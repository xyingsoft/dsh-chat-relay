/**
 * 私聊投递测试。
 *
 * 覆盖 §28 中最容易实现错、且错了之后很难察觉的几条：幂等重放、队列满的时机、
 * 不淘汰未 ACK 消息、租约按设备而非按账号、ACK 前崩溃后重投。
 *
 * 这些对应[骨架](../../../../docs/04-roadmap/02-minimum-skeleton.md)第 7、9、11 步。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from '../../storage/database.js'

import { acceptContactRequest, block, checkDirectMessageGate, createContactRequest } from './contacts.js'
import { acceptDirectMessage, acknowledge, leaseBatch, watermarkOf } from './delivery.js'

let chat: ChatDatabase
const now = new Date('2026-08-30T00:00:00Z')
const ORG = 'org-1'

beforeEach(() => {
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('alice', '甲', now.toISOString())
    insert.run('bob', '乙', now.toISOString())
    insert.run('carol', '丙', now.toISOString())
  })
})

afterEach(() => chat.close())

function makeContacts(a: string, b: string): void {
  chat.transaction((db) => {
    createContactRequest(db, {
      requestId: `req-${a}-${b}`,
      organizationId: ORG,
      requesterId: a,
      targetId: b,
      now,
    })
    acceptContactRequest(db, { requestId: `req-${a}-${b}`, now })
  })
}

function send(
  messageId: string,
  body = '你好',
  capacity = 100,
  sender = 'alice',
  recipient = 'bob',
): ReturnType<typeof acceptDirectMessage> {
  return chat.transaction((db) =>
    acceptDirectMessage(db, {
      messageId,
      organizationId: ORG,
      senderId: sender,
      recipientId: recipient,
      body,
      operationId: `op-${messageId}`,
      now,
      queueCapacity: capacity,
    }),
  )
}

describe('准入判定（§13 的表达式）', () => {
  it('无联系人关系时拒绝', () => {
    const gate = checkDirectMessageGate(chat.readonlyHandle, {
      organizationId: ORG,
      senderId: 'alice',
      recipientId: 'bob',
    })
    expect(gate.allowed).toBe(false)
  })

  it('建立联系人后允许', () => {
    makeContacts('alice', 'bob')
    expect(
      checkDirectMessageGate(chat.readonlyHandle, {
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
      }).allowed,
    ).toBe(true)
  })

  it('对方拉黑我时拒绝', () => {
    makeContacts('alice', 'bob')
    chat.transaction((db) => block(db, { organizationId: ORG, actorId: 'bob', subjectId: 'alice', now }))
    expect(
      checkDirectMessageGate(chat.readonlyHandle, {
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
      }).allowed,
    ).toBe(false)
  })

  it('我拉黑对方时也拒绝——两个方向都要检查', () => {
    // 只检查「对方是否拉黑了我」会让被我拉黑的人仍能给我发消息
    makeContacts('alice', 'bob')
    chat.transaction((db) => block(db, { organizationId: ORG, actorId: 'alice', subjectId: 'bob', now }))
    expect(
      checkDirectMessageGate(chat.readonlyHandle, {
        organizationId: ORG,
        senderId: 'bob',
        recipientId: 'alice',
      }).allowed,
    ).toBe(false)
  })

  it('被拉黑与未建立联系人返回同一错误码', () => {
    // §13：被拉黑时不提示差异
    makeContacts('alice', 'bob')
    chat.transaction((db) => block(db, { organizationId: ORG, actorId: 'bob', subjectId: 'alice', now }))
    const blocked = checkDirectMessageGate(chat.readonlyHandle, {
      organizationId: ORG,
      senderId: 'alice',
      recipientId: 'bob',
    })
    const noContact = checkDirectMessageGate(chat.readonlyHandle, {
      organizationId: ORG,
      senderId: 'alice',
      recipientId: 'carol',
    })
    expect(blocked).toMatchObject({ errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
    expect(noContact).toMatchObject({ errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })
})

describe('接收与幂等', () => {
  it('消息与队列项在同一事务写入，DeliverySeq 从 1 开始单调递增', () => {
    makeContacts('alice', 'bob')
    expect(send('m-1')).toMatchObject({ ok: true, deliverySeq: 1, idempotentReplay: false })
    expect(send('m-2')).toMatchObject({ ok: true, deliverySeq: 2, idempotentReplay: false })
  })

  it('同一 (senderId, messageId) 重试返回首次结果，不新增', () => {
    // §14：relay 以 (senderAccountId, MessageId) 为幂等键，重试返回首次接收结果
    makeContacts('alice', 'bob')
    const first = send('m-1')
    const retry = send('m-1')
    expect(retry).toMatchObject({ ok: true, idempotentReplay: true })
    expect(retry).toMatchObject({ deliverySeq: (first as { deliverySeq: number }).deliverySeq })

    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM messages')
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('高水位随接收推进且不回退', () => {
    makeContacts('alice', 'bob')
    send('m-1')
    send('m-2')
    const mark = watermarkOf(chat.readonlyHandle, ORG, 'bob')
    expect(mark.highWatermark).toBe(2)
    expect(mark.streamEpoch).toBe(1)
  })
})

describe('队列容量', () => {
  it('达到容量后新发送被拒绝，返回 RECIPIENT_QUEUE_FULL', () => {
    makeContacts('alice', 'bob')
    send('m-1', '一', 2)
    send('m-2', '二', 2)
    const third = send('m-3', '三', 2)
    expect(third).toMatchObject({ ok: false, errorCode: 'RECIPIENT_QUEUE_FULL', pendingCount: 2 })
  })

  it('拒绝发生在写入之前——被拒的消息完全不存在', () => {
    // §28：relay 必须在接收新消息前拒绝。「发送未被接收」是该错误码的幂等语义
    makeContacts('alice', 'bob')
    send('m-1', '一', 1)
    send('m-2', '二', 1)
    const stored = chat.readonlyHandle
      .prepare('SELECT message_id FROM messages WHERE message_id = ?')
      .get('m-2')
    expect(stored, '被拒绝的消息不应留下任何痕迹').toBeUndefined()
  })

  it('不淘汰已接收但未 ACK 的早期消息', () => {
    // §28：relay 不得淘汰已经接收但尚未 ACK 的私聊消息为后续流量腾空间。
    // 这条如果违反，「至少一次」的承诺会静默断掉。
    makeContacts('alice', 'bob')
    send('m-1', '早期消息', 1)
    send('m-2', '新消息', 1) // 应被拒绝
    const early = chat.readonlyHandle
      .prepare('SELECT body FROM messages WHERE message_id = ?')
      .get('m-1') as { body: string } | undefined
    expect(early?.body).toBe('早期消息')
  })

  it('ACK 之后腾出额度，新发送恢复', () => {
    makeContacts('alice', 'bob')
    send('m-1', '一', 1)
    expect(send('m-2', '二', 1)).toMatchObject({ ok: false })

    const batch = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 10,
        leaseMs: 60_000,
        now,
      }),
    )
    chat.transaction((db) =>
      acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        deliverySeqs: batch.map((i) => i.deliverySeq),
        now,
      }),
    )
    expect(send('m-3', '三', 1)).toMatchObject({ ok: true })
  })
})

describe('租约与重投', () => {
  it('租约按设备而非按账号——两台设备各自拉到不同批次', () => {
    // §28：每个设备同时只允许一个有效的租约拉取批次，不是每个账号一个
    makeContacts('alice', 'bob')
    send('m-1')
    send('m-2')

    const first = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 1,
        leaseMs: 60_000,
        now,
      }),
    )
    const second = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b2',
        batchSize: 1,
        leaseMs: 60_000,
        now,
      }),
    )
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]!.deliverySeq).not.toBe(second[0]!.deliverySeq)
  })

  it('未持有租约的设备不能 ACK', () => {
    makeContacts('alice', 'bob')
    send('m-1')
    chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 10,
        leaseMs: 60_000,
        now,
      }),
    )
    const acked = chat.transaction((db) =>
      acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-impostor',
        deliverySeqs: [1],
        now,
      }),
    )
    expect(acked, '非租约持有者不应能确认').toBe(0)
  })

  it('ACK 前崩溃：租约到期后消息重新可拉取', () => {
    // §28 第 6 步：接收方在 ACK 前崩溃，租约到期后 relay 重投
    makeContacts('alice', 'bob')
    send('m-1')

    chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-crashed',
        batchSize: 10,
        leaseMs: 1000,
        now,
      }),
    )
    // 租约有效期内，另一台设备拉不到
    const during = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-other',
        batchSize: 10,
        leaseMs: 1000,
        now: new Date(now.getTime() + 500),
      }),
    )
    expect(during).toHaveLength(0)

    // 租约到期后可被接管
    const after = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-other',
        batchSize: 10,
        leaseMs: 1000,
        now: new Date(now.getTime() + 5000),
      }),
    )
    expect(after).toHaveLength(1)
  })

  it('重复 ACK 是幂等的', () => {
    makeContacts('alice', 'bob')
    send('m-1')
    chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 10,
        leaseMs: 60_000,
        now,
      }),
    )
    const first = chat.transaction((db) =>
      acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        deliverySeqs: [1],
        now,
      }),
    )
    const second = chat.transaction((db) =>
      acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        deliverySeqs: [1],
        now,
      }),
    )
    expect(first).toBe(1)
    expect(second, '第二次 ACK 不应产生变化').toBe(0)
  })

  it('ACK 后的消息不再出现在后续批次中（重启后仍只看到一条）', () => {
    // 对应骨架第 9 步：重启 DSH 后仍只看到一条消息
    makeContacts('alice', 'bob')
    send('m-1')
    const batch = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 10,
        leaseMs: 60_000,
        now,
      }),
    )
    chat.transaction((db) =>
      acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        deliverySeqs: batch.map((i) => i.deliverySeq),
        now,
      }),
    )
    const afterRestart = chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'dev-b1',
        batchSize: 10,
        leaseMs: 60_000,
        now: new Date(now.getTime() + 100_000),
      }),
    )
    expect(afterRestart).toHaveLength(0)
  })
})
