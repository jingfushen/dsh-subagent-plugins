# DSH 官方是怎么把 Codex / Claude Code 做成「原生子代理」的

- 调查日期：2026-10-25
- 对照运行时：**DeepSeek Harness 0.2.1-rc.3**（`/Applications/DeepSeek Harness.app`，`Info.plist` = 0.2.1-rc.3）
- 取证方式：从 npm 下载与运行时**同版本**的两个官方包，逐行读构建产物 + README；再对照本机 profile 现状
  - `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3`（873 行 `lib/index.js`，含 `run/wire` 两段）
  - `@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`（554 行 `lib/index.js`，含 `process/run` 两段）
  - 能力缝 `@deepseek-ai/dsh-subagent@0.2.1-rc.3`、暴露工具 `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.3`
  - 两份 README（`README.md` / `README.zh.md`）本身就是官方正式文档

> 一句话结论：**DSH 并没有把 Codex / Claude Code 内建进 app**。官方做法是发布两个与运行版本号严格锁定的可选插件包，各包含
> ①一个注册到进程级 `ctx.subagents` 注册表的 **external provider** 行，②一个全局 `subagent_*` 工具行；
> 委派时由 provider 拉起**真正的产品进程**（Codex 的 `app-server --stdio`、Claude Code 的官方 Agent SDK CLI），
> 走产品自己的协议、配置、鉴权和权限语义；DSH 只负责注册、发布、取消、结果投递与清理。

---

## 1. 四层结构（看懂这一节，两个产品就都通了）

```
bundle 层（cordis.patch.yml）   ← Profile 的一层补丁，只插 Host 行
├─ provider 行  @deepseek-ai/dsh-subagent-codex        （Host 平面：注册 ctx.subagents）
│               @deepseek-ai/dsh-subagent-claude-code
└─ tool 行      @deepseek-ai/dsh-tool-subagent (config: provider/toolName/maxDepth)
                └─ 模型看到 subagent_codex / subagent_claude_code
```

| 层 | 角色 | 关键点 |
|---|---|---|
| `@deepseek-ai/dsh-subagent` | 能力缝（seam）：命名 provider 注册表 + 统一启动/结算/取消/容量/发现 | 官方契约：`SubagentProvider { name, capabilities, inheritsParentContext, start }`、`SubagentRun { id, result, dispose }`；`startActivation()` 只在「已接受、可取消」后才返回 |
| `@deepseek-ai/dsh-subagent-codex` / `-claude-code` | 产品 provider（external，一次性） | `capabilities` 全 false、`inheritsParentContext=false`、**不实现 `prepareContinuable`** → 天然 one-shot，没有本地子会话 |
| `@deepseek-ai/dsh-tool-subagent` | 模型侧工具 | `provider` + `toolName` + `maxDepth`；provider 出现才挂载、消失即卸载；先返回 childId，结算后给父 Agent 完成通知 |
| `cordis.patch.yml`（`dsh.bundle.patch`） | Profile 层 | 只插 **Host 平面**行，任何 profile 可选用（含 headless / SDK / ACP）；不委派就不起进程 |

**「原生」的三重含义**（官方 README 与实现共同保证）：

1. **原生进程/协议**：不是把 prompt 翻译成 REST 调用，而是启动真产品——Codex 用官方 `@openai/codex@0.153.4` 的 `app-server --stdio`（JSON-RPC），Claude Code 用官方 `@anthropic-ai/claude-agent-sdk@0.3.263` 拉起的真 CLI。
2. **原生配置/鉴权/权限**：`HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`、用户/项目设置、`CLAUDE.md`、登录态全部照旧；DSH 不伪造、不登录、不越过产品自己的沙箱与权限模型（只覆盖行配置里显式声明的 `model` / `permissionMode` / `env`）。
3. **原生隔离**：子代理是 external activation，**父 Session 里不产生子会话**；只拿到 childId 与最终答案（或安全诊断），产品侧 reasoning、工具流量、stderr、usage、工作区 diff 都不进父上下文。`dsh-tool-subagent` 的 `maxDepth: provider-managed` 也不再设递归上限，交给产品自己管。

---

## 2. Codex 官方实现（`@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3`）

### 2.1 包与 bundle 形状

