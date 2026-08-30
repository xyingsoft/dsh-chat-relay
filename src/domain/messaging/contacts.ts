/**
 * 联系人与拉黑。
 *
 * 这是私聊的准入前置条件。§13 给出了整篇文档中少见的形式化表达：
 *
 * > 只有双方联系人关系已 `accepted`、且**不存在任一方向**的 `Block` 记录时，
 * > relay 才接收私聊消息。
 *
 * 两个容易写错的点：
 *
 * 1. **拉黑不是联系人状态**，而是有向记录 `Block(actorAccountId, subjectAccountId)`。
 *    双方可以分别拉黑或解除，互不影响。把它做成联系人状态的一个取值会丢失方向性。
 * 2. **删除联系人 ≠ 拉黑**。删除把关系置为 `removed` 且**不创建 `Block` 记录**，
 *    对方仍可再次发起请求。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { ContactRequestState } from '../../contract/index.js'

/**
 * 关系状态。
 *
 * §13 的联系人**请求**状态是 `pending`/`accepted`/`rejected`/`expired` 四个，
 * 但同一节的散文又说「删除联系人把**关系状态**置为 `removed`」—— 文档区分了
 * 请求状态与关系状态，却只给出了前者的完整枚举。
 *
 * 这里不把 `removed` 塞进被文档锁定的 `ContactRequestState`，而是单列一个联合类型。
 * 完整的关系状态枚举是一处应当补齐的文档缺口。
 */
export type ContactRelationshipState = ContactRequestState | 'removed'

export interface ContactRequest {
  readonly requestId: string
  readonly organizationId: string
  readonly requesterId: string
  readonly targetId: string
  readonly state: ContactRelationshipState
  readonly createdAt: string
  readonly updatedAt: string
  readonly expiresAt: string
}

/** 私聊准入判定的结果。 */
export type ContactGate =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      /**
       * §13 明确：同一目标重发受速率限制，**且被拉黑时不提示差异**。
       * 因此「未建立联系人」与「被对方拉黑」返回同一个错误码，
       * 具体原因只作为服务端诊断。
       */
      readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN'
      readonly diagnostic: 'no_accepted_contact' | 'blocked_by_target' | 'blocked_target'
    }

const DEFAULT_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function createContactRequest(
  db: DatabaseSync,
  input: {
    requestId: string
    organizationId: string
    requesterId: string
    targetId: string
    now: Date
    /** 有效期属版本化组织配置；默认 30 天来自 §13，实现从配置读取而非硬编码。 */
    ttlMs?: number
  },
): ContactRequest {
  const iso = input.now.toISOString()
  const ttl = input.ttlMs ?? DEFAULT_REQUEST_TTL_MS
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString()

  db.prepare(
    `INSERT INTO contact_requests
       (request_id, organization_id, requester_id, target_id, state, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    input.requestId,
    input.organizationId,
    input.requesterId,
    input.targetId,
    iso,
    iso,
    expiresAt,
  )
  return findContactRequest(db, input.requestId)!
}

/** 接受请求：`pending → accepted`。已过期的请求不能被接受。 */
export function acceptContactRequest(
  db: DatabaseSync,
  input: { requestId: string; now: Date },
): boolean {
  const iso = input.now.toISOString()
  const result = db
    .prepare(
      `UPDATE contact_requests
          SET state = 'accepted', updated_at = ?
        WHERE request_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .run(iso, input.requestId, iso)
  return result.changes === 1
}

export function rejectContactRequest(
  db: DatabaseSync,
  input: { requestId: string; now: Date },
): boolean {
  const result = db
    .prepare(
      `UPDATE contact_requests SET state = 'rejected', updated_at = ?
        WHERE request_id = ? AND state = 'pending'`,
    )
    .run(input.now.toISOString(), input.requestId)
  return result.changes === 1
}

/**
 * 删除联系人。
 *
 * §13：置为 `removed`，**不创建 `Block` 记录**，对方可再次发起请求。
 * 也不删除已投递的历史消息 —— 那属于保留策略的范畴，不是联系人操作的副作用。
 */
export function removeContact(
  db: DatabaseSync,
  input: { organizationId: string; accountA: string; accountB: string; now: Date },
): void {
  db.prepare(
    `UPDATE contact_requests
        SET state = 'removed', updated_at = ?
      WHERE organization_id = ?
        AND state = 'accepted'
        AND ((requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?))`,
  ).run(
    input.now.toISOString(),
    input.organizationId,
    input.accountA,
    input.accountB,
    input.accountB,
    input.accountA,
  )
}

export function findContactRequest(db: DatabaseSync, requestId: string): ContactRequest | undefined {
  const row = db.prepare('SELECT * FROM contact_requests WHERE request_id = ?').get(requestId) as
    | Record<string, string>
    | undefined
  if (!row) return undefined
  return {
    requestId: row['request_id']!,
    organizationId: row['organization_id']!,
    requesterId: row['requester_id']!,
    targetId: row['target_id']!,
    state: row['state'] as ContactRelationshipState,
    createdAt: row['created_at']!,
    updatedAt: row['updated_at']!,
    expiresAt: row['expires_at']!,
  }
}

/** 拉黑：有向记录。重复拉黑是幂等的。 */
export function block(
  db: DatabaseSync,
  input: { organizationId: string; actorId: string; subjectId: string; now: Date },
): void {
  db.prepare(
    `INSERT INTO blocks (organization_id, actor_account_id, subject_account_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(input.organizationId, input.actorId, input.subjectId, input.now.toISOString())
}

export function unblock(
  db: DatabaseSync,
  input: { organizationId: string; actorId: string; subjectId: string },
): void {
  db.prepare(
    `DELETE FROM blocks
      WHERE organization_id = ? AND actor_account_id = ? AND subject_account_id = ?`,
  ).run(input.organizationId, input.actorId, input.subjectId)
}

function isBlocked(
  db: DatabaseSync,
  organizationId: string,
  actorId: string,
  subjectId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM blocks
        WHERE organization_id = ? AND actor_account_id = ? AND subject_account_id = ?`,
    )
    .get(organizationId, actorId, subjectId)
  return row !== undefined
}

function hasAcceptedContact(
  db: DatabaseSync,
  organizationId: string,
  a: string,
  b: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM contact_requests
        WHERE organization_id = ? AND state = 'accepted'
          AND ((requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?))`,
    )
    .get(organizationId, a, b, b, a)
  return row !== undefined
}

/**
 * 私聊准入判定，直接对应 §13 的表达式：
 *
 * ```
 * contactAccepted(a,b) && !Block(a,b) && !Block(b,a)
 * ```
 *
 * 注意**两个方向都要检查** —— 只检查「对方是否拉黑了我」会让被我拉黑的人
 * 仍能给我发消息。
 */
export function checkDirectMessageGate(
  db: DatabaseSync,
  input: { organizationId: string; senderId: string; recipientId: string },
): ContactGate {
  const { organizationId, senderId, recipientId } = input

  if (!hasAcceptedContact(db, organizationId, senderId, recipientId)) {
    return {
      allowed: false,
      errorCode: 'NOT_FOUND_OR_FORBIDDEN',
      diagnostic: 'no_accepted_contact',
    }
  }
  if (isBlocked(db, organizationId, recipientId, senderId)) {
    return { allowed: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN', diagnostic: 'blocked_by_target' }
  }
  if (isBlocked(db, organizationId, senderId, recipientId)) {
    return { allowed: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN', diagnostic: 'blocked_target' }
  }
  return { allowed: true }
}
