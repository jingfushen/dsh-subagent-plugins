#!/usr/bin/env node
/**
 * ZCode CLI launcher for the @local/dsh-subagent-zcode provider bundle.
 *
 * The ZCode desktop app carries a plain CommonJS CLI bundle at
 * `<App>.app/Contents/Resources/glm/zcode.cjs`. Running that file directly is
 * not enough: the CLI resolves its BUILT-IN provider catalogue from
 * `dirname(realpath(process.argv[1]))` and looks for
 *
 *     <entrypoint dir>/provider/zcode-builtin.json
 *     <entrypoint dir>/../../../../../config/provider/zcode-builtin.json
 *
 * i.e. the layout of the app's own bundled entry script, not of `glm/`. This
 * launcher bridges that gap without touching the app bundle or the installed
 * plugin package at runtime:
 *
 *   1. create (or reuse) a stable per-user temp directory, e.g.
 *      `$TMPDIR/dsh-zcode-cli-<hash>`;
 *   2. expose the app's real provider catalogue there as
 *      `<stable>/provider/zcode-builtin.json` (symlink, copy as fallback);
 *   3. write a marker `<stable>/entry.cjs` (the CLI calls `realpathSync` on
 *      `process.argv[1]`, so that path must exist);
 *   4. rewrite `process.argv[1]` to the marker, then `require()` the real
 *      bundle — so inside the CLI `dirname(argv[1])` is `<stable>`.
 *
 * The app Resources directory is taken from the provider plugin's `appPath`
 * config, passed down as the `ZCODE_PLUGIN_APP_RESOURCES` environment entry,
 * with a standard macOS install as the default. All other argv elements are
 * passed through untouched; the provider supplies
 * `-p <task> --json --cwd <cwd> [--mode <mode>] [...extraArgs]`.
 *
 * Failure policy: any missing bundle / unusable catalogue exits non-zero with
 * a one-line `zcode-cli launcher:` message on stderr, so the provider's
 * diagnostic path can report it instead of an opaque MODULE_NOT_FOUND stack.
 *
 * This file is CommonJS on purpose: the target bundle is CommonJS and is
 * loaded with `require()`.
 */
'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Diagnostic prefix on stderr. */
const LAUNCHER_PREFIX = 'zcode-cli launcher'

/** Standard macOS install location of the app's Resources directory. */
const DEFAULT_APP_RESOURCES = '/Applications/ZCode.app/Contents/Resources'

/** Environment entry through which the provider passes its `appPath` config. */
const APP_RESOURCES_ENV = 'ZCODE_PLUGIN_APP_RESOURCES'

/** The real CLI bundle, relative to the Resources directory. */
const CLI_BUNDLE_PATH = ['glm', 'zcode.cjs']

/** The built-in provider catalogue the CLI resolves from `dirname(argv[1])`. */
const BUILTIN_CONFIG_PATH = ['config', 'provider', 'zcode-builtin.json']

/** Stable directory name prefix (per user, per app Resources path). */
const STABLE_DIR_PREFIX = 'dsh-zcode-cli-'

/** Marker file whose directory the CLI treats as its entrypoint directory. */
const ENTRY_FILE_NAME = 'entry.cjs'

/**
 * Report a startup problem as one actionable stderr line and exit non-zero.
 * @param {string} message - what is wrong and what to do about it.
 * @returns {never} never returns.
 */
function fail(message) {
  try {
    process.stderr.write(`${LAUNCHER_PREFIX}: ${message}\n`)
  }
  catch {}
  process.exit(2)
}

/**
 * Pick the stable launcher directory for one user + app Resources path.
 * A fixed path (rather than `mkdtemp`) is required: the CLI resolves the
 * provider catalogue relative to `argv[1]` on every run, so the layout must
 * outlive a single process and be reused across runs. `os.tmpdir()` is the
 * per-user private temp directory on macOS.
 * @param {string} resources - app Resources directory (absolute).
 * @returns {string} absolute stable directory path.
 */
function stableDirectory(resources) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid'
  const digest = createHash('sha256')
    .update(`${resources}\0${os.homedir()}\0${uid}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(os.tmpdir(), `${STABLE_DIR_PREFIX}${digest}`)
}

/**
 * Make `<stable>/provider/zcode-builtin.json` resolve to the app's catalogue.
 * A symlink is preferred (the app may refresh the catalogue in place); when
 * the filesystem rejects symlinks a plain copy is written instead.
 * @param {string} link - destination inside the stable directory.
 * @param {string} target - app catalogue path.
 * @param {string} stableDir - stable directory, for diagnostics.
 */
function exposeBuiltinConfig(link, target, stableDir) {
  let expected
  try {
    expected = fs.realpathSync(target)
  }
  catch (error) {
    fail(`cannot read the ZCode built-in provider config ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let current
  try {
    current = fs.realpathSync(link)
  }
  catch {
    current = undefined
  }
  if (current === expected) return
  try {
    fs.rmSync(link, { force: true, recursive: true })
  }
  catch {}
  try {
    fs.symlinkSync(expected, link)
    return
  }
  catch {}
  try {
    fs.copyFileSync(expected, link)
  }
  catch (error) {
    fail(`cannot expose ${expected} in the launcher directory ${stableDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Prepare the stable directory and rewrite argv so the CLI sees the expected
 * entrypoint layout, then hand control to the real bundle.
 */
function main() {
  const configured = (process.env[APP_RESOURCES_ENV] ?? '').trim()
  const resources = configured.length > 0 ? path.resolve(configured) : DEFAULT_APP_RESOURCES
  const bundle = path.join(resources, ...CLI_BUNDLE_PATH)
  const builtin = path.join(resources, ...BUILTIN_CONFIG_PATH)
  if (!fs.existsSync(bundle)) {
    fail(`ZCode CLI bundle not found at ${bundle} — install ZCode.app or set the provider's appPath config to its Contents/Resources directory`)
  }
  if (!fs.existsSync(builtin)) {
    fail(`ZCode built-in provider config not found at ${builtin} — the installed ZCode.app looks incomplete; reinstall it or set appPath`)
  }

  const stableDir = stableDirectory(resources)
  const entry = path.join(stableDir, ENTRY_FILE_NAME)
  const providerDir = path.join(stableDir, 'provider')
  try {
    fs.mkdirSync(providerDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(entry)) {
      fs.writeFileSync(
        entry,
        '// @local/dsh-subagent-zcode launcher marker. The ZCode CLI only needs this\n'
        + '// file to exist: it derives its built-in provider catalogue directory from\n'
        + '// dirname(realpath(process.argv[1])). See bin/zcode-cli.cjs.\n',
        { mode: 0o600 },
      )
    }
  }
  catch (error) {
    fail(`cannot create the launcher directory ${stableDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  exposeBuiltinConfig(path.join(providerDir, 'zcode-builtin.json'), builtin, stableDir)

  // Hand the app's real entrypoint layout to the CLI. The original argv tail is
  // preserved verbatim: this is the only argv rewrite the launcher performs.
  process.argv = [process.argv[0], entry, ...process.argv.slice(2)]
  require(bundle)
}

main()
