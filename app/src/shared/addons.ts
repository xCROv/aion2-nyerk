/**
 * Addons: features added from `<userData>/addons/<folder>/`, each described by a manifest.json.
 * Everything here is pure: main reads the folder (main/addons.ts), this decides what each addon is
 * and whether it may run, and the Settings tab shows the result.
 *
 * Two kinds of code, two trust levels:
 * - the web parts (`background`, `tab`, `hud`) run sandboxed, with only the permissions they declare;
 * - the Python part (`sidecar`) runs inside the tracker helper with its full access, so a feature
 *   that needs packets the public helper does not decode can still be an addon.
 *
 * Some addons come with Nyerk (app/addons/). The built-in ones (BUILTIN_ADDONS) say `"builtin": true`
 * and the app's own code does the work: they make the app's optional features (the PvP Log, the
 * Timers) switchable like any other addon. Which of the addons that come with Nyerk start switched
 * on is the app's choice, never a manifest's (DEFAULT_ON_ADDONS).
 *
 * `ADDON_API_VERSION` is the contract an addon's `nyerk` range is checked against. Its major
 * version changes only when something addons rely on stops working the same way.
 */
import { compareVersions } from './bundle.ts'

export const ADDON_API_VERSION = '1.4.0'

/**
 * Addons' pages load from `nyerk-addon://<id>/<path>`, and the SDK from the same origin, under
 * `/_nyerk/` (nyerk.js, nyerk.css): one origin per addon keeps its CSP to itself.
 */
export const ADDON_SCHEME = 'nyerk-addon'
export const ADDON_SDK_PATH = '_nyerk'
/** The page a background script runs in (made up by main: the SDK, then the script). */
export const ADDON_BACKGROUND_PAGE = '_background.html'

export const MANIFEST_FILE = 'manifest.json'
/** A manifest bigger than this is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024

/** Lowercase letters, digits and dashes: it names the addon's origin and its data folder. */
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** What an addon may ask for, and how the Settings tab says it. */
export const ADDON_PERMISSIONS = {
  'events:status': 'The tracker’s status',
  'events:pets': 'Your pet collection',
  'events:soul': 'Souls as they drop',
  'events:nearby': 'What is around you: zone, position, monsters',
  'events:combat': 'When you kill something',
  'events:shop': 'The Black Cloud Merchant’s stock',
  'events:kina': 'Your Kina',
  'events:fieldBosses': 'Field boss timers',
  'events:pvp': 'The PvP kill feed',
  'events:timers': 'Timers: their alerts, next starts and the resets',
  notify: 'Chime and shake the bubble',
  map: 'Put markers on the Collection Map',
  storage: 'Keep its own data',
} as const

export type AddonPermission = keyof typeof ADDON_PERMISSIONS

/**
 * The app's features that come as addons, by id. Their code is the app's own; the addon is what
 * switches it on or off.
 */
export const BUILTIN_ADDONS = ['pvp-log', 'timers'] as const
export type BuiltinAddon = (typeof BUILTIN_ADDONS)[number]
const isBuiltinId = (id: string): id is BuiltinAddon => (BUILTIN_ADDONS as readonly string[]).includes(id)

/**
 * The addons that come with Nyerk and start switched on, until the user switches them. Only the app
 * says so: an addon in the user's folder never starts on, whatever its id. Every other addon starts
 * off, the PvP Log included since the Task List came (main/builtins.ts keeps it on for those who
 * already used it).
 */
export const DEFAULT_ON_ADDONS: readonly string[] = ['timers', 'task-list']

/**
 * Whether an addon is on: the user's choice (`Settings.addons.enabled`), else whether it came with
 * Nyerk (`bundled`) and is one of DEFAULT_ON_ADDONS.
 */
export const addonOn = (enabled: Record<string, boolean>, id: string, bundled: boolean): boolean =>
  enabled[id] ?? (bundled && DEFAULT_ON_ADDONS.includes(id))

