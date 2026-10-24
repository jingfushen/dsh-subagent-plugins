# @local/dsh-subagent-kimicode

A self-contained DeepSeek Harness (DSH) plugin bundle that registers a **native
subagent provider** for the **Kimi Code CLI** (`kimi`, package
[`@moonshot-ai/kimi-code`](https://www.npmjs.com/package/@moonshot-ai/kimi-code)).

Each delegation spawns one headless `kimi` process in the parent Session's
workspace, sends the delegated prompt through the CLI's documented one-shot
prompt mode, and returns only the CLI's final response text — or a bounded,
provider-authored failure diagnostic.

```sh
kimi -p '<task>' --output-format text
```

The provider is named `kimicode`; the bundle also adds the model-facing tool
`subagent_kimicode`. No local child Session is created, and Kimi Code's own
login, model, and permission settings remain authoritative.

> **unverified: requires login** — the completed/response path has not been
> exercised end-to-end on this machine. The Kimi Code CLI here has no signed-in
> account and fails with `No model configured`. See
> [Unverified: requires login](#unverified-requires-login).

## Contents

- [Why this bundle exists](#why-this-bundle-exists)
- [Mount rows](#mount-rows)
- [Configuration](#configuration)
- [Prerequisite: a signed-in Kimi Code CLI](#prerequisite-a-signed-in-kimi-code-cli)
- [What a delegation looks like](#what-a-delegation-looks-like)
- [One-shot limitations](#one-shot-limitations)
- [Failure behavior](#failure-behavior)
- [Unverified: requires login](#unverified-requires-login)
- [Smoke test record](#smoke-test-record)
- [Bundle layout](#bundle-layout)

<a id="why-this-bundle-exists"></a>
## Why this bundle exists

DSH's delegation seam (`ctx.subagents`) resolves a registered provider for each
`subagent_*` tool call. This bundle implements that seam contract out of process:

| Provider field | Value | Meaning |
|---|---|---|
| `name` | `kimicode` | Registry name used by the tool row (`provider: kimicode`) |
| `capabilities` | `{agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false}` | Exactly the four start-time capabilities version `0.2.1-rc.3` validates; all are unsupported because the CLI call is one-shot |
| `inheritsParentContext` | `false` | The child never sees the parent's completed-turn prefix |
| `start(request)` | spawns `kimi` | Uses the seam-resolved absolute `request.cwd`; falls back to the parent Session's cwd when an older seam omits it |

`start()` publishes an ordinary seam run handle `{ id, result, dispose() }`:

- `result` resolves with `stopReason: 'completed'` and the trimmed stdout as one
  text block, or with `stopReason: 'aborted'` / `'error'` (never rejecting after
  publication for a child-level failure).
- `dispose()` is idempotent and tears the child down through the seam's
  termination ladder: `terminate()` → `waitForExit()` → `done`.
- Request-signal cancellation terminates the child and settles the run as
  `aborted`.

Because `dsh.bundle.patch` points at [`cordis.patch.yml`](./cordis.patch.yml),
selecting this bundle layer inserts both the provider row and the tool row.

<a id="mount-rows"></a>
## Mount rows

`cordis.patch.yml` inserts:

```yaml
- insert:
    - id: subagent-kimicode
      name: '@local/dsh-subagent-kimicode'
    - id: tool-subagent-kimicode
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: kimicode
        toolName: subagent_kimicode
        maxDepth: provider-managed
```

`maxDepth: provider-managed` is required for an external one-shot backend: the
tool cannot enforce a local depth cap for a process it does not manage. Later
user patches may edit or disable these rows by id. A preset that registers its
own tool named `subagent_kimicode` shadows the global tool for its Agents.

<a id="configuration"></a>
## Configuration

The provider row's `config` block is optional; every field has a default.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | `string` | `kimi` | Executable to spawn. Set an absolute path when the Host's `PATH` does not contain the npm global bin (common for GUI-launched apps). |
| `model` | `string` | native Kimi Code default | When set, passes `--model <value>` (an alias resolved by Kimi Code's own config). Omitted ⇒ the CLI's `default_model` is used. |
| `permissionMode` | `'ask' \| 'yolo' \| 'auto' \| 'plan'` | `ask` | Native non-interactive permission policy. See the mapping below. Invalid values fail provider registration loudly. |
| `extraArgs` | `string[]` | `[]` | Extra argv entries appended after `-p <task> --output-format text`, e.g. `['--add-dir', '/repo/shared']` or `['--skills-dir', '/repo/.kimi/skills']`. |
| `disposeGraceMs` | `number` | `3000` | Grace between subprocess termination tiers (positive, ≤ `2147483647`). |

| `permissionMode` | Emitted argv | Native behavior |
|---|---|---|
| `ask` | *(no flag)* | Kimi Code's own default (`-y/--yolo` not passed); suitable only when nothing needs approving |
| `yolo` | `-y` | "Ask When Needed": routine edits/commands run automatically; risky actions, questions, and plans still ask |
| `auto` | `--auto` | "Never Ask": everything runs and is decided automatically — the intended mode for unattended delegation |
| `plan` | `--plan` | Start in plan mode |

Example patch for an unattended delegation with an explicit model and an extra
workspace directory:

```yaml
- id: subagent-kimicode
  name: '@local/dsh-subagent-kimicode'
  config:
    command: /Users/me/.local/bin/kimi
    model: kimi-k2
    permissionMode: auto
    extraArgs: ['--add-dir', '/repo/shared']
```

The provider makes **no environment changes**. Kimi Code reads its login and
model configuration from its own on-disk config (`~/.kimi-code/`); the child is
spawned with an empty explicit environment overlay on top of the subprocess
seam's credential-scrubbed parent environment. Credentials therefore travel via
Kimi Code's native login, not through the DSH process environment.

<a id="prerequisite-a-signed-in-kimi-code-cli"></a>
## Prerequisite: a signed-in Kimi Code CLI

The provider spawns the CLI by `command`; it does not bundle or install it.

```sh
# Node.js 22.19+ is required by this package.
npm install -g @moonshot-ai/kimi-code      # provides the `kimi` bin
# or the official installer:
# curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash

kimi --version                              # expect 2.3.1 or newer
kimi login                                 # device-code flow / API key selection
kimi -p 'reply with OK' --output-format text  # expect the answer on stdout
```

`kimi login` is the documented device-code flow (see `kimi --help`; the CLI also
accepts a Kimi Platform API key). Alternatively set `default_model` in
`~/.kimi-code/config.toml` for a non-interactive setup. A fresh, signed-out
install prints:

```text
error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.
```

and exits non-zero — the provider maps exactly that failure to an actionable,
bounded diagnostic (see [Failure behavior](#failure-behavior)).

<a id="what-a-delegation-looks-like"></a>
## What a delegation looks like

1. The model calls `subagent_kimicode` with a task; DSH's subagent manager
   validates capabilities and the resolved absolute cwd.
2. `start()` joins the prompt's text blocks with blank lines, rejects an empty
   prompt or one over 256 KiB (argv ceiling), and spawns:

   ```text
   <command> -p <task> --output-format text [--model <model>] [<mode flag>] [<extraArgs…>]
   ```

   with `cwd = request.cwd`, `stdin: ignore`, and stdout/stderr buffered (4 MiB
   per stream, head kept).

3. The task never passes through a shell: the seam spawns an argv array, so no
   quoting or injection surface is introduced by this adapter.
4. On exit, stdout is trimmed and becomes the child's answer. The parent Session
   receives the completion notice with that answer, or the stop reason plus an
   optional diagnostic — never the CLI's raw stderr, tool activity, or workspace
   diffs.

<a id="one-shot-limitations"></a>
## One-shot limitations

- **One task per run, no follow-up.** There is no resume, steering, or
  `send_message` to the child. Each delegation is a fresh `kimi -p` process.
- **No context inheritance.** `inheritsParentContext: false`: the child does not
  see the parent's history, tools, model options, or persona.
- **No start-time capabilities.** `agentOptions`, `agentPreset`, `outputSchema`,
  and `depthLimit` are all `false`; the seam rejects a delegation that requests
  one instead of silently ignoring it. Structured output (`structured`) is
  never produced.
- **Text only out.** Only the final stdout text is returned. There is no token
  usage, tool trace, or streaming progress in the parent Session.
- **Non-interactive approval is the caller's choice.** `ask` (the CLI default)
  emits no flag; use `auto` (`--auto`) for genuinely unattended work, since an
  approval prompt cannot be answered by this adapter. `plan` mode's exact
  non-interactive behavior needs a signed-in account to confirm.
- **No session reuse.** The adapter never passes `--session`, `--continue`, or
  `--agent`; each call is a new CLI invocation. Kimi Code may still record its
  own session/log files under `~/.kimi-code/` — the provider does not read them.
- **Size limits.** Prompt ≤ 256 KiB (one argv element); stdout and stderr are
  each buffered up to 4 MiB (longer output truncated); diagnostics are capped at
  4096 UTF-8 bytes.

<a id="failure-behavior"></a>
## Failure behavior

| Situation | `stopReason` | `diagnostic` |
|---|---|---|
| Exit 0 with non-empty stdout | `completed` | — (stdout is the answer) |
| Non-zero exit | `error` | stderr with the `kimi version …` banner stripped, capped at 4096 UTF-8 bytes |
| Non-zero exit with empty stderr | `error` | `kimi exited with code <n>, signal <s>` |
| Exit 0 but empty stdout | `error` | `kimi completed without printing a response` |
| Request signal aborted / `dispose()` while running | `aborted` | — (partial stdout may be returned) |
| `No model configured` (signed out / no default model) | `error` | login hint **plus** the original stderr text |

The `No model configured` mapping is deliberate: the hint

```text
kimi is not signed in or has no default model — run `kimi login` (device-code flow) or set default_model in the Kimi Code config
```

precedes the exact CLI text so a reader sees both what to do and what happened.
Diagnostics contain no tool inputs, file contents, or credential values.

<a id="unverified-requires-login"></a>
## Unverified: requires login

**unverified: requires login.** This bundle's *success* path has not been
validated against the real service because the Kimi Code CLI on this machine is
not signed in. The CLI itself is installed (2.3.1, seen via `kimi --version`),
but every prompt invocation fails before any model call with
`No model configured`.

What **was** verified:

- `kimi --version` → `2.3.1`; `kimi --help` documents the exact flags used here
  (`-p/--prompt`, `--output-format text|stream-json`, `-y/--yolo`, `--auto`,
  `--plan`, `-m/--model`, `--add-dir`, `--skills-dir`, `--agent`).
- The provider's argv construction: `[command, '-p', <task>, '--output-format',
  'text', ...]`, spawned with `cwd = request.cwd`.
- The real unauthenticated failure path: exit 1, empty stdout, exact stderr
  string captured, mapped by the provider to a **325-byte** diagnostic (well
  under the 4096-byte cap).
- With an in-memory seam stand-in: completed output mapping, non-zero-exit
  diagnostics, empty-stdout error, idempotent dispose, dispose-while-running →
  `aborted`, request-signal abort → `aborted`, config validation, and every
  `permissionMode` argv variant.

What **remains unverified** until a signed-in account runs it:

- That a successful `kimi -p` prints only the answer on stdout (the
  unauthenticated startup banner was observed on stderr, and is stripped from
  diagnostics; success-path stdout shape is taken from `--help`'s "print the
  response" wording).
- `--auto` / `--plan` behavior in headless prompt mode, and whether a signed-in
  run requires any additional flags.
- A real cancellation against a live, signed-in child (the abort/dispose paths
  were exercised against the process-level contract, not a model-backed run).

Do not mark the delegation path as verified, and do not enable this bundle for
production use, until one signed-in `subagent_kimicode` delegation returns a
real answer.

<a id="smoke-test-record"></a>
## Smoke test record

Run on this machine (macOS, Node v24.20.0) with a scratch npm install of
`@moonshot-ai/kimi-code@2.3.1`; the bin path mirrors what `kimi` resolves to on
`PATH` after a global install.

```text
$ kimi --version
2.3.1                                       # exit 0

$ kimi -p 'smoke test' --output-format text     # cwd /tmp, stdin /dev/null
stderr:
  kimi version 2.3.1
  error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.
  See log: ~/.kimi-code/logs/kimi-code.log
stdout: (empty)                             # exit 1
```

Provider run against the same signed-out CLI (fake seam spawning the real bin,
`cwd=/tmp`):

```text
[spawn argv] [.../kimi, "-p", "provider smoke test", "--output-format", "text"]
[spawn cwd ] /tmp
[provider]   kimicode {"agentOptions":false,"agentPreset":false,"outputSchema":false,"depthLimit":false} inheritsParentContext= false
[result.stopReason] error
[result.output] []
[result.diagnostic bytes] 325
[result.diagnostic]
  kimi is not signed in or has no default model — run `kimi login` (device-code flow) or set default_model in the Kimi Code config
  error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.
  See log: /Users/jingfu-shen/.kimi-code/logs/kimi-code.log
```

<a id="bundle-layout"></a>
## Bundle layout

| Path | Purpose |
|---|---|
| `package.json` | `@local/dsh-subagent-kimicode`; `exports` for `.`, `./locale/*.json`, `./icon`; `dsh.bundle.patch` |
| `cordis.patch.yml` | Inserts the `subagent-kimicode` provider row and `tool-subagent-kimicode` tool row |
| `index.js` | Self-contained provider implementation — **`node:` builtins only**, no bare package imports |
| `README.md` | This document |
| `locale/en.json`, `locale/zh.json` | Plugin-manager title and description |
| `icon.svg` | Original moon-and-star mark; no external assets |

The adapter deliberately re-implements the two seam helpers it needs
(`settleRunResult`, `subprocessRunHandle`) instead of importing
`@deepseek-ai/dsh-subagent`, because this bundle is linked from the workspace and
must resolve with only Node builtins at load time.
