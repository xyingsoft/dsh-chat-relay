/**
 * 授权判定。
 *
 * §11 的双层模型：**角色给出默认能力，资源 ACL 决定实际操作**。
 * 账号在组织、工作区、项目三个层级分别获得角色，且
 * **较小范围的授权可以增加权限，不能突破上层的显式拒绝或账号冻结**。
 *
 * §48 要求判定由**服务端纯函数**统一执行，并以策略版本写入审计以便复算 ——
 * 因此本文件不做任何 I/O，输入是已读出的成员关系快照，输出是判定结果。
 */

import type { MembershipState, OrganizationState } from '../../contract/index.js'

/**
 * 角色标识符。
 *
 * §11.1 的角色表全为中文，没有给出英文标识符 —— 这是已登记的文档缺口。
 * 这里的取值是实现侧的命名，**不是**文档定义的品牌化 ID；若日后文档给出
 * 权威命名，以文档为准并在此处适配。
 */
export const ROLES = [
  'organization_owner',
  'organization_admin',
  'billing_admin',
  'analytics_admin',
  'project_manager',
  'developer',
  'member',
  'guest',
  'auditor',
  'bot_service_account',
] as const
export type Role = (typeof ROLES)[number]

/** 授权作用域的三个层级，对应 §11 的组织 → 工作区 → 项目。 */
export const SCOPE_KINDS = ['organization', 'workspace', 'project'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]

/**
 * 能力标识符。只列出 `P0-a` 实际判定的能力；未实现的能力不在此登记，
 * 其入口按文档要求返回 `NOT_IMPLEMENTED`，而不是在这里返回「无权限」——
 * 二者对调用方是完全不同的语义。
 */
export const CAPABILITIES = [
  'organization.manage',
  'organization.invite_member',
  'workspace.create',
  'project.create',
  'project.assign_work_item',
  'work_item.claim',
  'work_item.comment',
  'message.send',
  'audit.read',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/**
 * 角色的默认能力表。
 *
 * 逐条对应 §11.1 的角色表。**这是「默认能力」而不是最终授权** —— §11 明确
 * 「角色只定义默认能力，资源操作仍由资源 ACL 决定」，例如项目经理把目录授予
 * 开发者，该开发者不会因此能读项目经理的私聊或组织账单。
 */
const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = Object.freeze({
  organization_owner: [
    'organization.manage',
    'organization.invite_member',
    'workspace.create',
    'project.create',
    'project.assign_work_item',
    'work_item.claim',
    'work_item.comment',
    'message.send',
    'audit.read',
  ],
  organization_admin: [
    'organization.invite_member',
    'workspace.create',
    'project.create',
    'project.assign_work_item',
    'work_item.claim',
    'work_item.comment',
    'message.send',
    'audit.read',
  ],
  // 账单管理员「不管理成员或聊天内容」（§11.1）
  billing_admin: [],
  // 分析管理员「只能在授权范围查看聚合数据」，P0-a 无分析能力
  analytics_admin: [],
  project_manager: [
    'project.create',
    'project.assign_work_item',
    'work_item.claim',
    'work_item.comment',
    'message.send',
  ],
  developer: ['work_item.claim', 'work_item.comment', 'message.send'],
  member: ['work_item.comment', 'message.send'],
  // 访客默认可在被授予的群内发言，但不能创建群、邀请成员（§11.1）
  guest: ['message.send'],
  // 审计者只读，且默认不读消息正文（§11.1）
  auditor: ['audit.read'],
  bot_service_account: [],
})

/** 一条已读出的成员关系。判定所需的最小快照，不含无关字段。 */
export interface MembershipSnapshot {
  readonly scopeKind: ScopeKind
  readonly scopeId: string
  readonly role: Role
  readonly state: MembershipState
}

export interface AuthorizationInput {
  readonly organizationState: OrganizationState
  readonly memberships: readonly MembershipSnapshot[]
  /** 目标作用域：判定针对哪个组织/工作区/项目。 */
  readonly scopeKind: ScopeKind
  readonly scopeId: string
  /** 该作用域向上的祖先链，从近到远，用于「较小范围可增不可减」的合并。 */
  readonly ancestors: readonly { readonly scopeKind: ScopeKind; readonly scopeId: string }[]
  readonly capability: Capability
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly errorCode: 'FORBIDDEN' | 'NOT_FOUND_OR_FORBIDDEN' }

/**
 * 判定是否允许。
 *
 * 合并规则来自 §11：从目标作用域向上收集**状态为 `active`** 的成员关系，
 * 取其默认能力的并集 —— 较小范围**可以增加**权限。文档同时说「不能突破上层的
 * 显式拒绝或账号冻结」，`P0-a` 尚无显式拒绝条目（资源 ACL 属后续阶段），
 * 因此这里只实现「组织挂起」与「成员非 active」两条上层拒绝。
 *
 * 拒绝一律返回 `NOT_FOUND_OR_FORBIDDEN`，**不区分「无权限」与「对象不存在」** ——
 * §46 要求统一返回，用户错误码不得泄露其他组织、成员、文件或群的存在性。
 */
export function authorize(input: AuthorizationInput): AuthorizationDecision {
  // 组织挂起时停止新写入；只读与恢复能力不在 P0-a 的判定范围内
  if (input.organizationState !== 'active') {
    return { allowed: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }

  const chain = [{ scopeKind: input.scopeKind, scopeId: input.scopeId }, ...input.ancestors]

  for (const scope of chain) {
    for (const membership of input.memberships) {
      if (membership.scopeKind !== scope.scopeKind) continue
      if (membership.scopeId !== scope.scopeId) continue
      // 只有 active 成员能接收新授权、发送项目消息、下载资源或调用 Bot（§11.2）
      if (membership.state !== 'active') continue
      if (ROLE_CAPABILITIES[membership.role].includes(input.capability)) {
        return { allowed: true }
      }
    }
  }

  return { allowed: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
}

/** 某角色的默认能力，供界面呈现「可用操作」用。 */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}
