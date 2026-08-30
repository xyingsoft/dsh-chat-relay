/**
 * 命令与事件的契约定义。
 *
 * §48：**协议 schema 只放在 `@dsh-chat/contract`**，且只在 HTTP、数据库、文件系统、
 * 队列和浏览器请求这些边界解析。因此命令的输入输出形状在这里定义一次，
 * host 路由与客户端共用同一份。
 *
 * ## 命令与事件的区别
 *
 * **命令**是会改变业务状态的请求，走 HTTP，有幂等键，失败返回错误码。
 * **事件**是已发生事实的记录，写入事务 outbox，消费方以事件 ID 去重。
 *
 * 一个命令可以产生零到多个事件；一个事件不对应任何命令（例如租约到期）。
 */

import type { OperationId } from './persistence.js'

/** 全部命令名。封闭联合，配合 `assertNever` 保证路由穷尽。 */
export const COMMAND_NAMES = [
  'message.send',
  'message.pull',
  'message.ack',
  'message.edit',
  'message.revoke',
  'workItem.create',
  'workItem.assign',
  'workItem.acknowledge',
  'workItem.addDependency',
  'notification.list',
  'notification.mark',
] as const
export type CommandName = (typeof COMMAND_NAMES)[number]

/**
 * 全部持久领域事件名。
 *
 * 取值逐字来自 [§6.1 能力与提供者矩阵](../../../../docs/02-architecture/02-plugin-model.md#61-能力与提供者矩阵)
 * 中「消费者与持久事件」一列。`events.host.spec.ts` 会反向解析该文档核对，
 * 与错误码目录同一套防漂移机制。
 */
export const DOMAIN_EVENT_NAMES = [
  'device_registered',
  'device_restricted',
  'device_revoked',
  'membership_changed',
  'policy_changed',
  'presence_changed',
  'message_accepted',
  'message_edited',
  'message_revoked',
  'notification_created',
  'notification_read',
  'work_item_changed',
  'review_requested',
  'review_completed',
  'audit_recorded',
  'audit_chain_broken',
] as const
export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number]

/** 所有命令共有的信封。 */
export interface CommandEnvelope {
  /**
   * 幂等键，**由调用方生成并随请求携带**（§26）。
   *
   * 事务提交后网络连接断开时，调用方用同一幂等键查询最终结果 —— 因此它必须由
   * 调用方决定，服务端分配的话重试就换了一个键，幂等无从谈起。
   */
  readonly operationId: OperationId
}

// ── 命令的输入形状 ────────────────────────────────────────────────

export interface SendMessageCommand extends CommandEnvelope {
  /** 客户端生成的 UUIDv7（§14）。与发送者构成幂等键。 */
  readonly messageId: string
  readonly recipientId: string
  readonly body: string
}

export interface PullMessagesCommand {
  readonly batchSize?: number
}

export interface AckMessagesCommand {
  readonly deliverySeqs: readonly number[]
}

export interface EditMessageCommand extends CommandEnvelope {
  readonly messageId: string
  /** 目标修订号。编辑追加事件而非覆盖，冲突时以更高的 revision 为准（§14.1）。 */
  readonly targetRevision: number
  readonly body: string
}

export interface RevokeMessageCommand extends CommandEnvelope {
  readonly messageId: string
}

export interface CreateWorkItemCommand extends CommandEnvelope {
  readonly projectId: string
  readonly title: string
  readonly description?: string
  readonly dueAt?: string
}

export interface AssignWorkItemCommand extends CommandEnvelope {
  readonly workItemId: string
  readonly assigneeId: string
  /** 版本检查（§26 的第三步）。不匹配返回 `VERSION_CONFLICT`。 */
  readonly expectedVersion: number
}

export interface AcknowledgeWorkItemCommand extends CommandEnvelope {
  readonly workItemId: string
  readonly accept: boolean
  readonly expectedVersion: number
  /** 拒绝时须说明原因（§17：「拒绝并说明原因」）。 */
  readonly reason?: string
}

export interface AddDependencyCommand extends CommandEnvelope {
  readonly fromId: string
  readonly toId: string
  readonly kind: 'blocks' | 'depends_on'
}

/**
 * 命令名到输入类型的映射。
 *
 * 用映射类型而不是重载：路由分发时可以 `CommandInput[N]` 取到对应形状，
 * 新增命令若忘记加输入类型会在这里报错，而不是到运行时才发现。
 */
export interface CommandInput {
  'message.send': SendMessageCommand
  'message.pull': PullMessagesCommand
  'message.ack': AckMessagesCommand
  'message.edit': EditMessageCommand
  'message.revoke': RevokeMessageCommand
  'workItem.create': CreateWorkItemCommand
  'workItem.assign': AssignWorkItemCommand
  'workItem.acknowledge': AcknowledgeWorkItemCommand
  'workItem.addDependency': AddDependencyCommand
  'notification.list': { readonly after?: string; readonly limit?: number }
  'notification.mark': { readonly notificationIds: readonly string[]; readonly state: string }
}

/** 事务 outbox 中的一条事件。消费方以 `eventId` 去重（§26）。 */
export interface OutboxEvent {
  readonly eventId: string
  readonly organizationId: string
  readonly eventType: DomainEventName
  /** 负载形状随 `eventFormatVersion` 演进，读取方据此选择解析分支。 */
  readonly payload: Readonly<Record<string, unknown>>
  readonly eventFormatVersion: number
  readonly createdAt: string
}
