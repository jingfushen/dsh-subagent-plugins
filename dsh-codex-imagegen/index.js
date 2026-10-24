/**
 * One-shot `codex_imagegen` tool: GPT Image through Codex CLI's built-in
 * imagegen skill.
 *
 * The historical preset bundled this capability as `./imagegen.mjs` inside a
 * local preset package. This file is the standalone plugin equivalent: a
 * Host-only bundle that registers one model-facing tool and spawns the real
 * Codex CLI (`codex exec`) with the built-in `image_gen` tool, keeping the
 * parent Session free of the child's reasoning, tool traffic, and stderr.
 *
 * Deliberately self-contained: a linked workspace bundle imports only `node:`
 * builtins and reaches the shared DSH services through the injected `ctx`
 * (`ctx.tools`, `ctx.subprocess`). No bare package specifier is imported.
 *
 * ── argv shape (verified against codex CLI 0.153.x) ──────────────────────────
 *   codex exec --skip-git-repo-check --ephemeral -C <cwd> -s <sandbox>
 *              --color never --json -o <lastMessageFile>
 *              [-m <model>] [-c model_reasoning_effort="<effort>"]
 *              [-i <ref>]... <task>
 *
 * The final answer is read from the `-o` last-message file (the JSONL event
 * stream is kept only for diagnostics); the tool then accepts only an existing
 * absolute image path, preferring the requested `out` path and falling back to
 * the newest file in `$CODEX_HOME/generated_images`.
 *
 * ── network ──────────────────────────────────────────────────────────────────
 * The subprocess seam starts children from a credential-scrubbed environment.
 * This machine reaches the Codex backend only through the local system proxy,
 * so `proxy` is stated once here and applied to every child
 * (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY, NO_PROXY emptied).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { connect } from 'node:net'

/** This machine's system proxy, confirmed with `scutil --proxy`. */
const GLOBAL_PROXY = 'http://127.0.0.1:12450'

/** Default sandbox for the child Codex run; imagegen writes outside the cwd. */
const DEFAULT_SANDBOX = 'danger-full-access'

/** Wall-clock ceiling for one generation; also declared to the tool timeout policy. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** POSIX grace between subprocess termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Per-stream in-memory cap; the child's stdout/stderr are diagnostics, not output. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/** Bounded provider-authored diagnostic limit. */
const DIAGNOSTIC_LIMIT_BYTES = 4096

/** How long the pre-spawn proxy probe may take before the proxy is called unreachable. */
const PROXY_PROBE_TIMEOUT_MS = 1500

