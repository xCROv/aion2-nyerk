import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { BundleState } from '../src/shared/bundle.ts'

const LOADER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'loader', 'index.ts')
const BUNDLE = '9.9.9'

/** The loader as scripts/build-loader.mjs compiles it, run with a stand-in for Electron's app. */
async function launch(userData: string, getsLock: boolean): Promise<void> {
  const { outputFiles } = await build({ entryPoints: [LOADER], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], write: false, logLevel: 'silent' })
  const app = {
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: () => userData,
    setName: () => undefined,
    requestSingleInstanceLock: () => getsLock,
    quit: () => undefined,
    relaunch: () => undefined,
    exit: () => undefined,
  }
  const nodeRequire = createRequire(import.meta.url)
  const fakeRequire = (id: string): unknown => (id === 'electron' ? { app } : id.endsWith('index.js') ? {} : nodeRequire(id))
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', outputFiles[0]!.text)(fakeRequire, module, module.exports, join(userData, 'install', 'loader'))
}

const failures = (userData: string): number | undefined =>
  (JSON.parse(readFileSync(join(userData, 'bundles', 'state.json'), 'utf8')) as BundleState).bundles[BUNDLE]?.failures

describe('the loader with a downloaded bundle active', () => {
  let userData = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'nyerk-loader-'))
    mkdirSync(join(userData, 'bundles', BUNDLE), { recursive: true })
    writeFileSync(join(userData, 'bundles', BUNDLE, 'bundle.asar'), 'stand-in')
    const state: BundleState = { active: BUNDLE, bundles: { [BUNDLE]: { version: BUNDLE, minShell: '1.0.0', sha512: '', installedAt: 0, failures: 0 } } }
    writeFileSync(join(userData, 'bundles', 'state.json'), JSON.stringify(state))
  })

  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('counts the attempt of a launch that gets the single-instance lock', async () => {
    await launch(userData, true)
    assert.equal(failures(userData), 1)
  })

  it('leaves the count alone on a second launch, which only opens the running one', async () => {
    await launch(userData, false)
    assert.equal(failures(userData), 0)
  })
})
