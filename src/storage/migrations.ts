/**
 * SQLite schema 与迁移。
 *
 * §29.1 的约束：schema 版本**单调递增**；迁移分五步（扩展 → 双读/双写 → 回填校验
 * → 切换读取 → 收缩）；**禁止把生产升级设计为长时间锁表的整表 `ALTER TABLE`**。
 *
 * 本文件只承载「扩展」这一步所需的 DDL —— 每次迁移只增加可空字段、新表或新索引，
 * 从不就地改列或删列。收缩步骤（删除旧字段）另行安排，且要等所有部署版本与备份
 * 恢复窗口都越过兼容期。
 *
 * ## 为什么第一版就有这么多字段
 *
 * §27 要求 L1 的 schema 从第一版起就包含 `OrganizationId`、事件 ID、操作 ID、
 * 策略修订、账户同步序列、加密元数据和恢复水位。这些字段在 P0 大多恒为默认值，
 * 但**先占位比后加列便宜得多** —— 否则 P4 引入 E2EE 时要重写消息主表。
 */

/** 一次迁移：单调递增的版本号 + 只做扩展的 DDL。 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

/**
 * 版本 1：P0-a 的完整表结构。
 *
 * 每张业务表都带 `organization_id` —— §48 要求「缓存键、数据库查询、对象存储路径、
 * 队列分区和异步任务都必须携带 `OrganizationId`」，从 schema 层强制比在查询层
 * 靠自觉可靠。
 */
