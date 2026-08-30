/**
 * 评审。
 *
 * [§18](../../../../docs/01-requirements/02-collaboration-requirements.md#18-评审与评论)：
 *
 * > 评审是工作项从 `in_review` 进入 `done` 的**显式关口**，不是聊天消息里的
 * > 口头确认。
 * >
 * > 评审人必须是有该项目读取权限的成员，且**默认不能是提交者本人**。
 * >
 * > **`approved` 只对评审时锁定的产物版本生效。** 关联产物或提交在评审后发生
 * > 变化时，评审自动转为 `superseded` 并要求重新评审，**不允许「批准一个版本、
 * > 合入另一个版本」**。
 *
 * ## 「自动转 superseded」是查询时判定，不是后台任务
 *
 * 一个扫描所有评审、发现产物变了就改状态的后台任务，在产物刚变到任务下一次
 * 扫描之间有一个窗口 —— 那个窗口里 `approved` 仍然对新版本生效，而这正是
 * §18 要禁止的。
 *
 * 所以判定发生在**读取时**：`effectiveReviewOf` 拿当前产物版本与评审锁定的版本
 * 比较，不一致就返回 `superseded`。写入（把状态持久化为 superseded）可以晚一点，
 * 但判定不能。§44.1.2 把这条列为 `P0-a` 验收项。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { ReviewState } from '../../contract/index.js'

export interface Review {
  readonly reviewId: string
  readonly organizationId: string
  readonly workItemId: string
  readonly requesterId: string
  readonly reviewerId: string
  /** 评审针对的产物。 */
  readonly artifactRef: string
  /** 评审时**锁定**的产物版本。批准只对这一版生效。 */
  readonly artifactVersion: number
  readonly state: ReviewState
  readonly note: string | undefined
  readonly dueAt: string | undefined
  readonly createdAt: string
  readonly updatedAt: string
  readonly supersededByVersion: number | undefined
}

export type ReviewFailure =
  | 'NOT_FOUND_OR_FORBIDDEN'
  /** 提交者本人不能评审自己的产物（§18）。 */
  | 'FORBIDDEN'
  | 'REVIEW_SUPERSEDED'

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: ReviewFailure }

export interface RequestReviewInput {
  readonly reviewId: string
  readonly organizationId: string
  readonly workItemId: string
  readonly requesterId: string
  readonly reviewerId: string
  readonly artifactRef: string
  readonly artifactVersion: number
  readonly note?: string
  readonly dueAt?: string
  readonly now: Date
  /** 评审人是否对该项目有读取权限。由调用方注入，理由同 comments 的 `canRead`。 */
  readonly reviewerCanRead: (accountId: string) => boolean
  /**
   * 是否允许自评审。
   *
   * §18 说「**默认**不能是提交者本人」——「默认」意味着组织策略可以放宽，
   * 所以这里是参数而不是硬编码的禁止。缺省为 false：默认拒绝。
   */
  readonly allowSelfReview?: boolean
}

/** 发起评审请求。 */
export function requestReview(
  db: DatabaseSync,
  input: RequestReviewInput,
): ReviewResult<Review> {
  if (input.reviewerId === input.requesterId && input.allowSelfReview !== true) {
    return { ok: false, errorCode: 'FORBIDDEN' }
  }
  if (!input.reviewerCanRead(input.reviewerId)) {
    return { ok: false, errorCode: 'FORBIDDEN' }
  }

  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO reviews
       (review_id, organization_id, work_item_id, requester_id, reviewer_id,
        artifact_ref, artifact_version, state, note, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
  ).run(
    input.reviewId,
    input.organizationId,
    input.workItemId,
    input.requesterId,
    input.reviewerId,
    input.artifactRef,
    input.artifactVersion,
    input.note ?? null,
    input.dueAt ?? null,
    iso,
    iso,
  )
  return { ok: true, value: reviewOf(db, input.reviewId)! }
}

/** 评审人可给出的结论。`superseded` 与 `expired` 不在其中 —— 那是系统判定的。 */
export const REVIEW_CONCLUSIONS = ['approved', 'changes_requested', 'declined'] as const
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number]

export interface ConcludeInput {
  readonly reviewId: string
  readonly reviewerId: string
  readonly conclusion: ReviewConclusion
  /** 结论作出时看到的产物版本。与锁定版本不符即 `REVIEW_SUPERSEDED`。 */
  readonly observedArtifactVersion: number
  readonly now: Date
}

/**
 * 给出评审结论。
 *
 * 传入 `observedArtifactVersion` 而不是在这里去查当前版本：评审人是在**某个
 * 具体版本**上做的判断，那个版本是什么由界面告诉服务端。如果服务端自己去查，
 * 查到的是「此刻的版本」—— 而评审人看的可能是几分钟前的那一版，两者不一定相同。
 */
