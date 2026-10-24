/**
 * One-shot `agy` (Antigravity CLI) subagent provider for the delegation seam.
 *
 * Modelled on @deepseek-ai/dsh-subagent-codex: an OUT-OF-PROCESS one-shot
 * provider that advertises NO start-time capabilities and publishes through the
 * seam's run-handle / result contract. Where Codex is driven over the Codex
 * app-server JSON-RPC protocol, `agy` is driven through its documented
 * non-interactive print mode, so this adapter owns argv construction and the
 * JSON result envelope instead of a wire protocol.
 *
 * ── argv shape (verified against agy 1.4.7, not guessed) ────────────────────
 * `--print` takes the PROMPT as its value: `agy --print` alone exits 2 with
 * "flag needs an argument: -print". agy additionally guards against a following
 * flag being mistaken for the prompt:
 *
 *   $ agy --print --output-format bogus x
 *   Error: --print took "--output-format" as its prompt, so the intended prompt
 *   was left as an argument and ignored. Attach the prompt to the flag
 *   (--print='your prompt') and move --output-format elsewhere
 *
 * So every other flag is emitted BEFORE it and the prompt is attached as
 * `--print=<prompt>`. The prompt never passes through a shell: the seam spawns
 * an argv array, never a command string.
 *
 * ── result envelope (verified against a real authenticated run) ─────────────
 * `agy --output-format json "--print=<task>"` prints one JSON object:
 *
 *   {"conversation_id":"…","status":"SUCCESS","response":"OK,AGY-PLUGIN\n",
 *    "duration_seconds":3.2,"num_turns":1,"usage":{…}}
 *
 * A failed run reports `status` other than `SUCCESS` (or an `error` string)
 * and exits non-zero. Observed on 1.4.7 with a dead proxy: exit 3 and
 * {"status":"ERROR","response":"","error":"failed to construct executor: plan
 * model not specified; you must specify a valid model"} — an account-shaped
 * message for a transport problem, which is why the plugin probes the proxy
 * first. Only `SUCCESS` is treated as an answer; anything else becomes a
 * bounded diagnostic.
 *
 * ── 全局走网络代理 / the global proxy (the reason this plugin exists) ────────
 * This machine reaches the Antigravity backend only through its system proxy
 * 127.0.0.1:12450. The subprocess seam starts children from a SCRUBBED
 * environment, so a child that is not explicitly told otherwise inherits NO
 * proxy at all and the run fails. This file therefore declares the endpoint
 * ONCE as GLOBAL_PROXY below, exposes it as the row's `proxy` config, and
 * forces every child environment onto it: HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
 * = proxy and NO_PROXY='' (emptied so nothing bypasses it). The same declaration
 * is visible in cordis.patch.yml as the one-line `proxy: …` row config.
 *
 * ── why the seam helpers are re-implemented ─────────────────────────────────
 * The bundle is a linked workspace package and is deliberately self-contained:
 * `node:` builtins only, no bare package specifiers. This file therefore
 * re-states the two seam contracts it needs — settleRunResult and
 * subprocessRunHandle — against their documented behaviour instead of importing
 * the @deepseek-ai/dsh-subagent package.
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { connect } from 'node:net'

export const name = 'subagent-antigravity'
export const inject = ['subagents', 'subprocess']

/**
 * 全局走网络代理 — this machine's system proxy. Every `agy` child is forced
 * through this endpoint (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY, NO_PROXY='').
 * It is declared here once and mirrored by the `proxy` row config in
 * cordis.patch.yml; changing the machine's proxy means changing both.
 */
const GLOBAL_PROXY = 'http://127.0.0.1:12450'

/** Envelope selector emitted before `--print`; see the header note on ordering. */
const DEFAULT_OUTPUT_ARGS = ['--output-format', 'json']

/** agy's accepted `--effort` values; anything else is a config error. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/** POSIX grace between subprocess termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** The seam's bounded-diagnostic limit for SubagentResult.diagnostic. */
const DIAGNOSTIC_LIMIT_BYTES = 4096

/** Per-stream in-memory cap; the CLI's stdout is a result, not a transcript. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/**
 * agy takes the prompt as an argv element, so an enormous task would hit the
 * OS argv ceiling and surface as an opaque spawn failure. Refuse it early with
 * an actionable message instead. agy's `--input-format stream-json` would lift
 * this, but that request shape is unverified against a working account.
 */
const MAX_PROMPT_BYTES = 256 * 1024

/** How long the pre-spawn proxy probe may take before it is called unreachable. */
const PROXY_PROBE_TIMEOUT_MS = 1500

/**
 * Out-of-process children cannot honour parent-enforced start features, so the
 * service rejects a request needing any of them rather than accepting and
 * silently ignoring it. This is the seam's exact SubagentCapabilities shape:
 * {agentOptions, agentPreset, outputSchema, depthLimit}.
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

/**
 * Parse the declared proxy into a probe target.
 *
 * The endpoint is resolved from the `proxy` config (default GLOBAL_PROXY), not
 * from a raw environment variable, so there is exactly one declaration. A
 * malformed value fails plugin activation instead of the first delegation.
 * @param prefix - diagnostic prefix.
 * @param raw - the declared proxy URL.
 * @returns the endpoint to probe, with a credential-free display form.
 */