const migration001: Migration = {
  version: 1,
  name: 'p0a-initial',
  statements: [
    // ── 账号与设备 ────────────────────────────────────────────────
    `CREATE TABLE accounts (
       account_id        TEXT PRIMARY KEY,
       display_name      TEXT NOT NULL,
       email             TEXT,
       -- relay 只保存 Argon2id 验证值，绝不保存明文；P0 允许为空（设备密钥登录）
       password_verifier TEXT,
       created_at        TEXT NOT NULL,
       -- 账户级状态变更流序列，用于跨设备已读与偏好同步（§10）
       account_state_seq INTEGER NOT NULL DEFAULT 0,
       -- 注销后保留协作事实的不可逆匿名标识（§38.2），P0 恒为空
       tombstone_id      TEXT
     ) STRICT`,

    `CREATE TABLE devices (
       device_id        TEXT PRIMARY KEY,
       account_id       TEXT NOT NULL REFERENCES accounts(account_id),
       -- Ed25519 签名公钥；私钥永不上传（§7）
       signing_public_key TEXT NOT NULL,
       -- X25519 密钥协商公钥，为 P4 的 E2EE 预留
       agreement_public_key TEXT,
       key_fingerprint  TEXT NOT NULL,
       -- 取值见 contract 的设备状态；P0 使用 active / restricted / revoked
       state            TEXT NOT NULL,
       first_seen_at    TEXT NOT NULL,
       last_seen_at     TEXT NOT NULL,
       -- 设备级同步状态（§10），P0 即建立
       seen_account_state_seq INTEGER NOT NULL DEFAULT 0
     ) STRICT`,
    `CREATE INDEX idx_devices_account ON devices(account_id)`,

    // 恢复材料：relay 只保存恢复公钥与守护人策略，绝不保存可直接恢复账号的明文秘密（§7.2）
    `CREATE TABLE recovery_kits (
       account_id          TEXT PRIMARY KEY REFERENCES accounts(account_id),
       recovery_public_key TEXT NOT NULL,
       -- 守护人阈值策略，如 2/3；形状由 contract 定义
       threshold_policy    TEXT NOT NULL,
       created_at          TEXT NOT NULL
     ) STRICT`,

    // ── 邀请码（骨架第 1 步）─────────────────────────────────────
    `CREATE TABLE invite_codes (
       code             TEXT PRIMARY KEY,
       organization_id  TEXT NOT NULL,
       created_by       TEXT NOT NULL REFERENCES accounts(account_id),
       created_at       TEXT NOT NULL,
       expires_at       TEXT NOT NULL,
       -- 一次性：消费后写入使用者与时间，不删除记录（审计需要）
       consumed_by      TEXT REFERENCES accounts(account_id),
       consumed_at      TEXT
     ) STRICT`,

    // ── 组织三级层次 ──────────────────────────────────────────────
    `CREATE TABLE organizations (
       organization_id TEXT PRIMARY KEY,
       name            TEXT NOT NULL,
       -- active / suspended / archived
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       -- 并发控制：所有变更携带版本号，冲突返回 VERSION_CONFLICT（§11.2）
       version         INTEGER NOT NULL DEFAULT 1,
       -- 策略修订号，写入审计以便复算（§48）
       policy_revision INTEGER NOT NULL DEFAULT 1
     ) STRICT`,

    `CREATE TABLE workspaces (
       workspace_id    TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       name            TEXT NOT NULL,
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_workspaces_org ON workspaces(organization_id)`,

    `CREATE TABLE projects (
       project_id      TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
       name            TEXT NOT NULL,
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_projects_org ON projects(organization_id)`,

    // 成员关系：角色给出默认能力，资源 ACL 决定实际操作（§11）
    `CREATE TABLE memberships (
       membership_id   TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       account_id      TEXT NOT NULL REFERENCES accounts(account_id),
       -- 授权作用域：organization / workspace / project
       scope_kind      TEXT NOT NULL,
       scope_id        TEXT NOT NULL,
       role            TEXT NOT NULL,
       -- invited / active / suspended / removed
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1,
       policy_revision INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_memberships_unique
       ON memberships(organization_id, account_id, scope_kind, scope_id)`,
    `CREATE INDEX idx_memberships_account ON memberships(organization_id, account_id)`,

    // ── 联系人与拉黑 ──────────────────────────────────────────────
    `CREATE TABLE contact_requests (
       request_id      TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       requester_id    TEXT NOT NULL REFERENCES accounts(account_id),
       target_id       TEXT NOT NULL REFERENCES accounts(account_id),
       -- pending / accepted / rejected / expired
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       expires_at      TEXT NOT NULL
     ) STRICT`,
    `CREATE INDEX idx_contact_requests_target
       ON contact_requests(organization_id, target_id, state)`,

    // 拉黑不是联系人状态，而是有向记录（§13）
    `CREATE TABLE blocks (
       organization_id  TEXT NOT NULL,
       actor_account_id TEXT NOT NULL REFERENCES accounts(account_id),
       subject_account_id TEXT NOT NULL REFERENCES accounts(account_id),
       created_at       TEXT NOT NULL,
       PRIMARY KEY (organization_id, actor_account_id, subject_account_id)
     ) STRICT`,

    // ── 消息与投递 ────────────────────────────────────────────────
    `CREATE TABLE messages (
       -- 客户端生成的 UUIDv7（§14）
       message_id       TEXT NOT NULL,
       organization_id  TEXT NOT NULL,
       sender_id        TEXT NOT NULL REFERENCES accounts(account_id),
       recipient_id     TEXT NOT NULL REFERENCES accounts(account_id),
       -- P0 只有 text
       kind             TEXT NOT NULL,
       body             TEXT NOT NULL,
       -- 单调递增；编辑追加事件而非覆盖，初始为 1（§14.1）
       revision         INTEGER NOT NULL DEFAULT 1,
       created_at       TEXT NOT NULL,
       received_at      TEXT NOT NULL,
       -- 幂等键与事件格式版本
       operation_id     TEXT NOT NULL,
       event_format_version INTEGER NOT NULL,
       -- P0 恒为 {"scheme":"none","keyEpoch":0,"formatVersion":1}，为 P4 预留
       encryption_meta  TEXT NOT NULL,
       -- (senderAccountId, MessageId) 是幂等键（§14）
       PRIMARY KEY (sender_id, message_id)
     ) STRICT`,
    `CREATE INDEX idx_messages_recipient
       ON messages(organization_id, recipient_id, received_at)`,

    // 收件人队列：relay 为每个队列项分配单调 DeliverySeq，按接收人分区（§28）
    `CREATE TABLE delivery_queue (
       organization_id TEXT NOT NULL,
       recipient_id    TEXT NOT NULL REFERENCES accounts(account_id),
       delivery_seq    INTEGER NOT NULL,
       sender_id       TEXT NOT NULL,
       message_id      TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       -- 租约：每个设备同时只允许一个有效的拉取批次（§28）
       lease_device_id TEXT,
       lease_expires_at TEXT,
       -- ACK 后置位；不删除记录，保留期内可复查
       acked_at        TEXT,
       acked_device_id TEXT,
       PRIMARY KEY (organization_id, recipient_id, delivery_seq)
     ) STRICT`,
    `CREATE INDEX idx_delivery_pending
       ON delivery_queue(organization_id, recipient_id, acked_at)`,

    // 每个私聊队列分区的流代次与高水位，不可回退（§28.1）
    `CREATE TABLE stream_state (
       organization_id TEXT NOT NULL,
       partition_key   TEXT NOT NULL,
       stream_epoch    INTEGER NOT NULL DEFAULT 1,
       high_watermark  INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (organization_id, partition_key)
     ) STRICT`,

    // ── 工作项 ────────────────────────────────────────────────────
    `CREATE TABLE work_items (
       work_item_id    TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       project_id      TEXT NOT NULL REFERENCES projects(project_id),
       title           TEXT NOT NULL,
       description     TEXT NOT NULL DEFAULT '',
       priority        TEXT NOT NULL,
       assignee_id     TEXT REFERENCES accounts(account_id),
       -- draft / open / assigned / in_progress / blocked / in_review / done / cancelled / archived
       state           TEXT NOT NULL,
       -- 独立于工作项状态的签收状态机（§17）
       acknowledgement_state TEXT,
       due_at          TEXT,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_work_items_project ON work_items(organization_id, project_id)`,
    `CREATE INDEX idx_work_items_assignee ON work_items(organization_id, assignee_id)`,

    // 依赖是同项目内的显式引用，创建时校验不成环（§17）
    `CREATE TABLE work_item_dependencies (
       organization_id TEXT NOT NULL,
       from_id         TEXT NOT NULL REFERENCES work_items(work_item_id),
       to_id           TEXT NOT NULL REFERENCES work_items(work_item_id),
       -- blocks / depends_on
       kind            TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       PRIMARY KEY (organization_id, from_id, to_id, kind)
     ) STRICT`,

    // ── 通知 ──────────────────────────────────────────────────────
    // 持久化收件箱记录，不是 SSE 推送本身（§17.1）
    `CREATE TABLE notifications (
       notification_id TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       recipient_id    TEXT NOT NULL REFERENCES accounts(account_id),
       event_type      TEXT NOT NULL,
       resource_ref    TEXT NOT NULL,
       actor_id        TEXT REFERENCES accounts(account_id),
       summary         TEXT NOT NULL,
       priority        TEXT NOT NULL,
       -- queued / delivered / seen / read / dismissed / expired / failed
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       -- 去重键防止同一领域事件重复投递产生多条记录（§17.1）
       dedupe_key      TEXT NOT NULL
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_notifications_dedupe
       ON notifications(organization_id, recipient_id, dedupe_key)`,
    `CREATE INDEX idx_notifications_inbox
       ON notifications(organization_id, recipient_id, state, created_at)`,

    // ── 审计 ──────────────────────────────────────────────────────
    // 仅追加。§37 的字段清单；审计表中不含任何消息正文（§43 第 14 步）
    `CREATE TABLE audit_events (
       audit_event_id  TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       event_type      TEXT NOT NULL,
       occurred_at     TEXT NOT NULL,
       -- 服务端序列号，单调递增
       server_seq      INTEGER NOT NULL,
       actor_account_id TEXT,
       device_id       TEXT,
       source_ip_prefix TEXT,
       coarse_region   TEXT,
       target_ref      TEXT NOT NULL,
       -- 成功或被拒绝；被拒绝的越权尝试同样留下记录（§43 第 14 步）
       outcome         TEXT NOT NULL,
       error_code      TEXT,
       policy_revision INTEGER NOT NULL,
       operation_id    TEXT,
       related_event_id TEXT,
       trace_id        TEXT
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_audit_seq ON audit_events(organization_id, server_seq)`,
    `CREATE INDEX idx_audit_lookup ON audit_events(organization_id, occurred_at)`,

    // ── 事务 outbox ───────────────────────────────────────────────
    // §26：领域对象与 outbox 在同一事务写入，提交后异步投递；
    // outbox 任务可以重复执行，消费方以事件 ID 去重
    `CREATE TABLE outbox (
       event_id        TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       event_type      TEXT NOT NULL,
       payload         TEXT NOT NULL,
       event_format_version INTEGER NOT NULL,
       created_at      TEXT NOT NULL,
       -- queued / running / retrying / succeeded / failed / cancelled / dead_letter
       task_state      TEXT NOT NULL DEFAULT 'queued',
       attempts        INTEGER NOT NULL DEFAULT 0,
       next_attempt_at TEXT,
       last_error      TEXT
     ) STRICT`,
    `CREATE INDEX idx_outbox_pending ON outbox(task_state, next_attempt_at)`,
  ],
}