export function concludeReview(db: DatabaseSync, input: ConcludeInput): ReviewResult<Review> {
  const review = reviewOf(db, input.reviewId)
  if (review === undefined) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  if (review.reviewerId !== input.reviewerId) {
    return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  }
  if (review.state === 'superseded') return { ok: false, errorCode: 'REVIEW_SUPERSEDED' }

  if (input.observedArtifactVersion !== review.artifactVersion) {
    // 评审人看的版本已经不是锁定的那一版。持久化 superseded 并拒绝 ——
    // 接受的话就是「批准一个版本、合入另一个版本」
    markSuperseded(db, input.reviewId, input.observedArtifactVersion, input.now)
    return { ok: false, errorCode: 'REVIEW_SUPERSEDED' }
  }

  db.prepare('UPDATE reviews SET state = ?, updated_at = ? WHERE review_id = ?').run(
    input.conclusion,
    input.now.toISOString(),
    input.reviewId,
  )
  return { ok: true, value: reviewOf(db, input.reviewId)! }
}

/**
 * 读出评审在**当前产物版本下**的有效状态。
 *
 * 这是 §18 那条约束的执行点。`approved` 遇上更高的产物版本时返回 `superseded`,
 * 即便数据库里还写着 `approved` —— 判定不等后台任务。
 *
 * 顺带持久化该状态，使后续读取无需重复比较。但**返回值不依赖写入成功** ——
 * 只读事务里也能得到正确判定。
 */
export function effectiveReviewOf(
  db: DatabaseSync,
  reviewId: string,
  currentArtifactVersion: number,
  now: Date,
): Review | undefined {
  const review = reviewOf(db, reviewId)
  if (review === undefined) return undefined
  if (review.state === 'superseded') return review

  // 产物版本没变，状态照旧
  if (currentArtifactVersion === review.artifactVersion) return review

  // §18：关联产物或提交在评审后发生变化时，评审自动转为 superseded。
  // 注意这里不区分「变高」与「变低」—— 任何不一致都意味着评审看的不是这一版
  markSuperseded(db, reviewId, currentArtifactVersion, now)
  return reviewOf(db, reviewId)
}

/**
 * 工作项能否进入 `done`。
 *
 * §18：「只有获得组织或项目策略要求的**评审结论**后，工作项才能由有权成员
 * 转入 `done`；策略未要求评审的项目可直接完成。」
 *
 * `requiresReview` 由调用方给出 —— 那是项目配置，不是这里能知道的。
 */
export function canTransitionToDone(
  db: DatabaseSync,
  input: {
    readonly organizationId: string
    readonly workItemId: string
    readonly currentArtifactVersion: number
    readonly requiresReview: boolean
    readonly now: Date
  },
): { readonly allowed: true } | { readonly allowed: false; readonly errorCode: 'REVIEW_REQUIRED' } {
  if (!input.requiresReview) return { allowed: true }

  const reviews = reviewsOf(db, input.organizationId, input.workItemId)
  const approved = reviews.some((review) => {
    const effective = effectiveReviewOf(db, review.reviewId, input.currentArtifactVersion, input.now)
    return effective?.state === 'approved'
  })

  // 没有对当前版本有效的 approved 就不能完成。一条已 superseded 的批准
  // 不算数 —— 那正是「批准一个版本、合入另一个版本」
  return approved ? { allowed: true } : { allowed: false, errorCode: 'REVIEW_REQUIRED' }
}

export function reviewOf(db: DatabaseSync, reviewId: string): Review | undefined {
  const row = db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(reviewId) as
    | Record<string, string | number | null>
    | undefined
  if (row === undefined) return undefined
  return {
    reviewId: row['review_id'] as string,
    organizationId: row['organization_id'] as string,
    workItemId: row['work_item_id'] as string,
    requesterId: row['requester_id'] as string,
    reviewerId: row['reviewer_id'] as string,
    artifactRef: row['artifact_ref'] as string,
    artifactVersion: row['artifact_version'] as number,
    state: row['state'] as ReviewState,
    note: (row['note'] as string | null) ?? undefined,
    dueAt: (row['due_at'] as string | null) ?? undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    supersededByVersion: (row['superseded_by_version'] as number | null) ?? undefined,
  }
}

/** 某工作项下的全部评审，按创建时间升序。 */
export function reviewsOf(
  db: DatabaseSync,
  organizationId: string,
  workItemId: string,
): readonly Review[] {
  const rows = db
    .prepare(
      `SELECT review_id FROM reviews
        WHERE organization_id = ? AND work_item_id = ?
        ORDER BY created_at, review_id`,
    )
    .all(organizationId, workItemId) as Array<{ review_id: string }>
  return rows.flatMap((row) => {
    const review = reviewOf(db, row.review_id)
    return review === undefined ? [] : [review]
  })
}

function markSuperseded(
  db: DatabaseSync,
  reviewId: string,
  observedVersion: number,
  now: Date,
): void {
  db.prepare(
    `UPDATE reviews SET state = 'superseded', superseded_by_version = ?, updated_at = ?
      WHERE review_id = ? AND state != 'superseded'`,
  ).run(observedVersion, now.toISOString(), reviewId)
}
