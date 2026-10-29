# Agent Team 魔改：外部 Agent 作为原生队友

- 日期：2026-10-25
- 插件：`@local/dsh-team-external`（`output/dsh-subagent-plugins-20261025/dsh-team-external/`）
- 运行环境：DSH 0.2.1-rc.3 desktop profile（Agent Team 实验 bundle 已启用）
- 状态：已安装（`install_bundle` → `application: applied`），已完成真实端到端验证

## 1. 目标与结论

要求：**魔改智能体团队，让 ZCode / Antigravity / Kimi Code 这些外部 agent 能进去，像 DSH 原生 teammate 一样工作。**

结论：不需要 fork 官方 Team 包，也不需要改 `~/.dsh` 里的已装代码。新插件在运行时**装饰** `ctx.agentTeams`
服务实例，把一个外部 CLI 会话映射成一条真实 Team 花名册成员：

- 用真正的 `team/member` 事件落盘 → `list_agents`、任务看板 owner、浏览器 roster 投影全部原生可见；
- `send_message` 走 CLI 会话续聊（agy `--conversation` / zcode `--resume` / kimi `-S`），忙时排队；
- 外部 turn 结束 → 以原生队友完全一致的 Team peer message 形式送到 Lead（`Team message from <name>: …`，
  `agent-message` relay source，`root.steer()`）；
- `wait_agent` 能被外部 turn 的起止唤醒；`interrupt_agent` 终止正在跑的 CLI，之后仍可续聊；
- 任务看板 `reassign owner=<外部成员名>` 正常解析出 `ownerName`。

## 2. 实现方式（为什么这样改）

官方 Team 把 teammate 定义为「可续聊的进程内子 Agent」：roster id = 子 Session id，inbox = DSH Session
inbox。外部 CLI 是进程外的一次性运行，没有 inbox、没有可续聊 Session，所以官方 `spawn_teammate` 起不了它们。

插件的做法：

1. **成员持久化**：调用 Team 内部 journal 的 `transact` + `appendAndFlush`，先写 `provisioning` 再写
   `active` 的 `team/member` 事件（与官方 `spawnAdmitted` 完全同构），因此投影/看板/浏览器 roster 无感。
2. **服务装饰**：在 `apply` 里替换 `agentTeams` 实例的 `listMembers` / `sendMessage` / `interrupt` /
   `waitForChange` / `spawnTeammate` 方法，外部目标走桥接，其它目标原样委托（保留原生行为）；effect 清理时恢复。
3. **驱动层**（`lib/drivers.js`）：每个产品一个适配器，负责「新会话 argv / 续聊 argv / 解析回答与会话 id」。
4. **会话 id 持久化**：成员记录本身 + `$DSH_HOME/team-external/state.json`，进程重启/插件 HMR 后仍能续聊。
5. **消息与活动**：turn 起止调用 `TeamActivity.notify`；回答以原生 peer message 送达 Lead。
6. **额度**：外部成员有自己的 `maxExternalMembers` 预算（默认 8），不占用原生 `maxMembers`（本会话原生额度已满 8，
   否则外部成员会被挡住）。

7. **Team CLI 控制通道（v1.1）**：Host 进程内起 token 保护的 unix socket；`bin/team-cli.cjs` 由外部队友在
   自己的 shell 里调用，把原生的「花名册 / 任务板 / 发消息 / wait」暴露给它（任务操作直接走 Team 内部
   `service.tasks`，权限按成员身份校验）。每个 turn 注入 socket/token/member 环境变量，首个 turn 自动附协议说明。

## 3. 三个后端（均已实测）

| provider | 启动 | 续聊 | 会话 id |
|---|---|---|---|
| antigravity | `agy --output-format json --dangerously-skip-permissions --print=<task>` | 前加 `--conversation <id>` | JSON `conversation_id` |
| zcode | `node bin/zcode-cli.cjs -p <task> --json --cwd <cwd>` | 前加 `--resume <id>` | JSON `sessionId` |
| kimicode | `kimi -p <task> --output-format stream-json` | `-S <id> -p <task> --output-format stream-json` | 最后一行 `session.resume_hint.session_id` |

- agy 打印模式无法弹权限询问，默认 `--dangerously-skip-permissions`（可配置关闭，改用 agy `permissions.allow`）。
- ZCode 走插件自带 launcher（修复 `zcode-builtin.json` 定位），与 zcode 子代理插件同一套。
- Kimi 用 NDJSON `stream-json`：回答取最后一条非空 assistant content，会话 id 取 resume_hint；`-y/--auto/--plan`
  与 `-p` 互斥不能用；cwd 必须是物理路径（macOS `/private/...`）；`KIMI_CODE_NO_AUTO_UPDATE=1`。

## 4. 端到端验证（真实调用，deaktop profile 内）

