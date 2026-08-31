/**
 * 在线状态测试。
 *
 * §9.1 的两条约束在测试里各占一组：**`unknown` 不能被说成 `offline`**
 * （前者是「不知道」，后者是一个断言），以及**隐藏时对别人显示 `unknown`
 * 而不是 `offline`**（后者是在替用户撒谎）。
 *
 * 阈值用 §50.3 关闭的那组基线值，并把它们当作**可被推翻的默认**来测 ——
 * 每条都显式传自己的阈值，不依赖常量的当前取值。改基线不该让这些用例变红。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  PRESENCE_BASELINE,
  applyVisibility,
  presenceOf,
  recordHeartbeat,
  stateOfDevice,
} from './presence.js'

const NOW = new Date('2026-08-30T12:00:00.000Z')
const THRESHOLDS = { onlineWithinMs: 90_000, idleWithinMs: 600_000 }

/** 相对 NOW 往前 n 毫秒。 */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE accounts (account_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE device_presence (
      device_id           TEXT NOT NULL,
      account_id          TEXT NOT NULL REFERENCES accounts(account_id),
      organization_id     TEXT NOT NULL,
      last_heartbeat_at   TEXT NOT NULL,
      last_interaction_at TEXT NOT NULL,
      PRIMARY KEY (device_id, organization_id)
    ) STRICT;
  `)
  db.prepare('INSERT INTO accounts VALUES (?)').run('jia')
})

afterEach(() => db.close())

describe('单设备的状态折叠', () => {
  it('心跳与交互都新鲜 → online', () => {
    expect(
      stateOfDevice({ lastHeartbeatAt: ago(10_000), lastInteractionAt: ago(10_000) }, NOW, THRESHOLDS),
    ).toBe('online')
  })

  it('心跳新鲜但很久没操作 → idle', () => {
    // 这正是 idle 存在的理由：进程活着，人不在
    expect(
      stateOfDevice(
        { lastHeartbeatAt: ago(10_000), lastInteractionAt: ago(900_000) },
        NOW,
        THRESHOLDS,
      ),
    ).toBe('idle')
  })

  it('心跳超过 online 窗口但还在 idle 窗口内 → idle', () => {
    // 进程活着，网络可能不稳。直接判 offline 会让抖动看起来像掉线
    expect(
      stateOfDevice({ lastHeartbeatAt: ago(120_000), lastInteractionAt: ago(1_000) }, NOW, THRESHOLDS),
    ).toBe('idle')
  })

  it('心跳超过 idle 窗口 → offline，哪怕交互时间很新', () => {
    // 先看心跳再看交互。反过来的话，一台早就关机的机器会因为「最后一次交互
    // 在 10 分钟内」而显示 idle
    expect(
      stateOfDevice({ lastHeartbeatAt: ago(3_600_000), lastInteractionAt: ago(1_000) }, NOW, THRESHOLDS),
    ).toBe('offline')
  })

  it('心跳来自遥远的未来 → unknown，不是 online', () => {
    // §9.1 把时钟异常列为 unknown。当成最新的话，一台时钟设错的机器会
    // 永远显示在线
    const future = new Date(NOW.getTime() + 3_600_000)
    expect(
      stateOfDevice({ lastHeartbeatAt: future, lastInteractionAt: future }, NOW, THRESHOLDS),
    ).toBe('unknown')
  })

  it('轻微的未来偏移仍算 online —— 时钟总有几秒差', () => {
    // 严格要求「不得晚于服务器」的话，正常机器每隔几秒就会闪一次 unknown
    const slightlyAhead = new Date(NOW.getTime() + 2_000)
    expect(
      stateOfDevice(
        { lastHeartbeatAt: slightlyAhead, lastInteractionAt: slightlyAhead },
        NOW,
        THRESHOLDS,
      ),
    ).toBe('online')
  })

  it('边界值取「窗口内算数」', () => {
    // 恰好等于阈值时判 offline 的话，一个准点发心跳的 host 会周期性闪断
    expect(
      stateOfDevice(
        { lastHeartbeatAt: ago(THRESHOLDS.onlineWithinMs), lastInteractionAt: NOW },
        NOW,
        THRESHOLDS,
      ),
    ).toBe('online')
  })
})

describe('聚合到账号', () => {
  function beat(deviceId: string, heartbeatAgoMs: number, interactionAgoMs = heartbeatAgoMs): void {
    recordHeartbeat(db, {
      deviceId,
      accountId: 'jia',
      organizationId: 'org-1',
      at: ago(heartbeatAgoMs),
      lastInteractionAt: ago(interactionAgoMs),
    })
  }

  it('没有任何记录 → unknown，不是 offline', () => {
    // 说成 offline 是在断言一件没有依据的事。§9.1 明确 unknown 用于
    // 「刚加入组织」这类情况
    expect(presenceOf(db, { organizationId: 'org-1', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'unknown',
    )
  })

  it('多设备取最乐观的一档', () => {
    // 取最悲观的话，一台忘在公司的机器会让人永远显示离线
    beat('laptop', 5_000)
    beat('desktop', 3_600_000)
    expect(presenceOf(db, { organizationId: 'org-1', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'online',
    )
  })

  it('全都离线才是离线', () => {
    beat('laptop', 3_600_000)
    beat('desktop', 7_200_000)
    expect(presenceOf(db, { organizationId: 'org-1', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'offline',
    )
  })

  it('按组织隔离 —— 在 A 组织的心跳不代表 B 组织在线', () => {
    // 同一台机器可能属于多个组织，而在线状态是按组织回答的
    beat('laptop', 5_000)
    expect(presenceOf(db, { organizationId: 'org-2', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'unknown',
    )
  })

  it('重复心跳覆盖同一行，不堆历史', () => {
    beat('laptop', 600_000)
    beat('laptop', 1_000)
    const count = db.prepare('SELECT COUNT(*) AS c FROM device_presence').get() as { c: number }
    expect(count.c).toBe(1)
    expect(presenceOf(db, { organizationId: 'org-1', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'online',
    )
  })

  it('不上报交互时间的旧版 host 显示 online 而不是 idle', () => {
    // 宁可少一档信息，不要给错的那一档
    recordHeartbeat(db, {
      deviceId: 'old-host',
      accountId: 'jia',
      organizationId: 'org-1',
      at: ago(5_000),
    })
    expect(presenceOf(db, { organizationId: 'org-1', accountId: 'jia', now: NOW }, THRESHOLDS)).toBe(
      'online',
    )
  })
})

describe('可见性（§9.1 的三档）', () => {
  const shown = (visibility: 'everyone' | 'shared_scopes' | 'hidden', sharesScope: boolean) =>
    applyVisibility('online', { visibility, isSelf: false, sharesScope })

  it('hidden 对别人显示 unknown，不是 offline', () => {
    // 显示成离线是在替用户撒谎 —— 那是一个关于「这个人不在」的断言，
    // 而实际情况是「这个人不想说」
    expect(shown('hidden', true)).toBe('unknown')
  })

  it('shared_scopes：共享作用域的看得到，其他人看不到', () => {
    expect(shown('shared_scopes', true)).toBe('online')
    expect(shown('shared_scopes', false)).toBe('unknown')
  })

  it('everyone 谁都看得到', () => {
    expect(shown('everyone', false)).toBe('online')
  })

  it('看自己永远是真实状态，隐藏也一样', () => {
    // 看不到的话，用户没法确认自己的隐藏设置生效了没有，也没法发现自己的
    // host 其实已经掉线
    expect(applyVisibility('idle', { visibility: 'hidden', isSelf: true, sharesScope: false })).toBe(
      'idle',
    )
  })
})

describe('基线阈值就是 §50.3 关闭时写下的那组', () => {
  it('心跳 30 秒、online 90 秒、idle 10 分钟', () => {
    // 这条是文档与代码的对齐锁。改基线时它会红，提醒同步改 §50.3 与 §9.1
    expect(PRESENCE_BASELINE.heartbeatIntervalMs).toBe(30_000)
    expect(PRESENCE_BASELINE.onlineWithinMs).toBe(90_000)
    expect(PRESENCE_BASELINE.idleWithinMs).toBe(10 * 60_000)
  })

  it('online 窗口是心跳间隔的三倍 —— 允许连丢两次', () => {
    // 设成一倍的话，一次 GC 停顿或网络抖动就会让人闪断
    expect(PRESENCE_BASELINE.onlineWithinMs).toBe(PRESENCE_BASELINE.heartbeatIntervalMs * 3)
  })
})
