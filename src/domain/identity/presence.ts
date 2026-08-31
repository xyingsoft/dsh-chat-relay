/**
 * 在线状态（§9.1）。
 *
 * **这是插件仓库 `packages/chat/identity/src/presence.ts` 的对应实现。**
 * 两侧各有一份是仓库拆分的既定代价（contract 靠 vendored 校验防漂移，
 * 领域代码没有那层保护）。这一份是 relay 侧的权威实现 —— 跨机器的在线
 * 状态只有 relay 看得全，host 那份只服务单机模式。
 *
 * 改动其一时另一侧不会自动跟着变。折叠规则若要改，两边的测试都要跑。
 *
 * > **在线状态表达 DSH host 是否仍在运行，不表示用户正在阅读、输入或愿意
 * > 被打扰。**
 *
 * 这句话决定了这个模块的每一个取舍。它不是「用户在不在」，是「进程活没活」。
 *
 * > 在线状态是最终一致的提示信息，**绝不用于推断已读、送达、是否可以打扰
 * > 或是否自动把消息改为失败**。
 *
 * 所以这里只有查询，没有任何会影响投递的返回值。谁想拿它决定要不要发消息，
 * 在这一层就找不到入口。
 *
 * ## 阈值
 *
 * 取自 §50.3 已关闭的那条决策：心跳 30 秒，`online` ≤ 90 秒，`idle` ≤ 10
 * 分钟，超出即 `offline`。90 秒是三个心跳周期 —— 设一个周期的话，一次 GC
 * 停顿或网络抖动就会让人「闪断」。
 *
 * 阈值属**版本化组织策略**（§50 的原话），所以是参数不是常量；下面导出的
 * 只是基线默认值。
 *
 * ## `idle` 看的是交互时间，不是心跳时间
 *
 * host 活着但没人操作，正是 `idle` 要表达的东西。所以 host 在心跳里带上
 * 最近一次用户交互的时间戳，relay 不自己猜 —— 猜的话只能用心跳时间，
 * 而那永远是新鲜的，`idle` 就永远不会出现。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { PresenceState } from '../../contract/index.js'

/** §50.3 关闭的基线值。属版本化组织策略，调用方可覆盖。 */
export const PRESENCE_BASELINE = {
  heartbeatIntervalMs: 30_000,
  onlineWithinMs: 90_000,
  idleWithinMs: 10 * 60_000,
} as const

export interface PresenceThresholds {
  readonly onlineWithinMs: number
  readonly idleWithinMs: number
}

/** 一台设备上报的一次心跳。 */
export interface Heartbeat {
  readonly deviceId: string
  readonly accountId: string
  readonly organizationId: string
  readonly at: Date
  /**
   * 最近一次用户交互的时间。
   *
   * 不给就等同于「就是现在」—— 一个不上报交互时间的旧版 host 会一直显示
   * `online` 而不是错误地显示 `idle`。宁可少一档信息，不要给错的那一档。
   */
  readonly lastInteractionAt?: Date
}

/**
 * 记一次心跳。**必须在调用方的事务内执行。**
 *
 * 一行一设备，直接覆盖。保留历史心跳没有用途 —— 在线状态是「此刻」的问题，
 * 而「这台设备什么时候上过线」由审计与设备表的 `last_seen_at` 回答。
 */
export function recordHeartbeat(db: DatabaseSync, beat: Heartbeat): void {
  const at = beat.at.toISOString()
  const interaction = (beat.lastInteractionAt ?? beat.at).toISOString()
  db.prepare(
    `INSERT INTO device_presence
       (device_id, account_id, organization_id, last_heartbeat_at, last_interaction_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id, organization_id) DO UPDATE SET
       last_heartbeat_at = excluded.last_heartbeat_at,
       last_interaction_at = excluded.last_interaction_at`,
  ).run(beat.deviceId, beat.accountId, beat.organizationId, at, interaction)
}

interface PresenceRow {
  last_heartbeat_at: string
  last_interaction_at: string
}

/**
 * 把一台设备的两个时间戳折成一个状态。
 *
 * 顺序是有意的：先看心跳判断进程死活，再看交互判断人在不在。反过来的话，
 * 一台早就关机的机器会因为「最后一次交互在 10 分钟内」而显示 `idle`，
 * 而它其实是 `offline`。
 */
