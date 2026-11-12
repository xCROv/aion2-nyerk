/**
 * The entry point of an install: pick an app bundle and hand over to it (shared/bundle.ts; the
 * design is marnis-app's docs/23-app-bundles.md).
 *
 * This is **shell** code. scripts/build-loader.mjs compiles it to out/loader/index.js, beside the
 * app rather than inside it, and it changes only when an installer ships. So it does as little as
 * it can, and every path through it ends with an app starting: the built-in bundle is in the
 * install, always there and always runnable.
 *
 * In order:
 * 1. name the app, because userData hangs off the name (main/index.ts names it again);
 * 2. take the single-instance lock: a second launch only opens the first one's panel, so it quits
 *    here, before it could count as an attempt;
 * 3. read `<userData>/bundles/state.json` and choose what to run;
 * 4. count the attempt **before** making it, so a bundle that cannot start is counted out rather
 *    than retried forever (the app clears the count once it has started);
 * 5. require the bundle's main/index.js, which is the app as before.
 *
 * `--builtin-bundle` or NYERK_BUILTIN=1 pins the install to its built-in app. A development run
 * (not packaged) always runs the code it was started from.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISPLAY_NAME } from '../shared/app.ts'
import { withoutAsar } from '../shared/asar.ts'
import { chooseBundle, MAX_BUNDLE_FAILURES, parseBundleState, publishActiveBundle, type BundleState } from '../shared/bundle.ts'

const MAIN = join('main', 'index.js')

const bundlesDir = (): string => join(app.getPath('userData'), 'bundles')
const statePath = (): string => join(bundlesDir(), 'state.json')
const asarPath = (version: string): string => join(bundlesDir(), version, 'bundle.asar')

/** Only when something is wrong, to logs/loader.log (tracker.log is started afresh by the app). */
function note(message: string): void {
  console.warn(`[loader] ${message}`)
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'loader.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // A log that cannot be written is no reason to fail a start.
  }
}

function readState(): BundleState {
  try {
    return parseBundleState(readFileSync(statePath(), 'utf8'))
  } catch {
    return { active: null, bundles: {} }
  }
}

/** Never in place: this is the one reader with no way to recover from a half-written file. */
function writeState(state: BundleState): void {
  mkdirSync(bundlesDir(), { recursive: true })
  const partial = `${statePath()}.part`
  writeFileSync(partial, JSON.stringify(state, null, 2))
  withoutAsar(() => renameSync(partial, statePath()))
}

/** There, and the bytes it was verified as when it landed (through withoutAsar: it is a file). */
function intact(version: string, sha512: string): boolean {
  try {
    return withoutAsar(() => {
      const path = asarPath(version)
      if (!statSync(path).isFile()) return false
      return sha512 === '' || createHash('sha512').update(readFileSync(path)).digest('base64') === sha512
    })
  } catch {
    return false
  }
}

function forcedToBuiltin(): boolean {
  return !app.isPackaged || process.argv.includes('--builtin-bundle') || process.env['NYERK_BUILTIN'] === '1'
}

function runBuiltin(builtinMain: string, version: string): void {
  publishActiveBundle({ version, source: 'builtin', path: builtinMain })
  require(builtinMain)
}

function boot(): void {
  const builtinMain = join(__dirname, '..', MAIN)
  const builtinVersion = app.getVersion()

  let state: BundleState | null = null
  let choice: { version: string; source: 'builtin' | 'downloaded'; reason?: string } = { version: builtinVersion, source: 'builtin' }
  try {
    if (!forcedToBuiltin()) {
      const read = readState()
      state = read
      choice = chooseBundle({
        state: read,
        builtinVersion,
        shellVersion: builtinVersion,
        present: (version) => intact(version, read.bundles[version]?.sha512 ?? ''),
      })
      if (choice.source === 'builtin' && read.active) note(`not running bundle ${read.active} (${choice.reason}); running ${builtinVersion}`)
    }
  } catch (error) {
    note(`could not read the bundle state; running ${builtinVersion}: ${String(error)}`)
  }

  if (choice.source === 'builtin' || !state) return runBuiltin(builtinMain, builtinVersion)

  const version = choice.version
  // The attempt goes on the record first: a bundle that takes the process down never gets to say so.
  try {
    const bundle = state.bundles[version]!
    writeState({ ...state, bundles: { ...state.bundles, [version]: { ...bundle, failures: bundle.failures + 1 } } })
  } catch (error) {
    note(`could not record the attempt; running ${builtinVersion}: ${String(error)}`)
    return runBuiltin(builtinMain, builtinVersion)
  }

  const entry = join(asarPath(version), MAIN)
  try {
    publishActiveBundle({ version, source: 'downloaded', path: entry })
    require(entry)
  } catch (error) {
    // Half a bundle has run in this process: set it aside and start again on the built-in app.
    note(`bundle ${version} did not load; going back to ${builtinVersion}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    try {
      const latest = readState()
      const bundle = latest.bundles[version]
      if (bundle) writeState({ ...latest, active: null, bundles: { ...latest.bundles, [version]: { ...bundle, failures: MAX_BUNDLE_FAILURES } } })
    } catch {
      // The flag on the relaunch makes the next start ignore the state anyway.
    }
    app.relaunch({ args: [...process.argv.slice(1), '--builtin-bundle'] })
    app.exit(0)
  }
}

app.setName(DISPLAY_NAME)
if (app.requestSingleInstanceLock()) boot()
else app.quit()
