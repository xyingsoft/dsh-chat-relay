/**
 * 通知聚合。
 *
 * [§17.1](../../../../docs/01-requirements/02-collaboration-requirements.md#171-通知与收件箱)：
 *
 * > **去重键与聚合是两件事。** 去重键防止同一领域事件重复投递产生多条记录；
 * > 聚合把多个不同事件折叠为一条可展开的收件箱条目。
 * >
 * > 聚合按 `(接收人, 来源对象, 事件类型)` 在可配置的聚合窗口（默认 5 分钟）内
 * > 进行：同群的多次 @ 提及折叠为一条「N 条新提及」，**保留最早与最新事件引用和
 * > 计数**，不生成 N 条独立记录；同一工作项的连续状态变更折叠为最新状态并保留
 * > 变更次数。**聚合条目的已读语义作用于整条，展开后逐条跳转。**
 * >
 * > 安全类通知、工作项签收请求、权限变更和风险处置**不参与聚合，始终逐条呈现**。
 * > 聚合只影响收件箱呈现与推送节流，**不影响审计事件的逐条完整性**。
 *
 * ## 聚合是呈现层的折叠，不是数据的丢弃
 *
 * 「展开后逐条跳转」要求被折叠的每一条仍然可查。所以实现是「组 + 成员」两张表，
 * 而不是给 notifications 加个 count 然后丢掉后续条目。每条通知照常写入，
 * 聚合只是在它们之上再加一层。
 *
 * 这也直接满足了「不影响审计事件的逐条完整性」—— 审计根本不看聚合表。
 */

import type { DatabaseSync } from 'node:sqlite'

import { NEVER_AGGREGATED, type Notification } from './inbox.js'

/** §17.1：可配置的聚合窗口，默认 5 分钟。 */
export const DEFAULT_AGGREGATION_WINDOW_MS = 5 * 60 * 1000

export interface NotificationGroup {
  readonly groupId: string
  readonly organizationId: string
  readonly recipientId: string
  /** 来源对象引用，聚合三元组的第二项。 */
  readonly sourceRef: string
  readonly eventType: string
  readonly windowStartedAt: string
  readonly earliestNotificationId: string
  readonly latestNotificationId: string
  readonly count: number
  readonly state: string
  readonly updatedAt: string
}

export type AggregationOutcome =
  /** 该事件类型不参与聚合，逐条呈现。 */
  | { readonly kind: 'not_aggregated' }
  /** 开了一个新组。 */
  | { readonly kind: 'group_created'; readonly group: NotificationGroup }
  /** 并入了已有的开放组。 */
  | { readonly kind: 'group_extended'; readonly group: NotificationGroup }

export interface AggregateInput {
  readonly notification: Notification
  /** 来源对象引用。与 `resourceRef` 可能不同 —— 见下方说明。 */
  readonly sourceRef: string
  readonly now: Date
  readonly newGroupId: () => string
  readonly windowMs?: number
}

/**
 * 把一条已写入的通知并入聚合。
 *
 * **在 `createNotification` 之后调用，同事务内。** 顺序不能反 —— 组要引用
 * 通知 ID，通知还没写入时那个引用指向不存在的行。
 *
 * `sourceRef` 由调用方给出而不是从 `resourceRef` 推导：§17.1 说的是「来源对象」，
 * 而 `resourceRef` 指向的是**通知本身指向的资源**。多次 @ 提及的 resourceRef 是
 * 各条消息，来源对象却是同一个会话 —— 按 resourceRef 分组的话每条自成一组，
 * 聚合等于没做。
 */
