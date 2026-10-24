# ZCode 子智能体插件 · `@local/dsh-subagent-zcode`

给 DeepSeek Harness 的委派 seam 注册一个**一次性（one-shot）**子智能体后端：provider 名
`zcode`，模型工具名 `subagent_zcode`。每次委派都会在后台启动一个独立的 ZCode CLI 进程，
在指定工作目录里执行任务，把 CLI 的 JSON 结果里的 `response` 作为子智能体最终输出交回。

- 产物目录：`output/dsh-subagent-plugins-20261025/dsh-subagent-zcode/`
- 定位：workspace bundle（linked bundle），由 DSH 的 bundle patch 机制挂载
- 自包含：`index.js` 只 import `node:` 内置模块，不依赖任何裸包说明符（bare specifier）
- 验证基线：ZCode CLI 0.17.0（ZCode.app 内置 `zcode.cjs`）+ Node 24.20.0 + macOS

---

## 1. 目录结构与文件职责

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包元数据；`dsh.bundle.patch` 指向 `cordis.patch.yml`；`exports` 暴露入口 / locale / icon |
| `cordis.patch.yml` | 两条挂载行：`subagent-zcode`（provider）+ `tool-subagent-zcode`（模型工具） |
| `index.js` | 自包含的 ESM 插件：`name` / `inject` / `apply`，构造 argv、spawn、解析 JSON、settle 结果、释放进程 |
| `bin/zcode-cli.cjs` | CLI 启动器：搭建 `<stableDir>/provider/zcode-builtin.json` 布局、重写 `process.argv[1]`、`require()` 真正的 ZCode CLI |
| `locale/en.json`、`locale/zh.json` | 插件市场标题与描述（中英） |
| `icon.svg` | 原创图标（青绿方块 + 折角 `Z`），无外部资源 |

---

## 2. 挂载行（`cordis.patch.yml`）

```yaml
- insert:
    - id: subagent-zcode
      name: '@local/dsh-subagent-zcode'
    - id: tool-subagent-zcode
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: zcode
        toolName: subagent_zcode
        maxDepth: provider-managed
```

- provider 行注册进程全局的 `zcode` 名称。**provider 名进程内唯一**，同一个 DSH 进程里只能挂一次。
- tool 行复用官方 `@deepseek-ai/dsh-tool-subagent`，绑定 `provider: zcode`，并起独立工具名
  `subagent_zcode`（与 `subagent` / `subagent_codex` 等互不冲突）。
- `maxDepth: provider-managed`：这是**出进程（out-of-process）**后端唯一正确的取值——数字深度上限
  需要 provider 的 `depthLimit` 能力，而 CLI 子进程无法执行父进程的深度约束；递归预算由 CLI 自己管理。

---

## 3. 配置项（`subagent-zcode` 行的 `config:`）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `appPath` | `string`（绝对路径） | `/Applications/ZCode.app/Contents/Resources` | ZCode.app 的 `Contents/Resources` 目录。非标准安装位置（如挂载的 DMG）必须显式指定；插件在**挂载时**校验 `glm/zcode.cjs` 与 `config/provider/zcode-builtin.json` 存在，缺失会立刻报错而不是等第一次委派失败 |
| `mode` | `'build' \| 'edit' \| 'plan' \| 'yolo' \| 'guarded'` | 不传（CLI 默认 `yolo`） | 透传为 `--mode <mode>`，控制 CLI 的权限模式 |
| `model` | `string` | 不传 | **CLI 0.17.0 没有模型命令行参数**，本字段会被忽略并在加载时打一条 warning；要指定模型请用 `extraArgs` 传 CLI 将来提供的参数 |
| `extraArgs` | `string[]` | `[]` | 追加到 argv 末尾的原始 CLI 参数，用于实验性能力（如 `--toolsearch-mode`、`--locale`）。按原样逐个作为 argv 元素传递，不经过 shell |
| `disposeGraceMs` | `number` | `3000` | **已发布 run 被 dispose** 时，SIGTERM→SIGKILL 之间的宽限（透传为 subprocess seam 的 `graceMs`）；必须是正的有限毫秒数且 ≤ `2147483647` |
| `env` | `Record<string, string>` | `{}` | 追加/覆盖给 CLI 子进程的环境变量。subprocess seam 只继承“脱敏后的父环境”（保留 `PATH`、`HOME`、locale，剔除 `*KEY*` / `*TOKEN*` / `*SECRET*` / `*PASSWORD*` 和 `DSH_*`），所以需要代理、额外凭据等必须在这里显式给出 |

示例（把 ZCode 装到别处 + 收紧权限模式 + 走代理）：

