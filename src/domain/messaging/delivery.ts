/**
 * 私聊投递。
 *
 * §28 定义的可靠性语义是精确的：
 *
 * > **从 relay 接收消息开始，到接收方把消息写入持久化存储为止，至少投递一次。**
 *
 * 注意它既不是「至多一次」也不是「恰好一次」—— 重复投递是允许的，由接收侧的
 * 幂等写入消化。因此本文件的每个写入路径都要能承受重放。
 *
 * ## 六步流程中本文件负责的部分
 *
 * 第 3 步（relay 在**一个事务**中提交「已接收消息」和「目标收件人队列项」）、
 * 第 5 步（带租约的批次拉取与 ACK）、第 6 步（租约到期重投，本地记录使重写幂等）。
 *
 * ## 两条不能违反的容量规则
 *
 * - 队列容量不足时，relay **必须在接收新消息前**拒绝，返回 `RECIPIENT_QUEUE_FULL`。
 *   「发送未被接收」是这个错误码的幂等语义 —— 调用方可以安全重试。
 * - relay **不得淘汰已经接收但尚未 ACK 的消息**来为新流量腾空间。这条如果违反，
 *   「至少一次」的承诺就断了，而且是静默断的。
 */

import type { DatabaseSync } from 'node:sqlite'

import { PLAINTEXT_ENCRYPTION_META, CURRENT_EVENT_FORMAT_VERSION } from '../../contract/index.js'

export interface AcceptMessageInput {
  readonly messageId: string
  readonly organizationId: string
  readonly senderId: string
  readonly recipientId: string
  readonly body: string
  readonly operationId: string
  readonly now: Date
  /** 收件人队列容量上限。属版本化 `PlanLimits`，调用方从配置读取（§30.1）。 */
  readonly queueCapacity: number
}

export type AcceptMessageResult =
  | {
      readonly ok: true
      readonly deliverySeq: number
      /** 幂等命中：同一 `(senderId, messageId)` 重试，返回首次接收的结果。 */
      readonly idempotentReplay: boolean
    }
  | {
      readonly ok: false
      readonly errorCode: 'RECIPIENT_QUEUE_FULL'
      /** 当前未 ACK 的队列深度，供调用方决定退避策略。 */
      readonly pendingCount: number
    }

