/**
 * 通知收件箱。
 *
 * §17.1 的第一句就划清了边界：
 *
 * > `Notification` 是**持久化收件箱记录，不是 SSE 推送本身**。
 *
 * 由此推出三条实现约束：
 *
 * 1. 每个应通知的领域事件**先在数据库事务中写入 `Notification`**，再由 outbox
 *    任务向在线 host 推送。顺序反过来会在推送成功但事务回滚时产生幽灵通知。
 * 2. SSE 断开、桌面通知权限被拒、设备离线**都不会让通知丢失** —— host 重连后
 *    从收件箱游标补拉。
 * 3. 通知发送失败**仅影响即时提醒**，不影响消息、工作项、资源的已提交状态。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { NotificationState } from '../../contract/index.js'

export interface Notification {
  readonly notificationId: string
  readonly organizationId: string
  readonly recipientId: string
  readonly eventType: string
  readonly resourceRef: string
  readonly actorId: string | null
  readonly summary: string
  readonly priority: string
  readonly state: NotificationState
  readonly createdAt: string
  readonly dedupeKey: string
}

/**
 * 不参与聚合的事件类型。
 *
 * §17.1 明确列出：安全类通知、工作项签收请求、权限变更、风险处置**始终逐条呈现**。
 * 把它们折叠会让用户错过需要逐条处置的事项。
 */
export const NEVER_AGGREGATED = [
  'security_alert',
  'work_item_acknowledgement_request',
  'permission_changed',
  'risk_disposition',
] as const

export type CreateResult =
  | { readonly ok: true; readonly notification: Notification }
  /** 去重键命中：同一领域事件重复投递，不产生第二条记录。 */
  | { readonly ok: false; readonly reason: 'duplicate' }

/**
 * 写入一条通知。
 *
 * **必须在调用方的事务内执行** —— 与触发它的领域写入同事务。
 *
 * 去重键与聚合是两件事（§17.1）：去重键防止**同一领域事件**重复投递产生多条记录；
 * 聚合把**多个不同事件**折叠为一条可展开条目。这里只实现去重。
 */
export function createNotification(
  db: DatabaseSync,
  input: {
    notificationId: string
    organizationId: string
    recipientId: string
    eventType: string
    resourceRef: string
    actorId?: string
    summary: string
    priority?: string
    dedupeKey: string
    now: Date
  },
): CreateResult {
  const existing = db
    .prepare(
      `SELECT notification_id FROM notifications
        WHERE organization_id = ? AND recipient_id = ? AND dedupe_key = ?`,
    )
    .get(input.organizationId, input.recipientId, input.dedupeKey)

  if (existing) return { ok: false, reason: 'duplicate' }

  db.prepare(
    `INSERT INTO notifications
       (notification_id, organization_id, recipient_id, event_type, resource_ref,
        actor_id, summary, priority, state, created_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    input.notificationId,
    input.organizationId,
    input.recipientId,
    input.eventType,
    input.resourceRef,
    input.actorId ?? null,
    input.summary,
    input.priority ?? 'normal',
    input.now.toISOString(),
    input.dedupeKey,
  )
  return { ok: true, notification: findNotification(db, input.notificationId)! }
}

/** 行映射。索引访问在 noUncheckedIndexedAccess 下带 undefined，统一在此收敛。 */
function toNotification(row: Record<string, string | null>): Notification {
  return {
    notificationId: row['notification_id'] as string,
    organizationId: row['organization_id'] as string,
    recipientId: row['recipient_id'] as string,
    eventType: row['event_type'] as string,
    resourceRef: row['resource_ref'] as string,
    actorId: row['actor_id'] ?? null,
    summary: row['summary'] as string,
    priority: row['priority'] as string,
    state: row['state'] as NotificationState,
    createdAt: row['created_at'] as string,
    dedupeKey: row['dedupe_key'] as string,
  }
}

export function findNotification(
  db: DatabaseSync,
  notificationId: string,
): Notification | undefined {
  const row = db
    .prepare('SELECT * FROM notifications WHERE notification_id = ?')
    .get(notificationId) as Record<string, string | null> | undefined
  return row ? toNotification(row) : undefined
}

/**
 * 收件箱查询。
 *
 * §17.1：host 重连后**从收件箱游标补拉** —— 因此按创建时间升序返回，
 * 调用方带上次读到的位置。这也是「SSE 断开不会让通知丢失」的实现方式。
 */
export function inboxSince(
  db: DatabaseSync,
  input: {
    organizationId: string
    recipientId: string
    /** 上次读到的位置；首次拉取传 undefined。 */
    afterCreatedAt?: string
    limit: number
  },
): readonly Notification[] {
  const rows = db
    .prepare(
      `SELECT * FROM notifications
        WHERE organization_id = ? AND recipient_id = ?
          AND (? IS NULL OR created_at > ?)
          AND state NOT IN ('dismissed', 'expired')
        ORDER BY created_at
        LIMIT ?`,
    )
    .all(
      input.organizationId,
      input.recipientId,
      input.afterCreatedAt ?? null,
      input.afterCreatedAt ?? null,
      input.limit,
    ) as Array<Record<string, string | null>>

  return rows.map(toNotification)
}

/**
 * 标记状态。
 *
 * §17.1 的状态里 `seen` 与 `read` 是**两个不同状态** —— 前者是「出现在视野中」，
 * 后者是「用户确实打开了」。把两者合并会让未读计数失真。
 */
export function markNotificationState(
  db: DatabaseSync,
  input: {
    organizationId: string
    recipientId: string
    notificationIds: readonly string[]
    state: NotificationState
  },
): number {
  if (input.notificationIds.length === 0) return 0
  const statement = db.prepare(
    `UPDATE notifications SET state = ?
      WHERE organization_id = ? AND recipient_id = ? AND notification_id = ?`,
  )
  let changed = 0
  for (const id of input.notificationIds) {
    changed += Number(
      statement.run(input.state, input.organizationId, input.recipientId, id).changes,
    )
  }
  return changed
}

/** 未读计数。`queued`/`delivered`/`seen` 都算未读，只有 `read` 之后才不算。 */
export function unreadCount(
  db: DatabaseSync,
  organizationId: string,
  recipientId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications
        WHERE organization_id = ? AND recipient_id = ?
          AND state IN ('queued', 'delivered', 'seen')`,
    )
    .get(organizationId, recipientId) as { n: number }
  return row.n
}
