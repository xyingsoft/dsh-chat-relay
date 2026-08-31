/**
 * 设备会话与 token。
 *
 * [§7](../../../README.md)：relay「为该设备签发短期 access token 和可轮换的
 * refresh token」。
 *
 * §34：「设备会话绑定 `AccountId + DeviceId + keyFingerprint + tokenId`，
 * 有短访问期、可轮换刷新期和 token 撤销列表。」
 *
 * ## token 只存哈希
 *
 * 库被读走时，存明文 token 等于把所有活跃会话一起交出去。这与 §9 对密码的
 * 要求（relay 只保存验证值）是同一个道理 —— 区别只是密码由用户记住、
 * token 由客户端存着。
 *
 * ## 这不能替代请求签名
 *
 * token 证明「持有者曾经通过认证」，**不证明这次请求确实来自那台设备** ——
 * token 被复制走就能被别人用。§7.1 的请求签名才是设备身份的证明：每个请求
 * 用设备私钥对方法、路径、正文摘要、时间戳、nonce 签名。
 *
 * 两者是叠加而不是二选一：token 定位是哪个会话，签名证明请求没被冒用。
 * 校验入口 `authenticateRequest` 把两步串起来。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { deviceOf, type RegisteredDevice } from './device-registration.js'

/** §7 的「短期」。取 1 小时 —— 短到被复制走也有限，长到不会一直在刷新。 */
export const ACCESS_TTL_MS = 60 * 60 * 1000
/** 刷新期。取 30 天，与常见的「一个月不用就要重新登录」一致。 */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface IssuedSession {
  readonly tokenId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: string
  readonly refreshExpiresAt: string
}

export interface SessionPrincipal {
  readonly accountId: string
  readonly deviceId: string
  readonly tokenId: string
  readonly keyFingerprint: string
}

export type SessionFailure =
  /** token 不认识、过期或已撤销。**三者返回同一个** —— 区分开就是一个探测接口。 */
  | 'UNAUTHENTICATED'
  | 'DEVICE_RESTRICTED'
  | 'DEVICE_REVOKED'

export type SessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: SessionFailure; readonly diagnostic: string }

/** token 的哈希。定长且不可逆，库被读走也用不了。 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 生成一个 token。
 *
 * 32 字节随机，base64url。不带任何可解析的结构 —— 自描述的 token（JWT 之类）
 * 会诱使调用方直接读里面的字段而不去查库，那样撤销就失效了：一个已撤销的
 * JWT 看起来仍然完全合法。
 */
function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface IssueSessionInput {
  readonly tokenId: string
  readonly accountId: string
  readonly deviceId: string
  readonly keyFingerprint: string
  readonly now: Date
  readonly accessTtlMs?: number
  readonly refreshTtlMs?: number
}

