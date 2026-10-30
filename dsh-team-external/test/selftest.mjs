/**
 * In-memory self-test for the team-external bridge (v1.1: control channel).
 *
 * Runs the real `index.js` against a fake Agent Team service, fake Agent/ctx and
 * a fake subprocess seam, then exercises the Team CLI control socket from the
 * same process and through the real `bin/team-cli.cjs` child script.
 *
 * Usage: node test/selftest.mjs
 */

import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

const PLUGIN_INDEX = new URL('../index.js', import.meta.url)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'team-external-selftest-'))

const { apply } = await import(pathToFileURL(PLUGIN_INDEX.pathname).href)

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  [${detail}]`}`)
}

// ── fake Lead Agent ─────────────────────────────────────────────────────────
const steered = []
const lead = {
  id: 'lead-1',
  options: { model: 'deepseek-flash' },
  session: { header: { cwd: '/tmp' } },
  status: 'inactive',
  steer(message) { steered.push(message) },
}

// ── fake Team state/service ─────────────────────────────────────────────────
const state = { id: 'lead-1', members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 }
const notifications = []
const appended = []
const delegation = []

const journal = {
  state: () => state,
  transact: async (_rootId, operation) => await operation(),
  appendAndFlush: async (root, type, data) => {
    appended.push({ type, data })
    if (type === 'team/member') {
      const index = state.members.findIndex((member) => member.id === data.member.id)
      if (index >= 0) state.members[index] = data.member
      else state.members.push(data.member)
    }
    activity.notify(root.id)
  },
}
const activity = { notify: (id) => notifications.push(id), wait: async () => ({ timedOut: true }) }
const roster = {
  list() {
    return [
      { id: lead.id, name: 'lead', role: 'lead', status: 'inactive', diagnostics: [] },
      ...state.members.map((member) => ({ id: member.id, name: member.name, role: 'teammate', status: 'inactive', provider: member.provider, diagnostics: [] })),
    ]
  },
  memberName(value) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 64 || value === 'lead') throw new Error('teammate name must be lower-kebab-case, at most 64 characters, and not "lead"')
    return value
  },
  async settleProvisioning(root, terminal) {
    const current = state.members.find((member) => member.id === terminal.id)
    if (current === undefined) throw new Error('provisioned teammate disappeared')
    if (current.phase !== 'provisioning') return current.phase
    await journal.appendAndFlush(root, 'team/member', { version: 2, teamId: root.id, member: terminal })
    return terminal.phase === 'active' ? 'active' : 'failed'
  },
}
const tasks = {
  list: () => state.tasks.map((task) => ({ ...task })),
  get(_membership, id) {
    const task = state.tasks.find((candidate) => candidate.id === id)
    if (task === undefined) throw new Error(`team task "${id}" not found`)
    return { ...task }
  },
  async create(_membership, request) {
    const task = { id: `task-${state.tasks.length + 1}`, revision: 1, subject: request.subject, description: request.description, status: 'pending', blockedBy: [], writeScopes: request.writeScopes ?? [] }
    state.tasks.push(task)
    return { ...task }
  },
  async update(caller, _membership, request) {
    const index = state.tasks.findIndex((candidate) => candidate.id === request.taskId)
    if (index < 0) throw new Error(`team task "${request.taskId}" not found`)
    const current = state.tasks[index]
    if (current.revision !== request.expectedRevision) throw new Error(`stale team task "${request.taskId}" revision ${request.expectedRevision}; current revision is ${current.revision}`)
    const next = { ...current, revision: current.revision + 1 }
    if (request.action === 'claim') { next.status = 'in_progress'; next.ownerId = caller.id }
    if (request.action === 'complete') { next.status = 'completed' }
    if (request.action === 'edit') { if (request.subject !== undefined) next.subject = request.subject; if (request.description !== undefined) next.description = request.description }
    state.tasks[index] = next
    return { ...next }
  },
}
const service = {
  config: { maxMembers: 16 },
  journal,
  activity,
  roster,
  tasks,
  membership(agent) {
    if (agent !== lead) throw new Error('agent is not a member of an active Agent Team')
    return { root: lead, id: lead.id, role: 'lead', name: 'lead' }
  },
  listMembers(agent) {
    this.membership(agent)
    return roster.list()
  },
  async sendMessage(caller, request) {
    delegation.push({ method: 'sendMessage', target: request.target })
    return { messageId: 'native-send' }
  },
  interrupt(caller, target) {
    delegation.push({ method: 'interrupt', target })
    return { previousStatus: 'inactive' }
  },
  async waitForChange() {
    delegation.push({ method: 'waitForChange' })
    return { timedOut: true }
  },
  async spawnTeammate() {
    delegation.push({ method: 'spawnTeammate' })
    return { member: { id: 'native-child', name: 'native', role: 'teammate', status: 'running' } }
  },
}

