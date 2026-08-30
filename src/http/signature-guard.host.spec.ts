/**
 * 请求证明挂进请求路径之后的测试。
 *
 * `request-signing.host.spec.ts` 测的是校验函数本身。这一份测的是**它真的被
 * 调用了**，以及被调用的位置对不对 —— 那套代码此前写好了却从没接进请求路径，
 * 单测全绿而线上一次都没跑过。
 *
 * 所以这里全程走真实 HTTP：起进程、注册设备、自己签名、打业务端点。
 */

import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bodyDigestOf, signingPayload } from '../domain/identity/request-signing.js'
import { issueInviteCode } from '../domain/identity/invite-codes.js'
import { ChatDatabase } from '../storage/database.js'

import { startRelay, type RunningRelay } from '../server.js'

const FINGERPRINT = 'b'.repeat(64)
const ORG = 'org-1'
const PATH = '/api/chat/conversations'

let workDir: string
let dbPath: string
let relay: RunningRelay | undefined
let base: string
let privateKeyPem: string
let accessToken: string

/** 起一台配了指纹的 relay —— 那是启用签名校验的开关。 */
async function start(options: { fingerprint?: string; skewToleranceMs?: number } = {}) {
  relay = await startRelay({
    databasePath: dbPath,
    host: '127.0.0.1',
    port: 0,
    sharedSecret: 'unused-in-these-tests-0123456789',
    ...(options.fingerprint === undefined ? {} : { tlsFingerprint: options.fingerprint }),
    ...(options.skewToleranceMs === undefined ? {} : { skewToleranceMs: options.skewToleranceMs }),
  })
  base = `http://127.0.0.1:${relay.port}`
}

function seedInvite(code: string): void {
  const db = ChatDatabase.open({ location: dbPath })
  db.transaction((handle) => {
    const stamp = new Date().toISOString()
    handle
      .prepare('INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)')
      .run('admin', '管理员', stamp)
    handle
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (organization_id, name, state, created_by, created_at, updated_at, version, policy_revision)
         VALUES (?,?,'active',?,?,?,1,1)`,
      )
      .run(ORG, 'Acme', 'admin', stamp, stamp)
    issueInviteCode(handle, {
      code,
      organizationId: ORG,
      createdBy: 'admin',
      now: new Date(),
      validForMs: 60 * 60 * 1000,
    })
  })
  db.close()
}

/**
 * 走真实注册端点开户。
 *
 * 私钥留在测试进程里 —— 与真实 host 的做法一致，也顺便证明 relay 不需要它
 * 就能验签。
 */
async function enroll(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  seedInvite('code-sig')
  const response = await fetch(`${base}/api/identity/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inviteCode: 'code-sig',
      displayName: '甲',
      deviceName: '甲的笔记本',
      signingPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }),
  })
  const payload = (await response.json()) as { data: { accessToken: string; deviceId: string } }
  accessToken = payload.data.accessToken
  deviceId = payload.data.deviceId
}

let deviceId: string

interface CallOptions {
  body?: unknown
  /** 覆盖签名里的某个要素，用来制造各种不匹配。 */
  tamper?: {
    bodyDigest?: string
    timestamp?: number
    nonce?: string
    relayFingerprint?: string
    path?: string
  }
  /** 发出去的实际请求体与签名时用的不同 —— 模拟中途被改包。 */
  sentBody?: unknown
  omitSignature?: boolean
  reuseNonce?: string
}