/** Image extensions accepted as the tool's result path. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i

const name = 'codex-imagegen'
const inject = ['tools', 'subprocess']

const description = 'Generate or edit raster images through Codex CLI\'s built-in imagegen skill (GPT Image). Use when the task needs a bitmap asset: illustration, photo, texture, sprite, mockup, cover, product shot, or an edit/variant of an existing image. Returns the absolute path of the generated image. One call produces one final image; pass reference image paths in `refs` for style/composition guidance.'

/** Trim a string to a UTF-8 byte budget. */
function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`
}

/** Collect a child stream with a byte cap, keeping the head. */
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

/** Read the proxy endpoint out of the configured proxy string. */
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

/** Fail BEFORE spawning when the configured proxy cannot accept a connection. */
function assertProxyReachable(endpoint) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolvePromise()
      else reject(new Error(`codex_imagegen: proxy ${endpoint.url} is not reachable (${error.message}) — start the proxy, or set verifyProxy: false`))
    }
    socket.setTimeout(PROXY_PROBE_TIMEOUT_MS, () => finish(new Error(`no answer within ${PROXY_PROBE_TIMEOUT_MS}ms`)))
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}

/** Resolve the child working directory from the calling Agent's Session. */
function childCwd(exec) {
  const raw = exec?.agent?.session?.header?.cwd
  if (typeof raw === 'string' && isAbsolute(raw)) return raw
  return process.cwd()
}

/** Validate the model-supplied arguments; returns a normalised request. */
function parseArgs(args) {
  const source = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('codex_imagegen: `prompt` must be a non-empty string')
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) throw new Error('codex_imagegen: `prompt` is too long (64 KiB limit)')

  let out
  if (source.out !== undefined) {
    if (typeof source.out !== 'string' || source.out.trim().length === 0 || !isAbsolute(source.out.trim())) {
      throw new Error('codex_imagegen: `out` must be an absolute file path when supplied')
    }
    out = source.out.trim()
  }

  let refs = []
  if (source.refs !== undefined) {
    if (!Array.isArray(source.refs)) throw new Error('codex_imagegen: `refs` must be an array of absolute image paths')
    refs = source.refs.map((value) => {
      if (typeof value !== 'string' || !isAbsolute(value)) {
        throw new Error('codex_imagegen: every `refs` entry must be an absolute path')
      }
      let stats
      try {
        stats = statSync(value)
      }
      catch {
        throw new Error(`codex_imagegen: reference image does not exist: ${value}`)
      }
      if (!stats.isFile()) throw new Error(`codex_imagegen: reference image is not a file: ${value}`)
      return value
    })
  }

  return { prompt, out, refs }
}

/** Build the child Codex task. */
function buildTask(request) {
  const lines = [
    "Use Codex's built-in imagegen skill (the built-in `image_gen` tool, NOT the Python CLI fallback).",
    '',
    `Task: ${request.prompt}`,
  ]
  if (request.refs.length > 0) {
    lines.push('', 'Reference images (use them for style/composition guidance):')
    for (const ref of request.refs) lines.push(`- ${ref}`)
  }
  if (request.out !== undefined) {
    lines.push('', `Save the final image to this exact absolute path: ${request.out}`)
    lines.push('If the built-in tool saves elsewhere (for example $CODEX_HOME/generated_images), copy or move the final file to that path.')
  }
  lines.push(
    '',
    request.out !== undefined
      ? 'Reply with only the absolute saved path.'
      : 'Reply with only the absolute path where the final image file is stored (copy it into the working directory when it makes sense).',
  )
  return lines.join('\n')
}

/** Find an absolute image path in the child's final message. */
function pathFromMessage(text) {
  const matches = text.match(/(?:^|[\s("'`])((?:\/[^\s"'`()<>]+?\.(?:png|jpg|jpeg|webp|gif)))(?=$|[\s)"'`.,;:])/gim)
  if (matches === null) return undefined
  for (const match of matches) {
    const candidate = match.trim().replace(/^[("'`]+/, '').replace(/["'`).,;:]+$/, '')
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Newest image under $CODEX_HOME/generated_images not older than `since`. */
function newestGeneratedImage(since) {
  const codexHome = process.env.CODEX_HOME !== undefined && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex')
  const directory = join(codexHome, 'generated_images')
  let entries
  try {
    entries = readdirSync(directory)
  }
  catch {
    return undefined
  }
  let best
  for (const entry of entries) {
    if (!IMAGE_EXTENSIONS.test(entry)) continue
    const full = join(directory, entry)
    let stats
    try {
      stats = statSync(full)
    }
    catch {
      continue
    }
    if (!stats.isFile() || stats.mtimeMs < since) continue
    if (best === undefined || stats.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stats.mtimeMs }
  }
  return best?.path
}

/** Terminate a child through the shared managed-range owner and await exit. */
async function disposeChild(child) {
  if (child === undefined) return
  try {
    child.stdin?.end()
  }
  catch {}
  try {
    child.terminate()
  }
  catch {}
  try {
    await child.waitForExit()
  }
  catch {}
  await child.done.catch(() => {})
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('codex_imagegen: aborted'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run one generation and return its canonical `{ path }` value. */
async function runGeneration(request, exec, config) {
  const endpoint = proxyEndpoint(config.proxy)
  if (endpoint !== undefined && config.verifyProxy) await assertProxyReachable(endpoint)
  if (exec.signal.aborted) throw new Error('codex_imagegen: call was aborted before startup')

  const cwd = childCwd(exec)
  const lastMessageFile = join(tmpdir(), `dsh-codex-imagegen-${randomUUID()}.txt`)
  const startedAt = Date.now() - 5000
  const argv = [
    config.command,
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    cwd,
    '-s',
    config.sandbox,
    '--color',
    'never',
    '--json',
    '-o',
    lastMessageFile,
  ]
  if (config.model !== undefined) argv.push('-m', config.model)
  if (config.reasoningEffort !== undefined) argv.push('-c', `model_reasoning_effort="${config.reasoningEffort}"`)
  for (const ref of request.refs) argv.push('-i', ref)
  argv.push(buildTask(request))

  const env = {
    ...(config.proxy !== undefined ? {
      HTTP_PROXY: config.proxy,
      HTTPS_PROXY: config.proxy,
      ALL_PROXY: config.proxy,
      NO_PROXY: '',
    } : {}),
    ...config.env,
  }

  let child
  const cleanup = () => {
    try {
      unlinkSync(lastMessageFile)
    }
    catch {}
  }
  try {
    child = config.spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: config.disposeGraceMs, env })
  }
  catch (error) {
    cleanup()
    throw new Error(`codex_imagegen: could not start Codex CLI (${String(error?.message ?? error)})`)
  }

  const stdout = collectStream(child.stdout)
  const stderr = collectStream(child.stderr)
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(new Error(`codex_imagegen: generation exceeded ${config.timeoutMs}ms`)), config.timeoutMs)
  const onCallerAbort = () => {
    try {
      child.terminate()
    }
    catch {}
  }
  exec.signal.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const outcome = await Promise.race([
      child.done,
      abortPromise(timeoutController.signal),
      abortPromise(exec.signal),
    ])
    const lastMessage = (() => {
      try {
        return readFileSync(lastMessageFile, 'utf8').trim()
      }
      catch {
        return ''
      }
    })()
    if (exec.signal.aborted) throw new Error('codex_imagegen: call was aborted')
    if (outcome.exitCode !== 0) {
      const detail = stderr.text().trim() || lastMessage || stdout.text().trim()
      throw new Error(`codex_imagegen: Codex CLI exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}${detail.length > 0 ? `\n${truncateBytes(detail, DIAGNOSTIC_LIMIT_BYTES)}` : ''}`)
    }
    let answer = request.out
    if (answer === undefined || !existsSync(answer)) {
      answer = pathFromMessage(lastMessage) ?? newestGeneratedImage(startedAt)
    }
    if (answer === undefined || !existsSync(answer)) {
      throw new Error(`codex_imagegen: Codex finished without producing an image file${lastMessage.length > 0 ? `\n${truncateBytes(lastMessage, DIAGNOSTIC_LIMIT_BYTES)}` : ''}`)
    }
    return { path: answer, prompt: request.prompt }
  }
  finally {
    clearTimeout(timeout)
    exec.signal.removeEventListener('abort', onCallerAbort)
    await disposeChild(child)
    cleanup()
  }
}

/** Register the `codex_imagegen` tool. */
function apply(ctx, config = {}) {
  const resolved = {
    command: typeof config.command === 'string' && config.command.length > 0 ? config.command : 'codex',
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
    reasoningEffort: typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0 ? config.reasoningEffort : undefined,
    sandbox: typeof config.sandbox === 'string' && config.sandbox.length > 0 ? config.sandbox : DEFAULT_SANDBOX,
    proxy: config.proxy === null ? undefined : typeof config.proxy === 'string' && config.proxy.length > 0 ? config.proxy : GLOBAL_PROXY,
    verifyProxy: config.verifyProxy !== false,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    disposeGraceMs: Number.isFinite(config.disposeGraceMs) && config.disposeGraceMs > 0 ? config.disposeGraceMs : DEFAULT_DISPOSE_GRACE_MS,
    env: config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env) ? { ...config.env } : {},
    spawn: (spec) => ctx.subprocess.spawn(spec),
  }

  ctx.tools.register({
    name: 'codex_imagegen',
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'What to generate or how to edit the reference images. Describe subject, style, composition, and text carefully; include the intended aspect ratio or size in words when it matters.',
        },
        out: {
          type: 'string',
          description: 'Optional absolute path where the final image must be saved (for example /tmp/hero.png). Omit to let Codex keep its generated file and return that path.',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute paths of reference images for style, composition, or editing.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['path', 'prompt'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Generated image: ${value.path}`,
      }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const request = parseArgs(args)
      return runGeneration(request, exec, resolved)
    },
  })
}

export { apply, inject, name }
