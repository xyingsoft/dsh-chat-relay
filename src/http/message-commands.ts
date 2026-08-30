/**
 * 私聊命令的 HTTP 端点。
 *
 * 这是把领域模块接到浏览器的最后一层。每个端点严格按 §26 的顺序执行：
 *
 * > 认证 → 授权 → 版本检查 → **同一数据库事务写入领域对象和 outbox** → 提交后异步投递
 *
 * 其中「同一事务」是本文件最要紧的一条：领域写入、审计与 outbox **必须**在同一个
 * `transaction()` 回调内完成。§44.1.2 明确要求「审计写入失败导致整个命令失败」，
 * 分开写就做不到这一点。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import type { ErrorCode } from '../contract/index.js'
import { recordAuditEvent } from '../domain/audit/index.js'
import {
  checkDirectMessageGate,
  acceptDirectMessage,
  acknowledge,
  conversationsOf,
  editMessage,
  leaseBatch,
  messagesWith,
  revokeMessage,
} from '../domain/messaging/index.js'

import type { ChatDatabaseService } from '../storage/database-port.js'

import { commandHandler, type CommandOutcome } from './command-router.js'

/** 认证结果。本文件不做认证 —— 由上游的设备签名校验注入。 */
export interface Principal {
  readonly accountId: string
  readonly deviceId: string
  readonly organizationId: string
}

export interface MessageCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  /** 从请求中解析出调用者。返回 undefined 表示未认证。 */
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  /** 队列容量。属版本化 `PlanLimits`，从配置读取而非硬编码（§30.1）。 */
  readonly queueCapacity: number
  readonly leaseMs: number
  readonly now: () => Date
  /**
   * 组织配置的编辑窗口（§14.1）。缺省用 `DEFAULT_EDIT_WINDOW_MS`。
   *
   * 文档说「组织配置的」但没给默认值，已登记为缺口。
   */
  readonly editWindowMs?: number
  /**
   * 判定调用者是否具备合规撤回权限（§14.1）。
   *
   * 不提供时视为**没有**该权限 —— 默认拒绝而非默认放行。一个忘了接线的部署
   * 应该表现为「管理员撤不了别人的消息」，而不是「谁都能撤别人的消息」。
   */
  readonly authorizeCompliance?: (db: DatabaseSync, principal: Principal) => boolean
}

interface SendBody {
  readonly messageId: string
  readonly recipientId: string
  readonly body: string
  readonly operationId: string
}

function parseSendBody(value: unknown): SendBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const { messageId, recipientId, body, operationId } = raw
  if (
    typeof messageId !== 'string' ||
    typeof recipientId !== 'string' ||
    typeof body !== 'string' ||
    typeof operationId !== 'string'
  ) {
    return undefined
  }
  // §30.1：消息正文 8000 字素簇。用 Intl.Segmenter 按字素簇计数而非 length ——
  // 后者数的是 UTF-16 码元，一个 emoji 会被算成 2，中文与之无异但表情符号会误判
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(body)].length
  if (graphemes === 0 || graphemes > 8000) return undefined
  return { messageId, recipientId, body, operationId }
}

/**
 * 发送私聊。
 *
 * 顺序：认证 → 准入判定（§13 的联系人与拉黑）→ 同一事务写入消息、队列项与审计。
 *
 * 被拒绝时**同样写审计**（§43 第 14 步），且写在同一事务里 —— 否则拒绝路径的
 * 审计可能因为后续失败而丢失。
 */
export function sendMessageHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request): Promise<CommandOutcome<{ deliverySeq: number }>> => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false, errorCode: 'UNAUTHENTICATED' }

      const body = parseSendBody(raw)
      if (!body) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

      const now = deps.now()
      const audit = (outcome: 'succeeded' | 'rejected', errorCode?: ErrorCode) => ({
        auditEventId: `ae-${body.operationId}-${outcome}`,
        organizationId: principal.organizationId,
        eventType: 'message_accepted',
        occurredAt: now,
        actorAccountId: principal.accountId,
        deviceId: principal.deviceId,
        // 只放引用，不放正文（§43 第 14 步）
        targetRef: `message:${principal.accountId}/${body.messageId}`,
        outcome,
        policyRevision: 1,
        operationId: body.operationId,
        ...(errorCode === undefined ? {} : { errorCode }),
      })

      return deps.database.transaction((db) => {
        const gate = checkDirectMessageGate(db, {
          organizationId: principal.organizationId,
          senderId: principal.accountId,
          recipientId: body.recipientId,
        })
        if (!gate.allowed) {
          recordAuditEvent(db, audit('rejected', gate.errorCode))
          return { ok: false as const, errorCode: gate.errorCode }
        }

        const accepted = acceptDirectMessage(db, {
          messageId: body.messageId,
          organizationId: principal.organizationId,
          senderId: principal.accountId,
          recipientId: body.recipientId,
          body: body.body,
          operationId: body.operationId,
          now,
          queueCapacity: deps.queueCapacity,
        })

        if (!accepted.ok) {
          recordAuditEvent(db, audit('rejected', accepted.errorCode))
          return { ok: false as const, errorCode: accepted.errorCode }
        }

        // 幂等重放**不写第二条审计**。
        //
        // §26：「事务提交后网络连接断开时，调用方用同一幂等键查询最终结果」——
        // 重放是**查询首次执行的结果**，不是再次执行。为它补一条审计会让审计
        // 记录的操作次数多于实际发生的次数，而审计的用途正是回答「发生了什么」。
        //
        // 首次执行的那条审计已经存在，重放只是把它的结果再返回一次。
        if (!accepted.idempotentReplay) {
          recordAuditEvent(db, audit('succeeded'))
        }
        return { ok: true as const, value: { deliverySeq: accepted.deliverySeq } }
      })
    },
  })
}

