/**
 * App updates, the way marnis-app does them since its 0.8.0: two feeds on nyerk.app, one flow.
 *
 * - **Bundles** (`/updates/bundle/`, shared/bundle.ts): the app alone, a few MB, verified against a
 *   signed manifest and adopted on a restart that takes about as long as opening the app. Nothing
 *   is reinstalled. Asked first: the cheap update wins whenever there is one.
 * - **Installers** (`/updates/latest.yml`, electron-updater, set in electron-builder.yml): the whole
 *   install, for a new Electron or a new tracker helper. Asked when the bundle feed has nothing for
 *   this install. An installer no newer than the app running is not offered (a bundle can be ahead
 *   of the installers).
 *
 * Automatic, and said out loud: the feed is checked at start and every hour while Settings allows
 * it, and an update found is downloaded. A bundle then installs itself; the panel and a Windows
 * notification say so a few seconds before the restart. While Aion 2 is running it waits for the
 * game to close (or the Restart button) rather than restart under someone mid-fight. An installer
 * waits for the panel's Restart to install, and a notification says it is there. Every restart
 * carries the session across (restart.ts), so nothing is lost but the second it takes.
 *
 * A version that was installed and is still offered after the restart did not take: it is tried
 * twice, then left to a click (restart.ts, attempts). A development run has no feed and says so.
 */
import { app, net, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { DISPLAY_NAME } from '../shared/app.ts'
import { BUNDLE_FEED_URL, compareVersions, readActiveBundle, type BundleManifest, type BundleOffer } from '../shared/bundle.ts'
import { autoInstallStep, initialUpdateStatus, type UpdateStatus } from '../shared/update.ts'
import { broadcast } from './broadcast.ts'
import { activateBundle, checkForBundle, downloadBundle, markBundleStarted, reconcileBundles, type BundleDeps } from './bundles.ts'
import { game } from './game.ts'
import { machineHash } from './machine.ts'
import { attempts, writeRestartState, type RestartState } from './restart.ts'
import { settings } from './settings.ts'
import { timers } from './timers.ts'
import { log, tracker } from './tracker.ts'
import { appVersion, shellVersion } from './version.ts'
import { markQuitting, merchantOpen, panelTab, panelVisible, saveWindowPlaces } from './windows.ts'

/** After start, once the windows are up: soon enough that an update lands before anyone settles in. */
const LAUNCH_DELAY_MS = 3_000
const INTERVAL_MS = 60 * 60 * 1000
/** How long the "restarting to install" notice is up before the restart. */
const RESTART_NOTICE_MS = 5_000
/** A downloaded bundle that has run this long without dying has started: the loader's count clears. */
const STARTED_AFTER_MS = 20_000

let status: UpdateStatus = initialUpdateStatus(app.getVersion())
let wired = false
/** What Download and Restart act on. */
let pending: { kind: 'bundle'; offer: BundleOffer; manifest: BundleManifest } | { kind: 'installer' } | null = null
let restartTimer: NodeJS.Timeout | null = null
let waitingForGameToClose = false
let askedToInstall: string | null = null

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  broadcast('update:status', status)
}

/**
 * A failed check, download or install: the whole error (stack and all) goes to tracker.log, the
 * panel gets a short line ending in a code to quote. A full message can be a long path or a page of HTTP.
 */
function fail(step: 'check' | 'download' | 'install', err: unknown): void {
  const e = err as { code?: unknown; statusCode?: unknown; stack?: unknown; message?: unknown } | null
  const code =
    typeof e?.code === 'string' && e.code
      ? e.code
      : typeof e?.statusCode === 'number'
        ? `HTTP ${e.statusCode}`
        : 'UNKNOWN'
  const what = { check: 'Could not check for updates', download: 'The update did not download', install: 'The update did not install' }[step]
  const why = failureReason(code)
  const line = `${what}${why ? `: ${why}` : ''} (${code}).`
  // electron-updater both emits 'error' and rejects: one failure, one entry.
  if (status.state === 'error' && status.error === line) return
  log(`update error (${step}, ${code}): ${typeof e?.stack === 'string' ? e.stack : String(e?.message ?? err)}`)
  set({ state: 'error', error: line, checkedAt: Date.now() })
}

/** A few words for the failures seen in the wild; anything else is left to its code and the log. */
function failureReason(code: string): string | null {
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code) || code.startsWith('ERR_NAME') || code.startsWith('ERR_INTERNET'))
    return 'no connection to the update server'
  if (code === 'ENOENT') return 'a file it needs is missing'
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return 'a file is locked or not writable'
  if (code.startsWith('HTTP 5')) return 'the update server is having trouble'
  if (code.startsWith('HTTP ')) return 'the update server turned the request down'
  if (code.includes('SIGNATURE') || code.includes('CHECKSUM') || code.includes('SHA512')) return 'the download did not verify'
  return null
}

