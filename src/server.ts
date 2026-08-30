/**
 * relay 服务进程。
 *
 * §4 的三层划分里，relay 是**共享状态的持有者**：队列、成员关系、工作项、通知、
 * 审计都在它这边。host 跑在用户本机、持有本地缓存，通过 HTTP 与 relay 通信；
 * 浏览器**不直接与 relay 通信**。
 *
 * ## 与 dsh-chat 插件仓库的关系
 *
 * 协议定义（`src/contract/`）是从 `xyingsoft/dsh-chat` **vendored 过来的副本**，
 * 由 `scripts/verify-contract.mjs` 校验未被就地修改。两侧独立升级、靠 §41 的
 * 协议版本协商对接 —— 那正是文档为 host↔relay 设计协商、却没有为 client↔host
 * 设计的原因。
 *
 * 长期应当把 contract 发布成包，两边都消费发布物。当前受限于凭证（缺
 * `write:packages`），先用 vendored 副本加校验，机制与 dsh-chat 仓库里 vendored
 * DSH 运行时的那一套一致。
 *
 * ## 认证
 *
 * 正路是**设备会话 token**：`/api/identity/register` 用邀请码开户并签发一对
 * token，`authenticateFrom` 从会话查出账号与设备，调用方说了不算。
 *
 * §7.1 的**请求签名**校验实现在 `domain/identity/request-signing.ts`，但本进程
 * 尚未把它挂进请求路径 —— token 证明「持有者曾通过认证」，签名才证明「这次请求
 * 确实来自那台设备」，两者是叠加关系。缺口登记在 README 的「安全边界」，
 * 不靠读代码才能发现。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import { resolveSession } from './domain/identity/sessions.js'
import { ChatDatabase } from './storage/database.js'
import {
  refreshSessionHandler,
  registerAccountHandler,
  signOutHandler,
  type IdentityCommandDeps,
} from './http/identity-commands.js'
import {
  ackMessagesHandler,
  conversationsHandler,
  editMessageHandler,
  messageHistoryHandler,
  pullMessagesHandler,
  revokeMessageHandler,
  sendMessageHandler,
  type MessageCommandDeps,
  type Principal,
} from './http/message-commands.js'
import {
  acceptMembershipHandler,
  createOrganizationHandler,
  createProjectHandler,
  createWorkspaceHandler,
  inviteMemberHandler,
  myMembershipsHandler,
  type OrganizationCommandDeps,
} from './http/organization-commands.js'
import {
  addDependencyHandler,
  assignWorkItemHandler,
  createWorkItemHandler,
  inboxHandler,
  type WorkspaceCommandDeps,
} from './http/workspace-commands.js'

/**
 * 本 relay 的协议能力声明（§41）。
 *
 * `minimumVersion` 与兼容窗口是**部署决策**而不是协议规则 —— 文档说窗口是
 * 「两个次要版本或 90 天中的较长者」，怎么换算成一个数字由部署方定，所以
 * 可以从 options 覆盖。
 */
const DEFAULT_CAPABILITY = {
  currentVersion: 1,
  minimumVersion: 1,
  eventFormatVersions: {
    message_accepted: 1,
    notification_created: 1,
    work_item_changed: 1,
  },
} as const

export interface RelayOptions {
  readonly databasePath: string
  readonly host?: string
  readonly port?: number
  /**
   * 部署期共享密钥。host 以 `authorization: Bearer <token>` 携带。
   *
   * **不配就全部拒绝** —— 一个没配密钥的 relay 应当谁都连不上，而不是谁都能连。
   */
  readonly sharedSecret?: string
  /** 允许的 host 来源，用于跨源判定。 */
  readonly expectedOrigin?: string
  /**
   * 允许用共享密钥直接声称身份。**默认关闭。**
   *
   * 开启后任何持有密钥的一方都能声称自己是任意账号 —— 那不是认证，是接入
   * 控制。仅供还没走注册流程的部署临时使用，开启时启动会打警告。
   */
  readonly allowSharedSecretIdentity?: boolean
  /** 覆盖协议能力声明。不给则用 DEFAULT_CAPABILITY。 */
  readonly capability?: {
    readonly currentVersion: number
    readonly minimumVersion: number
    readonly eventFormatVersions: Readonly<Record<string, number>>
    readonly deprecationDeadline?: string
  }
}

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void

/** 定长比较，避免按前缀长度泄露密钥。 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 从请求解析调用者。
 *
 * 两条路径，**按强度优先**：
 *
 * 1. **设备会话 token**（`authorization: Bearer <access token>`）。账号与设备
 *    由服务端从会话查出来，调用方说了不算。这是正路。
 * 2. **部署期共享密钥**，仅当显式开启 `allowSharedSecretIdentity` 时可用。
 *    它只证明「这是一台被授权接入的 host」，账号由请求头声明 —— 也就是说
 *    **任何持有密钥的一方都可以声称自己是任意账号**。
 *
 * 第 2 条默认关闭。它存在只是为了让还没走注册流程的部署能先跑起来，
 * 开启时启动日志会打一行警告 —— 一个看起来像认证、实际只是共享密钥的东西，
 * 比一个明说自己是共享密钥的东西危险得多。
 *
 * 组织仍由请求头声明：一个账号可属多个组织（§9），当前操作在哪个组织下是
 * 调用方的选择。授权判定会再查该账号在那个组织的成员关系，声称一个不属于
 * 自己的组织拿不到任何东西。
 */
