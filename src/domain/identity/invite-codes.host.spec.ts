/**
 * 邀请码测试。
 *
 * 重点是三条拒绝路径与并发下的一次性保证 —— §45 要求「每条拒绝路径都有聚焦用例」，
 * 且断言的是拒绝行为与错误码。
 */

import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import {
  consumeInviteCode,
  findInviteCode,
  generateInviteCode,
  issueInviteCode,
} from './invite-codes.js'

let db: DatabaseSync
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE accounts (account_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_by TEXT,
      consumed_at TEXT
    ) STRICT;
  `)
})

afterEach(() => db.close())

const issue = (code: string, now = new Date('2026-08-30T00:00:00Z'), validForMs = 24 * HOUR) =>
  issueInviteCode(db, {
    code,
    organizationId: 'org-1',
    createdBy: 'admin-1',
    now,
    validForMs,
  })

describe('签发', () => {
  it('新码未被消费，且有效期由入参决定', () => {
    const created = issue('CODE-A')
    expect(created.consumedBy).toBeNull()
    expect(created.consumedAt).toBeNull()
    expect(new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime()).toBe(
      24 * HOUR,
    )
  })

  it('生成的码只含无歧义字符', () => {
    const code = generateInviteCode((n) => new Uint8Array(randomBytes(n)))
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/)
    // 排除易混字符，避免人工转抄出错
    expect(code).not.toMatch(/[IO01]/)
  })
})

describe('消费', () => {
  it('首次消费成功并返回组织', () => {
    issue('CODE-B')
    const result = consumeInviteCode(db, {
      code: 'CODE-B',
      accountId: 'acc-1',
      now: new Date('2026-08-30T01:00:00Z'),
    })
    expect(result).toEqual({ ok: true, organizationId: 'org-1' })
  })

  it('消费后记录保留使用者与时间，不被删除', () => {
    // 审计需要知道谁在什么时候用了哪个码；删记录会让 §43 第 14 步无法核对
    issue('CODE-C')
    consumeInviteCode(db, {
      code: 'CODE-C',
      accountId: 'acc-2',
      now: new Date('2026-08-30T02:00:00Z'),
    })
    const stored = findInviteCode(db, 'CODE-C')
    expect(stored?.consumedBy).toBe('acc-2')
    expect(stored?.consumedAt).toBe('2026-08-30T02:00:00.000Z')
  })

  it('第二次消费被拒绝', () => {
    issue('CODE-D')
    const now = new Date('2026-08-30T01:00:00Z')
    consumeInviteCode(db, { code: 'CODE-D', accountId: 'acc-1', now })
    const second = consumeInviteCode(db, { code: 'CODE-D', accountId: 'acc-2', now })
    expect(second.ok).toBe(false)
    expect(second).toMatchObject({ errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })

  it('第二次消费不会覆盖首个使用者', () => {
    issue('CODE-E')
    const now = new Date('2026-08-30T01:00:00Z')
    consumeInviteCode(db, { code: 'CODE-E', accountId: 'first', now })
    consumeInviteCode(db, { code: 'CODE-E', accountId: 'second', now })
    expect(findInviteCode(db, 'CODE-E')?.consumedBy).toBe('first')
  })

  it('过期码被拒绝', () => {
    issue('CODE-F', new Date('2026-08-30T00:00:00Z'), 1 * HOUR)
    const result = consumeInviteCode(db, {
      code: 'CODE-F',
      accountId: 'acc-1',
      now: new Date('2026-08-30T02:00:00Z'),
    })
    expect(result.ok).toBe(false)
  })

  it('不存在的码被拒绝', () => {
    const result = consumeInviteCode(db, {
      code: 'NEVER-ISSUED',
      accountId: 'acc-1',
      now: new Date(),
    })
    expect(result.ok).toBe(false)
  })
})

describe('不泄露存在性', () => {
  it('不存在、已消费、已过期三种失败返回同一个错误码', () => {
    issue('CODE-G')
    const now = new Date('2026-08-30T01:00:00Z')
    consumeInviteCode(db, { code: 'CODE-G', accountId: 'acc-1', now })
    issue('CODE-H', new Date('2026-08-30T00:00:00Z'), 1 * HOUR)

    const notFound = consumeInviteCode(db, { code: 'NOPE', accountId: 'x', now })
    const consumed = consumeInviteCode(db, { code: 'CODE-G', accountId: 'x', now })
    const expired = consumeInviteCode(db, {
      code: 'CODE-H',
      accountId: 'x',
      now: new Date('2026-08-30T05:00:00Z'),
    })

    // §46：统一返回 NOT_FOUND_OR_FORBIDDEN，不区分存在性。
    // 若三者可区分，攻击者能用穷举判断哪些码曾经有效。
    expect(notFound).toMatchObject({ ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
    expect(consumed).toMatchObject({ ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
    expect(expired).toMatchObject({ ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })

  it('诊断信息区分原因，但只供服务端使用', () => {
    // §26：服务端分别记录用户可见错误码与运维诊断
    issue('CODE-I')
    const now = new Date('2026-08-30T01:00:00Z')
    consumeInviteCode(db, { code: 'CODE-I', accountId: 'acc-1', now })
    const again = consumeInviteCode(db, { code: 'CODE-I', accountId: 'acc-2', now })
    expect(again).toMatchObject({ diagnostic: 'already_consumed' })
  })
})

describe('一次性由数据库保证', () => {
  it('条件更新使并发消费只有一个成功', () => {
    // 实现用一条带 consumed_by IS NULL 条件的 UPDATE 完成「检查+标记」，
    // 而不是先 SELECT 再 UPDATE —— 后者在并发下会让同一个码被两次通过检查。
    issue('CODE-J')
    const now = new Date('2026-08-30T01:00:00Z')
    const results = ['a', 'b', 'c'].map((accountId) =>
      consumeInviteCode(db, { code: 'CODE-J', accountId, now }),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toHaveLength(2)
  })
})
