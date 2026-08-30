/**
 * 第二验证因素（§8）。
 *
 * > 设备私钥签名是主要认证手段，第二验证因素用于保护**设备之外的高风险
 * > 路径**：新设备注册、账号恢复、密码或认证方式变更、安全中心处置、
 * > 组织所有权转让和企业单点登录降级场景。
 *
 * P0 支持 `totp` 与一次性备用码，并按 §50.2 关闭的那条决策**对组织所有者
 * 强制**。
 *
 * ## 几条不能改回去的
 *
 * **备用码只展示一次，库里只存哈希**（§8）。存明文等于把「第二因素」降级成
 * 「第一.五因素」—— 库被读走时它和密码一起丢。
 *
 * **备用码不能替代设备签名。** 它只在第二因素不可用时完成**一次验证**。
 * 允许它顶替设备签名的话，一张打印出来的纸就等于一台被授权的设备。
 *
 * **错误信息不区分「因素不存在」与「因素错误」**（§8）。区分开就能拿它
 * 枚举哪些账号启用了第二因素 —— 而那正好是攻击者挑目标的依据。
 *
 * **TOTP 已消费的时间步要记下来并拒绝重放**（§8）。不记的话，一个被肩窥到
 * 或从截图里读到的验证码在容忍窗口内（默认 90 秒）可以被反复使用。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { fromBase32, otpauthUri, stepAt, toBase32, verifyTotp } from './totp.js'

/** P0 支持的两种。`webauthn` 属 P4（§50.2 已关闭的决策）。 */
export const FACTOR_KINDS = ['totp', 'recovery_code'] as const
export type FactorKind = (typeof FACTOR_KINDS)[number]

/** 一次性备用码的张数与长度。 */
export const RECOVERY_CODE_COUNT = 10
/** 10 字节 → 16 个 Base32 字符。够抗穷举，又短到能抄在纸上。 */
const RECOVERY_CODE_BYTES = 10
/** 剩余低于这个数就提示重新生成（§8）。 */
export const RECOVERY_CODE_LOW_WATERMARK = 3

export type FactorFailure =
  /**
   * 验证没过。**「没启用第二因素」与「码不对」共用这一个** —— §8 要求
   * 不区分，区分开就是一个「哪些账号开了 2FA」的枚举接口。
   */
  | 'UNAUTHENTICATED'
  /** 这个码之前用过。与「码不对」分开，因为它对**用户**是不同的下一步。 */
  | 'REPLAYED'

export type FactorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: FactorFailure; readonly diagnostic: string }

/** 哈希备用码。定长不可逆，库被读走也用不了。 */
function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code), 'utf8').digest('hex')
}

/**
 * 归一化用户输入的备用码。
 *
 * 去空格与短横、转大写。展示时会按四位分组（`ABCD-EFGH-...`），用户抄回来
 * 时带不带短横都该认 —— 为此报「码不对」是纯粹的刁难，而用户此刻正处在
 * 「第二因素用不了」的窘境里。
 */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '')
}

/** 展示用的分组形式。只在签发那一次出现。 */
export function formatCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join('-')
}

export interface EnrolledTotp {
  readonly factorId: string
  /** 给认证器扫的密钥。**只在登记时返回一次。** */
  readonly secretBase32: string
  readonly otpauthUri: string
}

/**
 * 登记一个 TOTP 因素。**必须在调用方的事务内执行。**
 *
 * 状态为 `pending`：用户还没证明自己扫进去了。直接置 `active` 的话，一次
 * 扫码失败就会把账号锁在一个「要求第二因素、而用户没有第二因素」的死局里。
 * 由 `activateTotp` 在第一次验证成功时转 `active`。
 */
