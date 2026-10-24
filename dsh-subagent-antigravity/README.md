---
description: "One-shot Antigravity CLI (agy) native subagent provider for DeepSeek Harness: bundle shape, mount rows, configuration, the global-proxy declaration, and the verification record."
kind: "package-bundle"
---

# @local/dsh-subagent-antigravity

A self-contained workspace bundle that registers a **native subagent provider** for the
Antigravity CLI (`agy`) on DeepSeek Harness 0.2.1-rc.3. It mirrors the shape of the
official `@deepseek-ai/dsh-subagent-codex` bundle — one Host provider row plus one
`@deepseek-ai/dsh-tool-subagent` row — but drives `agy` through its documented
non-interactive `--print` mode instead of a wire protocol.

> 全局走网络代理：every `agy` child is forced through this machine's system proxy
> `http://127.0.0.1:12450`. The declaration lives in two places that must agree:
> `GLOBAL_PROXY` in [index.js](index.js) and the one-line `proxy:` row config in
> [cordis.patch.yml](cordis.patch.yml).

## What this package is

| File | Role |
|---|---|
| [index.js](index.js) | The plugin: resolves config, probes the proxy, builds the argv, spawns `agy`, parses its JSON envelope, publishes a seam `SubagentRun`. Self-contained: `node:crypto`, `node:fs`, `node:net` only — no bare imports. |
| [cordis.patch.yml](cordis.patch.yml) | The bundle layer: inserts the provider row `subagent-antigravity` and the tool row `tool-subagent-antigravity`. |
| [locale/en.json](locale/en.json), [locale/zh.json](locale/zh.json) | Plugin Manager title/description. |
| [icon.svg](icon.svg) | Original violet orbit + triangle mark (no external assets). |
| [package.json](package.json) | Manifest: private ESM package, `.` → `index.js`, `dsh.bundle.patch`. |

Each delegation is **one-shot**: a fresh `agy` process runs exactly one print-mode turn in
the parent Session's working directory and returns only the final answer (or a bounded,
safe diagnostic). No local child Session, no continuation, no follow-up messages.

## Mount rows

The bundle patch inserts two Host-plane rows:

```yaml
- insert:
    - id: subagent-antigravity
      name: '@local/dsh-subagent-antigravity'
      config:
        proxy: http://127.0.0.1:12450   # 全局走网络代理 — single declaration
        command: agy
        disposeGraceMs: 3000
        verifyProxy: true
    - id: tool-subagent-antigravity
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: antigravity
        toolName: subagent_antigravity
        maxDepth: provider-managed
```

- `subagent-antigravity` registers the provider name **`antigravity`** on the
  process-global `ctx.subagents` registry. Provider names are unique per process, so a
  bundle patch is the only place it is registered; do not register it again from a preset.
- `tool-subagent-antigravity` mounts the shipped delegation tool under the model-facing
  name **`subagent_antigravity`**, bound to that provider. `maxDepth: provider-managed`
  sends no DSH recursion cap: an out-of-process one-shot child owns its own budget.
- A preset that mounts its own tool with the same tool name shadows this global tool for
  its Agents (standard `dsh-tool-subagent` behavior).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `proxy` | `http://127.0.0.1:12450` (`GLOBAL_PROXY`) | The global proxy every child is forced through. Must be an `http://`/`https://` URL; malformed values fail at activation. |
| `command` | `agy` | The Antigravity CLI executable, resolved on the DSH process `PATH`. |
| `model` | agy's own native selection | Optional model fixed for every run: emitted as `--model <value>` before `--print`. |
| `effort` | agy's own native selection | Optional reasoning effort. One of `low`, `medium`, `high`, `xhigh`, `max`; emitted as `--effort <value>`. Any other value fails at activation. |
| `dangerouslySkipPermissions` | `false` | `true` emits `--dangerously-skip-permissions`. Select it explicitly: print mode has no interactive approval path. |
| `extraArgs` | `[]` | Additional `agy` flags, emitted before `--print`. Escape hatch for e.g. `['--add-dir', '/path']`. |
| `env` | `{}` | Extra child environment variables layered **before** the forced proxy keys, so the overlay may add variables but can never drop or redirect `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`. |
| `disposeGraceMs` | `3000` | Grace between the subprocess seam's termination tiers. |
| `verifyProxy` | `true` | TCP-probe the declared proxy before every spawn (1500 ms timeout). Set `false` only when you deliberately want the child started against a dead proxy. |

Configuration is validated when the row activates (`apply`), not on first delegation, so a
bad `proxy` or `effort` fails the mount loudly.

## Prerequisite: the Antigravity CLI

- `agy` must be **installed via the Antigravity CLI installer** and on the `PATH` of the
  DSH process. On the machine this bundle was built for it lives at
  `/Users/jingfu-shen/.local/bin/agy` and reports **version 1.4.7**.
  Check with `agy --version` (and `agy --help` for the exact flag surface).
