/**
 * 工作项与签收。
 *
 * §17 的两条关键约束：
 *
 * 1. 状态变更**必须使用命令而不是直接修改字段**，并记录操作者、理由、前一版本、
 *    后一版本、关联产物。
 * 2. 签收是**独立于工作项状态**的另一台状态机，由负责人通过明确命令改变。
 *    「通知已送达或已阅读只表示收件箱状态，**不能代表任务已知晓、同意或开始执行**」。
 *
 * ## 关于状态转换边
 *
 * 文档给出 9 个工作项状态，但**只约束了少数几条转换**：
 * - `in_review → done` 需要评审结论，否则 `REVIEW_REQUIRED`
 * - 进入终态且存在未完成子项时需要显式确认理由
 * - 逾期**不自动改变状态**
 *
 * 其余转换的合法性文档未定义。这里**不自行发明一张限制性的转换表** —— 那等于在
 * 实现中补需求。只实现文档明确约束的关口，其余转换放行，并把「完整转换矩阵」
 * 登记为待补的文档缺口。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { WorkItemState, WorkItemAcknowledgementState } from '../../contract/index.js'

export interface WorkItem {
  readonly workItemId: string
  readonly organizationId: string
  readonly projectId: string
  readonly title: string
  readonly description: string
  readonly priority: string
  readonly assigneeId: string | null
  readonly state: WorkItemState
  readonly acknowledgementState: WorkItemAcknowledgementState | null
  readonly dueAt: string | null
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export type TransitionResult =
  | { readonly ok: true; readonly workItem: WorkItem }
  | { readonly ok: false; readonly errorCode: 'VERSION_CONFLICT' }
  | { readonly ok: false; readonly errorCode: 'REVIEW_REQUIRED' }
  | { readonly ok: false; readonly errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

function toWorkItem(row: Record<string, string | number | null>): WorkItem {
  return {
    workItemId: row['work_item_id'] as string,
    organizationId: row['organization_id'] as string,
    projectId: row['project_id'] as string,
    title: row['title'] as string,
    description: row['description'] as string,
    priority: row['priority'] as string,
    assigneeId: row['assignee_id'] as string | null,
    state: row['state'] as WorkItemState,
    acknowledgementState: row['acknowledgement_state'] as WorkItemAcknowledgementState | null,
    dueAt: row['due_at'] as string | null,
    createdBy: row['created_by'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    version: row['version'] as number,
  }
}

export function createWorkItem(
  db: DatabaseSync,
  input: {
    workItemId: string
    organizationId: string
    projectId: string
    title: string
    description?: string
    priority?: string
    createdBy: string
    dueAt?: string
    now: Date
  },
): WorkItem {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO work_items
       (work_item_id, organization_id, project_id, title, description, priority,
        state, created_by, created_at, updated_at, version, due_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?)`,
  ).run(
    input.workItemId,
    input.organizationId,
    input.projectId,
    input.title,
    input.description ?? '',
    input.priority ?? 'normal',
    input.createdBy,
    iso,
    iso,
    input.dueAt ?? null,
  )
  return findWorkItem(db, input.workItemId)!
}

export function findWorkItem(db: DatabaseSync, workItemId: string): WorkItem | undefined {
  const row = db.prepare('SELECT * FROM work_items WHERE work_item_id = ?').get(workItemId) as
    | Record<string, string | number | null>
    | undefined
  return row ? toWorkItem(row) : undefined
}

/**
 * 分派工作项。
 *
 * §42「分派工作项」的最小成功条件：操作者有分派权、负责人是有效项目成员、**版本匹配**。
 * 授权判定由调用方在此之前完成 —— 本函数只负责版本检查与写入。
 *
 * 分派同时把签收状态置为 `offered`：§17 规定签收由负责人通过明确命令改变，
 * 分派动作本身只是「提出」。
 */
