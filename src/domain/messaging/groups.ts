/**
 * P1 群聊最小模型（S1）：建群 / 加人 / 查成员。
 *
 * 只实现领域不变量，不做 HTTP、不做审计记录 —— 那两层等群消息纵切
 * （S3/S4）与路由接人时按既有约定补齐。当前调用方是**测试环境播种脚本**
 * （examples/two-users 直写库），与 relay 的 HTTP 处理器走同一份代码。
 *
 * 函数统一收单个 options 参数（内含 `db`）：写路径必须在调用方事务内执行，
 * 与 relay 其它领域模块一致（本模块不自行开事务）。
 *
 * ## 不变量
 *
 * - 群与成员关系都带 `organization_id`（§48：缓存键/查询必须携带组织）——
 *   切组织后绝看不到别的组织的群与成员；
 * - 建群即把创建者加为成员（创建者不可能不在自己的群里）；
 * - 加人是幂等的（INSERT OR IGNORE）：重复播种不报错、不产生重复成员行。
 */

import type { DatabaseSync } from 'node:sqlite'

export interface GroupRow {
  readonly groupId: string
  readonly name: string
  readonly createdAt: string
}

/** 生成组织内唯一、可排序的群 ID。 */
function newGroupId(now: string): string {
  return `group-${Date.parse(now)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 建群。群名不允许空白 —— 空白群名在列表里无法指认。 */
export function createGroup(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly creatorAccountId: string
  readonly name: string
  readonly now?: string
}): { readonly groupId: string } {
  const name = input.name.trim()
  if (name.length === 0) {
    throw new Error('group name must not be blank')
  }
  const now = input.now ?? new Date().toISOString()
  const groupId = newGroupId(now)
  input.db
    .prepare(
      `INSERT INTO groups (organization_id, group_id, name, created_by_account_id, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(input.organizationId, groupId, name, input.creatorAccountId, now)
  input.db
    .prepare(
      `INSERT INTO group_members (organization_id, group_id, account_id, joined_at)
       VALUES (?,?,?,?)`,
    )
    .run(input.organizationId, groupId, input.creatorAccountId, now)
  return { groupId }
}

/** 是否群成员（组织作用域内）。 */
export function isGroupMember(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly groupId: string
  readonly accountId: string
}): boolean {
  const row = input.db
    .prepare(
      `SELECT 1 AS one FROM group_members
        WHERE organization_id = ? AND group_id = ? AND account_id = ?`,
    )
    .get(input.organizationId, input.groupId, input.accountId) as { one: number } | undefined
  return row !== undefined
}

/**
 * 把账号加进群。幂等：已是成员时返回 `added: false`，不报错。
 * 只建成员关系，不校验账号是否真实存在 —— 账号维度由调用方负责。
 */
export function addGroupMember(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly groupId: string
  readonly accountId: string
  readonly now?: string
}): { readonly added: boolean } {
  const now = input.now ?? new Date().toISOString()
  const result = input.db
    .prepare(
      `INSERT OR IGNORE INTO group_members (organization_id, group_id, account_id, joined_at)
       VALUES (?,?,?,?)`,
    )
    .run(input.organizationId, input.groupId, input.accountId, now)
  return { added: result.changes > 0 }
}

/** 群成员数（组织作用域内）。 */
export function groupMemberCount(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly groupId: string
}): number {
  const row = input.db
    .prepare(
      `SELECT COUNT(*) AS c FROM group_members
        WHERE organization_id = ? AND group_id = ?`,
    )
    .get(input.organizationId, input.groupId) as { c: number }
  return row.c
}

/** 某账号所属的全部群（组织作用域内），按建群先后。 */
export function groupsOf(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly accountId: string
}): readonly GroupRow[] {
  return input.db
    .prepare(
      `SELECT g.group_id AS groupId, g.name AS name, g.created_at AS createdAt
         FROM groups g
         JOIN group_members m
           ON m.organization_id = g.organization_id AND m.group_id = g.group_id
        WHERE g.organization_id = ? AND m.account_id = ?
        ORDER BY g.created_at ASC, g.group_id ASC`,
    )
    .all(input.organizationId, input.accountId) as unknown as GroupRow[]
}

/** 群本体 + 成员数。host 拼会话列表（群名/人数）用的只读查询。 */
export function groupInfoOf(input: {
  readonly db: DatabaseSync
  readonly organizationId: string
  readonly groupId: string
}): { readonly groupId: string; readonly name: string; readonly memberCount: number } | undefined {
  const group = input.db
    .prepare(
      `SELECT group_id AS groupId, name AS name FROM groups
        WHERE organization_id = ? AND group_id = ?`,
    )
    .get(input.organizationId, input.groupId) as
    | { groupId: string; name: string }
    | undefined
  if (group === undefined) return undefined
  return {
    groupId: group.groupId,
    name: group.name,
    memberCount: groupMemberCount({ db: input.db, organizationId: input.organizationId, groupId: group.groupId }),
  }
}
