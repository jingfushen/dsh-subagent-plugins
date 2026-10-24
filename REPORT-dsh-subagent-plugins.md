# DSH 插件：ZCode / Antigravity / Kimi Code / Codex imagegen

- 日期：2026-10-25
- 运行环境：DeepSeek Harness **0.2.1-rc.3**（desktop profile）
- 参照对象：官方 `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3`、`@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`
- 安装状态：四个插件均以独立 bundle 安装到 **desktop profile**，`install_bundle` 全部返回 `application: applied`，工具已在当前会话可见并完成真实调用验证。

## 1. 交付物

四个**互相独立**的 bundle 包（不是一个大杂烩），位于 `output/dsh-subagent-plugins-20261025/`：

| 包 | 类型 | provider / tool | 文件 |
|---|---|---|---|
| `@local/dsh-subagent-zcode` [目录](dsh-subagent-zcode/) | 子代理 | provider `zcode` → `subagent_zcode` | package.json / cordis.patch.yml / index.js / bin/zcode-cli.cjs / README / locale×2 / icon |
| `@local/dsh-subagent-antigravity` [目录](dsh-subagent-antigravity/) | 子代理 | provider `antigravity` → `subagent_antigravity` | package.json / cordis.patch.yml / index.js / README / locale×2 / icon |
| `@local/dsh-subagent-kimicode` [目录](dsh-subagent-kimicode/) | 子代理 | provider `kimicode` → `subagent_kimicode` | package.json / cordis.patch.yml / index.js / README / locale×2 / icon |
| `@local/dsh-codex-imagegen` [目录](dsh-codex-imagegen/) | 模型工具 | tool `codex_imagegen` | package.json / cordis.patch.yml / index.js / README / locale×2 / icon |

结构完全照官方 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只插 Host 行；子代理插件各插「provider 行 + `@deepseek-ai/dsh-tool-subagent` 工具行（`maxDepth: provider-managed`）」两行，imagegen 插件插一行自定义工具。所有 `index.js` 都是自包含的（只 import `node:` 内置模块，无裸包名），因为 link 安装的 bundle 目录没有自己的 `node_modules`。

## 2. 各插件实现要点

### 2.1 ZCode（`subagent_zcode`）

- 真实 CLI：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（ZCode **0.17.0**）。它按 `dirname(argv[1])/provider/zcode-builtin.json` 定位内置 provider 配置，所以插件自带 `bin/zcode-cli.cjs` launcher：在 `$TMPDIR/dsh-zcode-cli-<hash>/` 建 `provider/zcode-builtin.json` 符号链接（copy 兜底）、把 `argv[1]` 指向该目录、再加载真实 bundle；`appPath` 可配置。
- 一次调用 = `node <launcher> -p <task> --json --cwd <cwd>`；stdout 为 JSON（`response` 字段），stderr 的 `ZCode Built-in skipped (not-due)` 是无害警告。
- 配置：`appPath`、`mode`（build/edit/plan/yolo/guarded，缺省走 CLI 对 `--prompt` 默认的 yolo）、`extraArgs`、`disposeGraceMs`、`env`。认证沿用 `~/.zcode` 内的 ZCode.app 登录态。

### 2.2 Antigravity（`subagent_antigravity`）

