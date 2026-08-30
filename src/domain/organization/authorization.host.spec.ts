/**
 * 授权判定测试。
 *
 * §45 要求「每个状态转换与每条拒绝路径都有聚焦用例」，且安全用例断言的是
 * **拒绝行为与错误码**，而不仅是「未崩溃」。
 */

import { expect, it, describe } from 'vitest'

import {
  authorize,
  capabilitiesOf,
  ROLES,
  type AuthorizationInput,
  type MembershipSnapshot,
} from './authorization.js'

function input(overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    organizationState: 'active',
    memberships: [],
    scopeKind: 'project',
    scopeId: 'proj-1',
    ancestors: [
      { scopeKind: 'workspace', scopeId: 'ws-1' },
      { scopeKind: 'organization', scopeId: 'org-1' },
    ],
    capability: 'message.send',
    ...overrides,
  }
}

const activeMember = (
  scopeKind: MembershipSnapshot['scopeKind'],
  scopeId: string,
  role: MembershipSnapshot['role'],
): MembershipSnapshot => ({ scopeKind, scopeId, role, state: 'active' })

describe('允许路径', () => {
  it('项目层的开发者可以在项目内发言', () => {
    const decision = authorize(
      input({ memberships: [activeMember('project', 'proj-1', 'developer')] }),
    )
    expect(decision.allowed).toBe(true)
  })

  it('上层作用域的授权对下层生效', () => {
    // 组织所有者未在项目层单独授权，但组织层的角色沿链向下适用
    const decision = authorize(
      input({ memberships: [activeMember('organization', 'org-1', 'organization_owner')] }),
    )
    expect(decision.allowed).toBe(true)
  })

  it('较小范围可以增加权限', () => {
    // 组织层只是 member（无分派权），项目层是 project_manager（有）
    const decision = authorize(
      input({
        capability: 'project.assign_work_item',
        memberships: [
          activeMember('organization', 'org-1', 'member'),
          activeMember('project', 'proj-1', 'project_manager'),
        ],
      }),
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('拒绝路径', () => {
  it('无任何成员关系时拒绝', () => {
    const decision = authorize(input())
    expect(decision).toEqual({ allowed: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })

  it('组织挂起时拒绝，即使是所有者', () => {
    // §11.2：suspended 时停止新写入、Bot 调用和外部通知
    const decision = authorize(
      input({
        organizationState: 'suspended',
        memberships: [activeMember('organization', 'org-1', 'organization_owner')],
      }),
    )
    expect(decision.allowed).toBe(false)
  })

  it('成员状态非 active 时其角色不生效', () => {
    // §11.2：只有 active 成员能接收新授权、发送项目消息
    for (const state of ['invited', 'suspended', 'removed'] as const) {
      const decision = authorize(
        input({
          memberships: [{ scopeKind: 'project', scopeId: 'proj-1', role: 'developer', state }],
        }),
      )
      expect(decision.allowed, `成员状态 ${state} 不应获得授权`).toBe(false)
    }
  })

  it('其他项目的成员关系不能越界授权', () => {
    const decision = authorize(
      input({ memberships: [activeMember('project', 'proj-2', 'project_manager')] }),
    )
    expect(decision.allowed).toBe(false)
  })

  it('拒绝一律返回 NOT_FOUND_OR_FORBIDDEN，不泄露存在性', () => {
    // §46：统一返回，不区分「无权限」与「对象不存在」
    const noMembership = authorize(input())
    const wrongScope = authorize(
      input({ memberships: [activeMember('project', 'proj-2', 'organization_owner')] }),
    )
    expect(noMembership).toEqual(wrongScope)
  })
})

describe('角色默认能力对齐 §11.1', () => {
  it('账单管理员不管理成员或聊天内容', () => {
    const caps = capabilitiesOf('billing_admin')
    expect(caps).not.toContain('organization.invite_member')
    expect(caps).not.toContain('message.send')
  })

  it('审计者只读，且不含发言能力', () => {
    const caps = capabilitiesOf('auditor')
    expect(caps).toContain('audit.read')
    expect(caps).not.toContain('message.send')
  })

  it('访客可发言但不能邀请成员或建项目', () => {
    const caps = capabilitiesOf('guest')
    expect(caps).toContain('message.send')
    expect(caps).not.toContain('organization.invite_member')
    expect(caps).not.toContain('project.create')
  })

  it('开发者不能分派工作项', () => {
    // §17：只有项目经理、项目管理员或被授予分派权限的成员可变更负责人与终态
    expect(capabilitiesOf('developer')).not.toContain('project.assign_work_item')
    // 但可以认领已开放的工作项
    expect(capabilitiesOf('developer')).toContain('work_item.claim')
  })

  it('每个角色都有明确的能力表，没有遗漏', () => {
    for (const role of ROLES) {
      expect(Array.isArray(capabilitiesOf(role)), `${role} 缺少能力表`).toBe(true)
    }
  })
})
