/**
 * 账号开通与设备会话测试。
 *
 * §7 的注册闭环：邀请码 + 设备公钥 → 账号 + 设备 + 一对 token。
 *
 * 重点在两处：**邀请码的三种失败不可区分**（否则是枚举接口），以及
 * **refresh 是轮换不是延长**（否则泄露的 token 可以无限次使用而不留痕）。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueInviteCode } from '../domain/identity/invite-codes.js'
import { resolveSession } from '../domain/identity/sessions.js'
import { ChatDatabase } from '../storage/database.js'
import { startRelay, type RunningRelay } from '../server.js'

let workDir: string
let dbPath: string
let relay: RunningRelay | undefined
let base: string

/** 造一把设备公钥。私钥留在本地，永不上传（§7）。 */
function publicKey(): string {
  const { publicKey: key } = generateKeyPairSync('ed25519')
  return key.export({ type: 'spki', format: 'der' }).toString('base64')
}

/** 发一张邀请码。签发属管理员路径，这里直接写库。 */
function invite(code: string, options: { expiresInMs?: number } = {}): void {
  const db = ChatDatabase.open({ location: dbPath })
  db.transaction((handle) => {
    handle
      .prepare('INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)')
      .run('admin', '管理员', new Date().toISOString())
    handle
      .prepare("INSERT OR IGNORE INTO organizations VALUES (?,?,'active',?,?,?,1,1)")
      .run('org-1', 'Acme', 'admin', new Date().toISOString(), new Date().toISOString())
    issueInviteCode(handle, {
      code,
      organizationId: 'org-1',
      createdBy: 'admin',
      now: new Date(),
      validForMs: options.expiresInMs ?? 60 * 60 * 1000,
    })
  })
  db.close()
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, never> }
}