- `agy` must be **authenticated as the account the user signed in with**. This plugin does
  not install, log in, trust projects, or rewrite Antigravity settings; authentication and
  account state remain entirely native. A signed-out account fails inside agy and surfaces
  through the bounded diagnostic.
- The machine must be able to reach the proxy. The proxy is part of the contract here:
  without it `agy` fails with an account-shaped message
  (`failed to construct executor: plan model not specified…`), which is exactly why the
  plugin probes the port first.

## The global proxy declaration (全局走网络代理)

Why it is required: this machine reaches the Antigravity backend **only through its
system proxy `127.0.0.1:12450`**, and the subprocess seam starts children from a
**scrubbed environment** that carries no proxy variables at all. A child that is not
explicitly told otherwise therefore fails, while the interactive `agy` in a normal shell
works. The plugin makes the proxy an explicit, single declaration instead of ambient
environment state:

1. `const GLOBAL_PROXY = 'http://127.0.0.1:12450'` in [index.js](index.js), documented
   with 全局走网络代理.
2. The visible one-line `proxy: http://127.0.0.1:12450` in the provider row config in
   [cordis.patch.yml](cordis.patch.yml).

Every child environment is then built as `{ ...envOverlay, HTTP_PROXY: proxy,
HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '' }` — the proxy keys are applied last,
so no `env` entry can drop or redirect them, and `NO_PROXY` is **emptied** so nothing
bypasses the proxy. Before spawning, `verifyProxy` (default on) opens a TCP connection to
the declared endpoint; if it refuses or times out, the delegation is rejected before any
`agy` process exists with:

```
subagent-antigravity: proxy http://127.0.0.1:12450 is not reachable (connect ECONNREFUSED …)
  — start the proxy, or set verifyProxy: false to start the child anyway
```

To change the machine's proxy, change both declaration sites. A profile-level patch can
override the row's `config.proxy` without editing this package, but the `GLOBAL_PROXY`
constant remains the in-package default and should be kept in sync.

## CLI invocation and result envelope

The invocation is exactly (verified against `agy 1.4.7`):

```
agy --output-format json "--print=<task>"
```

`--print` takes the **prompt as its value**. agy errors out if a flag follows `--print`
("… attach the prompt to the flag … and move --output-format elsewhere"), so all flags
(`--output-format`, `--model`, `--effort`, `--dangerously-skip-permissions`, `extraArgs`)
are emitted **before** the attached `--print=<task>`, which is always the last argv
element. The prompt never passes through a shell; the seam spawns an argv array.

A successful run prints one JSON object and exits 0:

```json
{"conversation_id":"fa90…","status":"SUCCESS","response":"OK,AGY-PLUGIN\n",
 "duration_seconds":3.23,"num_turns":1,"usage":{…}}
```

Only `status == "SUCCESS"` **and** no `error` field is an answer; `response` becomes the
result's text block. Any other status, or a reported `error`, is a failure: the run settles
as `stopReason: "error"` (never as a rejection) with agy's own message as the bounded
(≤4096-byte) diagnostic. A non-zero exit is also an error, and an unparseable/non-object
stdout degrades to "the text agy printed". A successful run with an empty answer is an
error, not a silent empty result. Cancellation through the request signal settles as
`stopReason: "aborted"`, and `dispose()` reaches actual child exit through the seam's
termination ladder.

## One-shot limitations

- **No continuation, resume, or follow-up input** — one fresh `agy` process, one turn per
  delegation. Use the in-process `subagent`/`subagent_fork` providers when a child must be
  steered later.
- **No parent context** (`inheritsParentContext: false`) — the child sees none of the
  conversation. State the task, paths, and expected result in full. Large tasks should be
  started in the background from the `bash` tool when you do not want to block.
- **No optional start capabilities** — capabilities are exactly `{agentOptions: false,
  agentPreset: false, outputSchema: false, depthLimit: false}`; the seam rejects a request
  needing any of them rather than silently ignoring it.
- **Prompt travels as argv** — the prompt is capped at 256 KiB to fail early with an
  actionable message instead of an opaque OS argv-limit spawn failure.
- **No human approval path in print mode** — approval/account failures surface through the
  diagnostic. `dangerouslySkipPermissions` must be selected explicitly.
- **Static instance selection** — the provider name, model, effort, and tool binding are
  fixed by profile rows; a call cannot choose or change them dynamically.
- **No DSH wall-clock timeout or side-effect rollback** — the caller cancels long work; any
  files agy changed before cancellation are not restored.
- **Proxy is not per-call** — every child is forced through the declared proxy; the only
  switch is `verifyProxy` (probe on/off), not the endpoint. Changing the declaration
  requires editing the bundle and reinstalling it (a fresh JavaScript generation needs a
  restart to activate).
