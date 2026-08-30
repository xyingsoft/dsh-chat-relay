/**
 * TOTP（RFC 6238）。
 *
 * §8：「`totp`（RFC 6238，**30 秒步长，容忍前后各一步**）」。
 *
 * ## 为什么手写而不是引库
 *
 * 算法本身是三十行：HMAC-SHA1、动态截断、取模。引一个库的代价不是这三十行，
 * 是**把账号安全的一环交给一个不受本仓库测试约束的依赖** —— 而这一环出错的
 * 表现是「验证码总是不对」或者更糟「什么码都能过」。
 *
 * Base32 也一样：认证器 App 的密钥交换只认 Base32，而 Node 没有内置。
 *
 * ## SHA-1 不是疏忽
 *
 * RFC 6238 默认 HMAC-SHA1，几乎所有认证器 App 也只实现了它。这里的 SHA-1
 * 用在 HMAC 里，抗碰撞性不参与安全论证 —— 换成 SHA-256 会得到一个更「现代」
 * 但**用户扫不进去**的实现。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** §8：30 秒步长。 */
export const TOTP_STEP_SECONDS = 30
/** §8：容忍前后各一步。 */
export const TOTP_TOLERANCE_STEPS = 1
/** 六位。认证器 App 的通用长度。 */
export const TOTP_DIGITS = 6

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * 把密钥编成 Base32（RFC 4648，不带 padding）。
 *
 * 不带 `=` 补位：`otpauth://` URI 里带 padding 会被一部分认证器 App 拒掉，
 * 而它们不会说为什么。
 */
export function toBase32(secret: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of secret) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/**
 * 解回字节。
 *
 * 大小写不敏感，忽略空格与 `-`：用户从认证器界面复制密钥时经常带上分组
 * 空格，为此报「密钥无效」是纯粹的刁难。
 */
export function fromBase32(encoded: string): Uint8Array {
  const cleaned = encoded.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error(`不是合法的 Base32 字符：${character}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(bytes)
}

/** 时刻对应的计数器步数。 */
export function stepAt(now: Date, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / stepSeconds)
}

/**
 * 算某一步的验证码。
 *
 * 动态截断取自 RFC 4226 §5.3：用摘要最后一个字节的低四位当偏移量，
 * 从那里取四字节、抹掉最高位（避免有符号解读），再对 10^digits 取模。
 */
export function codeAtStep(
  secret: Uint8Array,
  step: number,
  digits: number = TOTP_DIGITS,
): string {
  const counter = Buffer.alloc(8)
  // 步数会超过 32 位（2038 年之前不会，但写死 32 位是一个会到期的 bug）
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', Buffer.from(secret)).update(counter).digest()

  const offset = (digest[digest.length - 1] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

export interface VerifyResult {
  readonly ok: boolean
  /**
   * 通过时是被接受的那一步。
   *
   * 调用方**必须**把它记下来并拒绝重放（§8：「TOTP 已消费的时间步在容忍
   * 窗口内记录并拒绝重放」）。不记的话，一个被肩窥到的验证码在 90 秒内
   * 可以被反复使用。
   */
  readonly step?: number
}

/**
 * 校验一个验证码。
 *
 * 遍历容忍窗口内的每一步都算一遍并做**定长比较**。提前 return 会让「第一步
 * 就对」和「最后一步才对」耗时不同，那是一个可测量的侧信道 —— 虽然它泄露的
 * 只是时钟偏移量，但代价是零，没有理由留着。
 */
export function verifyTotp(
  secret: Uint8Array,
  presented: string,
  now: Date,
  options: { toleranceSteps?: number; stepSeconds?: number; digits?: number } = {},
): VerifyResult {
  const tolerance = options.toleranceSteps ?? TOTP_TOLERANCE_STEPS
  const digits = options.digits ?? TOTP_DIGITS
  const current = stepAt(now, options.stepSeconds ?? TOTP_STEP_SECONDS)

  // 长度不对直接判否。这一条不走定长比较也没关系：验证码长度是公开的
  if (presented.length !== digits) return { ok: false }

  let matched: number | undefined
  for (let delta = -tolerance; delta <= tolerance; delta += 1) {
    const step = current + delta
    if (constantTimeEquals(codeAtStep(secret, step, digits), presented)) {
      matched = step
    }
  }
  return matched === undefined ? { ok: false } : { ok: true, step: matched }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 生成 `otpauth://` URI，供认证器扫码。
 *
 * `issuer` 同时放进 label 前缀和查询参数：前者是老客户端认的，后者是新的。
 * 只放一个的话，一部分 App 会显示成「未知服务」下的一串账号 —— 用户装了
 * 三个服务之后就分不清哪个码是哪个了。
 */
export function otpauthUri(input: {
  secretBase32: string
  accountLabel: string
  issuer: string
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountLabel}`)
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