/**
 * 版本 2：请求签名的 nonce 账本。
 *
 * §7.1 要求 relay「拒绝过期时间戳、**重复 nonce**、未注册或被限制设备」。
 * 拒绝重复 nonce 需要记住已见过的 nonce —— 这是唯一必须新增的状态。
 *
 * 按 §29.1 只做扩展：新表，不动既有列。
 */
const migration002: Migration = {
  version: 2,
  name: 'request-signing-nonces',
  statements: [
    // 主键是 (device_id, nonce) 而不是 nonce 单列：nonce 由各设备自行生成，
    // 两台设备偶然生成同一个值不该让后者的请求被判为重放。
    //
    // seen_at 用于按容忍窗口清理 —— 账本无限增长的话，一台设备跑一年就是
    // 几千万行，而窗口外的 nonce 早已因时间戳检查而无法使用，留着没有意义。
    `CREATE TABLE request_nonces (
       device_id TEXT NOT NULL,
       nonce     TEXT NOT NULL,
       seen_at   TEXT NOT NULL,
       PRIMARY KEY (device_id, nonce)
     ) STRICT`,
    `CREATE INDEX idx_request_nonces_expiry ON request_nonces(seen_at)`,
  ],
}

/**
 * 版本 3：消息编辑与撤回的事件流，以及发送方本地发送状态。
 *
 * §14.1：「**消息正文不是可原地覆盖的字段。**每个 `MessageId` 具有单调递增的
 * `MessageRevision`，初始正文为 revision 1；编辑追加不可变 `message_edited`
 * 事件，撤回追加 `message_revoked` tombstone 事件。」
 *
 * 因此这里加的是**事件表**而不是给 messages 加几个列。给 messages 加
 * `edited_at` / `is_revoked` 会让编辑历史无处存放，而 §14.1 的整段约束
 * （只接受更高 revision、引用展示发送时快照）都建立在历史可查之上。
 */
