/**
 * 账号开通与设备会话的 HTTP 端点。
 *
 * §7 的注册闭环：host 本地生成 Ed25519 密钥对，把**公钥**、设备名称与指纹
 * 连同邀请码提交给 relay；relay 保存公钥与指纹，并为该设备签发短期 access
 * token 与可轮换的 refresh token。
 *
 * ## 为什么这几个端点不要共享密钥
 *
 * 共享密钥证明「这是一台被授权接入的 host」。但注册的场景恰恰是**还没有任何
 * 授权**的时候 —— 要求先有密钥才能注册，等于把开户权限交给了任何持有部署密钥
 * 的人，那正是之前拒绝加「凭共享密钥就能建账号」端点的理由。
 *
 * 这里的准入靠**邀请码**：§7.2「自建组织用户……邀请码」，一次性消费、有有效期。
 * 谁拿到邀请码谁能开一个户，且用完即废。
 *
 * ## 三个失败原因返回同一个错误码
 *
 * 邀请码不存在、已被消费、已过期 —— 用户看到的都是同一句。区分开就能拿它
 * 枚举哪些邀请码存在过。具体原因只进服务端诊断。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { consumeInviteCode } from '../domain/identity/invite-codes.js'
import { registerDevice, fingerprintOf } from '../domain/identity/device-registration.js'
import {
  issueSession,
  refreshSession,
  revokeDeviceSessions,
  type IssuedSession,
} from '../domain/identity/sessions.js'
import type { ChatDatabasePort } from '../storage/database-port.js'

import { commandHandler } from './command-router.js'

export interface IdentityCommandDeps {
  readonly database: ChatDatabasePort
  readonly expectedOrigin: string
  readonly now: () => Date
  readonly newId: (prefix: string) => string
  /**
   * 已认证的调用者。仅注销端点需要 —— 注册与刷新按定义还没有会话。
   */
  readonly authenticate: (request: IncomingMessage) => { accountId: string; deviceId: string } | undefined
}

/** 邀请码被拒。用异常是为了让同事务里已插入的账号一起回滚。 */
class InviteRejected extends Error {
  constructor() {
    super('邀请码不可用')
    this.name = 'InviteRejected'
  }
}

function strings<K extends string>(raw: unknown, keys: readonly K[]): Record<K, string> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const out = {} as Record<K, string>
  for (const key of keys) {
    const value = source[key]
    if (typeof value !== 'string' || value.length === 0) return undefined
    out[key] = value
  }
  return out
}

/**
 * 用邀请码开户并注册第一台设备。
 *
 * 开户与注册设备**在同一事务**：只开户不注册设备的话，用户拿到一个没有任何
 * 设备的账号，既登录不了也没法补救；反过来注册了设备却没开户，设备表的外键
 * 直接失败。两件事没有中间态可言。
 */
export function registerAccountHandler(deps: IdentityCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw) => {
      const body = strings(raw, ['inviteCode', 'displayName', 'deviceName', 'signingPublicKey'])
      if (!body) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }

      // 公钥必须是能解出指纹的合法 SPKI DER。放行畸形公钥的话，
      // 设备表里会留下一个永远验不过签的条目
      let fingerprint: string
      try {
        fingerprint = fingerprintOf(body.signingPublicKey)
        if (Buffer.from(body.signingPublicKey, 'base64').length === 0) throw new Error('空公钥')
      } catch {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      const accountId = deps.newId('acct')
      const deviceId = deps.newId('dev')

      try {
        return deps.database.transaction((db: DatabaseSync) => {
          // 顺序是被外键逼出来的：invite_codes.consumed_by 指向 accounts，
          // 所以账号必须先存在。而「先建号再消费」意味着码无效时账号已经写进去了
          // —— 靠**抛异常回滚**来收拾，不能靠 return，后者会提交
          db.prepare(
            'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
          ).run(accountId, body.displayName, now.toISOString())

          const consumed = consumeInviteCode(db, { code: body.inviteCode, accountId, now })
          if (!consumed.ok) {
            // 三种失败原因（不存在/已消费/已过期）在这里被抹平为一个错误码；
            // 具体原因进服务端日志。抛出去让刚插入的账号一起回滚
            throw new InviteRejected()
          }

          const registered = registerDevice(db, {
            deviceId,
            accountId,
            deviceName: body.deviceName,
            signingPublicKey: body.signingPublicKey,
            registeredAt: now,
          })
          if (!registered.ok) {
            // 同样抛：返回错误的话邀请码已被消费却没开成户，那张码白白作废
            throw new Error(`设备注册失败：${registered.error}`)
          }

          const session = issueSession(db, {
            tokenId: randomUUID(),
            accountId,
            deviceId,
            keyFingerprint: fingerprint,
            now,
          })

          return { ok: true as const, value: { accountId, deviceId, fingerprint, ...session } }
        })
      } catch (error) {
        // 只把「邀请码被拒」翻译成用户可见的错误码。其余异常继续上抛，
        // 由 router 的兜底给 500 —— 把未知故障也说成「邀请码无效」会让人
        // 拿着一张好码反复试
        if (error instanceof InviteRejected) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }
        throw error
      }
    },
  })
}

/**
 * 用 refresh token 换一对新 token。
 *
 * 不需要 access token —— 它按定义已经过期了，那正是要刷新的原因。
 */
export function refreshSessionHandler(deps: IdentityCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw) => {
      const body = strings(raw, ['refreshToken'])
      if (!body) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const result = deps.database.transaction((db: DatabaseSync) =>
        refreshSession(db, {
          refreshToken: body.refreshToken,
          newTokenId: randomUUID(),
          now: deps.now(),
        }),
      ) as ReturnType<typeof refreshSession>

      return result.ok
        ? { ok: true as const, value: result.value satisfies IssuedSession }
        : { ok: false as const, errorCode: result.errorCode }
    },
  })
}

/**
 * 注销当前设备的全部会话。
 *
 * §9：设备撤销立即使该设备 token 与 refresh token 失效。这里只处理「用户主动
 * 退出本机」；管理员撤销他人设备属安全中心，是另一条路径。
 */
export function signOutHandler(deps: IdentityCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const revoked = deps.database.transaction((db: DatabaseSync) =>
        revokeDeviceSessions(db, principal.deviceId, 'signed-out', deps.now()),
      ) as number
      return { ok: true as const, value: { revoked } }
    },
  })
}
