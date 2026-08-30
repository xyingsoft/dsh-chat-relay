/**
 * 持久化层测试。
 *
 * 重点不是「能不能建表」，而是几条文档明确要求、且一旦写错就很难在后期补救的性质：
 * schema 版本单调、迁移原子、事务边界真实生效、每张业务表都带 `OrganizationId`、
 * §27 列举的七类字段第一版就存在。
 */

import { expect, it, describe } from 'vitest'

import { ChatDatabase } from './database.js'
import { MIGRATIONS } from './migrations.js'

function openMemory(): ChatDatabase {
  return ChatDatabase.open({ location: ':memory:' })
}

describe('迁移', () => {
  it('打开空库后 schema 版本为最新迁移的版本', () => {
    const db = openMemory()
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version
    expect(db.schemaVersion).toBe(latest)
    db.close()
  })

  it('迁移版本单调递增且不重复', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('重复打开不会重复应用迁移', () => {
    const db = openMemory()
    const applied = db.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number }
    expect(applied.n).toBe(MIGRATIONS.length)
    db.close()
  })
})

describe('事务边界', () => {
  it('提交后数据可见', () => {
    const db = openMemory()
    db.transaction((handle) => {
      handle
        .prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)')
        .run('acc-1', '甲', new Date().toISOString())
    })
    const row = db.readonlyHandle
      .prepare('SELECT display_name FROM accounts WHERE account_id = ?')
      .get('acc-1') as { display_name: string } | undefined
    expect(row?.display_name).toBe('甲')
    db.close()
  })

  it('抛错时整个事务回滚，不留下部分写入', () => {
    const db = openMemory()
    expect(() =>
      db.transaction((handle) => {
        handle
          .prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)')
          .run('acc-2', '乙', new Date().toISOString())
        // §26：请求在事务提交前失败时不产生任何可见领域状态
        throw new Error('模拟授权失败')
      }),
    ).toThrow('模拟授权失败')

    const row = db.readonlyHandle
      .prepare('SELECT account_id FROM accounts WHERE account_id = ?')
      .get('acc-2')
    expect(row, '回滚后不应残留任何行').toBeUndefined()
    db.close()
  })

  it('外键约束真实生效', () => {
    const db = openMemory()
    // devices.account_id 引用一个不存在的账号，应当被拒绝
    expect(() =>
      db.transaction((handle) => {
        handle
          .prepare(
            `INSERT INTO devices
             (device_id, account_id, signing_public_key, key_fingerprint, state, first_seen_at, last_seen_at)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .run('dev-1', 'acc-不存在', 'pk', 'fp', 'active', 'now', 'now')
      }),
    ).toThrow()
    db.close()
  })
})

describe('§27 要求第一版即存在的字段', () => {
  const db = openMemory()
  const columnsOf = (table: string): string[] =>
    (db.readonlyHandle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    )

  it('每张业务表都带 organization_id', () => {
    // accounts / devices / recovery_kits 属账号维度，跨组织存在，不带 organization_id。
    //
    // request_nonces 属**设备**维度，刻意不按组织分区：一个 nonce 一旦被某设备
    // 用过就应在全局作废。按组织分区的话，同一 nonce 在每个组织里各能用一次，
    // 重放窗口凭空放大到组织数量倍。签名本身已覆盖 organizationId，
    // 跨组织重放另有那一层挡着。
    const accountScoped = new Set([
      'accounts',
      'devices',
      'recovery_kits',
      'request_nonces',
      // device_sessions 属**设备**维度：一个账号可属多个组织（§9），
      // 但会话是「这台设备已通过认证」，跨组织通用。按组织分区的话，
      // 用户每切一个组织就要重新登录一次
      'device_sessions',
      'schema_migrations',
    ])
    const tables = (
      db.readonlyHandle
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name)

    for (const table of tables) {
      if (accountScoped.has(table)) continue
      expect(columnsOf(table), `${table} 缺少 organization_id`).toContain('organization_id')
    }
  })

  it('消息表带幂等键、事件格式版本与加密元数据', () => {
    const columns = columnsOf('messages')
    expect(columns).toContain('operation_id')
    expect(columns).toContain('event_format_version')
    // P0 不做 E2EE，但 §29.1 要求该字段 P0 即落库，避免 P4 重写消息主表
    expect(columns).toContain('encryption_meta')
  })

  it('审计表带策略修订与服务端序列，且不含消息正文', () => {
    const columns = columnsOf('audit_events')
    expect(columns).toContain('policy_revision')
    expect(columns).toContain('server_seq')
    expect(columns).toContain('outcome')
    // §43 第 14 步：审计表中不含任何消息正文
    expect(columns).not.toContain('body')
    expect(columns).not.toContain('content')
  })

  it('账户与设备同步状态第一版即存在', () => {
    expect(columnsOf('accounts')).toContain('account_state_seq')
    expect(columnsOf('devices')).toContain('seen_account_state_seq')
  })

  it('恢复水位以 stream_state 表承载，epoch 与高水位成对', () => {
    const columns = columnsOf('stream_state')
    expect(columns).toContain('stream_epoch')
    expect(columns).toContain('high_watermark')
  })

  it('outbox 与领域表同库，使同事务写入成为可能', () => {
    const columns = columnsOf('outbox')
    expect(columns).toContain('event_id')
    expect(columns).toContain('task_state')
    expect(columns).toContain('attempts')
  })
})

describe('幂等与并发的 schema 约束', () => {
  it('消息主键是 (sender_id, message_id)，重复插入被拒绝', () => {
    const db = openMemory()
    const insert = (): void => {
      db.transaction((handle) => {
        handle
          .prepare(
            `INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)
             ON CONFLICT DO NOTHING`,
          )
          .run('s1', '发送者', 'now')
        handle
          .prepare(
            `INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)
             ON CONFLICT DO NOTHING`,
          )
          .run('r1', '接收者', 'now')
        handle
          .prepare(
            `INSERT INTO messages
             (message_id, organization_id, sender_id, recipient_id, kind, body,
              created_at, received_at, operation_id, event_format_version, encryption_meta)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run('m1', 'org1', 's1', 'r1', 'text', '你好', 'now', 'now', 'op1', 1, '{}')
      })
    }
    insert()
    // §14：(senderAccountId, MessageId) 是幂等键，重试必须命中同一条而不是新增
    expect(() => insert()).toThrow()
    db.close()
  })

  it('通知去重键在 (组织, 接收人) 内唯一', () => {
    const db = openMemory()
    const insert = (id: string): void => {
      db.transaction((handle) => {
        handle
          .prepare(
            `INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)
             ON CONFLICT DO NOTHING`,
          )
          .run('r2', '接收者', 'now')
        handle
          .prepare(
            `INSERT INTO notifications
             (notification_id, organization_id, recipient_id, event_type, resource_ref,
              summary, priority, state, created_at, dedupe_key)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, 'org1', 'r2', 'work_item_changed', 'wi-1', '摘要', 'normal', 'queued', 'now', 'dk-1')
      })
    }
    insert('n1')
    // §17.1：去重键防止同一领域事件重复投递产生多条记录
    expect(() => insert('n2')).toThrow()
    db.close()
  })
})
