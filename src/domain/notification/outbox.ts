/**
 * 事务 outbox 的消费。
 *
 * §26：领域对象与 outbox **在同一事务写入**，提交后异步投递；outbox 任务
 * 可以重复执行，**消费方以事件 ID 去重**。
 *
 * §17.1：「每个应通知的领域事件先在数据库事务中写入 `Notification`，
 * **再由 outbox 任务向在线 host 推送事件**。」
 *
 * §48：「所有出站网络重试必须有**上限、随机退避、可取消且可观测**。
 * **超时必须留下可重试或终态失败，不能留下静默的模糊状态。**」
 *
 * ## 消费方去重，不是投递方保证只投一次
 *
 * 这是 §26 的原话，也是本模块最重要的一条。「恰好一次投递」在有网络的系统里
 * 做不到 —— 投递成功但确认丢失时，投递方无法区分「对方收到了」与「对方没收到」。
 * 所以选择「至少一次投递 + 消费方按事件 ID 去重」，把不确定性放在一个能解决它
 * 的地方。
 *
 * 因此 `claimBatch` 允许同一事件被投递多次，`markSucceeded` 是幂等的。
 *
 * ## 退避必须带随机抖动
 *
 * 纯指数退避会让同一批失败的任务在同一时刻一起重试 —— 那正是压垮刚恢复的
 * 下游的方式。抖动把它们摊开。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { AsyncTaskState } from '../../contract/index.js'

export interface OutboxTask {
  readonly eventId: string
  readonly organizationId: string
  readonly eventType: string
  readonly payload: string
  readonly eventFormatVersion: number
  readonly createdAt: string
  readonly taskState: AsyncTaskState
  readonly attempts: number
  readonly nextAttemptAt: string | undefined
  readonly lastError: string | undefined
}

export interface RetryPolicy {
  /** 尝试次数上限。超过后进入 `dead_letter`（§48：重试必须有上限）。 */
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /**
   * 抖动比例，0 到 1。
   *
   * 默认 0.5 —— 退避取 `[delay/2, delay]` 之间的随机值。纯指数退避会让同一批
   * 失败的任务在同一时刻一起重试，那正是压垮刚恢复的下游的方式。
   */
  readonly jitterRatio: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 1000,
  maxDelayMs: 5 * 60 * 1000,
  jitterRatio: 0.5,
})

/**
 * 领取一批待投递的任务。
 *
 * 领取即置为 `running` 并记一次尝试。**先记尝试再投递** —— 反过来的话，
 * 进程在投递中崩溃，这次尝试不算数，一个必然失败的任务会被无限重试，
 * 永远到不了 `dead_letter`。
 *
 * `now` 由调用方传入：既便于测试，也让「什么是现在」有单一来源。
 */
export function claimBatch(
  db: DatabaseSync,
  input: { readonly limit: number; readonly now: Date; readonly workerId: string },
): readonly OutboxTask[] {
  const iso = input.now.toISOString()
  const rows = db
    .prepare(
      `SELECT event_id FROM outbox
        WHERE task_state IN ('queued', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at, event_id
        LIMIT ?`,
    )
    .all(iso, input.limit) as Array<{ event_id: string }>

  const claimed: OutboxTask[] = []
  for (const row of rows) {
    // 条件更新而非「先读后写」：并发的两个 worker 都读到 queued 然后都投递，
    // 虽然消费方会去重，但白白多一次出站请求
    const result = db
      .prepare(
        `UPDATE outbox
            SET task_state = 'running', attempts = attempts + 1, last_error = NULL
          WHERE event_id = ? AND task_state IN ('queued', 'retrying')`,
      )
      .run(row.event_id)
    if (Number(result.changes) === 0) continue
    const task = taskOf(db, row.event_id)
    if (task !== undefined) claimed.push(task)
  }
  return claimed
}

/**
 * 投递成功。
 *
 * 幂等 —— 重复确认同一个事件不报错。至少一次投递意味着同一事件可能被投递
 * 多次，对应地也可能被确认多次。
 */
export function markSucceeded(db: DatabaseSync, eventId: string): boolean {
  const result = db
    .prepare(
      `UPDATE outbox SET task_state = 'succeeded', next_attempt_at = NULL, last_error = NULL
        WHERE event_id = ? AND task_state != 'succeeded'`,
    )
    .run(eventId)
  return Number(result.changes) > 0 || taskOf(db, eventId)?.taskState === 'succeeded'
}

export type FailureOutcome =
  | { readonly kind: 'retrying'; readonly nextAttemptAt: string; readonly attempts: number }
  /** 尝试次数用尽。§48：不能留下静默的模糊状态。 */
  | { readonly kind: 'dead_letter'; readonly attempts: number }
  | { readonly kind: 'unknown_task' }

/**
 * 投递失败。
 *
 * 要么排下一次重试，要么进 `dead_letter` —— **没有第三种结局**。§48：
 * 「超时必须留下可重试或终态失败，不能留下静默的模糊状态。」
 *
 * `random` 可注入，使抖动在测试中可复现。
 */
