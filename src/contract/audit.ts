/**
 * 审计事件的契约定义。
 *
 * §48 明确把 **`AuditEvent` 结构**列为 `@dsh-chat/contract` 的内容，与错误码目录、
 * `ProtocolVersion` 和术语表并列。原因是它有多个读者：写入方在 host 领域插件里，
 * 导出与合规查询在另一个插件里，客户端的审计视图在浏览器里 —— 结构定义在任何一个
 * 读者内部，其余读者就得复制一份，而复制的那份迟早会漂移。
 *
 * 写入实现（SQL、序列号分配）留在 `@dsh-chat/audit`：那是**副作用**，
 * 按 §48「本包只定义类型、schema 与服务接口，不携带数据库驱动」不能进契约包。
 */

/** 操作结果。**被拒绝的尝试同样要记录**（§43 第 14 步），因此这不是布尔值。 */
export const AUDIT_OUTCOMES = ['succeeded', 'rejected'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/**
 * 写入侧的审计事件。字段对应 §37 的 15 项清单。
 *
 * **注意没有 `body` / `content` 字段** —— §43 第 14 步要求「审计表中不含任何消息
 * 正文」。审计记录的是「事实与引用」，不是内容本身：`targetRef` 只放引用
 * （如 `message:sender/msg-id`），需要正文时按引用去主表查，且那条查询本身受权限约束。
 *
 * 不含 `serverSeq` —— 序列号由写入方在事务内分配，不是调用方能提供的。
 */
export interface AuditEventInput {
  readonly auditEventId: string
  readonly organizationId: string
  readonly eventType: string
  readonly occurredAt: Date
  readonly actorAccountId?: string
  readonly deviceId?: string
  /** 只记 IP 前缀而非完整地址（§37）。 */
  readonly sourceIpPrefix?: string
  readonly coarseRegion?: string
  readonly targetRef: string
  readonly outcome: AuditOutcome
  /** 被拒绝时记录错误码，供事后核对拒绝是否符合预期。 */
  readonly errorCode?: string
  /** 判定时生效的策略版本，使权限判定可复算（§48）。 */
  readonly policyRevision: number
  readonly operationId?: string
  readonly relatedEventId?: string
  readonly traceId?: string
}

/**
 * 读取侧的审计事件。
 *
 * 刻意**不从 `AuditEventInput` 派生**：写入侧的可选字段含义是「调用方可以不传」，
 * 读取侧的是「数据库里可能为 NULL」。在 `exactOptionalPropertyTypes` 下这是两种
 * 不同的类型 —— 合并成一个会让读取侧无法显式赋 `undefined`，反过来又会让写入侧
 * 被迫为每个可选字段传 `undefined`。两个接口比一个错的接口便宜。
 */
export interface AuditEvent {
  readonly auditEventId: string
  readonly organizationId: string
  readonly eventType: string
  readonly occurredAt: string
  /** 按组织分区、单调递增。缺口即意味着有记录被删除。 */
  readonly serverSeq: number
  readonly actorAccountId: string | undefined
  readonly deviceId: string | undefined
  readonly sourceIpPrefix: string | undefined
  readonly coarseRegion: string | undefined
  readonly targetRef: string
  readonly outcome: AuditOutcome
  readonly errorCode: string | undefined
  readonly policyRevision: number
  readonly operationId: string | undefined
  readonly relatedEventId: string | undefined
  readonly traceId: string | undefined
}

/**
 * 代码字段 → §37 中对应措辞的对照表，供防漂移测试核对。
 *
 * 与错误码目录同一机制：文档里有一份清单，代码就不该另立一份 —— 这里登记的是
 * 「代码认为文档说了什么」，测试反向解析文档验证这个认知没有过期。
 *
 * §37 的句子列了 **15 个短语**，对应 **16 个字段**：「来源 IP 前缀与粗粒度区域」
 * 一个短语覆盖 `sourceIpPrefix` 和 `coarseRegion` 两个字段。这个 1 的差值是真实的，
 * 不是记数错误，所以这里按字段列而不是按短语列。
 */
export const AUDIT_EVENT_FIELD_SOURCES: Readonly<Record<keyof AuditEvent, string>> =
  Object.freeze({
    auditEventId: '`AuditEventId`',
    organizationId: '`OrganizationId`',
    eventType: '事件类型',
    occurredAt: '发生时间',
    serverSeq: '服务端序列号',
    actorAccountId: '操作者身份',
    deviceId: '`DeviceId`',
    sourceIpPrefix: '来源 IP 前缀',
    coarseRegion: '粗粒度区域',
    targetRef: '目标对象引用',
    outcome: '操作结果',
    errorCode: '错误码',
    policyRevision: '策略版本',
    operationId: '关联操作 ID',
    relatedEventId: '关联领域事件 ID',
    traceId: '调用链 ID',
  })