/** Whether a built-in addon is on (they always come with Nyerk). */
export const builtinOn = (enabled: Record<string, boolean>, id: BuiltinAddon): boolean => addonOn(enabled, id, true)

export const isAddonId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/**
 * What addons hear of the app's own events, by the broadcast they come from: the name `nyerk.on`
 * takes and the permission it needs. `settings` (the addon's own) needs none.
 */
export const ADDON_EVENTS = {
  'tracker:status': { name: 'status', permission: 'events:status' },
  'tracker:pets': { name: 'pets', permission: 'events:pets' },
  'tracker:pet': { name: 'pet', permission: 'events:pets' },
  'tracker:soul': { name: 'soul', permission: 'events:soul' },
  'tracker:nearby': { name: 'nearby', permission: 'events:nearby' },
  'tracker:combat': { name: 'combat', permission: 'events:combat' },
  'tracker:shop': { name: 'shop', permission: 'events:shop' },
  'tracker:kina': { name: 'kina', permission: 'events:kina' },
  'tracker:fieldBosses': { name: 'fieldBosses', permission: 'events:fieldBosses' },
  'tracker:pvp': { name: 'pvp', permission: 'events:pvp' },
  'tracker:pvpKill': { name: 'pvpKill', permission: 'events:pvp' },
  'timers:alert': { name: 'timerAlert', permission: 'events:timers' },
  'timers:state': { name: 'timers', permission: 'events:timers' },
} as const satisfies Record<string, { name: string; permission: AddonPermission }>

/** Names an addon's Python part may not emit under: they are the app's. */
export const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([...Object.values(ADDON_EVENTS).map((e) => e.name), 'settings', 'hud', 'storage'])

/** A setting an addon declares; the Settings tab draws it under the addon. */
export type AddonSettingDef =
  | { key: string; label: string; hint: string | null; type: 'toggle'; default: boolean }
  | { key: string; label: string; hint: string | null; type: 'slider'; default: number; min: number; max: number; step: number }
  | { key: string; label: string; hint: string | null; type: 'select'; default: string; options: { value: string; label: string }[] }
  | { key: string; label: string; hint: string | null; type: 'text'; default: string }

export type AddonSettingValue = boolean | number | string
const SETTING_KEY = /^[A-Za-z0-9_-]{1,40}$/
export const isSettingKey = (v: unknown): v is string => typeof v === 'string' && SETTING_KEY.test(v)
const MAX_TEXT_SETTING = 200

function settingDef(v: unknown): AddonSettingDef | string {
  const d = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const key = d['key']
  const label = text(d['label'], 40)
  if (!isSettingKey(key) || !label) return 'each setting needs a key (letters, digits, - and _) and a label'
  const base = { key, label, hint: text(d['hint'], 200) }
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  switch (d['type']) {
    case 'toggle':
      return { ...base, type: 'toggle', default: d['default'] === true }
    case 'slider': {
      const { min, max } = d
      if (!finite(min) || !finite(max) || min >= max) return `setting ${key}: a slider needs a min below its max`
      const step = finite(d['step']) && d['step'] > 0 ? d['step'] : 1
      const def = finite(d['default']) ? Math.min(max, Math.max(min, d['default'])) : min
      return { ...base, type: 'slider', min, max, step, default: def }
    }
    case 'select': {
      const options = (Array.isArray(d['options']) ? d['options'] : [])
        .map((o) => (typeof o === 'string' ? { value: o, label: o } : ((o ?? {}) as Record<string, unknown>)))
        .map((o) => ({ value: text(o['value'], 60), label: text(o['label'], 60) ?? text(o['value'], 60) }))
        .filter((o): o is { value: string; label: string } => o.value !== null && o.label !== null)
      if (!options.length) return `setting ${key}: a select needs options`
      const def = options.some((o) => o.value === d['default']) ? (d['default'] as string) : options[0]!.value
      return { ...base, type: 'select', options, default: def }
    }
    case 'text':
      return { ...base, type: 'text', default: typeof d['default'] === 'string' ? d['default'].slice(0, MAX_TEXT_SETTING) : '' }
  }
  return `setting ${key}: its type must be toggle, slider, select or text`
}

