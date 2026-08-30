/**
 * 评论与 `CommentRevision`。
 *
 * [§18](../../../../docs/01-requirements/02-collaboration-requirements.md#18-评审与评论)：
 *
 * > 评论属于工作项、资源版本、评审或协作会话，**不属于群消息**，因此不进入
 * > `GroupLog`，也**不参与消息撤回语义**。评论包含作者、目标对象与版本、正文、
 * > 创建时间和 `CommentRevision`；**编辑追加修订，删除写入 tombstone 并保留
 * > 作者与时间**。
 * >
 * > 评论中的 @ 提及只能指向对该对象已有读取权限的成员；提及无权限成员时返回
 * > `FORBIDDEN`，**不静默丢弃提及也不因此授予访问权**。
 *
 * ## 与消息编辑的关系：同一模型，不同语义
 *
 * 两者都是「编辑追加修订」，但 §18 明说评论**不参与消息撤回语义** —— 所以这里
 * 不复用 `message-events`，也不共享 revision 空间。删除评论写 tombstone 保留
 * 作者与时间，而消息撤回是把正文替换为占位；前者仍显示「谁在何时删了一条评论」，
 * 后者在时间线上留一条「已撤回」。看着像，实际是两回事。
 *
 * ## 正文只存在修订表
 *
 * `comments` 表刻意没有 `body` 列。有的话就会有人去 `UPDATE comments SET body`，
 * 「编辑追加修订」的约束当场破掉 —— 而这种破坏不会有任何报错。
 */

import type { DatabaseSync } from 'node:sqlite'

/** 评论可挂载的对象类型（§18）。 */
export const COMMENT_TARGETS = ['work_item', 'resource_version', 'review', 'session'] as const
export type CommentTarget = (typeof COMMENT_TARGETS)[number]

export interface Comment {
  readonly commentId: string
  readonly organizationId: string
  readonly targetKind: CommentTarget
  readonly targetId: string
  /** §18：「目标对象**与版本**」。评论绑到具体版本，不绑到「当前」。 */
  readonly targetVersion: number | undefined
  readonly authorId: string
  readonly createdAt: string
  readonly revision: number
  /** tombstone 时为正文所在修订不再可读；作者与时间仍保留。 */
  readonly deletedAt: string | undefined
  /** 已删除时为 `undefined`。 */
  readonly body: string | undefined
}

export interface CommentRevision {
  readonly organizationId: string
  readonly commentId: string
  readonly revision: number
  readonly body: string
  readonly editorId: string
  readonly occurredAt: string
}

export type CommentFailure =
  | 'NOT_FOUND_OR_FORBIDDEN'
  /** 提及了对该对象没有读取权限的成员（§18 明确要求 `FORBIDDEN`）。 */
  | 'FORBIDDEN'
  | 'RESOURCE_GONE'

export type CommentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorCode: CommentFailure }

/**
 * 从正文中提取 @ 提及。
 *
 * 只认 `@` 后紧跟的标识符字符。刻意**不**支持带空格的显示名 —— 那需要一个
 * 名字到账号的解析步骤，而重名让它无法可靠完成；错误解析的后果是把提及发给
 * 错的人，比不支持更糟。
 */
export function extractMentions(body: string): readonly string[] {
  const matches = body.matchAll(/@([A-Za-z0-9_-]+)/g)
  return [...new Set([...matches].map((m) => m[1] as string))]
}

export interface CreateCommentInput {
  readonly commentId: string
  readonly organizationId: string
  readonly targetKind: CommentTarget
  readonly targetId: string
  readonly targetVersion?: number
  readonly authorId: string
  readonly body: string
  readonly now: Date
  /**
   * 判定某账号对该对象是否有读取权限。
   *
   * 由调用方注入而不是在这里查库：读取权限的判定要走 §11 的双层模型 +
   * 作用域链，那是 organization 包的职责。评论包引它会形成循环依赖。
   */
  readonly canRead: (accountId: string) => boolean
}

/**
 * 发表评论。
 *
 * 提及无权限成员时**整条评论失败**并返回 `FORBIDDEN`。§18 说得很直白：
 * 「不静默丢弃提及也不因此授予访问权」—— 静默丢弃会让作者以为对方收到了，
 * 而授予访问权则是让评论成为一条绕过授权的旁路。第三条路只剩拒绝整条。
 */
export function createComment(
  db: DatabaseSync,
  input: CreateCommentInput,
): CommentResult<Comment> {
  if (input.body.length === 0) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

  for (const mentioned of extractMentions(input.body)) {
    if (!input.canRead(mentioned)) return { ok: false, errorCode: 'FORBIDDEN' }
  }

  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO comments
       (comment_id, organization_id, target_kind, target_id, target_version,
        author_id, created_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    input.commentId,
    input.organizationId,
    input.targetKind,
    input.targetId,
    input.targetVersion ?? null,
    input.authorId,
    iso,
  )
  appendRevision(db, {
    organizationId: input.organizationId,
    commentId: input.commentId,
    revision: 1,
    body: input.body,
    editorId: input.authorId,
    occurredAt: iso,
  })

  return { ok: true, value: commentOf(db, input.commentId)! }
}

export interface EditCommentInput {
  readonly commentId: string
  readonly editorId: string
  readonly body: string
  readonly now: Date
  readonly canRead: (accountId: string) => boolean
}