function authenticateFrom(
  options: RelayOptions,
  chat: ChatDatabase,
): (request: IncomingMessage) => Principal | undefined {
  const secret = options.sharedSecret

  return (request) => {
    const header = request.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const presented = header.slice('Bearer '.length)

    const organizationId = request.headers['x-dsh-organization']
    if (typeof organizationId !== 'string' || organizationId.length === 0) return undefined

    // 先试会话 token
    const session = chat.transaction((db) => resolveSession(db, presented, new Date()))
    if (session.ok) {
      return {
        accountId: session.value.accountId,
        deviceId: session.value.deviceId,
        organizationId,
      }
    }

    // 再回落共享密钥 —— 仅在显式开启时
    if (options.allowSharedSecretIdentity !== true) return undefined
    if (secret === undefined || secret.length === 0) return undefined
    if (!secretMatches(presented, secret)) return undefined

    const accountId = request.headers['x-dsh-account']
    const deviceId = request.headers['x-dsh-device']
    if (typeof accountId !== 'string' || accountId.length === 0) return undefined

    return {
      accountId,
      organizationId,
      deviceId: typeof deviceId === 'string' ? deviceId : 'unknown-device',
    }
  }
}

export interface RunningRelay {
  readonly port: number
  close(): Promise<void>
}

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const chat = ChatDatabase.open({ location: options.databasePath })
  const authenticate = authenticateFrom(options, chat)
  if (options.allowSharedSecretIdentity === true) {
    process.stderr.write(
      'dsh-chat-relay: 已开启 allowSharedSecretIdentity —— ' +
        '任何持有共享密钥的一方都能声称自己是任意账号。仅供尚未走注册流程的部署临时使用。\n',
    )
  }
  const now = (): Date => new Date()
  let idCounter = 0
  const newId = (prefix: string): string => `${prefix}-${Date.now()}-${(idCounter += 1)}`

  const database = {
    transaction: chat.transaction.bind(chat),
    readonlyHandle: chat.readonlyHandle,
  } as MessageCommandDeps['database']

  const expectedOrigin = options.expectedOrigin ?? ''
  const messageDeps: MessageCommandDeps = {
    database,
    expectedOrigin,
    authenticate,
    queueCapacity: 1000,
    leaseMs: 60_000,
    now,
  }
  const shared = { database, expectedOrigin, authenticate, now, newId }
  const identityDeps: IdentityCommandDeps = { database, expectedOrigin, authenticate, now, newId }
  const workspaceDeps: WorkspaceCommandDeps = shared
  const organizationDeps: OrganizationCommandDeps = shared

  const routes: Readonly<Record<string, RouteHandler>> = {
    '/api/chat/messages': sendMessageHandler(messageDeps),
    '/api/chat/messages/pull': pullMessagesHandler(messageDeps),
    '/api/chat/messages/ack': ackMessagesHandler(messageDeps),
    '/api/chat/messages/edit': editMessageHandler(messageDeps),
    '/api/chat/messages/revoke': revokeMessageHandler(messageDeps),
    '/api/chat/messages/history': messageHistoryHandler(messageDeps),
    '/api/chat/conversations': conversationsHandler(messageDeps),
    '/api/chat/work-items': createWorkItemHandler(workspaceDeps),
    '/api/chat/work-items/assign': assignWorkItemHandler(workspaceDeps),
    '/api/chat/work-items/dependencies': addDependencyHandler(workspaceDeps),
    '/api/chat/notifications': inboxHandler(workspaceDeps),
    '/api/organization': createOrganizationHandler(organizationDeps),
    '/api/organization/workspaces': createWorkspaceHandler(organizationDeps),
    '/api/organization/projects': createProjectHandler(organizationDeps),
    '/api/organization/members/invite': inviteMemberHandler(organizationDeps),
    '/api/organization/members/accept': acceptMembershipHandler(organizationDeps),
    '/api/organization/members/me': myMembershipsHandler(organizationDeps),
    // 身份：注册与刷新**不要求已有会话**，那正是它们存在的原因
    '/api/identity/register': registerAccountHandler(identityDeps),
    '/api/identity/session/refresh': refreshSessionHandler(identityDeps),
    '/api/identity/session/sign-out': signOutHandler(identityDeps),
  }

  const capability = options.capability ?? DEFAULT_CAPABILITY

  const server = createServer((request, response) => {
    // 协议协商在认证之前。§41 要求「host 在建立设备会话时提交自身协议版本」——
    // 会话还没建立，此时要求认证是先有鸡还是先有蛋。
    //
    // 这里只暴露版本号与事件格式，不含任何组织数据，所以未认证可读是安全的；
    // 反过来说，把它挡在认证之后会让版本过旧的 host 拿到 401 而不是
    // PROTOCOL_VERSION_UNSUPPORTED —— 那正是 §41 禁止的「混同为认证失败」
    if (request.url === '/protocol/negotiate') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ data: capability }))
      return
    }

    // 健康检查不需要认证 —— 部署探针拿不到共享密钥，而它只暴露「进程活着」
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ status: 'ok', service: 'dsh-chat-relay' }))
      return
    }

    const path = (request.url ?? '').split('?')[0] ?? ''
    const handler = routes[path]
    if (handler === undefined) {
      // 不泄露哪些路径存在：未知路径与无权限路径返回同一个形状（§46）
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND_OR_FORBIDDEN' } }))
      return
    }
    handler(request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 8787)

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // 先关服务再关库。反过来的话，正在处理中的请求会拿到一个已关闭的句柄
      chat.close()
    },
  }
}

export { ChatDatabase } from './storage/database.js'
export type { Principal } from './http/message-commands.js'
