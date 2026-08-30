/**
 * 组织仓储测试。
 *
 * 重点在 §11.2 的两条：公共字段齐备、并发变更返回 `VERSION_CONFLICT` 而非静默覆盖。
 * 用真实 schema（经迁移建出）而不是手写建表，避免测试与实际表结构脱节。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from '../../storage/database.js'

import { authorize, type MembershipSnapshot } from './authorization.js'
import {
  acceptMembership,
  createOrganization,
  createProject,
  createWorkspace,
  findOrganization,
  inviteMember,
  membershipsOf,
  scopeChainOfProject,
  updateOrganizationState,
  VersionConflictError,
} from './repository.js'

let chat: ChatDatabase
const now = new Date('2026-08-30T00:00:00Z')

beforeEach(() => {
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('owner', '所有者', now.toISOString())
    insert.run('dev', '开发者', now.toISOString())
  })
})

afterEach(() => chat.close())

function seedProject(): void {
  chat.transaction((db) => {
    createOrganization(db, { organizationId: 'org-1', name: 'o', createdBy: 'owner', now })
    createWorkspace(db, {
      workspaceId: 'ws-1',
      organizationId: 'org-1',
      name: 'w',
      createdBy: 'owner',
      now,
    })
    createProject(db, {
      projectId: 'proj-1',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      name: 'p',
      createdBy: 'owner',
      now,
    })
  })
}

function canSend(accountId: string): boolean {
  const memberships = membershipsOf(chat.readonlyHandle, 'org-1', accountId)
  const snapshots: MembershipSnapshot[] = memberships.map((m) => ({
    scopeKind: m.scopeKind,
    scopeId: m.scopeId,
    role: m.role,
    state: m.state,
  }))
  return authorize({
    organizationState: 'active',
    memberships: snapshots,
    scopeKind: 'project',
    scopeId: 'proj-1',
    ancestors: scopeChainOfProject(chat.readonlyHandle, 'proj-1'),
    capability: 'message.send',
  }).allowed
}

describe('三级层次', () => {
  it('组织、工作区、项目都带 §11.2 的公共字段', () => {
    const created = chat.transaction((db) => ({
      org: createOrganization(db, {
        organizationId: 'org-1',
        name: '测试组织',
        createdBy: 'owner',
        now,
      }),
      ws: createWorkspace(db, {
        workspaceId: 'ws-1',
        organizationId: 'org-1',
        name: '工作区',
        createdBy: 'owner',
        now,
      }),
      proj: createProject(db, {
        projectId: 'proj-1',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        name: '项目',
        createdBy: 'owner',
        now,
      }),
    }))

    for (const [label, entity] of Object.entries(created)) {
      expect(entity.version, `${label} 缺少版本号`).toBe(1)
      expect(entity.createdBy, `${label} 缺少创建者`).toBeTruthy()
      expect(entity.createdAt, `${label} 缺少创建时间`).toBeTruthy()
      expect(entity.updatedAt, `${label} 缺少修改时间`).toBeTruthy()
      expect(entity.state, `${label} 缺少状态`).toBe('active')
    }
  })

  it('项目的作用域链自近及远', () => {
    seedProject()
    expect(scopeChainOfProject(chat.readonlyHandle, 'proj-1')).toEqual([
      { scopeKind: 'workspace', scopeId: 'ws-1' },
      { scopeKind: 'organization', scopeId: 'org-1' },
    ])
  })
})

describe('并发控制', () => {
  it('版本匹配时更新成功并递增版本', () => {
    seedProject()
    const updated = chat.transaction((db) =>
      updateOrganizationState(db, {
        organizationId: 'org-1',
        expectedVersion: 1,
        state: 'suspended',
        now,
      }),
    )
    expect(updated.state).toBe('suspended')
    expect(updated.version).toBe(2)
  })

  it('版本不匹配时抛 VERSION_CONFLICT，且不改变数据', () => {
    seedProject()
    // §11.2：并发变更返回 VERSION_CONFLICT，不能静默覆盖
    expect(() =>
      chat.transaction((db) =>
        updateOrganizationState(db, {
          organizationId: 'org-1',
          expectedVersion: 99,
          state: 'archived',
          now,
        }),
      ),
    ).toThrow(VersionConflictError)

    const unchanged = findOrganization(chat.readonlyHandle, 'org-1')
    expect(unchanged?.state).toBe('active')
    expect(unchanged?.version).toBe(1)
  })

  it('第二个并发写入者拿到冲突而不是覆盖第一个', () => {
    seedProject()
    // 两者都基于版本 1 发起
    chat.transaction((db) =>
      updateOrganizationState(db, {
        organizationId: 'org-1',
        expectedVersion: 1,
        state: 'suspended',
        now,
      }),
    )
    expect(() =>
      chat.transaction((db) =>
        updateOrganizationState(db, {
          organizationId: 'org-1',
          expectedVersion: 1,
          state: 'archived',
          now,
        }),
      ),
    ).toThrow(VersionConflictError)
    expect(findOrganization(chat.readonlyHandle, 'org-1')?.state).toBe('suspended')
  })
})

describe('成员关系与授权的衔接', () => {
  it('新邀请的成员状态是 invited，尚不能发言', () => {
    seedProject()
    chat.transaction((db) =>
      inviteMember(db, {
        membershipId: 'm-1',
        organizationId: 'org-1',
        accountId: 'dev',
        scopeKind: 'project',
        scopeId: 'proj-1',
        role: 'developer',
        now,
      }),
    )
    expect(membershipsOf(chat.readonlyHandle, 'org-1', 'dev')[0]?.state).toBe('invited')
    // §11.2：只有 active 成员能发送项目消息
    expect(canSend('dev')).toBe(false)
  })

  it('接受邀请后转 active 并获得角色能力', () => {
    seedProject()
    const invited = chat.transaction((db) =>
      inviteMember(db, {
        membershipId: 'm-1',
        organizationId: 'org-1',
        accountId: 'dev',
        scopeKind: 'project',
        scopeId: 'proj-1',
        role: 'developer',
        now,
      }),
    )
    chat.transaction((db) =>
      acceptMembership(db, { membershipId: 'm-1', expectedVersion: invited.version, now }),
    )
    expect(membershipsOf(chat.readonlyHandle, 'org-1', 'dev')[0]?.state).toBe('active')
    expect(canSend('dev')).toBe(true)
  })

  it('重复接受同一邀请被版本检查拦下', () => {
    seedProject()
    const invited = chat.transaction((db) =>
      inviteMember(db, {
        membershipId: 'm-1',
        organizationId: 'org-1',
        accountId: 'dev',
        scopeKind: 'project',
        scopeId: 'proj-1',
        role: 'developer',
        now,
      }),
    )
    chat.transaction((db) =>
      acceptMembership(db, { membershipId: 'm-1', expectedVersion: invited.version, now }),
    )
    expect(() =>
      chat.transaction((db) =>
        acceptMembership(db, { membershipId: 'm-1', expectedVersion: invited.version, now }),
      ),
    ).toThrow(VersionConflictError)
  })

  it('同一账号在同一作用域不能有两条成员关系', () => {
    seedProject()
    const invite = (id: string): void => {
      chat.transaction((db) =>
        inviteMember(db, {
          membershipId: id,
          organizationId: 'org-1',
          accountId: 'dev',
          scopeKind: 'project',
          scopeId: 'proj-1',
          role: 'developer',
          now,
        }),
      )
    }
    invite('m-1')
    expect(() => invite('m-2')).toThrow()
  })
})
