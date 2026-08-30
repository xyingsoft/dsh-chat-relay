/**
 * 一次性注册邀请码。
 *
 * 对应[最小可运行骨架](../../../../docs/04-roadmap/02-minimum-skeleton.md)第 1 步：
 * 「管理员创建两个一次性注册邀请码」。
 *
 * 「一次性」的实现要点是**消费即写入使用者与时间，但不删除记录** —— 审计需要
 * 知道谁在什么时候用了哪个码。删掉记录会让 §43 第 14 步「每一步在审计表中都有
 * 对应事件」失去可核对的对象。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { OperationId } from '../../contract/index.js'

/** 邀请码记录。字段与 `invite_codes` 表一一对应。 */
export interface InviteCode {
  readonly code: string
  readonly organizationId: string
  readonly createdBy: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly consumedBy: string | null
  readonly consumedAt: string | null
}

export interface IssueInviteInput {
  readonly code: string
  readonly organizationId: string
  readonly createdBy: string
  readonly now: Date
  /** 有效期。属版本化组织配置，调用方从配置读取，不在此处硬编码（§48）。 */
  readonly validForMs: number
}

/** 消费邀请码的结果。失败一律带错误码，由调用方映射为 HTTP 响应。 */
export type ConsumeResult =
  | { readonly ok: true; readonly organizationId: string }
  | {
      readonly ok: false
      /**
       * 三种失败都返回 `NOT_FOUND_OR_FORBIDDEN` —— §46 要求统一返回，
       * 不区分存在性。若分别返回「不存在」「已使用」「已过期」，攻击者可以
       * 用穷举来判断哪些码曾经有效。
       */
      readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN'
      /** 仅用于服务端诊断，**不得**出现在返回给用户的响应中（§26）。 */
      readonly diagnostic: 'not_found' | 'already_consumed' | 'expired'
    }

/** 在给定事务句柄上签发邀请码。 */
export function issueInviteCode(db: DatabaseSync, input: IssueInviteInput): InviteCode {
  const createdAt = input.now.toISOString()
  const expiresAt = new Date(input.now.getTime() + input.validForMs).toISOString()

  db.prepare(
    `INSERT INTO invite_codes (code, organization_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.code, input.organizationId, input.createdBy, createdAt, expiresAt)

  return {
    code: input.code,
    organizationId: input.organizationId,
    createdBy: input.createdBy,
    createdAt,
    expiresAt,
    consumedBy: null,
    consumedAt: null,
  }
}

/**
 * 消费邀请码。
 *
 * 用一条带条件的 `UPDATE` 完成「检查 + 标记」，而不是先 `SELECT` 再 `UPDATE`：
 * 后者在并发下会让同一个码被两个请求同时通过检查。条件里的
 * `consumed_by IS NULL` 使数据库来保证一次性。
 */
export function consumeInviteCode(
  db: DatabaseSync,
  input: { readonly code: string; readonly accountId: string; readonly now: Date },
): ConsumeResult {
  const nowIso = input.now.toISOString()

  const updated = db
    .prepare(
      `UPDATE invite_codes
          SET consumed_by = ?, consumed_at = ?
        WHERE code = ?
          AND consumed_by IS NULL
          AND expires_at > ?`,
    )
    .run(input.accountId, nowIso, input.code, nowIso)

  if (updated.changes === 1) {
    const row = db
      .prepare('SELECT organization_id FROM invite_codes WHERE code = ?')
      .get(input.code) as { organization_id: string }
    return { ok: true, organizationId: row.organization_id }
  }

  // 更新影响 0 行，再查一次以区分**服务端诊断**用的具体原因。
  // 注意返回给调用方的 errorCode 三者相同，诊断信息只进日志。
  const existing = db
    .prepare('SELECT consumed_by, expires_at FROM invite_codes WHERE code = ?')
    .get(input.code) as { consumed_by: string | null; expires_at: string } | undefined

  if (!existing) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN', diagnostic: 'not_found' }
  }
  if (existing.consumed_by !== null) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN', diagnostic: 'already_consumed' }
  }
  return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN', diagnostic: 'expired' }
}

/** 按码查询。仅供管理界面与审计核对，不用于消费路径。 */
export function findInviteCode(db: DatabaseSync, code: string): InviteCode | undefined {
  const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as
    | {
        code: string
        organization_id: string
        created_by: string
        created_at: string
        expires_at: string
        consumed_by: string | null
        consumed_at: string | null
      }
    | undefined
  if (!row) return undefined
  return {
    code: row.code,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at,
  }
}

/** 生成邀请码。用 crypto 随机源，避免可预测的码被穷举。 */
export function generateInviteCode(randomBytes: (size: number) => Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I/O/0/1
  const bytes = randomBytes(20)
  let out = ''
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length]
  }
  return out
}

/** 幂等键在签发路径上的用途：同一 `OperationId` 重试不应产生第二个码。 */
export function inviteOperationKey(operationId: OperationId): string {
  return `invite:${operationId}`
}