export function markFailed(
  db: DatabaseSync,
  input: {
    readonly eventId: string
    readonly error: string
    readonly now: Date
    readonly policy?: RetryPolicy
    readonly random?: () => number
  },
): FailureOutcome {
  const task = taskOf(db, input.eventId)
  if (task === undefined) return { kind: 'unknown_task' }

  const policy = input.policy ?? DEFAULT_RETRY_POLICY
  // 错误摘要截断：last_error 是给运维看的，一段几十 KB 的堆栈会把这张表撑大，
  // 而真正有用的信息在前面
  const error = input.error.slice(0, 500)

  if (task.attempts >= policy.maxAttempts) {
    db.prepare(
      `UPDATE outbox SET task_state = 'dead_letter', next_attempt_at = NULL, last_error = ?
        WHERE event_id = ?`,
    ).run(error, input.eventId)
    return { kind: 'dead_letter', attempts: task.attempts }
  }

  const delay = backoffDelay(task.attempts, policy, input.random ?? Math.random)
  const nextAttemptAt = new Date(input.now.getTime() + delay).toISOString()
  db.prepare(
    `UPDATE outbox SET task_state = 'retrying', next_attempt_at = ?, last_error = ?
      WHERE event_id = ?`,
  ).run(nextAttemptAt, error, input.eventId)
  return { kind: 'retrying', nextAttemptAt, attempts: task.attempts }
}

/**
 * 带抖动的指数退避。
 *
 * 上界先夹到 `maxDelayMs` 再加抖动 —— 顺序反过来的话，抖动会把已经夹好的值
 * 又推高，`maxDelayMs` 就不再是上界了。
 */
export function backoffDelay(
  attempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempts - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio * random()
  return Math.round(capped * jitter)
}

/**
 * 取消一个尚未成功的任务（§48：重试必须**可取消**）。
 *
 * 已成功的不能取消 —— 事件已经送出去了，把状态改成 cancelled 只会让运维
 * 以为它没送出去。
 */
export function cancelTask(db: DatabaseSync, eventId: string): boolean {
  const result = db
    .prepare(
      `UPDATE outbox SET task_state = 'cancelled', next_attempt_at = NULL
        WHERE event_id = ? AND task_state NOT IN ('succeeded', 'cancelled')`,
    )
    .run(eventId)
  return Number(result.changes) > 0
}

/**
 * outbox 的可观测指标（§40 的指标面要求「outbox 待处理量与 `dead_letter` 计数」）。
 *
 * 返回全部状态的计数而不只是待处理量：只报待处理量的话，一个把所有任务都
 * 打进 dead_letter 的故障会表现为「待处理量降到 0」—— 看起来像恢复了。
 */
export function outboxMetrics(
  db: DatabaseSync,
  organizationId?: string,
): Readonly<Record<string, number>> {
  const rows = (
    organizationId === undefined
      ? db.prepare('SELECT task_state, COUNT(*) AS c FROM outbox GROUP BY task_state').all()
      : db
          .prepare(
            'SELECT task_state, COUNT(*) AS c FROM outbox WHERE organization_id = ? GROUP BY task_state',
          )
          .all(organizationId)
  ) as Array<{ task_state: string; c: number }>

  const metrics: Record<string, number> = {}
  for (const row of rows) metrics[row.task_state] = row.c
  return metrics
}

/** 进入 dead_letter 的任务，供运维处置（§41 的管理台要求）。 */
export function deadLetters(db: DatabaseSync, limit = 100): readonly OutboxTask[] {
  const rows = db
    .prepare(
      `SELECT event_id FROM outbox WHERE task_state = 'dead_letter'
        ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as Array<{ event_id: string }>
  return rows.flatMap((row) => {
    const task = taskOf(db, row.event_id)
    return task === undefined ? [] : [task]
  })
}

export function taskOf(db: DatabaseSync, eventId: string): OutboxTask | undefined {
  const row = db.prepare('SELECT * FROM outbox WHERE event_id = ?').get(eventId) as
    | Record<string, string | number | null>
    | undefined
  if (row === undefined) return undefined
  return {
    eventId: row['event_id'] as string,
    organizationId: row['organization_id'] as string,
    eventType: row['event_type'] as string,
    payload: row['payload'] as string,
    eventFormatVersion: row['event_format_version'] as number,
    createdAt: row['created_at'] as string,
    taskState: row['task_state'] as AsyncTaskState,
    attempts: row['attempts'] as number,
    nextAttemptAt: (row['next_attempt_at'] as string | null) ?? undefined,
    lastError: (row['last_error'] as string | null) ?? undefined,
  }
}

/** 写入一条 outbox 事件。**必须在触发它的领域写入的同一事务内调用**（§26）。 */
export function enqueueEvent(
  db: DatabaseSync,
  input: {
    readonly eventId: string
    readonly organizationId: string
    readonly eventType: string
    readonly payload: unknown
    readonly eventFormatVersion?: number
    readonly now: Date
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO outbox
       (event_id, organization_id, event_type, payload, event_format_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.organizationId,
    input.eventType,
    JSON.stringify(input.payload),
    input.eventFormatVersion ?? 1,
    input.now.toISOString(),
  )
}
