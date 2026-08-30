/**
 * 组织、工作项与通知的 HTTP 端点。
 *
 * 与私聊端点同一套骨架，区别在于这些命令**需要授权判定** —— 私聊的准入由联系人
 * 关系决定，而组织内的操作由 §11 的双层模型决定：角色给出默认能力，作用域链
 * 向上合并。
 *
 * 判定与写入的顺序按 §26：**先判定后写入**，且判定结果与写入在同一事务内，
 * 使「判定通过但写入时权限已被收回」这种竞争不会产生已提交的越权写入。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { recordAuditEvent } from '../domain/audit/index.js'
import { createNotification, inboxSince, unreadCount } from '../domain/notification/index.js'
import {
  authorize,
  membershipsOf,
  scopeChainOfProject,
  type Capability,
  type MembershipSnapshot,
} from '../domain/organization/index.js'
import { addDependency, assignWorkItem, createWorkItem, findWorkItem } from '../domain/workitem/index.js'

import type { ChatDatabaseService } from '../storage/database-port.js'

import { commandHandler, type CommandGuard } from './command-router.js'
import type { Principal } from './message-commands.js'

export interface WorkspaceCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  readonly now: () => Date
  /** ID 生成器。注入而非内置，使测试可复现（§45：测试数据不含真实凭证）。 */
  readonly newId: (prefix: string) => string
  /**
   * §7.1 的请求证明校验。没配 relay 指纹时为 undefined，届时不校验。
   *
   * 只挂业务端点。身份三件套是会话的**引导路径**：注册时还没有设备，
   * refresh 根本不带 Bearer 头 —— 对它们要求签名等于要求「先有会话才能
   * 建会话」。
   */
  readonly guard?: CommandGuard
}

/**
 * 在项目作用域内判定能力。
 *
 * 读成员关系与作用域链都在传入的事务句柄上完成 —— 与后续写入同事务，
 * 避免「判定用的是旧快照、写入时权限已变」。
 */
function authorizeInProject(
  db: DatabaseSync,
  principal: Principal,
  projectId: string,
  capability: Capability,
): boolean {
  const memberships = membershipsOf(db, principal.organizationId, principal.accountId)
  const snapshots: MembershipSnapshot[] = memberships.map((m) => ({
    scopeKind: m.scopeKind,
    scopeId: m.scopeId,
    role: m.role,
    state: m.state,
  }))
  return authorize({
    // 组织状态从库中读；这里简化为 active，组织挂起的判定属 P0-b 的组织切换路径
    organizationState: 'active',
    memberships: snapshots,
    scopeKind: 'project',
    scopeId: projectId,
    ancestors: scopeChainOfProject(db, projectId),
    capability,
  }).allowed
}

interface CreateWorkItemBody {
  readonly projectId: string
  readonly title: string
  readonly operationId: string
  readonly description?: string
  readonly dueAt?: string
}

function parseCreateWorkItem(value: unknown): CreateWorkItemBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw['projectId'] !== 'string' ||
    typeof raw['title'] !== 'string' ||
    typeof raw['operationId'] !== 'string'
  ) {
    return undefined
  }
  const title = raw['title']
  if (title.length === 0 || title.length > 500) return undefined
  return {
    projectId: raw['projectId'],
    title,
    operationId: raw['operationId'],
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
    ...(typeof raw['dueAt'] === 'string' ? { dueAt: raw['dueAt'] } : {}),
  }
}