async function call(options: CallOptions = {}): Promise<{ status: number; json: never }> {
  const body = JSON.stringify(options.body ?? {})
  const nonce = options.reuseNonce ?? options.tamper?.nonce ?? randomUUID()
  const timestamp = options.tamper?.timestamp ?? Date.now()

  const signed = {
    method: 'POST',
    path: options.tamper?.path ?? PATH,
    bodyDigest: options.tamper?.bodyDigest ?? bodyDigestOf(body),
    timestamp,
    nonce,
    deviceId,
    organizationId: ORG,
    relayFingerprint: options.tamper?.relayFingerprint ?? FINGERPRINT,
  }
  const signature = sign(null, signingPayload(signed), createPrivateKey(privateKeyPem)).toString(
    'base64',
  )

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'x-dsh-organization': ORG,
  }
  if (options.omitSignature !== true) {
    headers['x-dsh-signature'] = signature
    headers['x-dsh-nonce'] = nonce
    headers['x-dsh-timestamp'] = String(timestamp)
  }

  const response = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.sentBody ?? options.body ?? {}),
  })
  return { status: response.status, json: (await response.json()) as never }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-sig-'))
  dbPath = join(workDir, 'relay.db')
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('配了指纹就启用校验', () => {
  beforeEach(async () => {
    await start({ fingerprint: FINGERPRINT })
    await enroll()
  })

  it('带正确签名的请求通过', async () => {
    expect((await call()).status).toBe(200)
  })

  it('用了设备 token 却不带签名 —— 拒绝', async () => {
    // 允许「没带就跳过」等于让攻击者删掉请求头就绕过整套机制。
    // 那是这类降级最常见的形态
    expect((await call({ omitSignature: true })).status).toBe(401)
  })

  it('请求体被改过 —— 拒绝', async () => {
    // 签名覆盖请求体摘要。不覆盖的话，一个合法签名可以被搬到任意请求体上
    const rejected = await call({ body: { a: 1 }, sentBody: { a: 999 } })
    expect(rejected.status).toBe(401)
  })

  it('同一个 nonce 用第二次 —— 拒绝', async () => {
    const nonce = randomUUID()
    expect((await call({ reuseNonce: nonce })).status).toBe(200)
    expect((await call({ reuseNonce: nonce })).status).toBe(401)
  })

  it('签的是别的 relay 的指纹 —— 拒绝', async () => {
    // §7.1 的「错误的 relay 指纹」。不查的话，对 A 站的请求证明可以被
    // 原样转发给 B 站
    const rejected = await call({ tamper: { relayFingerprint: 'c'.repeat(64) } })
    expect(rejected.status).not.toBe(200)
  })

  it('签的是别的路径 —— 拒绝', async () => {
    // 不覆盖路径的话，一个「读会话」的证明能拿去打「撤销消息」
    expect((await call({ tamper: { path: '/api/chat/messages/revoke' } })).status).toBe(401)
  })
})

describe('时间偏移按 §7.1 单独处理', () => {
  beforeEach(async () => {
    await start({ fingerprint: FINGERPRINT, skewToleranceMs: 60_000 })
    await enroll()
  })

  it('超窗返回 TIME_SKEW，并带出服务器时间与允许窗口', async () => {
    // 混同为认证失败的话，时钟漂了的设备会一直重试认证 ——
    // 而它需要做的是校时
    const skewed = await call({ tamper: { timestamp: Date.now() - 10 * 60 * 1000 } })
    const body = skewed.json as unknown as {
      error: { code: string; serverTime: string; toleranceMs: number }
    }
    expect(body.error.code).toBe('TIME_SKEW')
    expect(Number.isNaN(Date.parse(body.error.serverTime))).toBe(false)
    expect(body.error.toleranceMs).toBe(60_000)
  })

  it('窗口内的偏移仍然通过', async () => {
    expect((await call({ tamper: { timestamp: Date.now() - 30_000 } })).status).toBe(200)
  })

  it('签名伪造时不返回 TIME_SKEW —— 那会是个免认证的时间预言机', async () => {
    // §7.1：TIME_SKEW 只在「签名、nonce 和设备指纹其他条件正确时」返回。
    // 先查时间的话，任何人都能拿一个垃圾签名换一份服务器签名的时间
    const forged = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-dsh-organization': ORG,
        'x-dsh-signature': Buffer.from('伪造的签名').toString('base64'),
        'x-dsh-nonce': randomUUID(),
        'x-dsh-timestamp': String(Date.now() - 10 * 60 * 1000),
      },
      body: '{}',
    })
    const body = (await forged.json()) as { error: { code: string; serverTime?: string } }
    expect(body.error.code).not.toBe('TIME_SKEW')
    expect(body.error.serverTime).toBeUndefined()
  })
})

describe('没配指纹就不启用', () => {
  it('不带签名也能通过 —— 但启动时打了警告', async () => {
    // 这不是悄悄留的口子：它有名字（tlsFingerprint）、有日志、写进 README。
    // 本进程只听明文 HTTP，TLS 在反向代理终止，指纹只能由部署方配进来
    await start({})
    await enroll()
    expect((await call({ omitSignature: true })).status).toBe(200)
  })
})
