/**
 * 组织切换与缓存隔离测试。
 *
 * §9 的核心断言只有一句：「切换组织不会把前一组织的消息、资源、私人会话、
 * 搜索索引或未发送草稿暴露到新组织」。所以测试的形状是**先在 A 组织放一份
 * 可识别的数据，切到 B，再确认它拿不到**。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OrganizationSession } from './org-switch.js'
import { acceptMembership, inviteMember } from './repository.js'

let db: DatabaseSync
const NOW = new Date('2026-08-30T00:00:00Z')

/** 让某账号在某组织成为 active 成员。 */
function join(accountId: string, organizationId: string, state: 'active' | 'invited'): void {
  const membershipId = `m-${accountId}-${organizationId}`
  inviteMember(db, {
    membershipId,
    organizationId,
    accountId,
    scopeKind: 'organization',
    scopeId: organizationId,
    role: 'developer',
    now: NOW,
  })
  if (state === 'active') {
    acceptMembership(db, { membershipId, expectedVersion: 1, now: NOW })
  }
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE memberships (
      membership_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      role TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL
    ) STRICT;
  `)
  join('jia', 'org-a', 'active')
  join('jia', 'org-b', 'active')
})

afterEach(() => db.close())

describe('切换的前置校验', () => {
  it('成员状态为 active 才能切入（§9）', () => {
    const session = new OrganizationSession('jia')
    expect(session.switchTo(db, 'org-a').ok).toBe(true)
  })

  it('仅被邀请、尚未接受时不能切入', () => {
    join('yi', 'org-a', 'invited')
    const session = new OrganizationSession('yi')
    const result = session.switchTo(db, 'org-a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NOT_FOUND_OR_FORBIDDEN')
  })

  it('非成员与非 active 返回同一结果', () => {
    // 区分开就能探测某账号在某组织的成员状态
    join('yi', 'org-a', 'invited')
    const yi = new OrganizationSession('yi')
    const bing = new OrganizationSession('bing')
    expect(yi.switchTo(db, 'org-a')).toEqual(bing.switchTo(db, 'org-a'))
  })

  it('切换失败时当前组织不变', () => {
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.switchTo(db, 'org-nonexistent')
    expect(session.currentOrganizationId).toBe('org-a')
  })
})

describe('缓存按组织隔离', () => {
  it('切换后拿不到前一组织的缓存', () => {
    // §9：不会把前一组织的消息、资源、私人会话、搜索索引或未发送草稿
    // 暴露到新组织
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('draft:conv-1', '甲在 A 组织写了一半的草稿')

    session.switchTo(db, 'org-b')
    expect(session.cache()?.get('draft:conv-1')).toBeUndefined()
    expect(session.cache()?.size).toBe(0)
  })

  it('同名键在两个组织互不覆盖', () => {
    // 隔离靠桶而不是靠键前缀 —— 若靠前缀，某天有人加了个忘记带前缀的键，
    // 隔离就在那一处破了
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('inbox-cursor', 'A 的游标')
    session.switchTo(db, 'org-b')
    session.cache()?.set('inbox-cursor', 'B 的游标')
    expect(session.cache()?.get('inbox-cursor')).toBe('B 的游标')
  })

  it('切回原组织不会复活旧缓存', () => {
    // 期间权限可能已变，旧缓存不再可信。§9：「当前页面若持有旧组织资源，
    // 则先失效并重新授权」
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('projects', ['proj-1'])
    session.switchTo(db, 'org-b')
    session.switchTo(db, 'org-a')
    expect(session.cache()?.get('projects')).toBeUndefined()
  })

  it('切换后内存中不再持有前一组织的桶', () => {
    // 「读不到」与「不残留」是两回事。前者靠键隔离就够，后者要求真的丢弃 ——
    // 否则一次内存转储仍然能读出前一组织的草稿
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('secret', '不该跟着走的东西')
    session.switchTo(db, 'org-b')
    expect(session.cachedOrganizations()).not.toContain('org-a')

    // 桶是惰性创建的，所以此刻一个都没有 —— 切过去还没读过缓存
    expect(session.cachedOrganizations()).toEqual([])
    session.cache()
    expect(session.cachedOrganizations()).toEqual(['org-b'])
  })

  it('重复切换到当前组织不清空缓存', () => {
    // 界面上重复点一次当前组织就清空所有缓存，是纯粹的性能损失
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('projects', ['proj-1'])
    session.switchTo(db, 'org-a')
    expect(session.cache()?.get('projects')).toEqual(['proj-1'])
  })
})

describe('未切入任何组织时', () => {
  it('cache() 返回 undefined 而不是空 Map', () => {
    // §48：「失效无法确认时默认拒绝访问」。空 Map 会让调用方以为
    // 「这个组织确实没缓存」，而实际是「不知道现在在哪个组织」
    const session = new OrganizationSession('jia')
    expect(session.currentOrganizationId).toBeUndefined()
    expect(session.cache()).toBeUndefined()
  })
})

describe('退出组织', () => {
  it('删除该组织的缓存桶（§9 最后一段）', () => {
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.cache()?.set('x', 1)
    session.switchTo(db, 'org-b')
    session.cache()?.set('y', 2)

    session.leave('org-b')
    expect(session.cachedOrganizations()).toEqual([])
  })

  it('退出当前组织后 cache() 返回 undefined', () => {
    const session = new OrganizationSession('jia')
    session.switchTo(db, 'org-a')
    session.leave('org-a')
    expect(session.currentOrganizationId).toBeUndefined()
    expect(session.cache()).toBeUndefined()
  })
})

describe('每个账号一个会话', () => {
  it('同一设备上两个账号的当前组织互不相干', () => {
    // 做成全局单例的话，后登录的账号会改掉前一个的视图
    join('yi', 'org-b', 'active')
    const jia = new OrganizationSession('jia')
    const yi = new OrganizationSession('yi')
    jia.switchTo(db, 'org-a')
    yi.switchTo(db, 'org-b')
    expect(jia.currentOrganizationId).toBe('org-a')
    expect(yi.currentOrganizationId).toBe('org-b')
  })

  it('一个账号的成员关系不让另一个账号切进去', () => {
    // 甲是 org-a 的成员，乙不是。乙不能借甲的成员关系切入
    const yi = new OrganizationSession('yi')
    expect(yi.switchTo(db, 'org-a').ok).toBe(false)
  })
})