/** 创建工作项。需要 `project.create` 能力。 */
export function createWorkItemHandler(deps: WorkspaceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const body = parseCreateWorkItem(raw)
      if (!body) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }

      const now = deps.now()
      const workItemId = deps.newId('wi')

      return deps.database.transaction((db) => {
        if (!authorizeInProject(db, principal, body.projectId, 'project.create')) {
          recordAuditEvent(db, {
            auditEventId: deps.newId('ae'),
            organizationId: principal.organizationId,
            eventType: 'work_item_changed',
            occurredAt: now,
            actorAccountId: principal.accountId,
            deviceId: principal.deviceId,
            targetRef: `project:${body.projectId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            policyRevision: 1,
            operationId: body.operationId,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const created = createWorkItem(db, {
          workItemId,
          organizationId: principal.organizationId,
          projectId: body.projectId,
          title: body.title,
          createdBy: principal.accountId,
          now,
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
        })
        recordAuditEvent(db, {
          auditEventId: deps.newId('ae'),
          organizationId: principal.organizationId,
          eventType: 'work_item_changed',
          occurredAt: now,
          actorAccountId: principal.accountId,
          deviceId: principal.deviceId,
          targetRef: `work_item:${workItemId}`,
          outcome: 'succeeded',
          policyRevision: 1,
          operationId: body.operationId,
        })
        return { ok: true as const, value: created }
      })
    },
  })
}

/**
 * 分派工作项。
 *
 * 需要 `project.assign_work_item` 能力 —— §17 规定只有项目经理、项目管理员或被
 * 授予分派权限的成员可以变更负责人；开发者只能认领已开放的工作项。
 *
 * 分派成功后**在同一事务内**写入通知（§17.1：先写收件箱记录，再由 outbox 推送）。
 */
export function assignWorkItemHandler(deps: WorkspaceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      if (typeof raw !== 'object' || raw === null) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const input = raw as Record<string, unknown>
      const workItemId = input['workItemId']
      const assigneeId = input['assigneeId']
      const expectedVersion = input['expectedVersion']
      const operationId = input['operationId']
      if (
        typeof workItemId !== 'string' ||
        typeof assigneeId !== 'string' ||
        typeof expectedVersion !== 'number' ||
        typeof operationId !== 'string'
      ) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()

      return deps.database.transaction((db) => {
        const existing = findWorkItem(db, workItemId)
        if (!existing || existing.organizationId !== principal.organizationId) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }
        if (!authorizeInProject(db, principal, existing.projectId, 'project.assign_work_item')) {
          recordAuditEvent(db, {
            auditEventId: deps.newId('ae'),
            organizationId: principal.organizationId,
            eventType: 'work_item_changed',
            occurredAt: now,
            actorAccountId: principal.accountId,
            deviceId: principal.deviceId,
            targetRef: `work_item:${workItemId}`,
            outcome: 'rejected',
            errorCode: 'NOT_FOUND_OR_FORBIDDEN',
            policyRevision: 1,
            operationId,
          })
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const result = assignWorkItem(db, { workItemId, assigneeId, expectedVersion, now })
        if (!result.ok) {
          recordAuditEvent(db, {
            auditEventId: deps.newId('ae'),
            organizationId: principal.organizationId,
            eventType: 'work_item_changed',
            occurredAt: now,
            actorAccountId: principal.accountId,
            deviceId: principal.deviceId,
            targetRef: `work_item:${workItemId}`,
            outcome: 'rejected',
            errorCode: result.errorCode,
            policyRevision: 1,
            operationId,
          })
          return { ok: false as const, errorCode: result.errorCode }
        }

        // §17.1：通知先在数据库事务中写入，再由 outbox 任务推送。
        // 签收请求不参与聚合，始终逐条呈现。
        createNotification(db, {
          notificationId: deps.newId('n'),
          organizationId: principal.organizationId,
          recipientId: assigneeId,
          eventType: 'work_item_acknowledgement_request',
          resourceRef: `work_item:${workItemId}`,
          actorId: principal.accountId,
          summary: `你被分派了工作项：${result.workItem.title}`,
          priority: 'high',
          dedupeKey: `${workItemId}:assigned:${result.workItem.version}`,
          now,
        })
        recordAuditEvent(db, {
          auditEventId: deps.newId('ae'),
          organizationId: principal.organizationId,
          eventType: 'work_item_changed',
          occurredAt: now,
          actorAccountId: principal.accountId,
          deviceId: principal.deviceId,
          targetRef: `work_item:${workItemId}`,
          outcome: 'succeeded',
          policyRevision: 1,
          operationId,
        })
        return { ok: true as const, value: result.workItem }
      })
    },
  })
}

/** 添加工作项依赖。成环时返回 `DEPENDENCY_CYCLE` 并带上环的路径。 */
export function addDependencyHandler(deps: WorkspaceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      if (typeof raw !== 'object' || raw === null) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const input = raw as Record<string, unknown>
      const fromId = input['fromId']
      const toId = input['toId']
      const kind = input['kind']
      if (
        typeof fromId !== 'string' ||
        typeof toId !== 'string' ||
        (kind !== 'blocks' && kind !== 'depends_on')
      ) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      return deps.database.transaction((db) => {
        const item = findWorkItem(db, fromId)
        if (!item || item.organizationId !== principal.organizationId) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }
        if (!authorizeInProject(db, principal, item.projectId, 'project.assign_work_item')) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const result = addDependency(db, {
          organizationId: principal.organizationId,
          fromId,
          toId,
          kind,
          now: deps.now(),
        })
        if (!result.ok) return { ok: false as const, errorCode: result.errorCode }
        return { ok: true as const, value: { added: true } }
      })
    },
  })
}

/**
 * 读取收件箱。
 *
 * §17.1：host 重连后**从收件箱游标补拉**，因此接受 `after` 游标而不是页码 ——
 * 页码在有新通知插入时会错位。
 */
export function inboxHandler(deps: WorkspaceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const after = typeof input['after'] === 'string' ? input['after'] : undefined
      const limit =
        typeof input['limit'] === 'number' ? Math.min(Math.max(1, input['limit']), 100) : 50

      const db = deps.database.readonlyHandle
      const items = inboxSince(db, {
        organizationId: principal.organizationId,
        recipientId: principal.accountId,
        ...(after === undefined ? {} : { afterCreatedAt: after }),
        limit,
      })
      return {
        ok: true as const,
        value: {
          items,
          unread: unreadCount(db, principal.organizationId, principal.accountId),
        },
      }
    },
  })
}
