/**
 * relay 服务器测试。
 *
 * 领域逻辑的测试随代码一起搬过来了，这里只测**relay 作为一个进程**新增的那部分：
 * 认证、路由、以及「没配密钥就谁都进不来」。
 *
 * 起的是真实的 `node:http` 服务与真实的 SQLite 文件。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from './storage/database.js'

import { startRelay, type RunningRelay } from './server.js'

const SECRET = 'test-shared-secret-0123456789'
let workDir: string
let relay: RunningRelay | undefined

async function start(options: { secret?: string } = {}): Promise<string> {
  relay = await startRelay({
    databasePath: join(workDir, 'relay.db'),
    host: '127.0.0.1',
    port: 0,
    ...(options.secret === undefined ? {} : { sharedSecret: options.secret }),
  })
  return `http://127.0.0.1:${relay.port}`
}

function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${SECRET}`,
    'x-dsh-account': 'jia',
    'x-dsh-organization': 'org-1',
    'x-dsh-device': 'jia-device',
    ...overrides,
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('健康检查', () => {
  it('不需要认证 —— 探针拿不到共享密钥', async () => {
    const base = await start({ secret: SECRET })
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', service: 'dsh-chat-relay' })
  })

  it('只暴露「进程活着」，不带任何部署信息', async () => {
    // 健康检查是未认证端点，泄露版本、库路径、组织数量都是白送的情报
    const base = await start({ secret: SECRET })
    const body = await (await fetch(`${base}/health`)).text()
    for (const leak of ['databasePath', 'version', 'secret', workDir]) {
      expect(body).not.toContain(leak)
    }
  })
})

describe('共享密钥', () => {
  it('没配密钥时全部业务端点拒绝', async () => {
    // 一个没配密钥的 relay 应当谁都连不上，而不是谁都能连
    const base = await start({})
    const response = await fetch(`${base}/api/chat/conversations`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('密钥不对时拒绝', async () => {
    const base = await start({ secret: SECRET })
    const response = await fetch(`${base}/api/chat/conversations`, {
      method: 'POST',
      headers: authHeaders({ authorization: 'Bearer wrong-secret-0123456789012' }),
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('缺 Bearer 前缀时拒绝', async () => {
    const base = await start({ secret: SECRET })
    const response = await fetch(`${base}/api/chat/conversations`, {
      method: 'POST',
      headers: authHeaders({ authorization: SECRET }),
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('缺账号或组织声明时拒绝', async () => {
    const base = await start({ secret: SECRET })
    for (const missing of ['x-dsh-account', 'x-dsh-organization']) {
      const headers = authHeaders()
      delete headers[missing]
      const response = await fetch(`${base}/api/chat/conversations`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      expect(response.status, `缺 ${missing} 未被拒绝`).toBe(401)
    }
  })

  it('密钥正确时放行', async () => {
    const base = await start({ secret: SECRET })
    const response = await fetch(`${base}/api/chat/conversations`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { conversations: [] } })
  })
})

describe('路由', () => {
  it('未知路径与无权限返回同一形状，不泄露哪些路径存在', async () => {
    // §46：用户错误码不得泄露其他组织、成员、文件或群的存在性；
    // 路径本身同理
    const base = await start({ secret: SECRET })
    const unknown = await fetch(`${base}/api/chat/does-not-exist`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: { code: 'NOT_FOUND_OR_FORBIDDEN' } })
  })

  it('业务端点确实挂上了', async () => {
    // 与插件仓库同一条教训：处理器写好了不等于挂上去了
    const base = await start({ secret: SECRET })
    const paths = [
      '/api/chat/messages',
      '/api/chat/messages/pull',
      '/api/chat/messages/ack',
      '/api/chat/messages/edit',
      '/api/chat/messages/revoke',
      '/api/chat/messages/history',
      '/api/chat/conversations',
      '/api/chat/work-items',
      '/api/chat/work-items/assign',
      '/api/chat/work-items/dependencies',
      '/api/chat/notifications',
      '/api/organization',
      '/api/organization/workspaces',
      '/api/organization/projects',
      '/api/organization/members/invite',
      '/api/organization/members/accept',
      '/api/organization/members/me',
    ]
    for (const path of paths) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: '{}',
      })
      const body = (await response.json()) as { error?: { code?: string } }
      // 未注册的路径由兜底返回 NOT_FOUND_OR_FORBIDDEN 且**没有 data 字段**；
      // 已注册的要么成功、要么返回带 retryability 的错误信封
      const isFallback =
        response.status === 404 && JSON.stringify(body) === '{"error":{"code":"NOT_FOUND_OR_FORBIDDEN"}}'
      expect(isFallback, `${path} 未注册`).toBe(false)
    }
  })
})

/**
 * 预置账号。
 *
 * relay **还没有账号开通端点** —— §7 规定注册走邀请码，`invite-codes.ts` 已经
 * 实现了消费逻辑，但没有对应的 HTTP 入口。在有之前，这里直接写库。
 *
 * 不顺手加一个「凭共享密钥就能建账号」的端点：共享密钥证明的是「这是一台被
 * 授权接入的 host」，不是「这个人有权开户」，两件事混在一起就等于谁拿到密钥
 * 谁就能造账号。缺口登记在 README。
 */
function seedAccount(dbPath: string, accountId: string): void {
  const db = ChatDatabase.open({ location: dbPath })
  db.transaction((handle) => {
    handle
      .prepare('INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)')
      .run(accountId, accountId, new Date().toISOString())
  })
  db.close()
}

describe('数据落在 relay 自己的库里', () => {
  it('写入后重启进程仍在', async () => {
    const dbPath = join(workDir, 'relay.db')
    seedAccount(dbPath, 'jia')
    relay = await startRelay({ databasePath: dbPath, host: '127.0.0.1', port: 0, sharedSecret: SECRET })
    const base = `http://127.0.0.1:${relay.port}`

    const created = await fetch(`${base}/api/organization`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Acme', operationId: 'op-1' }),
    })
    expect(created.status).toBe(200)
    const createdBody = (await created.json()) as {
      data: { organization: { organizationId: string } }
    }
    const newOrg = createdBody.data.organization.organizationId

    await relay.close()
    relay = await startRelay({ databasePath: dbPath, host: '127.0.0.1', port: 0, sharedSecret: SECRET })
    const reopened = `http://127.0.0.1:${relay.port}`

    // 查成员关系时要报**新组织**的 ID。仍用请求头里那个 org-1 会得到 0 条 ——
    // 那是对的：members/me 按 principal 的组织过滤，不跨组织返回
    const rows = await fetch(`${reopened}/api/organization/members/me`, {
      method: 'POST',
      headers: authHeaders({ 'x-dsh-organization': newOrg }),
      body: '{}',
    })
    const body = (await rows.json()) as { data?: { memberships?: unknown[] } }
    expect(body.data?.memberships?.length).toBeGreaterThan(0)

    // 反过来也确认一次：换回原来的组织就查不到，说明隔离是真的
    const otherOrg = await fetch(`${reopened}/api/organization/members/me`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    })
    const otherBody = (await otherOrg.json()) as { data?: { memberships?: unknown[] } }
    expect(otherBody.data?.memberships).toHaveLength(0)
  })
})
