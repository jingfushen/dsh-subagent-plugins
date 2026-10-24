/**
 * One-shot ZCode CLI subagent provider for the DeepSeek Harness delegation seam.
 *
 * Modelled on @deepseek-ai/dsh-subagent-codex: an OUT-OF-PROCESS one-shot
 * provider that advertises NO start-time capabilities and publishes through the
 * seam's run-handle / result contract. Where the official Codex provider drives
 * the Codex app-server JSON-RPC protocol, ZCode is driven through its documented
 * non-interactive print mode (`zcode -p <task> --json --cwd <dir>`), so this
 * adapter owns argc construction and the JSON result envelope instead of a wire
 * protocol.
 *
 * ── why a launcher (bin/zcode-cli.cjs) instead of `zcode` on PATH ───────────
 * The ZCode CLI that ships inside ZCode.app (`Contents/Resources/glm/zcode.cjs`)
 * is not directly executable in `-p` mode: it resolves its BUILT-IN provider
 * catalogue from `dirname(realpath(process.argv[1]))/provider/zcode-builtin.json`,
 * a layout that only exists for the app's own bundled entrypoint. The launcher
 * shipped with this bundle recreates that layout in a stable per-user temp
 * directory, points argv[1] at it, and then requires the real bundle. The child
 * process therefore stays `[node, <launcher>, '-p', task, '--json', ...]`.
 *
 * ── argv shape (verified against ZCode CLI 0.17.0, not guessed) ─────────────
 *   node <launcher> -p <task> --json --cwd <cwd> [--mode <mode>] [...extraArgs]
 *
 * `-p/--prompt` takes the prompt as its value. The prompt never passes through a
 * shell: the seam spawns an argv array, never a command string. `--json` makes
 * the CLI print one JSON object on stdout; looking at the message catalogue
 * there is no model flag, so `model` config is accepted but not emitted — use
 * `extraArgs` for any raw CLI flag, including a future model selector.
 *
 * ── why the seam helpers are re-implemented ────────────────────────────────
 * This bundle is installed as a linked workspace bundle and must stay
 * self-contained (relative imports plus `node:` builtins only; no bare package
 * specifiers). This file therefore re-states the two contracts it needs —
 * settleRunResult and subprocessRunHandle — against their documented
 * behaviour rather than importing them.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'subagent-zcode'
export const inject = ['subagents', 'subprocess']

/** Diagnostic prefix for every message this provider throws or logs. */
const PLUGIN = 'subagent-zcode'

/** Absolute path of the launcher shipped next to this file. */
const LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'zcode-cli.cjs')

/** Standard macOS install location of the ZCode app's Resources directory. */
const DEFAULT_APP_RESOURCES = '/Applications/ZCode.app/Contents/Resources'

/** Environment entry that carries the resolved app Resources directory to the launcher. */
const APP_RESOURCES_ENV = 'ZCODE_PLUGIN_APP_RESOURCES'

/** App-relative paths the provider refuses to start without. */
const CLI_BUNDLE_RELATIVE = ['glm', 'zcode.cjs']
const BUILTIN_CONFIG_RELATIVE = ['config', 'provider', 'zcode-builtin.json']

/** `--mode` values accepted by ZCode CLI 0.17.0 (`--help`). */
const MODES = Object.freeze(['build', 'edit', 'plan', 'yolo', 'guarded'])

/** POSIX grace between subprocess termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Node's maximum timer delay; a bigger grace would be silently clamped. */
const MAX_TIMER_DELAY_MS = 2147483647

/** The seam's bounded-diagnostic limit for SubagentResult.diagnostic. */
const DIAGNOSTIC_LIMIT_BYTES = 4096

/** Per-stream in-memory cap; the CLI's stdout is a result, not a transcript. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/**
 * ZCode takes the prompt as an argv element (`-p <task>`), so an enormous task
 * would hit the OS argv ceiling and surface as an opaque spawn failure. Refuse
 * it early with an actionable message instead.
 */
const MAX_PROMPT_BYTES = 256 * 1024

/**
 * Out-of-process children cannot honour parent-enforced start features
 * (agent options / preset / output schema / delegation-depth cap), so the
 * service rejects a request needing any of them rather than accepting and
 * silently ignoring it.
 */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/** Trim a string to a UTF-8 byte budget (a replacement char may end it). */
function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`
}

/** Assert a configured timing bound is a positive finite number of milliseconds. */
function assertPositiveFinite(prefix, field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: config.${field} must be a positive finite number of milliseconds, got ${String(value)}`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${prefix}: config.${field} must be no greater than ${MAX_TIMER_DELAY_MS} (Node's maximum timer delay), got ${String(value)}`)
  }
}

