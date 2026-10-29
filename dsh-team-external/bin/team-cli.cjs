#!/usr/bin/env node
'use strict'

/**
 * Team CLI for external teammates.
 *
 * The bridge plugin (index.js) hosts a small token-guarded control socket inside
 * the DSH Host process. An external CLI agent calls this script from its own
 * shell tool to use the native Agent Team surfaces: roster, peer messages and
 * the shared task board.
 *
 * The script only uses `node:` builtins and receives its identity from the
 * environment the bridge injects into every external teammate turn:
 *
 *   DSH_TEAM_CLI, DSH_TEAM_SOCKET, DSH_TEAM_TOKEN, DSH_TEAM_MEMBER, DSH_TEAM_NAME
 *
 * Usage examples (as shown in the injected Team protocol):
 *   node "$DSH_TEAM_CLI" whoami
 *   node "$DSH_TEAM_CLI" list
 *   node "$DSH_TEAM_CLI" tasks
 *   node "$DSH_TEAM_CLI" task-get task-3
 *   node "$DSH_TEAM_CLI" task-claim task-3 --rev 1
 *   node "$DSH_TEAM_CLI" task-complete task-3 --rev 2
 *   node "$DSH_TEAM_CLI" task-create --subject "Fix gate" --description "..."
 *   node "$DSH_TEAM_CLI" send --to lead "review done, all green"
 *   node "$DSH_TEAM_CLI" wait --timeout 30000
 */

const net = require('node:net')

const rawArgs = process.argv.slice(2)
const command = rawArgs[0]
const rest = rawArgs.slice(1)

function fail(message) {
  console.error(`team-cli: ${message}`)
  process.exit(1)
}

function requireEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) fail(`${name} is not set — this command only works inside an external teammate turn started by the DSH Team bridge`)
  return value
}

/** Split remaining argv into positionals and `--flag value` / `--flag=value` options. */
function parseArgs(argv) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq >= 0) {
        options[token.slice(2, eq)] = token.slice(eq + 1)
        continue
      }
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        index += 1
      }
      else {
        options[key] = true
      }
      continue
    }
    positionals.push(token)
  }
  return { positionals, options }
}

function numberOption(options, key) {
  const value = options[key]
  if (value === undefined || value === true) fail(`--${key} requires a number`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail(`--${key} must be a number, got ${JSON.stringify(value)}`)
  return parsed
}

function listOption(options, key) {
  const values = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    if (rawArgs[index] === `--${key}` && rawArgs[index + 1] !== undefined && !rawArgs[index + 1].startsWith('--')) values.push(rawArgs[index + 1])
    if (rawArgs[index].startsWith(`--${key}=`)) values.push(rawArgs[index].slice(key.length + 3))
  }
  return values
}

const { positionals, options } = parseArgs(rest)

/** Build the request for one command. */
function buildRequest() {
  switch (command) {
    case 'whoami':
    case 'list':
    case 'tasks':
      return { cmd: command, args: {} }
    case 'task-get': {
      if (positionals[0] === undefined) fail('task-get requires a task id (for example task-3)')
      return { cmd: 'task-get', args: { taskId: positionals[0] } }
    }
    case 'task-claim':
    case 'task-release':
    case 'task-complete':
    case 'task-reopen':
    case 'task-delete': {
      if (positionals[0] === undefined) fail(`${command} requires a task id`)
      return { cmd: 'task-update', args: { taskId: positionals[0], expectedRevision: numberOption(options, 'rev'), action: command.slice('task-'.length) } }
    }
    case 'task-edit': {
      if (positionals[0] === undefined) fail('task-edit requires a task id')
      return {
        cmd: 'task-update',
        args: {
          taskId: positionals[0],
          expectedRevision: numberOption(options, 'rev'),
          action: 'edit',
          ...(options.subject === undefined ? {} : { subject: String(options.subject) }),
          ...(options.description === undefined ? {} : { description: String(options.description) }),
          ...(listOption(options, 'write-scope').length === 0 ? {} : { writeScopes: listOption(options, 'write-scope') }),
        },
      }
    }
    case 'task-create': {
      if (options.subject === undefined) fail('task-create requires --subject')
      if (options.description === undefined) fail('task-create requires --description')
      return {
        cmd: 'task-create',
        args: {
          subject: String(options.subject),
          description: String(options.description),
          ...(listOption(options, 'blocked-by').length === 0 ? {} : { blockedBy: listOption(options, 'blocked-by') }),
          ...(listOption(options, 'write-scope').length === 0 ? {} : { writeScopes: listOption(options, 'write-scope') }),
        },
      }
    }
    case 'send': {
      const to = options.to
      if (to === undefined || to === true) fail('send requires --to <lead|member-name>')
      const text = positionals.join(' ').trim()
      if (text.length === 0) fail('send requires a message text')
      return { cmd: 'send', args: { to: String(to), text } }
    }
    case 'wait': {
      const timeout = options.timeout === undefined ? 60000 : numberOption(options, 'timeout')
      return { cmd: 'wait', args: { timeoutMs: timeout } }
    }
    case 'help':
    case undefined:
      process.stdout.write(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1])
      process.exit(0)
      break
    default:
      fail(`unknown command ${JSON.stringify(command)} — try: whoami, list, tasks, task-get, task-create, task-claim, task-complete, task-edit, send, wait`)
  }
}

const request = buildRequest()
request.member = requireEnv('DSH_TEAM_MEMBER')
request.token = requireEnv('DSH_TEAM_TOKEN')
const socketPath = requireEnv('DSH_TEAM_SOCKET')

const socket = net.connect({ path: socketPath })
let received = ''
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
socket.on('data', (chunk) => { received += chunk })
socket.on('error', (error) => fail(`cannot reach the DSH Team bridge at ${socketPath}: ${error.message}`))
socket.on('close', () => {
  const line = received.trim()
  if (line.length === 0) fail('the DSH Team bridge closed the connection without an answer')
  let response
  try {
    response = JSON.parse(line)
  }
  catch {
    fail(`the DSH Team bridge returned an unparseable answer: ${line.slice(0, 400)}`)
  }
  if (response.ok !== true) fail(String(response.error ?? 'unknown bridge error'))
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`)
})