/**
 * 拉取一个带租约的批次。
 *
 * 这是读+写混合：分配租约本身是写操作，所以整体在事务内完成。
 * 租约按**设备**分配（§28），因此 `deviceId` 来自认证结果而非请求体 ——
 * 让调用方自己声明设备等于允许它冒用别人的租约。
 */
export function pullMessagesHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const batchSize =
        typeof raw === 'object' && raw !== null && typeof (raw as { batchSize?: unknown }).batchSize === 'number'
          ? Math.min(Math.max(1, (raw as { batchSize: number }).batchSize), 100)
          : 50

      const items = deps.database.transaction((db) =>
        leaseBatch(db, {
          organizationId: principal.organizationId,
          recipientId: principal.accountId,
          deviceId: principal.deviceId,
          batchSize,
          leaseMs: deps.leaseMs,
          now: deps.now(),
        }),
      )
      return { ok: true as const, value: { items } }
    },
  })
}

/**
 * 确认一批 `DeliverySeq`。
 *
 * 只有持有租约的设备能 ACK；`deviceId` 同样来自认证结果。
 * 返回实际确认的条数 —— 与请求条数不符时，调用方据此知道有一部分租约已过期。
 */
export function ackMessagesHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const seqs =
        typeof raw === 'object' && raw !== null && Array.isArray((raw as { deliverySeqs?: unknown }).deliverySeqs)
          ? ((raw as { deliverySeqs: unknown[] }).deliverySeqs.filter(
              (v): v is number => typeof v === 'number',
            ) as number[])
          : []

      const acked = deps.database.transaction((db) =>
        acknowledge(db, {
          organizationId: principal.organizationId,
          recipientId: principal.accountId,
          deviceId: principal.deviceId,
          deliverySeqs: seqs,
          now: deps.now(),
        }),
      )
      return { ok: true as const, value: { acked, requested: seqs.length } }
    },
  })
}

// ── 编辑与撤回（§14.1）─────────────────────────────────────────────

/**
 * 编辑窗口的默认值。
 *
 * §14.1 说「组织配置的编辑窗口」，但**没有给出默认值**。这里取 15 分钟并把它
 * 登记为文档缺口 —— 不是因为 15 分钟有依据，而是因为端点必须有一个值才能工作。
 * 由 `MessageCommandDeps` 覆盖，不写死在判定逻辑里。
 */
export const DEFAULT_EDIT_WINDOW_MS = 15 * 60 * 1000

/** 编辑与撤回共用的正文校验，与发送保持同一口径。 */
function validBody(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(value)].length
  return graphemes > 0 && graphemes <= 8000
}

/**
 * 编辑自己发出的消息。
 *
 * `senderId` **取自认证结果而不是请求体** —— 否则任何人填上别人的 accountId
 * 就能去编辑别人的消息，领域层那道「只有原发送者」的检查会因为拿到的是伪造的
 * senderId 而通过。
 */
export function editMessageHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      if (typeof raw !== 'object' || raw === null) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const input = raw as Record<string, unknown>
      const messageId = input['messageId']
      const targetRevision = input['targetRevision']
      const operationId = input['operationId']
      const body = input['body']
      if (
        typeof messageId !== 'string' ||
        typeof operationId !== 'string' ||
        typeof targetRevision !== 'number' ||
        !Number.isInteger(targetRevision) ||
        targetRevision < 2 ||
        !validBody(body)
      ) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction((db) => {
        const result = editMessage(db, {
          organizationId: principal.organizationId,
          // 认证结果，不是请求体
          senderId: principal.accountId,
          messageId,
          editorId: principal.accountId,
          targetRevision,
          body,
          now,
          policyRevision: 1,
          operationId,
          editWindowMs: deps.editWindowMs ?? DEFAULT_EDIT_WINDOW_MS,
        })

        recordAuditEvent(db, {
          auditEventId: `ae-${operationId}-${result.ok ? 'succeeded' : 'rejected'}`,
          organizationId: principal.organizationId,
          eventType: 'message_edited',
          occurredAt: now,
          actorAccountId: principal.accountId,
          deviceId: principal.deviceId,
          // 只放引用，不放新正文 —— 否则审计表就成了消息正文的第二份副本
          targetRef: `message:${principal.accountId}/${messageId}`,
          outcome: result.ok ? 'succeeded' : 'rejected',
          policyRevision: 1,
          operationId,
          ...(result.ok ? {} : { errorCode: result.errorCode }),
        })

        return result.ok
          ? { ok: true as const, value: { revision: result.revision } }
          : { ok: false as const, errorCode: result.errorCode }
      })
    },
  })
}

