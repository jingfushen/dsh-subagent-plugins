/**
 * External CLI agents as first-class Agent Team members.
 *
 * The shipped Team domain (`@deepseek-ai/dsh-experimental-agent-team`) models a
 * teammate as a continuable in-process child Agent: its roster id is the child
 * Session id, its inbox is a DSH Session inbox, and its answers arrive as Team
 * peer messages. External CLIs are out-of-process one-shot runs, so they have
 * no inbox and no continuable Session — which is why `spawn_teammate` cannot
 * start them.
 *
 * This plugin bridges the two worlds by decorating the live `ctx.agentTeams`
 * service instance (never replacing it) and treating one external CLI
 * conversation as one durable roster member:
 *
 * - The member is persisted with the real `team/member` event, so the shipped
 *   tools, the browser roster projection, and the task board's owner resolution
 *   all see it: `list_agents`, `team_task_*` owner assignment, and the client
 *   roster need no changes.
 * - Per-member conversation continuity comes from each CLI's own resume flag
 *   (agy `--conversation`, zcode `--resume`, kimi `--session`); the id is kept
 *   in the Lead's Session log via the member record and in a small JSON state
 *   file so it survives a harness restart.
 * - `send_message` to an external member starts or resumes its CLI conversation
 *   (queued while the CLI is already running, like a native inbox).
 * - A finished turn is delivered to the Lead exactly like a native teammate
 *   message: `Team message from <name>:` + the answer, `agent-message` relay
 *   source, delivered with `root.steer()`.
 * - `wait_agent` observes external turn starts/settles through the same Team
 *   activity seam; `interrupt_agent` terminates the running CLI child.
 *
 * Deliberately self-contained: only `node:` builtins and the relative
 * `lib/drivers.js` adapter table are imported (a linked workspace bundle has no
 * own node_modules).
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS, PROVIDER_LABELS, resolveAdapter } from './lib/drivers.js'

/** Marks a roster member whose backend is an external CLI. */
const EXTERNAL_PREFIX = 'external:'

/** Per-stream in-memory cap; CLI stdout/stderr are diagnostics, not conversation state. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/** One argv-carried prompt ceiling (mirrors the built-in subagent providers). */
const MAX_PROMPT_BYTES = 256 * 1024

/** One peer-message body ceiling, matching the shipped Team default. */
const MAX_MESSAGE_BYTES = 64 * 1024

/** Upper bound for a delivered answer (the rest is truncated with a marker). */
const DELIVER_MAX_BYTES = 32 * 1024

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Tool description shown to the model. */
const SPAWN_DESCRIPTION = [
  'Create one external CLI teammate inside the current Agent Team.',
  'The member becomes a normal durable Team roster entry: after creation use the shipped `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, and `team_task_*` tools on it exactly like a native teammate.',
  'Backends: `antigravity` (Antigravity CLI agy), `zcode` (ZCode CLI), `kimicode` (Kimi Code CLI). Each turn resumes the same CLI conversation, so the member keeps its own context between messages.',
  'External members return work as Team peer messages ("Team message from <name>: ..."). They cannot call Team tools themselves: the Lead assigns/edits/ completes their tasks with `team_task_update` (`reassign` to the member name), and should send them the task text explicitly.',
  'Only the Team Lead can create external teammates. Prefer native `spawn_teammate` when the task needs DSH tools or a shared context; choose an external backend when the task should run on that specific agent product.',
].join(' ')

/**
 * The protocol block injected into an external teammate's first turn. The
 * bridge also injects the same facts as environment variables, so the command
 * paths below keep working even when the CLI's shell starts in another cwd.
 */