```yaml
# cordis.patch.yml —— 一个 insert，两行 Host 行
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

- 依赖：`@openai/codex: 0.153.4`（固定版本）+ `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.3`；peer 全部是本版本 DSH 包（`~4.0.5` cordis、`0.2.1-rc.3` 其余）。
- 可执行文件**包内解析、不查 PATH**：`require.resolve("@openai/codex/package.json")` → `dirname + manifest.bin.codex`，argv 固定为
  `[process.execPath, <包内 codex.js>, "app-server", "--stdio"]`（`lib/index.js:535-538, 581-588`）。平台二进制由 `@openai/codex` 的 optionalDependencies（如 `@openai/codex-darwin-arm64`）提供；缺了就在首次委派时报安全失败，**绝不 fallback 到宿主 `codex`**。

### 2.2 注册

```js
const name = "subagent-codex";
const inject = ["subagents", "subprocess"];          // 依赖 seam 与子进程服务

apply(ctx, config) {
  // 校验 disposeGraceMs（正有限数、≤ MAX_TIMER_DELAY_MS）
  ctx.subagents.registerProvider(new CodexProvider(...));   // lib/index.js:870
}
```

- Provider 描述符：`{ name: providerName(默认 codex), capabilities: NO_START_CAPABILITIES, inheritsParentContext: false, start(request) }`（`lib/index.js:823-855`）。
- `NO_START_CAPABILITIES = { agentOptions:false, agentPreset:false, outputSchema:false, depthLimit:false }`：
  一旦调用方请求这些能力，seam 在 `start()` 之前就以 `UNSUPPORTED_CAPABILITY` 拒绝（**显式拒绝，不是静默忽略**）。
- 没有 `prepareContinuable` → seam 走 `manager.startExternal`：一次执行、无续聊、无冷启动恢复。

### 2.3 一次 run 的生命周期（发布点 = 「thread 已经存在」）

1. 只接受**非空 text block**（不接受图片/其它 block），cwd 由 seam 解析为绝对路径并校验可用。
2. `ctx.subprocess.spawn({ argv, cwd, stdio: 全 pipe, graceMs: disposeGraceMs, env })`；stderr 原样转写 Host stderr，**不进父 Session**。
3. `initialize`（`clientInfo: deepseek-harness`）→ `initialized` 通知。
4. `thread/start`：`{ cwd, ephemeral: true, model?, ...THREAD_PERMISSION_PARAMS[mode] }`，并要求返回 `thread.ephemeral === true`；否则失败。
5. **只有走到这一步才把 run 发布出去**（返回 `SubagentRun`）。发布前任何失败都要先清理子进程再拒绝（`lib/index.js:637-740`；README 的 “publishes only after Codex returns a valid ephemeral thread”）。
6. `turn/start`：`{ threadId, input: [{type:"text", text, text_elements: []}] }`；只接受本 run 的 thread/turn 通知，其它线程的消息忽略；早期通知先缓冲，`turn/start` 响应到达后 `commitTurnId` 再对齐。
7. 终局 `turn/completed`（status ∈ completed / interrupted / failed）→ 结算。
8. **答案选择优先级**：最新 `agentMessage.phase === "final_answer"` > 最新 `partial_answer`（稳定答案、后续可能还有输出）> 兼容回退「`phase: null`」；`commentary` 永不入选；未知 phase 直接失败；成功但答案空白 = `invalid-result`。

### 2.4 权限模式（映射到 Codex 官方 `thread/start` 字段）

| provider `permissionMode` | 发给 `thread/start` 的字段 | 语义 |
|---|---|---|
| `never`（默认） | `approvalPolicy: "never"`（sandbox 不写） | 从不询问；执行失败按 Codex 原生沙箱语义回给模型 |
| `approve-for-me` | `approvalPolicy: "on-request"`、`approvalsReviewer: "auto_review"`、`sandbox: "workspace-write"` | 权限请求走 Codex 自动审查，不找人 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: "never"`、`sandbox: "danger-full-access"` | 跳过审批与沙箱，必须显式选 |

无人值守应答（server→client 请求）：
- command/file 审批 → 有 `cancel` 选 `cancel`，否则 `decline`（没有可用决策就 fail closed）；
- permissions 请求 → `{permissions:{}, scope:"turn"}`；
- tool 的 user input → `{answers:{}}`；
- MCP elicitation → `{action:"decline", content:null, _meta:null}`；
- 未知方法 → 直接抛错（**fail closed**，不猜）；
- 每次无人值守决策都会记一条安全诊断（可出现在最终 diagnostic 里）。

