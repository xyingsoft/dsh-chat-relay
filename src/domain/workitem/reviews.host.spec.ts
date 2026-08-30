/**
 * 评审测试。
 *
 * §44.1.2 把「**评审批准后关联产物变化时自动转 `superseded`**」列为 `P0-a`
 * 的验收项。§18 给出的理由是「不允许**批准一个版本、合入另一个版本**」——
 * 所以这里的用例大多在从不同角度尝试制造那种情形，然后确认被挡住。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canTransitionToDone,
  concludeReview,
  effectiveReviewOf,
  requestReview,
  reviewOf,
  reviewsOf,
} from './reviews.js'

let db: DatabaseSync
const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')
const later = (ms: number): Date => new Date(NOW.getTime() + ms)

const canRead = (accountId: string): boolean => ['jia', 'yi', 'bing'].includes(accountId)

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE reviews (
      review_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      artifact_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_by_version INTEGER
    ) STRICT;
  `)
})

afterEach(() => db.close())

function request(overrides: Partial<Parameters<typeof requestReview>[1]> = {}) {
  return requestReview(db, {
    reviewId: 'rev-1',
    organizationId: ORG,
    workItemId: 'wi-1',
    requesterId: 'jia',
    reviewerId: 'yi',
    artifactRef: 'artifact:a-1',
    artifactVersion: 3,
    now: NOW,
    reviewerCanRead: canRead,
    ...overrides,
  })
}

/** 发起并批准一条针对 version 3 的评审。 */
function approved(): void {
  request()
  const result = concludeReview(db, {
    reviewId: 'rev-1',
    reviewerId: 'yi',
    conclusion: 'approved',
    observedArtifactVersion: 3,
    now: NOW,
  })
  expect(result.ok).toBe(true)
}