export function assignWorkItem(
  db: DatabaseSync,
  input: { workItemId: string; assigneeId: string; expectedVersion: number; now: Date },
): TransitionResult {
  const result = db
    .prepare(
      `UPDATE work_items
          SET assignee_id = ?, state = 'assigned', acknowledgement_state = 'offered',
              updated_at = ?, version = version + 1
        WHERE work_item_id = ? AND version = ?
          AND state NOT IN ('done', 'cancelled', 'archived')`,
    )
    .run(input.assigneeId, input.now.toISOString(), input.workItemId, input.expectedVersion)

  if (result.changes !== 1) {
    // §42：工作项已进入终态时分派是终态失败，不是版本问题；但两者都以
    // VERSION_CONFLICT 返回会误导调用方，所以先区分
    const current = findWorkItem(db, input.workItemId)
    if (!current) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
    if (['done', 'cancelled', 'archived'].includes(current.state)) {
      return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
    }
    return { ok: false, errorCode: 'VERSION_CONFLICT' }
  }
  return { ok: true, workItem: findWorkItem(db, input.workItemId)! }
}

/**
 * 负责人签收。
 *
 * §17：由负责人通过明确命令改变 —— 「接受任务」/「拒绝并说明原因」。
 * 只有签收状态为 `offered` 时才能接受，避免重复签收或对已撤回的分派签收。
 */
export function acknowledgeAssignment(
  db: DatabaseSync,
  input: {
    workItemId: string
    assigneeId: string
    accept: boolean
    expectedVersion: number
    now: Date
  },
): TransitionResult {
  const next: WorkItemAcknowledgementState = input.accept ? 'acknowledged' : 'declined'
  const result = db
    .prepare(
      `UPDATE work_items
          SET acknowledgement_state = ?, updated_at = ?, version = version + 1
        WHERE work_item_id = ? AND version = ?
          AND assignee_id = ? AND acknowledgement_state = 'offered'`,
    )
    .run(next, input.now.toISOString(), input.workItemId, input.expectedVersion, input.assigneeId)

  if (result.changes !== 1) {
    const current = findWorkItem(db, input.workItemId)
    if (!current) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
    if (current.assigneeId !== input.assigneeId) {
      return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
    }
    return { ok: false, errorCode: 'VERSION_CONFLICT' }
  }
  return { ok: true, workItem: findWorkItem(db, input.workItemId)! }
}

/**
 * 变更工作项状态。
 *
 * 唯一实现的关口是 §18 的 `in_review → done`：项目策略要求评审结论时，
 * 未获批准则返回 `REVIEW_REQUIRED`。其余转换放行 —— 文档未定义完整转换矩阵，
 * 在实现里补一张会变成未经评审的需求。
 */
export function transitionWorkItem(
  db: DatabaseSync,
  input: {
    workItemId: string
    nextState: WorkItemState
    expectedVersion: number
    now: Date
    /** 项目策略是否要求评审。属版本化组织配置，调用方从配置读取。 */
    reviewRequired: boolean
    /** 关联评审是否已 approved。 */
    reviewApproved: boolean
  },
): TransitionResult {
  const current = findWorkItem(db, input.workItemId)
  if (!current) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  if (current.version !== input.expectedVersion) {
    return { ok: false, errorCode: 'VERSION_CONFLICT' }
  }

  // §18：只有获得项目策略要求的评审结论后，工作项才能转入 done
  if (
    input.nextState === 'done' &&
    current.state === 'in_review' &&
    input.reviewRequired &&
    !input.reviewApproved
  ) {
    return { ok: false, errorCode: 'REVIEW_REQUIRED' }
  }

  const result = db
    .prepare(
      `UPDATE work_items SET state = ?, updated_at = ?, version = version + 1
        WHERE work_item_id = ? AND version = ?`,
    )
    .run(input.nextState, input.now.toISOString(), input.workItemId, input.expectedVersion)

  if (result.changes !== 1) return { ok: false, errorCode: 'VERSION_CONFLICT' }
  return { ok: true, workItem: findWorkItem(db, input.workItemId)! }
}

/**
 * 逾期查询。
 *
 * §17：逾期**不自动改变状态**，只产生逾期提醒并在分析中标记；
 * 系统**不因逾期自动重新分派或降低优先级**。因此这里只是查询，没有副作用。
 */
export function overdueWorkItems(
  db: DatabaseSync,
  organizationId: string,
  now: Date,
): readonly WorkItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM work_items
        WHERE organization_id = ? AND due_at IS NOT NULL AND due_at < ?
          AND state NOT IN ('done', 'cancelled', 'archived')`,
    )
    .all(organizationId, now.toISOString()) as Array<Record<string, string | number | null>>
  return rows.map(toWorkItem)
}