const migration003: Migration = {
  version: 3,
  name: 'message-events-and-send-state',
  statements: [
    // 不可变事件流。没有 UPDATE 路径 —— 表里每一行都是一个已发生的事实。
    //
    // 主键含 revision：同一条消息的每次编辑是一行。(sender_id, message_id) 与
    // messages 表的幂等键对齐，便于按同一把钥匙关联。
    `CREATE TABLE message_events (
       organization_id TEXT NOT NULL,
       sender_id       TEXT NOT NULL,
       message_id      TEXT NOT NULL,
       -- 该事件把消息推进到的 revision。撤回也占一个 revision，
       -- 使「撤回」与「撤回后又收到一条迟到的编辑」可比较
       revision        INTEGER NOT NULL,
       -- message_edited / message_revoked
       event_type      TEXT NOT NULL,
       actor_id        TEXT NOT NULL,
       occurred_at     TEXT NOT NULL,
       -- §14.1：编辑事件包含新内容摘要。撤回事件为 NULL —— tombstone 不带内容
       body            TEXT,
       -- 判定时生效的策略版本，使「当时是否在编辑窗口内」可复算
       policy_revision INTEGER NOT NULL,
       operation_id    TEXT NOT NULL,
       PRIMARY KEY (organization_id, sender_id, message_id, revision)
     ) STRICT`,
    `CREATE INDEX idx_message_events_lookup
       ON message_events(organization_id, sender_id, message_id, revision)`,

    // 发送方本地发送状态（§4「离线时界面区分三种状态」）。
    //
    // 与 messages 分表：messages 是**已被服务器接收**的消息，而 pending 的
    // 那条按定义还没被接收。塞进 messages 会让「查我收到的消息」意外查出
    // 自己尚未发出的草稿。
    `CREATE TABLE outgoing_messages (
       organization_id TEXT NOT NULL,
       sender_id       TEXT NOT NULL,
       message_id      TEXT NOT NULL,
       recipient_id    TEXT NOT NULL,
       body            TEXT NOT NULL,
       -- pending / accepted / failed，见 contract 的 OUTGOING_STATES
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       -- accepted 后由服务器给出；pending 与 failed 时为 NULL
       delivery_seq    INTEGER,
       -- failed 时记录终态错误码，供界面按可重试性呈现
       error_code      TEXT,
       attempts        INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (organization_id, sender_id, message_id)
     ) STRICT`,
    `CREATE INDEX idx_outgoing_pending
       ON outgoing_messages(organization_id, sender_id, state)`,
  ],
}