- **Authentication and account state are native** — not handled by this plugin.
- **Raw streams stay out of the parent** — stdout/stderr are capped at 4 MiB in memory;
  only the selected answer (or diagnostic) enters the parent Session.

## Verification record (2026-10-25, macOS, agy 1.4.7)

All checks ran without installing anything into a DSH profile.

1. **Syntax + self-containment** — `node --check index.js` → OK; imports are exactly
   `node:crypto`, `node:fs`, `node:net`.

2. **Direct CLI smoke test through the global proxy** (the task's smoke test):

   ```bash
   env HTTP_PROXY=http://127.0.0.1:12450 HTTPS_PROXY=http://127.0.0.1:12450 \
       ALL_PROXY=http://127.0.0.1:12450 NO_PROXY='' \
       agy --output-format json "--print=Reply with exactly: OK,AGY-PLUGIN"
   # exit 0
   # {"conversation_id":"fa901258-…","status":"SUCCESS","response":"OK,AGY-PLUGIN\n",
   #  "duration_seconds":3.227,"num_turns":1,"usage":{…}}
   ```

3. **Unreachable-proxy CLI behavior** (documented so the probe's value is testable):

   ```bash
   env HTTP_PROXY=http://127.0.0.1:12451 HTTPS_PROXY=http://127.0.0.1:12451 \
       ALL_PROXY=http://127.0.0.1:12451 NO_PROXY='' \
       agy --output-format json "--print=Reply with exactly: OK,AGY-PLUGIN"
   # exit 3
   # {"status":"ERROR","response":"","error":"failed to construct executor: plan model
   #  not specified; you must specify a valid model",…}
   ```

4. **Provider end-to-end through the real CLI** — a harness imported `index.js`, called
   `apply()` with no config (so `GLOBAL_PROXY` defaults), and backed `ctx.subprocess.spawn`
   with a real `node:child_process.spawn` of `agy` (emulating the seam's scrubbed base
   environment + explicit overlay):

   ```
   provider: antigravity | capabilities: {"agentOptions":false,"agentPreset":false,
     "outputSchema":false,"depthLimit":false} | inheritsParentContext: false
   RESULT: {"output":[{"type":"text","text":"OK,AGY-PLUGIN\n"}],"stopReason":"completed"}
   env: {"HTTP_PROXY":"http://127.0.0.1:12450","HTTPS_PROXY":"http://127.0.0.1:12450",
         "ALL_PROXY":"http://127.0.0.1:12450","NO_PROXY":""}
   argv: ["agy","--output-format","json"] + "--print=Reply with exactly: OK,AGY-PLUGIN"
   cwd: /tmp | graceMs: 3000
   ```

5. **Pre-spawn proxy probe** — `proxy: http://127.0.0.1:12451`, default `verifyProxy`:

   ```
   start() rejected: subagent-antigravity: proxy http://127.0.0.1:12451 is not reachable
     (connect ECONNREFUSED 127.0.0.1:12451) — start the proxy, or set verifyProxy: false …
   spawn called: false
   ```

6. **Failure envelope through the provider** — same dead proxy with `verifyProxy: false`:

   ```
   {"output":[],"stopReason":"error",
    "diagnostic":"failed to construct executor: plan model not specified; you must specify a valid model"}
   logger.warn: subagent-antigravity: child run failed (error): …
   ```

7. **argv/env construction unit test** — `model`, `effort: max`,
   `dangerouslySkipPermissions`, `extraArgs`, `env` overlay containing a conflicting
   `HTTP_PROXY`:

   ```
   argv: ["agy","--output-format","json","--model","auto","--effort","max",
          "--dangerously-skip-permissions","--add-dir","/work","--print=hi"]
   env:  {"FOO":"bar","HTTP_PROXY":"http://127.0.0.1:12450","HTTPS_PROXY":"…12450",
          "ALL_PROXY":"…12450","NO_PROXY":""}   # overlay cannot override the proxy
   effort: "turbo" → rejected at activation
   ```

### Not verified here

- Not installed as a bundle and not mounted in a DSH profile (out of scope for this task),
  so live Provider Manager inventory, locale/icon rendering, tool mounting, completion
  notifications, and the actual seam `subprocess` implementation were not exercised.
- `--model`, `--effort`, `--dangerously-skip-permissions`, and `extraArgs` are verified as
  argv construction only, not against real model/flag combinations.
- Cancellation/abort and disposal against a real long-running `agy` were not exercised;
  that logic is carried over unchanged from the proven `agy.mjs` preset provider.
- The 256 KiB argv ceiling and the 4 MiB stream cap were not stressed.
- Windows is untested; the POSIX cwd/`/`-absolute checks are macOS/Linux oriented.