/** One value for a declared setting, or its default when it is not one. */
export function settingValue(def: AddonSettingDef, v: unknown): AddonSettingValue {
  switch (def.type) {
    case 'toggle':
      return typeof v === 'boolean' ? v : def.default
    case 'slider':
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(def.max, Math.max(def.min, v)) : def.default
    case 'select':
      return def.options.some((o) => o.value === v) ? (v as string) : def.default
    case 'text':
      return typeof v === 'string' ? v.slice(0, MAX_TEXT_SETTING) : def.default
  }
}

/** Every declared setting's value: what is stored where it is valid, the default otherwise. */
export function settingValues(defs: AddonSettingDef[], stored: Record<string, unknown> | undefined): Record<string, AddonSettingValue> {
  return Object.fromEntries(defs.map((d) => [d.key, settingValue(d, stored?.[d.key])]))
}

export interface AddonManifest {
  id: string
  name: string
  version: string
  author: string | null
  description: string | null
  /** The range of ADDON_API_VERSION it was written for. */
  nyerk: string
  /** Paths inside the addon's folder, with forward slashes. */
  sidecar: string | null
  background: string | null
  /** `icon`: an .svg, the tab's face in the panel, drawn in the tab's colour (1.3). */
  tab: { label: string; page: string; icon: string | null } | null
  /**
   * A page drawn in the HUD. `widthSetting` names a slider controlling the outer frame width;
   * `frameSetting` names a toggle that hides or shows the frame chrome.
   */
  hud: { page: string; widthSetting: string | null; frameSetting: string | null } | null
  permissions: AddonPermission[]
  /** Origins its web parts may connect to (`https://host[:port]`). */
  network: string[]
  settings: AddonSettingDef[]
  /** Its work is done by the app's own code (one of BUILTIN_ADDONS, included with Nyerk only). */
  builtin: boolean
}

export type ManifestResult =
  | { ok: true; manifest: AddonManifest }
  | { ok: false; incompatible: boolean; problem: string; id: string | null; name: string | null; version: string | null }

/**
 * Whether `version` is in `range`: `*`, `^1` / `^1.2` / `^1.2.3` (same major, at least that),
 * `>=1.2.0`, or an exact version.
 */
export function satisfies(range: string, version: string): boolean {
  const r = range.trim()
  if (r === '*') return true
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(r)
  if (caret) {
    const floor = `${caret[1]}.${caret[2] ?? 0}.${caret[3] ?? 0}`
    return Number.parseInt(version, 10) === Number(caret[1]) && compareVersions(version, floor) >= 0
  }
  const atLeast = /^>=\s*(\d+\.\d+\.\d+)$/.exec(r)
  if (atLeast) return compareVersions(version, atLeast[1]!) >= 0
  return VERSION.test(r) && compareVersions(version, r) === 0
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/** A path inside the addon's folder, with forward slashes; null when it would leave it. */
export function addonPath(v: unknown, extension: string): string | null {
  if (typeof v !== 'string') return null
  const path = v.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || !path.toLowerCase().endsWith(extension)) return null
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return path
}

