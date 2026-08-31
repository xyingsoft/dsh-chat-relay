/**
 * host 的同源命令路由。
 *
 * §4：浏览器只与 host 通信，走**同源** `/api/chat` 与 `/api/organization`；
 * host 是浏览器访问组织与 relay 的**唯一入口**。
 *
 * §26 规定了写入路径的固定顺序：
 *
 * > 认证 → 授权 → 版本检查 → **同一数据库事务写入领域对象和 outbox** → 提交后异步投递
 *
 * 本文件把这个顺序做成一条骨架，让每个命令处理器只填自己的那一段，而不是各自
 * 重写一遍顺序 —— 顺序写错是这类代码最常见也最难发现的缺陷。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ERROR_CATALOGUE, type ErrorCode } from '../contract/index.js'

/**
 * 请求守卫的判定。失败时直接给出完整响应。
 *
 * 之所以不复用 `CommandOutcome` 的错误码：`TIME_SKEW` 要按 §7.1 附带签名的
 * 服务器时间与允许窗口，而那两个字段不该混进所有错误都用的统一信封。
 */
export type CommandGuard = (
  request: IncomingMessage,
  rawBody: Buffer,
) => { readonly ok: true } | { readonly ok: false; readonly status: number; readonly body: unknown }

/** 命令的执行上下文。认证结果由调用方注入，本文件不做认证。 */
export interface CommandContext {
  readonly accountId: string
  readonly deviceId: string
  readonly organizationId: string
  /** 幂等键，由调用方生成并随请求携带（§26）。 */
  readonly operationId: string
}

export type CommandOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: ErrorCode; readonly retryAfterMs?: number }

/**
 * 把错误码映射为 HTTP 响应。
 *
 * 映射取自错误码目录而不是就地判断 —— §46 要求「新增错误码必须同时声明 HTTP
 * 映射、可重试性与幂等语义」，在这里再写一遍会产生第二个真相来源。
 *
 * 注意 `SANDBOX_QUOTA_EXCEEDED` 与 `ATTACHMENT_UNAVAILABLE` 映射为 **200**：
 * 它们是被正常返回的**领域状态**而非请求失败，调用方按状态机处理。
 */
export function httpStatusOf(code: ErrorCode): number {
  return ERROR_CATALOGUE[code].http
}

/** 统一的错误响应体。**不携带任何服务端诊断信息**（§26）。 */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode
    /** 可重试性由目录给出，客户端据此决定是否显示重试入口（§5）。 */
    readonly retryability: string
    /** 仅 `RATE_LIMITED` 携带；不泄露他人用量（§30.1）。 */
    readonly retryAfterMs?: number
  }
}

export function errorBody(code: ErrorCode, retryAfterMs?: number): ErrorBody {
  return {
    error: {
      code,
      retryability: ERROR_CATALOGUE[code].retryability,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 命令响应不缓存：版本号与幂等结果都依赖实时状态
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** 请求体大小上限。§30.1：请求体 1 MB（不含流式上传），边缘层拒绝超限。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 读取并解析 JSON 请求体。
 *
 * 超过上限时**在读完之前**就中断 —— 先读完再判断等于让攻击者决定内存占用。
 */
export async function readJsonBody(request: IncomingMessage): Promise<
  | { readonly ok: true; readonly value: unknown; readonly raw: Buffer }
  | { readonly ok: false; readonly errorCode: ErrorCode }
> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      request.destroy()
      return { ok: false, errorCode: 'RATE_LIMITED' }
    }
    chunks.push(buffer)
  }

  // 原始字节一并返回。§7.1 的签名覆盖请求体摘要，而摘要必须对**收到的字节**
  // 取 —— 对 JSON.parse 之后再 stringify 的结果取会因键序、空格、数字表示的
  // 差异而对不上，那种失配还极难定位
  const raw = Buffer.concat(chunks)
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')), raw }
  } catch {
    // schema 无效是终态错误，异步任务不得自动重试（§46）
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }
}

/**
 * 跨源写请求防护。
 *
 * §44.1.2 把「跨源浏览器写请求」列为必须覆盖的失败路径。host 提供的是**同源**
 * API，因此任何带 `Origin` 且与 host 自身不同源的写请求都应被拒绝。
 *
 * 这里用 `Origin` 而非 `Referer`：后者可被隐私设置剥离，把它当作判定依据会在
 * 用户开启隐私保护时误拒合法请求。
 */
export function isSameOriginWrite(
  request: IncomingMessage,
  expectedOrigin: string,
): boolean {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true

  const origin = request.headers.origin
  // 无 Origin 头的写请求来自非浏览器客户端（如 host 自身的工具），放行；
  // 浏览器发起的跨源请求一定带 Origin
  if (origin === undefined) return true
  return origin === expectedOrigin
}

/**
 * 命令处理器的统一包装。
 *
 * 固化 §26 的顺序：解析 → 跨源检查 → 交给业务处理器 → 统一序列化响应。
 * 业务处理器只关心自己那一段，拿到的是已校验的输入。
 */
export function commandHandler<T>(options: {
  readonly expectedOrigin: string
  readonly execute: (body: unknown, request: IncomingMessage) => Promise<CommandOutcome<T>>
  /**
   * 请求证明校验（§7.1）。在业务处理器之前跑，拿得到**原始请求体字节**。
   *
   * 放在这里而不是 `authenticate` 里，是因为签名覆盖请求体摘要，而
   * `authenticate` 只拿得到 `IncomingMessage` —— 那时候 body 还没读。
   *
   * 失败时守卫自己给出完整响应而不是一个错误码：`TIME_SKEW` 按 §7.1 要带
   * 服务器时间与允许窗口，那两个字段不属于统一错误信封。
   */
  readonly guard?: CommandGuard
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (!isSameOriginWrite(request, options.expectedOrigin)) {
      writeJson(response, httpStatusOf('FORBIDDEN'), errorBody('FORBIDDEN'))
      return
    }

    const body = await readJsonBody(request)
    if (!body.ok) {
      writeJson(response, httpStatusOf(body.errorCode), errorBody(body.errorCode))
      return
    }

    if (options.guard !== undefined) {
      const verdict = options.guard(request, body.raw)
      if (!verdict.ok) {
        writeJson(response, verdict.status, verdict.body)
        return
      }
    }

    let outcome: CommandOutcome<T>
    try {
      outcome = await options.execute(body.value, request)
    } catch (error) {
      // 未预期的异常不能泄露内部细节（§26：用户错误码不得泄露存在性）；
      // 诊断信息只进服务端日志
      console.error('命令执行失败', error)
      writeJson(response, 500, { error: { code: 'INTERNAL', retryability: 'retryable' } })
      return
    }

    if (outcome.ok) {
      writeJson(response, 200, { data: outcome.value })
      return
    }
    writeJson(
      response,
      httpStatusOf(outcome.errorCode),
      errorBody(outcome.errorCode, outcome.retryAfterMs),
    )
  }
}