/**
 * 版本 4：通知聚合与评论。
 *
 * §17.1：「聚合按 `(接收人, 来源对象, 事件类型)` 在可配置的聚合窗口（默认 5 分钟）
 * 内进行……保留最早与最新事件引用和计数，不生成 N 条独立记录。」
 *
 * 聚合是**呈现层**的折叠，不是数据的丢弃 —— 「展开后逐条跳转」要求被折叠的
 * 每一条仍然可查。所以这里加的是聚合组表加成员表，而不是给 notifications
 * 加一个 count 列然后丢掉后续条目。
 *
 * §18：「评论包含作者、目标对象与版本、正文、创建时间和 `CommentRevision`；
 * 编辑追加修订，删除写入 tombstone 并保留作者与时间。」与消息编辑同一模型。
 */
const migration004: Migration = {
  version: 4,
  name: 'notification-aggregation-and-comments',
  statements: [
    // 聚合组。键就是 §17.1 的三元组，加上组织分区。
    //
    // window_started_at 记的是**组内最早一条**的时间，窗口从它起算。
    // 若从最新一条起算，持续的提及会让窗口无限延长，一个吵闹的会话
    // 可以永远折叠成一条，用户再也看不到新提醒。
    `CREATE TABLE notification_groups (
       group_id        TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       recipient_id    TEXT NOT NULL,
       source_ref      TEXT NOT NULL,
       event_type      TEXT NOT NULL,
       window_started_at TEXT NOT NULL,
       -- 最早与最新事件引用（§17.1）
       earliest_notification_id TEXT NOT NULL,
       latest_notification_id   TEXT NOT NULL,
       count           INTEGER NOT NULL,
       -- 已读语义作用于整条（§17.1）
       state           TEXT NOT NULL,
       updated_at      TEXT NOT NULL
     ) STRICT`,
    // 同一 (接收人, 来源对象, 事件类型) 在同一时刻只能有一个**开放**的组。
    // 窗口关闭后新事件开新组，因此不能对三元组建唯一索引 —— 用普通索引，
    // 由查询按窗口筛出开放的那个
    `CREATE INDEX idx_notification_groups_key
       ON notification_groups(organization_id, recipient_id, source_ref, event_type,
                              window_started_at)`,

    // 组成员。展开时逐条跳转靠它。
    //
    // 带 organization_id 是冗余的（group_id 已经决定了组织），但 §48 要求
    // **每个**数据库查询携带 OrganizationId。靠「查这张表前先查父表」是靠自觉，
    // 而 schema 层强制是结构性的 —— 多一列换掉一条需要人记住的规则。
    `CREATE TABLE notification_group_members (
       organization_id TEXT NOT NULL,
       group_id        TEXT NOT NULL,
       notification_id TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       PRIMARY KEY (group_id, notification_id)
     ) STRICT`,

    // 评论。§18：不进入 GroupLog，也不参与消息撤回语义
    `CREATE TABLE comments (
       comment_id      TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       -- 目标对象与版本。work_item / resource_version / review / session
       target_kind     TEXT NOT NULL,
       target_id       TEXT NOT NULL,
       target_version  INTEGER,
       author_id       TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       -- 当前修订号。编辑追加 comment_revisions，本列跟着走
       revision        INTEGER NOT NULL DEFAULT 1,
       -- 删除写 tombstone：正文置空但**保留作者与时间**（§18）
       deleted_at      TEXT
     ) STRICT`,
    `CREATE INDEX idx_comments_target
       ON comments(organization_id, target_kind, target_id, created_at)`,

    // CommentRevision：每次编辑一行，正文只存在这里。
    // comments 表刻意没有 body 列 —— 有的话就会有人去 UPDATE 它，
    // 「编辑追加修订」的约束当场破掉
    `CREATE TABLE comment_revisions (
       organization_id TEXT NOT NULL,
       comment_id      TEXT NOT NULL,
       revision        INTEGER NOT NULL,
       body            TEXT NOT NULL,
       editor_id       TEXT NOT NULL,
       occurred_at     TEXT NOT NULL,
       PRIMARY KEY (comment_id, revision)
     ) STRICT`,
  ],
}