/** 为一台设备签发会话。**必须在调用方的事务内执行。** */
export function issueSession(db: DatabaseSync, input: IssueSessionInput): IssuedSession {
  const accessToken = mintToken()
  const refreshToken = mintToken()
  const accessExpiresAt = new Date(
    input.now.getTime() + (input.accessTtlMs ?? ACCESS_TTL_MS),
  ).toISOString()
  const refreshExpiresAt = new Date(
    input.now.getTime() + (input.refreshTtlMs ?? REFRESH_TTL_MS),
  ).toISOString()

  db.prepare(
    `INSERT INTO device_sessions
       (token_id, account_id, device_id, key_fingerprint, access_hash, refresh_hash,
        issued_at, access_expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.tokenId,
    input.accountId,
    input.deviceId,
    input.keyFingerprint,
    hashToken(accessToken),
    hashToken(refreshToken),
    input.now.toISOString(),
    accessExpiresAt,
    refreshExpiresAt,
  )

  return { tokenId: input.tokenId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

interface SessionRow {
  token_id: string
  account_id: string
  device_id: string
  key_fingerprint: string
  access_expires_at: string
  refresh_expires_at: string
  revoked_at: string | null
}

/**
 * 用 access token 定位会话。
 *
 * 校验四件事，任一不过都返回 `UNAUTHENTICATED`：token 存在、未撤销、未过期、
 * 设备指纹仍与注册时一致。最后一条对应 §34 的「会话绑定 keyFingerprint」——
 * 设备换了密钥，旧会话就该失效，否则密钥轮换等于没换。
 */
export function resolveSession(
  db: DatabaseSync,
  accessToken: string,
  now: Date,
): SessionResult<SessionPrincipal & { device: RegisteredDevice }> {
  const row = db
    .prepare('SELECT * FROM device_sessions WHERE access_hash = ?')
    .get(hashToken(accessToken)) as SessionRow | undefined

  // 「没见过这个 token」与「这个 token 已撤销/过期」返回同一个错误码。
  // 区分开就能拿它枚举哪些 token 曾经存在过
  if (row === undefined) return fail('UNAUTHENTICATED', 'token 不存在')
  if (row.revoked_at !== null) return fail('UNAUTHENTICATED', '会话已撤销')
  if (new Date(row.access_expires_at).getTime() <= now.getTime()) {
    return fail('UNAUTHENTICATED', 'access token 已过期')
  }

  const device = deviceOf(db, row.device_id)
  if (device === undefined) return fail('UNAUTHENTICATED', '设备不存在')
  if (device.state === 'revoked') return fail('DEVICE_REVOKED', '设备已撤销，需重新注册')
  if (device.state === 'restricted') return fail('DEVICE_RESTRICTED', '设备受限，需完成风险处置')

  // §34：会话绑定注册时的指纹
  if (device.keyFingerprint !== row.key_fingerprint) {
    return fail('UNAUTHENTICATED', '设备密钥已变更，旧会话失效')
  }

  return {
    ok: true,
    value: {
      accountId: row.account_id,
      deviceId: row.device_id,
      tokenId: row.token_id,
      keyFingerprint: row.key_fingerprint,
      device,
    },
  }
}

/**
 * 用 refresh token 换一对新 token。
 *
 * **轮换而不是延长**：旧的 refresh token 用过即撤销，新的一对全新签发。
 * 不轮换的话，一个泄露的 refresh token 可以被无限次使用而不留痕迹；
 * 轮换后，攻击者用过一次之后真正的用户下次刷新就会失败 —— 那是一个可观测的
 * 信号，而不是无声的持续入侵。
 */
export function refreshSession(
  db: DatabaseSync,
  input: { refreshToken: string; newTokenId: string; now: Date },
): SessionResult<IssuedSession> {
  const row = db
    .prepare('SELECT * FROM device_sessions WHERE refresh_hash = ?')
    .get(hashToken(input.refreshToken)) as SessionRow | undefined

  if (row === undefined) return fail('UNAUTHENTICATED', 'refresh token 不存在')
  if (row.revoked_at !== null) return fail('UNAUTHENTICATED', '会话已撤销')
  if (new Date(row.refresh_expires_at).getTime() <= now(input).getTime()) {
    return fail('UNAUTHENTICATED', 'refresh token 已过期')
  }

  const device = deviceOf(db, row.device_id)
  if (device === undefined) return fail('UNAUTHENTICATED', '设备不存在')
  if (device.state === 'revoked') return fail('DEVICE_REVOKED', '设备已撤销，需重新注册')
  if (device.keyFingerprint !== row.key_fingerprint) {
    return fail('UNAUTHENTICATED', '设备密钥已变更，旧会话失效')
  }

  revokeSession(db, row.token_id, 'rotated', input.now)
  return {
    ok: true,
    value: issueSession(db, {
      tokenId: input.newTokenId,
      accountId: row.account_id,
      deviceId: row.device_id,
      keyFingerprint: row.key_fingerprint,
      now: input.now,
    }),
  }
}

/** 撤销一个会话。保留行 —— 撤销记录本身是审计线索。 */
export function revokeSession(
  db: DatabaseSync,
  tokenId: string,
  reason: string,
  at: Date,
): boolean {
  const result = db
    .prepare(
      'UPDATE device_sessions SET revoked_at = ?, revoked_reason = ? WHERE token_id = ? AND revoked_at IS NULL',
    )
    .run(at.toISOString(), reason, tokenId)
  return Number(result.changes) > 0
}

/**
 * 撤销一台设备的全部会话。
 *
 * §9：「设备撤销立即使该设备 token、refresh token、长连接、上传预约、执行租约
 * 和组织访问缓存失效。」这里负责前两项。
 */
export function revokeDeviceSessions(
  db: DatabaseSync,
  deviceId: string,
  reason: string,
  at: Date,
): number {
  const result = db
    .prepare(
      'UPDATE device_sessions SET revoked_at = ?, revoked_reason = ? WHERE device_id = ? AND revoked_at IS NULL',
    )
    .run(at.toISOString(), reason, deviceId)
  return Number(result.changes)
}

/** 定长比较，供调用方比对 token 时使用，避免按前缀长度泄露。 */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function fail(errorCode: SessionFailure, diagnostic: string): SessionResult<never> {
  return { ok: false, errorCode, diagnostic }
}

function now(input: { now: Date }): Date {
  return input.now
}