const dataDir = (): string => app.getPath('userData')
const bundleRoot = (): string => join(dataDir(), 'bundles')

function bundleDeps(): BundleDeps {
  return {
    // NYERK_BUNDLE_FEED: another feed, to try a bundle before it is published. Its manifest must
    // still be signed by the key this build trusts.
    feed: process.env['NYERK_BUNDLE_FEED'] ?? BUNDLE_FEED_URL,
    fetch: async (url) => {
      // The same gate as the installer feed (aion2-api's ban list): see machine.ts.
      const response = await net.fetch(url, { headers: { 'X-A2-Machine': machineHash(), 'Cache-Control': 'no-cache' } })
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        bytes: async () => new Uint8Array(await response.arrayBuffer()),
      }
    },
    root: bundleRoot(),
    shellVersion: shellVersion(),
    runningVersion: appVersion(),
    onWarning: (m) => log(`update warning: ${m}`),
  }
}

function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // The server's gate (aion2-api) keys its ban list on this: see machine.ts.
  autoUpdater.requestHeaders = { 'X-A2-Machine': machineHash() }
  // Without a logger the library writes to a console nobody sees in an installed build.
  autoUpdater.logger = {
    info: (m: unknown) => log(`update: ${String(m)}`),
    warn: (m: unknown) => log(`update warning: ${String(m)}`),
    error: (m: unknown) => log(`update error: ${String(m)}`),
    debug: () => undefined,
  }
  autoUpdater.on('update-available', (info) => {
    // A bundle can be ahead of the newest installer: that installer has nothing to add.
    if (compareVersions(info.version, appVersion()) <= 0) {
      pending = null
      set({ state: 'none', version: null, kind: null, checkedAt: Date.now() })
      return
    }
    pending = { kind: 'installer' }
    set({ state: 'available', kind: 'installer', version: info.version, checkedAt: Date.now() })
  })
  autoUpdater.on('update-not-available', () => set({ state: 'none', version: null, kind: null, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (err) => fail(status.state === 'downloading' ? 'download' : 'check', err))
}

/**
 * What the next start needs to come back as this one is. The session's souls are asked of the
 * tracker helper, which goes down with the app.
 */
async function saveRestartState(to: string): Promise<void> {
  saveWindowPlaces()
  const dumped = await tracker.dumpSession()
  const nearby = tracker.nearby()
  const state: RestartState = {
    at: Date.now(),
    from: appVersion(),
    to,
    panel: { visible: panelVisible(), tab: panelTab() },
    merchantOpen: merchantOpen(),
    kina: tracker.kina(),
    shop: tracker.shop(),
    sessions: dumped,
    world: nearby.world,
    position: nearby.position,
    timers: timers.snapshot(),
  }
  writeRestartState(dataDir(), state)
  log(`update: saved the session for the restart (${dumped ? Object.values(dumped).reduce((n, pets) => n + Object.keys(pets).length, 0) : 'no'} pets with session souls)`)
}

/** Quit and come straight back, on whatever the loader now names. */
function relaunch(): void {
  markQuitting()
  // Not with --builtin-bundle: that is for one start after a bundle failed, not for good.
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--builtin-bundle') })
  app.quit()
}

function notify(body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title: DISPLAY_NAME, body, silent: true, icon: join(__dirname, '../renderer/icon.png') }).show()
}

/** Say the restart is coming, then restart into the update. */
function restartSoon(): void {
  if (restartTimer || (status.state !== 'ready' && status.state !== 'restarting')) return
  const version = status.version
  log(`update: ${version} is ready; restarting in ${RESTART_NOTICE_MS / 1000} s to install it`)
  set({ state: 'restarting', restartAt: Date.now() + RESTART_NOTICE_MS })
  notify(
    status.kind === 'bundle'
      ? `Version ${version} was found. ${DISPLAY_NAME} restarts in a few seconds to install it, and picks up where it left off.`
      : `Version ${version} was found. ${DISPLAY_NAME} restarts in a few seconds to install it (this one takes a little longer), and picks up where it left off.`,
  )
  restartTimer = setTimeout(() => void updates.install(), RESTART_NOTICE_MS)
}

/** Once per version: the hourly check finds the same installer still waiting. */
function askToInstall(): void {
  if (askedToInstall === status.version) return
  askedToInstall = status.version
  log(`update: installer ${status.version} is ready; it installs when Restart to install is clicked`)
  notify(`Version ${status.version} is ready. Choose Restart to install in the ${DISPLAY_NAME} panel when it suits you; it picks up where it left off.`)
}