```yaml
- id: subagent-zcode
  name: '@local/dsh-subagent-zcode'
  config:
    appPath: /Volumes/ZCode 3.16.3-arm64/ZCode.app/Contents/Resources
    mode: build
    disposeGraceMs: 5000
    env:
      HTTPS_PROXY: http://127.0.0.1:12450
      HTTP_PROXY: http://127.0.0.1:12450
```

---

## 4. 前置条件

1. **安装 ZCode.app**（macOS）。插件默认读取
   `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`；换位置就配 `appPath`。
2. **登录 ZCode**。CLI 复用桌面端凭据，存放于 `~/.zcode/cli/` 与 `~/.zcode/v2/`
   （`credentials.json`、`provider_config.json` 等）。在 ZCode.app 里完成登录即可；
   也可在终端跑 `zcode login`（若把 CLI 装到了 PATH）。未登录时 CLI 会以非 0 退出，
   provider 会把它归类为 `stopReason: 'error'` 并把 stderr 尾部写进 `diagnostic`。
3. **网络**：本机实测直连可用（`https://zcode.z.ai`）。需要代理时通过 `config.env` 显式传入，
   因为子进程环境经过脱敏，不保证继承宿主的代理变量。
4. **Node**：使用运行 DSH 的同一个 Node 可执行文件（`process.execPath`），无需在 PATH 里装 node。
   若插件跑在 Electron 主进程里，插件会为子进程补上 `ELECTRON_RUN_AS_NODE=1`（真 Node 会忽略该变量）。

---

## 5. 运行机制

### 5.1 argv

```text
<process.execPath> <plugin>/bin/zcode-cli.cjs -p <task> --json --cwd <cwd> [--mode <mode>] [...extraArgs]
```

- prompt 由 `-p` 以**单个 argv 元素**传入，绝不经过 shell；超过 **256KB** 直接拒绝（argv 上限），
  空 prompt（无 text 块或全为空白）同样拒绝。
- `--cwd` 子进程工作目录：取 `request.cwd` 绝对路径，缺失时回退 `request.parent.session.header.cwd`；
  必须是已存在的绝对目录，否则 `start()` 立即报错。
- 子进程 spawn 成功后才发布 run；spawn 本身失败会让 `start()` 拒绝（不产生半死的 run handle）。

### 5.2 启动器解决了什么问题

ZCode CLI 内部用 `dirname(realpath(process.argv[1]))/provider/zcode-builtin.json` 定位内置 provider
配置（`--help` 之外的隐藏前提，实测 0.17.0 源码如此）。直接跑 `glm/zcode.cjs` 会因此报
“无法定位 CLI ZCode Built-in Provider Config”。`bin/zcode-cli.cjs` 在系统临时目录准备一个稳定布局：

```text
$TMPDIR/dsh-zcode-cli-<hash>/
├── entry.cjs                       # 标记文件（CLI 会对 argv[1] 做 realpathSync，路径必须存在）
└── provider/
    └── zcode-builtin.json          # → <appPath>/config/provider/zcode-builtin.json 的符号链接
```

然后把 `process.argv` 重写为 `[node, <stableDir>/entry.cjs, ...原参数]`，再 `require()` 真正的
`zcode.cjs`。`<hash>` 由 appPath + 用户名 + uid 派生，跨进程稳定复用；app 升级导致配置文件变化时，
下次运行会重新指向，无需重启 DSH。该目录只做布局映射：插件运行时不会修改 ZCode.app 与 DSH profile。

### 5.3 结果解析与失败判定

stdout 形如（CLI 0.17.0，`--json`）：

```json
{
  "sessionId": "sess_…",
  "traceId": "…",
  "turnId": "turn_…",
  "response": "OK,ZCODE-PLUGIN",
  "usage": { "inputTokens": 17882, "outputTokens": 41, "totalTokens": 17923, "…": "…" },
  "eventCount": 48,
  "projection": { "status": "idle", "turnCount": 1, "contextUsed": 17923, "contextWindow": 200000 }
}
```

- 取 `response` 作为子智能体输出（text 内容块）。
- stderr 里的 `ZCode Built-in skipped (not-due)` 之类是**无害告警**，不影响结果，也不会被当作失败。
- 以下情况一律 `stopReason: 'error'`，并在 `diagnostic`（截断到 4096 UTF-8 字节）里给出原因：
  - CLI 非 0 退出（含被信号杀死）；
  - stdout 无法解析出 JSON 对象；
  - JSON 对象里 `error` 非空；
  - 缺失 `response` 或 `response` 全为空白。
- 若 stdout 出现过 JSON 对象前的日志行，解析器会从第一个 `{` 到最后一个 `}` 兜底再试一次（容错但不放宽语义）。
- 请求 abort：本地取消优先于观测到的完成；`result` 解析为 `stopReason: 'aborted'`，并走释放阶梯。

### 5.4 释放阶梯（dispose）

