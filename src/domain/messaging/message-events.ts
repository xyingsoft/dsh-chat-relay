/**
 * 消息编辑与撤回。
 *
 * [§14.1](../../../../docs/01-requirements/02-collaboration-requirements.md#141-消息编辑与撤回)：
 *
 * > **消息正文不是可原地覆盖的字段。** 每个 `MessageId` 具有单调递增的
 * > `MessageRevision`，初始正文为 revision 1；编辑追加不可变 `message_edited`
 * > 事件，撤回追加 `message_revoked` tombstone 事件。
 * >
 * > 编辑事件包含 `MessageId`、目标 revision、编辑者、编辑时间、策略版本和新内容
 * > 摘要；只有原发送者在组织配置的编辑窗口内，且消息未被撤回、未触发保留冻结时
 * > 可以编辑。接收方和 host **只接受比本地 revision 更高的事件**，因此重复投递或
 * > 乱序同步不会把新正文覆盖为旧正文。
 * >
 * > 撤回由原发送者或具备合规权限的管理员发起。……本地把正文替换为撤回占位并保留
 * > 最小审计元数据。
 *
 * ## 为什么撤回也占一个 revision
 *
 * 文档没有明说。但若撤回不占 revision，一条「撤回」与一条「迟到的编辑」就无法
 * 按同一把尺子比较 —— 而乱序同步正是 §14.1 要处理的情形。给撤回也分配 revision
 * 后，「只接受更高 revision」这一条规则同时覆盖两种事件，不需要为撤回单开一套
 * 优先级判断。
 *
 * ## 没有实现的：保留冻结
 *
 * §14.1 说「未触发保留冻结时」可以编辑。保留冻结（legal hold）在 §38 定义，
 * 属 P0-b 之后。这里**不发明**一个冻结判定 —— 假装检查过一个不存在的条件，
 * 比明确地没有这个检查更糟。
 */

import type { DatabaseSync } from 'node:sqlite'

/** §14.1 的两种事件。 */
export const MESSAGE_EVENT_TYPES = ['message_edited', 'message_revoked'] as const
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number]

/** 撤回后界面展示的占位。正文不再可得，但消息本身仍在时间线上。 */
export const REVOKED_PLACEHOLDER = '[已撤回]'

export interface MessageEvent {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
  readonly revision: number
  readonly eventType: MessageEventType
  readonly actorId: string
  readonly occurredAt: string
  /** 编辑事件的新正文；撤回事件为 `undefined` —— tombstone 不带内容。 */
  readonly body: string | undefined
  readonly policyRevision: number
  readonly operationId: string
}

/** 一条消息在应用完所有事件后的样子。 */
export interface MessageView {
  readonly messageId: string
  readonly senderId: string
  readonly revision: number
  /** 已撤回时为 `undefined`。调用方应展示 `REVOKED_PLACEHOLDER`。 */
  readonly body: string | undefined
  readonly revoked: boolean
  /** revision > 1 且未撤回时为真。§14.1：引用要标记原消息已编辑。 */
  readonly edited: boolean
}

export type EditFailure =
  | 'NOT_FOUND_OR_FORBIDDEN'
  /** 目标 revision 不高于当前。§14.1：只接受比本地 revision 更高的事件。 */
  | 'VERSION_CONFLICT'
  /** 已撤回的消息不能再编辑。 */
  | 'RESOURCE_GONE'

export type EditResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly errorCode: EditFailure }

export interface EditInput {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
  readonly editorId: string
  readonly targetRevision: number
  readonly body: string
  readonly now: Date
  readonly policyRevision: number
  readonly operationId: string
  /** 组织配置的编辑窗口，毫秒。§14.1 说「组织配置的」，所以由调用方给。 */
  readonly editWindowMs: number
}

/**
 * 编辑一条消息。追加事件，**不改动 messages 表的 body**。
 *
 * 顺序上先判定后写入，且整个函数应在调用方的事务内执行 —— 判定用的 revision
 * 与写入的 revision 之间若有其他写入插入，单调性就断了。
 */