### 2.5 取消 / 销毁 / 失败

- 取消：请求 signal → 私有 `AbortController.abort()` + 尽力发 `turn/interrupt {threadId,turnId}`；本地取消胜出，结算为 `aborted`。
- 销毁：`wire.close()` → `stdin.end()` → `child.terminate()` → `waitForExit()` → 等 `child.done`；失败归 `teardown/unknown`；`dispose()` 幂等。
- 终止分级（SIGTERM → SIGKILL 的宽限）由 `dsh-subprocess` 按 `graceMs=disposeGraceMs`（默认 3000）统一负责。
- 失败分类：`limit | access-policy | service | transport | product-error | invalid-result | unknown`，早期退出归 `process`；连接/流错误保留数字 `httpStatusCode`；`contextWindowExceeded` 映射 `stopReason: "max-tokens"`。诊断文本只含固定事实（stage/category/exit code/signal），seam 上限 4096 字节，不含工具入参、文件内容、凭据。

### 2.6 环境变量

- 子进程环境 = `dsh-subprocess` **凭证清洗后的父环境**（`*KEY* / *PASSWORD* / *SECRET* / *TOKEN*`、`DSH_*` 会被移除）**再叠加**行配置 `env`。
- 想给子进程 API key，必须写进行配置 `env`；`HOME` / `CODEX_HOME` 透传，所以原生登录与 `~/.codex/config.toml` 照旧生效。

---

## 3. Claude Code 官方实现（`@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`）

### 3.1 包与 bundle 形状

```yaml
- insert:
    - id: subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-claude-code'
    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: claude-code
        toolName: subagent_claude_code
        maxDepth: provider-managed
```

- 依赖：`@anthropic-ai/claude-agent-sdk: 0.3.263`（固定）、`@anthropic-ai/sdk 0.93.0`、`@modelcontextprotocol/sdk`、`zod`；peer 同上。
- **没有宿主 CLI fallback**：CLI 由 Agent SDK 自己的 optionalDependencies 提供（`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263` 等 8 个平台包，内含 `claudeCodeVersion: 2.1.263` 的 CLI）。SDK 从**自己模块目录**解析可执行文件；缺 payload 直接报 “Native CLI binary … not found. Reinstall …”，不会搜 PATH，DSH 也从不设置 `pathToClaudeCodeExecutable`。

### 3.2 注册

与 Codex 完全同构：`name="subagent-claude-code"`、`inject=["subagents","subprocess"]`、`capabilities = NO_START_CAPABILITIES`、`inheritsParentContext=false`、只有 `start()`、`ctx.subagents.registerProvider(...)`（`lib/index.js:492-552`）。所以能力集合同样是「父级不支持 agentPreset / agentOptions / outputSchema / 数字 maxDepth，请求即拒绝」。

### 3.3 一次 run 的生命周期（发布点 = 「SDK 已交出活的 CLI 句柄」）

1. 只接受非空 text block，拼成一段 prompt；`persistSession: false`。
2. `query({ prompt, options })`；options 的关键项（`lib/index.js:297-331`）：
   - 私有 `AbortController`、`cwd`、可选 `model`、`env = {...scrubbedParentEnv(), ...row.env}`；
   - `disallowedTools`（默认含 `AskUserQuestion`；plan 模式再加 `ExitPlanMode`）；
   - `permissionMode`；非 bypass 时 `canUseTool: () => deny + 诊断`；
   - `onElicitation` → `{action:"decline"}`；`onUserDialog` → `{behavior:"cancelled"}`（只放行 `refusal_fallback_prompt` 一种对话框并取默认）；
   - **`spawnClaudeCodeProcess` hook**：SDK 请求拉起 CLI 时，把 `{command,args,cwd,env,signal}` 翻译成 `dsh-subprocess` 的 spawn spec（argv=`[command,...args]`、`stdio` 管道、`graceMs=disposeGraceMs`、`signal`、env overlay），再用 `ManagedClaudeCodeProcess` 把 seam 的句柄投影成 SDK 的 `SpawnedProcess`（`kill()` 忽略 SDK 信号、统一走 `child.terminate()`）。
