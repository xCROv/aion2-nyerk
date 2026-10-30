/**
 * Addons, main's side: the folder `<userData>/addons` (beside settings.json), the addons that come
 * with Nyerk (app/addons/, copied to out/addons by the build), which addons are switched on, and
 * everything they run (the design: shared/addons.ts).
 *
 * - **Built-in addons** (the PvP Log, the Timers) run the app's own code; main/builtins.ts tells
 *   that code whether they are on. An addon in the folder with one of their ids is not loaded.
 * - **Python parts** go to the tracker helper as `--addon <id>=<file>` (aion2_tracker/addons.py);
 *   switching one on or off, or a reload, restarts the helper with the session carried across.
 * - **Web parts** load from `nyerk-addon://<id>/`, served here from the addon's own folder only,
 *   with a CSP that limits their connections to the hosts they declare. Tabs are frames in the
 *   panel, HUD sections frames in the HUD; background scripts are frames in a hidden window
 *   (windows.ts setAddonHost).
 * - Every frame's call comes through `addons:call`, relayed by the window holding it, and is
 *   checked here against the addon's permissions. The app's events reach an addon only where a
 *   permission allows (ADDON_EVENTS), through the broadcast tap.
 * - Markers an addon puts on the Collection Map (`map.markers`, the `map` permission) are kept here
 *   until it replaces them, is switched off or reloaded, and go to every window as `addons:markers`.
 */
