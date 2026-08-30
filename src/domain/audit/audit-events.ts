/**
 * 审计事件。
 *
 * §37 给出了完整的字段清单，§43 第 14 步给出了两条验收条件：
 *
 * > 上述每一步在审计表中都有对应事件，且**被拒绝的越权尝试同样留下记录**；
 * > **审计表中不含任何消息正文**。
 *
 * §44.1.2 还有一条更强的要求：**审计写入失败导致整个命令失败**。
 * 这决定了本模块的接口形态 —— 写审计的函数不吞异常、不返回「失败但继续」，
 * 它必须在调用方的事务内抛出，让整个命令回滚。
 */

import type { DatabaseSync } from 'node:sqlite'

// 结构定义在契约包 —— §37：「`AuditEvent` 的结构属于 `@dsh-chat/contract`，
// 不由各插件自行定义」。本模块只负责**写入实现**（SQL、序列号分配），
// 那是副作用，按 §48 不能进契约包。
import type { AuditEvent, AuditEventInput, AuditOutcome } from '../../contract/index.js'

// 为既有调用方保留从本包导入的路径，避免一次结构搬迁牵动所有领域插件
export { AUDIT_OUTCOMES } from '../../contract/index.js'
export type { AuditEvent, AuditEventInput, AuditOutcome } from '../../contract/index.js'

/**
 * 写入一条审计事件。
 *
 * **必须在调用方的事务内执行**，且**不捕获异常** —— §44.1.2 要求审计写入失败
 * 导致整个命令失败。如果这里吞掉异常，就会出现「操作成功但没有审计记录」的状态，
 * 而那正是审计要防的事。
 *
 * 服务端序列号在同一事务内分配并单调递增，用于检测缺口。
 */
export function recordAuditEvent(db: DatabaseSync, input: AuditEventInput): number {
  const nextSeq = allocateServerSeq(db, input.organizationId)

  db.prepare(
    `INSERT INTO audit_events
       (audit_event_id, organization_id, event_type, occurred_at, server_seq,
        actor_account_id, device_id, source_ip_prefix, coarse_region,
        target_ref, outcome, error_code, policy_revision, operation_id,
        related_event_id, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.auditEventId,
    input.organizationId,
    input.eventType,
    input.occurredAt.toISOString(),
    nextSeq,
    input.actorAccountId ?? null,
    input.deviceId ?? null,
    input.sourceIpPrefix ?? null,
    input.coarseRegion ?? null,
    input.targetRef,
    input.outcome,
    input.errorCode ?? null,
    input.policyRevision,
    input.operationId ?? null,
    input.relatedEventId ?? null,
    input.traceId ?? null,
  )

  return nextSeq
}

/**
 * 分配下一个服务端序列号。
 *
 * 用 `MAX(server_seq) + 1` 而不是自增列：序列必须**按组织分区**，
 * 而 SQLite 的 AUTOINCREMENT 是表级的。在同一事务内读写保证不产生重复。
 */
function allocateServerSeq(db: DatabaseSync, organizationId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(server_seq), 0) AS max_seq FROM audit_events WHERE organization_id = ?')
    .get(organizationId) as { max_seq: number }
  return row.max_seq + 1
}

/** 按组织读取审计事件，按序列升序。 */
export function auditEventsOf(
  db: DatabaseSync,
  organizationId: string,
  options: { readonly afterSeq?: number; readonly limit?: number } = {},
): readonly AuditEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM audit_events
        WHERE organization_id = ? AND server_seq > ?
        ORDER BY server_seq
        LIMIT ?`,
    )
    .all(organizationId, options.afterSeq ?? 0, options.limit ?? 100) as Array<
    Record<string, string | number | null>
  >

  return rows.map((row) => ({
    auditEventId: row['audit_event_id'] as string,
    organizationId: row['organization_id'] as string,
    eventType: row['event_type'] as string,
    occurredAt: row['occurred_at'] as string,
    serverSeq: row['server_seq'] as number,
    actorAccountId: (row['actor_account_id'] as string | null) ?? undefined,
    deviceId: (row['device_id'] as string | null) ?? undefined,
    sourceIpPrefix: (row['source_ip_prefix'] as string | null) ?? undefined,
    coarseRegion: (row['coarse_region'] as string | null) ?? undefined,
    targetRef: row['target_ref'] as string,
    outcome: row['outcome'] as AuditOutcome,
    errorCode: (row['error_code'] as string | null) ?? undefined,
    policyRevision: row['policy_revision'] as number,
    operationId: (row['operation_id'] as string | null) ?? undefined,
    relatedEventId: (row['related_event_id'] as string | null) ?? undefined,
    traceId: (row['trace_id'] as string | null) ?? undefined,
  }))
}

/**
 * 检测序列缺口。
 *
 * 仅追加存储的价值在于「删除会留下痕迹」。序列连续性是最基本的完整性检查：
 * 如果有人删了中间一条，这里会报出来。
 *
 * L2 起会加每日锚点、L3 起加逐条哈希链（§6.1 的能力矩阵），P0 先做序列连续性。
 */
export function findSequenceGaps(db: DatabaseSync, organizationId: string): readonly number[] {
  const rows = db
    .prepare(
      'SELECT server_seq FROM audit_events WHERE organization_id = ? ORDER BY server_seq',
    )
    .all(organizationId) as Array<{ server_seq: number }>

  const gaps: number[] = []
  let expected = 1
  for (const row of rows) {
    while (expected < row.server_seq) {
      gaps.push(expected)
      expected += 1
    }
    expected = row.server_seq + 1
  }
  return gaps
}
