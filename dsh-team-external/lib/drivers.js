/**
 * External CLI adapters for the Team bridge.
 *
 * Each adapter knows three things for one product: how to start a fresh CLI
 * conversation, how to resume an existing one with a new user message, and how
 * to read the answer plus the conversation id out of the CLI's output.
 *
 * Self-contained: only `node:` builtins are imported (a linked workspace bundle
 * has no own node_modules). Everything machine-specific lives in the row config
 * under `providers.<id>`.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The ZCode launcher shipped beside this file. */
const ZCODE_LAUNCHER = fileURLToPath(new URL('../bin/zcode-cli.cjs', import.meta.url))

/** Adapter ids accepted by `spawn_external_teammate`. */
export const PROVIDER_IDS = ['antigravity', 'zcode', 'kimicode']

/** Human-facing labels used in tool descriptions and diagnostics. */
export const PROVIDER_LABELS = {
  antigravity: 'Antigravity (agy)',
  zcode: 'ZCode',
  kimicode: 'Kimi Code',
}

/** One machine's system proxy, applied to CLIs that need it. */
export const DEFAULT_PROXY = 'http://127.0.0.1:12450'

/** Proxy environment keys forced for adapters with `needsProxy`. */
function proxyEnv(proxy) {
  if (typeof proxy !== 'string' || proxy.length === 0) return {}
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: '',
  }
}

/** Layer explicit config env over adapter defaults. */
function envFor(adapter, config, kind) {
  const base = adapter.needsProxy === true ? proxyEnv(config.proxy) : {}
  const electron = kind === 'zcode' && process.versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  return { ...base, ...electron, ...(config.providers?.[kind]?.env ?? {}) }
}

/** Read one provider's row override. */
function override(config, kind) {
  const value = config.providers?.[kind]
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Turn `--flag value` pairs from config into argv entries. */
function optionalFlag(argv, flag, value) {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

/** Non-empty string helper. */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Resolve the physical (symlink-free) working directory one CLI recorded. */
function physicalCwd(cwd) {
  try {
    return realpathSync(cwd)
  }
  catch {
    return cwd
  }
}

/** Parse one NDJSON stream, ignoring non-JSON diagnostic lines. */
function parseNdjson(text) {
  const records = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) records.push(value)
    }
    catch {}
  }
  return records
}

/** The Antigravity CLI (`agy --print`). */
const antigravity = {
  id: 'antigravity',
  needsProxy: true,
  /** Build argv for a fresh conversation. */
  start({ task, config }) {
    const own = override(config, 'antigravity')
    const argv = [text(own.command) ?? 'agy', '--output-format', 'json']
    optionalFlag(argv, '--model', text(own.model))
    optionalFlag(argv, '--effort', text(own.effort))
    // Headless print mode cannot prompt for tool approvals; teammates are meant
    // to do real work, so skip permissions unless the row explicitly opts out.
    if (own.dangerouslySkipPermissions !== false) argv.push('--dangerously-skip-permissions')
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    argv.push(`--print=${task}`)
    return { argv }
  },
  /** Build argv resuming one conversation. */
  resume({ task, conversationId, config }) {
    const own = override(config, 'antigravity')
    const argv = [text(own.command) ?? 'agy', '--output-format', 'json', '--conversation', conversationId]
    optionalFlag(argv, '--model', text(own.model))
    optionalFlag(argv, '--effort', text(own.effort))
    if (own.dangerouslySkipPermissions !== false) argv.push('--dangerously-skip-permissions')
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    argv.push(`--print=${task}`)
    return { argv }
  },
  /** Parse the JSON envelope printed on stdout. */
  parse(stdout) {
    let value
    try {
      value = JSON.parse(stdout)
    }
    catch {
      return { error: `Antigravity printed no JSON envelope${stdout.trim().length > 0 ? `: ${stdout.trim().slice(0, 400)}` : ''}` }
    }
    if (value === null || typeof value !== 'object') return { error: 'Antigravity printed an invalid JSON envelope' }
    const conversationId = text(value.conversation_id)
    const answer = typeof value.response === 'string' ? value.response : undefined
    if (value.status !== 'SUCCESS' || value.error !== undefined) {
      return { conversationId, error: `Antigravity failed (${String(value.status)}): ${String(value.error ?? value.message ?? 'no error text')}` }
    }
    if (answer === undefined || answer.trim().length === 0) return { conversationId, error: 'Antigravity completed without a final answer' }
    return { conversationId, answer }
  },
  env(config) {
    return envFor(antigravity, config, 'antigravity')
  },
}

