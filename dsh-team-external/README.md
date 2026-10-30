# External agents on the Team (`@local/dsh-team-external`)

Bridges external CLI agents — **Antigravity (`agy`), ZCode, Kimi Code** — into the native
DeepSeek Harness Agent Team, so they behave like native teammates: they are durable roster
members you can `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, and assign
shared tasks to.

This is a **mod (魔改) of the Agent Team layer, not of the shipped packages**: it decorates the
live `ctx.agentTeams` service instance, keeps every native behavior intact, and comes with one
new model tool, `spawn_external_teammate`.

## Why a bridge

The shipped Team domain models a teammate as a *continuable in-process child Agent*: its roster
id is a child Session id, its inbox is a DSH Session inbox, and its answers arrive as Team peer
messages. External CLIs are out-of-process one-shot runs — no inbox, no continuable Session — so
`spawn_teammate` cannot start them.

The bridge treats **one external CLI conversation as one durable roster member**:

| Native piece | External equivalent |
|---|---|
| `team/member` durable record | appended through the real Team journal, so the roster projection, `list_agents`, task-board owner resolution and the browser roster all see it |
| child Session id | generated member id (the external CLI has no DSH Session) |
| inbox + `send_message` | CLI conversation resume (`agy --conversation`, `zcode --resume`, `kimi -S`); messages queue while a turn is running |
| teammate → Lead `send_message` | the finished turn is delivered as a genuine Team peer message (`Team message from <name>: …`, `agent-message` relay source) via `Lead.steer()` |
| `wait_agent` activity | turn start/settle calls `TeamActivity.notify`, plus the bridge's own waiters |
| `interrupt_agent` | `child.terminate()` on the running CLI; the conversation is resumed on the next message |
| text history continuity | conversation id persisted per member (Lead Session log record + `$DSH_HOME/team-external/state.json`) and re-read after a harness restart |

## Tool

`spawn_external_teammate({ name, description, provider, task })` — Lead only.

```
provider: "antigravity" | "zcode" | "kimicode"
```

Everything after creation uses the **shipped, unchanged tools**:

- `send_message` — new prompt to the member (resumes its CLI conversation; queues while busy)
- `list_agents` — shows the member as a `teammate` with `provider: "external:<id>"` and live
  `running`/`inactive` status plus last-error diagnostics
- `wait_agent` — wakes on external turn start/settle, not only on native roster events
- `interrupt_agent` — stops the current CLI turn (`previousStatus` is `running`/`inactive`)
- `team_task_create` / `team_task_update` — `reassign` a task to the external member; its name
  resolves to a real `ownerName` on the board. External agents cannot call Team tools themselves,
  so **the Lead** assigns, edits and eventually completes their tasks and should send the task
  text explicitly.

## Team CLI: external teammates work on the Team themselves (v1.1)

External CLIs cannot call DSH tools directly, so the bridge ships a small **Team CLI** and injects it
into every external teammate turn:

- the first turn prepends a short protocol block naming the exact commands;
- every turn exports `DSH_TEAM_CLI`, `DSH_TEAM_SOCKET`, `DSH_TEAM_TOKEN`, `DSH_TEAM_MEMBER`,
  `DSH_TEAM_NAME` (token-guarded unix socket inside the Host process);
- the teammate runs the CLI with its own shell/bash tool.

```bash
node "$DSH_TEAM_CLI" whoami                     # name, member id, team id, provider
node "$DSH_TEAM_CLI" list                       # Team members and status
node "$DSH_TEAM_CLI" tasks                      # shared task board
node "$DSH_TEAM_CLI" task-claim task-7 --rev 1  # claim like a native teammate
node "$DSH_TEAM_CLI" task-complete task-7 --rev 2
node "$DSH_TEAM_CLI" task-create --subject "..." --description "..."
node "$DSH_TEAM_CLI" task-edit task-7 --rev 2 --description "..."
node "$DSH_TEAM_CLI" send --to lead "progress or result"
node "$DSH_TEAM_CLI" send --to other-external-agent "peer message"
node "$DSH_TEAM_CLI" send --to native-teammate "message to a native DSH teammate"
node "$DSH_TEAM_CLI" wait --timeout 30000
```

So external teammates can now self-claim and self-complete board tasks, create tasks, read the roster,
initiate messages to the Lead, and message other external teammates. Messages the Lead sends are framed
as `Team message from <sender>:` exactly like native peer messages.

### Reaching native DSH teammates (Lead-authorized relay)

An external CLI has no DSH Agent credential, so it cannot write into a native child inbox directly. The
bridge therefore relays `send --to <native-teammate>` through the Lead's authority (the user explicitly
authorized this) and keeps the attribution explicit: the native teammate receives a native Team peer
message from the Lead whose content starts with `Forwarded from external teammate <name> (<provider>,
member <id>):` followed by the external teammate's text. Native teammates can reply straight back to the
external member with their normal `send_message` tool — the bridge intercepts that target and delivers
it as the next turn of the external CLI conversation. Set `allowNativeRelay: false` in the row config to
disable the external→native direction.

## Backends

| provider | start | resume | conversation id source |
|---|---|---|---|
| `antigravity` | `agy --output-format json --dangerously-skip-permissions --print=<task>` | add `--conversation <id>` before `--print` | JSON `conversation_id` |
| `zcode` | `node <bundle>/bin/zcode-cli.cjs -p <task> --json --cwd <cwd>` | `--resume <id>` before `-p` | JSON `sessionId` |
| `kimicode` | `kimi -p <task> --output-format stream-json` | `-S <id> -p <task> --output-format stream-json` | last NDJSON `session.resume_hint.session_id`; final answer = last non-empty `role:"assistant".content` |

agy runs through the configured proxy; ZCode goes through the launcher that repairs
`zcode-builtin.json` lookup; Kimi runs in the session's **physical** cwd (macOS `/private/...`).

## Mount

This bundle already carries its one row (place it **after** the shipped Team bundles — bundle
install order does this for you):

```yaml
- insert:
    - id: team-external
      name: '@local/dsh-team-external'
      config:
        proxy: http://127.0.0.1:12450
        verifyProxy: true
        turnTimeoutMs: 600000
        disposeGraceMs: 3000
        maxExternalMembers: 8
        providers:
          antigravity: { command: agy }
          zcode: { command: node }
          kimicode: { command: kimi }
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `proxy` | `http://127.0.0.1:12450` | proxy for adapters that need one (`null` disables) |
| `verifyProxy` | `true` | TCP-probe the proxy before the first turn of an idle member |
| `turnTimeoutMs` | `600000` | wall-clock ceiling for one external turn |
| `disposeGraceMs` | `3000` | grace between subprocess termination tiers |
| `maxExternalMembers` | `8` | external members are cheap roster rows, so they get their own budget instead of consuming the native `maxMembers` limit |
| `allowNativeRelay` | `true` | allow `send --to <native-teammate>` relayed through the Lead's authority (user-authorized) |
| `providers.<id>.command` | adapter default | CLI path/name |
| `providers.<id>.model`, `.effort`, `.mode`, `.dangerouslySkipPermissions`, `.extraArgs`, `.env` | — | adapter-specific overrides |

