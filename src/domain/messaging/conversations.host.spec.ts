/**
 * 会话列表测试。
 *
 * 重点在两处容易出错的地方：**预览必须反映编辑与撤回**（不能显示
 * `messages.body` 里的初始正文），以及**未读要按会话分开数**（不是全局总数）。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { conversationsOf } from './conversations.js'
import { REVOKED_PLACEHOLDER, editMessage, revokeMessage } from './message-events.js'

let db: DatabaseSync
let seq = 0
const ORG = 'org-1'
const T0 = new Date('2026-08-30T12:00:00Z')
const at = (ms: number): string => new Date(T0.getTime() + ms).toISOString()

beforeEach(() => {
  // 计数器必须逐例重置 —— 它是模块级可变状态，不重置的话 delivery_seq
  // 会跨用例累加，按固定 seq 断言的用例就会莫名其妙地失败
  seq = 0
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE accounts (account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL) STRICT;
    CREATE TABLE messages (
      message_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, received_at TEXT NOT NULL, operation_id TEXT NOT NULL,
      event_format_version INTEGER NOT NULL, encryption_meta TEXT NOT NULL,
      PRIMARY KEY (sender_id, message_id)
    ) STRICT;
    CREATE TABLE message_events (
      organization_id TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
      revision INTEGER NOT NULL, event_type TEXT NOT NULL, actor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL, body TEXT, policy_revision INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (organization_id, sender_id, message_id, revision)
    ) STRICT;
    CREATE TABLE delivery_queue (
      organization_id TEXT NOT NULL, recipient_id TEXT NOT NULL, delivery_seq INTEGER NOT NULL,
      sender_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL,
      lease_device_id TEXT, lease_expires_at TEXT, acked_at TEXT, acked_device_id TEXT,
      PRIMARY KEY (organization_id, recipient_id, delivery_seq)
    ) STRICT;
  `)
  for (const [id, name] of [['jia', '甲'], ['yi', '乙'], ['bing', '丙']]) {
    db.prepare('INSERT INTO accounts VALUES (?,?)').run(id, name)
  }
})

afterEach(() => db.close())

/** 写一条消息，并按需在收件人队列里挂一条未 ACK 的投递项。 */
function message(
  senderId: string,
  recipientId: string,
  body: string,
  offsetMs: number,
  options: { queued?: boolean; organizationId?: string } = {},
): string {
  seq += 1
  const messageId = `msg-${seq}`
  const org = options.organizationId ?? ORG
  db.prepare(
    `INSERT INTO messages VALUES (?,?,?,?,'text',?,1,?,?,?,1,'{}')`,
  ).run(messageId, org, senderId, recipientId, body, at(offsetMs), at(offsetMs), `op-${messageId}`)
  if (options.queued === true) {
    db.prepare(
      'INSERT INTO delivery_queue (organization_id, recipient_id, delivery_seq, sender_id, message_id, created_at) VALUES (?,?,?,?,?,?)',
    ).run(org, recipientId, seq, senderId, messageId, at(offsetMs))
  }
  return messageId
}

describe('会话聚合', () => {
  it('按对端聚合，最近活动的排在前面', () => {
    message('jia', 'yi', '给乙的', 0)
    message('bing', 'jia', '丙发来的', 1000)

    const list = conversationsOf(db, ORG, 'jia')
    expect(list.map((c) => c.peerId)).toEqual(['bing', 'yi'])
  })

  it('收发双向都算同一个会话', () => {
    message('jia', 'yi', '甲发的', 0)
    message('yi', 'jia', '乙回的', 1000)
    const list = conversationsOf(db, ORG, 'jia')
    expect(list).toHaveLength(1)
    expect(list[0]?.peerId).toBe('yi')
  })

  it('带出对端显示名', () => {
    message('jia', 'yi', 'hi', 0)
    expect(conversationsOf(db, ORG, 'jia')[0]?.peerDisplayName).toBe('乙')
  })

  it('显示名查不到时用 ID 兜底而不是空串', () => {
    // 账号注销后可能查不到。空标题的会话在列表里无法指认
    message('jia', 'ghost', 'hi', 0)
    expect(conversationsOf(db, ORG, 'jia')[0]?.peerDisplayName).toBe('ghost')
  })

  it('标出最后一条是不是自己发的', () => {
    message('jia', 'yi', '我发的', 0)
    expect(conversationsOf(db, ORG, 'jia')[0]?.lastMessageOutgoing).toBe(true)
    message('yi', 'jia', '他回的', 1000)
    expect(conversationsOf(db, ORG, 'jia')[0]?.lastMessageOutgoing).toBe(false)
  })

  it('不返回与本人无关的会话', () => {
    message('yi', 'bing', '与甲无关', 0)
    expect(conversationsOf(db, ORG, 'jia')).toHaveLength(0)
  })
})

describe('组织隔离（§9）', () => {
  it('不返回其他组织的会话', () => {
    // 少了组织过滤，切换组织后会看到上一个组织的会话列表
    message('jia', 'yi', '本组织', 0)
    message('jia', 'bing', '另一个组织', 1000, { organizationId: 'org-2' })

    const list = conversationsOf(db, ORG, 'jia')
    expect(list.map((c) => c.peerId)).toEqual(['yi'])
  })
})

