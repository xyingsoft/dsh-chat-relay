/**
 * 引导邀请码测试。
 *
 * 这个机制的全部价值在于**它会自己失效**。测的重点就是那个：库里一有真实
 * 账号，环境变量再怎么设都不起作用。挡不住这一条的话，它就是一个「改一下
 * 环境变量就能给自己发码」的后门。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { consumeInviteCode } from './domain/identity/invite-codes.js'
import { ChatDatabase } from './storage/database.js'

import { BOOTSTRAP_ACCOUNT_ID, bootstrapInvite } from './bootstrap.js'

let workDir: string
let dbPath: string
let chat: ChatDatabase

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-'))
  dbPath = join(workDir, 'relay.db')
  chat = ChatDatabase.open({ location: dbPath })
})

afterEach(() => {
  chat.close()
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('空库引导', () => {
  it('签出一张能用的码', () => {
    const outcome = bootstrapInvite(chat, { code: 'boot-1', now: new Date() })
    expect(outcome.kind).toBe('issued')

    // 真的能消费 —— 光有一行记录不算数
    chat.transaction((db) => {
      db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
        'acct-1',
        '甲',
        new Date().toISOString(),
      )
      const consumed = consumeInviteCode(db, {
        code: 'boot-1',
        accountId: 'acct-1',
        now: new Date(),
      })
      expect(consumed.ok).toBe(true)
    })
  })

  it('签发者如实记为系统账号，不伪装成某个人', () => {
    bootstrapInvite(chat, { code: 'boot-2', now: new Date() })
    const row = chat.readonlyHandle
      .prepare('SELECT created_by FROM invite_codes WHERE code = ?')
      .get('boot-2') as { created_by: string }
    expect(row.created_by).toBe(BOOTSTRAP_ACCOUNT_ID)
  })

  it('重启不会签第二张', () => {
    expect(bootstrapInvite(chat, { code: 'boot-3', now: new Date() }).kind).toBe('issued')
    expect(bootstrapInvite(chat, { code: 'boot-3', now: new Date() }).kind).toBe(
      'skipped-already-issued',
    )
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM invite_codes')
      .get() as { c: number }
    expect(count.c).toBe(1)
  })
})

describe('自失效', () => {
  it('库里有真实账号后就不再签发', () => {
    // 这是整个机制的安全性所在。环境变量比数据库容易改得多，
    // 一个不会失效的引导等于一个环境变量后门
    chat.transaction((db) => {
      db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
        'acct-real',
        '已有用户',
        new Date().toISOString(),
      )
    })
    const outcome = bootstrapInvite(chat, { code: 'boot-late', now: new Date() })
    expect(outcome.kind).toBe('skipped-not-empty')

    const row = chat.readonlyHandle
      .prepare('SELECT code FROM invite_codes WHERE code = ?')
      .get('boot-late')
    expect(row).toBeUndefined()
  })

  it('系统账号自己不算「已有账号」', () => {
    // 否则第一次引导之后就再也进不来了，而那时候还没有任何真实用户 ——
    // 引导码没用掉、又签不出新的，等于把自己锁在门外
    bootstrapInvite(chat, { code: 'boot-a', now: new Date() })
    const second = bootstrapInvite(chat, { code: 'boot-b', now: new Date() })
    expect(second.kind).toBe('issued')
  })

  it('第一个人开完户之后，新码签不出来了', () => {
    bootstrapInvite(chat, { code: 'boot-first', now: new Date() })
    chat.transaction((db) => {
      db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
        'acct-1',
        '甲',
        new Date().toISOString(),
      )
      consumeInviteCode(db, { code: 'boot-first', accountId: 'acct-1', now: new Date() })
    })
    expect(bootstrapInvite(chat, { code: 'boot-second', now: new Date() }).kind).toBe(
      'skipped-not-empty',
    )
  })
})
