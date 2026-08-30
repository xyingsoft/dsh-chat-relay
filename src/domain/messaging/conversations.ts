/**
 * 会话列表。
 *
 * 「会话」在 P0 不是一张表 —— 私聊没有会话实体，只有消息和对端。会话是**查询
 * 出来的视图**：按对端聚合消息，取最后一条做预览、数未 ACK 的做未读。
 *
 * 建一张 conversations 表当然更快，但那会引入一份需要与消息保持一致的派生状态；
 * 撤回、删除、补拉都得记得同步它。P0 的量级下查询完全够用，等真的成为瓶颈
 * 再加物化视图 —— 那时至少已经知道要物化什么。
 *
 * ## 预览为什么在这里生成
 *
 * §14.1：撤回后「本地把正文替换为撤回占位」。客户端拿到什么显示什么
 * （见 `ConversationList` 的注释），所以**替换必须在服务端做**。
 * 让客户端自己判断是否撤回，等于把正文先发过去再让它别显示 —— 那不叫撤回。
 */

import type { DatabaseSync } from 'node:sqlite'

import { REVOKED_PLACEHOLDER, messageView } from './message-events.js'

export interface ConversationSummary {
  /** 对端账号 ID。P0 的私聊里，会话就是对端。 */
  readonly peerId: string
  readonly peerDisplayName: string
  /** 最后一条消息的摘要。已撤回时是占位而非原文。 */
  readonly preview: string
  readonly lastActivityAt: string
  /** 未 ACK 的投递条数。 */
  readonly unreadCount: number
  /** 最后一条是不是自己发的。界面用它决定要不要显示「你：」前缀。 */
  readonly lastMessageOutgoing: boolean
}

/** 预览的字素簇上限。整条正文送到列表里没有意义，还会把响应撑大。 */
const PREVIEW_GRAPHEMES = 40

/**
 * 截断预览。
 *
 * 按**字素簇**而不是 `length` —— 与发送侧的长度校验同一口径。按 UTF-16 码元切
 * 会把一个 emoji 劈成两半，前一半是孤立代理项，JSON 序列化后是 `�`。
 */
function truncate(body: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(body)]
  if (graphemes.length <= PREVIEW_GRAPHEMES) return body
  return `${graphemes.slice(0, PREVIEW_GRAPHEMES).map((s) => s.segment).join('')}…`
}

interface PeerRow {
  peer_id: string
  last_at: string
}

/**
 * 某账号在某组织下的全部会话，按最后活动时间倒序。
 *
 * 只统计**该账号参与**的消息 —— `sender_id = ? OR recipient_id = ?`，
 * 且两侧都带 `organization_id`。少了组织过滤，切换组织后会看到上一个组织的
 * 会话列表（§9 明确禁止）。
 */
export function conversationsOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
  options: { readonly limit?: number } = {},
): readonly ConversationSummary[] {
  // 先取对端集合与各自的最后活动时间。用 CASE 把「对端」从两列里归一出来，
  // 比查两次再在 JS 里合并少一趟
  const peers = db
    .prepare(
      `SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
              MAX(created_at) AS last_at
         FROM messages
        WHERE organization_id = ? AND (sender_id = ? OR recipient_id = ?)
        GROUP BY peer_id
        ORDER BY last_at DESC
        LIMIT ?`,
    )
    .all(accountId, organizationId, accountId, accountId, options.limit ?? 50) as unknown as PeerRow[]

  return peers.map((peer) => summarize(db, organizationId, accountId, peer))
}

function summarize(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
  peer: PeerRow,
): ConversationSummary {
  const last = db
    .prepare(
      `SELECT message_id, sender_id, body, created_at
         FROM messages
        WHERE organization_id = ?
          AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1`,
    )
    .get(organizationId, accountId, peer.peer_id, peer.peer_id, accountId) as
    | { message_id: string; sender_id: string; body: string; created_at: string }
    | undefined

  const displayName = db
    .prepare('SELECT display_name FROM accounts WHERE account_id = ?')
    .get(peer.peer_id) as { display_name: string } | undefined

  // 未读 = 发给我的、尚未 ACK 的队列项。按发送人过滤，否则一个会话会显示
  // 全部会话的未读总数
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS c FROM delivery_queue
        WHERE organization_id = ? AND recipient_id = ? AND sender_id = ? AND acked_at IS NULL`,
    )
    .get(organizationId, accountId, peer.peer_id) as { c: number }

  return {
    peerId: peer.peer_id,
    // 账号被注销后 display_name 可能查不到。用 ID 兜底而不是空串 ——
    // 空标题的会话在列表里无法指认
    peerDisplayName: displayName?.display_name ?? peer.peer_id,
    preview: previewOf(db, organizationId, last),
    lastActivityAt: last?.created_at ?? peer.last_at,
    unreadCount: unread.c,
    lastMessageOutgoing: last?.sender_id === accountId,
  }
}

/**
 * 生成预览，撤回后替换为占位。
 *
 * 走 `messageView` 而不是自己查 `message_events` 的最高 revision。后者看着
 * 等价，实则会在「先撤回、后到一条 revision 更高的迟到编辑」时把正文显示出来
 * —— 撤回是终态，这条规则已经在 `messageView` 里实现并有用例守着。
 * 复制一份判定就是复制一份将来会漂移的判定。
 */
function previewOf(
  db: DatabaseSync,
  organizationId: string,
  last: { message_id: string; sender_id: string; body: string } | undefined,
): string {
  if (last === undefined) return ''

  const view = messageView(db, {
    organizationId,
    senderId: last.sender_id,
    messageId: last.message_id,
  })
  if (view === undefined) return truncate(last.body)
  if (view.revoked) return REVOKED_PLACEHOLDER
  return truncate(view.body ?? last.body)
}

/** 会话内的一条消息，已应用编辑与撤回。 */
export interface ConversationMessage {
  readonly messageId: string
  readonly senderId: string
  readonly outgoing: boolean
  /** 已撤回时为 `undefined` —— 与 `MessageView` 的 `DisplayMessage` 同一约定。 */
  readonly body: string | undefined
  readonly revoked: boolean
  readonly edited: boolean
  readonly sentAt: string
}

/**
 * 与某个对端的消息记录，按时间升序。
 *
 * 每条都过一遍 `messageView` —— 直接返回 `messages.body` 会把已编辑的旧正文和
 * 已撤回的原文一起发给客户端，那样「撤回」只是界面不显示而已。
 */
export function messagesWith(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
  peerId: string,
  options: { readonly limit?: number } = {},
): readonly ConversationMessage[] {
  // 先按时间倒序取最近 N 条，再翻转成升序。直接升序加 LIMIT 会取到最早的 N 条，
  // 而会话要看的是最近的
  const rows = db
    .prepare(
      `SELECT message_id, sender_id, body, created_at
         FROM messages
        WHERE organization_id = ?
          AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY created_at DESC, message_id DESC
        LIMIT ?`,
    )
    .all(organizationId, accountId, peerId, peerId, accountId, options.limit ?? 50) as unknown as Array<{
    message_id: string
    sender_id: string
    body: string
    created_at: string
  }>

  return rows
    .slice()
    .reverse()
    .map((row) => {
      const view = messageView(db, {
        organizationId,
        senderId: row.sender_id,
        messageId: row.message_id,
      })
      return {
        messageId: row.message_id,
        senderId: row.sender_id,
        outgoing: row.sender_id === accountId,
        body: view?.revoked === true ? undefined : (view?.body ?? row.body),
        revoked: view?.revoked ?? false,
        edited: view?.edited ?? false,
        sentAt: row.created_at,
      }
    })
}
