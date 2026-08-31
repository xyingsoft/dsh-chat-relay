/**
 * 第二因素测试。
 *
 * §8 里有四条是「改回去就出安全问题」的，各占一组：
 *
 * 1. 备用码只存哈希
 * 2. 备用码消费即失效
 * 3. TOTP 已消费的时间步拒绝重放
 * 4. 「没启用」与「码不对」返回同一个错误码
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../../storage/migrations.js'

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LOW_WATERMARK,
  activateTotp,
  consumeRecoveryCode,
  enrollTotp,
  hasActiveFactor,
  issueRecoveryCodes,
  normalizeCode,
  pruneUsedSteps,
  revokeFactor,
  verifyTotpFactor,
} from './second-factor.js'
import { codeAtStep, fromBase32, stepAt } from './totp.js'

const NOW = new Date('2026-08-30T12:00:00.000Z')

let db: DatabaseSync

/** 用真实迁移建库 —— 手抄 schema 正是上一轮让 device_name 丢失的原因。 */
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) db.exec(statement)
  }
  db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
    'jia',
    '甲',
    NOW.toISOString(),
  )
})

afterEach(() => db.close())

function enroll() {
  return enrollTotp(db, {
    accountId: 'jia',
    issuer: 'DSH Chat',
    accountLabel: '甲',
    now: NOW,
  })
}

/** 算出当前这一步的正确验证码。 */
function currentCode(secretBase32: string, at: Date = NOW): string {
  return codeAtStep(fromBase32(secretBase32), stepAt(at), 6)
}

describe('登记 TOTP', () => {
  it('返回可扫的密钥与 URI', () => {
    const enrolled = enroll()
    expect(enrolled.secretBase32.length).toBeGreaterThan(0)
    expect(enrolled.otpauthUri).toContain('otpauth://totp/')
  })

  it('初始是 pending，不是 active', () => {
    // 直接置 active 的话，一次扫码失败就把账号锁进「要求第二因素、
    // 而用户没有第二因素」的死局
    enroll()
    expect(hasActiveFactor(db, 'jia')).toBe(false)
  })

  it('验证成功后才能转 active', () => {
    const enrolled = enroll()
    expect(verifyTotpFactor(db, { accountId: 'jia', code: currentCode(enrolled.secretBase32), now: NOW }).ok).toBe(true)
    expect(activateTotp(db, enrolled.factorId, NOW)).toBe(true)
    expect(hasActiveFactor(db, 'jia')).toBe(true)
  })

  it('每次登记的密钥都不一样', () => {
    expect(enroll().secretBase32).not.toBe(enroll().secretBase32)
  })
})

