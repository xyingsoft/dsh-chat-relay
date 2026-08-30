/**
 * relay 的启动入口。
 *
 * 配置全部走环境变量 —— 部署里不留配置文件，凭证就不会被误提交。
 *
 * 必填：
 *   DSH_CHAT_RELAY_SECRET   共享密钥。**不配则拒绝启动**（见下）
 *   DSH_CHAT_RELAY_DB       SQLite 文件路径
 * 选填：
 *   DSH_CHAT_RELAY_HOST     监听地址，默认 127.0.0.1
 *   DSH_CHAT_RELAY_PORT     监听端口，默认 8787
 *   DSH_CHAT_RELAY_ORIGIN   允许的 host 来源，用于跨源判定
 *   DSH_CHAT_RELAY_BOOTSTRAP_INVITE
 *                           首个账号的引导邀请码。**仅在库里一条真实账号都
 *                           没有时生效**，第一个人开完户就自动失效。见
 *                           bootstrap.ts 关于那个死锁的说明
 *   DSH_CHAT_RELAY_ALLOW_SHARED_SECRET_IDENTITY=1
 *                           允许持有共享密钥的一方声称任意账号。**默认关闭**，
 *                           开了会打警告。只给还没走注册流程的部署用
 */

import { bootstrapInvite } from './bootstrap.js'
import { ChatDatabase } from './storage/database.js'
import { startRelay } from './server.js'

const secret = process.env['DSH_CHAT_RELAY_SECRET']
const databasePath = process.env['DSH_CHAT_RELAY_DB']

// 不配密钥就拒绝启动，而不是「启动了但谁都连不上」。
// 后者会让运维看到一个健康的进程，却查不出为什么所有请求都是 401
if (secret === undefined || secret.length === 0) {
  process.stderr.write('DSH_CHAT_RELAY_SECRET 未设置。relay 拒绝以无认证方式启动。\n')
  process.exit(2)
}
if (databasePath === undefined || databasePath.length === 0) {
  process.stderr.write('DSH_CHAT_RELAY_DB 未设置。\n')
  process.exit(2)
}

// 默认只听 127.0.0.1。要对外提供服务必须显式设 HOST ——
// 默认监听 0.0.0.0 的服务是被扫到的第一批
const host = process.env['DSH_CHAT_RELAY_HOST'] ?? '127.0.0.1'
const port = Number(process.env['DSH_CHAT_RELAY_PORT'] ?? '8787')
// 允许 0：那是「让内核分配空闲端口」的标准写法，测试与容器部署都用它。
// 第一版把 0 当非法，结果端到端测试根本起不来 relay
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`DSH_CHAT_RELAY_PORT 不是合法端口：${String(process.env['DSH_CHAT_RELAY_PORT'])}\n`)
  process.exit(2)
}

// 引导要在 startRelay 之前跑完：relay 一起来就可能收到注册请求，
// 那时候码必须已经在库里了
const bootstrapCode = process.env['DSH_CHAT_RELAY_BOOTSTRAP_INVITE']
if (bootstrapCode !== undefined && bootstrapCode.length > 0) {
  const chat = ChatDatabase.open({ location: databasePath })
  const outcome = bootstrapInvite(chat, { code: bootstrapCode, now: new Date() })
  chat.close()
  // 不打码本身 —— 它就在设它的人手里，进日志只是多一个泄露点
  process.stdout.write(
    outcome.kind === 'issued'
      ? `引导邀请码已签发，组织 ${outcome.organizationId}，有效期至 ${outcome.expiresAt}
`
      : `引导邀请码未签发（${outcome.kind}）—— 这通常意味着已经有账号了，属正常。
`,
  )
}

const origin = process.env['DSH_CHAT_RELAY_ORIGIN']
const allowSharedSecretIdentity = process.env['DSH_CHAT_RELAY_ALLOW_SHARED_SECRET_IDENTITY'] === '1'
const relay = await startRelay({
  databasePath,
  host,
  port,
  sharedSecret: secret,
  allowSharedSecretIdentity,
  ...(origin === undefined ? {} : { expectedOrigin: origin }),
})

process.stdout.write(`dsh-chat-relay 已启动：http://${host}:${relay.port}\n`)

const shutdown = (signal: string): void => {
  process.stdout.write(`收到 ${signal}，正在关闭…\n`)
  void relay.close().then(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
