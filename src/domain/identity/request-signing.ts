/**
 * 请求签名与时间偏移。
 *
 * [§7.1](../../../../docs/03-details/01-identity-and-permission.md#71-请求签名与时间偏移)：
 *
 * > 每个认证请求都携带 access token，以及设备签名私钥对**请求方法、路径、请求体
 * > 摘要、时间戳、nonce、`DeviceId` 和目标组织**签名生成的证明。
 * >
 * > relay 拒绝过期时间戳、重复 nonce、未注册或被限制设备、错误的 relay 指纹、
 * > 以及与凭证账号不一致的声明发送者。
 * >
 * > 设备签名时间戳采用可配置容忍窗口，**默认正负 5 分钟**。relay 检测到超窗但
 * > 签名、nonce 和设备指纹其他条件正确时，返回 `TIME_SKEW`、签名的服务器时间和
 * > 允许窗口，**不把它混同为认证失败**。
 *
 * ## 检查顺序
 *
 * 时间偏移检查放在**签名验证之后**。这不是效率上的取舍，而是 §7.1 的字面要求：
 * `TIME_SKEW` 只在「签名、nonce 和设备指纹其他条件正确时」返回。先查时间的话，
 * 一个签名完全伪造的请求也会得到 `TIME_SKEW` 和一份**服务器签名的时间** ——
 * 那等于给任何人提供了一个免认证的时间预言机。
 *
 * nonce 的记录同样在最后：先记录再验签，攻击者就能用垃圾签名把受害设备的 nonce
 * 空间填满，让其真实请求被判为重放。
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { deviceOf, type RegisteredDevice } from './device-registration.js'

/** §7.1：默认正负 5 分钟。可配置。 */
export const DEFAULT_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/**
 * 待签名的请求要素。**顺序即协议** —— 双方必须以完全一致的方式拼接。
 *
 * 注意签的是请求体的**摘要**而不是请求体本身：正文可能是几百 KB，
 * 逐字节签名会让每个请求多一次全量拷贝，而摘要在抗碰撞下等价。
 */
export interface SignedRequest {
  readonly method: string
  readonly path: string
  readonly bodyDigest: string
  /** 设备声称的签名时间，毫秒 epoch。 */
  readonly timestamp: number
  readonly nonce: string
  readonly deviceId: string
  /** 目标组织。放进签名内，使一个组织的请求证明不能被拿去对另一个组织重放。 */
  readonly organizationId: string
  /** relay TLS 公钥指纹（§7）。放进签名内，使证明与特定 relay 绑定。 */
  readonly relayFingerprint: string
}

/** 计算请求体摘要。空体也有确定的摘要，不是特例。 */
export function bodyDigestOf(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('base64')
}

/**
 * 拼接待签名的字节串。
 *
 * 用换行分隔而不是直接拼接：若直接拼，`path=/a/b` + `nonce=c` 与 `path=/a` +
 * `nonce=/bc` 会得到同一个字符串，两个不同的请求共享一个签名 —— 经典的
 * 分隔符注入。换行是这些字段里都不可能出现的字符。
 *
 * 前缀 `dsh-chat/1` 是域分隔：即便某天设备私钥被用于签别的东西，
 * 那些签名也不会碰巧成为一个合法的请求证明。
 */
