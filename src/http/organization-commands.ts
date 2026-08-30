/**
 * 组织、工作区、项目与成员的 HTTP 端点。
 *
 * 这些是骨架第 3 步（「甲创建组织、工作区和项目，并把乙以开发者角色邀请进项目」）
 * 经 HTTP 的入口。领域逻辑早已在 `@dsh-chat/organization` 中实现并测试，
 * 本文件只负责边界：解析、鉴权、审计、错误映射。
 *
 * ## 与工作项端点的两处不同
 *
 * **判定作用域不是项目而是组织或工作区**，因此不能复用 `authorizeInProject`。
 * 作用域链的形状随目标层级变化：项目有 workspace + organization 两级祖先，
 * 工作区只有 organization 一级，组织本身没有祖先。
 *
 * **创建组织这个命令没有作用域可判定** —— 组织还不存在，任何成员关系都无从谈起。
 * 见 `createOrganizationHandler` 的说明。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { recordAuditEvent } from '../domain/audit/index.js'
import {
  ROLES,
  SCOPE_KINDS,
  VersionConflictError,
  acceptMembership,
  authorize,
  createOrganization,
  createProject,
  createWorkspace,
  findMembership,
  findOrganization,
  inviteMember,
  membershipsOf,
  type Capability,
  type MembershipSnapshot,
  type Role,
  type ScopeKind,
} from '../domain/organization/index.js'

import type { ChatDatabaseService } from '../storage/database-port.js'

import { commandHandler } from './command-router.js'
import type { Principal } from './message-commands.js'

export interface OrganizationCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  readonly now: () => Date
  readonly newId: (prefix: string) => string
}

/**
 * 在任意作用域内判定能力。
 *
 * 组织状态从库中**读出**而不是写死 `'active'` —— 组织被挂起后所有写入都应停止，
 * 而挂起状态只存在数据库里。工作项端点当前把它简化为常量，那是那条路径上的
 * 待补项；新写的这条不重复该简化。
 */
function authorizeInScope(
  db: DatabaseSync,
  principal: Principal,
  target: { readonly scopeKind: ScopeKind; readonly scopeId: string },
  ancestors: ReadonlyArray<{ readonly scopeKind: ScopeKind; readonly scopeId: string }>,
  capability: Capability,
): boolean {
  const organization = findOrganization(db, principal.organizationId)
  if (organization === undefined) return false

  const snapshots: MembershipSnapshot[] = membershipsOf(
    db,
    principal.organizationId,
    principal.accountId,
  ).map((m) => ({ scopeKind: m.scopeKind, scopeId: m.scopeId, role: m.role, state: m.state }))

  return authorize({
    organizationState: organization.state,
    memberships: snapshots,
    scopeKind: target.scopeKind,
    scopeId: target.scopeId,
    ancestors,
    capability,
  }).allowed
}

/** 记一条审计。所有端点共用，避免每处重复十几行字段。 */
function audit(
  db: DatabaseSync,
  deps: OrganizationCommandDeps,
  principal: Principal,
  input: {
    readonly eventType: string
    readonly targetRef: string
    readonly outcome: 'succeeded' | 'rejected'
    readonly operationId: string
    readonly errorCode?: string
    readonly now: Date
  },
): void {
  recordAuditEvent(db, {
    auditEventId: deps.newId('ae'),
    organizationId: principal.organizationId,
    eventType: input.eventType,
    occurredAt: input.now,
    actorAccountId: principal.accountId,
    deviceId: principal.deviceId,
    targetRef: input.targetRef,
    outcome: input.outcome,
    policyRevision: 1,
    operationId: input.operationId,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  })
}

function requireStrings<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const out = {} as Record<K, string>
  for (const key of keys) {
    const value = source[key]
    // 空字符串一律拒绝：名称为空的组织在界面上不可指认，而它能被创建
    if (typeof value !== 'string' || value.length === 0) return undefined
    out[key] = value
  }
  return out
}

/** 名称上限。§30.1 对消息正文有明确限额，对名称没有；取一个保守值并登记为缺口。 */
const MAX_NAME_LENGTH = 200

/**
 * 创建组织。
 *
 * **这个命令没有可判定的作用域** —— 组织尚不存在，成员关系无从谈起。§12 说
 * 「自建组织用户」可以创建组织，也就是说创建组织的权限来自「已认证」本身，
 * 不来自任何组织内角色。
 *
 * 因此这里只检查认证，不做 `authorize` 调用。这不是遗漏；写一个恒真的判定
 * 反而会让读者以为此处有权限约束。真正的约束在配额侧（组织数量上限），
 * 那属于 §12 的订阅与容量，P0-a 未实现，已登记。
 *
 * 创建者自动成为 `organization_owner` 且状态直接为 `active` —— 若沿用邀请流程
 * 的 `invited`，创建者就要接受自己发出的邀请才能操作自己的组织。
 */