/**
 * 编辑评论：追加一条修订。
 *
 * 只有作者能编辑 —— §18 没有给任何角色「改写他人评论」的权限，
 * 而评论的价值恰恰在于它归属于说话的人。
 *
 * revision 由服务端递增而不是由调用方指定。这与消息编辑不同：消息的 revision
 * 要跨设备同步、可能乱序到达，所以由调用方带；评论只有一条写入路径，
 * 让调用方指定只会引入一个可以被伪造的输入。
 */
export function editComment(
  db: DatabaseSync,
  input: EditCommentInput,
): CommentResult<Comment> {
  const comment = commentOf(db, input.commentId)
  if (comment === undefined) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  if (comment.authorId !== input.editorId) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  if (comment.deletedAt !== undefined) return { ok: false, errorCode: 'RESOURCE_GONE' }
  if (input.body.length === 0) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

  for (const mentioned of extractMentions(input.body)) {
    if (!input.canRead(mentioned)) return { ok: false, errorCode: 'FORBIDDEN' }
  }

  const revision = comment.revision + 1
  appendRevision(db, {
    organizationId: comment.organizationId,
    commentId: input.commentId,
    revision,
    body: input.body,
    editorId: input.editorId,
    occurredAt: input.now.toISOString(),
  })
  db.prepare('UPDATE comments SET revision = ? WHERE comment_id = ?').run(
    revision,
    input.commentId,
  )
  return { ok: true, value: commentOf(db, input.commentId)! }
}

/**
 * 删除评论：写 tombstone。
 *
 * §18：「删除写入 tombstone 并**保留作者与时间**」。所以这里不 DELETE 行，
 * 只置 `deleted_at`。修订表里的正文也保留 —— 删除的是**可见性**，
 * 不是记录。真正的物理清理属 §38 的保留策略，走另一条路径。
 *
 * 重复删除幂等：用户连点两次不该看到报错。
 */
export function deleteComment(
  db: DatabaseSync,
  input: { commentId: string; actorId: string; canModerate?: boolean; now: Date },
): CommentResult<Comment> {
  const comment = commentOf(db, input.commentId)
  if (comment === undefined) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

  const allowed = comment.authorId === input.actorId || input.canModerate === true
  if (!allowed) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
  if (comment.deletedAt !== undefined) return { ok: true, value: comment }

  db.prepare('UPDATE comments SET deleted_at = ? WHERE comment_id = ?').run(
    input.now.toISOString(),
    input.commentId,
  )
  return { ok: true, value: commentOf(db, input.commentId)! }
}

export function commentOf(db: DatabaseSync, commentId: string): Comment | undefined {
  const row = db.prepare('SELECT * FROM comments WHERE comment_id = ?').get(commentId) as
    | Record<string, string | number | null>
    | undefined
  if (row === undefined) return undefined

  const deletedAt = (row['deleted_at'] as string | null) ?? undefined
  const revision = row['revision'] as number
  const body =
    deletedAt === undefined ? revisionOf(db, commentId, revision)?.body : undefined

  return {
    commentId: row['comment_id'] as string,
    organizationId: row['organization_id'] as string,
    targetKind: row['target_kind'] as CommentTarget,
    targetId: row['target_id'] as string,
    targetVersion: (row['target_version'] as number | null) ?? undefined,
    authorId: row['author_id'] as string,
    createdAt: row['created_at'] as string,
    revision,
    deletedAt,
    body,
  }
}

/** 某条评论的全部修订，按 revision 升序。编辑历史可查。 */
export function revisionsOf(db: DatabaseSync, commentId: string): readonly CommentRevision[] {
  const rows = db
    .prepare('SELECT * FROM comment_revisions WHERE comment_id = ? ORDER BY revision')
    .all(commentId) as Array<Record<string, string | number>>
  return rows.map(toRevision)
}

/** 目标对象上的评论，按创建时间升序。已删除的**仍然返回** —— 见 `deleteComment`。 */
export function commentsOn(
  db: DatabaseSync,
  key: {
    readonly organizationId: string
    readonly targetKind: CommentTarget
    readonly targetId: string
  },
): readonly Comment[] {
  const rows = db
    .prepare(
      `SELECT comment_id FROM comments
        WHERE organization_id = ? AND target_kind = ? AND target_id = ?
        ORDER BY created_at, comment_id`,
    )
    .all(key.organizationId, key.targetKind, key.targetId) as Array<{ comment_id: string }>

  return rows.flatMap((row) => {
    const comment = commentOf(db, row.comment_id)
    return comment === undefined ? [] : [comment]
  })
}

function revisionOf(
  db: DatabaseSync,
  commentId: string,
  revision: number,
): CommentRevision | undefined {
  const row = db
    .prepare('SELECT * FROM comment_revisions WHERE comment_id = ? AND revision = ?')
    .get(commentId, revision) as Record<string, string | number> | undefined
  return row === undefined ? undefined : toRevision(row)
}

function toRevision(row: Record<string, string | number>): CommentRevision {
  return {
    organizationId: row['organization_id'] as string,
    commentId: row['comment_id'] as string,
    revision: row['revision'] as number,
    body: row['body'] as string,
    editorId: row['editor_id'] as string,
    occurredAt: row['occurred_at'] as string,
  }
}

function appendRevision(db: DatabaseSync, revision: CommentRevision): void {
  db.prepare(
    `INSERT INTO comment_revisions
       (organization_id, comment_id, revision, body, editor_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    revision.organizationId,
    revision.commentId,
    revision.revision,
    revision.body,
    revision.editorId,
    revision.occurredAt,
  )
}
