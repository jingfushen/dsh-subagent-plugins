/**
 * One-shot `kimi` (Kimi Code CLI) subagent provider for the delegation seam.
 *
 * Modelled on @deepseek-ai/dsh-subagent-codex and on the local self-contained
 * `agy` provider: an OUT-OF-PROCESS one-shot provider that advertises NO
 * start-time capabilities and publishes through the seam's run-handle / result
 * contract. Kimi Code exposes a documented non-interactive prompt mode, so this
 * adapter owns argv construction and the plain-text result envelope instead of
 * a wire protocol.
 *
 * ── verified CLI facts (Kimi Code CLI 2.3.1) ────────────────────────────────
 * `kimi --help` documents:
 *
 *   -p, --prompt <prompt>      Run one prompt non-interactively and print the
 *                              response.
 *   --output-format <format>   Prompt-mode output; choices "text" | "stream-json",
 *                              defaults to text.
 *   -y, --yolo                 Ask When Needed: routine edits run automatically.
 *   --auto                     Never Ask: everything runs and is decided automatically.
 *   --plan                     Start in plan mode.
 *   -m, --model <model>        Model alias for this invocation.
 *   --add-dir <dir>            Extra workspace directory (repeatable).
 *   --skills-dir <dir>, --agent <name> also exist.
 *
 * One-shot shape used here: `kimi -p <task> --output-format text`. stdout is the
 * response text (trimmed before it becomes the child's answer), stderr carries
 * the startup banner and diagnostics, and a non-zero exit (or empty stdout) is a
 * failed run. The prompt never passes through a shell: the seam spawns an argv
 * array.
 *
 * ── why the seam helpers are re-implemented ─────────────────────────────────
 * This bundle is linked straight from the workspace, so it stays self-contained
 * (`node:` builtins only; no bare package specifiers). It therefore re-states the
 * two seam contracts it needs — `settleRunResult` and `subprocessRunHandle` —
 * against their documented behaviour rather than importing them.
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'

export const name = 'subagent-kimicode'
export const inject = ['subagents', 'subprocess']

/** Kimi Code's installed bin name; the package is @moonshot-ai/kimi-code. */
const DEFAULT_COMMAND = 'kimi'

/** Prompt-mode envelope: plain text keeps stdout a result, not a transcript. */
const DEFAULT_OUTPUT_ARGS = ['--output-format', 'text']

/** `ask` emits no flag and leaves Kimi Code's own approval policy in force. */
const DEFAULT_PERMISSION_MODE = 'ask'

/** Native non-interactive modes; `ask` is the CLI default and emits no flag. */
const PERMISSION_MODE_ARGS = Object.freeze({
  ask: [],
  yolo: ['-y'],
  auto: ['--auto'],
  plan: ['--plan'],
})

const PERMISSION_MODES = Object.freeze(Object.keys(PERMISSION_MODE_ARGS))

/** POSIX grace between subprocess termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Node's upper bound for a single timer, mirrored from @deepseek-ai/dsh-timeout. */
const MAX_TIMER_DELAY_MS = 2147483647

/** The seam's bounded-diagnostic limit for SubagentResult.diagnostic. */
const DIAGNOSTIC_LIMIT_BYTES = 4096

/** Per-stream in-memory cap; the CLI's stdout is a result, not a transcript. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/**
 * The prompt is one argv element, so an enormous task would hit the OS argv
 * ceiling and surface as an opaque spawn failure. Refuse it early with an
 * actionable message instead.
 */
const MAX_PROMPT_BYTES = 256 * 1024

/**
 * Out-of-process children cannot honour parent-enforced start features, so the
 * service rejects a request needing any of them rather than accepting and
 * silently ignoring it. These are exactly the four capabilities the seam
 * validates for version 0.2.1-rc.3.
 */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/**
 * Prepended to a bounded diagnostic when the CLI reports its unauthenticated
 * "No model configured" failure, which is the exact string a fresh install
 * prints before `kimi login`.
 */
const LOGIN_HINT = 'kimi is not signed in or has no default model — run `kimi login` (device-code flow) or set default_model in the Kimi Code config'

