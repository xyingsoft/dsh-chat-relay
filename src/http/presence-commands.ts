/**
 * 在线状态端点（§9.1）。
 *
 * relay 侧才看得全：在线状态是「这个人的**任意一台** host 在不在跑」，而
 * 每台 host 只知道自己。host 本地那份只服务单机模式。
 *
 * ## 可见性过滤在这一层做
 *
 * 让客户端自觉是不行的 —— 界面拿到什么就能显示什么，一个改过的客户端会把
 * 隐藏的人也画出来。所以真实状态在离开这个进程之前就已经被过滤过了。
 *
 * ## `sharesScope` 是真算的
 *
 * §9.1 的「仅项目/群成员可见」需要知道两人有没有共享作用域。host 那边没有
 * 成员关系表，只能接受调用方注入一个判定；relay 有，所以这里直接查 ——
 * 一个「默认返回 false」的占位实现会让 `shared_scopes` 事实上等同于
 * `hidden`，而用户选的是前者。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import type { PresenceState } from '../contract/index.js'
import {
  PRESENCE_VISIBILITY,
  applyVisibility,
  presenceOf,
  recordHeartbeat,
  type PresenceVisibility,
} from '../domain/identity/presence.js'
import type { ChatDatabasePort } from '../storage/database-port.js'

import { commandHandler, type CommandGuard } from './command-router.js'
import type { Principal } from './message-commands.js'

export interface PresenceCommandDeps {
  readonly database: ChatDatabasePort
  readonly expectedOrigin: string
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  readonly now: () => Date
  readonly guard?: CommandGuard
}

/** 上报心跳。`lastInteractionAt` 由 host 转达浏览器观察到的交互时间。 */
export function heartbeatHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const at = deps.now()
      const reported = (raw as { lastInteractionAt?: unknown }).lastInteractionAt
      const parsed = typeof reported === 'string' ? new Date(reported) : undefined
      // 未来的交互时间一律丢弃并回落到「现在」。信它的话，一个时钟设错的
      // 客户端会让自己永远显示 online，idle 就再也不会出现
      const lastInteractionAt =
        parsed !== undefined && !Number.isNaN(parsed.getTime()) && parsed.getTime() <= at.getTime()
          ? parsed
          : at

      deps.database.transaction((db: DatabaseSync) => {
        recordHeartbeat(db, {
          deviceId: principal.deviceId,
          accountId: principal.accountId,
          organizationId: principal.organizationId,
          at,
          lastInteractionAt,
        })
      })
      return { ok: true as const, value: { at: at.toISOString() } }
    },
  })
}

/** 查询上限。不截断的话这个端点就是一次全组织扫描。 */
const MAX_QUERY = 200

/**
 * 查一批人的在线状态。
 *
 * 只接受显式账号列表，**不提供「列出全组织在线的人」** —— 那等于一个组织
 * 通讯录，而列名单是要 `organization.manage` 的（§46 也要求不泄露其他成员的
 * 存在性）。
 */
export function presenceQueryHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const requested = (raw as { accountIds?: unknown }).accountIds
      if (!Array.isArray(requested)) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const accountIds = [
        ...new Set(requested.filter((id): id is string => typeof id === 'string' && id.length > 0)),
      ].slice(0, MAX_QUERY)

      const now = deps.now()
      const presence = deps.database.transaction((db: DatabaseSync) => {
        const out: Record<string, PresenceState> = {}
        for (const accountId of accountIds) {
          const actual = presenceOf(db, {
            organizationId: principal.organizationId,
            accountId,
            now,
          })
          out[accountId] = applyVisibility(actual, {
            visibility: visibilityOf(db, principal.organizationId, accountId),
            isSelf: accountId === principal.accountId,
            sharesScope: sharesScope(db, principal.organizationId, principal.accountId, accountId),
          })
        }
        return out
      }) as Record<string, PresenceState>

      return { ok: true as const, value: { presence } }
    },
  })
}

/**
 * 改自己的可见性。
 *
 * 只能改自己的 —— 这不是一项可以被授予的权限，是一条身份等同判断。允许
 * 管理员代改的话，「隐身」就成了一个可以被别人关掉的开关，那它保护不了任何东西。
 */
export function setVisibilityHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const value = (raw as { visibility?: unknown }).visibility
      if (
        typeof value !== 'string' ||
        !(PRESENCE_VISIBILITY as readonly string[]).includes(value)
      ) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      deps.database.transaction((db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO presence_visibility (account_id, organization_id, visibility, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, organization_id) DO UPDATE SET
             visibility = excluded.visibility,
             updated_at = excluded.updated_at`,
        ).run(principal.accountId, principal.organizationId, value, now.toISOString())
      })
      return { ok: true as const, value: { visibility: value as PresenceVisibility } }
    },
  })
}

/** 读自己的可见性。界面要能显示当前选的是哪一档。 */
export function getVisibilityHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    ...(deps.guard === undefined ? {} : { guard: deps.guard }),
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const visibility = deps.database.transaction((db: DatabaseSync) =>
        visibilityOf(db, principal.organizationId, principal.accountId),
      ) as PresenceVisibility
      return { ok: true as const, value: { visibility } }
    },
  })
}

/**
 * 某人在某组织的可见性。没设过按 `everyone`。
 *
 * 默认隐藏会让在线状态整个看起来是坏的 —— 用户打开界面看到所有人都是
 * 「状态未知」，第一反应是功能没做完，而不是「大家都隐身了」。
 *
 * 存了一个不认识的值时同样按 `everyone` 而不是抛：那多半是降级部署写进去的
 * 新档位，而一个查不出在线状态的界面比一个多显示了状态的界面更像坏了。
 */
function visibilityOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
): PresenceVisibility {
  const row = db
    .prepare(
      'SELECT visibility FROM presence_visibility WHERE account_id = ? AND organization_id = ?',
    )
    .get(accountId, organizationId) as { visibility: string } | undefined
  const value = row?.visibility
  return value !== undefined && (PRESENCE_VISIBILITY as readonly string[]).includes(value)
    ? (value as PresenceVisibility)
    : 'everyone'
}

/**
 * 两人是否共享至少一个工作区或项目。
 *
 * **只看非组织级的作用域。** 同属一个组织不算「共享作用域」—— 若算，
 * `shared_scopes` 就等同于 `everyone`，那一档就白设了。
 *
 * 两边都要求 `active`：被移除的成员关系还留在表里（那是审计线索），
 * 拿它当共享依据的话，一个已经被踢出项目的人还能继续看到别人的在线状态。
 */
function sharesScope(
  db: DatabaseSync,
  organizationId: string,
  a: string,
  b: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit
         FROM memberships ma
         JOIN memberships mb
           ON ma.organization_id = mb.organization_id
          AND ma.scope_kind = mb.scope_kind
          AND ma.scope_id = mb.scope_id
        WHERE ma.organization_id = ?
          AND ma.account_id = ?
          AND mb.account_id = ?
          AND ma.scope_kind <> 'organization'
          AND ma.state = 'active'
          AND mb.state = 'active'
        LIMIT 1`,
    )
    .get(organizationId, a, b) as { hit: number } | undefined
  return row !== undefined
}
