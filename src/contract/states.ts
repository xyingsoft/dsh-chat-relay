/**
 * 领域状态集合。
 *
 * **每一组的取值都逐字取自 `docs/`，顺序也与文档一致。** `states.host.spec.ts` 会在
 * 全部文档中查找与之完全匹配的连续枚举，找不到即失败 —— 与错误码目录同一套防漂移
 * 机制。新增或修改状态必须先改文档。
 *
 * ## 只有状态集合，没有转换边
 *
 * 文档给出了状态**集合**，但除少数几条约束外**没有定义合法的转换边**。例如工作项
 * 只明确了 `in_review → done` 需要评审关口、进入终态且有未完成子项时需要显式确认，
 * 其余转换的合法性未定义。
 *
 * 这个缺口已登记在[实现记录](../../../../docs/_meta/implementation-log.md)中，
 * 需通过文档变更补齐。**在补齐之前，本文件不提供任何转换校验函数** —— 在实现里
 * 就地定义转换规则等于绕过文档先行流程。
 */

/** 把一组只读字面量收敛为联合类型的辅助类型。 */
type Values<T extends readonly string[]> = T[number]

/**
 * 工作项状态。转换边未定义，见本文件头部说明。
 * 唯一明确的关口：`in_review → done` 需要评审结论（否则返回 `REVIEW_REQUIRED`）。
 */
export const WORK_ITEM_STATES = [
  'draft',
  'open',
  'assigned',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
  'archived',
] as const
export type WorkItemState = Values<typeof WORK_ITEM_STATES>

/**
 * 工作项签收状态。
 *
 * 这是**独立于工作项状态**的另一台状态机，由负责人通过明确命令改变。文档强调：
 * 通知已送达或已阅读只表示收件箱状态，不代表任务已知晓、同意或开始执行。
 * 两台状态机之间的对应关系未定义，同样属于已登记的缺口。
 */
export const WORK_ITEM_ACKNOWLEDGEMENT_STATES = [
  'offered',
  'acknowledged',
  'declined',
  'expired',
  'reassigned',
] as const
export type WorkItemAcknowledgementState = Values<typeof WORK_ITEM_ACKNOWLEDGEMENT_STATES>

/** 通知状态。注意 `seen` 与 `read` 是两个不同状态。 */
export const NOTIFICATION_STATES = [
  'queued',
  'delivered',
  'seen',
  'read',
  'dismissed',
  'expired',
  'failed',
] as const
export type NotificationState = Values<typeof NOTIFICATION_STATES>

/**
 * 评审状态。
 * `approved → superseded` 是**自动转换**：关联产物或提交在评审后变化时触发，
 * 对应错误码 `REVIEW_SUPERSEDED`。文档明确「不允许批准一个版本、合入另一个版本」。
 */
export const REVIEW_STATES = [
  'requested',
  'in_progress',
  'approved',
  'changes_requested',
  'declined',
  'expired',
  'superseded',
] as const
export type ReviewState = Values<typeof REVIEW_STATES>

/**
 * 组织状态。
 * `suspended` 时停止新写入、Bot 调用与外部通知，但**保留只读和恢复能力**。
 * 组织不允许没有 `active` 所有者 —— 唯一所有者失效时强制进入 `suspended` 并触发接管。
 */
export const ORGANIZATION_STATES = ['active', 'suspended', 'archived'] as const
export type OrganizationState = Values<typeof ORGANIZATION_STATES>

/**
 * 成员关系状态。
 * **只有 `active` 成员**能接收新授权、发送项目消息、下载资源或调用 Bot。
 */
export const MEMBERSHIP_STATES = ['invited', 'active', 'suspended', 'removed'] as const
export type MembershipState = Values<typeof MEMBERSHIP_STATES>

/** 联系人请求状态。`pending` 默认 30 天后转 `expired`（保留期属版本化配置）。 */
export const CONTACT_REQUEST_STATES = ['pending', 'accepted', 'rejected', 'expired'] as const
export type ContactRequestState = Values<typeof CONTACT_REQUEST_STATES>

/**
 * 在线状态（relay 聚合后的结果）。
 *
 * 边界声明，实现时必须遵守：**在线状态表达 DSH host 是否仍在运行，不表示用户正在
 * 阅读、输入或愿意被打扰**；它是最终一致的提示信息，**绝不用于推断已读、送达、
 * 是否可以打扰，或自动把消息改为失败**。
 *
 * 隐藏在线状态的成员**仍然发送心跳**以维持投递与安全，只是对其他成员显示为
 * `unknown` —— 隐藏既不等于停心跳，也不等于显示 `offline`。
 *
 * 各状态的判定阈值属于版本化组织策略，**不得写成代码常量**；具体取值是 §50 中尚未
 * 关闭的开放决策。
 */
export const PRESENCE_STATES = ['online', 'idle', 'offline', 'unknown'] as const
export type PresenceState = Values<typeof PRESENCE_STATES>

/**
 * 第二验证因素状态。
 * `pending_verification → active` **必须当场完成一次成功验证**，避免登记了不可用的
 * 认证器。删除最后一个 `active` 因素且组织策略强制时返回 `FORBIDDEN`。
 */
export const SECOND_FACTOR_STATES = [
  'pending_verification',
  'active',
  'suspended',
  'revoked',
] as const
export type SecondFactorState = Values<typeof SECOND_FACTOR_STATES>

/** 设备风险事件状态，驱动设备的 `restricted` 等管制状态。 */
export const SECURITY_RISK_EVENT_STATES = [
  'observed',
  'pending_confirmation',
  'restricted',
  'resolved',
  'suspended',
  'false_positive',
] as const
export type SecurityRiskEventState = Values<typeof SECURITY_RISK_EVENT_STATES>

/**
 * 异步任务状态。
 * 每个任务含尝试次数、下次重试时间、最后错误与关联领域对象。
 * **权限拒绝、schema 无效、配额不足、资源不存在与版本冲突是终态错误，不得自动重试**
 * —— 判定依据是错误码目录的 `retryability`，不是任务自身猜测。
 */
export const ASYNC_TASK_STATES = [
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
] as const
export type AsyncTaskState = Values<typeof ASYNC_TASK_STATES>

/** 供防漂移测试遍历用的全量登记表。新增状态集合时必须同时登记在这里。 */
export const ALL_STATE_SETS = {
  WORK_ITEM_STATES,
  WORK_ITEM_ACKNOWLEDGEMENT_STATES,
  NOTIFICATION_STATES,
  REVIEW_STATES,
  ORGANIZATION_STATES,
  MEMBERSHIP_STATES,
  CONTACT_REQUEST_STATES,
  PRESENCE_STATES,
  SECOND_FACTOR_STATES,
  SECURITY_RISK_EVENT_STATES,
  ASYNC_TASK_STATES,
} as const satisfies Record<string, readonly string[]>