- 真实 CLI：`agy`（Antigravity CLI 1.4.7），一次调用 `agy --output-format json "--print=<task>"`；envelope 只有 `status: SUCCESS` 且无 `error` 才接受。
- **全局走网络代理的声明**已按要求显式落地两处：
  - [index.js:70](dsh-subagent-antigravity/index.js#L70)：`const GLOBAL_PROXY = 'http://127.0.0.1:12450'`；
  - [cordis.patch.yml:24](dsh-subagent-antigravity/cordis.patch.yml#L24)：provider 行里一行可见的 `proxy: http://127.0.0.1:12450`。
- 每个子进程环境强制 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY = proxy`、`NO_PROXY=''`（子进程环境会被 DSH 清洗，不显式写就会丢）；spawn 前做 1500ms TCP 探活，代理不通直接报代理本身，而不是 agy 那句误导性的账号错误。
- 配置：`proxy`、`command`、`model`、`effort`、`dangerouslySkipPermissions`、`extraArgs`、`verifyProxy`、`disposeGraceMs`、`env`。

### 2.3 Kimi Code（`subagent_kimicode`）

- 真实 CLI：Kimi Code `2.3.1`（npm `@moonshot-ai/kimi-code`，bin `kimi`），一次调用 `kimi -p <task> --output-format text`，cwd 为父会话工作目录；stdout 为回答，stderr 为诊断。
- 配置：`command`、`model`、`permissionMode`（`ask` 默认 / `yolo` / `auto` / `plan`）、`extraArgs`、`disposeGraceMs`。
- 前置条件：`npm i -g @moonshot-ai/kimi-code` + **`kimi login`（设备码流程）**。本机已装 CLI，但**尚未登录**。

### 2.4 Codex imagegen（`codex_imagegen`）

- 旧实现（`dsh-codex-agy-preset` 内置 `./imagegen.mjs`）源码已随历史清理丢失，只留下历史配置：工具名 `codex_imagegen`、入参 `prompt` / `out`（可选绝对路径）/ `refs`（参考图）、返回图片路径、`model: gpt-6-astra`、`reasoningEffort: xhigh`。本次按该契约用独立 bundle 重做。
- 每次调用 spawn 一次真实 `codex exec`：
  `codex exec --skip-git-repo-check --ephemeral -C <cwd> -s <sandbox> --color never --json -o <lastMessage> [-m model] [-c model_reasoning_effort=…] [-i ref]… <task>`
  任务文本要求 Codex 用**内置** imagegen 技能（`image_gen` 工具，不用 Python/API fallback），保存到 `out` 或返回其生成路径。
- 通过 `-o` 最后一条消息 + `$CODEX_HOME/generated_images` 最新文件双保险解析图片路径，校验文件存在后返回 `{ path, prompt }`。
- 配置：`command`、`model`、`reasoningEffort`、`sandbox`（默认 `danger-full-access`，图片落在 workspace 之外必须可写）、`proxy`、`verifyProxy`、`timeoutMs`（默认 600000）、`disposeGraceMs`、`env`。用 ChatGPT 登录的内置 `image_gen`，不需要 `OPENAI_API_KEY`。

## 3. 安装记录

四次 `plugin_manager install_bundle`（target = 工作区绝对目录）都返回 `enabled: true, application: applied`，无 warnings：

| bundle | 版本 | 行 |
|---|---|---|
| `@local/dsh-subagent-zcode` | 1.0.0 | `subagent-zcode`、`tool-subagent-zcode` |
| `@local/dsh-subagent-antigravity` | 1.0.0 | `subagent-antigravity`、`tool-subagent-antigravity` |
| `@local/dsh-subagent-kimicode` | 1.0.0 | `subagent-kimicode`、`tool-subagent-kimicode` |
| `@local/dsh-codex-imagegen` | 1.0.0 | `tool-codex-imagegen` |

- 安装器把它们写进 `~/.dsh/profiles/desktop/package.json`（`link:` 依赖）并在 `node_modules/@local/` 建符号链接指向本工作区目录。
- 四个工具在当前会话已可见（系统下发过 tool schema 更新），说明 Host 行注册成功。
- 旧的 `@local/dsh-codex-agy-preset` 保持原样未动；新插件 provider 名用 `zcode` / `antigravity` / `kimicode`，与旧的 `codex` / `agy` 不冲突。

## 4. 端到端验证（真实调用）

| 调用 | 结果 |
|---|---|
| `subagent_antigravity` → "Reply with exactly: OK,ANTIGRAVITY-DSH" | ✅ **completed**，返回 `OK,ANTIGRAVITY-DSH` |
| `subagent_zcode` → "Reply with exactly: OK,ZCODE-DSH" | ✅ **completed**，返回 `OK,ZCODE-DSH` |
| `codex_imagegen` → "minimalist teal rounded square app icon" + `out=/tmp/dsh-imagegen-e2e.png` | ✅ 生成 1254×1254 PNG（1,025,669 B），文件见 [artifacts/codex-imagegen-e2e.png](artifacts/codex-imagegen-e2e.png)，白底居中 teal 圆角方块，符合 prompt |
| `subagent_kimicode` → 同样的冒烟任务 | ⚠️ **预期失败**（CLI 未登录）：父会话收到 bounded 诊断「kimi is not signed in or has no default model — run `kimi login` …」+ CLI 原文；**成功路径未验证**，按约定留给用户登录后自测 |

## 5. 额外系统改动（都已做，需知悉）

1. ZCode 插件要求系统中存在 `/Applications/ZCode.app`（3.16.3 已装且已登录）；`appPath` 可配置。
2. Kimi Code CLI：`npm i -g @moonshot-ai/kimi-code@2.3.1` 已安装；npm 全局 bin 目录（`~/.local/lib/node-v24.20.0-darwin-arm64/bin`）不在 Host PATH 上，因此补了一个符号链接 `~/.local/bin/kimi → …/bin/kimi`。**Kimi 成功调用仍需你执行一次 `kimi login`。**
3. `codex_imagegen` 依赖本机 `codex` 已登录（ChatGPT），并需要代理 `127.0.0.1:12450` 在线（插件已默认写入，可在行配置改为 `proxy: null` 直连）。

## 6. 覆盖 / 禁用 / 回滚

- 改配置（不改包）：在 profile patch 里按 row id 覆盖，例如
  ```yaml
  - id: subagent-antigravity
    config:
      proxy: http://127.0.0.1:12450
      effort: max
  ```
- 禁用某个工具：Plugins 页面关闭对应 bundle，或给 tool 行加 `disabled: true`。
- 卸载：`plugin_manager` `remove_bundle`（或在 Plugins 页面 Remove）四个包名；如需彻底清理再删除工作区目录。
- 回滚整套改动（恢复安装前的 profile 状态）：
  1. 依次 `remove_bundle`：`@local/dsh-subagent-zcode`、`@local/dsh-subagent-antigravity`、`@local/dsh-subagent-kimicode`、`@local/dsh-codex-imagegen`；
  2. 如需还原 Kimi CLI 安装：`npm uninstall -g @moonshot-ai/kimi-code` 并删除 `~/.local/bin/kimi`；
  3. 本报告目录与插件源码可整体删除，不影响其它 profile 文件；
  4. 旧的 `@local/dsh-codex-agy-preset` 未被修改，无需处理。

## 7. 已知限制与未验证项

- **Kimi 成功路径未验证**（未登录）：只验证了 CLI 存在、argv 构造、失败路径与 bounded diagnostic。README 明确标注。
- **显示元数据渲染**（Plugins 页标题/描述/图标）未截图验证；安装包已带 `locale/en.json`、`locale/zh.json`、原創 `icon.svg`，`list_bundles` 中描述已生效。
- 取消/长任务销毁只做了代码层与 teammate 的 in-memory seam 测试；未对真实长跑 CLI 做中断演练（逻辑照搬已生产使用过的 `agy.mjs`/官方 codex provider 的终止阶梯）。
- ZCode 的 `appPath` 只验证 macOS 默认安装路径；ZCode 大版本可能改内置 provider 配置布局。
- `codex_imagegen` 单次生成约数十秒到数分钟、按张计费；`timeoutMs` 默认 10 分钟，可用行配置调整。
- 四个插件的工具目前是 **Host 级全局工具**（与官方 bundle 行为一致，所有 preset 可见）；如只想给特定 preset 用，需在 profile patch 里禁用全局行、在目标 preset 内另插 tool 行。

## 8. 相关材料

- 官方实现拆解报告：[REPORT-dsh-native-subagents.md](REPORT-dsh-native-subagents.md)
- 端到端截图（图片生成结果）：[artifacts/codex-imagegen-e2e.png](artifacts/codex-imagegen-e2e.png)
- 各插件 README 内含完整配置表、前置条件与验证记录。