function parseProxyEndpoint(prefix, raw) {
  let url
  try {
    url = new URL(raw)
  }
  catch (error) {
    throw new Error(`${prefix}: proxy ${JSON.stringify(raw)} is not a valid URL: ${String(error?.message ?? error)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${prefix}: proxy ${JSON.stringify(raw)} must be an http:// or https:// endpoint`)
  }
  if (url.hostname === '') {
    throw new Error(`${prefix}: proxy ${JSON.stringify(raw)} has no host`)
  }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${prefix}: proxy ${JSON.stringify(raw)} has no usable port`)
  }
  // Never echo userinfo back into a diagnostic or a log line.
  return { url: raw, host: url.hostname, port, display: `${url.protocol}//${url.host}` }
}

/**
 * Fail BEFORE spawning when the declared proxy cannot accept a connection.
 *
 * agy reports an unreachable proxy with an account-shaped message instead of a
 * transport one — observed on 1.4.7 pointing at a closed port: exit 3,
 * status ERROR, error "failed to construct executor: plan model not specified;
 * you must specify a valid model". Probing here keeps the diagnosis where it
 * belongs ("the proxy is down"), instead of sending the reader to the account.
 * @param prefix - diagnostic prefix.
 * @param endpoint - the proxy to probe.
 * @returns a promise resolving when the proxy accepts a TCP connection.
 */
function assertProxyReachable(prefix, endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(new Error(`${prefix}: proxy ${endpoint.display} is not reachable (${error.message}) — start the proxy, or set verifyProxy: false to start the child anyway`))
    }
    socket.setTimeout(PROXY_PROBE_TIMEOUT_MS, () => finish(new Error(`no answer within ${PROXY_PROBE_TIMEOUT_MS}ms`)))
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
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
 * Read agy's `--output-format json` envelope:
 *
 *   {"conversation_id":"","status":"SUCCESS","response":"OK,AGY-PLUGIN\n",
 *    "duration_seconds":0,"num_turns":0,"usage":{…}}
 *
 * `status` must be SUCCESS and `error` must be absent for an answer. Any other
 * status (or a reported error) is a failure carrying the product's own message.
 * Deliberately tolerant only on shape: an unparseable or non-object body falls
 * back to raw stdout as the answer, so a future agy build that changes the
 * envelope degrades to "the text agy printed" instead of failing outright.
 * @param raw - the child's full stdout.
 * @returns the answer text and, when the child reported one, its error.
 */
