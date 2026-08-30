/**
 * §46 错误码目录。
 *
 * **本文件由 `docs/03-details/06-contracts-and-conventions.md` §46 的表格生成，
 * 不要手工编辑。** `errors.host.spec.ts` 会反向解析该文档并逐字段核对，任何漂移
 * 都会让测试失败 —— 新增或修改错误码必须先改文档。
 *
 * 编码规范要求：错误码目录属于本包，插件不得自定义同名概念或私有错误码；新增错误码
 * 必须同时声明 HTTP 映射、可重试性与幂等语义。
 */

/**
 * 可重试性是错误码的固有属性，由目录声明，**不由调用方猜测**。
 *
 * - `retryable`   —— 同一幂等键重试可能成功
 * - `conditional` —— 需先解决前置条件（重新确认、补拉、扩容）后再试
 * - `terminal`    —— 重试无意义
 */
export type Retryability = 'retryable' | 'conditional' | 'terminal'

/** 一条错误码的完整声明。 */
export interface ErrorDefinition {
  /** HTTP 状态码。注意有两条刻意映射为 200，见下方说明。 */
  readonly http: number
  readonly retryability: Retryability
  /** 文档中的分类，保持原文 —— 英文标识符尚未在文档中定义，此处不自行发明。 */
  readonly category: string
  /** 幂等语义，取自文档表格的最后一列。 */
  readonly idempotency: string
}