describe('发起评审', () => {
  it('锁定发起时的产物版本', () => {
    const result = request({ artifactVersion: 7 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.artifactVersion).toBe(7)
  })

  it('初始状态为 requested', () => {
    const result = request()
    if (result.ok) expect(result.value.state).toBe('requested')
  })

  it('默认不能评审自己提交的产物（§18）', () => {
    const result = request({ reviewerId: 'jia' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('FORBIDDEN')
  })

  it('组织策略可以放宽自评审', () => {
    // §18 说的是「**默认**不能是提交者本人」——「默认」意味着可配置，
    // 所以是参数而非硬编码的禁止
    expect(request({ reviewerId: 'jia', allowSelfReview: true }).ok).toBe(true)
  })

  it('评审人必须对项目有读取权限', () => {
    const result = request({ reviewerId: 'outsider' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('FORBIDDEN')
  })
})

describe('批准只对锁定版本生效（§44.1.2 验收项）', () => {
  it('产物版本未变时批准有效', () => {
    approved()
    expect(effectiveReviewOf(db, 'rev-1', 3, later(1000))?.state).toBe('approved')
  })

  it('产物版本变化后自动转 superseded', () => {
    // §18：不允许「批准一个版本、合入另一个版本」
    approved()
    const effective = effectiveReviewOf(db, 'rev-1', 4, later(1000))
    expect(effective?.state).toBe('superseded')
    expect(effective?.supersededByVersion).toBe(4)
  })

  it('判定在读取时发生，不等后台任务', () => {
    // 扫描式的后台任务在「产物变了」到「下次扫描」之间有一个窗口 ——
    // 那个窗口里 approved 仍对新版本生效，正是要禁止的
    approved()
    // 一读就已经是 superseded，数据库里也跟着改了
    effectiveReviewOf(db, 'rev-1', 4, later(1))
    expect(reviewOf(db, 'rev-1')?.state).toBe('superseded')
  })

  it('版本回退同样触发 superseded', () => {
    // 不区分变高变低 —— 任何不一致都意味着评审看的不是这一版
    approved()
    expect(effectiveReviewOf(db, 'rev-1', 2, later(1000))?.state).toBe('superseded')
  })

  it('superseded 是终态，回到原版本也不复活', () => {
    // 复活的话，把产物改回去就能让一条本该重审的批准重新生效
    approved()
    effectiveReviewOf(db, 'rev-1', 4, later(1000))
    expect(effectiveReviewOf(db, 'rev-1', 3, later(2000))?.state).toBe('superseded')
  })

  it('结论作出时产物已变，直接拒绝并转 superseded', () => {
    request()
    const result = concludeReview(db, {
      reviewId: 'rev-1',
      reviewerId: 'yi',
      conclusion: 'approved',
      observedArtifactVersion: 5,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('REVIEW_SUPERSEDED')
    expect(reviewOf(db, 'rev-1')?.state).toBe('superseded')
  })

  it('已 superseded 的评审不能再给结论', () => {
    approved()
    effectiveReviewOf(db, 'rev-1', 4, later(1000))
    const result = concludeReview(db, {
      reviewId: 'rev-1',
      reviewerId: 'yi',
      conclusion: 'approved',
      observedArtifactVersion: 4,
      now: later(2000),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('REVIEW_SUPERSEDED')
  })
})

describe('给出结论', () => {
  it('只有指定评审人能给结论', () => {
    request()
    const result = concludeReview(db, {
      reviewId: 'rev-1',
      reviewerId: 'bing',
      conclusion: 'approved',
      observedArtifactVersion: 3,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    expect(reviewOf(db, 'rev-1')?.state).toBe('requested')
  })

  it('changes_requested 与 declined 同样是有效结论', () => {
    for (const conclusion of ['changes_requested', 'declined'] as const) {
      db.exec('DELETE FROM reviews')
      request()
      const result = concludeReview(db, {
        reviewId: 'rev-1',
        reviewerId: 'yi',
        conclusion,
        observedArtifactVersion: 3,
        now: NOW,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.state).toBe(conclusion)
    }
  })

  it('结论看到的版本由调用方给出，不由服务端现查', () => {
    // 评审人是在某个具体版本上做的判断。服务端自己去查得到的是「此刻的版本」，
    // 而评审人看的可能是几分钟前那一版
    request({ artifactVersion: 3 })
    // 界面报告评审人看的是 v3，即便产物此刻已是 v9，结论仍针对 v3 成立
    const result = concludeReview(db, {
      reviewId: 'rev-1',
      reviewerId: 'yi',
      conclusion: 'approved',
      observedArtifactVersion: 3,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    // 但对 v9 而言这条批准已经失效
    expect(effectiveReviewOf(db, 'rev-1', 9, later(1))?.state).toBe('superseded')
  })
})

describe('进入 done 的关口（§18）', () => {
  const base = { organizationId: ORG, workItemId: 'wi-1', now: later(5000) }

  it('策略不要求评审时可直接完成', () => {
    expect(
      canTransitionToDone(db, { ...base, currentArtifactVersion: 3, requiresReview: false }).allowed,
    ).toBe(true)
  })

  it('要求评审但没有批准时返回 REVIEW_REQUIRED', () => {
    request()
    const result = canTransitionToDone(db, {
      ...base,
      currentArtifactVersion: 3,
      requiresReview: true,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('REVIEW_REQUIRED')
  })

  it('有对当前版本有效的批准时可完成', () => {
    approved()
    expect(
      canTransitionToDone(db, { ...base, currentArtifactVersion: 3, requiresReview: true }).allowed,
    ).toBe(true)
  })

  it('批准已 superseded 时不能完成', () => {
    // 这条是整个模块的目的：一条已失效的批准不能把工作项送进 done
    approved()
    const result = canTransitionToDone(db, {
      ...base,
      currentArtifactVersion: 4,
      requiresReview: true,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('REVIEW_REQUIRED')
  })

  it('changes_requested 不算通过', () => {
    request()
    concludeReview(db, {
      reviewId: 'rev-1',
      reviewerId: 'yi',
      conclusion: 'changes_requested',
      observedArtifactVersion: 3,
      now: NOW,
    })
    expect(
      canTransitionToDone(db, { ...base, currentArtifactVersion: 3, requiresReview: true }).allowed,
    ).toBe(false)
  })

  it('多条评审中有一条对当前版本有效的批准即可', () => {
    approved()
    request({ reviewId: 'rev-2', reviewerId: 'bing' })
    expect(reviewsOf(db, ORG, 'wi-1')).toHaveLength(2)
    expect(
      canTransitionToDone(db, { ...base, currentArtifactVersion: 3, requiresReview: true }).allowed,
    ).toBe(true)
  })
})
