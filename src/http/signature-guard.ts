/**
 * 把 §7.1 的请求证明挂进请求路径。
 *
 * `domain/identity/request-signing.ts` 早就实现了校验，但一直没有人调用它 ——
 * 一套写好却不生效的安全代码比没写更糟：它让读代码的人以为请求是被签名保护
 * 的，而实际上一个被复制走的 token 就是完整的身份。
 *
 * ## 谁需要签名
 *
 * **凭会话 token 进来的请求都要签。** 那些调用方按定义是注册过的设备，本机就
 * 有私钥，签得出来。
 *
 * 凭共享密钥进来的签不了 —— 那条路径上根本没有设备私钥，只有一个部署期口令。
 * 它本来就是默认关闭的降级通道，这里不为它编一套弱一点的规则：要么用真身份
 * 并签名，要么用那条明说自己弱的回落。
 *
 * ## 为什么要配 relay 指纹才启用
 *
 * §7.1 的签名覆盖 relay 的 TLS 公钥指纹，用来把证明绑定到特定 relay。但本进程
 * **只听明文 HTTP**（README：生产部署放在反向代理后面），TLS 在代理那一层
 * 终止 —— 进程自己无从知道那张证书的指纹。只能由部署方配进来。
 *
 * 所以没配指纹时不启用签名校验，并在启动时打一行明确说了「没在检查什么」的
 * 警告。这不是悄悄留的口子：它是一个有名字、有日志、写进 README 的前置条件。
 * 编一个假指纹让校验「看起来在跑」才是真的糟糕 —— 那样每个人都以为绑定生效了。
 */

import type { IncomingMessage } from 'node:http'

import { resolveSession } from '../domain/identity/sessions.js'
import {
  bodyDigestOf,
  verifySignedRequest,
  type SignedRequest,
} from '../domain/identity/request-signing.js'
import type { ChatDatabase } from '../storage/database.js'

import { errorBody, httpStatusOf, type CommandGuard } from './command-router.js'

/** 携带证明的三个请求头。签名本身是 base64 的 Ed25519 签名。 */
export const SIGNATURE_HEADER = 'x-dsh-signature'
export const NONCE_HEADER = 'x-dsh-nonce'
export const TIMESTAMP_HEADER = 'x-dsh-timestamp'

export interface SignatureGuardOptions {
  readonly database: ChatDatabase
  /** 本 relay 的 TLS 公钥指纹。**不配则不启用校验。** */
  readonly relayFingerprint?: string
  readonly now: () => Date
  readonly skewToleranceMs?: number
}

/**
 * 造一个守卫。没配指纹时返回 `undefined` —— 调用方据此决定挂不挂。
 *
 * 返回 undefined 而不是一个恒真的守卫：恒真守卫会一直挂在链路上，将来有人读
 * 代码时看到「这里有校验」，得再翻一层才发现它什么都不做。
 */
export function createSignatureGuard(options: SignatureGuardOptions): CommandGuard | undefined {
  const relayFingerprint = options.relayFingerprint
  if (relayFingerprint === undefined || relayFingerprint.length === 0) return undefined

  return (request: IncomingMessage, rawBody: Buffer) => {
    const header = request.headers['authorization']
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined
    if (presented === undefined) return unauthenticated()

    // 先看这是不是一个会话 token。不是的话（共享密钥回落）就不在本守卫的
    // 管辖范围内 —— 认证由 authenticateFrom 决定，这里只管「已经用设备身份
    // 进来的请求有没有签名」
    const session = options.database.transaction((db) =>
      resolveSession(db, presented, options.now()),
    )
    if (!session.ok) return { ok: true as const }

    const signature = single(request.headers[SIGNATURE_HEADER])
    const nonce = single(request.headers[NONCE_HEADER])
    const timestampRaw = single(request.headers[TIMESTAMP_HEADER])
    const organizationId = single(request.headers['x-dsh-organization'])
    // 用了设备身份却不带证明，一律拒。允许「没带就跳过」等于让攻击者
    // 把请求头删掉就绕过整套机制 —— 那是这类降级最常见的形态
    if (
      signature === undefined ||
      nonce === undefined ||
      timestampRaw === undefined ||
      organizationId === undefined
    ) {
      return unauthenticated()
    }
    const timestamp = Number(timestampRaw)
    if (!Number.isFinite(timestamp)) return unauthenticated()

    const signed: SignedRequest = {
      method: request.method ?? 'POST',
      path: (request.url ?? '').split('?')[0] ?? '',
      // Uint8Array 而不是 Buffer：`bodyDigestOf` 的签名收前者，而 Buffer 在
      // 当前 @types/node 下不再自动窄化过去
      bodyDigest: bodyDigestOf(new Uint8Array(rawBody)),
      timestamp,
      nonce,
      deviceId: session.value.deviceId,
      organizationId,
      relayFingerprint,
    }

    const verdict = options.database.transaction((db) =>
      verifySignedRequest(db, signed, signature, {
        now: options.now(),
        relayFingerprint,
        authenticatedAccountId: session.value.accountId,
        ...(options.skewToleranceMs === undefined
          ? {}
          : { skewToleranceMs: options.skewToleranceMs }),
      }),
    )
    if (verdict.ok) return { ok: true as const }

    const failure = verdict.failure
    if (failure.code === 'TIME_SKEW') {
      // §7.1：带上签名的服务器时间和允许窗口，**不混同为认证失败** ——
      // 混同的话，时钟漂了的设备会一直重试认证，而它需要做的是校时
      return {
        ok: false as const,
        status: httpStatusOf('TIME_SKEW'),
        body: {
          error: {
            code: 'TIME_SKEW',
            retryability: 'retryable',
            serverTime: failure.serverTime,
            toleranceMs: failure.toleranceMs,
          },
        },
      }
    }
    return {
      ok: false as const,
      status: httpStatusOf(failure.code),
      body: errorBody(failure.code),
    }
  }
}

function unauthenticated() {
  return {
    ok: false as const,
    status: httpStatusOf('UNAUTHENTICATED'),
    body: errorBody('UNAUTHENTICATED'),
  }
}

function single(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}