`antigravity` defaults to `--dangerously-skip-permissions` because headless print mode cannot
approve tool calls; set `providers.antigravity.dangerouslySkipPermissions: false` when you
prefer `permissions.allow` rules in agy's settings.

## Requirements

- Shipped Agent Team packages mounted (they are in this profile).
- **antigravity**: `agy` authenticated; reachable proxy (or `proxy: null`).
- **zcode**: ZCode.app signed in; the launcher lives in `bin/` of this bundle.
- **kimicode**: `npm i -g @moonshot-ai/kimi-code` and **`kimi login`**. Without a login every turn
  fails with a bounded diagnostic ("No model configured …"), delivered as a peer message.

## Verified (live, DSH desktop profile)

- Created `agy-recon` (antigravity) and `zcode-recon` (zcode), each with a codeword in its first
  turn; `list_agents` showed both with `external:*` provider and live `running` status;
  `wait_agent` woke on external turns.
- Peer messages arrived: `STARTED` / `READY`, then after `send_message` the members answered
  `ORBIT-7` and `ZETA-9` — proving the CLI conversations were resumed, not restarted.
- Durability: after a plugin reload, `send_message` to `agy-recon` still resumed its old
  conversation (`ORBIT-7`), and later `PING`; conversation ids came from `state.json`.
