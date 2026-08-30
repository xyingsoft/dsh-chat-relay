# dsh-chat-relay

**dsh-chat 的 relay 服务** —— 共享状态的持有者：投递队列、成员关系、工作项、通知、审计。

配套的 DSH 插件在 [xyingsoft/dsh-chat](https://github.com/xyingsoft/dsh-chat)。

## 为什么是两个仓库

界线不在 client / host 之间，在 **host / relay** 之间 —— 依据是设计文档 §41：

> host 与 relay **独立升级**，因此协议兼容性必须显式协商而不是靠同步发版……升级顺序固定为 relay 先升、host 后升。

文档为 host↔relay 设计了整套协议版本协商，**唯独没有给 client↔host 设计任何类似的东西** —— 因为后者本来就该同版本发布。DSH 的装载模型也印证这一点：插件的渲染端与 host 端在同一个包里。

所以：

| 仓库 | 内容 | 跑在哪 |
|---|---|---|
| `xyingsoft/dsh-chat` | client + host + contract | 用户本机（DSH 插件） |
| `xyingsoft/dsh-chat-relay`（本仓库） | 队列、成员关系、审计、工作项、通知 | 服务器 |

## 运行

```bash
yarn install
yarn check          # 契约校验 + 类型 + 测试
yarn build

DSH_CHAT_RELAY_SECRET=<共享密钥> \
DSH_CHAT_RELAY_DB=/var/lib/dsh-chat/relay.db \
DSH_CHAT_RELAY_HOST=0.0.0.0 \
DSH_CHAT_RELAY_PORT=8787 \
yarn start
```

`DSH_CHAT_RELAY_SECRET` **不配则拒绝启动** —— 不是「启动了但谁都连不上」。后者会让运维看到一个健康的进程，却查不出为什么所有请求都是 401。

监听地址默认 `127.0.0.1`。要对外服务必须显式设 `DSH_CHAT_RELAY_HOST` —— 默认监听 `0.0.0.0` 的服务是被扫到的第一批。

## 安全边界

认证有两条路径，**按强度优先**。

### 1. 设备会话 token（正路）

`POST /api/identity/register` 用**邀请码 + 设备公钥**开户，返回一对 token。之后
`authorization: Bearer <access token>`，账号与设备由服务端从会话查出来，**调用方说了不算**。

几条不是随手定的取舍：

- **邀请码的三种失败（不存在 / 已消费 / 已过期）返回同一个错误码。** 区分开就能拿它枚举哪些邀请码存在过。
- **token 只存 SHA-256 哈希。** 库被读走时，存明文等于把所有活跃会话一起交出去。
- **token 不是 JWT，是 32 字节随机串。** 自描述的 token 会诱使调用方直接读里面的字段而不去查库，那样撤销就失效了 —— 一个已撤销的 JWT 看起来仍然完全合法。
- **refresh 是轮换不是延长。** 旧 refresh 用过即撤销。不轮换的话，泄露的 token 可以被无限次使用而不留痕；轮换后攻击者用过一次，真正的用户下次刷新就会失败 —— 那是可观测的信号。
- **会话绑定设备指纹**（§34）。设备换了密钥旧会话立即失效，否则密钥轮换等于没换。

注册与刷新端点**不要求任何已有凭证** —— 注册的场景恰恰是还没有授权的时候。要求先有共享密钥才能注册，等于把开户权限交给任何持有部署密钥的人。

### 2. 共享密钥回落（默认关闭）

`allowSharedSecretIdentity: true` 才启用，启动时打一行 stderr 警告。它只证明「这是一台被授权接入的 host」，账号由 `x-dsh-account` 请求头声明 —— 也就是说**任何持有密钥的一方都可以声称自己是任意账号**。仅供还没走注册流程的部署临时使用。

一个看起来像认证、实际只是共享密钥的东西，比一个明说自己是共享密钥的东西危险得多，所以它默认关、会警告、且在文档里说清楚。

### 3. 请求签名（§7.1）—— 配了指纹才启用

token 证明「持有者曾经通过认证」，**不证明这次请求确实来自那台设备** —— token 被复制走就能被别人用。请求签名才是设备身份的证明：每个请求用设备私钥对方法、路径、请求体摘要、时间戳、nonce、`DeviceId`、目标组织和 relay 指纹签名。两者是叠加而非二选一。

**启用方式是配 `DSH_CHAT_RELAY_TLS_FINGERPRINT`。** 不配就不校验，启动时会打一行说明「具体没在检查什么」的警告。

为什么要配而不是自动获取：签名覆盖 relay 的 TLS 公钥指纹（用于把证明绑定到特定 relay），但本进程**只听明文 HTTP**，TLS 在反向代理那一层终止 —— 进程自己无从知道那张证书的指纹。编一个假指纹让校验「看起来在跑」比不启用更糟，那样每个人都以为绑定生效了。

指纹取法（对着你的证书跑）：

```bash
openssl x509 -in cert.pem -pubkey -noout   | openssl pkey -pubin -outform der   | openssl dgst -sha256 -hex
```

启用后：

- 凭**会话 token** 进来的请求必须带签名，不带就 401 —— 允许「没带就跳过」等于让攻击者删个请求头就绕过整套机制
- 凭**共享密钥**进来的不要求签名，那条路径上根本没有设备私钥
- 身份三件套（注册/刷新/注销）不要求签名，它们是会话的引导路径
- 时间超窗返回 `TIME_SKEW` 并附带服务器时间与允许窗口，**不混同为认证失败**；且只在签名本身正确时返回 —— 否则它就是一个免认证的时间预言机

## 契约层是 vendored 副本

`src/contract/` 是从 `xyingsoft/dsh-chat` 的 `packages/chat/contract/src` 复制过来的，由 `scripts/verify-contract.mjs` 校验未被就地修改 —— 逐文件校验和 + 一个写在脚本里的**带外锚点**。只放清单文件的话，改协议的人顺手重新生成一次清单就过了。

正确的做法是把 contract 发布成包，两边都消费发布物。当前受限于凭证（手上的 GitHub token 只有 `public_repo`，没有 `write:packages`，npm 也未登录），先用 vendored 副本。**发布成包仍然是目标**，见下方缺口表。

同步契约：

```bash
cp ../DSH-CHAT/packages/chat/contract/src/*.ts src/contract/
node scripts/verify-contract.mjs --update   # 然后按提示同步 EXPECTED_AGGREGATE
```

## 已知未完成项

| 项 | 现状 | 影响 |
|---|---|---|
| **请求签名默认不启用** | 需要部署方配 TLS 指纹（进程只听明文 HTTP，自己拿不到）| 不配时，被复制走的 token 可以被别人用。见上方安全边界 |
| **contract 发布成包** | vendored 副本 + 防漂移校验 | 同步要手动跑一次脚本 |
| **host 侧的注册流程** | relay 端点已就绪，插件还没有「填邀请码开户」的界面 | 开户目前要手工调 `/api/identity/register` |
| **TLS** | 进程只听明文 HTTP | 生产部署必须放在反向代理后面 |

## 许可

MIT