function origin(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    const url = new URL(v)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Read a manifest.json. Its problems are worded for the Settings tab. `bundled`: it came with Nyerk
 * (app/addons/), so it may be built in.
 */
export function parseManifest(source: string, api: string = ADDON_API_VERSION, bundled = false): ManifestResult {
  let raw: unknown
  try {
    // Notepad and PowerShell save UTF-8 with a byte order mark, which JSON.parse refuses.
    raw = JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, incompatible: false, problem: 'manifest.json is not valid JSON', id: null, name: null, version: null }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, incompatible: false, problem: 'manifest.json is not an object', id: null, name: null, version: null }
  }
  const m = raw as Record<string, unknown>
  const id = isAddonId(m['id']) ? m['id'] : null
  const name = text(m['name'], 60)
  const version = typeof m['version'] === 'string' && VERSION.test(m['version']) ? m['version'] : null
  const fail = (problem: string, incompatible = false): ManifestResult => ({ ok: false, incompatible, problem, id, name, version })

  if (!id) return fail('its id must be lowercase letters, digits and dashes')
  if (!name) return fail('it has no name')
  if (!version) return fail('its version must look like 1.0.0')
  const range = text(m['nyerk'], 40)
  if (!range) return fail('it does not say which Nyerk it is for ("nyerk": "^1")')
  if (!satisfies(range, api)) return fail(`it is for Nyerk addons ${range}; this version has ${api}`, true)

  const sidecar = m['sidecar'] === undefined ? null : addonPath(m['sidecar'], '.py')
  if (m['sidecar'] !== undefined && !sidecar) return fail('its sidecar must be a .py file inside its folder')
  const background = m['background'] === undefined ? null : addonPath(m['background'], '.js')
  if (m['background'] !== undefined && !background) return fail('its background must be a .js file inside its folder')

  let tab: AddonManifest['tab'] = null
  if (m['tab'] !== undefined) {
    const t = (typeof m['tab'] === 'object' && m['tab'] !== null ? m['tab'] : {}) as Record<string, unknown>
    const label = text(t['label'], 20)
    const page = addonPath(t['page'], '.html')
    if (!label || !page) return fail('its tab needs a label and an .html page inside its folder')
    const icon = t['icon'] === undefined ? null : addonPath(t['icon'], '.svg')
    if (t['icon'] !== undefined && !icon) return fail("its tab's icon must be an .svg file inside its folder")
    tab = { label, page, icon }
  }
  let hud: AddonManifest['hud'] = null
  if (m['hud'] !== undefined) {
    const h = (typeof m['hud'] === 'object' && m['hud'] !== null ? m['hud'] : {}) as Record<string, unknown>
    const page = addonPath(h['page'], '.html')
    if (!page) return fail('its hud needs an .html page inside its folder')
    const widthSetting = h['widthSetting'] === undefined ? null : isSettingKey(h['widthSetting']) ? h['widthSetting'] : null
    if (h['widthSetting'] !== undefined && !widthSetting) return fail("its HUD widthSetting must name one of its slider settings")
    const frameSetting = h['frameSetting'] === undefined ? null : isSettingKey(h['frameSetting']) ? h['frameSetting'] : null
    if (h['frameSetting'] !== undefined && !frameSetting) return fail("its HUD frameSetting must name one of its toggle settings")
    hud = { page, widthSetting, frameSetting }
  }
  const builtin = m['builtin'] === true
  if (m['builtin'] !== undefined && !builtin) return fail('its builtin must be true when it is there')
  if (builtin && !bundled) return fail('only the addons included with Nyerk can be built in')
  if (builtin && !isBuiltinId(id)) return fail(`Nyerk has no built-in feature called ${id}`)
  if (builtin && (sidecar || background || tab || hud)) return fail("a built-in addon runs the app's own code: no sidecar, background, tab or hud")
  if (!sidecar && !background && !tab && !hud && !builtin) return fail('it has nothing to run: no sidecar, background, tab or hud')

  const permissions: AddonPermission[] = []
  for (const p of Array.isArray(m['permissions']) ? m['permissions'] : m['permissions'] === undefined ? [] : [null]) {
    if (typeof p !== 'string' || !(p in ADDON_PERMISSIONS)) return fail(`unknown permission ${JSON.stringify(p)}`)
    if (!permissions.includes(p as AddonPermission)) permissions.push(p as AddonPermission)
  }
  const network: string[] = []
  for (const n of Array.isArray(m['network']) ? m['network'] : m['network'] === undefined ? [] : [null]) {
    const o = origin(n)
    if (!o) return fail(`network entries must be https:// origins, not ${JSON.stringify(n)}`)
    if (!network.includes(o)) network.push(o)
  }

  const settings: AddonSettingDef[] = []
  const declared = m['settings'] === undefined ? [] : m['settings']
  if (!Array.isArray(declared) || declared.length > 20) return fail('its settings must be a list of at most 20')
  for (const d of declared) {
    const def = settingDef(d)
    if (typeof def === 'string') return fail(def)
    if (settings.some((x) => x.key === def.key)) return fail(`setting ${def.key} is declared twice`)
    settings.push(def)
  }
  const widthSetting = hud?.widthSetting
  if (widthSetting && !settings.some((s) => s.key === widthSetting && s.type === 'slider')) {
    return fail(`its HUD widthSetting ${widthSetting} must name a slider setting`)
  }
  const frameSetting = hud?.frameSetting
  if (frameSetting && !settings.some((s) => s.key === frameSetting && s.type === 'toggle')) {
    return fail(`its HUD frameSetting ${frameSetting} must name a toggle setting`)
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      author: text(m['author'], 60),
      description: text(m['description'], 300),
      nyerk: range,
      sidecar,
      background,
      tab,
      hud,
      permissions,
      network,
      settings,
      builtin,
    },
  }
}