import { app, protocol, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import {
  ADDON_BACKGROUND_PAGE,
  ADDON_EVENTS,
  ADDON_SCHEME,
  ADDON_SDK_PATH,
  addonPath,
  isSettingKey,
  MANIFEST_FILE,
  mapMarkers,
  MAX_MANIFEST_BYTES,
  RESERVED_EVENT_NAMES,
  resolveAddons,
  settingValue,
  type AddonInfo,
  type AddonMapMarker,
  type AddonMarkers,
  type AddonPermission,
  type AddonsStatus,
  type FoundFolder,
} from '../shared/addons.ts'
import type { EventChannel } from '../shared/ipc.ts'
import { isAlarmSound } from '../shared/timers.ts'
import { SDK_CSS, SDK_JS } from './addonSdk.ts'
import { broadcast, tapBroadcast } from './broadcast.ts'
import { settings } from './settings.ts'
import { timers } from './timers.ts'
import { log, tracker } from './tracker.ts'
import { setAddonHost, setAddonHuds } from './windows.ts'

/** Saving a file fires several events: look once they have settled. */
const WATCH_SETTLE_MS = 1000
/** An addon's own storage, as JSON. */
const MAX_STORAGE_BYTES = 1024 * 1024
/** One chime per addon at most this often. */
const NOTIFY_EVERY_MS = 3000
/** Each sound once per addon at most this often (a zone's nodes come in together). */
const SOUND_EVERY_MS = 1000

let list: AddonInfo[] = []
let changed = false
let generation = 0
let watcher: FSWatcher | null = null
let settle: NodeJS.Timeout | null = null
/** What went wrong while an addon ran, by id: shown on its card until the next reload. */
const errors = new Map<string, string>()
/** The latest of each event an addon's Python part emitted: a frame opened later starts from it. */
const emitted = new Map<string, Map<string, unknown>>()
const storage = new Map<string, Record<string, unknown>>()
const lastNotify = new Map<string, number>()
/** When each addon last played each sound: `<id>/<sound>`. */
const lastSound = new Map<string, number>()
/** Each addon's markers on the Collection Map: its latest list, until it is switched off or reloaded. */
const markers = new Map<string, AddonMapMarker[]>()

export const addonsFolder = (): string => join(app.getPath('userData'), 'addons')

/** The addons that come with Nyerk: out/addons in a build or a bundle, app/addons in a dev run. */
function bundledFolder(): string {
  const built = join(__dirname, '../addons')
  return existsSync(built) ? built : join(__dirname, '../../addons')
}
/** The folder an addon's files are in. */
const rootOf = (a: AddonInfo): string => join(a.bundled ? bundledFolder() : addonsFolder(), a.folder)
const dataFolder = (id: string): string => join(app.getPath('userData'), 'addon-data', id)

// ---- the folder -----------------------------------------------------------------------------

function readFolder(dir: string): FoundFolder[] {
  let entries: string[]
  try {
    // A folder linked in (a junction to where the addon is developed) counts as one.
    const isFolder = (e: import('node:fs').Dirent): boolean => {
      try {
        return e.isDirectory() || (e.isSymbolicLink() && statSync(join(dir, e.name)).isDirectory())
      } catch {
        return false
      }
    }
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => isFolder(e) && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  return entries.map((folder) => {
    const file = join(dir, folder, MANIFEST_FILE)
    try {
      if (statSync(file).size > MAX_MANIFEST_BYTES) return { folder, manifest: null, error: `${MANIFEST_FILE} is too big` }
      return { folder, manifest: readFileSync(file, 'utf8') }
    } catch {
      return { folder, manifest: null }
    }
  })
}

function look(): AddonInfo[] {
  const stored = settings.get('addons')
  const from = (dir: string, bundled: boolean): AddonInfo[] =>
    resolveAddons(readFolder(dir), stored.enabled, (folder, path) => existsSync(join(dir, folder, path)), undefined, stored.values, bundled)
  const included = from(bundledFolder(), true)
  const ids = new Set(included.map((a) => a.id).filter(Boolean))
  const own = from(addonsFolder(), false).map((a): AddonInfo =>
    a.id && ids.has(a.id) ? { ...a, state: 'invalid', isNew: false, problem: `Nyerk already includes an addon with its id (${a.id})` } : a,
  )
  return [...included, ...own]
}

/** Its HUD section as its page left it (nyerk.hud.show, .detach): hidden until it says otherwise. */
const hudPlace = (id: string | null): { shown: boolean; detached: boolean } => {
  const h = id ? settings.get('addons').hud[id] : undefined
  return { shown: h?.shown === true, detached: h?.detached === true }
}

const status = (): AddonsStatus => ({
  folder: addonsFolder(),
  addons: list.map((a) => {
    const h = hudPlace(a.id)
    return { ...a, hudShown: !!a.hud && h.shown, hudDetached: !!a.hud && h.detached, error: (a.id && errors.get(a.id)) || null }
  }),
  changed,
  generation,
})
const announce = (): void => broadcast('addons:changed', status())

/** Every addon's markers, with its name for the map's key; none from an addon that is not on. */
const allMarkers = (): AddonMarkers[] =>
  [...markers].flatMap(([id, list]) => {
    const addon = running(id)
    return addon && list.length ? [{ addon: id, name: addon.name, markers: list }] : []
  })
const announceMarkers = (): void => broadcast('addons:markers', allMarkers())
/** Its markers gone (switched off, reloaded), and the map told when it had any. */
function dropMarkers(id?: string): void {
  const had = id ? markers.delete(id) : markers.size > 0
  if (!id) markers.clear()
  if (had) announceMarkers()
}

/** An addon switched on and able to run. */
const running = (id: string): AddonInfo | undefined => list.find((a) => a.id === id && a.state === 'on')
const allowed = (addon: AddonInfo, permission: AddonPermission): boolean => addon.permissions.includes(permission)

function scan(): void {
  list = look()
  changed = false
  // Found for the first time: recorded as off, so it shows as new once and never switches itself on.
  const fresh = list.filter((a) => a.isNew && a.id)
  if (fresh.length) {
    const stored = settings.get('addons')
    const enabled = { ...stored.enabled }
    for (const a of fresh) enabled[a.id!] = false
    settings.set('addons', { ...stored, enabled })
  }
  const on = list.filter((a) => a.state === 'on').length
  const builtinOff = list.filter((a) => a.builtin && a.state === 'off').map((a) => a.id)
  const problems = list.filter((a) => a.problem).map((a) => `${a.folder}: ${a.problem}`)
  log(
    `addons: ${list.length} found, ${on} on${builtinOff.length ? ` (switched off: ${builtinOff.join(', ')})` : ''}` +
      (problems.length ? `; ${problems.join('; ')}` : ''),
  )
}

/** The folder changed on disk: if a look now differs from what was loaded, say a reload would help. */
function folderChanged(): void {
  if (settle) clearTimeout(settle)
  settle = setTimeout(() => {
    settle = null
    const same = (a: AddonInfo): unknown => ({ ...a, isNew: false, state: a.state === 'on' ? 'off' : a.state, values: null })
    const differs = JSON.stringify(look().map(same)) !== JSON.stringify(list.map(same))
    if (differs !== changed) {
      changed = differs
      announce()
    }
  }, WATCH_SETTLE_MS)
}

function startWatch(): void {
  if (watcher) return
  try {
    watcher = watch(addonsFolder(), { recursive: true }, folderChanged)
    // The folder deleted or renamed from under us: the next reload watches it again.
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    watcher = null
  }
}

// ---- running them ---------------------------------------------------------------------------

/** `--addon <id>=<file>` for each Python part switched on. */
function sidecarArgs(): string[] {
  return list.filter((a) => a.state === 'on' && a.sidecar && a.id).flatMap((a) => ['--addon', `${a.id}=${sidecarPath(a)}`])
}

/**
 * Where the helper runs an addon's Python part from. One that comes with Nyerk sits inside the
 * app's archive (app.asar, or an update bundle's), which only Electron can read: the .py files
 * beside its sidecar are copied out to `<userData>/addon-code/<id>/` first, at every start, so an
 * update's replace the old ones.
 */
function sidecarPath(a: AddonInfo): string {
  const file = join(rootOf(a), a.sidecar!)
  if (!a.bundled) return file
  const from = dirname(file)
  const out = join(app.getPath('userData'), 'addon-code', a.id!)
  try {
    mkdirSync(out, { recursive: true })
    for (const name of readdirSync(from)) {
      if (name.endsWith('.py')) writeFileSync(join(out, name), readFileSync(join(from, name)))
    }
    return join(out, basename(file))
  } catch (error) {
    log(`addon ${a.id}: could not copy its Python part out of the app: ${String(error)}`)
    return file
  }
}

/** What the helper was last started with, to tell when it must start again. */
let currentArgs: string[] = []

/**
 * Bring what runs in line with the list: the helper's arguments (restarting it when they changed,
 * or when `restartHelper` says its files may have), and the background host.
 */
function apply(restartHelper: boolean): void {
  const args = sidecarArgs()
  const before = currentArgs
  currentArgs = args
  tracker.setAddonArgs(args)
  if ((restartHelper || before.join('\n') !== args.join('\n')) && tracker.running()) {
    log('addons: restarting the tracker for its addons')
    void tracker.restartKeepingSession()
  }
  setAddonHost(list.some((a) => a.state === 'on' && a.background))
  syncAddonHuds()
}

/** The detached HUD sections get their windows (made with the other overlays, while the game runs). */
function syncAddonHuds(): void {
  setAddonHuds(list.filter((a) => a.state === 'on' && a.id && a.hud && hudPlace(a.id).shown && hudPlace(a.id).detached).map((a) => a.id!))
}

/** Its page shows, hides, detaches or docks its HUD section. */
function setHudPlace(addon: AddonInfo, change: { shown?: boolean; detached?: boolean }): { shown: boolean; detached: boolean } {
  if (!addon.hud) throw new Error('it has no HUD section ("hud" in its manifest)')
  const id = addon.id!
  const stored = settings.get('addons')
  const before = stored.hud[id] ?? { shown: false, detached: false, position: null }
  const next = { ...before, ...change }
  settings.set('addons', { ...stored, hud: { ...stored.hud, [id]: next } })
  const place = { shown: next.shown, detached: next.detached }
  broadcast('addons:event', { addon: id, name: 'hud', data: place })
  syncAddonHuds()
  announce()
  return place
}

/** Shown on its card; `logged` when the full story is already in the log. */
function fail(id: string, detail: string, logged = false): void {
  errors.set(id, detail.slice(0, 500))
  if (!logged) log(`addon ${id}: ${detail}`)
  announce()
}

function onHelperLine(ev: Record<string, unknown>): void {
  const id = String(ev['addon'] ?? '')
  const addon = running(id)
  if (!addon) return
  switch (ev['type']) {
    case 'addonLoaded':
      log(`addon ${id}: loaded in the tracker`)
      tracker.addonCommand({ cmd: 'addonSettings', addon: id, values: addon.values })
      break
    case 'addonError':
      fail(id, `${ev['fatal'] ? 'stopped: ' : ''}${String(ev['detail'] ?? 'unknown error')}`)
      break
    case 'addon': {
      const name = String(ev['name'] ?? '')
      if (!name || RESERVED_EVENT_NAMES.has(name)) return
      let cache = emitted.get(id)
      if (!cache) emitted.set(id, (cache = new Map()))
      cache.set(name, ev['data'])
      broadcast('addons:event', { addon: id, name, data: ev['data'] })
      break
    }
  }
}

/** The app's broadcasts, passed on to the addons allowed to hear them. */
function onBroadcast(channel: EventChannel, payload: unknown): void {
  const event = (ADDON_EVENTS as Partial<Record<EventChannel, { name: string; permission: AddonPermission }>>)[channel]
  if (!event) return
  for (const addon of list) {
    if (addon.state === 'on' && addon.id && (addon.tab || addon.background || addon.hud) && allowed(addon, event.permission)) {
      broadcast('addons:event', { addon: addon.id, name: event.name, data: payload })
    }
  }
}

/**
 * What a frame starts from: the app's state it may see, its Python part's latest, its settings,
 * and whether its HUD section is shown (null: it has none).
 */
function snapshot(addon: AddonInfo): {
  events: { name: string; data: unknown }[]
  settings: AddonInfo['values']
  hud: { shown: boolean; detached: boolean } | null
} {
  const state: [AddonPermission, string, () => unknown][] = [
    ['events:status', 'status', () => tracker.status()],
    ['events:pets', 'pets', () => tracker.pets()],
    ['events:nearby', 'nearby', () => tracker.nearby()],
    ['events:shop', 'shop', () => tracker.shop()],
    ['events:kina', 'kina', () => tracker.kina()],
    ['events:fieldBosses', 'fieldBosses', () => tracker.fieldBosses()],
    ['events:pvp', 'pvp', () => tracker.pvp()],
    ['events:timers', 'timers', () => timers.state()],
  ]
  const events = state.filter(([p]) => allowed(addon, p)).map(([, name, get]) => ({ name, data: get() }))
  for (const [name, data] of emitted.get(addon.id!) ?? []) events.push({ name, data })
  return { events, settings: addon.values, hud: addon.hud ? hudPlace(addon.id) : null }
}

function storageOf(id: string): Record<string, unknown> {
  let data = storage.get(id)
  if (!data) {
    try {
      data = JSON.parse(readFileSync(join(dataFolder(id), 'storage.json'), 'utf8')) as Record<string, unknown>
      if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {}
    } catch {
      data = {}
    }
    storage.set(id, data)
  }
  return data
}

function saveStorage(id: string, data: Record<string, unknown>): void {
  const text = JSON.stringify(data)
  if (text.length > MAX_STORAGE_BYTES) throw new Error('its storage is full (1 MB)')
  mkdirSync(dataFolder(id), { recursive: true })
  writeFileSync(join(dataFolder(id), 'storage.json'), text)
  storage.set(id, data)
}

function need(addon: AddonInfo, permission: AddonPermission): void {
  if (!allowed(addon, permission)) throw new Error(`it has no "${permission}" permission`)
}

/** One call from an addon's frame. Thrown errors go back to the frame as a rejected promise. */
function call(id: string, method: string, args: unknown[]): unknown {
  const addon = running(id)
  if (!addon) throw new Error('the addon is not switched on')
  switch (method) {
    case 'ready':
      return snapshot(addon)
    case 'error': {
      const text = String(args[0] ?? 'unknown error')
      log(`addon ${id}: ${text}`)
      // The card says "Error:" itself.
      fail(id, text.split('\n')[0]!.replace(/^(?:Uncaught )?Error: /, ''), true)
      return null
    }
    case 'send':
      if (!addon.native) throw new Error('it has no Python part to send to')
      tracker.addonCommand({ cmd: 'addon', addon: id, name: String(args[0] ?? ''), data: args[1] ?? null })
      return null
    case 'notify': {
      need(addon, 'notify')
      const now = Date.now()
      if (now - (lastNotify.get(id) ?? 0) >= NOTIFY_EVERY_MS) {
        lastNotify.set(id, now)
        broadcast('addons:notify', { addon: id })
      }
      return null
    }
    case 'sound': {
      need(addon, 'sound')
      const sound = args[0]
      if (!isAlarmSound(sound)) throw new Error(`unknown sound ${String(sound)}`)
      const now = Date.now()
      if (now - (lastSound.get(`${id}/${sound}`) ?? 0) >= SOUND_EVERY_MS) {
        lastSound.set(`${id}/${sound}`, now)
        broadcast('addons:sound', { addon: id, sound })
      }
      return null
    }
    case 'map.markers': {
      need(addon, 'map')
      const list = mapMarkers(args[0])
      // Nothing to tell when it had none and still has none (a page clearing on every quiet tick).
      if (!list.length && !markers.has(id)) return 0
      if (list.length) markers.set(id, list)
      else markers.delete(id)
      announceMarkers()
      return list.length
    }
    case 'hud.show':
      return setHudPlace(addon, { shown: args[0] === true })
    case 'hud.detach':
      return setHudPlace(addon, { detached: args[0] === true })
    case 'storage.get':
      need(addon, 'storage')
      return storageOf(id)[String(args[0])] ?? null
    case 'storage.all':
      need(addon, 'storage')
      return storageOf(id)
    case 'storage.set': {
      need(addon, 'storage')
      const data = { ...storageOf(id) }
      if (args[1] === undefined || args[1] === null) delete data[String(args[0])]
      else data[String(args[0])] = args[1]
      saveStorage(id, data)
      // Its other pages (a tab and its HUD section) hear of it, and keep in step.
      broadcast('addons:event', { addon: id, name: 'storage', data: { key: String(args[0]), value: args[1] ?? null } })
      return null
    }
  }
  throw new Error(`unknown call ${method}`)
}

// ---- nyerk-addon:// -------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

/**
 * Chromium matches neither 'self' nor a host source on a custom scheme, only the scheme itself. An
 * addon's page could so load another switched-on addon's files, and gain nothing by it: what a
 * page may do follows its frame's origin, which lib/addonFrame.ts checks on every call.
 */
const csp = (addon: AddonInfo): string => {
  const self = `${ADDON_SCHEME}:`
  return [
    "default-src 'none'",
    `script-src ${self}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data:`,
    `font-src ${self}`,
    `media-src ${self}`,
    `connect-src ${self} ${addon.network.join(' ')}`.trim(),
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

const notFound = (): Response => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })

/** Inter, as the renderer ships it (a hashed name in the build). */
function interFont(): Buffer | null {
  for (const dir of [join(__dirname, '../renderer/assets'), join(__dirname, '../../src/renderer/src/assets/fonts')]) {
    try {
      const name = readdirSync(dir).find((f) => f.startsWith('inter-latin-opsz') && f.endsWith('.woff2'))
      if (name) return readFileSync(join(dir, name))
    } catch {
      // not this one
    }
  }
  return null
}

function serveSdk(path: string): Response {
  if (path === 'nyerk.js') return new Response(SDK_JS, { headers: { 'content-type': TYPES['.js']! } })
  if (path === 'nyerk.css') return new Response(SDK_CSS, { headers: { 'content-type': TYPES['.css']! } })
  if (path === 'inter.woff2') {
    const font = interFont()
    return font ? new Response(new Uint8Array(font), { headers: { 'content-type': TYPES['.woff2']! } }) : notFound()
  }
  return notFound()
}

function serve(request: Request): Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const addon = running(url.hostname)
  if (!addon) return notFound()
  if (path.startsWith(`${ADDON_SDK_PATH}/`)) return serveSdk(path.slice(ADDON_SDK_PATH.length + 1))
  const headers = { 'content-security-policy': csp(addon), 'cache-control': 'no-store' }
  if (path === ADDON_BACKGROUND_PAGE && addon.background) {
    const page = `<!doctype html><meta charset="utf-8"><script src="/${ADDON_SDK_PATH}/nyerk.js"></script><script src="/${addon.background}"></script>`
    return new Response(page, { headers: { ...headers, 'content-type': TYPES['.html']! } })
  }
  const safe = addonPath(path, '')
  if (!safe) return notFound()
  const root = resolve(rootOf(addon))
  const file = resolve(root, safe)
  if (!file.startsWith(root + sep)) return notFound()
  try {
    const body = readFileSync(file)
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    // The tab's icon is drawn by the panel as a CSS mask, which loads it with CORS.
    const shared = safe === addon.tab?.icon ? { 'access-control-allow-origin': '*' } : {}
    return new Response(new Uint8Array(body), { headers: { ...headers, ...shared, 'content-type': type } })
  } catch {
    return notFound()
  }
}

/**
 * Before the app is ready (Electron's rule): the scheme behaves like https, with fetch. CORS lets
 * the panel load a tab's icon (the one file `serve` shares).
 */
export function registerAddonScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ADDON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

// ---- the API --------------------------------------------------------------------------------

export const addons = {
  /** At start, before the tracker: the folder looked at and watched, and what is on set running. */
  start(): void {
    try {
      mkdirSync(addonsFolder(), { recursive: true })
    } catch {
      // A folder that cannot be made just has no addons in it.
    }
    protocol.handle(ADDON_SCHEME, serve)
    tapBroadcast(onBroadcast)
    tracker.onAddonLine(onHelperLine)
    scan()
    startWatch()
    apply(false)
    announce()
  },
  status,
  /** Look at the folder again and start everything from it afresh. */
  reload(): AddonsStatus {
    const hadNative = list.some((a) => a.state === 'on' && a.native)
    scan()
    errors.clear()
    emitted.clear()
    storage.clear()
    dropMarkers()
    generation++
    startWatch()
    apply(hadNative || list.some((a) => a.state === 'on' && a.native))
    announce()
    return status()
  },
  async openFolder(): Promise<void> {
    mkdirSync(addonsFolder(), { recursive: true })
    const error = await shell.openPath(addonsFolder())
    if (error) log(`addons: could not open the folder: ${error}`)
  },
  setEnabled(id: string, on: boolean): void {
    const addon = list.find((a) => a.id === id)
    if (!addon || (addon.state !== 'on' && addon.state !== 'off')) return
    const stored = settings.get('addons')
    settings.set('addons', { ...stored, enabled: { ...stored.enabled, [id]: on } })
    list = list.map((a) => (a.id === id ? { ...a, state: on ? 'on' : 'off', isNew: false } : a))
    errors.delete(id)
    emitted.delete(id)
    dropMarkers(id)
    log(`addons: ${id} switched ${on ? 'on' : 'off'}`)
    apply(false)
    announce()
  },
  setSetting(id: string, key: string, value: unknown): void {
    const addon = list.find((a) => a.id === id)
    const def = addon?.settings.find((d) => d.key === key)
    if (!addon || !def || !isSettingKey(key)) return
    const v = settingValue(def, value)
    const stored = settings.get('addons')
    settings.set('addons', { ...stored, values: { ...stored.values, [id]: { ...stored.values[id], [key]: v } } })
    const values = { ...addon.values, [key]: v }
    list = list.map((a) => (a.id === id ? { ...a, values } : a))
    if (addon.state === 'on') {
      broadcast('addons:event', { addon: id, name: 'settings', data: values })
      if (addon.native) tracker.addonCommand({ cmd: 'addonSettings', addon: id, values })
    }
    announce()
  },
  call,
  markers: allMarkers,
}