/**
 * 撤回消息。
 *
 * 与编辑不同，撤回可以针对**他人的**消息（合规管理员），所以 `senderId` 必须
 * 来自请求体。合规权限由 `authorizeCompliance` 判定 —— 缺省实现返回 false，
 * 也就是说没有显式接线时只有原发送者能撤回。**默认拒绝**，不是默认放行。
 */
export function revokeMessageHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      if (typeof raw !== 'object' || raw === null) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const input = raw as Record<string, unknown>
      const messageId = input['messageId']
      const senderId = input['senderId']
      const operationId = input['operationId']
      if (
        typeof messageId !== 'string' ||
        typeof senderId !== 'string' ||
        typeof operationId !== 'string'
      ) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction((db) => {
        const hasCompliance =
          senderId === principal.accountId
            ? false
            : (deps.authorizeCompliance?.(db, principal) ?? false)

        const result = revokeMessage(db, {
          organizationId: principal.organizationId,
          senderId,
          messageId,
          actorId: principal.accountId,
          actorHasComplianceAuthority: hasCompliance,
          now,
          policyRevision: 1,
          operationId,
        })

        // 幂等重放跳过审计：重放是**查询首次执行的结果**，不是再次执行。
        // 不跳的话，同一 operationId 会生成同一个审计 ID，撞上审计表主键 ——
        // 而那会让一次本该成功的幂等重放变成 500。
        if (result.ok && result.idempotentReplay) {
          return { ok: true as const, value: { revision: result.revision } }
        }

        recordAuditEvent(db, {
          auditEventId: `ae-${operationId}-${result.ok ? 'succeeded' : 'rejected'}`,
          organizationId: principal.organizationId,
          eventType: 'message_revoked',
          occurredAt: now,
          actorAccountId: principal.accountId,
          deviceId: principal.deviceId,
          targetRef: `message:${senderId}/${messageId}`,
          outcome: result.ok ? 'succeeded' : 'rejected',
          policyRevision: 1,
          operationId,
          ...(result.ok ? {} : { errorCode: result.errorCode }),
        })

        return result.ok
          ? { ok: true as const, value: { revision: result.revision } }
          : { ok: false as const, errorCode: result.errorCode }
      })
    },
  })
}

/**
 * 会话列表。
 *
 * 只读端点，但仍走 `commandHandler` —— 它带跨源防护。读端点也要防跨源：
 * 会话列表含对端显示名与消息摘要，被第三方站点读走就是一次通讯录泄露。
 *
 * `accountId` 取自认证结果，请求体里给什么都不看。
 */
export function conversationsHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const limitInput =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)['limit']
          : undefined
      // 上限夹到 200：不夹的话调用方传一个巨大的 limit 就能让一次查询扫全表
      const limit =
        typeof limitInput === 'number' && Number.isInteger(limitInput) && limitInput > 0
          ? Math.min(limitInput, 200)
          : 50

      const conversations = deps.database.transaction((db) =>
        conversationsOf(db, principal.organizationId, principal.accountId, { limit }),
      )
      return { ok: true as const, value: { conversations } }
    },
  })
}

/**
 * 某个会话的消息记录。
 *
 * `peerId` 来自请求体（要看哪个会话是调用方的选择），但**只返回自己参与的
 * 消息** —— `messagesWith` 的查询两侧都锚定在认证出来的 accountId 上，
 * 所以填别人的 peerId 只会得到空列表，拿不到他人之间的对话。
 */
export function messageHistoryHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const peerId = input['peerId']
      if (typeof peerId !== 'string' || peerId.length === 0) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const limitInput = input['limit']
      const limit =
        typeof limitInput === 'number' && Number.isInteger(limitInput) && limitInput > 0
          ? Math.min(limitInput, 200)
          : 50

      const messages = deps.database.transaction((db) =>
        messagesWith(db, principal.organizationId, principal.accountId, peerId, { limit }),
      )
      return { ok: true as const, value: { messages } }
    },
  })
}
