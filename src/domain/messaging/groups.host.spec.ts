/**
 * 群领域函数测试（P1 S1 最小模型）。
 *
 * 与 relay 其它领域 spec 一致：不跑 MIGRATIONS，测试内联建所需表
 * （`groups` + `group_members`），只验证本模块的不变量。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addGroupMember,
  createGroup,
  groupMemberCount,
  groupsOf,
  isGroupMember,
} from './groups.js'

let db: DatabaseSync
const ORG_A = 'org-a'
const ORG_B = 'org-b'
const T0 = '2026-09-03T00:00:00.000Z'

const members = (groupId: string): number =>
  groupMemberCount({ db, organizationId: ORG_A, groupId })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE groups (
      organization_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id)
    ) STRICT;
    CREATE TABLE group_members (
      organization_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id, account_id)
    ) STRICT;
  `)
})

afterEach(() => db.close())

describe('createGroup', () => {
  it('建群并把创建者自动加为成员', () => {
    const { groupId } = createGroup({ db, organizationId: ORG_A, creatorAccountId: 'jia', name: '甲乙联调群', now: T0 })
    expect(groupId).toMatch(/^group-/)
    expect(members(groupId)).toBe(1)
    expect(isGroupMember({ db, organizationId: ORG_A, groupId, accountId: 'jia' })).toBe(true)
  })

  it('空白群名被拒绝', () => {
    expect(() => createGroup({ db, organizationId: ORG_A, creatorAccountId: 'jia', name: '   ' })).toThrow(
      /blank/,
    )
  })
})

describe('addGroupMember 幂等', () => {
  it('首次加入返回 added，再次加入返回未新增且人数不变', () => {
    const { groupId } = createGroup({ db, organizationId: ORG_A, creatorAccountId: 'jia', name: 'g', now: T0 })
    expect(addGroupMember({ db, organizationId: ORG_A, groupId, accountId: 'yi', now: T0 }).added).toBe(true)
    expect(members(groupId)).toBe(2)
    expect(addGroupMember({ db, organizationId: ORG_A, groupId, accountId: 'yi', now: T0 }).added).toBe(false)
    expect(members(groupId)).toBe(2)
  })
})

describe('组织隔离', () => {
  it('同一 group_id 在不同组织互不可见', () => {
    const a = createGroup({ db, organizationId: ORG_A, creatorAccountId: 'jia', name: 'A 群', now: T0 })
    // 直接复制群到另一个组织，验证查询互不串
    db.prepare(
      `INSERT INTO groups (organization_id, group_id, name, created_by_account_id, created_at)
       VALUES (?,?,?,?,?)`,
    ).run(ORG_B, a.groupId, 'B 群', 'yi', T0)
    expect(groupsOf({ db, organizationId: ORG_A, accountId: 'jia' }).map((g) => g.groupId)).toEqual([
      a.groupId,
    ])
    expect(groupsOf({ db, organizationId: ORG_B, accountId: 'jia' })).toEqual([])
    expect(groupMemberCount({ db, organizationId: ORG_B, groupId: a.groupId })).toBe(0)
  })

  it('非成员看不见群、成员身份不跨组织', () => {
    const { groupId } = createGroup({ db, organizationId: ORG_A, creatorAccountId: 'jia', name: '内部群', now: T0 })
    expect(groupsOf({ db, organizationId: ORG_A, accountId: 'yi' })).toEqual([])
    expect(isGroupMember({ db, organizationId: ORG_A, groupId, accountId: 'yi' })).toBe(false)
    expect(isGroupMember({ db, organizationId: ORG_B, groupId, accountId: 'jia' })).toBe(false)
  })
})
