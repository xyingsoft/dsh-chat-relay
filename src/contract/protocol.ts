/**
 * 协议版本协商。
 *
 * [§41](../../../../docs/03-details/05-observability-and-ops.md#41-协议版本协商与升级顺序)：
 *
 * > host 与 relay 独立升级，因此协议兼容性必须显式协商而不是靠同步发版。
 * >
 * > host 在建立设备会话时提交自身协议版本与已支持事件格式集合；relay 返回协商结果、
 * > 服务端当前版本、最低支持版本和弃用截止时间。
 * >
 * > 协商失败返回 `PROTOCOL_VERSION_UNSUPPORTED`，**host 显示明确的升级提示并停止
 * > 组织写入，不进入静默降级或部分可用状态**。
 *
 * ## 为什么协商结果不是布尔值
 *
 * 因为「兼容」不止一种。host 比 relay 旧但在兼容窗口内，与 host 和 relay 同版本，
 * 两者都算成功，但前者要给用户看弃用截止时间。把它们压成一个 `ok: true`，
 * 那条截止时间就无处安放，用户在窗口结束当天才发现写入停了。
 *
 * ## 为什么这里没有网络代码
 *
 * §48：契约包「只定义类型、schema 与服务接口，不携带数据库驱动、HTTP 框架或任何
 * 业务副作用」。`negotiate` 是纯函数 —— 输入两侧的声明，输出判定。传输由调用方负责。
 */

import { assertNever, type ProtocolVersion } from './index.js'

/**
 * host 在建立设备会话时提交的内容。
 *
 * 「已支持事件格式集合」按事件名分别声明，而不是一个全局版本号：
 * §41 说的是「各事件的 `eventFormatVersion`」，不同事件的格式各自演进。
 */
export interface ProtocolOffer {
  readonly protocolVersion: ProtocolVersion
  /** 事件名 → 该 host 能解析的最高事件格式版本。 */
  readonly eventFormatVersions: Readonly<Record<string, number>>
}

/** relay 侧的能力声明。 */
export interface ProtocolCapability {
  readonly currentVersion: ProtocolVersion
  /**
   * 最低支持版本。低于此值协商失败。
   *
   * §41 的兼容窗口是「两个次要版本或 90 天中的较长者」，窗口如何换算成这个数字
   * 是**部署决策**而非协议规则，所以由调用方传入而不是在这里算。
   */
  readonly minimumVersion: ProtocolVersion
  /** 各事件当前的格式版本。 */
  readonly eventFormatVersions: Readonly<Record<string, number>>
  /**
   * 弃用截止时间（ISO 8601）。仅当 host 版本低于 relay 当前版本时有意义。
   *
   * relay 与 host 同版本时不该有截止时间 —— 那会让界面显示「你的版本将于 X 停止
   * 支持」而其实用户已是最新，是纯粹的误导。
   */
  readonly deprecationDeadline?: string
}

/** 协商结果的判别式。 */
export type NegotiationOutcome =
  /** 双方同版本。 */
  | { readonly kind: 'current' }
  /** host 较旧但在兼容窗口内。relay 须以旧格式向其投递。 */
  | { readonly kind: 'deprecated'; readonly deadline: string | undefined }
  /** host 版本低于 relay 最低支持版本。 */
  | { readonly kind: 'host_too_old' }
  /**
   * host 版本高于 relay 当前版本。
   *
   * §41：「**新版本 relay 不得要求所有 host 已升级才能启动**」，且升级顺序固定为
   * relay 先升、host 后升。所以这个方向出现，说明部署顺序被违反了 —— relay 无法
   * 理解更新的命令，只能拒绝。
   */
  | { readonly kind: 'relay_too_old' }

export interface NegotiationResult {
  readonly outcome: NegotiationOutcome
  /** 协商是否通过。为 false 时调用方返回 `PROTOCOL_VERSION_UNSUPPORTED`。 */
  readonly accepted: boolean
  readonly serverVersion: ProtocolVersion
  readonly minimumVersion: ProtocolVersion
  /**
   * 双方都能处理的事件格式版本：`min(host, relay)`，按事件取。
   *
   * 只包含**两侧都声明了的**事件。relay 独有的事件不放进来 —— 向不认识该事件的
   * host 投递它，host 只能丢弃或崩溃，两种都比不投递糟。
   */
  readonly agreedEventFormats: Readonly<Record<string, number>>
  /** 仅在 `outcome.kind === 'deprecated'` 时非空。 */
  readonly deprecationDeadline: string | undefined
}

/**
 * 执行协商。纯函数，无 I/O。
 *
 * 判定顺序是**先版本后事件格式**：版本不兼容时事件格式无从谈起，
 * 反过来算等于在一个注定要拒绝的会话上浪费工作。
 */
export function negotiate(
  offer: ProtocolOffer,
  capability: ProtocolCapability,
): NegotiationResult {
  const outcome = classify(offer.protocolVersion, capability)
  const accepted = outcome.kind === 'current' || outcome.kind === 'deprecated'

  return {
    outcome,
    accepted,
    serverVersion: capability.currentVersion,
    minimumVersion: capability.minimumVersion,
    // 拒绝时不给事件格式：会话不会建立，给了只会让调用方误以为可以开始投递
    agreedEventFormats: accepted
      ? intersectFormats(offer.eventFormatVersions, capability.eventFormatVersions)
      : {},
    deprecationDeadline: outcome.kind === 'deprecated' ? outcome.deadline : undefined,
  }
}

function classify(
  hostVersion: ProtocolVersion,
  capability: ProtocolCapability,
): NegotiationOutcome {
  if (hostVersion > capability.currentVersion) return { kind: 'relay_too_old' }
  if (hostVersion < capability.minimumVersion) return { kind: 'host_too_old' }
  if (hostVersion === capability.currentVersion) return { kind: 'current' }
  return { kind: 'deprecated', deadline: capability.deprecationDeadline }
}

/** 取两侧事件格式版本的交集，每个事件取较小值。 */
function intersectFormats(
  host: Readonly<Record<string, number>>,
  relay: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const agreed: Record<string, number> = {}
  for (const [event, hostVersion] of Object.entries(host)) {
    const relayVersion = relay[event]
    if (relayVersion === undefined) continue
    agreed[event] = Math.min(hostVersion, relayVersion)
  }
  return agreed
}

/**
 * 协商失败时给用户看的话。
 *
 * §41 要求 host「显示**明确的**升级提示」。「明确」意味着说清该升级哪一边 ——
 * 「协议版本不兼容」这种话用户读了也不知道要做什么。
 */
export function upgradeHint(result: NegotiationResult): string | undefined {
  const { outcome } = result
  switch (outcome.kind) {
    case 'current':
      return undefined
    case 'deprecated':
      return outcome.deadline === undefined
        ? `当前协议版本已弃用，请升级到 v${result.serverVersion}。`
        : `当前协议版本将于 ${outcome.deadline} 停止支持，请在此之前升级到 v${result.serverVersion}。`
    case 'host_too_old':
      return `本机协议版本过旧，服务端最低支持 v${result.minimumVersion}，请升级本机后重试。组织写入已停止。`
    case 'relay_too_old':
      return `服务端协议版本 v${result.serverVersion} 低于本机，需先升级服务端。组织写入已停止。`
    default:
      return assertNever(outcome, '未处理的协商结果')
  }
}