`run.dispose()` 幂等（memoized teardown）：移除 abort 监听 → 本地标记取消 → `child.terminate()`
（seam 内 SIGTERM → `graceMs` → SIGKILL 进程树）→ `child.waitForExit()` → `child.done`。
`stdin` 在 `'ignore'` 模式，不参与协议，关闭时尽力 `end()`。

---

## 6. 一次性（one-shot）限制

- **每个子任务一个新进程**：不复用 CLI 会话，不支持 `send_message`、继续对话、恢复（resume）或
  DSH 的 continuable 子智能体会话；工具调用只返回“已启动”并异步给出完成通知。
- **不继承父上下文**：`inheritsParentContext = false`，子智能体只看到本次 prompt，看不到父会话历史。
- **不支持父进程强制的启动特性**：`capabilities` 全为 `false`（`agentOptions` / `agentPreset` /
  `outputSchema` / `depthLimit`）。请求这些特性的委派会被 seam 在启动前拒绝；工具行因此配置
  `maxDepth: provider-managed`。
- **权限模式**：`-p` 默认 `yolo`。需要更保守的沙箱行为时配 `mode: build` / `edit` / `plan` / `guarded`。
- **prompt 走 argv**：受 OS argv 上限约束，插件在 256KB 处提前报错。
- **并发**：seam 可对同一 provider 并发调用；每次 start 都是独立子进程、独立 run id，互不影响。

---

## 7. 冒烟测试（不安装进 DSH）

### 7.1 直接跑启动器（真 CLI）

```bash
cd /tmp
node "<plugin>/bin/zcode-cli.cjs" \
  -p "Reply with exactly: OK,ZCODE-PLUGIN" \
  --json --cwd /tmp
```

期望：退出码 `0`；stdout 是 JSON，`response` 为 `OK,ZCODE-PLUGIN`；stderr 可能有
`ZCode Built-in skipped (not-due)`（无害）。实测约 7 秒（含模型往返）。

### 7.2 通过插件代码跑（模拟 seam，不安装）

`/tmp/zcode-plugin-smoke.mjs` 用假的 `ctx.subagents` / `ctx.subprocess` 加载本包 `index.js`：
注册 provider → 断言 `name='zcode'`、无能力、`inheritsParentContext=false` → 调 `provider.start()`
（真 CLI）→ 断言 `stopReason='completed'` 且输出为 `OK,ZCODE-PLUGIN` → 调两次 `dispose()` 验证幂等
→ 另测空 prompt 与“启动前已 abort”两条拒绝路径。

```bash
node /tmp/zcode-plugin-smoke.mjs
```

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 挂载时报 `ZCode CLI bundle not found at …` | 没装 ZCode.app，或装在非默认位置：配置 `appPath` |
| 挂载时报 `ZCode built-in provider config not found …` | ZCode.app 安装不完整，重装或换 `appPath` |
| `diagnostic` 以 `zcode-cli launcher:` 开头 | 启动器自身的前置检查失败（bundle/配置/临时目录权限），按冒号后的文案处理 |
| `stopReason: 'error'` 且 diagnostic 是认证错误 | 在 ZCode.app 里重新登录（凭据在 `~/.zcode/`）；确认子进程能读到 `HOME` |
| 退出码非 0、diagnostic 是 stderr 尾部 | 直接按 §7.1 复跑，看完整 stderr |
| 网络超时 | 通过 `config.env` 给子进程显式设置 `HTTPS_PROXY` / `HTTP_PROXY` |
| 升级 ZCode 后结果格式变化 | 用 §7.1 看新 stdout；解析器只强依赖 `response` 字段，新增字段不影响 |

---

## 9. 已验证 / 未验证

已验证（本机，ZCode CLI 0.17.0 / Node 24.20.0 / macOS）：

- 启动器布局可让真 CLI 在 `-p … --json --cwd /tmp` 下正常返回 JSON；
- 成功路径：exit 0、`response` 精确等于 `OK,ZCODE-PLUGIN`；
- 插件自身：`apply()` 注册、`start()` spawn/解析/settle、`dispose()` 幂等；
- 拒绝路径：空 prompt、启动前已 abort、非法配置（`mode` / `extraArgs` / `disposeGraceMs`）。

未验证（本次不安装 bundle，也不改 DSH profile）：

- 在真实 DSH 会话里挂载后，`subagent_zcode` 工具端到端调用（工具注册、完成通知渲染）；
- `--mode` 各取值下的真实行为差异（只验证了参数名与可选值来自 `--help`）；
- 任务中途取消（SIGTERM 打断正在执行的 CLI）的实际时延；只验证了启动前取消；
- 非 macOS 主机、非默认 `appPath`（挂载 DMG 内 app）的完整跑通；
- ZCode 不同大版本之间 `zcode-builtin.json` 定位逻辑是否变化。