export function createOrganizationHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = requireStrings(raw, ['name', 'operationId'])
      if (!body || body.name.length > MAX_NAME_LENGTH) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      const organizationId = deps.newId('org')

      return deps.database.transaction((db) => {
        const organization = createOrganization(db, {
          organizationId,
          name: body.name,
          createdBy: principal.accountId,
          now,
        })

        const membershipId = deps.newId('mem')
        db.prepare(
          `INSERT INTO memberships
             (membership_id, organization_id, account_id, scope_kind, scope_id, role, state,
              created_at, updated_at, version, policy_revision)
           VALUES (?, ?, ?, 'organization', ?, 'organization_owner', 'active', ?, ?, 1, 1)`,
        ).run(
          membershipId,
          organizationId,
          principal.accountId,
          organizationId,
          now.toISOString(),
          now.toISOString(),
        )

        // 审计写在创建者自己的新组织下，不是 principal 当前所在的组织 ——
        // 这条事件属于新组织的历史
        recordAuditEvent(db, {
          auditEventId: deps.newId('ae'),
          organizationId,
          eventType: 'membership_changed',
          occurredAt: now,
          actorAccountId: principal.accountId,
          deviceId: principal.deviceId,
          targetRef: `organization:${organizationId}`,
          outcome: 'succeeded',
          policyRevision: 1,
          operationId: body.operationId,
        })

        return { ok: true as const, value: { organization, membershipId } }
      })
    },
  })
}

/** 创建工作区。需要组织作用域的 `workspace.create`。 */
export function createWorkspaceHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = requireStrings(raw, ['name', 'operationId'])
      if (!body || body.name.length > MAX_NAME_LENGTH) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction((db) => {
        const target = { scopeKind: 'organization' as const, scopeId: principal.organizationId }
        if (!authorizeInScope(db, principal, target, [], 'workspace.create')) {
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `organization:${principal.organizationId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            operationId: body.operationId,
            now,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const workspace = createWorkspace(db, {
          workspaceId: deps.newId('ws'),
          organizationId: principal.organizationId,
          name: body.name,
          createdBy: principal.accountId,
          now,
        })
        audit(db, deps, principal, {
          eventType: 'membership_changed',
          targetRef: `workspace:${workspace.workspaceId}`,
          outcome: 'succeeded',
          operationId: body.operationId,
          now,
        })
        return { ok: true as const, value: workspace }
      })
    },
  })
}

/**
 * 创建项目。需要工作区作用域的 `project.create`。
 *
 * 工作区归属校验用 `organization_id` 过滤 —— 不这样做的话，甲能在乙的组织的
 * 工作区下创建项目，只要他猜到那个 `workspaceId`。§48 要求每个数据库查询都
 * 携带 `OrganizationId`，这就是原因。
 */
export function createProjectHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = requireStrings(raw, ['workspaceId', 'name', 'operationId'])
      if (!body || body.name.length > MAX_NAME_LENGTH) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction((db) => {
        const workspace = db
          .prepare('SELECT 1 FROM workspaces WHERE workspace_id = ? AND organization_id = ?')
          .get(body.workspaceId, principal.organizationId)

        const target = { scopeKind: 'workspace' as const, scopeId: body.workspaceId }
        const ancestors = [
          { scopeKind: 'organization' as const, scopeId: principal.organizationId },
        ]
        const allowed =
          workspace !== undefined &&
          authorizeInScope(db, principal, target, ancestors, 'project.create')

        if (!allowed) {
          // 工作区不存在与无权限返回同一个错误码 —— 区分开就是一个
          // 跨组织的工作区存在性探测接口（§46）
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `workspace:${body.workspaceId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            operationId: body.operationId,
            now,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const project = createProject(db, {
          projectId: deps.newId('proj'),
          organizationId: principal.organizationId,
          workspaceId: body.workspaceId,
          name: body.name,
          createdBy: principal.accountId,
          now,
        })
        audit(db, deps, principal, {
          eventType: 'membership_changed',
          targetRef: `project:${project.projectId}`,
          outcome: 'succeeded',
          operationId: body.operationId,
          now,
        })
        return { ok: true as const, value: project }
      })
    },
  })
}

/**
 * 邀请成员。需要目标作用域链上的 `organization.invite_member`。
 *
 * 被邀请人进入 `invited` 状态，**不是 `active`** —— §11.2 规定只有 `active`
 * 成员能接收新授权。邀请单方面把人拉成 active 的话，被邀请人还没同意就已经
 * 承担了该角色的能力。
 */
