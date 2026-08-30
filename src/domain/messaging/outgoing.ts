/**
 * 发送方本地的发送状态机。
 *
 * [§4](../../../../docs/02-architecture/01-overall-architecture.md)：
 *
 * > 离线时界面区分**「本地已保存待发送」「服务器已接收」和「终态失败」三种状态，
 * > 绝不把未确认内容显示为已送达**。
 *
 * ## 三个状态，不是两个
 *
 * 直觉上「发送中 / 已发送」两态就够。但那样一来终态失败无处安放，只能表现为
 * 「一直发送中」—— 用户看着转圈，永远不知道这条消息其实已经不会发出去了。
 * 文档把失败单列为一态，就是为了消除这种伪装。
 *
 * ## 为什么和 messages 分表
 *
 * `messages` 存的是**已被服务器接收**的消息。pending 的那条按定义还没被接收，
 * 塞进去会让「查我收到的消息」意外查出自己尚未发出的草稿。两张表的语义不同，
 * 合并只是省了一次 join。
 *
 * ## 与 DeliveryState 的关系
 *
 * 客户端的 `presentDeliveryState` 已经保证「无一态可声称已送达」。本模块是它的
 * 数据来源 —— 状态在这里产生，在那里呈现。两处用的是同一组名字。
 */

import type { DatabaseSync } from 'node:sqlite'

/**
 * 发送方本地状态。**没有 `delivered`** —— 发送方无从得知接收方是否真的收到了，
 * 服务器接收（`accepted`）是发送方能确知的最远一步。
 */
export const OUTGOING_STATES = ['pending', 'accepted', 'failed'] as const
export type OutgoingState = (typeof OUTGOING_STATES)[number]

export interface OutgoingMessage {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
  readonly recipientId: string
  readonly body: string
  readonly state: OutgoingState
  readonly createdAt: string
  readonly updatedAt: string
  /** 服务器分配，仅 `accepted` 时有值。 */
  readonly deliverySeq: number | undefined
  /** 仅 `failed` 时有值。 */
  readonly errorCode: string | undefined
  readonly attempts: number
}

export interface EnqueueInput {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
  readonly recipientId: string
  readonly body: string
  readonly now: Date
}

/**
 * 本地保存一条待发送消息。
 *
 * **在发起网络请求之前调用。** 反过来的话，进程在请求发出后、响应回来前崩溃，
 * 这条消息就彻底消失了 —— 用户以为发了，实际什么都没留下。
 *
 * 重复入队同一 `messageId` 是幂等的：`(senderId, messageId)` 已经是 §14 的幂等键，
 * 重试时沿用同一个键正是它的用途。
 */
export function enqueueOutgoing(db: DatabaseSync, input: EnqueueInput): OutgoingMessage {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO outgoing_messages
       (organization_id, sender_id, message_id, recipient_id, body, state,
        created_at, updated_at, attempts)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
  ).run(
    input.organizationId,
    input.senderId,
    input.messageId,
    input.recipientId,
    input.body,
    iso,
    iso,
  )
  return outgoingOf(db, input)!
}

/**
 * 服务器已接收。
 *
 * 只允许从 `pending` 迁移。已经 `accepted` 的重复确认是幂等的（返回 true）；
 * 从 `failed` 迁到 `accepted` 则**拒绝** —— 终态失败是终态。若允许复活，
 * 界面上就会出现「刚才说发送失败，现在又说发出去了」，用户没有理由相信哪一个。
 */
export function markAccepted(
  db: DatabaseSync,
  key: OutgoingKey,
  deliverySeq: number,
  now: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE outgoing_messages
          SET state = 'accepted', delivery_seq = ?, updated_at = ?, error_code = NULL
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?
          AND state IN ('pending', 'accepted')`,
    )
    .run(deliverySeq, now.toISOString(), key.organizationId, key.senderId, key.messageId)
  return Number(result.changes) > 0
}

/**
 * 终态失败。
 *
 * 只在错误码的可重试性为 `terminal` 时调用 —— `retryable` 与 `conditional`
 * 应留在 `pending` 并计入尝试次数。把可重试的失败标成终态，等于替用户
 * 放弃了一条本来能发出去的消息。
 */
export function markFailed(
  db: DatabaseSync,
  key: OutgoingKey,
  errorCode: string,
  now: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE outgoing_messages
          SET state = 'failed', error_code = ?, updated_at = ?
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?
          AND state = 'pending'`,
    )
    .run(errorCode, now.toISOString(), key.organizationId, key.senderId, key.messageId)
  return Number(result.changes) > 0
}

/** 记一次失败的尝试，状态保持 `pending`。用于可重试的错误。 */
export function recordAttempt(db: DatabaseSync, key: OutgoingKey, now: Date): number {
  db.prepare(
    `UPDATE outgoing_messages
        SET attempts = attempts + 1, updated_at = ?
      WHERE organization_id = ? AND sender_id = ? AND message_id = ? AND state = 'pending'`,
  ).run(now.toISOString(), key.organizationId, key.senderId, key.messageId)
  return outgoingOf(db, key)?.attempts ?? 0
}

export interface OutgoingKey {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
}

export function outgoingOf(db: DatabaseSync, key: OutgoingKey): OutgoingMessage | undefined {
  const row = db
    .prepare(
      `SELECT * FROM outgoing_messages
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(key.organizationId, key.senderId, key.messageId) as
    | Record<string, string | number | null>
    | undefined
  if (row === undefined) return undefined

  return {
    organizationId: row['organization_id'] as string,
    senderId: row['sender_id'] as string,
    messageId: row['message_id'] as string,
    recipientId: row['recipient_id'] as string,
    body: row['body'] as string,
    state: row['state'] as OutgoingState,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    deliverySeq: (row['delivery_seq'] as number | null) ?? undefined,
    errorCode: (row['error_code'] as string | null) ?? undefined,
    attempts: row['attempts'] as number,
  }
}

/**
 * 待重发的消息，按创建时间升序。
 *
 * 只返回 `pending` —— `failed` 是终态，不自动重发；要重发就是一条新消息，
 * 由用户显式决定。自动重发终态失败会让「终态」这个词失去意义。
 */
export function pendingOutgoing(
  db: DatabaseSync,
  organizationId: string,
  senderId: string,
): readonly OutgoingMessage[] {
  const rows = db
    .prepare(
      `SELECT message_id FROM outgoing_messages
        WHERE organization_id = ? AND sender_id = ? AND state = 'pending'
        ORDER BY created_at, message_id`,
    )
    .all(organizationId, senderId) as Array<{ message_id: string }>

  return rows.flatMap((row) => {
    const message = outgoingOf(db, { organizationId, senderId, messageId: row.message_id })
    return message === undefined ? [] : [message]
  })
}