3. `query()` 返回后**必须已经捕获到活句柄**，否则 `query-start/unknown` 失败；这就是发布点。
4. 遍历完整 SDK 消息流；只认 `type === "result"`，且 **`subtype === "success"`、`is_error === false`、`result` 非空白**，并要求迭代器正常结束 → `completed`（输出即该段文本）。其余一律 `invalid-result`。
5. 取消：请求 signal → `controller.abort()`；结算 `aborted`；销毁顺序 `query.close()` → `child.terminate()` → `waitForExit()` → 等 done，失败归 `teardown`；终止分级同样由 `dsh-subprocess` 的 SIGTERM→SIGKILL 宽限负责。
6. 失败分类：`error_max_turns / error_max_budget_usd / error_max_structured_output_retries → limit`；`error_during_execution → product-error`；启动 `query-start/unknown`；执行中 `query-run`；早退 `process/process`；其他 `unknown`。

### 3.4 权限模式（`permissionMode`）

| 值 | 原生行为 |
|---|---|
| `dontAsk`（默认） | 未预授权的操作直接拒绝，不产生交互提示 |
| `acceptEdits` | 接受文件编辑；残余权限提示仍被无人值守回调拒绝 |
| `auto` | 交给 Claude Code 原生分类器决定；提示仍拒绝 |
| `plan` | 原生计划模式，禁 `AskUserQuestion` + `ExitPlanMode`，不批准执行，完成的计划作为最终答案 |
| `bypassPermissions` | 显式 `allowDangerouslySkipPermissions: true`，跳过权限检查（危险，须显式选择） |

> 注意：`~/.claude` 的登录态/设置照旧生效（省略 `settingSources` 即原生加载 user/project/local 设置与 `CLAUDE.md`）；但父环境里 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 这类名字会被凭证清洗掉，要显式传 API key 必须写进行配置 `env`。

---

## 4. 两个实现的对照

| 维度 | Codex | Claude Code |
|---|---|---|
| 产品接入方式 | 无官方 SDK → 自己实现最小 JSON-RPC app-server 客户端 | 官方 Agent SDK `query()` + `spawnClaudeCodeProcess` hook |
| 可执行文件 | 包内 `@openai/codex` wrapper（`process.execPath` 执行） | SDK 平台 payload 内的 pinned CLI（2.1.263） |
| 权限映射 | 映射为 `thread/start` 的 `approvalPolicy/approvalsReviewer/sandbox` | 映射为 SDK `permissionMode` / `allowDangerouslySkipPermissions` / 回调 |
| 无人值守 | 审批 cancel/decline、permissions 空、user input 空、elicitation decline、未知 fail closed | `AskUserQuestion` 禁用、`canUseTool` deny、elicitation decline、dialog cancelled |
| 答案提取 | 自有通知流 + 答案 phase 优先级（final > partial > null） | 严格 `result/success/!is_error/非空` |
| 共同点 | 一次委派 = 新进程 + 一次执行；发布前失败必清理；stderr/reasoning/工具流量不进父会话；env 清洗后叠加；无宿主 CLI 回退；诊断安全化（≤4096B）；`disposeGraceMs` 默认 3000 | 同左 |

**能力封口**：两者都 `NO_START_CAPABILITIES`，因此 `agentPreset`、`agentOptions`、`outputSchema`、数字 `maxDepth` 在 seam 层就被拒绝——外部产品 provider 不能假装支持这些只有本地 Agent 才能兑现的能力。

---

## 5. 官方「怎么启用」

### 5.1 插件页一键装（官方入口）

当前 DSH 的插件清单里，这两个包是 **`official: true`、`availability: "missing"`** 的官方条目（可直接在离线清单看到，安装时才下载）：

| 条目 | installTarget.spec |
|---|---|
| Codex subagent | `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3` |
| Claude Code subagent | `@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3` |

启用后：安装包 → 选中它的 profile layer → layer 插入上面那两行 Host 行 → provider 注册 + `subagent_codex` / `subagent_claude_code` 成为**全局工具**（所有 preset 可见，包括 minimal；preset 若自己注册同名工具则遮蔽全局工具）→ 不委派就不起任何进程。关闭 = 取消选择 layer，包仍保留；卸载是单独操作。