export function inviteMemberHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = requireStrings(raw, ['accountId', 'scopeKind', 'scopeId', 'role', 'operationId'])
      if (!body) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      // 角色与作用域类型必须是枚举里的值。放行任意字符串的话，
      // 一个拼错的角色名会被存进库，之后 ROLE_CAPABILITIES 查表拿到 undefined
      if (!(ROLES as readonly string[]).includes(body.role)) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      if (!(SCOPE_KINDS as readonly string[]).includes(body.scopeKind)) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      const scopeKind = body.scopeKind as ScopeKind
      return deps.database.transaction((db) => {
        const ancestors = ancestorsOf(db, scopeKind, body.scopeId, principal.organizationId)
        const target = { scopeKind, scopeId: body.scopeId }
        if (!authorizeInScope(db, principal, target, ancestors, 'organization.invite_member')) {
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `${scopeKind}:${body.scopeId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            operationId: body.operationId,
            now,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const membership = inviteMember(db, {
          membershipId: deps.newId('mem'),
          organizationId: principal.organizationId,
          accountId: body.accountId,
          scopeKind,
          scopeId: body.scopeId,
          role: body.role as Role,
          now,
        })
        audit(db, deps, principal, {
          eventType: 'membership_changed',
          targetRef: `membership:${membership.membershipId}`,
          outcome: 'succeeded',
          operationId: body.operationId,
          now,
        })
        return { ok: true as const, value: membership }
      })
    },
  })
}

/**
 * 接受邀请。
 *
 * 只有**被邀请人本人**能接受。这不是从 `authorize` 得来的 —— 能力表里没有
 * 「接受自己的邀请」这一项，因为它不是一项权限，而是一条身份等同判断。
 */
export function acceptMembershipHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = requireStrings(raw, ['membershipId', 'operationId'])
      if (!body) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      const expectedVersion = (raw as Record<string, unknown>)['expectedVersion']
      if (typeof expectedVersion !== 'number') {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction((db) => {
        const membership = findMembership(db, body.membershipId)
        const isOwn =
          membership !== undefined &&
          membership.accountId === principal.accountId &&
          membership.organizationId === principal.organizationId

        if (!isOwn) {
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `membership:${body.membershipId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            operationId: body.operationId,
            now,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        try {
          const accepted = acceptMembership(db, {
            membershipId: body.membershipId,
            expectedVersion,
            now,
          })
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `membership:${body.membershipId}`,
            outcome: 'succeeded',
            operationId: body.operationId,
            now,
          })
          return { ok: true as const, value: accepted }
        } catch (error) {
          if (!(error instanceof VersionConflictError)) throw error
          audit(db, deps, principal, {
            eventType: 'membership_changed',
            targetRef: `membership:${body.membershipId}`,
            outcome: 'rejected',
            errorCode: 'VERSION_CONFLICT',
            operationId: body.operationId,
            now,
          })
          return { ok: false as const, errorCode: 'VERSION_CONFLICT' as const }
        }
      })
    },
  })
}

/**
 * 列出自己在当前组织的成员关系。
 *
 * 只返回**调用者自己的** —— 列出他人的成员关系需要 `organization.manage`，
 * 那是另一个端点。默认返回全组织成员名单会让任何 guest 拿到完整通讯录。
 */
export function myMembershipsHandler(deps: OrganizationCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      return deps.database.transaction((db) => {
        const memberships = membershipsOf(db, principal.organizationId, principal.accountId)
        return { ok: true as const, value: { memberships } }
      })
    },
  })
}

/**
 * 目标作用域的祖先链，从近到远。
 *
 * 组织没有祖先；工作区的祖先是组织；项目的祖先是工作区加组织。查项目所属工作区
 * 时带上 `organization_id`，理由同 `createProjectHandler`。
 */
function ancestorsOf(
  db: DatabaseSync,
  scopeKind: ScopeKind,
  scopeId: string,
  organizationId: string,
): ReadonlyArray<{ readonly scopeKind: ScopeKind; readonly scopeId: string }> {
  const organization = { scopeKind: 'organization' as const, scopeId: organizationId }
  if (scopeKind === 'organization') return []
  if (scopeKind === 'workspace') return [organization]

  const row = db
    .prepare('SELECT workspace_id FROM projects WHERE project_id = ? AND organization_id = ?')
    .get(scopeId, organizationId) as { workspace_id: string } | undefined
  if (row === undefined) return [organization]
  return [{ scopeKind: 'workspace' as const, scopeId: row.workspace_id }, organization]
}