/** One addon as the Settings tab shows it. */
export interface AddonInfo {
  /** Its folder's name, under the addons folder. */
  folder: string
  id: string | null
  name: string
  version: string | null
  author: string | null
  description: string | null
  /** off/on: the user's choice; incompatible: for another addon API; invalid: cannot be read. */
  state: 'off' | 'on' | 'incompatible' | 'invalid'
  problem: string | null
  /** Found since the last reload, never switched on or off before. */
  isNew: boolean
  /** It has a Python part: it runs inside the tracker, with full access. */
  native: boolean
  permissions: AddonPermission[]
  network: string[]
  /** The panel tab it adds, if any. */
  tab: { label: string; page: string; icon: string | null } | null
  /**
   * Its HUD section, if any; whether it is shown, and detached into a window of its own (its page
   * switches both: nyerk.hud.show, nyerk.hud.detach).
   */
  hud: { page: string; widthSetting: string | null; frameSetting: string | null } | null
  hudShown: boolean
  hudDetached: boolean
  /** Its background script, if any. */
  background: string | null
  /** Its Python part, if any (inside its folder). */
  sidecar: string | null
  settings: AddonSettingDef[]
  /** Its settings' values (the defaults where none is stored). */
  values: Record<string, AddonSettingValue>
  /** What went wrong while it ran (set by main, cleared by a reload). */
  error: string | null
  /** It came with Nyerk (app/addons/), not from the addons folder. */
  bundled: boolean
  /** Its work is done by the app's own code (BUILTIN_ADDONS). */
  builtin: boolean
}

export interface AddonsStatus {
  /** The addons folder. */
  folder: string
  addons: AddonInfo[]
  /** The folder has changed since the last scan: a reload would find something new. */
  changed: boolean
  /** Counts reloads: the windows build their addon frames again when it moves. */
  generation: number
}

/** One marker an addon puts on the Collection Map (`nyerk.map.markers`, the `map` permission, 1.4). */
export interface AddonMapMarker {
  /** The zone, as the app's `nearby.world`. */
  world: number
  /** The map data's coordinates, as `nearby.position`. */
  position: [number, number]
  /** `#rgb` or `#rrggbb`. */
  color: string
  /** Shown on hover. */
  label: string | null
}

/** The markers each addon has on the map, with its name for the map's key. */
export interface AddonMarkers {
  addon: string
  name: string
  markers: AddonMapMarker[]
}

/** At most this many markers per addon: more are dropped. */
export const MAX_MAP_MARKERS = 2000
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * The markers an addon asked for, as the map draws them: anything that is not one is left out
 * (a bad colour falls back to the accent), and only the first MAX_MAP_MARKERS are kept.
 */
