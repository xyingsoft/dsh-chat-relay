/**
 * 群会话列表（P1 S4c，relay 侧）。
 *
 * 群消息与私聊在同一张 `messages`（S3：`recipient_type='group'`、
 * `recipient_id = 群 ID`），所以群会话是**查询出来的视图**，与私聊相同思路。
 *
 * 只列出**我所在的群**（org 作用域内）：预览取该群最后一条消息正文（截断），
 * 未读 = 发给我的、该群消息、尚未 ACK 的投递项。
 *
 * ## 已知边界（S4c 最小版）
 * - 预览取 `messages.body` 初值：编辑/撤回后的最终呈现尚未接
 *   （编辑/撤回走 message_events，群场景接法同 S4b host 侧，留待补）；
 * - 群内最后一条若是他人发的，未读数按 ACK 语义计（组内每个人各自队列）。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { ConversationSummary } from './conversations.js'

/** 预览截断上限：与私聊一致，字素簇计。 */
const PREVIEW_GRAPHEMES = 40

function truncate(body: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(body)]
  if (graphemes.length <= PREVIEW_GRAPHEMES) return body
  return `${graphemes.slice(0, PREVIEW_GRAPHEMES).map((s) => s.segment).join('')}…`
}

interface GroupMembershipRow {
  readonly groupId: string
  readonly name: string
  readonly memberCount: number
}

/** 某账号所属的群及其成员数（org 作用域）。 */
function membershipsOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
): readonly GroupMembershipRow[] {
  return db
    .prepare(
      `SELECT g.group_id AS groupId, g.name AS name,
              (SELECT COUNT(*) FROM group_members m
                WHERE m.organization_id = g.organization_id AND m.group_id = g.group_id) AS memberCount
         FROM groups g
         JOIN group_members me
           ON me.organization_id = g.organization_id AND me.group_id = g.group_id
        WHERE g.organization_id = ? AND me.account_id = ?
        ORDER BY g.created_at ASC, g.group_id ASC`,
    )
    .all(organizationId, accountId) as unknown as GroupMembershipRow[]
}

/** 某群的全部成员 ID（org 作用域），用于判定「消息作者是否还在群里」。 */
function memberIdsOf(
  db: DatabaseSync,
  organizationId: string,
  groupId: string,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT account_id AS accountId FROM group_members
        WHERE organization_id = ? AND group_id = ?`,
    )
    .all(organizationId, groupId) as Array<{ accountId: string }>
  return new Set(rows.map((row) => row.accountId))
}

/** 某账号的群会话列表，按最后活动倒序。 */
export function groupConversationsOf(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly accountId: string
  readonly limit?: number
}): readonly ConversationSummary[] {
  const db = input.db
  const groups = membershipsOf(db, input.organizationId, input.accountId)
  const out: ConversationSummary[] = []
  for (const group of groups) {
    const members = memberIdsOf(db, input.organizationId, group.groupId)

    const last = db
      .prepare(
        `SELECT sender_id AS senderId, body AS body, created_at AS createdAt
           FROM messages
          WHERE organization_id = ? AND recipient_type = 'group' AND recipient_id = ?
          ORDER BY created_at DESC, message_id DESC
          LIMIT 1`,
      )
      .get(input.organizationId, group.groupId) as
      | { senderId: string; body: string; createdAt: string }
      | undefined
    // 消息作者已退群时，这条历史不该再显示为这个群的最近动态（与私聊不同，
    // 群会话的「对方」是多对多的——只统计群成员发送的）
    if (last !== undefined && !members.has(last.senderId)) continue

    const unread = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM delivery_queue q
           JOIN messages m ON m.sender_id = q.sender_id AND m.message_id = q.message_id
          WHERE q.organization_id = ? AND q.recipient_id = ? AND q.acked_at IS NULL
            AND m.recipient_type = 'group' AND m.recipient_id = ?`,
      )
      .get(input.organizationId, input.accountId, group.groupId) as { c: number }

    out.push({
      peerId: group.groupId,
      peerDisplayName: group.name,
      kind: 'group',
      memberCount: group.memberCount,
      preview: last === undefined ? '' : truncate(last.body),
      lastActivityAt: last?.createdAt ?? group.groupId,
      unreadCount: unread.c,
      lastMessageOutgoing: last?.senderId === input.accountId,
    })
  }
  out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
  return out.slice(0, input.limit ?? 50)
}