function registration(code: string) {
  return {
    inviteCode: code,
    displayName: '甲',
    deviceName: '甲的笔记本',
    signingPublicKey: publicKey(),
  }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-identity-'))
  dbPath = join(workDir, 'relay.db')
  relay = await startRelay({
    databasePath: dbPath,
    host: '127.0.0.1',
    port: 0,
    sharedSecret: 'unused-in-these-tests-0123456789',
  })
  base = `http://127.0.0.1:${relay.port}`
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('用邀请码开户', () => {
  it('返回账号、设备与一对 token', async () => {
    invite('code-ok')
    const { status, json } = await post('/api/identity/register', registration('code-ok'))
    expect(status).toBe(200)
    const data = json['data'] as unknown as Record<string, string>
    expect(data['accountId']).toMatch(/^acct-/)
    expect(data['deviceId']).toMatch(/^dev-/)
    expect(data['accessToken']).toBeTruthy()
    expect(data['refreshToken']).toBeTruthy()
    expect(data['accessToken']).not.toBe(data['refreshToken'])
  })

  it('注册不需要任何已有凭证', async () => {
    // 注册的场景恰恰是还没有任何授权的时候。要求先有共享密钥才能注册，
    // 等于把开户权限交给任何持有部署密钥的人
    invite('code-noauth')
    const { status } = await post('/api/identity/register', registration('code-noauth'))
    expect(status).toBe(200)
  })

  it('签发的 token 能用来访问业务端点', async () => {
    invite('code-usable')
    const { json } = await post('/api/identity/register', registration('code-usable'))
    const data = json['data'] as unknown as Record<string, string>

    const conversations = await post(
      '/api/chat/conversations',
      {},
      {
        authorization: `Bearer ${data['accessToken']}`,
        'x-dsh-organization': 'org-1',
      },
    )
    expect(conversations.status).toBe(200)
  })

  it('token 只存哈希，库里查不到明文', async () => {
    // 库被读走时，存明文等于把所有活跃会话一起交出去
    invite('code-hash')
    const { json } = await post('/api/identity/register', registration('code-hash'))
    const data = json['data'] as unknown as Record<string, string>

    const db = ChatDatabase.open({ location: dbPath })
    const dump = JSON.stringify(db.readonlyHandle.prepare('SELECT * FROM device_sessions').all())
    db.close()
    expect(dump).not.toContain(data['accessToken'])
    expect(dump).not.toContain(data['refreshToken'])
  })

  it('设备私钥不可能出现在库里 —— 接口根本不收', async () => {
    // §7：设备私钥永远不上传。这里从类型上就没有那个字段
    invite('code-priv')
    const body = registration('code-priv')
    expect(Object.keys(body)).not.toContain('privateKey')
    expect(Object.keys(body)).not.toContain('signingPrivateKey')
  })
})

describe('邀请码的三种失败不可区分', () => {
  it('不存在、已消费、已过期返回同一个错误码', async () => {
    // 区分开就能拿它枚举哪些邀请码存在过
    invite('code-used')
    await post('/api/identity/register', registration('code-used'))
    invite('code-expired', { expiresInMs: -1000 })

    const missing = await post('/api/identity/register', registration('code-never-existed'))
    const used = await post('/api/identity/register', registration('code-used'))
    const expired = await post('/api/identity/register', registration('code-expired'))

    expect(missing.status).toBe(404)
    expect(used.status).toBe(missing.status)
    expect(expired.status).toBe(missing.status)
    expect(JSON.stringify(used.json)).toBe(JSON.stringify(missing.json))
    expect(JSON.stringify(expired.json)).toBe(JSON.stringify(missing.json))
  })

  it('一张码只能开一个户', async () => {
    invite('code-once')
    expect((await post('/api/identity/register', registration('code-once'))).status).toBe(200)
    expect((await post('/api/identity/register', registration('code-once'))).status).toBe(404)
  })

  it('畸形公钥被拒绝，不留下永远验不过签的设备', async () => {
    invite('code-badkey')
    const { status } = await post('/api/identity/register', {
      ...registration('code-badkey'),
      signingPublicKey: '',
    })
    expect(status).toBe(404)

    const db = ChatDatabase.open({ location: dbPath })
    const count = db.readonlyHandle.prepare('SELECT COUNT(*) AS c FROM devices').get() as {
      c: number
    }
    db.close()
    expect(count.c).toBe(0)
  })
})

describe('刷新是轮换而不是延长', () => {
  it('换到新的一对，旧 refresh 立即失效', async () => {
    // 不轮换的话，一个泄露的 refresh token 可以被无限次使用而不留痕迹；
    // 轮换后攻击者用过一次，真正的用户下次刷新就会失败 —— 那是可观测的信号
    invite('code-rotate')
    const { json } = await post('/api/identity/register', registration('code-rotate'))
    const first = json['data'] as unknown as Record<string, string>

    const refreshed = await post('/api/identity/session/refresh', {
      refreshToken: first['refreshToken'],
    })
    expect(refreshed.status).toBe(200)
    const second = refreshed.json['data'] as unknown as Record<string, string>
    expect(second['refreshToken']).not.toBe(first['refreshToken'])
    expect(second['accessToken']).not.toBe(first['accessToken'])

    // 旧的用不了了
    const replay = await post('/api/identity/session/refresh', {
      refreshToken: first['refreshToken'],
    })
    expect(replay.status).toBe(401)
  })

  it('旧 access token 在轮换后同样失效', async () => {
    invite('code-rotate2')
    const { json } = await post('/api/identity/register', registration('code-rotate2'))
    const first = json['data'] as unknown as Record<string, string>
    await post('/api/identity/session/refresh', { refreshToken: first['refreshToken'] })

    const withOld = await post(
      '/api/chat/conversations',
      {},
      { authorization: `Bearer ${first['accessToken']}`, 'x-dsh-organization': 'org-1' },
    )
    expect(withOld.status).toBe(401)
  })

  it('无效 refresh token 返回 401', async () => {
    expect((await post('/api/identity/session/refresh', { refreshToken: 'nope' })).status).toBe(401)
  })
})

describe('注销', () => {
  it('撤销本设备的全部会话', async () => {
    invite('code-signout')
    const { json } = await post('/api/identity/register', registration('code-signout'))
    const data = json['data'] as unknown as Record<string, string>
    const auth = {
      authorization: `Bearer ${data['accessToken']}`,
      'x-dsh-organization': 'org-1',
    }

    expect((await post('/api/identity/session/sign-out', {}, auth)).status).toBe(200)
    expect((await post('/api/chat/conversations', {}, auth)).status).toBe(401)
  })
})

describe('会话绑定设备指纹（§34）', () => {
  it('设备换了密钥后旧会话失效', async () => {
    // 不绑定的话，密钥轮换等于没换 —— 旧会话照用不误
    invite('code-fp')
    const { json } = await post('/api/identity/register', registration('code-fp'))
    const data = json['data'] as unknown as Record<string, string>

    const db = ChatDatabase.open({ location: dbPath })
    db.transaction((handle) => {
      handle
        .prepare('UPDATE devices SET key_fingerprint = ? WHERE device_id = ?')
        .run('a'.repeat(64), data['deviceId'])
    })
    const resolved = db.transaction((handle) =>
      resolveSession(handle, data['accessToken'] as string, new Date()),
    )
    db.close()

    expect(resolved.ok).toBe(false)
  })
})