function protocolIntro(runner) {
  return [
    '[DSH Team protocol]',
    `You are "${runner.name}", an external teammate in a DeepSeek Harness Agent Team (member id ${runner.memberId}).`,
    'You are part of the Team: you can message the Lead and use the shared task board through the Team CLI in your shell.',
    'The CLI path and connection are already exported in your environment; run these commands with your own shell/bash tool:',
    '  node "$DSH_TEAM_CLI" whoami            # your name, member id, team id, provider',
    '  node "$DSH_TEAM_CLI" list              # Team members (lead + teammates) and their status',
    '  node "$DSH_TEAM_CLI" tasks             # shared task board (id, revision, status, owner)',
    '  node "$DSH_TEAM_CLI" task-get <id>     # one task',
    '  node "$DSH_TEAM_CLI" task-claim <id> --rev <revision>',
    '  node "$DSH_TEAM_CLI" task-complete <id> --rev <revision>',
    '  node "$DSH_TEAM_CLI" task-create --subject "..." --description "..."',
    '  node "$DSH_TEAM_CLI" task-edit <id> --rev <revision> --description "..."',
    '  node "$DSH_TEAM_CLI" send --to lead "progress or result message"',
    '  node "$DSH_TEAM_CLI" wait --timeout 30000   # wait for the next Team change',
    'Team rules: claim a ready task before working on it and complete it when done; report progress and the final result to the Lead with `send --to lead`; be concise, and include the file paths a native teammate would need. The Lead hears from you only through these messages.',
    '[End of DSH Team protocol]',
  ].join('\n')
}

/** Deep-freeze plain JSON data (messages are immutable by contract). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** Trim a string to a UTF-8 byte budget. */
function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`
}

/** Collect a child stream up to a byte cap, keeping the head. */
function collectStream(stream) {
  const chunks = []
  let size = 0
  if (stream !== undefined && stream !== null && typeof stream.on === 'function') {
    stream.on('data', (chunk) => {
      if (size >= STREAM_CAP_BYTES) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const room = STREAM_CAP_BYTES - size
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
      chunks.push(slice)
      size += slice.length
    })
    stream.on('error', () => {})
  }
  return { text: () => Buffer.concat(chunks).toString('utf8') }
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Convert model-facing content blocks into one CLI prompt string. */
function contentToText(content, what) {
  const parts = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image: ${String(block.attachment?.name ?? 'attached image')}]`)
  }
  const text = parts.join('\n').trim()
  if (text.length === 0) throw new Error(`${what}: the message carries no text`)
  return text
}

/** Whether one roster member is backed by an external CLI. */
function isExternal(member) {
  return typeof member?.provider === 'string' && member.provider.startsWith(EXTERNAL_PREFIX)
}

/** The adapter id carried by one external roster member. */
function adapterIdOf(member) {
  return member.provider.slice(EXTERNAL_PREFIX.length)
}

/** Parse row config into validated defaults. */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const providers = source.providers !== null && typeof source.providers === 'object' && !Array.isArray(source.providers) ? source.providers : {}
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    proxy: source.proxy === null ? null : (typeof source.proxy === 'string' && source.proxy.length > 0 ? source.proxy : 'http://127.0.0.1:12450'),
    verifyProxy: source.verifyProxy !== false,
    providers,
    turnTimeoutMs: positive(source.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    disposeGraceMs: positive(source.disposeGraceMs, DEFAULT_DISPOSE_GRACE_MS),
    // External members are not native child Sessions, so they get their own
    // admission budget instead of consuming the native Team member limit.
    maxExternalMembers: positive(source.maxExternalMembers, 8),
  }
}

/** The state file that keeps conversation ids across harness restarts. */
function stateFilePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'team-external', 'state.json')
}

/** Load the persisted conversation index, tolerating corruption. */
function loadState() {
  const file = stateFilePath()
  if (!existsSync(file)) return { version: 1, teams: {} }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value === null || typeof value !== 'object' || value.version !== 1 || typeof value.teams !== 'object') {
      return { version: 1, teams: {} }
    }
    return value
  }
  catch {
    return { version: 1, teams: {} }
  }
}

/** Write the persisted conversation index atomically. */
function saveState(state) {
  const file = stateFilePath()
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2))
    renameSync(temporary, file)
  }
  catch {}
}

/** Parse one proxy URL into a connect endpoint. */
function proxyEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let url
  try {
    url = new URL(raw)
  }
  catch {
    return undefined
  }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || url.hostname === '') return undefined
  return { url: raw, host: url.hostname, port }
}