export function enrollTotp(
  db: DatabaseSync,
  input: { accountId: string; issuer: string; accountLabel: string; now: Date },
): EnrolledTotp {
  const secret = randomBytes(20)
  const secretBase32 = toBase32(secret)
  const factorId = randomUUID()

  db.prepare(
    `INSERT INTO second_factors (factor_id, account_id, kind, state, secret, created_at)
     VALUES (?, ?, 'totp', 'pending', ?, ?)`,
  ).run(factorId, input.accountId, secretBase32, input.now.toISOString())

  return {
    factorId,
    secretBase32,
    otpauthUri: otpauthUri({
      secretBase32,
      issuer: input.issuer,
      accountLabel: input.accountLabel,
    }),
  }
}

interface FactorRow {
  factor_id: string
  kind: string
  state: string
  secret: string | null
}

function activeOrPendingTotp(db: DatabaseSync, accountId: string): FactorRow | undefined {
  return db
    .prepare(
      `SELECT factor_id, kind, state, secret FROM second_factors
        WHERE account_id = ? AND kind = 'totp' AND state IN ('pending', 'active')
        ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(accountId) as FactorRow | undefined
}

/**
 * 校验一个 TOTP 码。
 *
 * 顺序：查因素 → 验码 → **查重放** → 记录已消费的步。
 *
 * 重放检查放在验码之后：先查的话，一个随便乱猜的码也会去写一行 nonce，
 * 攻击者能借此把受害者的重放表撑大。
 */
export function verifyTotpFactor(
  db: DatabaseSync,
  input: { accountId: string; code: string; now: Date },
): FactorResult<{ factorId: string; step: number }> {
  const row = activeOrPendingTotp(db, input.accountId)
  // 没启用与码不对返回同一个码 —— §8 要求不区分
  if (row === undefined || row.secret === null) {
    return fail('UNAUTHENTICATED', '未登记 TOTP 因素')
  }

  let secret: Uint8Array
  try {
    secret = fromBase32(row.secret)
  } catch {
    return fail('UNAUTHENTICATED', '库中的密钥不是合法 Base32')
  }

  const verdict = verifyTotp(secret, input.code, input.now)
  if (!verdict.ok || verdict.step === undefined) return fail('UNAUTHENTICATED', '验证码不匹配')

  const used = db
    .prepare('SELECT 1 AS hit FROM totp_used_steps WHERE account_id = ? AND step = ?')
    .get(input.accountId, verdict.step)
  if (used !== undefined) {
    // 与「码不对」分开：用户看到的下一步不同 —— 一个是「换一个码」，
    // 另一个是「等 30 秒再试」
    return fail('REPLAYED', '该时间步已被消费')
  }

  db.prepare(
    'INSERT INTO totp_used_steps (account_id, step, used_at) VALUES (?, ?, ?)',
  ).run(input.accountId, verdict.step, input.now.toISOString())

  return { ok: true, value: { factorId: row.factor_id, step: verdict.step } }
}

/**
 * 清掉早已越过容忍窗口的已消费步。
 *
 * 不清的话这张表会无限增长。**必须只清窗口之外的** —— 清掉窗口内的等于把
 * 重放保护关掉一段时间，而那正是保护要覆盖的那段时间。
 */
export function pruneUsedSteps(db: DatabaseSync, now: Date, keepSteps = 10): number {
  const oldest = stepAt(now) - keepSteps
  const result = db.prepare('DELETE FROM totp_used_steps WHERE step < ?').run(oldest)
  return Number(result.changes)
}

/**
 * 把 `pending` 的 TOTP 转 `active`。
 *
 * 只在一次成功验证之后调用 —— 那证明用户确实把密钥扫进了认证器。
 */
export function activateTotp(db: DatabaseSync, factorId: string, now: Date): boolean {
  const result = db
    .prepare(
      "UPDATE second_factors SET state = 'active', activated_at = ? WHERE factor_id = ? AND state = 'pending'",
    )
    .run(now.toISOString(), factorId)
  return Number(result.changes) > 0
}

export interface IssuedRecoveryCodes {
  /** **明文，只在这一次返回。** 库里只有哈希。 */
  readonly codes: readonly string[]
}

/**
 * 签发一组一次性备用码。
 *
 * §8：「启用第二因素时**必须**一次性签发一组一次性备用码，只展示一次并只
 * 保存哈希。」
 *
 * 重新签发会作废旧的全部。留着旧的话，用户以为自己换了一套，而实际上旧的
 * 那张纸仍然能用 —— 「我把备用码弄丢了所以重新生成」这个动作就白做了。
 */
export function issueRecoveryCodes(
  db: DatabaseSync,
  input: { accountId: string; now: Date; count?: number },
): IssuedRecoveryCodes {
  db.prepare(
    "UPDATE recovery_codes SET revoked_at = ? WHERE account_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
  ).run(input.now.toISOString(), input.accountId)

  const codes: string[] = []
  const insert = db.prepare(
    'INSERT INTO recovery_codes (account_id, code_hash, created_at) VALUES (?, ?, ?)',
  )
  for (let i = 0; i < (input.count ?? RECOVERY_CODE_COUNT); i += 1) {
    const code = toBase32(randomBytes(RECOVERY_CODE_BYTES))
    codes.push(formatCode(code))
    insert.run(input.accountId, hashCode(code), input.now.toISOString())
  }
  return { codes }
}

/**
 * 消费一张备用码。
 *
 * 全表扫这个账号的未消费码并逐个定长比较。按哈希直接查更快，但这里的
 * 数量级是十 —— 而定长比较让「有这张码但已用过」和「没这张码」耗时一致。
 *
 * 消费即失效，**不删行**：审计要能回答「哪张码在什么时候被用掉了」。
 */
export function consumeRecoveryCode(
  db: DatabaseSync,
  input: { accountId: string; code: string; now: Date },
): FactorResult<{ remaining: number; lowWatermark: boolean }> {
  const target = hashCode(input.code)
  const rows = db
    .prepare(
      `SELECT rowid AS id, code_hash FROM recovery_codes
        WHERE account_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .all(input.accountId) as Array<{ id: number; code_hash: string }>

  let matched: number | undefined
  for (const row of rows) {
    if (constantTimeEquals(row.code_hash, target)) matched = row.id
  }
  if (matched === undefined) return fail('UNAUTHENTICATED', '备用码不匹配或已用过')

  db.prepare('UPDATE recovery_codes SET consumed_at = ? WHERE rowid = ?').run(
    input.now.toISOString(),
    matched,
  )

  const remaining = rows.length - 1
  return { ok: true, value: { remaining, lowWatermark: remaining < RECOVERY_CODE_LOW_WATERMARK } }
}

/** 这个账号有没有一个可用的第二因素。 */
export function hasActiveFactor(db: DatabaseSync, accountId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS hit FROM second_factors WHERE account_id = ? AND kind = 'totp' AND state = 'active' LIMIT 1",
    )
    .get(accountId)
  return row !== undefined
}

/**
 * 删除一个因素。
 *
 * §8：「删除最后一个 `active` 因素时，若组织策略要求强制第二因素，则返回
 * `FORBIDDEN` 并提示先登记替代因素。」这里只做数据层，策略判定在调用方 ——
 * 因为「要不要强制」取决于这个账号在**哪个组织**里是什么角色，而这一层
 * 不知道组织。
 *
 * 保留行并置 `revoked`，理由同备用码：审计要能回答「谁在什么时候关掉了
 * 第二因素」，而那恰恰是最值得追查的一类动作。
 */
export function revokeFactor(db: DatabaseSync, factorId: string, now: Date): boolean {
  const result = db
    .prepare(
      "UPDATE second_factors SET state = 'revoked', revoked_at = ? WHERE factor_id = ? AND state <> 'revoked'",
    )
    .run(now.toISOString(), factorId)
  return Number(result.changes) > 0
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function fail(errorCode: FactorFailure, diagnostic: string): FactorResult<never> {
  return { ok: false, errorCode, diagnostic }
}
