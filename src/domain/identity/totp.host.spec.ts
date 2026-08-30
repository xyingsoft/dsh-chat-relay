/**
 * TOTP 测试。
 *
 * 核心是 **RFC 6238 附录 B 的官方测试向量**。自洽测试（自己算一遍再自己验
 * 一遍）对这个算法几乎没有价值 —— 一个把动态截断写错的实现同样自洽，只是
 * 和全世界的认证器 App 都对不上，而那个症状是「用户说验证码总是错的」。
 *
 * 向量用的是 8 位码和 ASCII 密钥 `12345678901234567890`；生产用 6 位，
 * 位数只影响最后那一次取模。
 */

import { describe, expect, it } from 'vitest'

import {
  TOTP_STEP_SECONDS,
  codeAtStep,
  fromBase32,
  otpauthUri,
  stepAt,
  toBase32,
  verifyTotp,
} from './totp.js'

/** RFC 6238 附录 B 的 SHA-1 密钥：ASCII "12345678901234567890"。 */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890')

/** [Unix 秒, 期望的 8 位码]，取自 RFC 6238 附录 B 的 SHA1 行。 */
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
]

describe('RFC 6238 官方测试向量', () => {
  it.each(RFC_VECTORS)('T=%i → %s', (seconds, expected) => {
    const step = stepAt(new Date(seconds * 1000))
    expect(codeAtStep(RFC_SECRET, step, 8)).toBe(expected)
  })

  it('最后一条向量超过 32 位步数仍然对', () => {
    // 20000000000 秒 / 30 ≈ 6.7 亿，还在 32 位内；但计数器按 64 位写
    // 才是协议要求的。写死 32 位是一个会到期的 bug，这里顺手钉一下
    const step = stepAt(new Date(20_000_000_000 * 1000))
    expect(step).toBeGreaterThan(0)
    expect(codeAtStep(RFC_SECRET, step, 8)).toBe('65353130')
  })
})

describe('步长', () => {
  it('30 秒一步（§8）', () => {
    expect(TOTP_STEP_SECONDS).toBe(30)
    expect(stepAt(new Date(29_000))).toBe(0)
    expect(stepAt(new Date(30_000))).toBe(1)
  })
})

describe('Base32', () => {
  it('编回来解回去是同一串字节', () => {
    const secret = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect([...fromBase32(toBase32(secret))]).toEqual([...secret])
  })

  it('不带 padding', () => {
    // otpauth:// URI 里带 = 会被一部分认证器 App 拒掉，且不说为什么
    expect(toBase32(Uint8Array.from([1]))).not.toContain('=')
  })

  it('解析时忽略空格与短横、不分大小写', () => {
    // 用户从认证器界面复制密钥时经常带上分组空格
    const canonical = toBase32(new TextEncoder().encode('hello'))
    const messy = canonical.toLowerCase().replace(/(.{4})/g, '$1 ')
    expect([...fromBase32(messy)]).toEqual([...fromBase32(canonical)])
  })

  it('非法字符抛异常，不静默产生一串错的字节', () => {
    // 静默的话，用户粘错一个字符会得到「验证码总是不对」而不是「密钥无效」
    expect(() => fromBase32('ABCD!')).toThrow()
  })
})

describe('校验', () => {
  const at = (seconds: number) => new Date(seconds * 1000)

  it('当前这一步通过', () => {
    const now = at(1_111_111_111)
    const code = codeAtStep(RFC_SECRET, stepAt(now), 6)
    expect(verifyTotp(RFC_SECRET, code, now)).toEqual({ ok: true, step: stepAt(now) })
  })

  it('前后各一步都通过（§8 的容忍窗口）', () => {
    const now = at(1_111_111_111)
    const current = stepAt(now)
    for (const delta of [-1, 1]) {
      const code = codeAtStep(RFC_SECRET, current + delta, 6)
      expect(verifyTotp(RFC_SECRET, code, now), `delta=${delta}`).toEqual({
        ok: true,
        step: current + delta,
      })
    }
  })

  it('两步之外不通过', () => {
    // 窗口开太大等于延长一个被肩窥到的码的可用时间
    const now = at(1_111_111_111)
    const code = codeAtStep(RFC_SECRET, stepAt(now) + 2, 6)
    expect(verifyTotp(RFC_SECRET, code, now).ok).toBe(false)
  })

  it('返回被接受的那一步 —— 调用方要拿它去防重放', () => {
    // 不返回的话，调用方无从记录「这个码用过了」，一个码在 90 秒内能反复用
    const now = at(1_111_111_111)
    const previous = stepAt(now) - 1
    expect(verifyTotp(RFC_SECRET, codeAtStep(RFC_SECRET, previous, 6), now).step).toBe(previous)
  })

  it('位数不对直接判否', () => {
    expect(verifyTotp(RFC_SECRET, '123', at(1_111_111_111)).ok).toBe(false)
    expect(verifyTotp(RFC_SECRET, '12345678', at(1_111_111_111)).ok).toBe(false)
  })

  it('换一个密钥就不通过', () => {
    const now = at(1_111_111_111)
    const code = codeAtStep(RFC_SECRET, stepAt(now), 6)
    const other = new TextEncoder().encode('09876543210987654321')
    expect(verifyTotp(other, code, now).ok).toBe(false)
  })
})

describe('otpauth URI', () => {
  const uri = otpauthUri({ secretBase32: 'JBSWY3DPEHPK3PXP', accountLabel: '甲', issuer: 'DSH Chat' })

  it('issuer 同时出现在 label 前缀和查询参数里', () => {
    // 只放一个的话，一部分 App 会显示成「未知服务」下的一串账号 ——
    // 装了三个服务之后就分不清哪个码是哪个了
    expect(uri).toContain(encodeURIComponent('DSH Chat:甲'))
    expect(uri).toContain('issuer=DSH+Chat')
  })

  it('声明算法、位数与周期', () => {
    // 不声明的话，默认值不一致的 App 会算出对不上的码
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('是一个能被 URL 解析的 otpauth://', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(() => new URL(uri)).not.toThrow()
  })
})
