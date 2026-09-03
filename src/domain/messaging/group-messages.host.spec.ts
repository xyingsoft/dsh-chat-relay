/**
 * 群消息组播入队测试（P1 S3，relay 侧）。
 *
 * 关键不变量：
 * - 一条群消息 → messages 一行（recipient_type='group'）+ 每名成员一条队列项；
 * - 发件人自己不收自己的群消息；
 * - 容量先检：任一人队列满 → 整条 RECIPIENT_QUEUE_FULL（可安全重试）；
 * - 幂等键 (senderId, messageId)：重放返回首次的 delivery_seq，不重复建队。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptGroupMessage } from './group-messages.js'
import { pendingDepth } from './delivery.js'

let db: DatabaseSync
const ORG = 'org-1'
const GROUP = 'group-1'
const at = new Date('2026-09-03T00:00:00.000Z')
let seq = 0

beforeEach(() => {
  seq = 0
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE groups (
      organization_id TEXT NOT NULL, group_id TEXT NOT NULL,
      name TEXT NOT NULL, created_by_account_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id)
    ) STRICT;
    CREATE TABLE group_members (
      organization_id TEXT NOT NULL, group_id TEXT NOT NULL,
      account_id TEXT NOT NULL, joined_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id, account_id)
    ) STRICT;
    CREATE TABLE messages (
      message_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      recipient_type TEXT NOT NULL DEFAULT 'account',
      kind TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, received_at TEXT NOT NULL, operation_id TEXT NOT NULL,
      event_format_version INTEGER NOT NULL, encryption_meta TEXT NOT NULL,
      PRIMARY KEY (sender_id, message_id)
    ) STRICT;
    CREATE TABLE delivery_queue (
      organization_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      delivery_seq INTEGER NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
      created_at TEXT NOT NULL, lease_device_id TEXT, lease_expires_at TEXT,
      acked_at TEXT, acked_device_id TEXT,
      PRIMARY KEY (organization_id, recipient_id, delivery_seq)
    ) STRICT;
    CREATE TABLE stream_state (
      organization_id TEXT NOT NULL, partition_key TEXT NOT NULL,
      stream_epoch INTEGER NOT NULL, high_watermark INTEGER NOT NULL,
      PRIMARY KEY (organization_id, partition_key)
    ) STRICT;
  `)
  // 群「甲乙丙」，甲为创建者
  db.prepare(
    `INSERT INTO groups (organization_id, group_id, name, created_by_account_id, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(ORG, GROUP, '三人行', 'jia', at.toISOString())
  for (const [who, by] of [['jia', 'jia'], ['yi', 'jia'], ['bing', 'jia']]) {
    db.prepare(
      `INSERT INTO group_members (organization_id, group_id, account_id, joined_at)
       VALUES (?,?,?,?)`,
    ).run(ORG, GROUP, who, at.toISOString())
  }
})

afterEach(() => db.close())

function sendFrom(senderId: string, options: { body?: string; queueCapacity?: number } = {}): ReturnType<typeof acceptGroupMessage> {
  seq += 1
  return acceptGroupMessage(db, {
    messageId: `gm-${seq}`,
    organizationId: ORG,
    senderId,
    groupId: GROUP,
    body: options.body ?? '大家好',
    operationId: `op-${seq}`,
    now: at,
    queueCapacity: options.queueCapacity ?? 100,
  })
}

describe('组播入队', () => {
  it('发件人除外，每名成员各入一条队，messages 标记 group', () => {
    const result = sendFrom('jia')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recipients).toBe(2)
    expect(result.rows.map((r) => r.recipientId).sort()).toEqual(['bing', 'yi'])
    for (const r of result.rows) {
      expect(pendingDepth(db, ORG, r.recipientId)).toBe(1)
    }
    const row = db
      .prepare(
        'SELECT recipient_id, recipient_type FROM messages WHERE sender_id = ? AND message_id = ?',
      )
      .get('jia', 'gm-1') as { recipient_id: string; recipient_type: string }
    expect(row.recipient_type).toBe('group')
    expect(row.recipient_id).toBe(GROUP)
  })

  it('群外发件人被拒（NOT_FOUND_OR_FORBIDDEN，不泄露群是否存在）', () => {
    const result = sendFrom('outsider')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NOT_FOUND_OR_FORBIDDEN')
  })

  it('任一人队列满则整条拒绝且不写任何队', () => {
    // 先由乙发一条：甲、丙各占 1
    const fill = sendFrom('yi')
    expect(fill.ok).toBe(true)
    if (!fill.ok) return
    // 甲再发（容量上限 1）→ 丙队列已满，整条拒绝
    const result = sendFrom('jia', { queueCapacity: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('RECIPIENT_QUEUE_FULL')
      expect(result.pendingCount).toBe(1)
    }
    // 没有部分入队：甲、丙深度保持 1（只有乙那条）
    expect(pendingDepth(db, ORG, 'jia')).toBe(1)
    expect(pendingDepth(db, ORG, 'bing')).toBe(1)
  })

  it('幂等重放返回首次 delivery_seq，不重复入队', () => {
    const input = {
      messageId: 'gm-idem',
      organizationId: ORG,
      senderId: 'yi',
      groupId: GROUP,
      body: '幂等测试',
      operationId: 'op-idem',
      now: at,
      queueCapacity: 100,
    } as const
    const first = acceptGroupMessage(db, input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = acceptGroupMessage(db, input)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.idempotentReplay).toBe(true)
    expect(second.rows.map((r) => [r.recipientId, r.deliverySeq])).toEqual(
      first.rows.map((r) => [r.recipientId, r.deliverySeq]),
    )
    expect(pendingDepth(db, ORG, 'jia')).toBe(1)
    expect(pendingDepth(db, ORG, 'bing')).toBe(1)
  })

  it('空白正文被拒', () => {
    const result = sendFrom('jia', { body: '   ' })
    expect(result.ok).toBe(false)
  })
})