/**
 * 版本 5：评审。
 *
 * §18：「`approved` **只对评审时锁定的产物版本生效**。关联产物或提交在评审后
 * 发生变化时，评审自动转为 `superseded` 并要求重新评审，**不允许「批准一个版本、
 * 合入另一个版本」**。」
 *
 * 因此 `artifact_version` 是这张表的核心列，不是附加信息 —— 没有它，
 * 「批准的是哪一版」就无从谈起，上面那条约束也就无法执行。
 */
const migration005: Migration = {
  version: 5,
  name: 'reviews',
  statements: [
    `CREATE TABLE reviews (
       review_id       TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       work_item_id    TEXT NOT NULL,
       requester_id    TEXT NOT NULL,
       reviewer_id     TEXT NOT NULL,
       -- 评审时锁定的产物版本（§18）。批准只对这一版生效
       artifact_ref     TEXT NOT NULL,
       artifact_version INTEGER NOT NULL,
       -- requested / in_progress / approved / changes_requested /
       -- declined / expired / superseded
       state           TEXT NOT NULL,
       note            TEXT,
       due_at          TEXT,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       -- 转为 superseded 时记下当时看到的新版本，便于事后核对
       superseded_by_version INTEGER
     ) STRICT`,
    `CREATE INDEX idx_reviews_work_item
       ON reviews(organization_id, work_item_id, state)`,
    `CREATE INDEX idx_reviews_artifact
       ON reviews(organization_id, artifact_ref, state)`,
  ],
}

