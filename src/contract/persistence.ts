/**
 * 持久化层在 L0 协议中的类型定义。
 *
 * §27 要求 L1 的 SQLite schema **从第一版起**就包含 `OrganizationId`、事件 ID、
 * 操作 ID、策略修订、账户同步序列、加密元数据和恢复水位字段，以避免后续的多租户、
 * E2E 或恢复需求变成破坏性表结构重写。
 *
 * §29.1 进一步要求：**预留字段不是未定义 JSON 垃圾桶，字段语义、所有者和解析版本
 * 必须在 L0 协议中明确**。因此下面每个「预留」结构都有确定的形状与版本号，不是
 * `Record<string, unknown>`。
 */

import type { Branded } from './index.js'

/** 领域事件的唯一标识。消费方以此去重（outbox 任务可以重复执行）。 */
export type EventId = Branded<string, 'EventId'>

/**
 * 一次写入操作的标识，同时充当幂等键。
 *
 * §26：事务提交后网络连接断开时，调用方用**同一幂等键**查询最终结果。因此它由
 * 调用方生成并随请求携带，不是服务端分配的。
 */
export type OperationId = Branded<string, 'OperationId'>

/**
 * 策略修订号。
 *
 * §48 要求权限判定「以策略版本写入审计和分析结果，确保后续可复算」——
 * 每条审计与每次授权判定都要记录当时生效的策略版本。
 */
export type PolicyRevision = Branded<number, 'PolicyRevision'>

/** 账户级状态变更流的单调序列，用于跨设备已读与偏好同步。 */
export type AccountStateSeq = Branded<number, 'AccountStateSeq'>

/** relay 为私聊收件人队列项分配的单调序列，按接收人分区。 */
export type DeliverySeq = Branded<number, 'DeliverySeq'>

/** 不可回退的流代次。数据库恢复或分片切换后用于检测分叉。 */
export type StreamEpoch = Branded<number, 'StreamEpoch'>

/**
 * 事件负载的格式版本。
 *
 * §29.1 要求 P0 即保存「事件格式版本」。同一张表在不同协议版本下写入的负载形状
 * 可能不同，读取方据此选择解析分支，而不是靠试探。
 */
export type EventFormatVersion = Branded<number, 'EventFormatVersion'>

/** 当前实现写出的事件格式版本。 */
export const CURRENT_EVENT_FORMAT_VERSION = 1 as EventFormatVersion

/**
 * 加密元数据。
 *
 * P0 不做端到端加密，但 §29.1 明确要求 `encryption_meta` **在 P0 即落库**，
 * 以免 P4 引入 E2EE 时重写消息主表。因此这里给出确定的形状：P0 一律写入
 * `{ scheme: 'none', keyEpoch: 0, formatVersion: 1 }`，P4 扩展 `scheme` 的取值。
 */
export interface EncryptionMeta {
  /** P0 只有 `none`；E2EE 模式在 P4 引入新的取值，届时按 scheme 分支解析。 */
  readonly scheme: 'none'
  /**
   * 密钥代次。E2EE 下群成员变化会推进 epoch，旧 epoch 的消息用旧密钥解。
   * P0 恒为 0 —— 保留字段而非省略，是为了让 P4 的迁移只是填值而不是加列。
   */
  readonly keyEpoch: number
  /** 本结构自身的解析版本，与 `EventFormatVersion` 独立演进。 */
  readonly formatVersion: number
}

/** P0 阶段写入的加密元数据常量。 */
export const PLAINTEXT_ENCRYPTION_META: EncryptionMeta = Object.freeze({
  scheme: 'none',
  keyEpoch: 0,
  formatVersion: 1,
})

/**
 * 恢复水位。
 *
 * §28.1：host 在同步请求、ACK 和账户阅读水位中**同时携带** `StreamEpoch` 与
 * `HighWatermark`。恢复副本若不能证明至少包含已公布的高水位，就不能直接恢复为可写。
 */
export interface RecoveryWatermark {
  readonly streamEpoch: StreamEpoch
  /** 已公布的高水位。不可回退。 */
  readonly highWatermark: number
}

/** 账户级同步状态。P0 即建立，不把已读位置与偏好限制在单机。 */
export interface AccountSyncState {
  readonly accountStateSeq: AccountStateSeq
  /** 「流 ID → 最高已读服务端序列」的稀疏水位映射；合并规则是同一流取最大值。 */
  readonly readWatermarks: Readonly<Record<string, number>>
}

/** 设备级同步状态。 */
export interface DeviceSyncState {
  /** 该设备已见的账户状态序列。断线后据此补拉。 */
  readonly seenAccountStateSeq: AccountStateSeq
  readonly lastSyncedAt: string
}

/**
 * 本次构建实现的协议版本。
 *
 * §41 规定它是**单调递增整数**。早先这里写的是 `'1.0'` 字符串 —— 那与文档不符，
 * 且字符串比较下 `'1.10' < '1.9'`，正是版本号最经典的排序错误。
 *
 * 不兼容时返回 `PROTOCOL_VERSION_UNSUPPORTED` 并**停止组织写入**，不得静默降级。
 * 升级顺序固定为 relay 先升、host 后升。
 */
export const PROTOCOL_VERSION = 1 as Branded<number, 'ProtocolVersion'>

/**
 * 数据库 schema 版本。
 *
 * §29.1 要求版本**单调递增**，迁移分五步：扩展 → 双读/双写 → 回填校验 →
 * 切换读取 → 收缩，且禁止长时间锁表的整表 `ALTER TABLE`。
 */
export type SchemaVersion = Branded<number, 'SchemaVersion'>
