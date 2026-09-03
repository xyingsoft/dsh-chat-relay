/**
 * 群会话列表测试（P1 S4c，relay 侧）。
 *
 * 关键不变量：只列我所在的群；群会话带 kind=group 与 memberCount；
 * 未读 = 该群消息里发给我的未 ACK 项；最后一条由群成员发出才算。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { groupConversationsOf } from './group-conversations.js'
import { acceptGroupMessage } from './group-messages.js'

let db: DatabaseSync
const ORG = 'org-1'
const GROUP = 'group-1'
const at = new Date('2026-09-03T00:00:00.000Z')
let seq = 0

function table() {
  return `
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
  `
}

beforeEach(() => {
  seq = 0
  db = new DatabaseSync(':memory:')
  db.exec(table())
  db.prepare(
    `INSERT INTO groups (organization_id, group_id, name, created_by_account_id, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(ORG, GROUP, '三人行', 'jia', at.toISOString())
  for (const who of ['jia', 'yi']) {
    db.prepare(
      `INSERT INTO group_members (organization_id, group_id, account_id, joined_at)
       VALUES (?,?,?,?)`,
    ).run(ORG, GROUP, who, at.toISOString())
  }
})

afterEach(() => db.close())

function groupSend(senderId: string, body: string): void {
  seq += 1
  const result = acceptGroupMessage(db, {
    messageId: `gm-${seq}`,
    organizationId: ORG,
    senderId,
    groupId: GROUP,
    body,
    operationId: `op-${seq}`,
    now: at,
    queueCapacity: 100,
  })
  expect(result.ok).toBe(true)
}

describe('groupConversationsOf', () => {
  it('群消息发出后，成员各自的列表出现该群（kind=group + 成员数 + 未读）', () => {
    groupSend('jia', '大家好，这是群公告')
    const list = groupConversationsOf({ db, organizationId: ORG, accountId: 'yi' })
    expect(list).toHaveLength(1)
    const row = list[0]!
    expect(row.kind).toBe('group')
    expect(row.peerId).toBe(GROUP)
    expect(row.peerDisplayName).toBe('三人行')
    expect(row.memberCount).toBe(2)
    expect(row.preview).toContain('群公告')
    // 甲发的群消息：乙还没 ACK → 未读 1
    expect(row.unreadCount).toBe(1)
    expect(row.lastMessageOutgoing).toBe(false)
  })

  it('发件人自己不在自己列表里造未读', () => {
    groupSend('jia', '公告')
    const mine = groupConversationsOf({ db, organizationId: ORG, accountId: 'jia' })
    expect(mine[0]!.unreadCount).toBe(0)
    expect(mine[0]!.lastMessageOutgoing).toBe(true)
  })

  it('不是成员看不到群会话', () => {
    groupSend('jia', '公告')
    expect(groupConversationsOf({ db, organizationId: ORG, accountId: 'outsider' })).toEqual([])
  })

  it('不同组织同 group_id 不串（org 作用域）', () => {
    db.prepare(
      `INSERT INTO groups (organization_id, group_id, name, created_by_account_id, created_at)
       VALUES (?,?,?,?,?)`,
    ).run('org-2', GROUP, '另一组织同名群', 'jia', at.toISOString())
    expect(groupConversationsOf({ db, organizationId: 'org-2', accountId: 'yi' })).toEqual([])
  })
})
