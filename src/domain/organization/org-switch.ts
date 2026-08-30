/**
 * 当前组织与切换时的缓存隔离。
 *
 * [§9](../../../../docs/03-details/01-identity-and-permission.md#9-账号设置与组织切换)：
 *
 * > 一个账号可以属于多个组织。host 把组织无关的账号与设备信息同**组织级缓存、
 * > 草稿、通知游标和偏好**分开保存。
 * >
 * > 用户切换组织时，浏览器请求 host 更换当前 `OrganizationId`；host 校验该账号的
 * > 成员状态为 `active`，加载该组织的权限、项目、群、资源入口、插件目录、
 * > 预算可见范围和通知游标。
 * >
 * > **切换组织不会把前一组织的消息、资源、私人会话、搜索索引或未发送草稿暴露到
 * > 新组织。** 当前页面若持有旧组织资源，则先失效并重新授权。
 *
 * ## 隔离靠结构，不靠纪律
 *
 * 把「切换时记得清缓存」写成一条约定，等于赌每个新加的缓存都有人记得去清。
 * 这里改成：**缓存不按类型分桶，按组织分桶**。切换组织就是丢弃整个桶 ——
 * 新加什么缓存都自动被覆盖，不需要有人记得。
 *
 * §48 的「缓存键…必须携带 `OrganizationId`」是同一件事的另一种说法。
 * 区别在于携带 ID 只保证读不串，丢弃整桶还额外保证**不残留**。
 *
 * ## 为什么账号级数据不在这里
 *
 * §9 明说组织无关的账号与设备信息要**分开保存**。它们不该随组织切换而失效 ——
 * 切个组织就要重新认证设备，是把隔离做过头了。所以这个类只管组织级的桶，
 * 账号级状态在别处，两者在类型上就不通。
 */

import type { DatabaseSync } from 'node:sqlite'

import { membershipsOf } from './repository.js'

/** 组织级缓存桶。键的语义由使用方决定，本模块只保证按组织隔离。 */
export type OrganizationScopedCache = Map<string, unknown>

export type SwitchResult =
  | { readonly ok: true; readonly organizationId: string }
  /**
   * §9 要求校验成员状态为 `active`。不是 active 时不切换。
   *
   * 与「不是成员」返回同一个结果 —— 区分开就能探测某账号在某组织的成员状态。
   */
  | { readonly ok: false; readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

/**
 * 一个账号在 host 上的当前组织与其组织级缓存。
 *
 * 每个已登录账号一个实例。**不是全局单例** —— 同一台设备上两个账号各自的当前
 * 组织互不相干，做成单例的话后登录的账号会改掉前一个的视图。
 */
export class OrganizationSession {
  #currentOrganizationId: string | undefined
  /** 组织 ID → 该组织的缓存桶。切换时整桶丢弃。 */
  readonly #buckets = new Map<string, OrganizationScopedCache>()

  constructor(readonly accountId: string) {}

  get currentOrganizationId(): string | undefined {
    return this.#currentOrganizationId
  }

  /**
   * 切换到目标组织。
   *
   * 成功时**丢弃前一组织的整个缓存桶**。不是清空当前桶 —— 是丢弃前一个的。
   * 这两者在切回去时表现不同：丢弃前一个意味着切回来要重新加载（正确，
   * 期间权限可能已变）；只清当前桶则会把刚加载的新组织数据也清掉。
   */
  switchTo(db: DatabaseSync, organizationId: string): SwitchResult {
    const memberships = membershipsOf(db, organizationId, this.accountId)
    const active = memberships.some((m) => m.state === 'active')
    if (!active) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

    const previous = this.#currentOrganizationId
    // 切换到当前所在的组织是无操作，不该把缓存丢掉 —— 界面上重复点一次
    // 当前组织就清空所有缓存，是纯粹的性能损失
    if (previous !== undefined && previous !== organizationId) {
      this.#buckets.delete(previous)
    }
    this.#currentOrganizationId = organizationId
    return { ok: true, organizationId }
  }

  /**
   * 取当前组织的缓存桶。
   *
   * 尚未切入任何组织时返回 `undefined` 而不是一个空 Map —— §48：
   * 「失效无法确认时**默认拒绝访问**」。返回空 Map 会让调用方以为
   * 「这个组织确实没缓存」，而实际是「不知道现在在哪个组织」。
   */
  cache(): OrganizationScopedCache | undefined {
    const current = this.#currentOrganizationId
    if (current === undefined) return undefined
    let bucket = this.#buckets.get(current)
    if (bucket === undefined) {
      bucket = new Map()
      this.#buckets.set(current, bucket)
    }
    return bucket
  }

  /**
   * 退出组织：删除该组织的缓存桶（§9 最后一段）。
   *
   * 若退出的正是当前组织，当前组织置空 —— 之后任何 `cache()` 都返回
   * `undefined`，直到显式切入另一个组织。
   */
  leave(organizationId: string): void {
    this.#buckets.delete(organizationId)
    if (this.#currentOrganizationId === organizationId) {
      this.#currentOrganizationId = undefined
    }
  }

  /** 当前持有缓存桶的组织。仅供测试与诊断断言用。 */
  cachedOrganizations(): readonly string[] {
    return [...this.#buckets.keys()]
  }
}