describe('预览反映编辑与撤回（§14.1）', () => {
  it('未编辑时显示原文', () => {
    message('jia', 'yi', '你好', 0)
    expect(conversationsOf(db, ORG, 'jia')[0]?.preview).toBe('你好')
  })

  it('编辑后显示新正文而不是 messages.body', () => {
    // messages.body 按 §14.1 永远是初始正文。直接用它会让列表显示
    // 一条已被编辑掉的旧内容
    const id = message('jia', 'yi', '原始正文', 0)
    editMessage(db, {
      organizationId: ORG,
      senderId: 'jia',
      messageId: id,
      editorId: 'jia',
      targetRevision: 2,
      body: '改过的正文',
      now: new Date(T0.getTime() + 1000),
      policyRevision: 1,
      operationId: 'op-edit',
      editWindowMs: 60_000,
    })
    expect(conversationsOf(db, ORG, 'jia')[0]?.preview).toBe('改过的正文')
  })

  it('撤回后显示占位而不是原文', () => {
    // 让客户端自己判断是否撤回，等于把正文先发过去再让它别显示 —— 那不叫撤回
    const id = message('jia', 'yi', '不该出现在列表里', 0)
    revokeMessage(db, {
      organizationId: ORG,
      senderId: 'jia',
      messageId: id,
      actorId: 'jia',
      actorHasComplianceAuthority: false,
      now: new Date(T0.getTime() + 1000),
      policyRevision: 1,
      operationId: 'op-revoke',
    })
    const preview = conversationsOf(db, ORG, 'jia')[0]?.preview
    expect(preview).toBe(REVOKED_PLACEHOLDER)
    expect(preview).not.toContain('不该出现在列表里')
  })

  it('撤回后又来一条 revision 更高的编辑，仍显示占位', () => {
    // 撤回是终态。这里走 messageView 而不是自己取最高 revision，
    // 正是为了不在这条上出错
    const id = message('jia', 'yi', '原文', 0)
    revokeMessage(db, {
      organizationId: ORG,
      senderId: 'jia',
      messageId: id,
      actorId: 'jia',
      actorHasComplianceAuthority: false,
      now: new Date(T0.getTime() + 1000),
      policyRevision: 1,
      operationId: 'op-revoke',
    })
    db.prepare(
      `INSERT INTO message_events VALUES (?,?,?,?,'message_edited',?,?,?,1,'op-late')`,
    ).run(ORG, 'jia', id, 99, 'jia', at(2000), '偷偷复活')

    expect(conversationsOf(db, ORG, 'jia')[0]?.preview).toBe(REVOKED_PLACEHOLDER)
  })
})

describe('预览截断', () => {
  it('超长正文被截断并加省略号', () => {
    message('jia', 'yi', '啊'.repeat(200), 0)
    const preview = conversationsOf(db, ORG, 'jia')[0]!.preview
    expect(preview.endsWith('…')).toBe(true)
    expect([...preview].length).toBeLessThan(50)
  })

  it('按字素簇截断，不会把 emoji 劈成半个', () => {
    // 按 UTF-16 码元切会留下孤立代理项，JSON 序列化后是替换字符
    message('jia', 'yi', '👨‍👩‍👧‍👦'.repeat(60), 0)
    const preview = conversationsOf(db, ORG, 'jia')[0]!.preview
    expect(preview).not.toContain('�')
    // 孤立代理项的判定：任何未配对的高/低代理码元
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview)).toBe(
      false,
    )
  })

  it('不超长时原样返回', () => {
    message('jia', 'yi', '短消息', 0)
    expect(conversationsOf(db, ORG, 'jia')[0]?.preview).toBe('短消息')
  })
})

describe('未读计数', () => {
  it('数未 ACK 的投递项', () => {
    message('yi', 'jia', 'a', 0, { queued: true })
    message('yi', 'jia', 'b', 1000, { queued: true })
    expect(conversationsOf(db, ORG, 'jia')[0]?.unreadCount).toBe(2)
  })

  it('已 ACK 的不算未读', () => {
    message('yi', 'jia', 'a', 0, { queued: true })
    db.prepare('UPDATE delivery_queue SET acked_at = ? WHERE sender_id = ?').run(at(2000), 'yi')
    expect(conversationsOf(db, ORG, 'jia')[0]?.unreadCount).toBe(0)
  })

  it('按会话分开数，不是全局总数', () => {
    // 不按发送人过滤的话，每个会话都会显示所有会话的未读之和
    message('yi', 'jia', '乙发的', 0, { queued: true })
    message('bing', 'jia', '丙发的', 1000, { queued: true })
    message('bing', 'jia', '丙又发的', 2000, { queued: true })

    const byPeer = new Map(conversationsOf(db, ORG, 'jia').map((c) => [c.peerId, c.unreadCount]))
    expect(byPeer.get('yi')).toBe(1)
    expect(byPeer.get('bing')).toBe(2)
  })

  it('自己发出去的消息不计入自己的未读', () => {
    message('jia', 'yi', '我发的', 0, { queued: true })
    expect(conversationsOf(db, ORG, 'jia')[0]?.unreadCount).toBe(0)
  })
})

describe('limit', () => {
  it('限制返回条数，且保留最近的', () => {
    for (let i = 0; i < 5; i += 1) message('jia', `peer-${i}`, 'x', i * 1000)
    const list = conversationsOf(db, ORG, 'jia', { limit: 2 })
    expect(list.map((c) => c.peerId)).toEqual(['peer-4', 'peer-3'])
  })
})