// ── fake subprocess seam ───────────────────────────────────────────────────
const spawns = []
let nextOutput = { delay: 3, exitCode: 0, stdout: '', stderr: '' }
function fakeSpawn(spec) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const output = nextOutput
  let settleDone
  let settled = false
  const settle = (outcome) => { if (!settled) { settled = true; settleDone(outcome) } }
  const done = new Promise((resolve) => { settleDone = resolve })
  const timer = setTimeout(() => {
    if (output.stdout.length > 0) stdout.write(output.stdout)
    if (output.stderr.length > 0) stderr.write(output.stderr)
    stdout.end()
    stderr.end()
    settle({ exitCode: output.exitCode, signal: null })
  }, output.delay)
  const child = {
    stdout,
    stderr,
    done,
    terminated: false,
    terminate() {
      if (this.terminated) return
      this.terminated = true
      clearTimeout(timer)
      try { stdout.end() } catch {}
      try { stderr.end() } catch {}
      setTimeout(() => settle({ exitCode: null, signal: 'SIGTERM' }), 2)
    },
    async waitForExit() {},
  }
  spawns.push({ spec, child })
  return child
}
const ctx = {
  agents: { get: (id) => (id === lead.id ? lead : undefined), list: () => [lead] },
  tools: { register: (definition) => { ctx.registeredTool = definition; return () => {} } },
  subprocess: { spawn: fakeSpawn },
  effect: (callback) => { ctx.dispose = callback(); return ctx.dispose },
  logger: { warn: () => {} },
  agentTeams: service,
}
apply(ctx, { verifyProxy: false })

const signal = new AbortController().signal
const flush = () => new Promise((resolve) => setTimeout(resolve, 60))

// ── install surface ────────────────────────────────────────────────────────
check('tool registered', ctx.registeredTool?.name === 'spawn_external_teammate')
check('bridge installed', typeof service.spawnExternalTeammate === 'function')
check('service decorated', service.__teamExternal !== undefined)

// ── spawn ──────────────────────────────────────────────────────────────────
nextOutput = { delay: 3, exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: 'ANSWER-1', conversation_id: 'conv-1' }), stderr: 'diag\n' }
const spawned = await service.spawnExternalTeammate(lead, { name: 'agy-worker', description: 'external antigravity', provider: 'antigravity', task: 'hello external', signal })
const memberId = spawned.member.id
const startSpec = spawns[0].spec
check('spawn returns running member', spawned.member.status === 'running' && spawned.member.name === 'agy-worker')
check('member persisted active', state.members[0]?.phase === 'active' && state.members[0]?.provider === 'external:antigravity')
check('protocol injected on first turn', String(startSpec.argv.at(-1)).startsWith('--print=[DSH Team protocol]') && String(startSpec.argv.at(-1)).endsWith('hello external'))
check('protocol documents team-cli', String(startSpec.argv.at(-1)).includes('DSH_TEAM_CLI') && String(startSpec.argv.at(-1)).includes('task-claim'))
const env = startSpec.env
check('control env injected', typeof env.DSH_TEAM_CLI === 'string' && env.DSH_TEAM_TOKEN.length > 10 && env.DSH_TEAM_MEMBER === memberId && env.DSH_TEAM_NAME === 'agy-worker')
check('proxy env for agy', env.HTTP_PROXY === 'http://127.0.0.1:12450' && env.NO_PROXY === '')
await flush()
check('first answer delivered as peer message', steered.length === 1 && steered[0].content[0].text === 'Team message from agy-worker:' && steered[0].content[1].text === 'ANSWER-1')
check('peer source shape', steered[0].source.kind === 'agent-message' && steered[0].source.senderSessionId === memberId)

