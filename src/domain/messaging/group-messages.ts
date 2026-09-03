/**
 * P1 群消息接收与组播入队（S3，relay 侧）。
 *
 * 直接复用私聊投递的可靠性语义（§28「至少一次」、容量先检、幂等重放）：
 * - **一条**群消息在 `messages` 存一行（`recipient_id = 群 ID`、
 *   `recipient_type = 'group'`），**对每个成员**（发件人除外）各建一条
 *   `delivery_queue` —— 成员各自按自己的 `dm:<account>` 分区拉取/ACK，
 *   与私聊完全同一条流水线，host 无需知道「群」也能拉回正文；
 * - 容量判定对**每个成员**先做：任一人队列满则整条拒绝
 *   （`RECIPIENT_QUEUE_FULL`，§28「发送未被接收」的幂等语义允许安全重试）；
 * - 幂等键沿用 `(senderId, messageId)`（§14）：重试返回首次接收的结果。
 *
 * 必须由调用方在事务内执行（§26：领域行与全部队列项同事务提交）。
 */

import type { DatabaseSync } from 'node:sqlite'

import {
  PLAINTEXT_ENCRYPTION_META,
  CURRENT_EVENT_FORMAT_VERSION,
} from '../../contract/index.js'

import { nextDeliverySeq, pendingDepth } from './delivery.js'
import { groupInfoOf } from './groups.js'

export interface AcceptGroupMessageInput {
  readonly messageId: string
  readonly organizationId: string
  readonly senderId: string
  readonly groupId: string
  readonly body: string
  readonly operationId: string
  readonly now: Date
  /** 每名成员的队列容量上限（与私聊同源，调用方从 PlanLimits 读取）。 */
  readonly queueCapacity: number
}

export interface GroupDeliveryRow {
  readonly recipientId: string
  readonly deliverySeq: number
}

export type AcceptGroupMessageResult =
  | {
      readonly ok: true
      readonly recipients: number
      readonly rows: readonly GroupDeliveryRow[]
      readonly idempotentReplay: boolean
    }
  | {
      readonly ok: false
      readonly errorCode: 'RECIPIENT_QUEUE_FULL' | 'NOT_FOUND_OR_FORBIDDEN'
      readonly pendingCount?: number
    }

function memberIdsExcept(
  db: DatabaseSync,
  organizationId: string,
  groupId: string,
  senderId: string,
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT account_id AS accountId FROM group_members
        WHERE organization_id = ? AND group_id = ? AND account_id <> ?`,
    )
    .all(organizationId, groupId, senderId) as Array<{ accountId: string }>
  return rows.map((row) => row.accountId)
}

/** 发件人是否是该组织内该群的成员。 */
function senderIsMember(
  db: DatabaseSync,
  organizationId: string,
  groupId: string,
  senderId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS one FROM group_members
        WHERE organization_id = ? AND group_id = ? AND account_id = ?`,
    )
    .get(organizationId, groupId, senderId) as { one: number } | undefined
  return row !== undefined
}

/**
 * relay 接收一条群消息（组播入队）。
 *
 * 幂等命中时返回首次接收各成员的 delivery_seq；此时已 ACK 的记录仍在库里
 * （只读不重建）。返回 `ok: false / NOT_FOUND_OR_FORBIDDEN` 表示群不存在或
 * 发件人不是成员 —— 不区分两者，避免泄露群的存在性。
 */
export function acceptGroupMessage(
  db: DatabaseSync,
  input: AcceptGroupMessageInput,
): AcceptGroupMessageResult {
  const body = input.body.trim()
  if (body.length === 0) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

  const group = db
    .prepare(
      'SELECT 1 AS one FROM groups WHERE organization_id = ? AND group_id = ?',
    )
    .get(input.organizationId, input.groupId) as { one: number } | undefined
  if (group === undefined || !senderIsMember(db, input.organizationId, input.groupId, input.senderId)) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }

  // 幂等重放：同一 (senderId, messageId) 不重复建队列项
  const existing = db
    .prepare(
      'SELECT message_id FROM messages WHERE sender_id = ? AND message_id = ?',
    )
    .get(input.senderId, input.messageId) as { message_id: string } | undefined
  if (existing !== undefined) {
    const rows = db
      .prepare(
        `SELECT recipient_id AS recipientId, delivery_seq AS deliverySeq
           FROM delivery_queue
          WHERE organization_id = ? AND sender_id = ? AND message_id = ?
          ORDER BY delivery_seq`,
      )
      .all(
        input.organizationId,
        input.senderId,
        input.messageId,
      ) as unknown as GroupDeliveryRow[]
    return { ok: true, recipients: rows.length, rows, idempotentReplay: true }
  }

  const recipients = memberIdsExcept(db, input.organizationId, input.groupId, input.senderId)

  // 容量先检（写之前拒绝，§28）
  for (const recipientId of recipients) {
    const pending = pendingDepth(db, input.organizationId, recipientId)
    if (pending >= input.queueCapacity) {
      return { ok: false, errorCode: 'RECIPIENT_QUEUE_FULL', pendingCount: pending }
    }
  }

  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO messages
       (message_id, organization_id, sender_id, recipient_id, recipient_type,
        kind, body, revision, created_at, received_at, operation_id,
        event_format_version, encryption_meta)
     VALUES (?, ?, ?, ?, 'group', 'text', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.organizationId,
    input.senderId,
    input.groupId,
    body,
    iso,
    iso,
    input.operationId,
    CURRENT_EVENT_FORMAT_VERSION,
    JSON.stringify(PLAINTEXT_ENCRYPTION_META),
  )

  const rows: GroupDeliveryRow[] = []
  for (const recipientId of recipients) {
    const deliverySeq = nextDeliverySeq(db, input.organizationId, recipientId)
    db.prepare(
      `INSERT INTO delivery_queue
         (organization_id, recipient_id, delivery_seq, sender_id, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.organizationId,
      recipientId,
      deliverySeq,
      input.senderId,
      input.messageId,
      iso,
    )
    rows.push({ recipientId, deliverySeq })
  }

  return { ok: true, recipients: rows.length, rows, idempotentReplay: false }
}

/**
 * 一条消息的投递元数据（S4a：host 区分群/私聊并取群名）。
 *
 * host 拉队列时只拿得到 sender/body —— 要判断「这是群消息、群叫什么」，
 * 得回到 messages 行看 `recipient_type`；group 时补查群名。
 * 查不到该 (senderId, messageId) 行时返回 undefined（幂等留痕场景不应发生，
 * 但调用方要能处理）。
 */
export type MessageDeliveryMeta =
  | { readonly recipientType: 'account' }
  | { readonly recipientType: 'group'; readonly groupId: string; readonly name: string }

export function messageDeliveryMeta(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
}): MessageDeliveryMeta | undefined {
  const row = input.db
    .prepare(
      `SELECT recipient_id AS recipientId, recipient_type AS recipientType
         FROM messages
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(input.organizationId, input.senderId, input.messageId) as
    | { recipientId: string; recipientType: string }
    | undefined
  if (row === undefined) return undefined
  if (row.recipientType !== 'group') return { recipientType: 'account' }
  const info = groupInfoOf({
    db: input.db,
    organizationId: input.organizationId,
    groupId: row.recipientId,
  })
  if (info === undefined) return { recipientType: 'account' }
  return { recipientType: 'group', groupId: info.groupId, name: info.name }
}