/** The ZCode CLI (through the bundled launcher). */
const zcode = {
  id: 'zcode',
  needsProxy: false,
  start({ task, cwd, config }) {
    const own = override(config, 'zcode')
    const argv = ['-p', task, '--json', '--cwd', cwd]
    optionalFlag(argv, '--mode', text(own.mode))
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    return { argv: [process.execPath, ZCODE_LAUNCHER, ...argv] }
  },
  resume({ task, cwd, conversationId, config }) {
    const own = override(config, 'zcode')
    const argv = ['--resume', conversationId, '-p', task, '--json', '--cwd', cwd]
    optionalFlag(argv, '--mode', text(own.mode))
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    return { argv: [process.execPath, ZCODE_LAUNCHER, ...argv] }
  },
  parse(stdout) {
    let value
    try {
      value = JSON.parse(stdout)
    }
    catch {
      return { error: `ZCode printed no JSON envelope${stdout.trim().length > 0 ? `: ${stdout.trim().slice(0, 400)}` : ''}` }
    }
    if (value === null || typeof value !== 'object') return { error: 'ZCode printed an invalid JSON envelope' }
    const conversationId = text(value.sessionId)
    const answer = typeof value.response === 'string' ? value.response : undefined
    if (value.error !== undefined) return { conversationId, error: `ZCode failed: ${String(value.error)}` }
    if (answer === undefined || answer.trim().length === 0) return { conversationId, error: 'ZCode completed without a final answer' }
    return { conversationId, answer }
  },
  env(config) {
    return envFor(zcode, config, 'zcode')
  },
}

/** The Kimi Code CLI (`kimi -p`). */
const kimicode = {
  id: 'kimicode',
  needsProxy: false,
  start({ task, cwd, config }) {
    const own = override(config, 'kimicode')
    const argv = ['-p', task, '--output-format', 'stream-json']
    optionalFlag(argv, '-m', text(own.model))
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    return { argv: [text(own.command) ?? 'kimi', ...argv], cwd: physicalCwd(cwd) }
  },
  resume({ task, cwd, conversationId, config }) {
    const own = override(config, 'kimicode')
    const argv = ['-S', conversationId, '-p', task, '--output-format', 'stream-json']
    optionalFlag(argv, '-m', text(own.model))
    if (Array.isArray(own.extraArgs)) argv.push(...own.extraArgs.map(String))
    return { argv: [text(own.command) ?? 'kimi', ...argv], cwd: physicalCwd(cwd) }
  },
  parse(stdout) {
    const records = parseNdjson(stdout)
    if (records.length === 0) {
      return { error: `Kimi Code printed no stream events${String(stdout).trim().length > 0 ? `: ${String(stdout).trim().slice(0, 400)}` : ''}` }
    }
    const errorRecord = records.find((record) => record.type === 'error')
    if (errorRecord !== undefined) {
      return { error: `Kimi Code failed (${String(errorRecord.code)}): ${String(errorRecord.message)}` }
    }
    let conversationId
    let answer
    for (const record of records) {
      if (record.role === 'assistant' && typeof record.content === 'string' && record.content.trim().length > 0) {
        answer = record.content
      }
      if (record.role === 'meta' && record.type === 'session.resume_hint' && typeof record.session_id === 'string') {
        conversationId = record.session_id
      }
    }
    if (answer === undefined) return { conversationId, error: 'Kimi Code completed without a final answer' }
    return { conversationId, answer }
  },
  env(config) {
    return { KIMI_CODE_NO_AUTO_UPDATE: '1', ...envFor(kimicode, config, 'kimicode') }
  },
}

/** Adapter table keyed by provider id. */
export const PROVIDERS = { antigravity, zcode, kimicode }

/** Resolve one provider id or explain the accepted values. */
export function resolveAdapter(id) {
  const adapter = PROVIDERS[id]
  if (adapter === undefined) {
    throw new Error(`unknown external provider ${JSON.stringify(id)}; expected one of ${PROVIDER_IDS.join(', ')}`)
  }
  return adapter
}
