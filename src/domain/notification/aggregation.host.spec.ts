/**
 * 通知聚合测试。
 *
 * §17.1 有一句话值得反复验证：「**去重键与聚合是两件事**」。
 * 混淆两者的实现会在「同一事件重投」和「不同事件折叠」上都出错，
 * 所以这里两组行为分开测，并有一条专门确认它们互不干扰。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AGGREGATION_WINDOW_MS,
  aggregateNotification,
  groupOf,
  groupedInbox,
  markGroupState,
  membersOf,
} from './aggregation.js'
import { NEVER_AGGREGATED, createNotification, findNotification } from './inbox.js'

let db: DatabaseSync
const ORG = 'org-1'
const T0 = new Date('2026-08-30T12:00:00Z')
let counter = 0

beforeEach(() => {
  counter = 0
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE notifications (
      notification_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      actor_id TEXT,
      summary TEXT NOT NULL,
      priority TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX idx_notifications_dedupe
      ON notifications(organization_id, recipient_id, dedupe_key);
    CREATE TABLE notification_groups (
      group_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      event_type TEXT NOT NULL,
      window_started_at TEXT NOT NULL,
      earliest_notification_id TEXT NOT NULL,
      latest_notification_id TEXT NOT NULL,
      count INTEGER NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE notification_group_members (
      organization_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      notification_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, notification_id)
    ) STRICT;
  `)
})

afterEach(() => db.close())

/** 写一条通知并并入聚合。返回聚合结果。 */
function notify(options: {
  eventType?: string
  sourceRef?: string
  recipientId?: string
  at?: Date
  dedupeKey?: string
  windowMs?: number
}) {
  counter += 1
  const now = options.at ?? T0
  const created = createNotification(db, {
    notificationId: `n-${counter}`,
    organizationId: ORG,
    recipientId: options.recipientId ?? 'yi',
    eventType: options.eventType ?? 'mention',
    resourceRef: `message:msg-${counter}`,
    summary: `第 ${counter} 条`,
    dedupeKey: options.dedupeKey ?? `dk-${counter}`,
    now,
  })
  if (!created.ok) return { created, aggregation: undefined }

  const aggregation = aggregateNotification(db, {
    notification: created.notification,
    sourceRef: options.sourceRef ?? 'conversation:conv-1',
    now,
    newGroupId: () => `g-${counter}`,
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
  })
  return { created, aggregation }
}

describe('窗口内折叠为一条', () => {
  it('同一 (接收人, 来源对象, 事件类型) 的多条折叠为一组', () => {
    notify({})
    notify({ at: new Date(T0.getTime() + 60_000) })
    const third = notify({ at: new Date(T0.getTime() + 120_000) })

    expect(third.aggregation?.kind).toBe('group_extended')
    const groups = groupedInbox(db, ORG, 'yi')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(3)
  })

  it('保留最早与最新事件引用（§17.1）', () => {
    notify({})
    notify({ at: new Date(T0.getTime() + 60_000) })
    notify({ at: new Date(T0.getTime() + 120_000) })

    const group = groupedInbox(db, ORG, 'yi')[0]!
    expect(group.earliestNotificationId).toBe('n-1')
    expect(group.latestNotificationId).toBe('n-3')
  })

  it('每条通知照常写入，聚合不丢数据', () => {
    // 「展开后逐条跳转」要求被折叠的每一条仍然可查
    notify({})
    notify({ at: new Date(T0.getTime() + 60_000) })
    expect(findNotification(db, 'n-1')).toBeDefined()
    expect(findNotification(db, 'n-2')).toBeDefined()
    expect(membersOf(db, 'g-1')).toEqual(['n-1', 'n-2'])
  })
})

describe('分组键的三个维度', () => {
  it('不同接收人不折叠', () => {
    notify({ recipientId: 'yi' })
    notify({ recipientId: 'bing', at: new Date(T0.getTime() + 1000) })
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(1)
    expect(groupedInbox(db, ORG, 'bing')).toHaveLength(1)
  })

  it('不同来源对象不折叠', () => {
    notify({ sourceRef: 'conversation:a' })
    notify({ sourceRef: 'conversation:b', at: new Date(T0.getTime() + 1000) })
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(2)
  })

  it('不同事件类型不折叠', () => {
    notify({ eventType: 'mention' })
    notify({ eventType: 'work_item_changed', at: new Date(T0.getTime() + 1000) })
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(2)
  })

  it('来源对象与 resourceRef 是两回事', () => {
    // 多次 @ 提及的 resourceRef 是各条消息，来源对象却是同一个会话。
    // 按 resourceRef 分组的话每条自成一组，聚合等于没做
    const a = notify({ sourceRef: 'conversation:conv-1' })
    const b = notify({ sourceRef: 'conversation:conv-1', at: new Date(T0.getTime() + 1000) })
    expect(a.created.ok && b.created.ok).toBe(true)
    if (!a.created.ok || !b.created.ok) return
    expect(a.created.notification.resourceRef).not.toBe(b.created.notification.resourceRef)
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(1)
  })
})