export function mapMarkers(v: unknown): AddonMapMarker[] {
  const out: AddonMapMarker[] = []
  for (const item of Array.isArray(v) ? v : []) {
    if (out.length >= MAX_MAP_MARKERS) break
    const m = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const world = m['world']
    const at = m['position']
    if (!Number.isInteger(world) || !Array.isArray(at) || at.length !== 2) continue
    const [x, y] = at as unknown[]
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    const color = typeof m['color'] === 'string' && COLOR.test(m['color']) ? m['color'] : '#a3acff'
    out.push({ world: world as number, position: [x, y], color, label: text(m['label'], 80) })
  }
  return out
}

/** Main to an addon's frames: one of its events. */
export interface AddonEvent {
  addon: string
  name: string
  data: unknown
}

/** A folder found under the addons folder: its manifest's text, or why there is none. */
export interface FoundFolder {
  folder: string
  manifest: string | null
  error?: string
}

/**
 * Every folder found, as addons: their state from the user's choices (`enabled`, by id), the first
 * folder with an id winning over later ones (by name), and the files each names checked with
 * `exists(folder, path)`. `bundled`: these folders came with Nyerk (app/addons/), so they may be
 * built in, and are never new.
 */
export function resolveAddons(
  found: FoundFolder[],
  enabled: Record<string, boolean>,
  exists: (folder: string, path: string) => boolean,
  api: string = ADDON_API_VERSION,
  stored: Record<string, Record<string, unknown>> = {},
  bundled = false,
): AddonInfo[] {
  const taken = new Map<string, string>()
  const out: AddonInfo[] = []
  for (const f of [...found].sort((a, b) => a.folder.localeCompare(b.folder))) {
    const blank: AddonInfo = {
      folder: f.folder,
      id: null,
      name: f.folder,
      version: null,
      author: null,
      description: null,
      state: 'invalid',
      problem: null,
      isNew: false,
      native: false,
      permissions: [],
      network: [],
      tab: null,
      hud: null,
      hudShown: false,
      hudDetached: false,
      background: null,
      sidecar: null,
      settings: [],
      values: {},
      error: null,
      bundled,
      builtin: false,
    }
    if (f.manifest === null) {
      out.push({ ...blank, problem: f.error ?? `there is no ${MANIFEST_FILE} in it` })
      continue
    }
    const parsed = parseManifest(f.manifest, api, bundled)
    if (!parsed.ok) {
      out.push({
        ...blank,
        id: parsed.id,
        name: parsed.name ?? f.folder,
        version: parsed.version,
        state: parsed.incompatible ? 'incompatible' : 'invalid',
        problem: parsed.problem,
      })
      continue
    }
    const m = parsed.manifest
    const info: AddonInfo = {
      ...blank,
      id: m.id,
      name: m.name,
      version: m.version,
      author: m.author,
      description: m.description,
      native: m.sidecar !== null,
      permissions: m.permissions,
      network: m.network,
      tab: m.tab,
      hud: m.hud,
      background: m.background,
      sidecar: m.sidecar,
      settings: m.settings,
      values: settingValues(m.settings, stored[m.id]),
      builtin: m.builtin,
    }
    const missing = [m.sidecar, m.background, m.tab?.page, m.tab?.icon, m.hud?.page].find((p) => p && !exists(f.folder, p))
    const twin = taken.get(m.id)
    if (twin) {
      out.push({ ...info, state: 'invalid', problem: `the folder ${twin} has the same id (${m.id})` })
    } else if (missing) {
      taken.set(m.id, f.folder)
      out.push({ ...info, state: 'invalid', problem: `${missing} is missing` })
    } else {
      taken.set(m.id, f.folder)
      out.push({ ...info, state: addonOn(enabled, m.id, bundled) ? 'on' : 'off', isNew: !bundled && !(m.id in enabled) })
    }
  }
  return out
}
