/**
 * 工作项依赖与成环检测。
 *
 * §17：依赖关系有 `blocks` 与 `depends_on` 两种，是**同项目内的显式引用**，
 * **创建时校验不产生环**，成环返回 `DEPENDENCY_CYCLE`（409，terminal —— 重试无意义）。
 *
 * 检测放在写入前而不是靠数据库约束：SQL 没有现成的环检测，且 §26 要求
 * 「请求在事务提交前失败时返回错误，且不产生任何可见领域状态」。
 */

import type { DatabaseSync } from 'node:sqlite'

/** 依赖类型。取值来自 §17 的原文。 */
export const DEPENDENCY_KINDS = ['blocks', 'depends_on'] as const
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]

export type AddDependencyResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly errorCode: 'DEPENDENCY_CYCLE'
      /** 构成环的路径，从起点回到起点，便于界面直接展示。 */
      readonly cycle: readonly string[]
    }
  | { readonly ok: false; readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

/**
 * 读出某方向上的全部边。
 *
 * 两种依赖类型在环检测上等价：`A blocks B` 与 `B depends_on A` 描述的是同一件事，
 * 只是书写方向不同。因此检测时把 `blocks` 反向归一，统一成「A 必须先于 B」。
 */
function outgoingEdges(db: DatabaseSync, organizationId: string, from: string): string[] {
  const rows = db
    .prepare(
      `SELECT to_id, kind FROM work_item_dependencies
        WHERE organization_id = ? AND from_id = ?
        UNION
       SELECT from_id AS to_id, kind FROM work_item_dependencies
        WHERE organization_id = ? AND to_id = ? AND kind = 'blocks'`,
    )
    .all(organizationId, from, organizationId, from) as Array<{ to_id: string; kind: string }>
  return rows.map((row) => row.to_id)
}

/**
 * 从 `start` 出发能否到达 `target`。返回到达路径，用于把环展示给用户。
 *
 * 用显式栈的深度优先而不是递归 —— 依赖图理论上可以很深，递归会有栈溢出风险，
 * 而这条路径是用户可触发的。
 */
function findPath(
  db: DatabaseSync,
  organizationId: string,
  start: string,
  target: string,
): string[] | null {
  const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }]
  const seen = new Set<string>()

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.node === target && current.path.length > 1) return current.path
    if (seen.has(current.node)) continue
    seen.add(current.node)

    for (const next of outgoingEdges(db, organizationId, current.node)) {
      if (next === target) return [...current.path, next]
      if (!seen.has(next)) stack.push({ node: next, path: [...current.path, next] })
    }
  }
  return null
}

/**
 * 添加一条依赖。
 *
 * 校验顺序：两端存在且同项目 → 不自环 → 不成环 → 写入。
 * 任何一步失败都在写入前返回，符合 §26。
 */
export function addDependency(
  db: DatabaseSync,
  input: {
    organizationId: string
    fromId: string
    toId: string
    kind: DependencyKind
    now: Date
  },
): AddDependencyResult {
  if (input.fromId === input.toId) {
    return { ok: false, errorCode: 'DEPENDENCY_CYCLE', cycle: [input.fromId, input.toId] }
  }

  const ends = db
    .prepare(
      `SELECT work_item_id, project_id FROM work_items
        WHERE organization_id = ? AND work_item_id IN (?, ?)`,
    )
    .all(input.organizationId, input.fromId, input.toId) as Array<{
    work_item_id: string
    project_id: string
  }>

  if (ends.length !== 2) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }
  // §17：依赖是**同项目内**的显式引用；跨项目依赖需双方项目的分派权限，属后续阶段
  if (ends[0]!.project_id !== ends[1]!.project_id) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }

  // 新边是 from → to；若 to 已能到达 from，加上这条边就成环
  const backPath = findPath(db, input.organizationId, input.toId, input.fromId)
  if (backPath) {
    return { ok: false, errorCode: 'DEPENDENCY_CYCLE', cycle: [...backPath, input.toId] }
  }

  db.prepare(
    `INSERT INTO work_item_dependencies (organization_id, from_id, to_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.organizationId, input.fromId, input.toId, input.kind, input.now.toISOString())

  return { ok: true }
}

/** 某工作项的直接依赖。 */
export function dependenciesOf(
  db: DatabaseSync,
  organizationId: string,
  workItemId: string,
): readonly { readonly toId: string; readonly kind: DependencyKind }[] {
  const rows = db
    .prepare(
      `SELECT to_id, kind FROM work_item_dependencies
        WHERE organization_id = ? AND from_id = ?`,
    )
    .all(organizationId, workItemId) as Array<{ to_id: string; kind: DependencyKind }>
  return rows.map((row) => ({ toId: row.to_id, kind: row.kind }))
}
