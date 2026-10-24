# DSH Native Subagent Plugins

Four independent [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin bundles that
expose one-shot external agent CLIs as native subagents, plus a Codex image-generation tool.
Structure follows the official `@deepseek-ai/dsh-subagent-codex` / `@deepseek-ai/dsh-subagent-claude-code`
bundles: a bundle patch inserts Host-plane rows — a provider row on `ctx.subagents` and a
`@deepseek-ai/dsh-tool-subagent` delegation-tool row (`maxDepth: provider-managed`).

Built and verified against **DSH 0.2.1-rc.3** (desktop profile, macOS). Each plugin is a separate
bundle, installed independently — no shared aggregator package.

| Plugin | Kind | Model-facing tool | Backend | Verified |
|---|---|---|---|---|
| [`dsh-subagent-zcode`](dsh-subagent-zcode/) | subagent provider | `subagent_zcode` | ZCode CLI 0.17.0 (`/Applications/ZCode.app/.../glm/zcode.cjs`) | ✅ real delegation returned `OK,ZCODE-DSH` |
| [`dsh-subagent-antigravity`](dsh-subagent-antigravity/) | subagent provider | `subagent_antigravity` | Antigravity CLI `agy` 1.4.7, forced through a declared global proxy | ✅ real delegation returned `OK,ANTIGRAVITY-DSH` |
| [`dsh-subagent-kimicode`](dsh-subagent-kimicode/) | subagent provider | `subagent_kimicode` | Kimi Code CLI 2.3.1 (`kimi -p ... --output-format text`) | ⚠️ failure path verified; success path needs `kimi login` |
| [`dsh-codex-imagegen`](dsh-codex-imagegen/) | model tool | `codex_imagegen` | Codex CLI `codex exec` + built-in imagegen skill (`image_gen`) | ✅ generated a real 1254×1254 PNG |

Reports:

- [REPORT-dsh-subagent-plugins.md](REPORT-dsh-subagent-plugins.md) — implementation, installation,
  end-to-end verification, prerequisites, rollback, known gaps.
- [REPORT-dsh-native-subagents.md](REPORT-dsh-native-subagents.md) — how the official DSH Codex /
  Claude Code native-subagent packages are built (source-level deep dive), used as the template here.

## Repository layout

```
dsh-subagent-zcode/          # provider `zcode`  + tool `subagent_zcode`
dsh-subagent-antigravity/    # provider `antigravity` + tool `subagent_antigravity`
dsh-subagent-kimicode/       # provider `kimicode` + tool `subagent_kimicode`
dsh-codex-imagegen/          # tool `codex_imagegen`
REPORT-dsh-subagent-plugins.md
REPORT-dsh-native-subagents.md
artifacts/                   # end-to-end evidence (generated image)
```

Each plugin directory is a complete DSH bundle package: `package.json` (with `dsh.bundle.patch`),
`cordis.patch.yml`, a self-contained `index.js` (only `node:` builtins — linked bundles have no own
`node_modules`), `locale/en.json` + `locale/zh.json`, `icon.svg`, and a README with the full config table.

## Installation

Recommended (DSH performs package install + profile-layer selection):

1. Clone this repository somewhere stable, e.g. `git clone https://github.com/jingfushen/dsh-subagent-plugins.git ~/dsh-subagent-plugins`.
2. In a DSH session, ask the agent to install each bundle with the `plugin_manager` tool,
   `action: install_bundle`, `target: /abs/path/to/<plugin-directory>` (one per directory).
3. The install applies live (`application: applied`); the new tool appears on the next model request.
   The plugin rows are Host-plane rows, so the tools are global (visible to every preset).
   Disable or override a row by id in the profile patch if a preset should not see it.

Manual alternative: add the same two rows from the plugin's `cordis.patch.yml` to the profile
`cordis.patch.yml`, and install the package with
`dsh plugin --profile <profile> add link:/abs/path/to/<plugin-directory>`.

### Requirements

- **ZCode plugin**: `/Applications/ZCode.app` (3.16.3+), signed in inside ZCode. The bundled
  `bin/zcode-cli.cjs` launcher repairs ZCode's `zcode-builtin.json` lookup; `appPath` is configurable.
- **Antigravity plugin**: `agy` on `PATH` (Antigravity CLI installer), authenticated, and a reachable
  proxy at `127.0.0.1:12450` (see the global-proxy declaration below; set `proxy: null` to disable).
- **Kimi Code plugin**: `npm i -g @moonshot-ai/kimi-code` then `kimi login` (device-code flow).
  Without a login every delegation fails with a bounded "No model configured / run kimi login" diagnostic.
- **Codex imagegen plugin**: `codex` signed in with ChatGPT; the built-in `image_gen` tool needs no
  `OPENAI_API_KEY`. Default proxy `127.0.0.1:12450`; image output lands outside the workspace so the
  child runs with `sandbox: danger-full-access` by default (configurable).

### Antigravity global proxy declaration

The requirement was one explicit "all traffic through the proxy" declaration. It exists twice, kept in sync:

- [`dsh-subagent-antigravity/cordis.patch.yml`](dsh-subagent-antigravity/cordis.patch.yml) — the visible
  one-line row config `proxy: http://127.0.0.1:12450`;
- [`dsh-subagent-antigravity/index.js`](dsh-subagent-antigravity/index.js) — `const GLOBAL_PROXY = 'http://127.0.0.1:12450'`;
  every child environment is forced to `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=proxy` with `NO_PROXY=''`
  (DSH spawns children from a credential-scrubbed environment), and a pre-spawn TCP probe reports a dead
  proxy as itself instead of agy's misleading account error.

## Configuration and removal

Every plugin README documents its config fields. A profile-layer override replaces the whole `config`:

```yaml
- id: subagent-antigravity
  config:
    proxy: http://127.0.0.1:12450
    effort: max
```

Remove with `plugin_manager` `remove_bundle` (or the Plugins page). Removing a bundle does not remove
the CLI prerequisites listed above.

## Notes and limitations

- The tools are Host-level global tools (same behavior as the official bundles). They do not create a
  local child Session: the parent gets a child id and, on completion, the final answer or a bounded
  diagnostic; child reasoning/tool traffic/stderr stay out of the parent Session.
- One-shot only: no continuation, resume, or pooling.
- Kimi Code's success path is unverified until a signed-in `subagent_kimicode` run returns an answer.
- The official deep dive ([REPORT-dsh-native-subagents.md](REPORT-dsh-native-subagents.md)) was written
  against DSH 0.2.1-rc.3; protocol/CLI pins may change with DSH or product upgrades.