describe('聚合窗口', () => {
  it('窗口内并入现有组', () => {
    notify({})
    const inside = notify({ at: new Date(T0.getTime() + DEFAULT_AGGREGATION_WINDOW_MS - 1) })
    expect(inside.aggregation?.kind).toBe('group_extended')
  })

  it('超出窗口开新组', () => {
    notify({})
    const outside = notify({ at: new Date(T0.getTime() + DEFAULT_AGGREGATION_WINDOW_MS + 1000) })
    expect(outside.aggregation?.kind).toBe('group_created')
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(2)
  })

  it('窗口从组内最早一条起算，不随新事件延长', () => {
    // 从最新一条起算的话，持续的提及会让窗口无限延长 ——
    // 一个吵闹的会话可以永远折叠成一条，用户再也看不到新提醒
    const window = DEFAULT_AGGREGATION_WINDOW_MS
    notify({ at: T0 })
    notify({ at: new Date(T0.getTime() + window - 1000) })
    // 距最早一条已超窗，距上一条只过了 2 秒
    const third = notify({ at: new Date(T0.getTime() + window + 1000) })
    expect(third.aggregation?.kind).toBe('group_created')
  })

  it('窗口可配置', () => {
    // §17.1 说「可配置的聚合窗口（默认 5 分钟）」
    expect(DEFAULT_AGGREGATION_WINDOW_MS).toBe(5 * 60 * 1000)
    notify({ windowMs: 1000 })
    const outside = notify({ at: new Date(T0.getTime() + 2000), windowMs: 1000 })
    expect(outside.aggregation?.kind).toBe('group_created')
  })
})

describe('不参与聚合的事件', () => {
  it('§17.1 列出的四类始终逐条呈现', () => {
    for (const eventType of NEVER_AGGREGATED) {
      const result = notify({ eventType })
      expect(result.aggregation?.kind, `${eventType} 不该被聚合`).toBe('not_aggregated')
    }
    // 一个组都没建
    expect(groupedInbox(db, ORG, 'yi')).toHaveLength(0)
  })

  it('不聚合的通知本身照常写入', () => {
    // 「不聚合」是不折叠，不是不通知
    const result = notify({ eventType: 'security_alert' })
    expect(result.created.ok).toBe(true)
    expect(findNotification(db, 'n-1')).toBeDefined()
  })

  it('同一来源下聚合与不聚合的事件互不影响', () => {
    notify({ eventType: 'mention' })
    notify({ eventType: 'security_alert', at: new Date(T0.getTime() + 1000) })
    notify({ eventType: 'mention', at: new Date(T0.getTime() + 2000) })
    const groups = groupedInbox(db, ORG, 'yi')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(2)
  })
})

describe('去重键与聚合是两件事（§17.1）', () => {
  it('同一去重键重投不产生第二条，也不增加计数', () => {
    notify({ dedupeKey: 'same' })
    const replay = notify({ dedupeKey: 'same', at: new Date(T0.getTime() + 1000) })
    expect(replay.created.ok).toBe(false)
    expect(groupedInbox(db, ORG, 'yi')[0]?.count).toBe(1)
  })

  it('不同去重键的不同事件正常折叠', () => {
    // 这是聚合该做的事：多个**不同**事件折叠为一条可展开条目
    notify({ dedupeKey: 'a' })
    notify({ dedupeKey: 'b', at: new Date(T0.getTime() + 1000) })
    expect(groupedInbox(db, ORG, 'yi')[0]?.count).toBe(2)
  })
})

describe('已读语义作用于整条', () => {
  it('标记组为已读时全部成员一并标记', () => {
    // 只更新组的话，展开后每一条仍显示未读，用户被迫再点 N 次
    notify({})
    notify({ at: new Date(T0.getTime() + 1000) })
    notify({ at: new Date(T0.getTime() + 2000) })

    expect(markGroupState(db, 'g-1', 'read', T0)).toBe(3)
    expect(groupOf(db, 'g-1')?.state).toBe('read')
    for (const id of ['n-1', 'n-2', 'n-3']) {
      expect(findNotification(db, id)?.state).toBe('read')
    }
  })

  it('不影响其他组的成员', () => {
    notify({ sourceRef: 'conversation:a' })
    notify({ sourceRef: 'conversation:b', at: new Date(T0.getTime() + 1000) })
    markGroupState(db, 'g-1', 'read', T0)
    expect(findNotification(db, 'n-2')?.state).toBe('queued')
  })

  it('空组不报错', () => {
    expect(markGroupState(db, 'g-nonexistent', 'read', T0)).toBe(0)
  })
})