| 场景 | 结果 |
|---|---|
| `spawn_external_teammate` agy-recon（antigravity） | ✅ 返回 running；`list_agents` 显示 `provider: external:antigravity` |
| agy 首轮回答 | ✅ 收到 peer message `Team message from agy-recon: STARTED` |
| `send_message` agy-recon 问暗号 | ✅ 续聊返回 `ORBIT-7`（证明同一 conversation） |
| `spawn_external_teammate` zcode-recon（zcode） | ✅ 首轮 `READY`；续聊问暗号返回 `ZETA-9` |
| 插件 HMR 重载后续聊（agy） | ✅ 重载后仍从持久化 id 续聊返回 `ORBIT-7`，再测 `PING` |
| `interrupt_agent` zcode-recon（正在跑 sleep 25） | ✅ `previousStatus: "running"`；随后 inactive + diagnostics `["interrupted"]`；再 `send_message` 返回 `BACK` |
| `wait_agent` | ✅ 外部 turn 起止都能唤醒（多次 timedOut:false） |
| 任务看板 `reassign owner=zcode-recon` | ✅ `ownerName: "zcode-recon"`，任务随后删除清理 |
| Kimi（未登录） | ✅ 失败路径：peer message 收到 bounded 诊断「No model configured … run `kimi login`」；`list_agents` diagnostics 同样展示；**成功路径未验证** |
| in-memory seam 自测 | ✅ 41/41：argv/env、排队、装饰/委托、重名/非法名拒绝、卸载恢复等 |

## 4.1 v1.1：外部队友自助使用团队（Team CLI）

v1.0 的桥接让 Lead 能操外部队友，但外部队友自己不能发消息、不能看/领/完成任务。v1.1 新增 **Team CLI**：
插件在 Host 进程内起一个 token 保护的 unix socket 控制通道，并给每个外部 turn 注入
`DSH_TEAM_CLI / DSH_TEAM_SOCKET / DSH_TEAM_TOKEN / DSH_TEAM_MEMBER / DSH_TEAM_NAME` 环境变量；首个 turn
的 prompt 前自动附一段协议说明，告诉外部队友用自己 shell 工具运行 `node "$DSH_TEAM_CLI" ...`：

```
whoami | list | tasks | task-get <id>
task-create --subject ... --description ...
task-claim <id> --rev N | task-complete <id> --rev N | task-edit ...
send --to lead "..." | send --to <autre-external> "..." | wait --timeout 30000
```

外部队友因此能：自己读花名册和任务板、自己 claim/complete/create 任务、主动给 Lead 发进展或结果、
给其他外部队友发消息。Lead 发给外部队友的消息按原生格式加 `Team message from <sender>:` 前缀。
控制通道校验 token，socket 文件权限 0600。

**v1.1 新增实证：**

| 场景 | 结果 |
|---|---|
| 新建 task-9，spawn 全新 `cli-agy`（antigravity），首轮 prompt 自带协议 | ✅ 它自己运行 `whoami` / `tasks` / `task-claim task-9 --rev 1` / `task-complete task-9 --rev 2` / `send --to lead ...` |
| 任务板状态 | ✅ task-9 `ownerName: cli-agy`，revision 3，`completed`（Lead 只是创建和观测） |
| 主动消息 | ✅ 收到 peer message：`CLI-AGY-OK: claimed and completed task-9`，随后 `DONE` |
| 另一个后端 | ✅ `cli-zcode`（zcode）自己跑 `whoami` + `send --to lead "CLI-ZCODE-OK: ..."` |
| 内存自测（v1.1） | ✅ 37/37：首轮协议/环境注入、控制 socket 鉴权、任务 create/claim/complete/过期 revision、给 Lead 发消息、真实 `team-cli.cjs` 子进程调用、排队、装饰/委托、重名拒绝、卸载恢复、socket 关闭 |

## 5. 限制

- **v1.1 已解决**：外部队友现在能通过注入的 Team CLI 自己发消息、读花名册、claim/complete/create/edit
  任务；Lead 仍然可以直接 assign/编辑/完成任务，两条路径都可用。外部队友仍没有通用 DSH 工具（文件/搜索等），
  这是预期行为（它们用自己产品的工具）。
- **仍不支持**：外部队友不能直接给原生 DSH 队友发消息（桥接无法绕过 Lead 的授权给原生子 Agent 的 inbox 投递）；
  先发给 lead，由 Lead 转达。
- 一个成员同一时刻只跑一个 CLI turn；运行中收到的消息排队到下一轮（不是原生 step-boundary steer）。
- 被杀掉的 turn 不会自动重放，但会话本身可继续续聊。
- 插件在 mount 时装饰服务实例；若未来 DSH 重命名 Team 服务，需要更新行配置。
- 浏览器 roster 对「外部成员实时 running」的展示依赖插件桥接，durable 投影只带 phase+provider。
- 非 macOS 未验证。

## 6. 安装 / 回滚

- 安装：`plugin_manager` `install_bundle`（target = 本目录绝对路径）→ `application: applied`；工具
  `spawn_external_teammate` 下一次模型请求即可用。
- 重载代码：Plugins 页/`plugin_manager` 先 disable 再 enable bundle（已验证可热重载；运行中的外部 turn 会被终止）。
- 卸载：disable/remove bundle，effect 清理恢复原始 Team 服务方法并终止外部 turn；已写入的 `team/member`
  记录保留（Team 成员名和原生一样是永久的）。
- 额外产物：`~/.dsh/team-external/state.json`（外部会话 id 索引，可安全删除，删除后成员仍可从新会话继续）。

## 7. 相关文件

- [README](dsh-team-external/README.md)（安装/配置/用法）
- [index.js](dsh-team-external/index.js)（bridge 本体）
- [lib/drivers.js](dsh-team-external/lib/drivers.js)（三后端适配器）
- [bin/zcode-cli.cjs](dsh-team-external/bin/zcode-cli.cjs)（ZCode launcher）
- 之前的四个独立插件与报告：[REPORT-dsh-subagent-plugins.md](REPORT-dsh-subagent-plugins.md)
