/**
 * 设备注册。
 *
 * [§7](../../../../docs/03-details/01-identity-and-permission.md#7-身份与设备注册)：
 *
 * > DSH host 在本地生成 Ed25519 签名密钥对和 X25519 密钥协商密钥对，并在注册时把
 * > 公钥、设备名称和公钥指纹与邀请码提交给 relay。
 * >
 * > **设备私钥永远不上传至 relay。** relay 不保存「与客户端相同的秘密」，而是保存
 * > 公钥和指纹；设备**必须**以私钥签名证明自己仍持有与该指纹匹配的密钥。
 *
 * ## 这个模块里没有私钥
 *
 * 整个文件不接受、不生成、不存储任何私钥 —— `registerDevice` 的入参只有公钥。
 * 密钥对由 host 本地生成，见 `generateDeviceKeyPair`（那是给 host 侧和测试用的，
 * 产物不经过本模块）。
 *
 * 这条约束靠注释守不住，所以 `device-registration.host.spec.ts` 里有一条测试直接
 * 断言注册后的数据库中不含任何私钥字节。
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 设备状态。P0 使用这三个值（§34）。 */
export const DEVICE_STATES = ['active', 'restricted', 'revoked'] as const
export type DeviceState = (typeof DEVICE_STATES)[number]

export interface DeviceKeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
  /** SPKI DER 的 base64，即提交给 relay 的形式。 */
  readonly publicKeyBase64: string
  readonly fingerprint: string
}

/**
 * 在 host 本地生成一对 Ed25519 签名密钥。
 *
 * 放在这个包里是为了让指纹算法只有一处实现 —— 注册时算一次、验签时算一次，
 * 两处若各写各的，某天改了其中一处就会让所有既有设备验签失败。
 *
 * **返回值中的 `privateKey` 绝不能传给 `registerDevice`**，类型上也传不进去。
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    publicKey,
    privateKey,
    publicKeyBase64,
    fingerprint: fingerprintOf(publicKeyBase64),
  }
}

/**
 * 公钥指纹：SPKI DER 的 SHA-256，十六进制小写。
 *
 * §7 规定 relay 保存「公钥、SHA-256 指纹」。指纹对**原始 DER 字节**取，不是对
 * base64 文本取 —— 后者会让同一密钥在不同 base64 变体（换行、padding）下得到
 * 不同指纹。
 */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')
}

export interface DeviceRegistration {
  readonly deviceId: string
  readonly accountId: string
  readonly deviceName: string
  /** Ed25519 签名公钥，SPKI DER 的 base64。 */
  readonly signingPublicKey: string
  /** X25519 密钥协商公钥。P0 可缺省，为 P4 的 E2EE 预留（§7）。 */
  readonly agreementPublicKey?: string
  readonly registeredAt: Date
}

export type RegistrationResult =
  | { readonly ok: true; readonly fingerprint: string }
  | { readonly ok: false; readonly error: 'DEVICE_ALREADY_REGISTERED' | 'ACCOUNT_NOT_FOUND' }

/**
 * 注册一台设备。
 *
 * 指纹在**服务端**由公钥算出，而不是采信客户端提交的指纹。客户端提交的指纹只是
 * 一个声明；若采信它，攻击者就能提交「公钥 A + 公钥 B 的指纹」，让后续所有对
 * 指纹的检查都指向一把它并不持有私钥的密钥。
 */
export function registerDevice(
  db: DatabaseSync,
  registration: DeviceRegistration,
): RegistrationResult {
  const account = db
    .prepare('SELECT 1 FROM accounts WHERE account_id = ?')
    .get(registration.accountId)
  if (account === undefined) return { ok: false, error: 'ACCOUNT_NOT_FOUND' }

  const existing = db
    .prepare('SELECT 1 FROM devices WHERE device_id = ?')
    .get(registration.deviceId)
  if (existing !== undefined) return { ok: false, error: 'DEVICE_ALREADY_REGISTERED' }

  const fingerprint = fingerprintOf(registration.signingPublicKey)
  const at = registration.registeredAt.toISOString()

  db.prepare(
    `INSERT INTO devices
       (device_id, account_id, signing_public_key, agreement_public_key,
        key_fingerprint, state, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    registration.deviceId,
    registration.accountId,
    registration.signingPublicKey,
    registration.agreementPublicKey ?? null,
    fingerprint,
    at,
    at,
  )

  return { ok: true, fingerprint }
}

/** 已注册设备的公开信息。**不含任何秘密** —— 设备表里本来就没有。 */
export interface RegisteredDevice {
  readonly deviceId: string
  readonly accountId: string
  readonly signingPublicKey: string
  readonly keyFingerprint: string
  readonly state: DeviceState
}

export function deviceOf(db: DatabaseSync, deviceId: string): RegisteredDevice | undefined {
  const row = db
    .prepare(
      `SELECT device_id, account_id, signing_public_key, key_fingerprint, state
         FROM devices WHERE device_id = ?`,
    )
    .get(deviceId) as Record<string, string> | undefined
  if (row === undefined) return undefined

  return {
    deviceId: row['device_id'] as string,
    accountId: row['account_id'] as string,
    signingPublicKey: row['signing_public_key'] as string,
    keyFingerprint: row['key_fingerprint'] as string,
    state: row['state'] as DeviceState,
  }
}

/**
 * 变更设备状态。
 *
 * 不允许从 `revoked` 变回其他状态：§7 规定撤销后「需重新注册设备」
 * （`DEVICE_REVOKED` 的幂等语义）。若允许复活，一台被判定为失窃的设备就能被
 * 同一条管理路径悄悄放回来。
 */
export function setDeviceState(
  db: DatabaseSync,
  deviceId: string,
  state: DeviceState,
  at: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE devices SET state = ?, last_seen_at = ?
        WHERE device_id = ? AND state != 'revoked'`,
    )
    .run(state, at.toISOString(), deviceId)
  return Number(result.changes) > 0
}