export const ERROR_CATALOGUE = {
  UNAUTHENTICATED: {
    http: 401,
    retryability: 'conditional',
    category: '认证',
    idempotency: '重新认证后可重试',
  },
  TIME_SKEW: {
    http: 401,
    retryability: 'conditional',
    category: '认证',
    idempotency: '按签名服务器时间修正偏移后重试',
  },
  SERVER_IDENTITY_MISMATCH: {
    http: 495,
    retryability: 'terminal',
    category: '认证',
    idempotency: '需管理员确认签名轮换，禁止自动重试',
  },
  DEVICE_RESTRICTED: {
    http: 403,
    retryability: 'conditional',
    category: '风险',
    idempotency: '完成风险处置后可重试',
  },
  DEVICE_REVOKED: {
    http: 403,
    retryability: 'terminal',
    category: '风险',
    idempotency: '需重新注册设备',
  },
  FORBIDDEN: {
    http: 403,
    retryability: 'terminal',
    category: '授权',
    idempotency: '权限变更前重试无意义',
  },
  NOT_FOUND_OR_FORBIDDEN: {
    http: 404,
    retryability: 'terminal',
    category: '授权',
    idempotency: '统一返回，不区分存在性',
  },
  RECIPIENT_INACTIVE: {
    http: 409,
    retryability: 'terminal',
    category: '授权',
    idempotency: '目标已离开组织',
  },
  CONFIRMATION_REQUIRED: {
    http: 428,
    retryability: 'conditional',
    category: '确认',
    idempotency: '需先取得确认挑战',
  },
  CONFIRMATION_EXPIRED: {
    http: 428,
    retryability: 'conditional',
    category: '确认',
    idempotency: '必须重新展示摘要并确认',
  },
  VERSION_CONFLICT: {
    http: 409,
    retryability: 'conditional',
    category: '并发',
    idempotency: '读取最新版本后以新版本号重试',
  },
  SYNC_DIVERGED: {
    http: 409,
    retryability: 'conditional',
    category: '一致性',
    idempotency: '进入对账流程，停止自动重发',
  },
  MEMBER_LIMIT_REACHED: {
    http: 402,
    retryability: 'conditional',
    category: '配额',
    idempotency: '需扩容或释放名额',
  },
  STORAGE_QUOTA_EXCEEDED: {
    http: 402,
    retryability: 'conditional',
    category: '配额',
    idempotency: '需清理或扩容',
  },
  BOT_BUDGET_EXCEEDED: {
    http: 402,
    retryability: 'conditional',
    category: '配额',
    idempotency: '需管理员调整预算',
  },
  RECIPIENT_QUEUE_FULL: {
    http: 507,
    retryability: 'conditional',
    category: '容量',
    idempotency: '接收方消费后可重试，发送未被接收',
  },
  GROUP_LOG_CAPACITY_EXCEEDED: {
    http: 507,
    retryability: 'conditional',
    category: '容量',
    idempotency: '需保留策略或容量处理',
  },
  SANDBOX_QUOTA_EXCEEDED: {
    http: 200,
    retryability: 'terminal',
    category: '执行',
    idempotency: '尝试状态为 `failed`，保留检查点',
  },
  RESOURCE_SNAPSHOT_FORBIDDEN: {
    http: 403,
    retryability: 'terminal',
    category: '内容策略',
    idempotency: '目录禁止版本快照',
  },
  SHARE_UNAVAILABLE: {
    http: 410,
    retryability: 'terminal',
    category: '内容状态',
    idempotency: '已过期或已撤销',
  },
  RESOURCE_GONE: {
    http: 410,
    retryability: 'terminal',
    category: '内容状态',
    idempotency: '已物理清理',
  },
  ATTACHMENT_UNAVAILABLE: {
    http: 200,
    retryability: 'conditional',
    category: '内容状态',
    idempotency: '消息仍持久化，附件保留期内重试',
  },
  EGRESS_BLOCKED: {
    http: 403,
    retryability: 'terminal',
    category: '出站',
    idempotency: '目标不在 allowlist 或命中私网防护',
  },
  PLUGIN_REVOKED: {
    http: 403,
    retryability: 'terminal',
    category: '供应链',
    idempotency: '版本已撤销，能力租约失效',
  },
  NOT_IMPLEMENTED: {
    http: 501,
    retryability: 'terminal',
    category: '部署',
    idempotency: '该部署层未装载对应插件',
  },
  RATE_LIMITED: {
    http: 429,
    retryability: 'retryable',
    category: '限流',
    idempotency: '含 `retryAfter`，不泄露他人用量',
  },
  REVIEW_REQUIRED: {
    http: 409,
    retryability: 'conditional',
    category: '评审',
    idempotency: '项目策略要求评审结论后才能完成',
  },
  REVIEW_SUPERSEDED: {
    http: 409,
    retryability: 'conditional',
    category: '评审',
    idempotency: '关联产物已变化，需重新评审',
  },
  DEPENDENCY_CYCLE: {
    http: 409,
    retryability: 'terminal',
    category: '工作项',
    idempotency: '依赖关系将形成环',
  },
  ARTIFACT_NOT_ACCEPTED: {
    http: 409,
    retryability: 'conditional',
    category: '协作',
    idempotency: '候选产物需有写权限成员确认',
  },
  PROTOCOL_VERSION_UNSUPPORTED: {
    http: 426,
    retryability: 'terminal',
    category: '协议',
    idempotency: '需升级 host 或 relay',
  },
  SERVICE_READ_ONLY: {
    http: 503,
    retryability: 'retryable',
    category: '恢复',
    idempotency: '处于 `read_only_recovery`',
  },
} as const satisfies Record<string, ErrorDefinition>

/** 全部错误码构成的封闭联合类型。 */
export type ErrorCode = keyof typeof ERROR_CATALOGUE

/** 按错误码取其声明。 */
export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOGUE[code]
}

/**
 * `SANDBOX_QUOTA_EXCEEDED` 与 `ATTACHMENT_UNAVAILABLE` 映射为 200，因为它们是被正常
 * 返回的**领域状态**而不是请求失败 —— 调用方应按状态机处理，不按 HTTP 错误处理。
 */
export const DOMAIN_STATE_CODES = ['SANDBOX_QUOTA_EXCEEDED', 'ATTACHMENT_UNAVAILABLE'] as const

/**
 * 异步任务不得自动重试的终态错误类别。
 *
 * 文档原文：「权限拒绝、schema 无效、配额不足、资源不存在和版本冲突是终态错误，
 * 异步任务不得对其自动重试。」判定依据是 `retryability === 'terminal'`。
 */
export function isAutoRetryForbidden(code: ErrorCode): boolean {
  return ERROR_CATALOGUE[code].retryability === 'terminal'
}