/** 未 ACK 的队列深度。容量判定只看未 ACK 项 —— 已 ACK 的记录保留但不占额度。 */
function pendingDepth(db: DatabaseSync, organizationId: string, recipientId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_queue
        WHERE organization_id = ? AND recipient_id = ? AND acked_at IS NULL`,
    )
    .get(organizationId, recipientId) as { n: number }
  return row.n
}

/** 为收件人分区分配下一个 `DeliverySeq`，并推进该分区的高水位。 */
function nextDeliverySeq(db: DatabaseSync, organizationId: string, recipientId: string): number {
  const partitionKey = `dm:${recipientId}`
  db.prepare(
    `INSERT INTO stream_state (organization_id, partition_key, stream_epoch, high_watermark)
     VALUES (?, ?, 1, 0)
     ON CONFLICT (organization_id, partition_key) DO NOTHING`,
  ).run(organizationId, partitionKey)

  // 高水位不可回退（§28.1），因此只能 +1，不接受外部指定
  db.prepare(
    `UPDATE stream_state SET high_watermark = high_watermark + 1
      WHERE organization_id = ? AND partition_key = ?`,
  ).run(organizationId, partitionKey)

  const row = db
    .prepare(
      `SELECT high_watermark FROM stream_state
        WHERE organization_id = ? AND partition_key = ?`,
    )
    .get(organizationId, partitionKey) as { high_watermark: number }
  return row.high_watermark
}

/**
 * relay 接收一条私聊消息。
 *
 * **必须在调用方的事务内执行** —— §26 要求领域对象与队列项在同一事务提交，
 * 否则会出现「消息已存但队列项没建」这种对接收方不可见、对发送方却已成功的状态。
 *
 * 幂等键是 `(senderId, messageId)`（§14）。重试返回首次接收的结果，而不是新增一条。
 */
export function acceptDirectMessage(
  db: DatabaseSync,
  input: AcceptMessageInput,
): AcceptMessageResult {
  const existing = db
    .prepare('SELECT message_id FROM messages WHERE sender_id = ? AND message_id = ?')
    .get(input.senderId, input.messageId) as { message_id: string } | undefined

  if (existing) {
    const queued = db
      .prepare(
        `SELECT delivery_seq FROM delivery_queue
          WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
      )
      .get(input.organizationId, input.senderId, input.messageId) as
      | { delivery_seq: number }
      | undefined
    return { ok: true, deliverySeq: queued?.delivery_seq ?? 0, idempotentReplay: true }
  }

  // 容量检查必须在写入之前 —— §28：relay 必须在接收新消息前拒绝。
  // 先写后删会短暂地让「至少一次」的承诺失效。
  const pending = pendingDepth(db, input.organizationId, input.recipientId)
  if (pending >= input.queueCapacity) {
    return { ok: false, errorCode: 'RECIPIENT_QUEUE_FULL', pendingCount: pending }
  }

  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO messages
       (message_id, organization_id, sender_id, recipient_id, kind, body, revision,
        created_at, received_at, operation_id, event_format_version, encryption_meta)
     VALUES (?, ?, ?, ?, 'text', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.organizationId,
    input.senderId,
    input.recipientId,
    input.body,
    iso,
    iso,
    input.operationId,
    CURRENT_EVENT_FORMAT_VERSION,
    JSON.stringify(PLAINTEXT_ENCRYPTION_META),
  )

  const deliverySeq = nextDeliverySeq(db, input.organizationId, input.recipientId)
  db.prepare(
    `INSERT INTO delivery_queue
       (organization_id, recipient_id, delivery_seq, sender_id, message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.organizationId,
    input.recipientId,
    deliverySeq,
    input.senderId,
    input.messageId,
    iso,
  )

  return { ok: true, deliverySeq, idempotentReplay: false }
}

export interface LeasedItem {
  readonly deliverySeq: number
  readonly senderId: string
  readonly messageId: string
  readonly body: string
  readonly createdAt: string
}

/**
 * 拉取一个带租约的批次。
 *
 * §28：**每个设备**同时只允许一个有效的租约拉取批次 —— **不是每个账号一个**。
 * 这是为多设备保留清晰的所有权：两台设备各自拉取互不干扰，但同一设备重复拉取
 * 会先释放自己的旧租约。
 *
 * 已过期的租约可被其他设备接管，对应第 6 步「接收方在 ACK 前崩溃，租约到期后
 * relay 重投」。
 */
export function leaseBatch(
  db: DatabaseSync,
  input: {
    organizationId: string
    recipientId: string
    deviceId: string
    batchSize: number
    leaseMs: number
    now: Date
  },
): readonly LeasedItem[] {
  const nowIso = input.now.toISOString()
  const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString()

  // 同一设备重新拉取时先释放自己的旧租约，避免它占着不放又拿不到新的
  db.prepare(
    `UPDATE delivery_queue SET lease_device_id = NULL, lease_expires_at = NULL
      WHERE organization_id = ? AND recipient_id = ? AND lease_device_id = ? AND acked_at IS NULL`,
  ).run(input.organizationId, input.recipientId, input.deviceId)

  const candidates = db
    .prepare(
      `SELECT delivery_seq FROM delivery_queue
        WHERE organization_id = ? AND recipient_id = ? AND acked_at IS NULL
          AND (lease_device_id IS NULL OR lease_expires_at <= ?)
        ORDER BY delivery_seq
        LIMIT ?`,
    )
    .all(input.organizationId, input.recipientId, nowIso, input.batchSize) as Array<{
    delivery_seq: number
  }>

  const claim = db.prepare(
    `UPDATE delivery_queue SET lease_device_id = ?, lease_expires_at = ?
      WHERE organization_id = ? AND recipient_id = ? AND delivery_seq = ?`,
  )
  for (const candidate of candidates) {
    claim.run(
      input.deviceId,
      expiresAt,
      input.organizationId,
      input.recipientId,
      candidate.delivery_seq,
    )
  }

  if (candidates.length === 0) return []

  const placeholders = candidates.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT q.delivery_seq, q.sender_id, q.message_id, m.body, m.created_at
         FROM delivery_queue q
         JOIN messages m ON m.sender_id = q.sender_id AND m.message_id = q.message_id
        WHERE q.organization_id = ? AND q.recipient_id = ?
          AND q.delivery_seq IN (${placeholders})
        ORDER BY q.delivery_seq`,
    )
    .all(
      input.organizationId,
      input.recipientId,
      ...candidates.map((c) => c.delivery_seq),
    ) as Array<{
    delivery_seq: number
    sender_id: string
    message_id: string
    body: string
    created_at: string
  }>

  return rows.map((row) => ({
    deliverySeq: row.delivery_seq,
    senderId: row.sender_id,
    messageId: row.message_id,
    body: row.body,
    createdAt: row.created_at,
  }))
}

/**
 * 确认一批 `DeliverySeq`。
 *
 * 只有持有租约的设备能 ACK —— 否则一台设备可以确认另一台正在处理的批次，
 * 导致后者崩溃时消息不再重投。
 *
 * 重复 ACK 是幂等的：条件里的 `acked_at IS NULL` 让第二次不产生变化。
 */
export function acknowledge(
  db: DatabaseSync,
  input: {
    organizationId: string
    recipientId: string
    deviceId: string
    deliverySeqs: readonly number[]
    now: Date
  },
): number {
  if (input.deliverySeqs.length === 0) return 0
  const nowIso = input.now.toISOString()
  const statement = db.prepare(
    `UPDATE delivery_queue
        SET acked_at = ?, acked_device_id = ?, lease_device_id = NULL, lease_expires_at = NULL
      WHERE organization_id = ? AND recipient_id = ? AND delivery_seq = ?
        AND acked_at IS NULL
        AND lease_device_id = ?`,
  )
  let acked = 0
  for (const seq of input.deliverySeqs) {
    const result = statement.run(
      nowIso,
      input.deviceId,
      input.organizationId,
      input.recipientId,
      seq,
      input.deviceId,
    )
    // node:sqlite 的 changes 是 number | bigint（大结果集时为 bigint）；
    // 这里逐条更新，值必然是 0 或 1，显式收敛为 number
    acked += Number(result.changes)
  }
  return acked
}

/** 该收件人分区的流代次与高水位，host 在同步与 ACK 时须同时携带（§28.1）。 */
export function watermarkOf(
  db: DatabaseSync,
  organizationId: string,
  recipientId: string,
): { readonly streamEpoch: number; readonly highWatermark: number } {
  const row = db
    .prepare(
      `SELECT stream_epoch, high_watermark FROM stream_state
        WHERE organization_id = ? AND partition_key = ?`,
    )
    .get(organizationId, `dm:${recipientId}`) as
    | { stream_epoch: number; high_watermark: number }
    | undefined
  return {
    streamEpoch: row?.stream_epoch ?? 1,
    highWatermark: row?.high_watermark ?? 0,
  }
}