/** Reject `cwd` unless it is an absolute path to an existing directory. */
function requireUsableCwd(prefix, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error(`${prefix}: the delegating session has no working directory for the ZCode child`)
  }
  if (!cwd.startsWith('/')) {
    throw new Error(`${prefix}: the ZCode child working directory must be absolute, got ${JSON.stringify(cwd)}`)
  }
  let stats
  try {
    stats = statSync(cwd)
  }
  catch (error) {
    throw new Error(`${prefix}: the ZCode child working directory is not usable: ${String(error?.message ?? error)}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`${prefix}: the ZCode child working directory is not a directory: ${cwd}`)
  }
  return cwd
}

/** Flatten the delegated prompt's text blocks into one task string. */
function promptText(prompt) {
  const parts = []
  for (const block of prompt ?? []) {
    if (block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/** Buffer one child stream with a byte cap, keeping the head. */
function collectStream(stream) {
  const chunks = []
  let size = 0
  let truncated = false
  if (stream !== undefined && stream !== null && typeof stream.on === 'function') {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      if (size >= STREAM_CAP_BYTES) {
        truncated = true
        return
      }
      const room = STREAM_CAP_BYTES - size
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
      chunks.push(slice)
      size += slice.length
      if (slice.length < buffer.length) truncated = true
    })
    stream.on('error', () => {})
  }
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated,
  }
}

/**
 * Read ZCode's `--json` result envelope:
 *
 *   {"sessionId":"sess_…","traceId":"…","turnId":"turn_…",
 *    "response":"…","usage":{…},"projection":{…}}
 *
 * Strict on meaning (the run is NOT considered complete without a non-blank
 * `response`), tolerant on framing: a leading log line before the JSON object
 * is skipped, because the CLI still labels its stdout as machine-readable
 * while warning text is expected on stderr.
 * @param raw - the child's full stdout.
 * @returns the response text when present, the CLI-reported error when present,
 *   and the parsed object for callers that need it.
 */
function parseEnvelope(raw) {
  const text = raw.trim()
  if (text.length === 0) return { response: undefined, error: undefined, value: undefined }
  let value
  try {
    value = JSON.parse(text)
  }
  catch {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first === -1 || last <= first) return { response: undefined, error: undefined, value: undefined }
    try {
      value = JSON.parse(text.slice(first, last + 1))
    }
    catch {
      return { response: undefined, error: undefined, value: undefined }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { response: undefined, error: undefined, value: undefined }
  }
  const response = typeof value.response === 'string' ? value.response : undefined
  const error = typeof value.error === 'string' && value.error.length > 0 ? value.error : undefined
  return { response, error, value }
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`${PLUGIN}: aborted`))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Settle an out-of-process run under the seam contract: the returned promise
 * never rejects after publication, local cancellation wins over an observed
 * outcome, and any failure is flattened to `stopReason: 'error'` carrying a
 * bounded provider-authored diagnostic. The request's abort listener is removed
 * on every path.
 */
function settleRunResult(parts) {
  return Promise.resolve()
    .then(() => parts.attempt())
    .then(
      (result) => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
        return result
      },
      (error) => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
        const failure = error instanceof Error ? error : new Error(String(error))
        try {
          parts.onError?.(failure, 'error')
        }
        catch {}
        const detail = truncateBytes(parts.collectDiagnostic?.() ?? failure.message, DIAGNOSTIC_LIMIT_BYTES)
        const result = { output: parts.collectOutput(), stopReason: 'error' }
        if (detail.length > 0) result.diagnostic = detail
        return result
      },
    )
}

/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent through one memoized teardown: it detaches the abort listener,
 * settles local cancellation without assuming the child cooperates, then awaits
 * the backend's teardown to actual exit.
 */
function subprocessRunHandle(parts) {
  let disposal
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose() {
      disposal ??= (async () => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        parts.requestCancel()
        await parts.teardown()
      })()
      return disposal
    },
  }
}

/** Tear the child down through the seam's termination ladder to actual exit. */
async function disposeZcodeChild(child) {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  }
  catch {}
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Build the child argv for one one-shot ZCode run.
 *
 * The prompt is a single argv element taken by `-p`; every other flag is
 * emitted around it. `--mode` is omitted entirely when unset so the CLI keeps
 * its documented default (`yolo` for `--prompt`). Exported so the package's
 * smoke test exercises exactly the argv the provider spawns, without loading DSH.
 * @param config - resolved provider config (`mode`, `extraArgs`).
 * @param task - the joined prompt text.
 * @param cwd - the absolute child working directory.
 * @returns the complete argv, `argv[0]` being the current Node executable.
 */
export function buildZcodeArgv(config, task, cwd) {
  const argv = [
    process.execPath,
    LAUNCHER_PATH,
    '-p',
    task,
    '--json',
    '--cwd',
    cwd,
  ]
  if (config.mode !== undefined) {
    argv.push('--mode', config.mode)
  }
  for (const arg of config.extraArgs) {
    argv.push(arg)
  }
  return argv
}

/**
 * Build the child environment for one ZCode run: the operator's explicit env
 * entries plus the resolved app Resources path the launcher consumes.
 *
 * Electron note: when this plugin runs inside the Electron main process,
 * `process.execPath` is the Electron binary and a spawned JS entry only behaves
 * like Node with `ELECTRON_RUN_AS_NODE=1`. The harness normally sets that
 * itself; restating it for the child keeps the launcher spawnable either way
 * (a real Node binary ignores the variable).
 * Exported for the package's smoke test.
 * @param config - resolved provider config (`env`, `appPath`).
 * @returns the environment entries to layer over the seam's scrubbed base.
 */
export function buildZcodeEnv(config) {
  const env = { ...config.env, [APP_RESOURCES_ENV]: config.appPath }
  if (process.versions.electron !== undefined && env.ELECTRON_RUN_AS_NODE === undefined) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  return env
}

/**
 * Start the launcher child and publish its one-shot run.
 * @param request - the resolved subagent start request.
 * @param spec - plugin context, resolved config, and the validated child directory.
 * @returns the published run handle.
 */
async function startZcodeRun(request, spec) {
  const task = promptText(request.prompt)
  if (task.trim().length === 0) {
    throw new Error(`${PLUGIN}: the delegated prompt carries no text`)
  }
  const taskBytes = Buffer.byteLength(task, 'utf8')
  if (taskBytes > MAX_PROMPT_BYTES) {
    throw new Error(`${PLUGIN}: prompt is ${taskBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling — delegate a shorter task`)
  }
  if (request.signal.aborted) throw new Error(`${PLUGIN}: request was aborted before startup`)

  const argv = buildZcodeArgv(spec.config, task, spec.cwd)
  let child
  try {
    child = spec.ctx.subprocess.spawn({
      argv,
      cwd: spec.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.config.disposeGraceMs,
      env: buildZcodeEnv(spec.config),
    })
  }
  catch (error) {
    // Nothing was published, so the caller still owns the failure: reject with
    // the spawn diagnostic instead of returning a dead run handle.
    throw new Error(`${PLUGIN}: could not start the ZCode CLI launcher: ${String(error?.message ?? error)}`)
  }

  const stdout = collectStream(child.stdout)
  const stderr = collectStream(child.stderr)
  // A rejected `done` that loses the race below must not surface as an
  // unhandled rejection; the race and teardown both observe it.
  child.done.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error(`${PLUGIN}: run cancelled locally`))
    try {
      child.terminate()
    }
    catch {}
  }
  const onAbort = () => requestCancel()
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = () => {
    const { response } = parseEnvelope(stdout.text())
    return typeof response === 'string' && response.trim().length > 0
      ? [{ type: 'text', text: response }]
      : []
  }

  const attempt = async () => {
    if (runAbort.signal.aborted) throw new Error(`${PLUGIN}: run cancelled before the child settled`)
    const outcome = await Promise.race([child.done, abortPromise(runAbort.signal)])
    if (runAbort.signal.aborted) throw new Error(`${PLUGIN}: run cancelled before the child settled`)
    const { response, error } = parseEnvelope(stdout.text())
    if (error !== undefined) throw new Error(`${PLUGIN}: ${error}`)
    if (outcome.exitCode !== 0) {
      throw new Error(`${PLUGIN}: ZCode CLI exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`)
    }
    if (response === undefined) {
      throw new Error(`${PLUGIN}: ZCode CLI completed without a JSON response object on stdout`)
    }
    if (response.trim().length === 0) {
      throw new Error(`${PLUGIN}: ZCode CLI returned an empty response`)
    }
    return { output: [{ type: 'text', text: response }], stopReason: 'completed' }
  }

  const result = settleRunResult({
    attempt,
    collectOutput,
    // Prefer the CLI's own error text; fall back to the child's stderr tail
    // (which may legitimately carry benign warnings on the success path, but
    // is only consulted here after a failure).
    collectDiagnostic: () => {
      const { error } = parseEnvelope(stdout.text())
      if (error !== undefined) return error
      const tail = stderr.text().trim()
      return tail.length > 0 ? tail : undefined
    },
    cancelled: () => runAbort.signal.aborted,
    onError: (failure, stopReason) => {
      try {
        spec.ctx.logger?.warn?.(`${PLUGIN}: child run failed (${stopReason}): ${failure.message}`)
      }
      catch {}
    },
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: randomUUID(),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeZcodeChild(child),
  })
}

/** One publisher of a named `zcode` child, running the ZCode CLI once. */
class ZcodeProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  name = 'zcode'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  async start(request) {
    // The service resolves `cwd` before start for external providers; keep the
    // parent's session cwd as the documented fallback for direct callers.
    const fallback = request.parent?.session?.header?.cwd
    const candidate = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : fallback
    return startZcodeRun(request, {
      ctx: this.ctx,
      config: this.config,
      cwd: requireUsableCwd(PLUGIN, candidate),
    })
  }
}

/**
 * Validate and resolve the raw row config.
 * @param config - the config object the bundle row passed to `apply`.
 * @returns the normalized provider config.
 */
function resolveConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${PLUGIN}: config must be an object`)
  }
  const appPath = config.appPath ?? DEFAULT_APP_RESOURCES
  if (typeof appPath !== 'string' || appPath.trim().length === 0) {
    throw new Error(`${PLUGIN}: config.appPath must be a non-empty string`)
  }
  if (!appPath.trim().startsWith('/')) {
    throw new Error(`${PLUGIN}: config.appPath must be an absolute path, got ${JSON.stringify(appPath)}`)
  }
  const mode = config.mode
  if (mode !== undefined && !MODES.includes(mode)) {
    throw new Error(`${PLUGIN}: config.mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(mode)}`)
  }
  const model = config.model
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new Error(`${PLUGIN}: config.model must be a non-empty string when set`)
  }
  const extraArgs = config.extraArgs ?? []
  if (!Array.isArray(extraArgs)) {
    throw new Error(`${PLUGIN}: config.extraArgs must be an array of strings`)
  }
  for (const arg of extraArgs) {
    if (typeof arg !== 'string') {
      throw new Error(`${PLUGIN}: config.extraArgs must contain only strings, got ${JSON.stringify(arg)}`)
    }
  }
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  assertPositiveFinite(PLUGIN, 'disposeGraceMs', disposeGraceMs)
  const rawEnv = config.env ?? {}
  if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    throw new Error(`${PLUGIN}: config.env must be an object of string values`)
  }
  const env = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') {
      throw new Error(`${PLUGIN}: config.env.${key} must be a string`)
    }
    env[key] = value
  }
  return { appPath: appPath.trim(), mode, model, extraArgs: [...extraArgs], disposeGraceMs, env }
}

