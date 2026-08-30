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

**当前的认证是部署期共享密钥，不是设备身份。** 这一条必须说在前面，因为它比看上去弱：

- 共享密钥证明的是「这是一台被授权接入的 relay 的 host」，**不证明请求来自哪个账号** —— 账号由请求头 `x-dsh-account` 声明。
- 也就是说，**任何持有密钥的一方都可以声称自己是任意账号**。

真正的绑定要靠 §7.1 的设备签名：请求方以 Ed25519 私钥对方法、路径、请求体摘要、时间戳、nonce、`DeviceId` 和目标组织签名。**校验侧已经实现**（`src/domain/identity/request-signing.ts`，含 nonce 去重与时间偏移容忍窗口），缺的是会话建立与 token 下发，属 `P0-b`。

之所以不先接一个「假 token」让它看起来更像认证：一个看起来像认证、实际只是共享密钥的东西，比一个明说自己是共享密钥的东西危险得多。

**在设备会话接上之前，不要把这个 relay 暴露到不受信任的网络。**

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
| **设备会话与请求签名** | 校验侧已实现，缺会话建立与 token 下发 | 认证只到「授权接入的 host」，不到账号。见上方安全边界 |
| **账号开通端点** | §7 规定注册走邀请码，`invite-codes.ts` 已实现消费逻辑，但没有 HTTP 入口 | 账号目前要直接写库。不顺手加一个「凭共享密钥就能建账号」的端点：密钥证明的是接入授权，不是开户权限，混在一起等于谁拿到密钥谁就能造账号 |
| **contract 发布成包** | vendored 副本 + 防漂移校验 | 同步要手动跑一次脚本 |
| **host 侧的 relay 客户端** | 插件目前直接调本地领域代码，还没走 relay | 两边尚未真正对接 —— 这是下一步 |
| **TLS** | 进程只听明文 HTTP | 生产部署必须放在反向代理后面 |

## 许可

MIT