export function aggregateNotification(
  db: DatabaseSync,
  input: AggregateInput,
): AggregationOutcome {
  const { notification } = input

  // §17.1：安全类、签收请求、权限变更、风险处置始终逐条呈现。
  // 折叠它们会让用户错过需要逐条处置的事项
  if ((NEVER_AGGREGATED as readonly string[]).includes(notification.eventType)) {
    return { kind: 'not_aggregated' }
  }

  const windowMs = input.windowMs ?? DEFAULT_AGGREGATION_WINDOW_MS
  const cutoff = new Date(input.now.getTime() - windowMs).toISOString()

  const open = db
    .prepare(
      `SELECT * FROM notification_groups
        WHERE organization_id = ? AND recipient_id = ? AND source_ref = ? AND event_type = ?
          AND window_started_at > ?
        ORDER BY window_started_at DESC
        LIMIT 1`,
    )
    .get(
      notification.organizationId,
      notification.recipientId,
      input.sourceRef,
      notification.eventType,
      cutoff,
    ) as Record<string, string | number> | undefined

  if (open === undefined) {
    const groupId = input.newGroupId()
    db.prepare(
      `INSERT INTO notification_groups
         (group_id, organization_id, recipient_id, source_ref, event_type,
          window_started_at, earliest_notification_id, latest_notification_id,
          count, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      groupId,
      notification.organizationId,
      notification.recipientId,
      input.sourceRef,
      notification.eventType,
      notification.createdAt,
      notification.notificationId,
      notification.notificationId,
      notification.state,
      input.now.toISOString(),
    )
    addMember(db, groupId, notification)
    return { kind: 'group_created', group: groupOf(db, groupId)! }
  }

  const groupId = open['group_id'] as string
  db.prepare(
    `UPDATE notification_groups
        SET latest_notification_id = ?, count = count + 1, updated_at = ?
      WHERE group_id = ?`,
  ).run(notification.notificationId, input.now.toISOString(), groupId)
  addMember(db, groupId, notification)
  return { kind: 'group_extended', group: groupOf(db, groupId)! }
}

function addMember(db: DatabaseSync, groupId: string, notification: Notification): void {
  db.prepare(
    `INSERT OR IGNORE INTO notification_group_members
       (organization_id, group_id, notification_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    notification.organizationId,
    groupId,
    notification.notificationId,
    notification.createdAt,
  )
}

export function groupOf(db: DatabaseSync, groupId: string): NotificationGroup | undefined {
  const row = db.prepare('SELECT * FROM notification_groups WHERE group_id = ?').get(groupId) as
    | Record<string, string | number>
    | undefined
  if (row === undefined) return undefined
  return {
    groupId: row['group_id'] as string,
    organizationId: row['organization_id'] as string,
    recipientId: row['recipient_id'] as string,
    sourceRef: row['source_ref'] as string,
    eventType: row['event_type'] as string,
    windowStartedAt: row['window_started_at'] as string,
    earliestNotificationId: row['earliest_notification_id'] as string,
    latestNotificationId: row['latest_notification_id'] as string,
    count: row['count'] as number,
    state: row['state'] as string,
    updatedAt: row['updated_at'] as string,
  }
}

/** 组内的通知 ID，按创建时间升序。「展开后逐条跳转」用这个。 */
export function membersOf(db: DatabaseSync, groupId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT notification_id FROM notification_group_members
        WHERE group_id = ? ORDER BY created_at, notification_id`,
    )
    .all(groupId) as Array<{ notification_id: string }>
  return rows.map((row) => row.notification_id)
}

/**
 * 标记整个聚合条目的状态。
 *
 * §17.1：「聚合条目的已读语义**作用于整条**」。因此这里同时更新组与其全部成员 ——
 * 只更新组的话，展开后每一条仍显示未读，用户被迫再点 N 次。
 */
export function markGroupState(
  db: DatabaseSync,
  groupId: string,
  state: string,
  now: Date,
): number {
  const members = membersOf(db, groupId)
  if (members.length === 0) return 0

  db.prepare('UPDATE notification_groups SET state = ?, updated_at = ? WHERE group_id = ?').run(
    state,
    now.toISOString(),
    groupId,
  )
  const placeholders = members.map(() => '?').join(',')
  const result = db
    .prepare(`UPDATE notifications SET state = ? WHERE notification_id IN (${placeholders})`)
    .run(state, ...members)
  return Number(result.changes)
}

/**
 * 收件箱的聚合视图：一条组 = 一个条目。
 *
 * 不参与聚合的通知**不在这里** —— 它们没有组。调用方需要把两者合并呈现，
 * 这个分工是刻意的：把「不聚合的」硬塞进组模型，会让「count 恒为 1 的组」
 * 与「真的只有一条的组」无法区分。
 */
export function groupedInbox(
  db: DatabaseSync,
  organizationId: string,
  recipientId: string,
  options: { readonly limit?: number } = {},
): readonly NotificationGroup[] {
  const rows = db
    .prepare(
      `SELECT group_id FROM notification_groups
        WHERE organization_id = ? AND recipient_id = ?
        ORDER BY updated_at DESC, group_id
        LIMIT ?`,
    )
    .all(organizationId, recipientId, options.limit ?? 50) as Array<{ group_id: string }>

  return rows.flatMap((row) => {
    const group = groupOf(db, row.group_id)
    return group === undefined ? [] : [group]
  })
}
