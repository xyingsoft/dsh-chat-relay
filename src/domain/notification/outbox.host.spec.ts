/**
 * outbox 消费测试。
 *
 * §48 那句「超时必须留下可重试或终态失败，**不能留下静默的模糊状态**」
 * 是本文件的主线：每一条失败路径都要落到 `retrying` 或 `dead_letter`，
 * 没有第三种结局，也不会卡在 `running`。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  cancelTask,
  claimBatch,
  deadLetters,
  enqueueEvent,
  markFailed,
  markSucceeded,
  outboxMetrics,
  taskOf,
} from './outbox.js'

let db: DatabaseSync
const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE outbox (
      event_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      event_format_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      task_state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT
    ) STRICT;
  `)
})

afterEach(() => db.close())

function enqueue(eventId: string, at = NOW): void {
  enqueueEvent(db, {
    eventId,
    organizationId: ORG,
    eventType: 'notification_created',
    payload: { recipient: 'yi' },
    now: at,
  })
}

function claim(limit = 10, now = NOW) {
  return claimBatch(db, { limit, now, workerId: 'w-1' })
}

describe('领取与投递', () => {
  it('领取即置 running 并记一次尝试', () => {
    // 先记尝试再投递 —— 反过来的话，进程在投递中崩溃这次尝试不算数，
    // 一个必然失败的任务会被无限重试，永远到不了 dead_letter
    enqueue('e-1')
    const batch = claim()
    expect(batch).toHaveLength(1)
    expect(taskOf(db, 'e-1')?.taskState).toBe('running')
    expect(taskOf(db, 'e-1')?.attempts).toBe(1)
  })

  it('已领取的任务不会被再次领取', () => {
    enqueue('e-1')
    claim()
    expect(claim()).toHaveLength(0)
  })

  it('按创建时间升序领取', () => {
    enqueue('e-2', new Date(NOW.getTime() + 1000))
    enqueue('e-1', NOW)
    expect(claim().map((t) => t.eventId)).toEqual(['e-1', 'e-2'])
  })

  it('尊重 limit', () => {
    for (let i = 0; i < 5; i += 1) enqueue(`e-${i}`, new Date(NOW.getTime() + i))
    expect(claim(2)).toHaveLength(2)
  })

  it('投递成功后置为 succeeded', () => {
    enqueue('e-1')
    claim()
    expect(markSucceeded(db, 'e-1')).toBe(true)
    expect(taskOf(db, 'e-1')?.taskState).toBe('succeeded')
  })

  it('重复确认是幂等的', () => {
    // 至少一次投递意味着同一事件可能被投递多次，对应地也可能被确认多次
    enqueue('e-1')
    claim()
    markSucceeded(db, 'e-1')
    expect(markSucceeded(db, 'e-1')).toBe(true)
  })

  it('同一事件可以被投递多次 —— 去重是消费方的事（§26）', () => {
    // 「恰好一次投递」在有网络的系统里做不到：投递成功但确认丢失时，
    // 投递方无法区分「对方收到了」与「对方没收到」
    enqueue('e-1')
    claim()
    markFailed(db, { eventId: 'e-1', error: '确认丢失', now: NOW })
    const again = claim(10, new Date(NOW.getTime() + 60_000))
    expect(again.map((t) => t.eventId)).toEqual(['e-1'])
  })
})

describe('失败必落到可重试或终态（§48）', () => {
  it('未达上限时排下一次重试', () => {
    enqueue('e-1')
    claim()
    const outcome = markFailed(db, { eventId: 'e-1', error: '连接超时', now: NOW })
    expect(outcome.kind).toBe('retrying')
    const task = taskOf(db, 'e-1')
    expect(task?.taskState).toBe('retrying')
    expect(task?.nextAttemptAt).toBeDefined()
    expect(task?.lastError).toBe('连接超时')
  })

  it('达到上限后进 dead_letter', () => {
    enqueue('e-1')
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts; i += 1) {
      const batch = claim(10, new Date(NOW.getTime() + i * 3_600_000))
      expect(batch.length, `第 ${i + 1} 轮应能领取`).toBe(1)
      markFailed(db, {
        eventId: 'e-1',
        error: '一直失败',
        now: new Date(NOW.getTime() + i * 3_600_000),
      })
    }
    expect(taskOf(db, 'e-1')?.taskState).toBe('dead_letter')
    expect(deadLetters(db).map((t) => t.eventId)).toEqual(['e-1'])
  })

  it('dead_letter 之后不再被领取', () => {
    // 否则「上限」就没有意义
    enqueue('e-1')
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts; i += 1) {
      claim(10, new Date(NOW.getTime() + i * 3_600_000))
      markFailed(db, { eventId: 'e-1', error: 'x', now: new Date(NOW.getTime() + i * 3_600_000) })
    }
    expect(claim(10, new Date(NOW.getTime() + 999_999_999))).toHaveLength(0)
  })

  it('没有第三种结局 —— 失败后绝不停留在 running', () => {
    enqueue('e-1')
    claim()
    markFailed(db, { eventId: 'e-1', error: 'x', now: NOW })
    expect(taskOf(db, 'e-1')?.taskState).not.toBe('running')
  })

  it('未知任务返回明确结果而不是静默成功', () => {
    expect(markFailed(db, { eventId: 'e-nope', error: 'x', now: NOW }).kind).toBe('unknown_task')
  })

  it('错误摘要被截断', () => {
    // last_error 是给运维看的；一段几十 KB 的堆栈会把这张表撑大，
    // 而真正有用的信息在前面
    enqueue('e-1')
    claim()
    markFailed(db, { eventId: 'e-1', error: 'x'.repeat(10_000), now: NOW })
    expect(taskOf(db, 'e-1')?.lastError?.length).toBe(500)
  })
})

describe('退避', () => {
  it('重试时间在退避之后，未到时不领取', () => {
    enqueue('e-1')
    claim()
    const outcome = markFailed(db, { eventId: 'e-1', error: 'x', now: NOW, random: () => 0 })
    expect(outcome.kind).toBe('retrying')
    // 立刻再领取：还没到 next_attempt_at
    expect(claim(10, NOW)).toHaveLength(0)
    expect(claim(10, new Date(NOW.getTime() + 3_600_000))).toHaveLength(1)
  })

  it('随指数增长', () => {
    const noJitter = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 }
    expect(backoffDelay(1, noJitter)).toBe(1000)
    expect(backoffDelay(2, noJitter)).toBe(2000)
    expect(backoffDelay(3, noJitter)).toBe(4000)
  })

  it('不超过 maxDelayMs，抖动也不会把它推高', () => {
    // 先夹再抖。顺序反过来的话，抖动会把已经夹好的值又推高，
    // maxDelayMs 就不再是上界了
    const policy = { ...DEFAULT_RETRY_POLICY, maxDelayMs: 10_000 }
    for (const random of [0, 0.5, 1]) {
      expect(backoffDelay(20, policy, () => random)).toBeLessThanOrEqual(10_000)
    }
  })

  it('带随机抖动，同批失败不会同时重试', () => {
    // 纯指数退避会让同一批失败的任务在同一时刻一起重试 ——
    // 那正是压垮刚恢复的下游的方式
    const delays = new Set<number>()
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      delays.add(backoffDelay(5, DEFAULT_RETRY_POLICY, () => random))
    }
    expect(delays.size).toBeGreaterThan(1)
  })

  it('抖动只向下不向上', () => {
    // 向上抖会让重试比预期更晚，而 maxDelayMs 是承诺的上界
    const base = backoffDelay(3, { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 })
    for (const random of [0, 0.3, 0.7, 1]) {
      expect(backoffDelay(3, DEFAULT_RETRY_POLICY, () => random)).toBeLessThanOrEqual(base)
    }
  })
})

describe('可取消（§48）', () => {
  it('未成功的任务可以取消', () => {
    enqueue('e-1')
    expect(cancelTask(db, 'e-1')).toBe(true)
    expect(taskOf(db, 'e-1')?.taskState).toBe('cancelled')
  })

  it('取消后不再被领取', () => {
    enqueue('e-1')
    cancelTask(db, 'e-1')
    expect(claim()).toHaveLength(0)
  })

  it('已成功的不能取消', () => {
    // 事件已经送出去了，把状态改成 cancelled 只会让运维以为它没送出去
    enqueue('e-1')
    claim()
    markSucceeded(db, 'e-1')
    expect(cancelTask(db, 'e-1')).toBe(false)
    expect(taskOf(db, 'e-1')?.taskState).toBe('succeeded')
  })
})

describe('可观测（§40）', () => {
  it('报出全部状态的计数而不只是待处理量', () => {
    // 只报待处理量的话，一个把所有任务都打进 dead_letter 的故障
    // 会表现为「待处理量降到 0」—— 看起来像恢复了
    enqueue('e-1')
    enqueue('e-2', new Date(NOW.getTime() + 1))
    enqueue('e-3', new Date(NOW.getTime() + 2))
    claim()
    markSucceeded(db, 'e-1')
    markFailed(db, { eventId: 'e-2', error: 'x', now: NOW })

    const metrics = outboxMetrics(db, ORG)
    expect(metrics['succeeded']).toBe(1)
    expect(metrics['retrying']).toBe(1)
    expect(metrics['running']).toBe(1)
  })

  it('按组织分区统计', () => {
    enqueue('e-1')
    enqueueEvent(db, {
      eventId: 'e-other',
      organizationId: 'org-2',
      eventType: 'x',
      payload: {},
      now: NOW,
    })
    expect(outboxMetrics(db, ORG)['queued']).toBe(1)
    expect(outboxMetrics(db)['queued']).toBe(2)
  })
})

describe('入队', () => {
  it('同一 eventId 重复入队不产生第二条', () => {
    enqueue('e-1')
    enqueue('e-1')
    expect(outboxMetrics(db, ORG)['queued']).toBe(1)
  })

  it('负载按 JSON 序列化，事件格式版本随行', () => {
    enqueueEvent(db, {
      eventId: 'e-1',
      organizationId: ORG,
      eventType: 'notification_created',
      payload: { recipient: 'yi', 中文: '正常' },
      eventFormatVersion: 3,
      now: NOW,
    })
    const task = taskOf(db, 'e-1')
    expect(JSON.parse(task!.payload)).toEqual({ recipient: 'yi', 中文: '正常' })
    expect(task?.eventFormatVersion).toBe(3)
  })
})