/** Probe one TCP endpoint with a short timeout. */
function probeEndpoint(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(new Error(`team-external: proxy ${endpoint.url} is not reachable (${error.message}) — start it, or set proxy: null / verifyProxy: false`))
    }
    socket.setTimeout(1500, () => finish(new Error('no answer within 1500ms')))
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}

/**
 * Install the Team bridge on one live service instance.
 * @param ctx - the host plugin context (agent team service already mounted).
 * @param config - validated plugin config.
 * @returns uninstaller used by the plugin effect.
 */
function installBridge(ctx, config) {
  const service = ctx.agentTeams
  if (service === undefined || service === null) {
    throw new Error('team-external: the Agent Team service (agentTeams) is not mounted in this profile')
  }
  if (service.__teamExternal !== undefined) {
    throw new Error('team-external: the bridge is already installed on this Agent Team service')
  }

  const originals = {
    listMembers: service.listMembers.bind(service),
    sendMessage: service.sendMessage.bind(service),
    interrupt: service.interrupt.bind(service),
    waitForChange: service.waitForChange.bind(service),
    spawnTeammate: service.spawnTeammate.bind(service),
  }

  /** Running CLI conversations, keyed by roster member id. */
  const runners = new Map()
  /** Team waiters registered by `wait_agent` while only external members can change. */
  const waiters = new Map()
  const persisted = loadState()
  const disposals = []

  // ── Team CLI control channel ─────────────────────────────────────────────
  // External CLI agents cannot call DSH tools directly, so the bridge exposes
  // the same Team surfaces over a token-guarded unix socket and ships a small
  // `team-cli.cjs` they invoke from their own shell tool.
  const control = {
    token: randomUUID(),
    // Unix socket paths are length-bounded (~104 bytes on macOS); a short tmp
    // path keeps the control channel usable under long DSH_HOME values.
    path: join(tmpdir(), `dsh-team-external-${process.pid}.sock`),
    cliPath: fileURLToPath(new URL('./bin/team-cli.cjs', import.meta.url)),
    server: undefined,
  }

  /** Environment injected into every external teammate turn. */
  function controlEnv(runner) {
    return {
      DSH_TEAM_CLI: control.cliPath,
      DSH_TEAM_SOCKET: control.path,
      DSH_TEAM_TOKEN: control.token,
      DSH_TEAM_MEMBER: runner.memberId,
      DSH_TEAM_NAME: runner.name,
      DSH_TEAM_PROVIDER: runner.provider,
    }
  }

  /** Resolve the runner and teammate membership for one control request. */
  function resolveMemberContext(memberId) {
    const existing = runners.get(memberId)
    if (existing !== undefined) {
      const root = ctx.agents.get(existing.teamId) ?? existing.root
      if (root === undefined || root === null) throw new Error('team-cli: the Team Lead is no longer live')
      existing.root = root
      return { runner: existing, membership: { root, id: existing.teamId, role: 'teammate', name: existing.name } }
    }
    for (const [teamId, members] of Object.entries(persisted.teams ?? {})) {
      if (members?.[memberId] === undefined) continue
      const root = ctx.agents.get(teamId)
      if (root === undefined || root === null) continue
      const state = service.journal.state(root)
      const member = state.members.find((candidate) => candidate.id === memberId)
      if (member === undefined) continue
      const runner = ensureRunner(teamId, member, root)
      return { runner, membership: { root, id: teamId, role: 'teammate', name: member.name } }
    }
    throw new Error(`team-cli: unknown external teammate ${JSON.stringify(memberId)}`)
  }

  /** Deliver one external teammate's message to the Lead or another external member. */
  async function controlSend(runner, membership, to, text) {
    const target = String(to ?? '').trim()
    const message = String(text ?? '').trim()
    if (target.length === 0) throw new Error('team-cli: send requires --to <lead|member>')
    if (message.length === 0) throw new Error('team-cli: send requires a message text')
    if (target === 'lead') {
      deliverToLead(runner, message)
      notifyActivity(membership.id)
      return { delivered: true, to: 'lead' }
    }
    const state = service.journal.state(membership.root)
    const member = state.members.find((candidate) => candidate.name === target)
    if (member === undefined) throw new Error(`team-cli: no Team member named ${JSON.stringify(target)}`)
    if (!isExternal(member)) throw new Error(`team-cli: "${target}" is a native teammate — send to "lead" and let the Lead relay`)
    if (member.phase !== 'active') throw new Error(`team-cli: teammate ${JSON.stringify(target)} is not active`)
    const targetRunner = ensureRunner(membership.id, member, membership.root)
    targetRunner.queue.push(`Team message from ${runner.name}:\n${message}`)
    notifyActivity(membership.id)
    pump(targetRunner)
    return { delivered: true, to: target }
  }

  /** Execute one authenticated control command. */
  async function runControlCommand(request) {
    if (request === null || typeof request !== 'object') throw new Error('team-cli: invalid request')
    if (request.token !== control.token) throw new Error('team-cli: invalid token')
    const memberId = typeof request.member === 'string' ? request.member : ''
    const { runner, membership } = resolveMemberContext(memberId)
    const args = request.args !== null && typeof request.args === 'object' ? request.args : {}
    switch (request.cmd) {
      case 'whoami':
        return { name: runner.name, memberId: runner.memberId, teamId: runner.teamId, provider: runner.provider, role: 'teammate' }
      case 'list':
        return { members: service.roster.list(membership) }
      case 'tasks':
        return { tasks: service.tasks.list(membership) }
      case 'task-get':
        return { task: service.tasks.get(membership, String(args.taskId)) }
      case 'task-create':
        return {
          task: await service.tasks.create(membership, {
            subject: String(args.subject ?? ''),
            description: String(args.description ?? ''),
            ...(Array.isArray(args.blockedBy) ? { blockedBy: args.blockedBy.map(String) } : {}),
            ...(Array.isArray(args.writeScopes) ? { writeScopes: args.writeScopes.map(String) } : {}),
          }),
        }
      case 'task-update': {
        const update = { taskId: String(args.taskId), expectedRevision: Number(args.expectedRevision), action: String(args.action) }
        for (const key of ['subject', 'description']) if (typeof args[key] === 'string') update[key] = args[key]
        for (const key of ['blockedBy', 'writeScopes']) if (Array.isArray(args[key])) update[key] = args[key].map(String)
        if (typeof args.owner === 'string') update.owner = args.owner
        return { task: await service.tasks.update({ id: runner.memberId }, membership, update) }
      }
      case 'send':
        return await controlSend(runner, membership, args.to, args.text)
      case 'wait': {
        const timeoutMs = Math.min(3_600_000, Math.max(10_000, Number(args.timeoutMs) || 60_000))
        const result = await service.activity.wait(membership.id, timeoutMs, new AbortController().signal)
        return { timedOut: result.timedOut === true }
      }
      default:
        throw new Error(`team-cli: unknown command ${JSON.stringify(request.cmd)}`)
    }
  }

  /** Start the token-guarded unix-socket control server. */
  function startControlServer() {
    try {
      mkdirSync(dirname(control.path), { recursive: true })
    }
    catch {}
    try {
      unlinkSync(control.path)
    }
    catch {}
    control.server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        let request
        try {
          request = JSON.parse(line)
        }
        catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'team-cli: invalid JSON request' })}\n`)
          return
        }
        runControlCommand(request).then(
          (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
          (error) => socket.end(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`),
        )
      })
    })
    control.server.on('error', () => {})
    control.server.listen(control.path, () => {
      // The token is the real gate; the file mode keeps other local users out.
      try {
        chmodSync(control.path, 0o600)
      }
      catch {}
    })
  }

  /** Close the control server and remove its socket file. */
  function stopControlServer() {
    try {
      control.server?.close()
    }
    catch {}
    try {
      unlinkSync(control.path)
    }
    catch {}
  }
  let proxyOkAt = 0

  /** Fail a turn early when the configured proxy is down (agy needs it). */
  async function ensureProxy(adapter) {
    if (config.verifyProxy !== true || adapter.needsProxy !== true) return
    if (Date.now() - proxyOkAt < 30_000) return
    const endpoint = proxyEndpoint(config.proxy)
    if (endpoint === undefined) return
    await probeEndpoint(endpoint)
    proxyOkAt = Date.now()
  }

  /** Persist one member's conversation position. */
  function remember(runner, conversationId, cwd) {
    const team = (persisted.teams[runner.teamId] ??= {})
    const previous = team[runner.memberId] ?? {}
    team[runner.memberId] = {
      provider: runner.provider,
      conversationId: conversationId ?? previous.conversationId,
      ...(cwd === undefined ? (previous.cwd === undefined ? {} : { cwd: previous.cwd }) : { cwd }),
    }
    saveState(persisted)
  }

  /** The Lead's working directory, used as the external CLI cwd. */
  function leadCwd(root) {
    const raw = root?.session?.header?.cwd
    return typeof raw === 'string' && raw.length > 0 ? raw : process.cwd()
  }

  /** Wake the Team activity seam plus this bridge's own waiters. */
  function notifyActivity(teamId) {
    try {
      service.activity.notify(teamId)
    }
    catch {}
    const set = waiters.get(teamId)
    if (set !== undefined) {
      for (const entry of [...set]) entry.resolve()
      set.clear()
    }
  }

  /** Wait for the next bridge-owned change in one Team. */
  function waitExternalChange(teamId, signal) {
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          cleanup()
          resolve()
        },
      }
      const cleanup = () => {
        set !== undefined && set.delete(entry)
        signal?.removeEventListener?.('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      let set = waiters.get(teamId)
      if (set === undefined) {
        set = new Set()
        waiters.set(teamId, set)
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      set.add(entry)
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** Deliver one external answer as a genuine Team peer message to the Lead. */
  function deliverToLead(runner, body) {
    const root = ctx.agents.get(runner.teamId) ?? runner.root
    if (root === undefined || root === null) return
    const content = [
      { type: 'text', text: `Team message from ${runner.name}:` },
      { type: 'text', text: truncateBytes(body, DELIVER_MAX_BYTES) },
    ]
    const message = deepFreeze({
      id: randomUUID(),
      role: 'user',
      content,
      source: {
        kind: 'agent-message',
        form: 'relay',
        senderSessionId: runner.memberId,
      },
    })
    try {
      root.steer(message)
    }
    catch {}
  }

  /** Deliver one turn failure so the Lead does not have to poll blindly. */
  function deliverFailure(runner, failure) {
    deliverToLead(runner, `[external teammate error] ${truncateBytes(String(failure), 4000)}`)
  }

  /** Create the per-member runtime record on first use. */
  function ensureRunner(teamId, member, root) {
    let runner = runners.get(member.id)
    if (runner !== undefined) {
      if (root !== undefined) runner.root = root
      return runner
    }
    const adapter = resolveAdapter(adapterIdOf(member))
    const stored = persisted.teams?.[teamId]?.[member.id]
    runner = {
      memberId: member.id,
      name: member.name,
      provider: adapter.id,
      adapter,
      teamId,
      root: root ?? ctx.agents.get(teamId),
      conversationId: typeof stored?.conversationId === 'string' ? stored.conversationId : undefined,
      cwd: typeof stored?.cwd === 'string' ? stored.cwd : leadCwd(root ?? ctx.agents.get(teamId)),
      queue: [],
      running: false,
      child: undefined,
      ctrl: undefined,
      timer: undefined,
      completion: undefined,
      lastError: undefined,
      disposed: false,
    }
    runners.set(member.id, runner)
    return runner
  }

  /** Run one CLI turn; returns a completion promise that settles to a result. */
  function beginTurn(runner, task) {
    const prompt = runner.conversationId === undefined ? `${protocolIntro(runner)}\n\n${String(task)}` : String(task)
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error(`external teammate prompt is too large (${Buffer.byteLength(prompt, 'utf8')} bytes, limit ${MAX_PROMPT_BYTES})`)
    }
    const spec = runner.conversationId === undefined
      ? runner.adapter.start({ task: prompt, cwd: runner.cwd, config })
      : runner.adapter.resume({ task: prompt, cwd: runner.cwd, conversationId: runner.conversationId, config })
    const env = { ...runner.adapter.env(config), ...controlEnv(runner) }
    const child = ctx.subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd ?? runner.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: config.disposeGraceMs,
      env,
    })
    const stdout = collectStream(child.stdout)
    const stderr = collectStream(child.stderr)
    const ctrl = new AbortController()
    runner.child = child
    runner.ctrl = ctrl
    runner.running = true
    runner.lastError = undefined
    runner.timer = setTimeout(() => {
      runner.lastError = `turn exceeded ${config.turnTimeoutMs}ms`
      try {
        child.terminate()
      }
      catch {}
      ctrl.abort(new Error(runner.lastError))
    }, config.turnTimeoutMs)

    const completion = (async () => {
      let outcome
      try {
        outcome = await Promise.race([child.done, abortPromise(ctrl.signal)])
      }
      catch {
        try {
          child.terminate()
        }
        catch {}
        await child.done.catch(() => {})
        return { aborted: true, error: runner.lastError ?? 'interrupted' }
      }
      if (outcome.exitCode !== 0) {
        const detail = stderr.text().trim()
        return {
          error: `external CLI exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}${detail.length > 0 ? `\n${truncateBytes(detail, 4000)}` : ''}`,
        }
      }
      const parsed = runner.adapter.parse(stdout.text())
      const answerText = stderr.text().trim()
      if (parsed.conversationId !== undefined) {
        runner.conversationId = parsed.conversationId
        remember(runner, parsed.conversationId)
      }
      if (parsed.error !== undefined) {
        return { error: answerText.length > 0 ? `${parsed.error}\n${truncateBytes(answerText, 4000)}` : parsed.error }
      }
      return { answer: parsed.answer }
    })()

    completion.finally(() => {
      clearTimeout(runner.timer)
      runner.timer = undefined
    }).catch(() => {})

    runner.completion = completion
    return completion
  }

  /** Process the member's queued messages after a turn settles. */
  function pump(runner) {
    if (runner.disposed || runner.running) return
    const next = runner.queue.shift()
    if (next === undefined) {
      notifyActivity(runner.teamId)
      return
    }
    let completion
    try {
      completion = beginTurn(runner, next)
    }
    catch (error) {
      runner.lastError = String(error?.message ?? error)
      deliverFailure(runner, runner.lastError)
      notifyActivity(runner.teamId)
      return
    }
    completion.then(
      (result) => settleTurn(runner, result),
      (error) => settleTurn(runner, { error: String(error?.message ?? error) }),
    )
  }

  /** Apply one settled turn, then continue the queued conversation. */
  function settleTurn(runner, result) {
    runner.running = false
    runner.child = undefined
    runner.ctrl = undefined
    if (runner.disposed) return
    if (result.error !== undefined) {
      if (result.aborted !== true) {
        runner.lastError = result.error
        deliverFailure(runner, result.error)
      }
      else {
        runner.lastError = result.error
      }
    }
    else {
      runner.lastError = undefined
      deliverToLead(runner, result.answer)
    }
    notifyActivity(runner.teamId)
    pump(runner)
  }

  /** Create one external teammate and start its first CLI turn. */
  async function spawnExternalTeammate(caller, request) {
    const membership = service.membership(caller)
    if (membership.role !== 'lead') throw new Error('only the Team Lead can create external teammates')
    const root = membership.root
    const adapter = resolveAdapter(String(request.provider))
    const name = service.roster.memberName(String(request.name))
    const description = typeof request.description === 'string' ? request.description.trim() : ''
    if (description.length === 0) throw new Error('spawn_external_teammate: description must be non-empty')
    if ([...description].length > 200) throw new Error('spawn_external_teammate: description is longer than 200 characters')
    const task = typeof request.task === 'string' ? request.task.trim() : ''
    if (task.length === 0) throw new Error('spawn_external_teammate: task must be non-empty')
    request.signal?.throwIfAborted?.()

    const memberId = randomUUID()
    const providerTag = EXTERNAL_PREFIX + adapter.id
    const member = {
      id: memberId,
      name,
      description,
      provider: providerTag,
      context: 'fresh',
      phase: 'provisioning',
    }
    await service.journal.transact(root.id, async () => {
      const state = service.journal.state(root)
      if (state.members.some((candidate) => candidate.name === name)) {
        throw new Error(`teammate name "${name}" was already used in this Team`)
      }
      if (state.members.filter((candidate) => isExternal(candidate)).length >= config.maxExternalMembers) {
        throw new Error(`external teammate limit ${config.maxExternalMembers} reached`)
      }
      await service.journal.appendAndFlush(root, 'team/member', {
        version: 2,
        teamId: root.id,
        member,
      })
    })

    const runner = ensureRunner(root.id, member, root)
    let completion
    try {
      await ensureProxy(adapter)
      completion = beginTurn(runner, task)
      remember(runner, runner.conversationId, runner.cwd)
    }
    catch (error) {
      runner.running = false
      runners.delete(memberId)
      try {
        await service.roster.settleProvisioning(root, { ...member, phase: 'failed', error: String(error?.message ?? error) })
      }
      catch {}
      throw error
    }

    const phase = await service.roster.settleProvisioning(root, { ...member, phase: 'active' })
    if (phase === 'failed') {
      try {
        runner.child?.terminate()
      }
      catch {}
      runners.delete(memberId)
      throw new Error(`teammate "${name}" was reconciled as failed while creation was in progress`)
    }
    completion?.then(
      (result) => settleTurn(runner, result),
      (error) => settleTurn(runner, { error: String(error?.message ?? error) }),
    )
    notifyActivity(root.id)
    return {
      member: {
        id: memberId,
        name,
        role: 'teammate',
        status: 'running',
        description,
        provider: providerTag,
        context: 'fresh',
        diagnostics: [],
      },
    }
  }

  // ── service decoration ────────────────────────────────────────────────────

  service.listMembers = (agent) => {
    const rows = originals.listMembers(agent)
    const membership = service.membership(agent)
    const state = service.journal.state(membership.root)
    return rows.map((row) => {
      const member = state.members.find((candidate) => candidate.id === row.id)
      if (member === undefined || !isExternal(member)) return row
      const runner = runners.get(member.id)
      const status = member.phase === 'failed'
        ? 'failed'
        : member.phase === 'provisioning'
          ? 'provisioning'
          : runner?.running === true ? 'running' : 'inactive'
      const diagnostics = runner?.lastError === undefined ? [] : [runner.lastError]
      return { ...row, status, diagnostics }
    })
  }

  service.sendMessage = async (caller, request) => {
    const membership = service.membership(caller)
    const state = service.journal.state(membership.root)
    const targetName = typeof request.target === 'string' ? request.target.trim() : ''
    const member = state.members.find((candidate) => candidate.name === targetName)
    if (member === undefined || !isExternal(member)) return originals.sendMessage(caller, request)
    if (member.phase !== 'active') throw new Error(`active teammate "${targetName}" not found`)
    const text = contentToText(request.content, 'send to external teammate')
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new Error(`external teammate message exceeds ${MAX_MESSAGE_BYTES} bytes`)
    }
    const runner = ensureRunner(membership.id, member, membership.root)
    if (runner.running !== true) await ensureProxy(runner.adapter)
    runner.queue.push(`Team message from ${membership.name}:\n${text}`)
    notifyActivity(membership.id)
    pump(runner)
    return { messageId: randomUUID() }
  }

  service.interrupt = (caller, targetName) => {
    const membership = service.membership(caller)
    const state = service.journal.state(membership.root)
    const name = typeof targetName === 'string' ? targetName.trim() : ''
    const member = state.members.find((candidate) => candidate.name === name)
    if (member === undefined || !isExternal(member)) return originals.interrupt(caller, targetName)
    if (membership.role !== 'lead') throw new Error('only the Team Lead can interrupt teammates')
    if (member.phase !== 'active') throw new Error(`active teammate "${name}" not found`)
    const runner = runners.get(member.id)
    const previousStatus = runner?.running === true ? 'running' : 'inactive'
    if (runner?.running === true) {
      runner.lastError = 'interrupted'
      try {
        runner.child?.terminate()
      }
      catch {}
      try {
        runner.ctrl?.abort(new Error('interrupted'))
      }
      catch {}
      notifyActivity(membership.id)
    }
    return { previousStatus }
  }

  service.waitForChange = async (caller, timeoutMs, signal) => {
    const membership = service.membership(caller)
    const teamId = membership.id
    const local = new AbortController()
    const combined = AbortSignal.any([signal, local.signal])
    let externalWon = false
    const external = waitExternalChange(teamId, combined)
      .then(() => {
        externalWon = true
        return { timedOut: false }
      })
      .catch(() => undefined)
    const native = originals.waitForChange(caller, timeoutMs, combined).catch((error) => {
      if (externalWon || local.signal.aborted) return { timedOut: false }
      throw error
    })
    try {
      return await Promise.race([native, external])
    }
    finally {
      try {
        local.abort(new Error('team-external wait settled'))
      }
      catch {}
    }
  }

  service.spawnTeammate = async (caller, request) => {
    if (typeof request.provider === 'string' && request.provider.startsWith(EXTERNAL_PREFIX)) {
      const provider = request.provider.slice(EXTERNAL_PREFIX.length)
      return spawnExternalTeammate(caller, {
        name: request.name,
        description: request.description,
        provider,
        task: contentToText(request.prompt, 'spawn external teammate'),
        signal: request.signal,
      })
    }
    return originals.spawnTeammate(caller, request)
  }

  service.spawnExternalTeammate = spawnExternalTeammate

  // ── model tool ────────────────────────────────────────────────────────────

  const toolDispose = ctx.tools.register({
    name: 'spawn_external_teammate',
    description: SPAWN_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Unique lower-kebab-case teammate name (like a native teammate: spawn_greeter, zcode-reviewer).',
        },
        description: {
          type: 'string',
          description: 'Short description of this external teammate\'s responsibility (max 200 chars).',
        },
        provider: {
          type: 'string',
          enum: PROVIDER_IDS,
          description: 'External CLI backend: antigravity (Antigravity/agy), zcode (ZCode), kimicode (Kimi Code).',
        },
        task: {
          type: 'string',
          description: 'Initial task sent to the external CLI. It starts immediately in the Lead\'s working directory.',
        },
      },
      required: ['name', 'description', 'provider', 'task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          description: { type: 'string' },
          provider: { type: 'string' },
          context: { type: 'string' },
          diagnostics: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'role', 'status', 'provider'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `External teammate ${value.name} (${value.provider}) is ${value.status}.`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('spawn_external_teammate requires a calling Agent')
      const result = await spawnExternalTeammate(exec.agent, {
        name: args?.name,
        description: args?.description,
        provider: args?.provider,
        task: args?.task,
        signal: exec.signal,
      })
      return result.member
    },
  })

  disposals.push(() => {
    for (const runner of runners.values()) {
      runner.disposed = true
      try {
        runner.ctrl?.abort(new Error('team-external is disposing'))
      }
      catch {}
      try {
        runner.child?.terminate()
      }
      catch {}
    }
    runners.clear()
    for (const set of waiters.values()) {
      for (const entry of [...set]) entry.resolve()
      set.clear()
    }
    waiters.clear()
    stopControlServer()
    toolDispose?.()
    service.listMembers = originals.listMembers
    service.sendMessage = originals.sendMessage
    service.interrupt = originals.interrupt
    service.waitForChange = originals.waitForChange
    service.spawnTeammate = originals.spawnTeammate
    delete service.spawnExternalTeammate
    delete service.__teamExternal
  })

  startControlServer()

  Object.defineProperty(service, '__teamExternal', {
    value: { runners, spawnExternalTeammate },
    configurable: true,
  })

  return () => {
    for (const dispose of disposals.splice(0)) {
      try {
        dispose()
      }
      catch {}
    }
  }
}

const name = 'team-external'
const inject = ['agentTeams', 'agents', 'tools', 'subprocess']

/** Mount the Team bridge for external CLI agents. */
function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  ctx.effect(() => installBridge(ctx, resolved), 'teamExternal.bridge()')
}

export { apply, inject, name }