export function signingPayload(request: SignedRequest): Buffer {
  const lines = [
    'dsh-chat/1',
    request.method.toUpperCase(),
    request.path,
    request.bodyDigest,
    String(request.timestamp),
    request.nonce,
    request.deviceId,
    request.organizationId,
    request.relayFingerprint,
  ]
  for (const line of lines) {
    if (line.includes('\n')) {
      throw new Error(`签名要素不得含换行：${JSON.stringify(line)}`)
    }
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

export interface VerificationContext {
  /** 服务端当前时间。由调用方传入，便于测试与集中控制时钟来源。 */
  readonly now: Date
  /** 本 relay 的 TLS 公钥指纹。与请求中声明的比对。 */
  readonly relayFingerprint: string
  /** access token 对应的账号。与设备所属账号比对（§7.1 的「声明发送者」检查）。 */
  readonly authenticatedAccountId: string
  readonly skewToleranceMs?: number
}

export type VerificationFailure =
  /** 设备不存在。与「签名错误」返回同一个错误码，不泄露设备是否注册。 */
  | { readonly code: 'UNAUTHENTICATED'; readonly diagnostic: string }
  | { readonly code: 'DEVICE_RESTRICTED'; readonly diagnostic: string }
  | { readonly code: 'DEVICE_REVOKED'; readonly diagnostic: string }
  | { readonly code: 'SERVER_IDENTITY_MISMATCH'; readonly diagnostic: string }
  | {
      readonly code: 'TIME_SKEW'
      readonly diagnostic: string
      /** §7.1：返回签名的服务器时间和允许窗口，供 host 计算临时偏移量。 */
      readonly serverTime: string
      readonly toleranceMs: number
    }

export type VerificationResult =
  | { readonly ok: true; readonly device: RegisteredDevice }
  | { readonly ok: false; readonly failure: VerificationFailure }

/**
 * 验证一个请求证明。
 *
 * 成功时**副作用是记录 nonce** —— 因此本函数必须在调用方的事务内执行，
 * 且同一个请求不能验两次。
 */
export function verifySignedRequest(
  db: DatabaseSync,
  request: SignedRequest,
  signatureBase64: string,
  context: VerificationContext,
): VerificationResult {
  const tolerance = context.skewToleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS

  // ── 1. relay 指纹 ────────────────────────────────────────────────
  // §7：证书或公钥意外变化立即进入 server_identity_mismatch。这个检查在最前面，
  // 因为它意味着「你在跟另一台服务器说话」—— 后续任何检查的结果都不再可信。
  if (!constantTimeEquals(request.relayFingerprint, context.relayFingerprint)) {
    return fail({
      code: 'SERVER_IDENTITY_MISMATCH',
      diagnostic: 'relay 指纹与本机不符',
    })
  }

  // ── 2. 设备存在与状态 ────────────────────────────────────────────
  const device = deviceOf(db, request.deviceId)
  if (device === undefined) {
    return fail({ code: 'UNAUTHENTICATED', diagnostic: `设备未注册：${request.deviceId}` })
  }
  if (device.state === 'revoked') {
    return fail({ code: 'DEVICE_REVOKED', diagnostic: '设备已撤销，需重新注册' })
  }
  if (device.state === 'restricted') {
    return fail({ code: 'DEVICE_RESTRICTED', diagnostic: '设备受限，需完成风险处置' })
  }

  // ── 3. 声明的发送者与凭证账号一致 ────────────────────────────────
  // §7.1：拒绝「与凭证账号不一致的声明发送者」。access token 说你是 A，
  // 设备属于 B —— 说明 token 与设备来自不同的人。
  if (device.accountId !== context.authenticatedAccountId) {
    return fail({
      code: 'UNAUTHENTICATED',
      diagnostic: '设备所属账号与凭证账号不一致',
    })
  }

  // ── 4. 签名 ──────────────────────────────────────────────────────
  // 在时间与 nonce 之前。否则伪造签名也能换到一份服务器签名的时间。
  if (!verifySignature(device.signingPublicKey, request, signatureBase64)) {
    return fail({ code: 'UNAUTHENTICATED', diagnostic: '签名验证失败' })
  }

  // ── 5. 时间偏移 ──────────────────────────────────────────────────
  // 到这里签名已确认有效，才可以返回 TIME_SKEW 与服务器时间
  const drift = Math.abs(context.now.getTime() - request.timestamp)
  if (drift > tolerance) {
    return fail({
      code: 'TIME_SKEW',
      diagnostic: `时间偏移 ${drift}ms 超出容忍窗口 ${tolerance}ms`,
      serverTime: context.now.toISOString(),
      toleranceMs: tolerance,
    })
  }

  // ── 6. nonce 去重 ────────────────────────────────────────────────
  // 最后一步。先记录再验签的话，攻击者能用垃圾签名填满受害设备的 nonce 空间。
  //
  // 用带 OR IGNORE 的插入而不是「先查后插」：后者在并发下两个请求都查到「不存在」
  // 然后都插入成功，重放检测形同虚设。
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO request_nonces (device_id, nonce, seen_at)
       VALUES (?, ?, ?)`,
    )
    .run(request.deviceId, request.nonce, context.now.toISOString())
  if (Number(inserted.changes) === 0) {
    return fail({ code: 'UNAUTHENTICATED', diagnostic: 'nonce 已使用过，疑似重放' })
  }

  return { ok: true, device }
}

function fail(failure: VerificationFailure): VerificationResult {
  return { ok: false, failure }
}

function verifySignature(
  publicKeyBase64: string,
  request: SignedRequest,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    // Ed25519 的算法参数固定在密钥里，摘要算法传 null
    return verify(null, signingPayload(request), key, Buffer.from(signatureBase64, 'base64'))
  } catch {
    // 公钥或签名不是合法编码。当作验证失败处理，而不是抛给调用方 ——
    // 畸形输入是攻击面的常态，不是程序错误。
    return false
  }
}

/** 定长比较。指纹本身不是秘密，但比较模式会泄露前缀匹配长度。 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 清理容忍窗口之外的 nonce。
 *
 * 窗口外的 nonce 无法再被使用 —— 携带它的请求会先因时间戳超窗而被拒。所以留着
 * 只是让表无限增长：一台设备一年就是几千万行。
 *
 * 保留 2 倍窗口作为余量，避免恰好在边界上把仍可能有效的记录删掉。
 */
export function pruneExpiredNonces(
  db: DatabaseSync,
  now: Date,
  toleranceMs: number = DEFAULT_SKEW_TOLERANCE_MS,
): number {
  const cutoff = new Date(now.getTime() - toleranceMs * 2).toISOString()
  const result = db.prepare('DELETE FROM request_nonces WHERE seen_at < ?').run(cutoff)
  return Number(result.changes)
}