// ── resume via send_message ────────────────────────────────────────────────
nextOutput = { delay: 3, exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: 'ANSWER-2', conversation_id: 'conv-1' }), stderr: '' }
const sent = await service.sendMessage(lead, { target: 'agy-worker', content: [{ type: 'text', text: 'second question' }], signal })
check('resume argv', spawns[1]?.spec.argv.includes('--conversation') && spawns[1]?.spec.argv.includes('conv-1'))
check('resume prompt has no protocol block', String(spawns[1]?.spec.argv.at(-1)).endsWith('--print=Team message from lead:\nsecond question'))
await flush()
check('resume answer delivered', steered.at(-1)?.content[1].text === 'ANSWER-2')

// ── control channel (same process) ─────────────────────────────────────────
state.members.unshift({ id: 'native-1', name: 'native-one', description: 'a native teammate', provider: 'spawn', context: 'fresh', phase: 'active' })

function controlRequest(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: env.DSH_TEAM_SOCKET })
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { received += chunk })
    socket.on('error', reject)
    socket.on('close', () => {
      try { resolve(JSON.parse(received.trim())) } catch (error) { reject(error) }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: env.DSH_TEAM_TOKEN, member: env.DSH_TEAM_MEMBER, ...payload })}\n`))
  })
}
const whoami = await controlRequest({ cmd: 'whoami', args: {} })
check('whoami over socket', whoami.ok === true && whoami.result.name === 'agy-worker' && whoami.result.role === 'teammate')
const badToken = await controlRequest({ cmd: 'whoami', args: {}, token: 'nope' })
check('bad token rejected', badToken.ok === false && /invalid token/u.test(badToken.error))
const listed = await controlRequest({ cmd: 'list', args: {} })
check('list over socket', listed.ok === true && listed.result.members.length === 3)
const created = await controlRequest({ cmd: 'task-create', args: { subject: 'cli task', description: 'made by external teammate' } })
check('external creates task', created.ok === true && created.result.task.id === 'task-1', JSON.stringify(created.result?.task?.id))
const claimed = await controlRequest({ cmd: 'task-update', args: { taskId: 'task-1', expectedRevision: 1, action: 'claim' } })
check('external claims task', claimed.ok === true && claimed.result.task.status === 'in_progress' && claimed.result.task.ownerId === memberId)
const completed = await controlRequest({ cmd: 'task-update', args: { taskId: 'task-1', expectedRevision: 2, action: 'complete' } })
check('external completes task', completed.ok === true && completed.result.task.status === 'completed')
const stale = await controlRequest({ cmd: 'task-update', args: { taskId: 'task-1', expectedRevision: 1, action: 'complete' } })
check('stale revision rejected', stale.ok === false && /stale/u.test(stale.error))
const tasksList = await controlRequest({ cmd: 'tasks', args: {} })
check('tasks list over socket', tasksList.ok === true && tasksList.result.tasks.length === 1)
const extSend = await controlRequest({ cmd: 'send', args: { to: 'lead', text: 'external progress note' } })
check('external messages lead', extSend.ok === true && steered.at(-1)?.content[1].text === 'external progress note')
const relaySend = await controlRequest({ cmd: 'send', args: { to: 'native-one', text: 'message for the native teammate' } })
check('external relays to native teammate', relaySend.ok === true && relaySend.result.relayedBy === 'lead' && delegation.some((entry) => entry.method === 'sendMessage' && entry.target === 'native-one'), JSON.stringify(relaySend.result))
const badTarget = await controlRequest({ cmd: 'send', args: { to: 'nobody', text: 'hi' } })
check('unknown member target rejected', badTarget.ok === false && /no Team member/u.test(badTarget.error))

// ── real team-cli.cjs child process ────────────────────────────────────────
const cliEnv = { ...process.env, ...env }
// Async child execution is required here: the control server lives in THIS
// process, so a synchronous execFileSync would deadlock the event loop.
function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [env.DSH_TEAM_CLI, ...args], { env: cliEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
      else resolve(stdout)
    })
  })
}
const whoamiProcess = await runCli(['whoami'])
check('team-cli.cjs whoami', whoamiProcess.includes('agy-worker') && whoamiProcess.includes('teammate'))
const tasksProcess = await runCli(['tasks'])
check('team-cli.cjs tasks', tasksProcess.includes('task-1') && tasksProcess.includes('completed'))
const sendProcess = await runCli(['send', '--to', 'lead', 'cross process message'])
check('team-cli.cjs send', sendProcess.includes('delivered') && steered.at(-1)?.content[1].text === 'cross process message')
const created2 = await runCli(['task-create', '--subject', 'proc task', '--description', 'from child process'])
const processTaskId = JSON.parse(created2).task.id
check('team-cli.cjs task-create', processTaskId === 'task-2', processTaskId)
const claimOut = await runCli(['task-claim', processTaskId, '--rev', '1'])
check('team-cli.cjs task-claim', JSON.parse(claimOut).task.status === 'in_progress')

// ── interrupt ──────────────────────────────────────────────────────────────
nextOutput = { delay: 5000, exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: 'NEVER', conversation_id: 'conv-1' }), stderr: '' }
const slow = service.sendMessage(lead, { target: 'agy-worker', content: [{ type: 'text', text: 'long run' }], signal })
await slow
await new Promise((resolve) => setTimeout(resolve, 5))
const interrupted = service.interrupt(lead, 'agy-worker')
check('interrupt returns running', interrupted.previousStatus === 'running')
check('interrupt terminates child', spawns.at(-1).child.terminated === true)
await flush()
const stillThere = service.listMembers(lead).find((entry) => entry.name === 'agy-worker')
check('member inactive after interrupt', stillThere?.status === 'inactive' && stillThere?.diagnostics.includes('interrupted'))

// ── delegation and error paths ────────────────────────────────────────────
check('native send delegated', (await service.sendMessage(lead, { target: 'lead', content: [{ type: 'text', text: 'x' }], signal })).messageId === 'native-send')
let duplicateError
try { await service.spawnExternalTeammate(lead, { name: 'agy-worker', description: 'dup', provider: 'antigravity', task: 'x', signal }) } catch (error) { duplicateError = String(error?.message ?? error) }
check('duplicate name rejected', /already used/u.test(duplicateError ?? ''))
let badProvider
try { await service.spawnExternalTeammate(lead, { name: 'bad-one', description: 'bad', provider: 'nope', task: 'x', signal }) } catch (error) { badProvider = String(error?.message ?? error) }
check('unknown provider rejected', /unknown external provider/u.test(badProvider ?? ''))

// ── dispose ────────────────────────────────────────────────────────────────
ctx.dispose()
check('uninstall restores service', service.__teamExternal === undefined && service.spawnExternalTeammate === undefined)
let socketClosed = false
await new Promise((resolve) => {
  const probe = net.connect({ path: env.DSH_TEAM_SOCKET })
  probe.on('error', () => { socketClosed = true; resolve() })
  probe.on('connect', () => { probe.destroy(); resolve() })
})
check('control socket closed on dispose', socketClosed)

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
}