/** Trim a string to a UTF-8 byte budget, guaranteeing the result fits. */
function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  const marker = '…'
  const room = maxBytes - Buffer.byteLength(marker, 'utf8')
  let head = buffer.subarray(0, Math.max(0, room)).toString('utf8')
  while (Buffer.byteLength(head, 'utf8') > room) head = head.slice(0, -1)
  return `${head}${marker}`
}

/** Reject `cwd` unless it is an absolute path to an existing directory. */
function requireUsableCwd(prefix, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error(`${prefix}: the delegating session has no working directory`)
  }
  if (!cwd.startsWith('/')) {
    throw new Error(`${prefix}: child working directory must be absolute, got ${JSON.stringify(cwd)}`)
  }
  let stats
  try {
    stats = statSync(cwd)
  }
  catch (error) {
    throw new Error(`${prefix}: child working directory is not usable: ${String(error?.message ?? error)}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`${prefix}: child working directory is not a directory: ${cwd}`)
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

/** Drop the unconditional `kimi version <x.y.z>` banner prompt mode prints first. */
function stripVersionBanner(text) {
  return text.replace(/^kimi version \S+\r?\n?/, '')
}

/**
 * Build the bounded, provider-authored diagnostic for a failed run. The Kimi
 * Code CLI reports failures on stderr (its stdout stays empty), so the stderr
 * tail is the actionable text; the unauthenticated case additionally gets the
 * login hint the raw text only implies.
 * @param outcome - the child's exit outcome, when it settled.
 * @param stderrText - everything the child wrote to stderr.
 * @returns the bounded diagnostic, or `undefined` when nothing was reported.
 */
function failureDiagnostic(outcome, stderrText) {
  const tail = stripVersionBanner(stderrText).trim()
  if (tail.length === 0) {
    // No provider text to report: let the settle helper fall back to the
    // actionable failure message (spawn failure, empty answer, …) instead.
    if (outcome === undefined || outcome.exitCode === 0) return undefined
    return `kimi exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`
  }
  const bounded = truncateBytes(tail, DIAGNOSTIC_LIMIT_BYTES)
  if (/no model configured/i.test(tail)) {
    return truncateBytes(`${LOGIN_HINT}\n${bounded}`, DIAGNOSTIC_LIMIT_BYTES)
  }
  return bounded
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('subagent-kimicode: aborted'))
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
async function disposeKimicodeChild(child) {
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
 * Build the one-shot argv array for one delegated task.
 * @param config - resolved plugin config.
 * @param task - the joined prompt text.
 * @returns the argv array handed to the subprocess seam.
 */
function buildArgv(config, task) {
  const argv = [config.command, '-p', task, ...DEFAULT_OUTPUT_ARGS]
  if (config.model !== undefined) argv.push('--model', config.model)
  argv.push(...PERMISSION_MODE_ARGS[config.permissionMode])
  argv.push(...config.extraArgs)
  return argv
}

/**
 * Start the `kimi` child and publish its one-shot run.
 * @param request - the resolved subagent start request.
 * @param spec - plugin context, resolved config, and the validated child directory.
 * @returns the published run handle.
 */
async function startKimicodeRun(request, spec) {
  const task = promptText(request.prompt)
  if (task.trim().length === 0) throw new Error('subagent-kimicode: the delegated prompt carries no text')
  const taskBytes = Buffer.byteLength(task, 'utf8')
  if (taskBytes > MAX_PROMPT_BYTES) {
    throw new Error(`subagent-kimicode: prompt is ${taskBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling — delegate a shorter task`)
  }
  if (request.signal.aborted) throw new Error('subagent-kimicode: request was aborted before startup')

  const child = spec.ctx.subprocess.spawn({
    argv: buildArgv(spec.config, task),
    cwd: spec.cwd,
    // The CLI's one-shot prompt arrives as an argv value, so stdin is unused.
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.config.disposeGraceMs,
    // Explicit (empty) environment overlay: Kimi Code reads its login and model
    // configuration from its own on-disk config, so no ambient override is
    // needed, and the seam still layers this over its credential-scrubbed parent
    // environment.
    env: {},
  })

  const stdout = collectStream(child.stdout)
  const stderr = collectStream(child.stderr)

  /** The child's exit outcome once it settles; `undefined` before then. */
  let outcome
  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-kimicode: run cancelled locally'))
    try {
      child.terminate()
    }
    catch {}
  }
  const onAbort = () => requestCancel()
  request.signal.addEventListener('abort', onAbort, { once: true })

  const answerText = () => stdout.text().trim()
  const collectOutput = () => {
    const answer = answerText()
    return answer.length > 0 ? [{ type: 'text', text: answer }] : []
  }

  const attempt = async () => {
    if (runAbort.signal.aborted) throw new Error('subagent-kimicode: run cancelled before the child settled')
    outcome = await Promise.race([child.done, abortPromise(runAbort.signal)])
    if (runAbort.signal.aborted) throw new Error('subagent-kimicode: run cancelled before the child settled')
    if (outcome.exitCode !== 0) {
      throw new Error(`subagent-kimicode: kimi exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`)
    }
    const answer = answerText()
    if (answer.length === 0) throw new Error('subagent-kimicode: kimi completed without printing a response')
    return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
  }

  const result = settleRunResult({
    attempt,
    collectOutput,
    collectDiagnostic: () => failureDiagnostic(outcome, stderr.text()),
    cancelled: () => runAbort.signal.aborted,
    onError: (failure, stopReason) => {
      try {
        spec.ctx.logger?.warn?.(`subagent-kimicode: child run failed (${stopReason}): ${failure.message}`)
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
    teardown: () => disposeKimicodeChild(child),
  })
}

/** One publisher of a named `kimi` child, running the CLI's prompt mode once. */
class KimicodeProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  name = 'kimicode'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  async start(request) {
    // The 0.2.1-rc.3 seam resolves an absolute cwd before start; the parent
    // fallback keeps the adapter usable against older seam revisions too.
    const explicitCwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : undefined
    const inheritedCwd = request.parent?.session?.header?.cwd
    const cwd = explicitCwd
      ?? (typeof inheritedCwd === 'string' && inheritedCwd.length > 0 ? inheritedCwd : undefined)
    if (cwd === undefined) {
      throw new Error('subagent-kimicode: no working directory for the child — the resolved request carried none and the parent session has none')
    }
    return startKimicodeRun(request, {
      ctx: this.ctx,
      config: this.config,
      cwd: requireUsableCwd('subagent-kimicode', cwd),
    })
  }
}

/** Resolve and validate the plugin config, rejecting malformed values loudly. */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const command = typeof source.command === 'string' && source.command.length > 0 ? source.command : DEFAULT_COMMAND
  const model = typeof source.model === 'string' && source.model.length > 0 ? source.model : undefined
  const permissionMode = source.permissionMode === undefined ? DEFAULT_PERMISSION_MODE : String(source.permissionMode)
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`subagent-kimicode: permissionMode must be one of ${PERMISSION_MODES.map((mode) => JSON.stringify(mode)).join(', ')}, got ${JSON.stringify(source.permissionMode)}`)
  }
  let extraArgs = []
  if (source.extraArgs !== undefined) {
    if (!Array.isArray(source.extraArgs)) throw new Error('subagent-kimicode: extraArgs must be an array of strings')
    extraArgs = source.extraArgs.map((arg) => String(arg))
  }
  const disposeGraceMs = source.disposeGraceMs === undefined ? DEFAULT_DISPOSE_GRACE_MS : source.disposeGraceMs
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
    throw new Error('subagent-kimicode: disposeGraceMs must be a positive finite number')
  }
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-kimicode: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return { command, model, permissionMode, extraArgs, disposeGraceMs }
}

/**
 * Register the `kimicode` provider.
 * @param ctx - context carrying the shared subagent registry and subprocess seam.
 * @param config - optional `command`, `model`, `permissionMode`, `extraArgs`, and `disposeGraceMs`.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  ctx.subagents.registerProvider(new KimicodeProvider(ctx, resolved))
}