> 注意：这是「全局工具」形态。若希望工具只在某个自定义 preset 内可见（本机现有做法），不要启用 bundle layer，改用手工两行（见下）。

### 5.2 手工两行（等价、可控）

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: subagent-codex            # 或 subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-codex'   # 或 '@deepseek-ai/dsh-subagent-claude-code'
      # config 可选：providerName / model / env / permissionMode / disposeGraceMs
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

完整配置面（两个包一样，共 5 个字段）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `codex` / `claude-code` | `ctx.subagents` 注册名，进程内唯一 |
| `model` | 原生设置 | 只覆盖每次 run 的 model，其余原生 |
| `env` | `{}` | 叠加在清洗后的父环境上（API key、代理都走这里） |
| `permissionMode` | `never` / `dontAsk` | 无人值守权限模式（见上表） |
| `disposeGraceMs` | `3000` | 子进程终止分级的宽限 |

**没有 `reasoningEffort` 字段**——官方 Codex 包至今不支持（本机 `codex.mjs` 的 `-c model_reasoning_effort=` 是本地 shim 增值项）。

---

## 6. 与本机现状的对照（2026-10-25）

### 6.1 现状盘点

| 项 | 现状 |
|---|---|
| 运行版本 | DSH **0.2.1-rc.3**（Electron app） |
| 本机 codex 后端 | `@local/dsh-codex-agy-preset`（本地 bundle，已安装）：`codex.mjs` 用绝对路径**再导出** `~/.dsh/subagent-backends` 里的官方 `@deepseek-ai/dsh-subagent-codex@0.2.0-rc.2`，并额外注入 `-c model_reasoning_effort="max"` |
| 本机 agy 后端 | 自研 `agy.mjs`（Antigravity CLI `--print`，强制走 127.0.0.1:12450 代理），按官方 codex provider 结构仿写 |
| 本机 claude 后端 | **未安装**（`~/.dsh/subagent-backends` 无 claude 包） |
| 工具行 | 桌面/web 两个 profile 的 preset 里都已有 `tool-subagent-claude-code`（`provider: claude-code`，`disabled: true`）——provider 名与官方默认值一致，只差 provider 包 |
| 旧字段 | 工具行里仍有 `backgroundMode: one-shot/continuable`；0.2.1 的 `dsh-tool-subagent` 配置面已无此字段（未知键会被忽略，one-shot 由 external provider 天然决定），属历史遗留 |
| 官方入口 | 两个官方 bundle 条目均为 `availability: missing`（未安装），可随时装 |

### 6.2 版本错位（关键）

- 本机独立安装树 `~/.dsh/subagent-backends/node_modules` 是 **0.2.0-rc.2 全家桶**（`dsh-subagent`、`dsh-subprocess`、`dsh-sdk-protocol` 都是 0.2.0-rc.2），与当前运行时 0.2.1-rc.3 差一个版本；官方 0.2.1-rc.3 包的 peer 要求精确 `0.2.1-rc.3`。
- 迁移/新增时应**新开一个独立目录**（如 `~/.dsh/subagent-backends-0.2.1`）装 `0.2.1-rc.3` 全家桶，避免 npm 在旧树里为 peer 版本打架；本地 `*.mjs` 再导出路径随之更新。

### 6.3 三个必踩的坑

1. **provider 重名**：官方 layer 会注册 `codex`（默认名）；本机 bundle/手写行也注册 `codex` → 第二个挂载会被 `DUPLICATE_PROVIDER` 拒绝。官方与自研**二选一**，不能同时挂。
2. **工具行重复**：官方 bundle 自带 `tool-subagent-codex` 全局工具；若 preset 里你还留着同名工具行，preset 内的行会遮蔽全局行（可用，但别指望两套同时生效）。
3. **参数进不了官方行**：官方 layer 插入的 provider 行**没有 config**；`env`（本机 codex 必须带 `HTTP(S)_PROXY=127.0.0.1:12450`）、`model`、`permissionMode` 需要**再写一条按 id 覆盖的 patch**（`- id: subagent-codex` + `config:`），或直接用手工两行形态。

### 6.4 建议路线