describe('TOTP 校验', () => {
  it('正确的码通过', () => {
    const enrolled = enroll()
    expect(
      verifyTotpFactor(db, { accountId: 'jia', code: currentCode(enrolled.secretBase32), now: NOW })
        .ok,
    ).toBe(true)
  })

  it('同一个码用第二次被拒（§8 的重放防护）', () => {
    // 不拒的话，一个被肩窥到或从截图里读到的验证码在 90 秒内可以反复使用
    const enrolled = enroll()
    const code = currentCode(enrolled.secretBase32)
    expect(verifyTotpFactor(db, { accountId: 'jia', code, now: NOW }).ok).toBe(true)

    const replay = verifyTotpFactor(db, { accountId: 'jia', code, now: NOW })
    expect(replay.ok).toBe(false)
    expect(replay.ok === false && replay.errorCode).toBe('REPLAYED')
  })

  it('重放与「码不对」是不同的错误码', () => {
    // 对**用户**是不同的下一步：一个是「换一个码」，另一个是「等 30 秒」。
    // 这不违反「不区分存在性」—— 两者都发生在已经证明持有该因素之后
    const enrolled = enroll()
    const code = currentCode(enrolled.secretBase32)
    verifyTotpFactor(db, { accountId: 'jia', code, now: NOW })

    const wrong = verifyTotpFactor(db, { accountId: 'jia', code: '000000', now: NOW })
    expect(wrong.ok === false && wrong.errorCode).toBe('UNAUTHENTICATED')
  })

  it('没启用第二因素与码不对返回同一个错误码（§8）', () => {
    // 区分开就能拿它枚举哪些账号启用了 2FA —— 那正好是攻击者挑目标的依据
    const none = verifyTotpFactor(db, { accountId: 'jia', code: '000000', now: NOW })
    const enrolled = enroll()
    const wrong = verifyTotpFactor(db, { accountId: 'jia', code: '000000', now: NOW })

    expect(none.ok).toBe(false)
    expect(wrong.ok).toBe(false)
    expect(none.ok === false && none.errorCode).toBe(wrong.ok === false && wrong.errorCode)
    expect(enrolled.factorId.length).toBeGreaterThan(0)
  })

  it('验码失败不写重放表 —— 否则能被拿来撑爆它', () => {
    // 先查重放再验码的话，随便乱猜的码也会写一行，攻击者能借此把受害者的
    // 重放表撑大
    enroll()
    for (let i = 0; i < 5; i += 1) {
      verifyTotpFactor(db, { accountId: 'jia', code: '000000', now: NOW })
    }
    const count = db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('已消费步的清理', () => {
  it('只清窗口之外的', () => {
    // 清掉窗口内的等于把重放保护关掉一段时间，而那正是保护要覆盖的时间
    const enrolled = enroll()
    verifyTotpFactor(db, { accountId: 'jia', code: currentCode(enrolled.secretBase32), now: NOW })

    expect(pruneUsedSteps(db, NOW)).toBe(0)
    const stillThere = db.prepare('SELECT COUNT(*) AS c FROM totp_used_steps').get() as { c: number }
    expect(stillThere.c).toBe(1)
  })

  it('久远的步会被清掉', () => {
    const enrolled = enroll()
    verifyTotpFactor(db, { accountId: 'jia', code: currentCode(enrolled.secretBase32), now: NOW })

    const muchLater = new Date(NOW.getTime() + 60 * 60_000)
    expect(pruneUsedSteps(db, muchLater)).toBe(1)
  })
})

describe('一次性备用码', () => {
  it('签发一组，明文只返回一次', () => {
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
  })

  it('库里只有哈希，查不到明文（§8）', () => {
    // 存明文等于把「第二因素」降级成「第一.五因素」—— 库被读走时它和
    // 密码一起丢
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    const dump = JSON.stringify(db.prepare('SELECT * FROM recovery_codes').all())
    for (const code of codes) {
      expect(dump, '库里出现了明文备用码').not.toContain(normalizeCode(code))
      expect(dump).not.toContain(code)
    }
  })

  it('消费一次就失效', () => {
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    const first = codes[0] as string
    expect(consumeRecoveryCode(db, { accountId: 'jia', code: first, now: NOW }).ok).toBe(true)
    expect(consumeRecoveryCode(db, { accountId: 'jia', code: first, now: NOW }).ok).toBe(false)
  })

  it('消费不删行 —— 审计要能回答哪张码什么时候被用掉', () => {
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    consumeRecoveryCode(db, { accountId: 'jia', code: codes[0] as string, now: NOW })
    const count = db.prepare('SELECT COUNT(*) AS c FROM recovery_codes').get() as { c: number }
    expect(count.c).toBe(RECOVERY_CODE_COUNT)
  })

  it('剩余数量低于阈值时提示重新生成（§8）', () => {
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    let last: { remaining: number; lowWatermark: boolean } | undefined
    for (const code of codes.slice(0, RECOVERY_CODE_COUNT - RECOVERY_CODE_LOW_WATERMARK)) {
      const result = consumeRecoveryCode(db, { accountId: 'jia', code, now: NOW })
      if (result.ok) last = result.value
    }
    expect(last?.remaining).toBe(RECOVERY_CODE_LOW_WATERMARK)
    expect(last?.lowWatermark).toBe(false)

    const next = consumeRecoveryCode(db, {
      accountId: 'jia',
      code: codes[RECOVERY_CODE_COUNT - RECOVERY_CODE_LOW_WATERMARK] as string,
      now: NOW,
    })
    expect(next.ok && next.value.lowWatermark).toBe(true)
  })

  it('重新签发作废旧的全部', () => {
    // 留着旧的话，用户以为自己换了一套，而那张丢了的纸仍然能用 ——
    // 「重新生成」这个动作就白做了
    const first = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    expect(consumeRecoveryCode(db, { accountId: 'jia', code: first.codes[0] as string, now: NOW }).ok).toBe(
      false,
    )
  })

  it('带不带短横、大小写都认', () => {
    // 用户此刻正处在「第二因素用不了」的窘境里，为格式报错是纯粹的刁难
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    const messy = (codes[0] as string).toLowerCase().replace(/-/g, ' ')
    expect(consumeRecoveryCode(db, { accountId: 'jia', code: messy, now: NOW }).ok).toBe(true)
  })

  it('别人的码用不了', () => {
    db.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)').run(
      'yi',
      '乙',
      NOW.toISOString(),
    )
    const { codes } = issueRecoveryCodes(db, { accountId: 'jia', now: NOW })
    expect(consumeRecoveryCode(db, { accountId: 'yi', code: codes[0] as string, now: NOW }).ok).toBe(
      false,
    )
  })
})

describe('撤销因素', () => {
  it('撤销后不再是 active', () => {
    const enrolled = enroll()
    verifyTotpFactor(db, { accountId: 'jia', code: currentCode(enrolled.secretBase32), now: NOW })
    activateTotp(db, enrolled.factorId, NOW)

    expect(revokeFactor(db, enrolled.factorId, NOW)).toBe(true)
    expect(hasActiveFactor(db, 'jia')).toBe(false)
  })

  it('保留行 —— 关掉第二因素恰恰是最值得追查的动作', () => {
    const enrolled = enroll()
    revokeFactor(db, enrolled.factorId, NOW)
    const row = db
      .prepare('SELECT state, revoked_at FROM second_factors WHERE factor_id = ?')
      .get(enrolled.factorId) as { state: string; revoked_at: string }
    expect(row.state).toBe('revoked')
    expect(row.revoked_at).toBe(NOW.toISOString())
  })

  it('重复撤销是空操作', () => {
    const enrolled = enroll()
    expect(revokeFactor(db, enrolled.factorId, NOW)).toBe(true)
    expect(revokeFactor(db, enrolled.factorId, NOW)).toBe(false)
  })
})