/**
 * 版本 6：设备会话与 token。
 *
 * §7：relay「为该设备签发短期 access token 和可轮换的 refresh token」。
 * §34：「设备会话绑定 `AccountId + DeviceId + keyFingerprint + tokenId`，
 * 有短访问期、可轮换刷新期和 token 撤销列表。」
 *
 * ## 只存哈希，不存 token 本身
 *
 * 库被读走时，存明文 token 等于把所有活跃会话一起交出去。存哈希的话攻击者
 * 拿到的是不能直接用的摘要 —— 与密码只存验证值是同一个道理（§9 对密码的要求）。
 *
 * ## 为什么 refresh 也要记 tokenId
 *
 * §34 要求有「token 撤销列表」。撤销要能指名道姓地撤某一个会话，
 * 而不是「把这个设备的所有 token 都作废」—— 后者会把用户在别处的正常会话
 * 一起踢掉。
 *
 * **这张表只在 relay 侧存在。** 插件的本地库是缓存，不持有他人的会话。
 * 两边的迁移自此分叉，这是预期的。
 */
const migration006: Migration = {
  version: 6,
  name: 'device-sessions',
  statements: [
    `CREATE TABLE device_sessions (
       token_id        TEXT PRIMARY KEY,
       account_id      TEXT NOT NULL REFERENCES accounts(account_id),
       device_id       TEXT NOT NULL REFERENCES devices(device_id),
       -- §34：会话绑定到注册时的指纹。设备换了密钥，旧会话就该失效
       key_fingerprint TEXT NOT NULL,
       -- 只存 SHA-256，不存 token 本身
       access_hash     TEXT NOT NULL,
       refresh_hash    TEXT NOT NULL,
       issued_at       TEXT NOT NULL,
       access_expires_at  TEXT NOT NULL,
       refresh_expires_at TEXT NOT NULL,
       -- 撤销后保留行，用于「这个 token 是被撤销的」与「没见过这个 token」
       -- 区分开 —— 后者可能是伪造，前者是已知会话被主动终止
       revoked_at      TEXT,
       revoked_reason  TEXT
     ) STRICT`,
    `CREATE INDEX idx_device_sessions_lookup ON device_sessions(access_hash)`,
    `CREATE INDEX idx_device_sessions_refresh ON device_sessions(refresh_hash)`,
    `CREATE INDEX idx_device_sessions_device ON device_sessions(device_id, revoked_at)`,
  ],
}

/**
 * 设备名称。
 *
 * §7 明确要求注册时提交「公钥、**设备名称**和公钥指纹」，`registerDevice` 也
 * 一直收着这个字段 —— 只是从来没有列可以放，于是它被静默丢掉了。端到端测试
 * 想核对「注册的那台机器叫什么」时才暴露出来。
 *
 * 这不是可有可无的展示字段：§9 的设备撤销要用户在安全中心里认出「哪一台」，
 * 一列 `dev-1755…` 的 ID 认不出任何东西。
 *
 * 既有行填「未命名设备」而不是留空 —— 界面上少一个要处理的 null。
 */
const migration007: Migration = {
  version: 7,
  name: 'device-name',
  statements: [
    `ALTER TABLE devices ADD COLUMN device_name TEXT NOT NULL DEFAULT '未命名设备'`,
  ],
}

/**
 * 在线状态（§9.1）。
 *
 * 一行一「设备 × 组织」：同一台机器可能同时属于多个组织，而在线状态是按
 * 组织回答的 —— 在 A 组织隐藏不该顺带在 B 组织也隐藏。
 *
 * 不保留历史心跳。在线状态是「此刻」的问题；「这台设备什么时候上过线」由
 * 审计与 `devices.last_seen_at` 回答，两件事不要挤在一张表里。
 *
 * `last_interaction_at` 单独存而不是复用心跳时间：host 活着但没人操作，
 * 正是 idle 要表达的东西。只有心跳时间的话，idle 永远不会出现。
 */
const migration008: Migration = {
  version: 8,
  name: 'device-presence',
  statements: [
    `CREATE TABLE device_presence (
       device_id           TEXT NOT NULL,
       account_id          TEXT NOT NULL REFERENCES accounts(account_id),
       organization_id     TEXT NOT NULL,
       last_heartbeat_at   TEXT NOT NULL,
       -- 最近一次用户交互。与心跳分开 —— 见上方说明
       last_interaction_at TEXT NOT NULL,
       PRIMARY KEY (device_id, organization_id)
     ) STRICT`,
    `CREATE INDEX idx_device_presence_account
       ON device_presence(organization_id, account_id)`,
  ],
}

