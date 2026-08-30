/**
 * relay 侧在线状态测试。
 *
 * 折叠规则本身在 `domain/identity/presence.host.spec.ts` 测过。这里测的是
 * relay 独有的那两件事：**可见性从库里读**（host 那边是注入的占位），以及
 * **`sharesScope` 真的查成员关系**（host 那边默认 false）。
 *
 * 后一条尤其值得盯：一个「永远返回 false」的实现会让 `shared_scopes` 事实上
 * 等同于 `hidden`，而用户选的是前者 —— 那是一个静默的、只有用户抱怨才会
 * 发现的错误。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PresenceState } from '../contract/index.js'
import { ChatDatabase } from '../storage/database.js'

import { startRelay, type RunningRelay } from '../server.js'

const SECRET = 'presence-test-secret-0123456789'
const ORG = 'org-1'

let workDir: string
let dbPath: string
let relay: RunningRelay | undefined
let base: string

/** 建两个账号、一个组织，以及一个共享的项目作用域（按需）。 */
function seed(options: { sharedProject?: boolean } = {}): void {
  const db = ChatDatabase.open({ location: dbPath })
  db.transaction((handle) => {
    const stamp = new Date().toISOString()
    const account = handle.prepare(
      'INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const id of ['jia', 'yi']) account.run(id, id, stamp)
    handle
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (organization_id, name, state, created_by, created_at, updated_at, version, policy_revision)
         VALUES (?,?,'active',?,?,?,1,1)`,
      )
      .run(ORG, 'Acme', 'jia', stamp, stamp)

    const membership = handle.prepare(
      `INSERT OR IGNORE INTO memberships
         (membership_id, organization_id, account_id, scope_kind, scope_id, role, state,
          created_at, updated_at, version, policy_revision)
       VALUES (?,?,?,?,?,?,?,?,?,1,1)`,
    )
    // 两人都在组织级 —— 这一层**不算**共享作用域，否则 shared_scopes
    // 就等同于 everyone
    for (const id of ['jia', 'yi']) {
      membership.run(
        `mem-org-${id}`,
        ORG,
        id,
        'organization',
        ORG,
        'member',
        'active',
        stamp,
        stamp,
      )
    }
    if (options.sharedProject === true) {
      handle
        .prepare(
          `INSERT OR IGNORE INTO workspaces
             (workspace_id, organization_id, name, state, created_by, created_at, updated_at, version)
           VALUES (?,?,?,'active',?,?,?,1)`,
        )
        .run('ws-1', ORG, '主工作区', 'jia', stamp, stamp)
      handle
        .prepare(
          `INSERT OR IGNORE INTO projects
             (project_id, organization_id, workspace_id, name, state, created_by, created_at, updated_at, version)
           VALUES (?,?,?,?,'active',?,?,?,1)`,
        )
        .run('proj-1', ORG, 'ws-1', '主项目', 'jia', stamp, stamp)
      for (const id of ['jia', 'yi']) {
        membership.run(
          `mem-proj-${id}`,
          ORG,
          id,
          'project',
          'proj-1',
          'developer',
          'active',
          stamp,
          stamp,
        )
      }
    }
  })
  db.close()
}

async function start(): Promise<void> {
  relay = await startRelay({
    databasePath: dbPath,
    host: '127.0.0.1',
    port: 0,
    sharedSecret: SECRET,
    // 这一组测的是在线状态本身，用共享密钥直接声称身份最省事。
    // 签名那一层由 signature-guard.host.spec.ts 覆盖
    allowSharedSecretIdentity: true,
  })
  base = `http://127.0.0.1:${relay.port}`
}

async function post(
  path: string,
  body: unknown,
  as: string,
): Promise<{ status: number; json: Record<string, never> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
      'x-dsh-account': as,
      'x-dsh-organization': ORG,
      'x-dsh-device': `${as}-laptop`,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, never> }
}

async function presenceSeenBy(viewer: string, targets: string[]): Promise<Record<string, PresenceState>> {
  const { json } = await post('/api/chat/presence', { accountIds: targets }, viewer)
  return (json['data'] as unknown as { presence: Record<string, PresenceState> }).presence
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-presence-'))
  dbPath = join(workDir, 'relay.db')
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('跨机器的在线状态', () => {
  beforeEach(async () => {
    seed()
    await start()
  })

  it('乙上报心跳，甲看得到', async () => {
    // 这正是 relay 侧存在的理由 —— 甲那台机器不可能知道乙在不在
    await post('/api/chat/presence/heartbeat', {}, 'yi')
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('online')
  })

  it('没上报过的人是 unknown，不是 offline', async () => {
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('unknown')
  })

  it('久未交互 → idle', async () => {
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString()
    await post('/api/chat/presence/heartbeat', { lastInteractionAt: longAgo }, 'yi')
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('idle')
  })

  it('未来的交互时间被丢弃', async () => {
    // 信它的话，一个时钟设错的客户端会让自己永远显示 online
    const future = new Date(Date.now() + 3_600_000).toISOString()
    await post('/api/chat/presence/heartbeat', { lastInteractionAt: future }, 'yi')

    const db = ChatDatabase.open({ location: dbPath })
    const row = db.readonlyHandle
      .prepare('SELECT last_interaction_at FROM device_presence WHERE account_id = ?')
      .get('yi') as { last_interaction_at: string }
    db.close()
    expect(new Date(row.last_interaction_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000)
  })
})

describe('可见性从库里读', () => {
  beforeEach(async () => {
    seed()
    await start()
    await post('/api/chat/presence/heartbeat', {}, 'yi')
  })

  it('默认 everyone —— 没设过不等于隐身', async () => {
    // 默认隐藏会让在线状态整个看起来是坏的：用户看到所有人都「状态未知」，
    // 第一反应是功能没做完
    expect((await post('/api/chat/presence/visibility', {}, 'yi')).json['data']).toEqual({
      visibility: 'everyone',
    })
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('online')
  })

  it('设成 hidden 之后别人看到 unknown', async () => {
    await post('/api/chat/presence/visibility/set', { visibility: 'hidden' }, 'yi')
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('unknown')
  })

  it('hidden 时自己仍看得到真实状态', async () => {
    // 看不到的话，用户没法确认设置生效了没有，也没法发现自己的 host 掉线了
    await post('/api/chat/presence/visibility/set', { visibility: 'hidden' }, 'yi')
    expect((await presenceSeenBy('yi', ['yi']))['yi']).toBe('online')
  })

  it('不认识的档位被拒绝，不会写进库', async () => {
    const response = await post('/api/chat/presence/visibility/set', { visibility: '隐身术' }, 'yi')
    expect(response.status).toBe(404)
    expect((await post('/api/chat/presence/visibility', {}, 'yi')).json['data']).toEqual({
      visibility: 'everyone',
    })
  })

  it('改的只能是自己的 —— 端点从请求体里根本不收账号', async () => {
    // 允许管理员代改的话，「隐身」就成了一个可以被别人关掉的开关，
    // 那它保护不了任何东西
    await post('/api/chat/presence/visibility/set', { visibility: 'hidden', accountId: 'yi' }, 'jia')
    // 甲改的是甲自己的；乙不受影响
    expect((await post('/api/chat/presence/visibility', {}, 'yi')).json['data']).toEqual({
      visibility: 'everyone',
    })
    expect((await post('/api/chat/presence/visibility', {}, 'jia')).json['data']).toEqual({
      visibility: 'hidden',
    })
  })
})

describe('shared_scopes 真的查成员关系', () => {
  it('共享项目时看得到', async () => {
    seed({ sharedProject: true })
    await start()
    await post('/api/chat/presence/heartbeat', {}, 'yi')
    await post('/api/chat/presence/visibility/set', { visibility: 'shared_scopes' }, 'yi')
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('online')
  })

  it('只同属一个组织不算共享 —— 否则这一档等同于 everyone', async () => {
    seed()
    await start()
    await post('/api/chat/presence/heartbeat', {}, 'yi')
    await post('/api/chat/presence/visibility/set', { visibility: 'shared_scopes' }, 'yi')
    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('unknown')
  })

  it('被移出项目之后就看不到了', async () => {
    // 已移除的成员关系还留在表里（那是审计线索）。拿它当共享依据的话，
    // 一个被踢出项目的人还能继续看到别人的在线状态
    seed({ sharedProject: true })
    await start()
    await post('/api/chat/presence/heartbeat', {}, 'yi')
    await post('/api/chat/presence/visibility/set', { visibility: 'shared_scopes' }, 'yi')

    const db = ChatDatabase.open({ location: dbPath })
    db.transaction((handle) => {
      handle
        .prepare("UPDATE memberships SET state = 'removed' WHERE membership_id = ?")
        .run('mem-proj-jia')
    })
    db.close()

    expect((await presenceSeenBy('jia', ['yi']))['yi']).toBe('unknown')
  })
})

describe('查询接口不是通讯录', () => {
  beforeEach(async () => {
    seed()
    await start()
  })

  it('不给 accountIds 时拒绝，不默认返回全部', async () => {
    expect((await post('/api/chat/presence', {}, 'jia')).status).toBe(404)
  })

  it('一次问几千个人会被截断', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `acct-${i}`)
    const result = await presenceSeenBy('jia', many)
    expect(Object.keys(result).length).toBeLessThanOrEqual(200)
  })
})
