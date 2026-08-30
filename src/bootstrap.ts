/**
 * 首个账号的引导。
 *
 * 一个全新的 relay 里一条账号都没有，而邀请码的 `created_by` 有外键指向
 * `accounts` —— 也就是说**没有账号就签不出邀请码，而开户又要邀请码**。
 * 这是个真实的死锁，不是理论问题：不解决的话，部署完的 relay 谁也用不了。
 *
 * 解法是部署期的一次性引导：设 `DSH_CHAT_RELAY_BOOTSTRAP_INVITE`，启动时
 * 如果库里**一个账号都没有**，就建一个系统账号、一个引导组织，并签发这张码。
 *
 * ## 为什么只在库为空时生效
 *
 * 它是自失效的：第一个人开完户，`accounts` 就不为空了，之后这个环境变量
 * 再怎么设都不起作用。否则它就成了一个「改一下环境变量就能给自己发码」的
 * 后门 —— 而环境变量比数据库容易改得多。
 *
 * 日志里会打出这张码已被签发，但**不打码本身** —— 它就在设它的人手里，
 * 打进日志只是多一个泄露点。
 */

import type { DatabaseSync } from 'node:sqlite'

import { issueInviteCode } from './domain/identity/invite-codes.js'
import type { ChatDatabase } from './storage/database.js'

/** 引导时创建的系统账号。签发者如实记为系统，而不是伪装成某个人。 */
export const BOOTSTRAP_ACCOUNT_ID = 'system-bootstrap'
export const BOOTSTRAP_ORGANIZATION_ID = 'org-bootstrap'
/** 引导码的有效期。7 天 —— 够部署完的人从容用掉，又不会长期挂着。 */
export const BOOTSTRAP_VALID_MS = 7 * 24 * 60 * 60 * 1000

export type BootstrapOutcome =
  | { readonly kind: 'issued'; readonly organizationId: string; readonly expiresAt: string }
  /** 库里已经有账号了。这不是错误，是这个机制按设计失效了。 */
  | { readonly kind: 'skipped-not-empty' }
  /** 同一张码已经签过。重启不该报错，也不该签第二张。 */
  | { readonly kind: 'skipped-already-issued' }

export function bootstrapInvite(
  chat: ChatDatabase,
  input: { code: string; now: Date; validForMs?: number },
): BootstrapOutcome {
  return chat.transaction((db: DatabaseSync) => {
    const accounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }
    // 系统账号自己不算数 —— 否则第一次引导之后就再也进不来了，
    // 而那时候还没有任何真实用户
    const real = db
      .prepare('SELECT COUNT(*) AS c FROM accounts WHERE account_id <> ?')
      .get(BOOTSTRAP_ACCOUNT_ID) as { c: number }
    if (real.c > 0) return { kind: 'skipped-not-empty' as const }

    const existing = db
      .prepare('SELECT code FROM invite_codes WHERE code = ?')
      .get(input.code) as { code: string } | undefined
    if (existing !== undefined) return { kind: 'skipped-already-issued' as const }

    const timestamp = input.now.toISOString()
    if (accounts.c === 0) {
      db.prepare(
        'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
      ).run(BOOTSTRAP_ACCOUNT_ID, '系统引导', timestamp)
    }
    db.prepare(
      `INSERT OR IGNORE INTO organizations
         (organization_id, name, state, created_by, created_at, updated_at, version, policy_revision)
       VALUES (?,?,'active',?,?,?,1,1)`,
    ).run(BOOTSTRAP_ORGANIZATION_ID, '引导组织', BOOTSTRAP_ACCOUNT_ID, timestamp, timestamp)

    const issued = issueInviteCode(db, {
      code: input.code,
      organizationId: BOOTSTRAP_ORGANIZATION_ID,
      createdBy: BOOTSTRAP_ACCOUNT_ID,
      now: input.now,
      validForMs: input.validForMs ?? BOOTSTRAP_VALID_MS,
    })
    return {
      kind: 'issued' as const,
      organizationId: issued.organizationId,
      expiresAt: issued.expiresAt,
    }
  })
}
