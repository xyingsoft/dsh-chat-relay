/**
 * 消息编辑、撤回与发送方状态机测试。
 *
 * §14.1 的骨干是一句话：「接收方和 host **只接受比本地 revision 更高的事件**，
 * 因此重复投递或乱序同步不会把新正文覆盖为旧正文」。多数用例在从不同角度
 * 逼这一条。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  REVOKED_PLACEHOLDER,
  editMessage,
  eventsOf,
  messageView,
  revokeMessage,
} from './message-events.js'
import {
  enqueueOutgoing,
  markAccepted,
  markFailed,
  outgoingOf,
  pendingOutgoing,
  recordAttempt,
} from './outgoing.js'

let db: DatabaseSync
const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')
const HOUR = 60 * 60 * 1000
const KEY = { organizationId: ORG, senderId: 'jia', messageId: 'msg-1' }

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE messages (
      message_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_format_version INTEGER NOT NULL,
      encryption_meta TEXT NOT NULL,
      PRIMARY KEY (sender_id, message_id)
    ) STRICT;
    CREATE TABLE message_events (
      organization_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      body TEXT,
      policy_revision INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (organization_id, sender_id, message_id, revision)
    ) STRICT;
    CREATE TABLE outgoing_messages (
      organization_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivery_seq INTEGER,
      error_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, sender_id, message_id)
    ) STRICT;
  `)
  db.prepare(
    `INSERT INTO messages VALUES (?,?,?,?,'text',?,1,?,?,'op-0',1,'{"scheme":"none"}')`,
  ).run('msg-1', ORG, 'jia', 'yi', '原始正文', NOW.toISOString(), NOW.toISOString())
})

afterEach(() => db.close())

function edit(overrides: Partial<Parameters<typeof editMessage>[1]> = {}) {
  return editMessage(db, {
    ...KEY,
    editorId: 'jia',
    targetRevision: 2,
    body: '改过的正文',
    now: NOW,
    policyRevision: 1,
    operationId: 'op-edit',
    editWindowMs: HOUR,
    ...overrides,
  })
}

function revoke(overrides: Partial<Parameters<typeof revokeMessage>[1]> = {}) {
  return revokeMessage(db, {
    ...KEY,
    actorId: 'jia',
    actorHasComplianceAuthority: false,
    now: NOW,
    policyRevision: 1,
    operationId: 'op-revoke',
    ...overrides,
  })
}

describe('编辑追加事件而非覆盖', () => {
  it('编辑后 messages 表的 body 原封不动', () => {
    // §14.1：「消息正文不是可原地覆盖的字段」
    expect(edit().ok).toBe(true)
    const row = db
      .prepare('SELECT body FROM messages WHERE sender_id = ? AND message_id = ?')
      .get('jia', 'msg-1') as { body: string }
    expect(row.body).toBe('原始正文')
  })

  it('视图反映最新事件，历史仍可查', () => {
    edit({ targetRevision: 2, body: '第一次改' })
    edit({ targetRevision: 3, body: '第二次改' })
    expect(messageView(db, KEY)?.body).toBe('第二次改')

    const history = eventsOf(db, KEY)
    expect(history.map((e) => e.body)).toEqual(['第一次改', '第二次改'])
  })

  it('编辑事件带齐 §14.1 要求的字段', () => {
    // MessageId、目标 revision、编辑者、编辑时间、策略版本和新内容摘要
    edit({ policyRevision: 7 })
    const event = eventsOf(db, KEY)[0]
    expect(event?.messageId).toBe('msg-1')
    expect(event?.revision).toBe(2)
    expect(event?.actorId).toBe('jia')
    expect(event?.occurredAt).toBe(NOW.toISOString())
    expect(event?.policyRevision).toBe(7)
    expect(event?.body).toBe('改过的正文')
  })

  it('未编辑时 edited 为假，编辑后为真', () => {
    // §14.1：引用要标记原消息当前已编辑
    expect(messageView(db, KEY)?.edited).toBe(false)
    edit()
    expect(messageView(db, KEY)?.edited).toBe(true)
  })
})

describe('只接受更高的 revision', () => {
  it('低于当前 revision 的编辑被拒绝', () => {
    edit({ targetRevision: 5, body: '新' })
    const stale = edit({ targetRevision: 3, body: '旧的迟到了' })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.errorCode).toBe('VERSION_CONFLICT')
    expect(messageView(db, KEY)?.body).toBe('新')
  })

  it('等于当前 revision 的编辑同样被拒绝', () => {
    // 严格大于。同一 revision 的两次编辑内容不同的话，哪次生效取决于到达
    // 顺序 —— 那正是 §14.1 要消除的
    edit({ targetRevision: 2, body: 'A' })
    const same = edit({ targetRevision: 2, body: 'B' })
    expect(same.ok).toBe(false)
    expect(messageView(db, KEY)?.body).toBe('A')
  })

  it('重复投递同一编辑不会改变结果', () => {
    edit({ targetRevision: 2, body: 'A' })
    edit({ targetRevision: 2, body: 'A' })
    expect(eventsOf(db, KEY)).toHaveLength(1)
    expect(messageView(db, KEY)?.body).toBe('A')
  })
})

describe('撤回', () => {
  it('撤回后正文不可得，界面用占位', () => {
    expect(revoke().ok).toBe(true)
    const view = messageView(db, KEY)
    expect(view?.revoked).toBe(true)
    expect(view?.body).toBeUndefined()
    expect(REVOKED_PLACEHOLDER).toBe('[已撤回]')
  })

  it('tombstone 事件不带正文', () => {
    revoke()
    const event = eventsOf(db, KEY).find((e) => e.eventType === 'message_revoked')
    expect(event?.body).toBeUndefined()
  })

  it('撤回也占一个 revision', () => {
    // 不占的话，「撤回」与「迟到的编辑」无法按同一把尺子比较，
    // 而乱序同步正是 §14.1 要处理的情形
    edit({ targetRevision: 2 })
    revoke()
    expect(messageView(db, KEY)?.revision).toBe(3)
  })

  it('已撤回的消息不能再编辑', () => {
    revoke()
    const result = edit({ targetRevision: 9 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('RESOURCE_GONE')
  })

  it('撤回后迟到的高 revision 编辑不复活正文', () => {
    // 事件不可变，迟到的编辑仍然入库；但撤回是终态
    revoke()
    db.prepare(
      `INSERT INTO message_events VALUES (?,?,?,?,'message_edited',?,?,?,1,'op-late')`,
    ).run(ORG, 'jia', 'msg-1', 99, 'jia', NOW.toISOString(), '偷偷复活')
    const view = messageView(db, KEY)
    expect(view?.revoked).toBe(true)
    expect(view?.body).toBeUndefined()
  })

  it('重复撤回是幂等的', () => {
    // 用户在网络不稳时连点两次，第二次报错会让人以为撤回失败了
    const first = revoke()
    const second = revoke()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // 结果一致，但第二次标记为重放 —— 调用方据此跳过审计写入。
    // 不区分的话，同一 operationId 会生成同一个审计 ID 撞主键，
    // 一次本该成功的幂等重放变成 500
    expect(second.revision).toBe(first.revision)
    expect(first.idempotentReplay).toBe(false)
    expect(second.idempotentReplay).toBe(true)
    expect(eventsOf(db, KEY).filter((e) => e.eventType === 'message_revoked')).toHaveLength(1)
  })

  it('撤回不受编辑窗口限制', () => {
    // §14.1 只对编辑说了「在组织配置的编辑窗口内」。合规撤回的场景
    // 恰恰是事后才发现内容有问题
    const muchLater = new Date(NOW.getTime() + 365 * 24 * HOUR)
    expect(revoke({ now: muchLater }).ok).toBe(true)
  })
})

describe('谁能改、谁能撤', () => {
  it('只有原发送者能编辑', () => {
    const result = edit({ editorId: 'yi' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NOT_FOUND_OR_FORBIDDEN')
  })

  it('有合规权限的管理员也不能编辑他人消息', () => {
    // §14.1 把合规权限只授予撤回。让管理员改写他人消息的正文，
    // 等于一个不留痕的伪造通道
    const result = editMessage(db, {
      ...KEY,
      editorId: 'admin',
      targetRevision: 2,
      body: '管理员改的',
      now: NOW,
      policyRevision: 1,
      operationId: 'op',
      editWindowMs: HOUR,
    })
    expect(result.ok).toBe(false)
  })

  it('有合规权限的管理员可以撤回', () => {
    expect(revoke({ actorId: 'admin', actorHasComplianceAuthority: true }).ok).toBe(true)
  })

  it('无合规权限的他人不能撤回', () => {
    const result = revoke({ actorId: 'yi', actorHasComplianceAuthority: false })
    expect(result.ok).toBe(false)
  })

  it('消息不存在与无权限返回同一错误码', () => {
    const missing = editMessage(db, {
      organizationId: ORG,
      senderId: 'jia',
      messageId: 'msg-does-not-exist',
      editorId: 'jia',
      targetRevision: 2,
      body: 'x',
      now: NOW,
      policyRevision: 1,
      operationId: 'op',
      editWindowMs: HOUR,
    })
    const forbidden = edit({ editorId: 'yi' })
    expect(missing).toEqual(forbidden)
  })
})

describe('编辑窗口', () => {
  it('窗口内可以编辑', () => {
    expect(edit({ now: new Date(NOW.getTime() + HOUR - 1) }).ok).toBe(true)
  })

  it('超出窗口不能编辑', () => {
    const result = edit({ now: new Date(NOW.getTime() + HOUR + 1) })
    expect(result.ok).toBe(false)
  })

  it('窗口由调用方给出，不是硬编码', () => {
    // §14.1 说「组织配置的编辑窗口」。写死一个值等于替所有组织做决定
    const later = new Date(NOW.getTime() + 10 * HOUR)
    expect(edit({ now: later, editWindowMs: HOUR }).ok).toBe(false)
    expect(edit({ now: later, editWindowMs: 24 * HOUR }).ok).toBe(true)
  })
})

describe('发送方状态机', () => {
  const OUT = { organizationId: ORG, senderId: 'jia', messageId: 'out-1' }

  function enqueue() {
    return enqueueOutgoing(db, { ...OUT, recipientId: 'yi', body: '你好', now: NOW })
  }

  it('入队即为 pending，且不声称已送达', () => {
    // §4：绝不把未确认内容显示为已送达
    expect(enqueue().state).toBe('pending')
    expect(enqueue().deliverySeq).toBeUndefined()
  })

  it('pending → accepted 带上服务器给的 DeliverySeq', () => {
    enqueue()
    expect(markAccepted(db, OUT, 42, NOW)).toBe(true)
    const after = outgoingOf(db, OUT)
    expect(after?.state).toBe('accepted')
    expect(after?.deliverySeq).toBe(42)
  })

  it('pending → failed 记录终态错误码', () => {
    enqueue()
    expect(markFailed(db, OUT, 'RECIPIENT_INACTIVE', NOW)).toBe(true)
    const after = outgoingOf(db, OUT)
    expect(after?.state).toBe('failed')
    expect(after?.errorCode).toBe('RECIPIENT_INACTIVE')
  })

  it('failed 不能复活为 accepted', () => {
    // 「刚才说发送失败，现在又说发出去了」，用户没有理由相信哪一个
    enqueue()
    markFailed(db, OUT, 'RECIPIENT_INACTIVE', NOW)
    expect(markAccepted(db, OUT, 42, NOW)).toBe(false)
    expect(outgoingOf(db, OUT)?.state).toBe('failed')
  })

  it('accepted 后重复确认是幂等的', () => {
    enqueue()
    markAccepted(db, OUT, 42, NOW)
    expect(markAccepted(db, OUT, 42, NOW)).toBe(true)
    expect(outgoingOf(db, OUT)?.state).toBe('accepted')
  })

  it('accepted 后不能被标为 failed', () => {
    enqueue()
    markAccepted(db, OUT, 42, NOW)
    expect(markFailed(db, OUT, 'RATE_LIMITED', NOW)).toBe(false)
    expect(outgoingOf(db, OUT)?.state).toBe('accepted')
  })

  it('重复入队同一 messageId 是幂等的', () => {
    // (senderId, messageId) 已是 §14 的幂等键，重试沿用同一个键正是它的用途
    enqueue()
    markAccepted(db, OUT, 7, NOW)
    const again = enqueueOutgoing(db, {
      ...OUT,
      recipientId: 'yi',
      body: '你好',
      now: new Date(NOW.getTime() + 1000),
    })
    // 已 accepted 的不该被重新入队打回 pending
    expect(again.state).toBe('accepted')
    expect(again.deliverySeq).toBe(7)
  })

  it('可重试的失败停留在 pending 并计尝试次数', () => {
    // 把可重试的失败标成终态，等于替用户放弃了一条本来能发出去的消息
    enqueue()
    expect(recordAttempt(db, OUT, NOW)).toBe(1)
    expect(recordAttempt(db, OUT, NOW)).toBe(2)
    expect(outgoingOf(db, OUT)?.state).toBe('pending')
  })

  it('待重发清单只含 pending，不含 failed', () => {
    // failed 是终态，不自动重发。自动重发会让「终态」这个词失去意义
    enqueueOutgoing(db, { ...OUT, recipientId: 'yi', body: 'a', now: NOW })
    enqueueOutgoing(db, {
      organizationId: ORG,
      senderId: 'jia',
      messageId: 'out-2',
      recipientId: 'yi',
      body: 'b',
      now: new Date(NOW.getTime() + 1000),
    })
    markFailed(db, { ...OUT, messageId: 'out-2' }, 'RECIPIENT_INACTIVE', NOW)

    const pending = pendingOutgoing(db, ORG, 'jia')
    expect(pending.map((m) => m.messageId)).toEqual(['out-1'])
  })

  it('三态互不重叠，且没有 delivered', () => {
    // 发送方无从得知接收方是否真收到，accepted 是能确知的最远一步
    enqueue()
    const states = new Set(['pending', 'accepted', 'failed'])
    expect(states.has('delivered')).toBe(false)
    expect(states.has(outgoingOf(db, OUT)!.state)).toBe(true)
  })
})