/**
 * Fail at mount time — not at the first delegation — when the plugin or the
 * ZCode app it drives is not where the config says it is.
 * @param prefix - diagnostic prefix.
 * @param config - resolved provider config.
 */
function assertRuntimeAvailable(prefix, config) {
  if (!existsSync(LAUNCHER_PATH)) {
    throw new Error(`${prefix}: the bundled launcher is missing at ${LAUNCHER_PATH}`)
  }
  const bundle = join(config.appPath, ...CLI_BUNDLE_RELATIVE)
  if (!existsSync(bundle)) {
    throw new Error(`${prefix}: ZCode CLI bundle not found at ${bundle} — install ZCode.app or set config.appPath to its Contents/Resources directory`)
  }
  const builtin = join(config.appPath, ...BUILTIN_CONFIG_RELATIVE)
  if (!existsSync(builtin)) {
    throw new Error(`${prefix}: ZCode built-in provider config not found at ${builtin} — the installed ZCode.app looks incomplete; reinstall it or set config.appPath`)
  }
}

/**
 * Register the `zcode` provider.
 * @param ctx - context carrying the shared subagent registry and subprocess seam.
 * @param config - optional `appPath`, `mode`, `model`, `extraArgs`,
 *   `disposeGraceMs`, and `env` row config.
 */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object' || ctx.subagents === undefined) {
    throw new Error(`${PLUGIN}: apply requires the subagents seam (inject: ['subagents', 'subprocess'])`)
  }
  if (ctx.subprocess === undefined) {
    throw new Error(`${PLUGIN}: apply requires the subprocess seam (inject: ['subagents', 'subprocess'])`)
  }
  const resolved = resolveConfig(config)
  assertRuntimeAvailable(PLUGIN, resolved)
  if (resolved.model !== undefined) {
    try {
      ctx.logger?.warn?.(`${PLUGIN}: config.model is not supported by the ZCode CLI and is ignored; pass a model flag through config.extraArgs instead`)
    }
    catch {}
  }
  ctx.subagents.registerProvider(new ZcodeProvider(ctx, resolved))
}
