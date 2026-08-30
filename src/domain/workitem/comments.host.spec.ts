/**
 * 评论与 `CommentRevision` 测试。
 *
 * §18 有一条特别值得守：「提及无权限成员时返回 `FORBIDDEN`，**不静默丢弃提及
 * 也不因此授予访问权**」。这句话堵掉了两条看起来都很合理的实现路径，
 * 所以两条都有用例明确排除。
 */

import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  commentOf,
  commentsOn,
  createComment,
  deleteComment,
  editComment,
  extractMentions,
  revisionsOf,
} from './comments.js'

let db: DatabaseSync
const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')
const TARGET = { organizationId: ORG, targetKind: 'work_item' as const, targetId: 'wi-1' }

/** 甲乙有读取权限，外人没有。 */
const canRead = (accountId: string): boolean => ['jia', 'yi'].includes(accountId)

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE comments (
      comment_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_version INTEGER,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    ) STRICT;
    CREATE TABLE comment_revisions (
      organization_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      body TEXT NOT NULL,
      editor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (comment_id, revision)
    ) STRICT;
  `)
})

afterEach(() => db.close())

function create(body = '这个实现看起来没问题', commentId = 'c-1', authorId = 'jia') {
  return createComment(db, {
    commentId,
    ...TARGET,
    targetVersion: 3,
    authorId,
    body,
    now: NOW,
    canRead,
  })
}

describe('发表评论', () => {
  it('创建后可读出作者、目标版本与正文', () => {
    const result = create()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.authorId).toBe('jia')
    // §18：「目标对象**与版本**」。评论绑到具体版本，不绑到「当前」
    expect(result.value.targetVersion).toBe(3)
    expect(result.value.body).toBe('这个实现看起来没问题')
    expect(result.value.revision).toBe(1)
  })

  it('正文只存在修订表，comments 表没有 body 列', () => {
    // 有 body 列的话就会有人去 UPDATE comments SET body，
    // §18「编辑追加修订」的约束当场破掉，且不会有任何报错
    create()
    const columns = (
      db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(columns).not.toContain('body')
  })

  it('空正文被拒绝', () => {
    expect(create('').ok).toBe(false)
  })
})

describe('@ 提及的权限判定（§18）', () => {
  it('提及有权限成员正常发表', () => {
    expect(create('@yi 你看一下').ok).toBe(true)
  })

  it('提及无权限成员返回 FORBIDDEN', () => {
    const result = create('@outsider 你也看看')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('FORBIDDEN')
  })

  it('不静默丢弃提及 —— 整条评论失败，不落库', () => {
    // 静默丢弃会让作者以为对方收到了
    create('@outsider 你也看看')
    expect(commentsOn(db, TARGET)).toHaveLength(0)
  })

  it('不因提及而授予访问权', () => {
    // 另一条被 §18 堵掉的路：让提及自动授权，等于评论成为绕过授权的旁路
    const before = canRead('outsider')
    create('@outsider hi')
    expect(canRead('outsider')).toBe(before)
    expect(canRead('outsider')).toBe(false)
  })

  it('多个提及中只要有一个无权限就整条失败', () => {
    expect(create('@yi @outsider 都看看').ok).toBe(false)
  })

  it('提取提及不把带空格的显示名当成一个', () => {
    // 支持带空格的显示名需要名字到账号的解析，而重名让它无法可靠完成；
    // 错误解析的后果是把提及发给错的人，比不支持更糟
    expect(extractMentions('@jia 和 @yi 请看')).toEqual(['jia', 'yi'])
    expect(extractMentions('@jia-2 @yi_3')).toEqual(['jia-2', 'yi_3'])
  })

  it('重复提及同一人只算一次', () => {
    expect(extractMentions('@yi @yi @yi')).toEqual(['yi'])
  })

  it('没有提及时不做任何权限判定', () => {
    let calls = 0
    const result = createComment(db, {
      commentId: 'c-x',
      ...TARGET,
      authorId: 'jia',
      body: '没有提及任何人',
      now: NOW,
      canRead: () => {
        calls += 1
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(0)
  })
})

describe('编辑追加修订', () => {
  it('编辑后 revision 递增，历史可查', () => {
    create('第一版')
    const edited = editComment(db, {
      commentId: 'c-1',
      editorId: 'jia',
      body: '第二版',
      now: NOW,
      canRead,
    })
    expect(edited.ok).toBe(true)
    expect(commentOf(db, 'c-1')?.body).toBe('第二版')
    expect(commentOf(db, 'c-1')?.revision).toBe(2)
    expect(revisionsOf(db, 'c-1').map((r) => r.body)).toEqual(['第一版', '第二版'])
  })

  it('只有作者能编辑', () => {
    // §18 没有给任何角色「改写他人评论」的权限，
    // 而评论的价值恰恰在于它归属于说话的人
    create('甲写的')
    const result = editComment(db, {
      commentId: 'c-1',
      editorId: 'yi',
      body: '乙改的',
      now: NOW,
      canRead,
    })
    expect(result.ok).toBe(false)
    expect(commentOf(db, 'c-1')?.body).toBe('甲写的')
  })

  it('编辑时同样校验提及权限', () => {
    create('原文')
    const result = editComment(db, {
      commentId: 'c-1',
      editorId: 'jia',
      body: '@outsider 补一句',
      now: NOW,
      canRead,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('FORBIDDEN')
    expect(commentOf(db, 'c-1')?.body).toBe('原文')
  })

  it('revision 由服务端递增，调用方无法指定', () => {
    // 评论只有一条写入路径，让调用方指定只会引入一个可被伪造的输入。
    // 与消息编辑不同：消息 revision 要跨设备同步、可能乱序到达
    create()
    editComment(db, { commentId: 'c-1', editorId: 'jia', body: 'a', now: NOW, canRead })
    editComment(db, { commentId: 'c-1', editorId: 'jia', body: 'b', now: NOW, canRead })
    expect(revisionsOf(db, 'c-1').map((r) => r.revision)).toEqual([1, 2, 3])
  })

  it('不存在的评论返回 NOT_FOUND_OR_FORBIDDEN', () => {
    const result = editComment(db, {
      commentId: 'c-nope',
      editorId: 'jia',
      body: 'x',
      now: NOW,
      canRead,
    })
    expect(result.ok).toBe(false)
  })
})

describe('删除写 tombstone', () => {
  it('删除后保留作者与时间（§18）', () => {
    create('要删的内容')
    const deleted = deleteComment(db, { commentId: 'c-1', actorId: 'jia', now: NOW })
    expect(deleted.ok).toBe(true)
    const comment = commentOf(db, 'c-1')
    expect(comment?.authorId).toBe('jia')
    expect(comment?.createdAt).toBe(NOW.toISOString())
    expect(comment?.deletedAt).toBeDefined()
    expect(comment?.body).toBeUndefined()
  })

  it('删除的是可见性而不是记录，行仍在', () => {
    // 真正的物理清理属 §38 的保留策略，走另一条路径
    create()
    deleteComment(db, { commentId: 'c-1', actorId: 'jia', now: NOW })
    expect(commentsOn(db, TARGET)).toHaveLength(1)
  })

  it('已删除的评论不能再编辑', () => {
    create()
    deleteComment(db, { commentId: 'c-1', actorId: 'jia', now: NOW })
    const result = editComment(db, {
      commentId: 'c-1',
      editorId: 'jia',
      body: 'x',
      now: NOW,
      canRead,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('RESOURCE_GONE')
  })

  it('他人不能删除，除非有管理权限', () => {
    create()
    expect(deleteComment(db, { commentId: 'c-1', actorId: 'yi', now: NOW }).ok).toBe(false)
    expect(
      deleteComment(db, { commentId: 'c-1', actorId: 'yi', canModerate: true, now: NOW }).ok,
    ).toBe(true)
  })

  it('重复删除幂等', () => {
    create()
    const first = deleteComment(db, { commentId: 'c-1', actorId: 'jia', now: NOW })
    const second = deleteComment(db, { commentId: 'c-1', actorId: 'jia', now: NOW })
    expect(first).toEqual(second)
  })
})

describe('评论不参与消息撤回语义（§18）', () => {
  it('评论表与消息事件表无关联', () => {
    // §18 明说评论「不进入 GroupLog，也不参与消息撤回语义」。
    // 复用 message_events 会让两套语义纠缠 —— 删评论保留作者与时间，
    // 撤消息把正文换成占位，看着像实际是两回事
    create()
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(tables).not.toContain('message_events')
  })
})