- **A（最省事，官方全托）**：插件页启用两个官方 bundle → 删/禁本地 bundle 与 profile 里所有 `codex` provider 行、停用同名工具行 → 用 profile patch 给 `subagent-codex` 行补 `env` 代理；`subagent_claude_code` 直接可用（前提：本机 Claude Code 已有登录态，或行配置 `env` 里给 `ANTHROPIC_API_KEY`）。代价：两个工具变成**所有 preset 全局可见**，且失去 `reasoningEffort` shim。
- **B（推荐，保持现有「preset 级控制」架构）**：新建 `~/.dsh/subagent-backends-0.2.1` 装 `codex@0.2.1-rc.3` + `claude-code@0.2.1-rc.3`；沿用本机 `*.mjs` 再导出模式：codex 保留 `reasoningEffort` shim（官方仍无此字段），新增 `subagent-claude-code.mjs`；Host 行注册 `codex` / `claude-code` 两个 provider；preset 里启用现成的 `subagent_claude_code` 行 + 保留 `subagent_codex` 行。不启用官方 bundle layer，工具仍只在「Codex + AGY」preset 可见，代理/模型/权限都可按 preset 配。
- **C（最小改动）**：只加 Claude Code：装 `@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3` + 一个新 `subagent-claude-code.mjs` 再导出 + Host 行；把两个 profile 里 `tool-subagent-claude-code` 的 `disabled: true` 去掉（或按 preset 逐个开）。codex 保持现状不动。

### 6.5 落地后验证清单

1. 挂载日志无 `DUPLICATE_PROVIDER`、无 “provider not found”；目标 preset 工具列表出现 `subagent_codex` / `subagent_claude_code`。
2. 各跑一次真实委派（简单只读任务）：先拿到 childId，再收到最终答案完成通知；父上下文里**没有**子代理的 reasoning / 工具调用 / stderr。
3. 权限抽查：`dontAsk` 下要求写文件应被拒绝并带安全诊断；`plan` 模式应只返回计划。
4. 取消抽查：中断一次长任务 → 结算为 `aborted`，无残留子进程（`ps` 看不到 codex/claude 子进程）。
5. 若走 API key 路线：确认 key 是写进行配置 `env`（父环境同名变量会被清洗）。
6. 回滚：禁行/删行 + 恢复 profile 备份 + 重启会话；官方包卸载是独立操作。

---

## 7. 证据与索引

- 包（npm，版本 = 运行时版本）：`@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3`、`@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`；两者 `package.json` 的 `dsh.bundle.patch` 指向各自 `cordis.patch.yml`。
- 关键源码位置（包内相对路径）：
  - Codex：`lib/index.js` —— `THREAD_PERMISSION_PARAMS`(19-30)、`codexAppServerArgv`(581-588)、`textTask`(598-607)、`disposeCodexChild`(614-634)、`startCodexRun`(637-802)、provider/apply(823-871)
  - Claude：`lib/index.js` —— 权限模式(130-139)、`textTask`(196-205)、`successfulResult`(211-225)、`consumeClaudeQuery`(231-249)、`disposeClaudeCodeChild`(264-288)、`claudeQueryOptions`(297-331)、`startClaudeCodeRun`(335-489)、provider/apply(492-552)
  - seam：`lib/types/types.d.ts`（`SubagentCapabilities` 113-121、`SubagentRun` 271-287、`SubagentProvider` 296-341）；`lib/types/index.d.ts:288`（`registerProvider`）
  - tool：`lib/types/index.d.ts`（Config 16-44，`maxDepth` 语义 35-43）
- 官方文档：两个包的 `README.md` / `README.zh.md`（含 Use this package / Understand the implementation / Model Experience / Known Limitations，已引用为权威来源）；包内 “Further Exploration” 指向仓库内 `docs/subsystems/subagent.md` 与 `docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.md`（未随包分发）。
- 平台 payload：`@openai/codex@0.153.4` 的 optionalDependencies（`codex-<platform>-<arch>`）；`@anthropic-ai/claude-agent-sdk@0.3.263` 的 8 个平台包（`claudeCodeVersion: 2.1.263`）。
- 本机对照：`~/.dsh/subagent-backends`（0.2.0-rc.2 独立树）、`~/.dsh/local-bundles/dsh-codex-agy-preset/`、`~/.dsh/profiles/{desktop,web}/cordis.patch.yml`、插件清单（`plugin_manager list_bundles` 中的 official 条目与 installTarget）。
