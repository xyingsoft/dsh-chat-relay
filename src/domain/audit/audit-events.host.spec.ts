/**
 * 审计测试。
 *
 * 覆盖 §43 第 14 步与 §44.1.2 的三条验收：被拒绝的尝试同样留痕、审计表不含
 * 消息正文、审计写入失败导致整个命令失败。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from '../../storage/database.js'

import { auditEventsOf, findSequenceGaps, recordAuditEvent } from './audit-events.js'

let chat: ChatDatabase
const now = new Date('2026-08-30T00:00:00Z')
const ORG = 'org-1'

beforeEach(() => {
  chat = ChatDatabase.open({ location: ':memory:' })
})

afterEach(() => chat.close())

const record = (id: string, overrides: Partial<Parameters<typeof recordAuditEvent>[1]> = {}) =>
  chat.transaction((db) =>
    recordAuditEvent(db, {
      auditEventId: id,
      organizationId: ORG,
      eventType: 'work_item_changed',
      occurredAt: now,
      targetRef: 'work_item:wi-1',
      outcome: 'succeeded',
      policyRevision: 1,
      ...overrides,
    }),
  )

describe('序列号', () => {
  it('按组织单调递增，从 1 开始', () => {
    expect(record('a-1')).toBe(1)
    expect(record('a-2')).toBe(2)
    expect(record('a-3')).toBe(3)
  })

  it('不同组织各自独立编号', () => {
    record('a-1')
    record('a-2')
    const otherOrg = chat.transaction((db) =>
      recordAuditEvent(db, {
        auditEventId: 'b-1',
        organizationId: 'org-2',
        eventType: 'x',
        occurredAt: now,
        targetRef: 'y',
        outcome: 'succeeded',
        policyRevision: 1,
      }),
    )
    // 序列按组织分区；用表级自增列会让两个组织共享编号空间
    expect(otherOrg).toBe(1)
  })

  it('连续写入无缺口', () => {
    record('a-1')
    record('a-2')
    record('a-3')
    expect(findSequenceGaps(chat.readonlyHandle, ORG)).toEqual([])
  })

  it('中间记录被删除时能检出缺口', () => {
    // 仅追加存储的价值在于删除会留下痕迹
    record('a-1')
    record('a-2')
    record('a-3')
    chat.transaction((db) => {
      db.prepare('DELETE FROM audit_events WHERE audit_event_id = ?').run('a-2')
    })
    expect(findSequenceGaps(chat.readonlyHandle, ORG)).toEqual([2])
  })
})

describe('被拒绝的尝试同样留痕（§43 第 14 步）', () => {
  it('rejected 与 succeeded 都会被记录', () => {
    record('ok-1', { outcome: 'succeeded' })
    record('no-1', { outcome: 'rejected', errorCode: 'NOT_FOUND_OR_FORBIDDEN' })

    const events = auditEventsOf(chat.readonlyHandle, ORG)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.outcome)).toEqual(['succeeded', 'rejected'])
  })

  it('被拒绝时记录错误码，供事后核对拒绝是否符合预期', () => {
    record('no-1', { outcome: 'rejected', errorCode: 'RECIPIENT_QUEUE_FULL' })
    const events = auditEventsOf(chat.readonlyHandle, ORG)
    expect(events[0]?.errorCode).toBe('RECIPIENT_QUEUE_FULL')
  })

  it('策略修订被记录，使权限判定可复算', () => {
    // §48：以策略版本写入审计和分析结果，确保后续可复算
    record('a-1', { policyRevision: 7 })
    expect(auditEventsOf(chat.readonlyHandle, ORG)[0]?.policyRevision).toBe(7)
  })
})

describe('审计表不含消息正文（§43 第 14 步）', () => {
  it('表结构中没有 body/content 列', () => {
    const columns = (
      chat.readonlyHandle.prepare('PRAGMA table_info(audit_events)').all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(columns).not.toContain('body')
    expect(columns).not.toContain('content')
    expect(columns).not.toContain('message_body')
  })

  it('targetRef 只放引用，不放内容', () => {
    record('a-1', { targetRef: 'message:alice/m-1' })
    const event = auditEventsOf(chat.readonlyHandle, ORG)[0]!
    // 引用形如 message:<sender>/<messageId>，需要正文时按引用回主表查，
    // 且那条查询本身受权限约束
    expect(event.targetRef).toBe('message:alice/m-1')
  })
})

describe('审计写入失败导致整个命令失败（§44.1.2）', () => {
  it('审计写入抛错时领域写入一并回滚', () => {
    // 主键冲突模拟审计写入失败
    record('dup-1')

    expect(() =>
      chat.transaction((db) => {
        // 先做领域写入
        db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
          'acc-x',
          '甲',
          now.toISOString(),
        )
        // 再写审计——用重复 ID 触发失败
        recordAuditEvent(db, {
          auditEventId: 'dup-1',
          organizationId: ORG,
          eventType: 'x',
          occurredAt: now,
          targetRef: 'y',
          outcome: 'succeeded',
          policyRevision: 1,
        })
      }),
    ).toThrow()

    const account = chat.readonlyHandle
      .prepare('SELECT account_id FROM accounts WHERE account_id = ?')
      .get('acc-x')
    expect(account, '审计失败时领域写入必须一并回滚').toBeUndefined()
  })

  it('写审计的函数不吞异常', () => {
    // 若实现捕获了异常并返回「失败但继续」，上一条用例会通过而这条会失败：
    // 它验证异常确实向上传播，而不是被静默处理
    record('dup-1')
    let threw = false
    try {
      chat.transaction((db) =>
        recordAuditEvent(db, {
          auditEventId: 'dup-1',
          organizationId: ORG,
          eventType: 'x',
          occurredAt: now,
          targetRef: 'y',
          outcome: 'succeeded',
          policyRevision: 1,
        }),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('查询', () => {
  it('按序列升序返回，支持游标', () => {
    record('a-1')
    record('a-2')
    record('a-3')
    const page = auditEventsOf(chat.readonlyHandle, ORG, { afterSeq: 1, limit: 10 })
    expect(page.map((e) => e.serverSeq)).toEqual([2, 3])
  })

  it('不返回其他组织的事件', () => {
    // §48：多租户隔离，查询必须携带 OrganizationId
    record('a-1')
    chat.transaction((db) =>
      recordAuditEvent(db, {
        auditEventId: 'b-1',
        organizationId: 'org-2',
        eventType: 'x',
        occurredAt: now,
        targetRef: 'y',
        outcome: 'succeeded',
        policyRevision: 1,
      }),
    )
    const events = auditEventsOf(chat.readonlyHandle, ORG)
    expect(events).toHaveLength(1)
    expect(events[0]?.auditEventId).toBe('a-1')
  })
})