/**
 * 在线可见性（§9.1 的三档）。
 *
 * 一行一「账号 × 组织」：可见性是按组织选的，「在公司组织里隐身、在朋友的
 * 组织里正常」是一个合理的诉求，而把它做成全局设置就表达不了。
 *
 * 没有行时按 `everyone`。默认隐藏会让在线状态整个看起来是坏的 —— 用户
 * 打开界面看到所有人都是「状态未知」，第一反应是功能没做完，而不是
 * 「大家都隐身了」。
 */
const migration009: Migration = {
  version: 9,
  name: 'presence-visibility',
  statements: [
    `CREATE TABLE presence_visibility (
       account_id      TEXT NOT NULL REFERENCES accounts(account_id),
       organization_id TEXT NOT NULL,
       -- everyone / shared_scopes / hidden
       visibility      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       PRIMARY KEY (account_id, organization_id)
     ) STRICT`,
  ],
}

/**
 * 第二验证因素（§8）。
 *
 * 三张表：因素本体、一次性备用码、已消费的 TOTP 时间步。
 *
 * **备用码只存哈希**（§8）。存明文等于把「第二因素」降级成「第一.五因素」——
 * 库被读走时它和密码一起丢。
 *
 * `totp_used_steps` 是重放防护：§8 要求「已消费的时间步在容忍窗口内记录并
 * 拒绝重放」。不记的话，一个被肩窥到或从截图里读到的验证码在 90 秒内可以
 * 被反复使用。这张表要定期清理窗口之外的行（`pruneUsedSteps`）。
 *
 * 三张表都不按组织分区：第二因素属**账号**维度，一个账号可属多个组织（§9），
 * 而「在 A 组织通过了 2FA、在 B 组织没有」不是一个说得通的状态。
 */
const migration010: Migration = {
  version: 10,
  name: 'second-factor',
  statements: [
    `CREATE TABLE second_factors (
       factor_id    TEXT PRIMARY KEY,
       account_id   TEXT NOT NULL REFERENCES accounts(account_id),
       -- P0 只有 totp；webauthn 属 P4
       kind         TEXT NOT NULL,
       -- pending（已登记未验证）/ active / revoked
       state        TEXT NOT NULL,
       -- TOTP 共享密钥，Base32。**这是一个真正的秘密** —— 与备用码不同，
       -- 它无法只存哈希：验码时要用它重算
       secret       TEXT,
       created_at   TEXT NOT NULL,
       activated_at TEXT,
       revoked_at   TEXT
     ) STRICT`,
    `CREATE INDEX idx_second_factors_account ON second_factors(account_id, state)`,

    `CREATE TABLE recovery_codes (
       account_id  TEXT NOT NULL REFERENCES accounts(account_id),
       -- SHA-256。明文只在签发那一次出现过
       code_hash   TEXT NOT NULL,
       created_at  TEXT NOT NULL,
       -- 消费即失效但**不删行**：审计要能回答哪张码在什么时候被用掉了
       consumed_at TEXT,
       -- 重新签发时作废旧的一批
       revoked_at  TEXT
     ) STRICT`,
    `CREATE INDEX idx_recovery_codes_usable
       ON recovery_codes(account_id, consumed_at, revoked_at)`,

    `CREATE TABLE totp_used_steps (
       account_id TEXT NOT NULL REFERENCES accounts(account_id),
       step       INTEGER NOT NULL,
       used_at    TEXT NOT NULL,
       PRIMARY KEY (account_id, step)
     ) STRICT`,
    `CREATE INDEX idx_totp_used_steps_prune ON totp_used_steps(step)`,
  ],
}

/** 全部迁移，按版本升序。新增迁移只能追加，不能修改既有条目。 */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
]