/** Check and download without a click, then install as autoInstallStep says. */
async function autoUpdate(): Promise<void> {
  if (!settings.get('autoUpdateCheck')) return
  await updates.check()
  if (status.state !== 'available' && status.state !== 'ready') return
  if (status.version && attempts.exhausted(dataDir(), status.version)) {
    log(`update: ${status.version} was installed twice and is still offered; waiting for a click`)
    return
  }
  await updates.download()
  if (status.state !== 'ready') return
  switch (autoInstallStep(status.kind, game.running())) {
    case 'ask':
      askToInstall()
      return
    case 'wait-for-game':
      if (!waitingForGameToClose) log(`update: ${status.version} is ready; it installs once Aion 2 closes`)
      waitingForGameToClose = true
      return
    case 'restart':
      restartSoon()
  }
}

export const updates = {
  status: (): UpdateStatus => status,

  async check(): Promise<void> {
    if (!app.isPackaged) {
      set({ state: 'unsupported' })
      return
    }
    // Never over a check, a download, or an update waiting to be installed.
    if (['checking', 'downloading', 'ready', 'restarting'].includes(status.state)) return
    set({ state: 'checking', error: null })
    try {
      const result = await checkForBundle(bundleDeps())
      if (result.outcome === 'offer') {
        pending = { kind: 'bundle', offer: result.offer, manifest: result.manifest }
        set({ state: 'available', kind: 'bundle', version: result.offer.version, checkedAt: Date.now() })
        return
      }
      // A bundle feed that is down must not stand in the way of an installer that is there.
      if (result.outcome === 'error') log(`update warning: the bundle feed: ${result.error}`)
    } catch (err) {
      log(`update warning: the bundle feed: ${(err as Error).message}`)
    }
    wire()
    pending = null
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      fail('check', err)
    }
  },

  async download(): Promise<void> {
    if (status.state !== 'available') return
    set({ state: 'downloading', percent: 0 })
    try {
      if (pending?.kind === 'bundle') {
        if (pending.offer.needsDownload) await downloadBundle(bundleDeps(), pending.manifest)
        set({ state: 'ready', percent: 100 })
      } else {
        await autoUpdater.downloadUpdate()
      }
    } catch (err) {
      fail('download', err)
    }
  },

  /** Save the session, then restart into the update (the Restart button, or restartSoon). */
  async install(): Promise<void> {
    if ((status.state !== 'ready' && status.state !== 'restarting') || !status.version) return
    const version = status.version
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    set({ state: 'restarting', restartAt: Date.now() })
    log(`update: restarting to install ${version} (${pending?.kind ?? 'installer'})`)
    try {
      await saveRestartState(version)
    } catch (err) {
      log(`update warning: could not save the session for the restart: ${(err as Error).message}`)
    }
    attempts.record(dataDir(), version)
    if (pending?.kind === 'bundle') {
      try {
        // The built-in app is named by clearing the pointer (a rollback to the install's own).
        await activateBundle(bundleRoot(), version === shellVersion() ? null : version)
      } catch (err) {
        log(`update error: could not switch to ${version}`)
        fail('install', err)
        return
      }
      relaunch()
      return
    }
    // As in marnis-app: mark the quit as meant, or the tray app's close handling cancels it and
    // the new version bounces off the single-instance lock back to the old one. Silent install,
    // relaunched afterwards.
    markQuitting()
    autoUpdater.quitAndInstall(true, true)
  },
}

/** A downloaded bundle that is running and has not died: tell the loader it starts fine. */
function watchBundleStart(): void {
  const active = readActiveBundle()
  if (active?.source !== 'downloaded') return
  let done = false
  const started = (): void => {
    if (done) return
    done = true
    void markBundleStarted(bundleRoot(), active.version).catch((err: unknown) => log(`update warning: could not record a good start: ${String(err)}`))
  }
  // A window that has loaded proves main, preload and the renderer; with the game closed there may
  // be no window for a long time, so staying up a while counts too.
  app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', started))
  setTimeout(started, STARTED_AFTER_MS).unref()
}

/** At start: bundle housekeeping, then the launch check and the hourly ones (installed builds only). */
export function startUpdateChecks(): void {
  set({ current: appVersion() })
  if (!app.isPackaged) {
    set({ state: 'unsupported' })
    return
  }
  const active = readActiveBundle()
  log(`version ${appVersion()} (${active?.source === 'downloaded' ? `downloaded bundle on shell ${shellVersion()}` : 'built in'})`)
  attempts.settle(dataDir(), appVersion())
  watchBundleStart()
  void reconcileBundles({ root: bundleRoot(), shellVersion: shellVersion(), runningVersion: appVersion() }).catch((err: unknown) =>
    log(`update warning: could not tidy the bundles folder: ${String(err)}`),
  )

  setTimeout(() => void autoUpdate(), LAUNCH_DELAY_MS).unref()
  setInterval(() => void autoUpdate(), INTERVAL_MS).unref()
  // A bundle downloaded while the game ran installs once it closes.
  game.onChange((running) => {
    if (running || !waitingForGameToClose || status.state !== 'ready') return
    waitingForGameToClose = false
    restartSoon()
  })
}