function parseEnvelope(raw) {
  const text = raw.trim()
  if (text.length === 0) return { answer: '', error: undefined }
  let value
  try {
    value = JSON.parse(text)
  }
  catch {
    return { answer: text, error: undefined }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { answer: text, error: undefined }
  }
  const reported = typeof value.error === 'string' && value.error.length > 0 ? value.error : undefined
  if (reported !== undefined) return { answer: '', error: reported }
  const status = typeof value.status === 'string' ? value.status : ''
  if (status.toUpperCase() !== 'SUCCESS') {
    return { answer: '', error: `antigravity reported status ${JSON.stringify(status)}` }
  }
  const response = typeof value.response === 'string' ? value.response : ''
  return { answer: response, error: undefined }
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('subagent-antigravity: aborted'))
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
async function disposeAntigravityChild(child) {
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
 * Build the child argv. The prompt MUST stay attached to `--print` and last:
 * agy otherwise mistakes the next flag for the prompt and drops the task (see
 * the header note on argv shape).
 * @param config - resolved provider config.
 * @param task - the flattened delegated prompt.
 * @returns the argv array handed to the subprocess seam.
 */
function buildArgv(config, task) {
  const argv = [config.command, ...DEFAULT_OUTPUT_ARGS]
  if (config.model !== undefined) argv.push('--model', config.model)
  if (config.effort !== undefined) argv.push('--effort', config.effort)
  if (config.dangerouslySkipPermissions) argv.push('--dangerously-skip-permissions')
  argv.push(...config.extraArgs)
  argv.push(`--print=${task}`)
  return argv
}

/**
 * Start the `agy` child and publish its one-shot run.
 * @param request - the resolved subagent start request (absolute request.cwd).
 * @param spec - plugin context, resolved config, and the validated child directory.
 * @returns the published run handle.
 */
async function startAntigravityRun(request, spec) {
  const task = promptText(request.prompt)
  if (task.length === 0) throw new Error('subagent-antigravity: the delegated prompt carries no text')
  const taskBytes = Buffer.byteLength(task, 'utf8')
  if (taskBytes > MAX_PROMPT_BYTES) {
    throw new Error(`subagent-antigravity: prompt is ${taskBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling — delegate a shorter task`)
  }
  if (request.signal.aborted) throw new Error('subagent-antigravity: request was aborted before startup')

  // Probe before spawning so an unreachable global proxy is reported as itself
  // rather than as agy's misleading eligibility failure.
  if (spec.config.verifyProxy) {
    await assertProxyReachable('subagent-antigravity', spec.config.proxyEndpoint)
    if (request.signal.aborted) throw new Error('subagent-antigravity: request was aborted before startup')
  }

  const child = spec.ctx.subprocess.spawn({
    argv: buildArgv(spec.config, task),
    cwd: spec.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.config.disposeGraceMs,
    env: spec.config.env,
  })

  const stdout = collectStream(child.stdout)
  const stderr = collectStream(child.stderr)

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-antigravity: run cancelled locally'))
    try {
      child.terminate()
    }
    catch {}
  }
  const onAbort = () => requestCancel()
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = () => {
    const { answer } = parseEnvelope(stdout.text())
    return answer.length > 0 ? [{ type: 'text', text: answer }] : []
  }

  const attempt = async () => {
    if (runAbort.signal.aborted) throw new Error('subagent-antigravity: run cancelled before the child settled')
    const outcome = await Promise.race([child.done, abortPromise(runAbort.signal)])
    if (runAbort.signal.aborted) throw new Error('subagent-antigravity: run cancelled before the child settled')
    const { answer, error } = parseEnvelope(stdout.text())
    if (error !== undefined) throw new Error(`subagent-antigravity: ${error}`)
    if (outcome.exitCode !== 0) {
      throw new Error(`subagent-antigravity: agy exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`)
    }
    // A successful envelope with no nonblank answer is a failure, not an
    // empty-but-successful delegation (a bare "\n" is not an answer).
    if (answer.trim().length === 0) throw new Error('subagent-antigravity: agy completed without a final answer')
    return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
  }

  const result = settleRunResult({
    attempt,
    collectOutput,
    // Prefer agy's own error text (its message is the actionable one); fall
    // back to the child's stderr tail.
    collectDiagnostic: () => {
      const { error } = parseEnvelope(stdout.text())
      if (error !== undefined) return error
      const tail = stderr.text().trim()
      return tail.length > 0 ? tail : undefined
    },
    cancelled: () => runAbort.signal.aborted,
    onError: (failure, stopReason) => {
      try {
        spec.ctx.logger?.warn?.(`subagent-antigravity: child run failed (${stopReason}): ${failure.message}`)
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
    teardown: () => disposeAntigravityChild(child),
  })
}

/** One publisher of a named `agy` child, running agy's print mode once. */
class AntigravityProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  name = 'antigravity'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  async start(request) {
    // The seam resolves the child directory; fall back to the parent session's
    // cwd only for a caller that somehow bypassed resolution.
    const cwd = typeof request.cwd === 'string' && request.cwd.length > 0
      ? request.cwd
      : request.parent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('subagent-antigravity: no working directory for the child — delegate from a parent session that has one')
    }
    return startAntigravityRun(request, {
      ctx: this.ctx,
      config: this.config,
      cwd: requireUsableCwd('subagent-antigravity', cwd),
    })
  }
}

/**
 * Register the `antigravity` provider, forcing every child through the declared
 * global proxy.
 * @param ctx - context carrying the shared subagent registry and subprocess seam.
 * @param config - optional `command`, `model`, `effort`,
 *   `dangerouslySkipPermissions`, `extraArgs`, `env`, `proxy`,
 *   `disposeGraceMs`, and `verifyProxy`.
 */
export function apply(ctx, config = {}) {
  const proxy = typeof config.proxy === 'string' && config.proxy.length > 0 ? config.proxy : GLOBAL_PROXY
  // Resolve once at activation: a malformed proxy fails the mount loudly.
  const proxyEndpoint = parseProxyEndpoint('subagent-antigravity', proxy)

  let effort
  if (config.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(config.effort)) {
      throw new Error(`subagent-antigravity: effort must be one of ${EFFORT_LEVELS.join('|')}, got ${JSON.stringify(config.effort)}`)
    }
    effort = config.effort
  }

  const envOverlay = config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env)
    ? config.env
    : {}

  const resolved = {
    command: typeof config.command === 'string' && config.command.length > 0 ? config.command : 'agy',
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
    effort,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions === true,
    extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : [],
    // The overlay comes first and the proxy next, so no env entry can drop or
    // redirect the forced proxy. NO_PROXY is emptied so nothing bypasses it.
    env: {
      ...envOverlay,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      NO_PROXY: '',
    },
    proxy,
    proxyEndpoint,
    disposeGraceMs: Number.isFinite(config.disposeGraceMs) ? config.disposeGraceMs : DEFAULT_DISPOSE_GRACE_MS,
    // Probe the declared proxy before every spawn unless explicitly disabled.
    verifyProxy: config.verifyProxy !== false,
  }
  ctx.subagents.registerProvider(new AntigravityProvider(ctx, resolved))
}
