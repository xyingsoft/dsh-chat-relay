/**
 * host 的本地数据库服务。
 *
 * §4 规定 host 持有「本地 SQLite 缓存」，是浏览器访问组织与 relay 的唯一入口。
 * §29 要求 P0 的 host 与 relay **都必须使用事务型数据库** ——「反复重写的
 * `state.json` 不足以保证消息队列、去重和附件元数据的一致性」。
 *
 * 用 Node 内置的 `node:sqlite`：无 native 编译、无预编译包分发问题，对一个要被
 * 装进别人 DSH 的插件而言，少一个 node-gyp 依赖就少一类安装失败。
 */

import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS, type Migration } from './migrations.js'

export interface DatabaseOptions {
  /** 数据库文件路径；`:memory:` 用于测试。 */
  readonly location: string
}

/**
 * 迁移记录表本身也要先建出来。
 * 它记录每次迁移的版本、名称与应用时间，用于判断从哪一版继续。
 */
const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`

export class ChatDatabase {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** 打开数据库并把 schema 迁移到最新版本。 */
  static open(options: DatabaseOptions): ChatDatabase {
    const db = new DatabaseSync(options.location)

    // 外键约束默认关闭，必须显式开启，否则 REFERENCES 只是注释
    db.exec('PRAGMA foreign_keys = ON')
    // WAL 让读不阻塞写；:memory: 不支持，忽略失败
    try {
      db.exec('PRAGMA journal_mode = WAL')
    } catch {
      // 内存库不支持 WAL，按默认模式继续
    }

    db.exec(MIGRATION_TABLE)

    const instance = new ChatDatabase(db)
    instance.#migrate()
    return instance
  }

  /**
   * 应用尚未执行的迁移。
   *
   * §29.1 要求版本单调递增。这里额外断言 `MIGRATIONS` 自身有序且无重复 ——
   * 一个写错版本号的迁移会让后续所有部署的行为取决于它们各自停在哪一版，
   * 是最难排查的一类问题。
   */
  #migrate(): void {
    for (let index = 1; index < MIGRATIONS.length; index += 1) {
      const previous = MIGRATIONS[index - 1]!
      const current = MIGRATIONS[index]!
      if (current.version <= previous.version) {
        throw new Error(
          `迁移版本必须单调递增：${previous.name}(v${previous.version}) 之后是 ` +
            `${current.name}(v${current.version})`,
        )
      }
    }

    const appliedRows = this.#db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number
    }>
    const applied = new Set(appliedRows.map((row) => row.version))

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.#applyMigration(migration)
    }
  }

  /** 单个迁移在一个事务内完成：要么整体生效，要么完全不生效。 */
  #applyMigration(migration: Migration): void {
    this.#db.exec('BEGIN')
    try {
      for (const statement of migration.statements) {
        this.#db.exec(statement)
      }
      this.#db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw new Error(`迁移 ${migration.name}(v${migration.version}) 失败：${String(error)}`, {
        cause: error,
      })
    }
  }

  /** 当前 schema 版本；空库为 0。 */
  get schemaVersion(): number {
    const row = this.#db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined
    return row?.version ?? 0
  }

  /**
   * 在一个事务中执行 `body`。
   *
   * §26 规定的写入路径是「认证 → 授权 → 版本检查 → **同一数据库事务写入领域对象和
   * outbox** → 提交后异步投递」，且「请求在事务提交前失败时返回错误，且不产生任何
   * 可见领域状态」。因此领域写入与 outbox、审计必须共用同一个事务边界。
   *
   * 不支持嵌套调用 —— SQLite 的 `BEGIN` 不可重入，嵌套会静默提交外层事务。
   */
  transaction<T>(body: (db: DatabaseSync) => T): T {
    this.#db.exec('BEGIN')
    try {
      const result = body(this.#db)
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** 只读访问。写操作请走 `transaction`，以免绕过同事务约束。 */
  get readonlyHandle(): DatabaseSync {
    return this.#db
  }

  close(): void {
    this.#db.close()
  }
}
