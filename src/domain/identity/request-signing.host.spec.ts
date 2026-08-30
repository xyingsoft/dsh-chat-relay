/**
 * 请求签名与设备注册测试。
 *
 * §45 要求「每条拒绝路径都有聚焦用例」。§7.1 列了五条拒绝理由 ——
 * 过期时间戳、重复 nonce、未注册或被限制设备、错误的 relay 指纹、
 * 与凭证账号不一致的声明发送者 —— 每条各有一个用例。
 *
 * 另有几条用例针对的不是「拒绝对不对」，而是「拒绝的**顺序**对不对」：
 * §7.1 规定 `TIME_SKEW` 只在其他条件都正确时返回，顺序错了会把服务器时间
 * 送给任何伪造签名的人。
 */

import { sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deviceOf,
  fingerprintOf,
  generateDeviceKeyPair,
  registerDevice,
  setDeviceState,
  type DeviceKeyPair,
} from './device-registration.js'
import {
  DEFAULT_SKEW_TOLERANCE_MS,
  bodyDigestOf,
  pruneExpiredNonces,
  signingPayload,
  verifySignedRequest,
  type SignedRequest,
  type VerificationContext,
} from './request-signing.js'

let db: DatabaseSync
let keys: DeviceKeyPair

const RELAY_FINGERPRINT = 'a'.repeat(64)
const NOW = new Date('2026-08-30T12:00:00.000Z')

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE accounts (account_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      signing_public_key TEXT NOT NULL,
      agreement_public_key TEXT,
      key_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_account_state_seq INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE request_nonces (
      device_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (device_id, nonce)
    ) STRICT;
  `)
  db.prepare('INSERT INTO accounts VALUES (?)').run('acct-jia')
  db.prepare('INSERT INTO accounts VALUES (?)').run('acct-yi')

  keys = generateDeviceKeyPair()
  registerDevice(db, {
    deviceId: 'dev-1',
    accountId: 'acct-jia',
    deviceName: '甲的笔记本',
    signingPublicKey: keys.publicKeyBase64,
    registeredAt: NOW,
  })
})

afterEach(() => db.close())

function request(overrides: Partial<SignedRequest> = {}): SignedRequest {
  return {
    method: 'POST',
    path: '/api/chat/messages',
    bodyDigest: bodyDigestOf('{"body":"你好"}'),
    timestamp: NOW.getTime(),
    nonce: `nonce-${Math.random()}`,
    deviceId: 'dev-1',
    organizationId: 'org-1',
    relayFingerprint: RELAY_FINGERPRINT,
    ...overrides,
  }
}

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    now: NOW,
    relayFingerprint: RELAY_FINGERPRINT,
    authenticatedAccountId: 'acct-jia',
    ...overrides,
  }
}

/** 用给定私钥签名。默认用注册设备的那把。 */
function signWith(req: SignedRequest, privateKey = keys.privateKey): string {
  return sign(null, signingPayload(req), privateKey).toString('base64')
}

describe('设备注册', () => {
  it('注册后可按 DeviceId 查到公钥与指纹', () => {
    const device = deviceOf(db, 'dev-1')
    expect(device?.accountId).toBe('acct-jia')
    expect(device?.signingPublicKey).toBe(keys.publicKeyBase64)
    expect(device?.state).toBe('active')
  })

  it('指纹由服务端从公钥算出，不采信客户端声明', () => {
    // 若采信客户端提交的指纹，攻击者就能提交「公钥 A + 公钥 B 的指纹」，
    // 让后续对指纹的检查指向一把它并不持有私钥的密钥
    expect(deviceOf(db, 'dev-1')?.keyFingerprint).toBe(fingerprintOf(keys.publicKeyBase64))
  })

  it('数据库中不含任何私钥字节', () => {
    // §7：「设备私钥永远不上传至 relay」。这条靠注释守不住，直接查全表
    const privateDer = keys.privateKey.export({ type: 'pkcs8', format: 'der' })
    const rows = db.prepare('SELECT * FROM devices').all() as Array<Record<string, unknown>>
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(privateDer.toString('base64'))
    expect(dump).not.toContain(privateDer.toString('hex'))
  })

  it('重复注册同一 DeviceId 被拒绝', () => {
    const result = registerDevice(db, {
      deviceId: 'dev-1',
      accountId: 'acct-jia',
      deviceName: '冒名',
      signingPublicKey: generateDeviceKeyPair().publicKeyBase64,
      registeredAt: NOW,
    })
    expect(result).toEqual({ ok: false, error: 'DEVICE_ALREADY_REGISTERED' })
    // 原公钥未被覆盖 —— 否则任何人都能用重复注册顶掉他人的设备密钥
    expect(deviceOf(db, 'dev-1')?.signingPublicKey).toBe(keys.publicKeyBase64)
  })

  it('为不存在的账号注册被拒绝', () => {
    const result = registerDevice(db, {
      deviceId: 'dev-x',
      accountId: 'acct-nobody',
      deviceName: '幽灵',
      signingPublicKey: generateDeviceKeyPair().publicKeyBase64,
      registeredAt: NOW,
    })
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_NOT_FOUND' })
  })

  it('撤销后不能被改回可用状态', () => {
    // §7：DEVICE_REVOKED 的幂等语义是「需重新注册设备」。若能复活，
    // 一台被判定为失窃的设备就能被同一条管理路径悄悄放回来
    expect(setDeviceState(db, 'dev-1', 'revoked', NOW)).toBe(true)
    expect(setDeviceState(db, 'dev-1', 'active', NOW)).toBe(false)
    expect(deviceOf(db, 'dev-1')?.state).toBe('revoked')
  })
})

describe('签名验证通过', () => {
  it('合法签名通过，并返回设备', () => {
    const req = request()
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.device.deviceId).toBe('dev-1')
  })

  it('容忍窗口边界内通过', () => {
    const req = request({ timestamp: NOW.getTime() - DEFAULT_SKEW_TOLERANCE_MS })
    expect(verifySignedRequest(db, req, signWith(req), context()).ok).toBe(true)
  })
})

describe('§7.1 的五条拒绝路径', () => {
  it('过期时间戳 → TIME_SKEW，且带出服务器时间与允许窗口', () => {
    const req = request({ timestamp: NOW.getTime() - DEFAULT_SKEW_TOLERANCE_MS - 1 })
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('TIME_SKEW')
    if (result.failure.code !== 'TIME_SKEW') return
    // §7.1：返回签名的服务器时间和允许窗口，供 host 计算临时偏移量
    expect(result.failure.serverTime).toBe(NOW.toISOString())
    expect(result.failure.toleranceMs).toBe(DEFAULT_SKEW_TOLERANCE_MS)
  })

  it('未来方向的偏移同样被检测', () => {
    // 「正负 5 分钟」是双向的。只查一边的话，把时钟调快就能预生成签名，
    // 扩大重放窗口
    const req = request({ timestamp: NOW.getTime() + DEFAULT_SKEW_TOLERANCE_MS + 1 })
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('TIME_SKEW')
  })

  it('重复 nonce → 被拒', () => {
    const req = request({ nonce: 'fixed-nonce' })
    const signature = signWith(req)
    expect(verifySignedRequest(db, req, signature, context()).ok).toBe(true)
    // 一字不差的重放
    const replay = verifySignedRequest(db, req, signature, context())
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.failure.code).toBe('UNAUTHENTICATED')
  })

  it('不同设备可以用同一个 nonce 值', () => {
    // nonce 由各设备自行生成，两台设备偶然撞值不该让后者被判为重放
    const other = generateDeviceKeyPair()
    registerDevice(db, {
      deviceId: 'dev-2',
      accountId: 'acct-jia',
      deviceName: '甲的手机',
      signingPublicKey: other.publicKeyBase64,
      registeredAt: NOW,
    })
    const a = request({ nonce: 'same', deviceId: 'dev-1' })
    const b = request({ nonce: 'same', deviceId: 'dev-2' })
    expect(verifySignedRequest(db, a, signWith(a), context()).ok).toBe(true)
    expect(verifySignedRequest(db, b, signWith(b, other.privateKey), context()).ok).toBe(true)
  })

  it('未注册设备 → UNAUTHENTICATED，且不透露设备是否存在', () => {
    const req = request({ deviceId: 'dev-unknown' })
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 与「签名错误」同一个错误码 —— 区分开就等于一个设备存在性探测接口
    expect(result.failure.code).toBe('UNAUTHENTICATED')
  })

  it('受限设备 → DEVICE_RESTRICTED', () => {
    setDeviceState(db, 'dev-1', 'restricted', NOW)
    const req = request()
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('DEVICE_RESTRICTED')
  })

  it('已撤销设备 → DEVICE_REVOKED（与受限区分）', () => {
    // 两者可重试性不同：restricted 是 conditional（处置后可重试），
    // revoked 是 terminal（需重新注册）。混为一谈会让客户端做错重试决策
    setDeviceState(db, 'dev-1', 'revoked', NOW)
    const req = request()
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('DEVICE_REVOKED')
  })

  it('错误的 relay 指纹 → SERVER_IDENTITY_MISMATCH', () => {
    const req = request({ relayFingerprint: 'b'.repeat(64) })
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('SERVER_IDENTITY_MISMATCH')
  })

  it('声明发送者与凭证账号不一致 → UNAUTHENTICATED', () => {
    // token 说你是乙，设备属于甲 —— token 与设备来自不同的人
    const req = request()
    const result = verifySignedRequest(
      db,
      req,
      signWith(req),
      context({ authenticatedAccountId: 'acct-yi' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('UNAUTHENTICATED')
  })
})

describe('签名覆盖全部要素', () => {
  // 每个要素都单独验一遍：漏签任何一个，攻击者就能改动那一项而签名依然有效
  const tampering: ReadonlyArray<readonly [string, Partial<SignedRequest>]> = [
    ['方法', { method: 'DELETE' }],
    ['路径', { path: '/api/chat/work-items' }],
    ['请求体摘要', { bodyDigest: bodyDigestOf('{"body":"改过的正文"}') }],
    ['时间戳', { timestamp: NOW.getTime() - 1000 }],
    ['nonce', { nonce: 'another-nonce' }],
    ['目标组织', { organizationId: 'org-2' }],
  ]

  for (const [label, mutation] of tampering) {
    it(`改动${label}会使签名失效`, () => {
      const original = request()
      const signature = signWith(original)
      const tampered = { ...original, ...mutation }
      const result = verifySignedRequest(db, tampered, signature, context())
      expect(result.ok, `改动${label}后签名仍然通过`).toBe(false)
    })
  }

  it('改动 DeviceId 会使签名失效', () => {
    // 单独一条：换 DeviceId 同时要有那台设备存在，否则会先被「未注册」挡掉，
    // 测不到签名这一层
    const other = generateDeviceKeyPair()
    registerDevice(db, {
      deviceId: 'dev-2',
      accountId: 'acct-jia',
      deviceName: '甲的手机',
      signingPublicKey: other.publicKeyBase64,
      registeredAt: NOW,
    })
    const original = request({ deviceId: 'dev-1' })
    const signature = signWith(original)
    const result = verifySignedRequest(db, { ...original, deviceId: 'dev-2' }, signature, context())
    expect(result.ok).toBe(false)
  })

  it('用别的设备的私钥签名不能通过', () => {
    const attacker = generateDeviceKeyPair()
    const req = request()
    const result = verifySignedRequest(db, req, signWith(req, attacker.privateKey), context())
    expect(result.ok).toBe(false)
  })

  it('畸形签名当作验证失败而非抛异常', () => {
    // 畸形输入是攻击面的常态，不是程序错误
    const req = request()
    for (const bogus of ['', 'not-base64!!!', 'AAAA', 'x'.repeat(200)]) {
      const result = verifySignedRequest(db, request({ nonce: bogus + req.nonce }), bogus, context())
      expect(result.ok).toBe(false)
    }
  })
})

describe('分隔符注入', () => {
  it('要素边界不可被移动', () => {
    // 若直接拼接，path=/a/b + nonce=c 与 path=/a + nonce=/bc 会得到同一串。
    // 这两个请求必须有不同的待签名字节
    const a = signingPayload(request({ path: '/a/b', nonce: 'c' }))
    const b = signingPayload(request({ path: '/a', nonce: '/bc' }))
    expect(a.equals(b)).toBe(false)
  })

  it('含换行的要素被直接拒绝而不是悄悄签进去', () => {
    // 换行是分隔符。让它进入要素值，注入就重新成为可能
    expect(() => signingPayload(request({ path: '/a\nPOST' }))).toThrow(/不得含换行/)
  })

  it('待签名内容带域分隔前缀', () => {
    // 即便某天设备私钥被用于签别的东西，那些签名也不会碰巧成为合法的请求证明
    expect(signingPayload(request()).toString('utf8').startsWith('dsh-chat/1\n')).toBe(true)
  })
})

describe('检查顺序', () => {
  it('签名无效时返回 UNAUTHENTICATED 而不是 TIME_SKEW', () => {
    // §7.1：TIME_SKEW 只在「签名、nonce 和设备指纹其他条件正确时」返回。
    // 顺序反过来的话，任何人拿一个垃圾签名 + 一个离谱时间戳，就能换到
    // 一份服务器时间 —— 等于一个免认证的时间预言机
    const req = request({ timestamp: NOW.getTime() - 10 * 60 * 1000 })
    const result = verifySignedRequest(db, req, 'AAAA', context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('UNAUTHENTICATED')
  })

  it('签名无效时不记录 nonce', () => {
    // 否则攻击者能用垃圾签名把受害设备的 nonce 空间填满，
    // 让其真实请求被判为重放
    const req = request({ nonce: 'victim-nonce' })
    verifySignedRequest(db, req, 'AAAA', context())

    const legit = request({ nonce: 'victim-nonce' })
    expect(verifySignedRequest(db, legit, signWith(legit), context()).ok).toBe(true)
  })

  it('时间超窗时不记录 nonce', () => {
    // 该 nonce 从未被真正使用过。记下来的话，host 按服务器时间修正偏移后
    // 用同一 nonce 重试（§7.1 明说要修正后重试）会被判为重放
    const skewed = request({ nonce: 'retry-nonce', timestamp: NOW.getTime() - 10 * 60 * 1000 })
    verifySignedRequest(db, skewed, signWith(skewed), context())

    const corrected = request({ nonce: 'retry-nonce' })
    expect(verifySignedRequest(db, corrected, signWith(corrected), context()).ok).toBe(true)
  })

  it('设备被撤销时不记录 nonce', () => {
    setDeviceState(db, 'dev-1', 'revoked', NOW)
    const req = request({ nonce: 'n' })
    verifySignedRequest(db, req, signWith(req), context())
    const count = db.prepare('SELECT COUNT(*) AS c FROM request_nonces').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('nonce 账本清理', () => {
  it('删除两倍窗口之前的记录，保留窗口内的', () => {
    const old = new Date(NOW.getTime() - 30 * 60 * 1000)
    const recent = new Date(NOW.getTime() - 60 * 1000)
    db.prepare('INSERT INTO request_nonces VALUES (?, ?, ?)').run('dev-1', 'old', old.toISOString())
    db.prepare('INSERT INTO request_nonces VALUES (?, ?, ?)').run(
      'dev-1',
      'recent',
      recent.toISOString(),
    )

    expect(pruneExpiredNonces(db, NOW)).toBe(1)
    const rows = db.prepare('SELECT nonce FROM request_nonces').all() as Array<{ nonce: string }>
    expect(rows.map((r) => r.nonce)).toEqual(['recent'])
  })

  it('清理不会让已过期的 nonce 变得可重放', () => {
    // 清掉的 nonce 对应的时间戳早已超窗，携带它的请求会先被 TIME_SKEW 挡掉
    const staleTimestamp = NOW.getTime() - 30 * 60 * 1000
    const req = request({ nonce: 'stale', timestamp: staleTimestamp })
    pruneExpiredNonces(db, NOW)
    const result = verifySignedRequest(db, req, signWith(req), context())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('TIME_SKEW')
  })
})
