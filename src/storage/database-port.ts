/**
 * 路由层看到的数据库接口。
 *
 * 在 dsh-chat 插件仓库里，这个位置是 `ChatDatabaseService`（一个 Cordis
 * `Service`）—— 那是插件运行时的形态。relay 是**普通 Node 进程，不是 Cordis
 * 插件**，把 Cordis 拖进来只为了拿一个类型没有道理。
 *
 * 所以这里只声明路由真正用到的两件事。`ChatDatabase` 天然满足它，
 * 插件那边的 `ChatDatabaseService` 也满足 —— 这不是巧合，两边的路由代码是
 * 同一份，接口收窄到共同子集才让它能同时跑在两种宿主里。
 */

import type { ChatDatabase } from './database.js'

export interface ChatDatabasePort {
  /** 在一个事务中执行；领域写入、outbox 与审计必须共用同一事务（§26）。 */
  transaction<T>(body: (db: Parameters<ChatDatabase['transaction']>[0] extends (
    db: infer D,
  ) => unknown
    ? D
    : never) => T): T
  readonly readonlyHandle: ChatDatabase['readonlyHandle']
}

/** 便于路由层引用同一个名字，减少两仓之间的 diff。 */
export type ChatDatabaseService = ChatDatabasePort