export function stateOfDevice(
  row: { lastHeartbeatAt: Date; lastInteractionAt: Date },
  now: Date,
  thresholds: PresenceThresholds = PRESENCE_BASELINE,
): PresenceState {
  const sinceHeartbeat = now.getTime() - row.lastHeartbeatAt.getTime()
  // 心跳来自未来：时钟异常。§9.1 明确把这种情况列为 unknown，而不是当成
  // 最新 —— 「无法可靠判定」和「在线」是两回事
  if (sinceHeartbeat < -thresholds.onlineWithinMs) return 'unknown'
  if (sinceHeartbeat > thresholds.idleWithinMs) return 'offline'

  const sinceInteraction = now.getTime() - row.lastInteractionAt.getTime()
  if (sinceHeartbeat > thresholds.onlineWithinMs) {
    // 心跳还在但已经超过 online 窗口：进程活着，网络可能不稳
    return 'idle'
  }
  return sinceInteraction > thresholds.idleWithinMs ? 'idle' : 'online'
}

/**
 * 某账号在某组织的聚合状态。
 *
 * 多设备取**最乐观**的那一档：一台在线一台离线，人就是在线的。取最悲观的话，
 * 一台忘在公司的机器会让人永远显示离线。
 *
 * 一条记录都没有时返回 `unknown` 而不是 `offline` —— §9.1：「`unknown` 表示
 * relay 无法可靠判定，例如刚加入组织」。说成 `offline` 是在断言一件没有依据
 * 的事。
 */
export function presenceOf(
  db: DatabaseSync,
  input: { organizationId: string; accountId: string; now: Date },
  thresholds: PresenceThresholds = PRESENCE_BASELINE,
): PresenceState {
  const rows = db
    .prepare(
      `SELECT last_heartbeat_at, last_interaction_at FROM device_presence
        WHERE organization_id = ? AND account_id = ?`,
    )
    .all(input.organizationId, input.accountId) as unknown as PresenceRow[]
  if (rows.length === 0) return 'unknown'

  const states = rows.map((row) =>
    stateOfDevice(
      {
        lastHeartbeatAt: new Date(row.last_heartbeat_at),
        lastInteractionAt: new Date(row.last_interaction_at),
      },
      input.now,
      thresholds,
    ),
  )
  return mostOptimistic(states)
}

/** 乐观程度排序。`unknown` 排在最后 —— 有任何确切信息都比「不知道」强。 */
const OPTIMISM: readonly PresenceState[] = ['online', 'idle', 'offline', 'unknown']

function mostOptimistic(states: readonly PresenceState[]): PresenceState {
  for (const candidate of OPTIMISM) {
    if (states.includes(candidate)) return candidate
  }
  return 'unknown'
}

/** 可见性策略（§9.1 的三档）。 */
export const PRESENCE_VISIBILITY = ['everyone', 'shared_scopes', 'hidden'] as const
export type PresenceVisibility = (typeof PRESENCE_VISIBILITY)[number]

/**
 * 按可见性策略过滤。
 *
 * §9.1：「隐藏时仍向 relay 发送必要心跳以维持投递和安全，但对其他成员显示为
 * `unknown`。」注意是 `unknown` 而不是 `offline` —— 显示成离线是在替用户
 * 撒谎，而 `unknown` 只是不说。
 *
 * 看自己永远看得到真实状态。看不到的话，用户没法确认自己的隐藏设置生效了
 * 没有，也没法发现自己的 host 其实已经掉线。
 */
export function applyVisibility(
  actual: PresenceState,
  input: {
    visibility: PresenceVisibility
    /** 观察者与被观察者是否同一个人。 */
    isSelf: boolean
    /** 两人是否共享至少一个项目或群。`shared_scopes` 下用它判定。 */
    sharesScope: boolean
  },
): PresenceState {
  if (input.isSelf) return actual
  if (input.visibility === 'hidden') return 'unknown'
  if (input.visibility === 'shared_scopes' && !input.sharesScope) return 'unknown'
  return actual
}
