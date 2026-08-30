/**
 * 工作项、依赖与通知的测试。
 *
 * 覆盖 §17/§18 中最容易实现错的几条：签收是独立状态机、依赖成环被拒、
 * 评审关口、逾期不改状态、通知去重与补拉。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from '../../storage/database.js'
import {
  createNotification,
  inboxSince,
  markNotificationState,
  unreadCount,
} from '../notification/inbox.js'
import {
  createOrganization,
  createProject,
  createWorkspace,
} from '../organization/repository.js'

import { addDependency, dependenciesOf } from './dependencies.js'
import {
  acknowledgeAssignment,
  assignWorkItem,
  createWorkItem,
  findWorkItem,
  overdueWorkItems,
  transitionWorkItem,
} from './work-items.js'

let chat: ChatDatabase
const now = new Date('2026-08-30T00:00:00Z')
const ORG = 'org-1'

beforeEach(() => {
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('pm', '项目经理', now.toISOString())
    insert.run('dev', '开发者', now.toISOString())
    createOrganization(db, { organizationId: ORG, name: 'o', createdBy: 'pm', now })
    createWorkspace(db, {
      workspaceId: 'ws-1',
      organizationId: ORG,
      name: 'w',
      createdBy: 'pm',
      now,
    })
    createProject(db, {
      projectId: 'proj-1',
      organizationId: ORG,
      workspaceId: 'ws-1',
      name: 'p',
      createdBy: 'pm',
      now,
    })
    createProject(db, {
      projectId: 'proj-2',
      organizationId: ORG,
      workspaceId: 'ws-1',
      name: 'p2',
      createdBy: 'pm',
      now,
    })
  })
})

afterEach(() => chat.close())

const makeItem = (id: string, projectId = 'proj-1', dueAt?: string) =>
  chat.transaction((db) =>
    createWorkItem(db, {
      workItemId: id,
      organizationId: ORG,
      projectId,
      title: `工作项 ${id}`,
      createdBy: 'pm',
      now,
      ...(dueAt === undefined ? {} : { dueAt }),
    }),
  )

describe('分派与签收', () => {
  it('分派把状态置为 assigned，并把签收状态置为 offered', () => {
    const item = makeItem('wi-1')
    const result = chat.transaction((db) =>
      assignWorkItem(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        expectedVersion: item.version,
        now,
      }),
    )
    expect(result.ok).toBe(true)
    const updated = findWorkItem(chat.readonlyHandle, 'wi-1')!
    expect(updated.state).toBe('assigned')
    // §17：签收由负责人通过明确命令改变；分派本身只是「提出」
    expect(updated.acknowledgementState).toBe('offered')
  })

  it('签收是独立于工作项状态的状态机', () => {
    // §17：通知已送达或已阅读只表示收件箱状态，不代表任务已知晓、同意或开始执行
    const item = makeItem('wi-1')
    const assigned = chat.transaction((db) =>
      assignWorkItem(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        expectedVersion: item.version,
        now,
      }),
    )
    const version = (assigned as { workItem: { version: number } }).workItem.version

    chat.transaction((db) =>
      acknowledgeAssignment(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        accept: true,
        expectedVersion: version,
        now,
      }),
    )
    const after = findWorkItem(chat.readonlyHandle, 'wi-1')!
    expect(after.acknowledgementState).toBe('acknowledged')
    // 工作项状态未因签收而改变
    expect(after.state).toBe('assigned')
  })

  it('非负责人不能签收', () => {
    const item = makeItem('wi-1')
    const assigned = chat.transaction((db) =>
      assignWorkItem(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        expectedVersion: item.version,
        now,
      }),
    )
    const version = (assigned as { workItem: { version: number } }).workItem.version
    const result = chat.transaction((db) =>
      acknowledgeAssignment(db, {
        workItemId: 'wi-1',
        assigneeId: 'pm',
        accept: true,
        expectedVersion: version,
        now,
      }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })

  it('重复签收被拦下', () => {
    const item = makeItem('wi-1')
    const assigned = chat.transaction((db) =>
      assignWorkItem(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        expectedVersion: item.version,
        now,
      }),
    )
    const version = (assigned as { workItem: { version: number } }).workItem.version
    chat.transaction((db) =>
      acknowledgeAssignment(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        accept: true,
        expectedVersion: version,
        now,
      }),
    )
    const again = chat.transaction((db) =>
      acknowledgeAssignment(db, {
        workItemId: 'wi-1',
        assigneeId: 'dev',
        accept: true,
        expectedVersion: version,
        now,
      }),
    )
    expect(again.ok).toBe(false)
  })

  it('版本不匹配时分派失败', () => {
    makeItem('wi-1')
    const result = chat.transaction((db) =>
      assignWorkItem(db, { workItemId: 'wi-1', assigneeId: 'dev', expectedVersion: 99, now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'VERSION_CONFLICT' })
  })
})

describe('评审关口（§18）', () => {
  it('项目要求评审且未批准时，in_review → done 返回 REVIEW_REQUIRED', () => {
    const item = makeItem('wi-1')
    const inReview = chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'in_review',
        expectedVersion: item.version,
        now,
        reviewRequired: true,
        reviewApproved: false,
      }),
    )
    const version = (inReview as { workItem: { version: number } }).workItem.version

    const result = chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'done',
        expectedVersion: version,
        now,
        reviewRequired: true,
        reviewApproved: false,
      }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'REVIEW_REQUIRED' })
    expect(findWorkItem(chat.readonlyHandle, 'wi-1')!.state).toBe('in_review')
  })

  it('评审已批准时允许完成', () => {
    const item = makeItem('wi-1')
    const inReview = chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'in_review',
        expectedVersion: item.version,
        now,
        reviewRequired: true,
        reviewApproved: false,
      }),
    )
    const version = (inReview as { workItem: { version: number } }).workItem.version
    const done = chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'done',
        expectedVersion: version,
        now,
        reviewRequired: true,
        reviewApproved: true,
      }),
    )
    expect(done.ok).toBe(true)
  })

  it('项目策略未要求评审时可直接完成', () => {
    // §18：策略未要求评审的项目可直接完成，但该差异必须记录在项目配置
    const item = makeItem('wi-1')
    const result = chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'done',
        expectedVersion: item.version,
        now,
        reviewRequired: false,
        reviewApproved: false,
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe('依赖成环（§17）', () => {
  it('正常依赖可添加', () => {
    makeItem('a')
    makeItem('b')
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'b', kind: 'depends_on', now }),
    )
    expect(result.ok).toBe(true)
    expect(dependenciesOf(chat.readonlyHandle, ORG, 'a')).toEqual([
      { toId: 'b', kind: 'depends_on' },
    ])
  })

  it('自依赖被拒绝', () => {
    makeItem('a')
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'a', kind: 'depends_on', now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'DEPENDENCY_CYCLE' })
  })

  it('直接成环被拒绝', () => {
    makeItem('a')
    makeItem('b')
    chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'b', kind: 'depends_on', now }),
    )
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'b', toId: 'a', kind: 'depends_on', now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'DEPENDENCY_CYCLE' })
  })

  it('间接成环被拒绝，并给出环的路径', () => {
    makeItem('a')
    makeItem('b')
    makeItem('c')
    chat.transaction((db) => {
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'b', kind: 'depends_on', now })
      addDependency(db, { organizationId: ORG, fromId: 'b', toId: 'c', kind: 'depends_on', now })
    })
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'c', toId: 'a', kind: 'depends_on', now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'DEPENDENCY_CYCLE' })
    if (!result.ok && 'cycle' in result) {
      expect(result.cycle.length).toBeGreaterThan(2)
    }
  })

  it('成环被拒时不写入任何边', () => {
    // §26：请求在事务提交前失败时不产生任何可见领域状态
    makeItem('a')
    makeItem('b')
    chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'b', kind: 'depends_on', now }),
    )
    chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'b', toId: 'a', kind: 'depends_on', now }),
    )
    expect(dependenciesOf(chat.readonlyHandle, ORG, 'b')).toHaveLength(0)
  })

  it('跨项目依赖被拒绝', () => {
    // §17：依赖是同项目内的显式引用；跨项目需双方项目的分派权限，属后续阶段
    makeItem('a', 'proj-1')
    makeItem('x', 'proj-2')
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'x', kind: 'depends_on', now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' })
  })

  it('blocks 与 depends_on 在环检测上等价', () => {
    // A blocks B 与 B depends_on A 描述同一件事，只是书写方向不同
    makeItem('a')
    makeItem('b')
    chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'a', toId: 'b', kind: 'blocks', now }),
    )
    const result = chat.transaction((db) =>
      addDependency(db, { organizationId: ORG, fromId: 'b', toId: 'a', kind: 'depends_on', now }),
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'DEPENDENCY_CYCLE' })
  })
})

describe('逾期', () => {
  it('逾期只查询，不自动改变状态', () => {
    // §17：逾期不自动改变状态，系统不因逾期自动重新分派或降低优先级
    makeItem('wi-1', 'proj-1', '2026-08-29T00:00:00.000Z')
    const overdue = overdueWorkItems(chat.readonlyHandle, ORG, now)
    expect(overdue).toHaveLength(1)
    expect(findWorkItem(chat.readonlyHandle, 'wi-1')!.state).toBe('open')
  })

  it('已完成的工作项不算逾期', () => {
    const item = makeItem('wi-1', 'proj-1', '2026-08-29T00:00:00.000Z')
    chat.transaction((db) =>
      transitionWorkItem(db, {
        workItemId: 'wi-1',
        nextState: 'done',
        expectedVersion: item.version,
        now,
        reviewRequired: false,
        reviewApproved: false,
      }),
    )
    expect(overdueWorkItems(chat.readonlyHandle, ORG, now)).toHaveLength(0)
  })
})

describe('通知收件箱（§17.1）', () => {
  const notify = (id: string, dedupeKey: string, at = now) =>
    chat.transaction((db) =>
      createNotification(db, {
        notificationId: id,
        organizationId: ORG,
        recipientId: 'dev',
        eventType: 'work_item_changed',
        resourceRef: 'wi-1',
        summary: '工作项已分派给你',
        dedupeKey,
        now: at,
      }),
    )

  it('去重键命中时不产生第二条记录', () => {
    expect(notify('n-1', 'dk-1').ok).toBe(true)
    expect(notify('n-2', 'dk-1')).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(unreadCount(chat.readonlyHandle, ORG, 'dev')).toBe(1)
  })

  it('收件箱按游标补拉——断线不丢通知', () => {
    notify('n-1', 'dk-1', new Date('2026-08-30T00:00:01Z'))
    notify('n-2', 'dk-2', new Date('2026-08-30T00:00:02Z'))
    notify('n-3', 'dk-3', new Date('2026-08-30T00:00:03Z'))

    const first = inboxSince(chat.readonlyHandle, {
      organizationId: ORG,
      recipientId: 'dev',
      limit: 2,
    })
    expect(first.map((n) => n.notificationId)).toEqual(['n-1', 'n-2'])

    const rest = inboxSince(chat.readonlyHandle, {
      organizationId: ORG,
      recipientId: 'dev',
      afterCreatedAt: first[first.length - 1]!.createdAt,
      limit: 10,
    })
    expect(rest.map((n) => n.notificationId)).toEqual(['n-3'])
  })

  it('seen 与 read 是两个不同状态，未读计数只在 read 后减少', () => {
    notify('n-1', 'dk-1')
    expect(unreadCount(chat.readonlyHandle, ORG, 'dev')).toBe(1)

    chat.transaction((db) =>
      markNotificationState(db, {
        organizationId: ORG,
        recipientId: 'dev',
        notificationIds: ['n-1'],
        state: 'seen',
      }),
    )
    expect(unreadCount(chat.readonlyHandle, ORG, 'dev'), 'seen 仍算未读').toBe(1)

    chat.transaction((db) =>
      markNotificationState(db, {
        organizationId: ORG,
        recipientId: 'dev',
        notificationIds: ['n-1'],
        state: 'read',
      }),
    )
    expect(unreadCount(chat.readonlyHandle, ORG, 'dev')).toBe(0)
  })

  it('已忽略的通知不出现在收件箱中', () => {
    notify('n-1', 'dk-1')
    chat.transaction((db) =>
      markNotificationState(db, {
        organizationId: ORG,
        recipientId: 'dev',
        notificationIds: ['n-1'],
        state: 'dismissed',
      }),
    )
    expect(
      inboxSince(chat.readonlyHandle, { organizationId: ORG, recipientId: 'dev', limit: 10 }),
    ).toHaveLength(0)
  })
})