export function editMessage(db: DatabaseSync, input: EditInput): EditResult {
  const message = db
    .prepare(
      `SELECT created_at FROM messages
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(input.organizationId, input.senderId, input.messageId) as
    | { created_at: string }
    | undefined

  // 消息不存在与「不是你的消息」返回同一个错误码 —— 区分开就是一个
  // 消息存在性探测接口（§46）
  if (message === undefined) return reject('NOT_FOUND_OR_FORBIDDEN')

  // §14.1：**只有原发送者**可以编辑。管理员的合规权限只覆盖撤回，不覆盖编辑 ——
  // 让管理员改写他人消息的正文，等于给了一个不留痕的伪造通道
  if (input.editorId !== input.senderId) return reject('NOT_FOUND_OR_FORBIDDEN')

  const current = currentStateOf(db, input)
  if (current.revoked) return reject('RESOURCE_GONE')

  // 「更高」是严格大于。等于也拒绝：同一 revision 的两次编辑内容不同的话，
  // 哪一次生效就取决于到达顺序，而那正是 §14.1 要消除的
  if (input.targetRevision <= current.revision) return reject('VERSION_CONFLICT')

  const elapsed = input.now.getTime() - new Date(message.created_at).getTime()
  if (elapsed > input.editWindowMs) return reject('NOT_FOUND_OR_FORBIDDEN')

  appendEvent(db, {
    organizationId: input.organizationId,
    senderId: input.senderId,
    messageId: input.messageId,
    revision: input.targetRevision,
    eventType: 'message_edited',
    actorId: input.editorId,
    occurredAt: input.now.toISOString(),
    body: input.body,
    policyRevision: input.policyRevision,
    operationId: input.operationId,
  })

  return { ok: true, revision: input.targetRevision }
}

export interface RevokeInput {
  readonly organizationId: string
  readonly senderId: string
  readonly messageId: string
  readonly actorId: string
  /** §14.1：撤回由原发送者**或具备合规权限的管理员**发起。 */
  readonly actorHasComplianceAuthority: boolean
  readonly now: Date
  readonly policyRevision: number
  readonly operationId: string
}

export type RevokeResult =
  | {
      readonly ok: true
      readonly revision: number
      /**
       * 这次调用**没有**追加事件，返回的是首次撤回的结果。
       *
       * 调用方据此跳过审计写入：重放是「查询首次执行的结果」，不是再次执行。
       * 不区分的话，第二次调用会用同一个 operationId 生成同一个审计 ID，
       * 撞上审计表的主键。
       */
      readonly idempotentReplay: boolean
    }
  | { readonly ok: false; readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

/**
 * 撤回一条消息。
 *
 * 重复撤回是**幂等**的，返回已有的 revision 而不是报错 —— 用户在网络不稳时
 * 连点两次撤回，第二次报错会让人以为撤回失败了。
 *
 * 与编辑不同，撤回**不受编辑窗口限制**。§14.1 只对编辑说了「在组织配置的编辑
 * 窗口内」；撤回那一段没有时限，而这是合理的：合规撤回的场景恰恰是事后才发现
 * 内容有问题。
 */
export function revokeMessage(db: DatabaseSync, input: RevokeInput): RevokeResult {
  const exists = db
    .prepare(
      `SELECT 1 FROM messages
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(input.organizationId, input.senderId, input.messageId)
  if (exists === undefined) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

  const isSender = input.actorId === input.senderId
  if (!isSender && !input.actorHasComplianceAuthority) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }

  const current = currentStateOf(db, input)
  if (current.revoked) return { ok: true, revision: current.revision, idempotentReplay: true }

  const revision = current.revision + 1
  appendEvent(db, {
    organizationId: input.organizationId,
    senderId: input.senderId,
    messageId: input.messageId,
    revision,
    eventType: 'message_revoked',
    actorId: input.actorId,
    occurredAt: input.now.toISOString(),
    body: undefined,
    policyRevision: input.policyRevision,
    operationId: input.operationId,
  })
  return { ok: true, revision, idempotentReplay: false }
}

/**
 * 按事件流还原一条消息当前的样子。
 *
 * 从 messages 的初始正文（revision 1）出发，按 revision 升序应用事件。
 * 撤回一旦出现就是终态 —— 后续事件不再改变正文，即便它们的 revision 更高。
 */
export function messageView(
  db: DatabaseSync,
  key: { readonly organizationId: string; readonly senderId: string; readonly messageId: string },
): MessageView | undefined {
  const base = db
    .prepare(
      `SELECT body FROM messages
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(key.organizationId, key.senderId, key.messageId) as { body: string } | undefined
  if (base === undefined) return undefined

  let body: string | undefined = base.body
  let revision = 1
  let revoked = false

  for (const event of eventsOf(db, key)) {
    if (revoked) {
      // 撤回是终态。迟到的编辑仍然入库（事件不可变，不能拒收），但不复活正文
      revision = Math.max(revision, event.revision)
      continue
    }
    revision = event.revision
    if (event.eventType === 'message_revoked') {
      revoked = true
      body = undefined
    } else {
      body = event.body
    }
  }

  return { messageId: key.messageId, senderId: key.senderId, revision, body, revoked, edited: !revoked && revision > 1 }
}

/** 一条消息的全部事件，按 revision 升序。供审计与引用快照用。 */
export function eventsOf(
  db: DatabaseSync,
  key: { readonly organizationId: string; readonly senderId: string; readonly messageId: string },
): readonly MessageEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM message_events
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?
        ORDER BY revision`,
    )
    .all(key.organizationId, key.senderId, key.messageId) as Array<
    Record<string, string | number | null>
  >

  return rows.map((row) => ({
    organizationId: row['organization_id'] as string,
    senderId: row['sender_id'] as string,
    messageId: row['message_id'] as string,
    revision: row['revision'] as number,
    eventType: row['event_type'] as MessageEventType,
    actorId: row['actor_id'] as string,
    occurredAt: row['occurred_at'] as string,
    body: (row['body'] as string | null) ?? undefined,
    policyRevision: row['policy_revision'] as number,
    operationId: row['operation_id'] as string,
  }))
}

function currentStateOf(
  db: DatabaseSync,
  key: { readonly organizationId: string; readonly senderId: string; readonly messageId: string },
): { readonly revision: number; readonly revoked: boolean } {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(revision), 1) AS rev,
              MAX(CASE WHEN event_type = 'message_revoked' THEN 1 ELSE 0 END) AS revoked
         FROM message_events
        WHERE organization_id = ? AND sender_id = ? AND message_id = ?`,
    )
    .get(key.organizationId, key.senderId, key.messageId) as {
    rev: number
    revoked: number | null
  }
  return { revision: row.rev, revoked: row.revoked === 1 }
}

function appendEvent(db: DatabaseSync, event: MessageEvent): void {
  db.prepare(
    `INSERT INTO message_events
       (organization_id, sender_id, message_id, revision, event_type,
        actor_id, occurred_at, body, policy_revision, operation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.organizationId,
    event.senderId,
    event.messageId,
    event.revision,
    event.eventType,
    event.actorId,
    event.occurredAt,
    event.body ?? null,
    event.policyRevision,
    event.operationId,
  )
}

function reject(errorCode: EditFailure): EditResult {
  return { ok: false, errorCode }
}