- `interrupt_agent` on a 25 s ZCode turn returned `previousStatus: "running"`, the member became
  `inactive` with the `interrupted` diagnostic, and a following `send_message` returned `BACK`.
- `team_task_update action=reassign owner=zcode-recon` produced `ownerName: "zcode-recon"`.
- Kimi failure path: `kimi-recon` settled `inactive` with the bounded
  "No model configured … run `kimi login`" diagnostic as a peer message.
- **Bidirectional native messaging (v1.2)**: `cli-agy` sent `--to kimi-spec-dev` through the Team CLI,
  the bridge relayed it under the Lead's authority, and the native `kimi-spec-dev` woke up and answered
  `RELAY-OK`. Then `kimi-spec-dev` used its normal `send_message` tool against `cli-agy`, and the
  external teammate received `NATIVE-TO-EXT-OK` and reported it back to the Lead.
- **Self-service Team CLI (v1.1)**: created task-9, spawned a fresh `cli-agy` teammate whose
  first turn contained the protocol block; it ran `whoami`, `tasks`, `task-claim task-9 --rev 1`,
  `task-complete task-9 --rev 2` and `send --to lead "CLI-AGY-OK: claimed and completed task-9"`
  by itself — the board showed `ownerName: cli-agy` and `completed`; a `cli-zcode` teammate also ran
  `whoami` + `send --to lead "CLI-ZCODE-OK"` from its own shell.
- In-memory seam self-test: **38/38** checks (protocol/env injection, control socket auth, task
  create/claim/complete/claim-stale, lead messaging, native-teammate relay, real `team-cli.cjs` child calls, queueing,
  wrappers, delegation, duplicate/invalid-name rejection, uninstall restoration).

**Unverified:** Kimi success path (needs login); native browser roster live status for external
members beyond the durable projection (the bridge only feeds phase + provider); mid-turn
`send_message` steering semantics are queue-based, not step-boundary steering; non-macOS.

## Limits (updated in v1.1)

- **Solved**: external teammates can now send Team messages themselves, read the roster, and
  claim/complete/create/edit tasks through the injected Team CLI. They can also reach native DSH
  teammates through the Lead-authorized relay described above; native teammates reply to them with
  their normal `send_message` tool. External members still have no generic DSH tools
  (file/search/etc.) — that is expected, they use their own product tools.
- External→native messages are relayed by the Lead (the external member has no Agent credential), so
  the native teammate sees a Lead peer message whose content is explicitly attributed as forwarded.
- One CLI turn runs at a time per member; messages sent while running are queued and run next.
- No cold resume of a turn that was killed mid-flight; the conversation itself keeps resuming.
- The bridge decorates the service instance at mount; if the shipped Team service is renamed in a
  future DSH version, the plugin row must be updated.
- Kimi Code success path is unverified until `kimi login`; its failure path is verified.

## Uninstall

Disable/remove the `@local/dsh-team-external` bundle: the effect cleanup restores the original
Team service methods, aborts running external turns and clears waiters. Existing external roster
records remain in the Lead Session log (Team names are permanent, like native teammates).
