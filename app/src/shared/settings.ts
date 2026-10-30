/**
 * Persisted settings: typed, with defaults, and normalised at the IPC boundary so a hand-edited
 * file or a renderer bug can never store something the app then trips over.
 */

import {
  DEFAULT_SOUND,
  defaultShown,
  isAlarmSound,
  leadChoices,
  REGIONS,
  TIMERS,
  type AlarmSound,
  type RegionSetting,
  type TimerId,
} from './timers.ts'
import { isAddonId, isSettingKey } from './addons.ts'

export interface Point {
  x: number
  y: number
}

/** The shapes a map marker can take. */
export const MARK_SHAPES = ['circle', 'square', 'diamond', 'triangle'] as const
export type MarkShape = (typeof MARK_SHAPES)[number]
/** A marker's look picked on the Collection Map; null keeps the map's own (its colour, its shape). */
export interface MarkStyle {
  color: string | null
  shape: MarkShape | null
}
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export interface Settings {
  /** Where the floating icon sits, in screen DIPs; null = bottom right of the primary display. */
  bubble: Point | null
  /** Panel size (its outer edges drag it bigger); its position follows the bubble. */
  panel: { width: number; height: number }
  /** Keep the panel above the game while it is open. */
  panelOnTop: boolean

  hud: {
    enabled: boolean
    /** Top-left in screen DIPs; null = top right of the primary display. */
    position: Point | null
    /** 'recent': pets that gained souls this session; 'pinned': the pets pinned in the panel. */
    mode: 'recent' | 'pinned'
    /** The Nearby section at the top: soul monsters around you, by the pet they drop. */
    nearby: boolean
    /** How many pets the Nearby section lists. */
    nearbyCount: number
    pinned: number[]
    /** How many recent pets 'recent' shows. */
    recentCount: number
    toasts: boolean
    opacity: number
    scale: number
    /** Hide the HUD when no game traffic has been seen for a while. */
    hideWithoutGame: boolean
    /**
     * Seconds without a kill, soul or crystal before the HUD clears itself and hides until the
     * next fight; 0 = never.
     */
    idleHideSeconds: number
    /** Pop up the Black Cloud Merchant's pets worth buying when one of its tabs is opened. */
    merchant: boolean
    /** This session's Kina per hour, at the top right. */
    kina: boolean
  }

  /** Where the Black Cloud Merchant window sits (top-left, screen DIPs); null = top centre. */
  merchantWindow: Point | null

  /**
   * The map window (a pet's drop locations, the collection's map): its size, and where (null =
   * centred); and the size of the collection's map as a minimap.
   */
  mapWindow: { position: Point | null; width: number; height: number; minimap: { width: number; height: number } }

  /**
   * The Collection Map's markers as you styled them: each pet's spawns by pet id, and each kind of
   * addon marker by `<addon id>/<label>` (Nearby Nodes' "Odyle"). Only the ones you changed.
   */
  mapStyles: { pets: Record<string, MarkStyle>; marks: Record<string, MarkStyle> }

  /** The Collection Map opens following you (the crosshair on), until its crosshair turns that off. */
  mapFollow: boolean

  /** The kill feed window (PvP Log → Open HUD): open, and where (null = top right). */
  killFeed: { open: boolean; position: Point | null }

  /** Hide every overlay window from screenshots, OBS and Discord (WDA_EXCLUDEFROMCAPTURE). */
  hideFromCapture: boolean

  /** Your side: its zones are listed first where a soul drops. */
  faction: 'elyos' | 'asmodians'
  /** Your level, to point out monsters close enough to it for souls to drop well; null = unset. */
  playerLevel: number | null

  /** Look for a new version 30 s after start and every 6 hours (installed builds only). */
  autoUpdateCheck: boolean

  /** The Timers tab: which events alert, and how (a chime; the bubble shaking). */
  timers: {
    /** The server region: weekly events are at its own local time. 'auto': the character's
     *  server's (resolveRegion). */
    region: RegionSetting
    /** The region was chosen by hand: an older install's saved one (always NA East unless
     *  changed) becomes 'auto' once, a choice made since is kept. */
    regionChosen: boolean
    enabled: Record<TimerId, boolean>
    /** Minutes before each start to alert. */
    lead: Record<TimerId, number>
    /** The sound each timer's alert plays. */
    sounds: Record<TimerId, AlarmSound>
    sound: boolean
    /** 0..1 */
    volume: number
    shake: boolean
    /** Share field boss timers: send what your map shows, get what other players' maps show. */
    share: boolean
    /** Listed in the Timers tab; only these alert. */
    shown: Record<TimerId, boolean>
  }

  /** Leave pets at the cap (Lv3: no more souls) out of the collection, Nearby and the HUD. */
  hideMaxed: boolean

  /**
   * While Aion 2 is not running: no bubble, no HUD, no capture, only the tray icon. Everything
   * comes back when the game starts.
   */
  sleepWithoutGame: boolean

  /**
   * More in tracker.log for troubleshooting: the game stream's health every 30 s, and the game
   * connection recorded to a .pcap in the logs folder (the newest 3 kept) for a player to send.
   */
  debugLogging: boolean

  tracker: {
    /** The Python interpreter; empty = the repo's .venv. */
    python: string
    /** The collection file; empty = <userData>/collection.json. */
    dataFile: string
  }

  /**
   * Addons (shared/addons.ts): on or off, by id (an id first found is recorded as off), and the
   * values of the settings each declares, and each one's HUD section: shown or not, in the HUD or
   * detached into its own window, and where that window was put.
   */
  addons: { enabled: Record<string, boolean>; values: Record<string, Record<string, boolean | number | string>>; hud: Record<string, AddonHudPlace> }
}

/** An addon's HUD section (shared/addons.ts): its page shows it, and may detach it into a window of its own. */
export interface AddonHudPlace {
  shown: boolean
  detached: boolean
  position: Point | null
}

export type SettingKey = keyof Settings

/** How small and large the panel can be dragged. */
export const PANEL_MIN = { width: 340, height: 360 }
export const PANEL_MAX = { width: 1200, height: 1400 }
/** How small the map window can be dragged: room for the monster list beside a map. */
export const MAP_MIN = { width: 640, height: 420 }
/** How small the collection's map can be dragged as a minimap: only the map. */
export const MINIMAP_MIN = { width: 160, height: 160 }

export const SETTINGS_DEFAULTS: Settings = {
  bubble: null,
  panel: { width: 420, height: 560 },
  panelOnTop: true,
  hud: {
    enabled: true,
    position: null,
    mode: 'recent',
    nearby: true,
    nearbyCount: 3,
    pinned: [],
    recentCount: 3,
    toasts: true,
    opacity: 0.92,
    scale: 1,
    hideWithoutGame: true,
    idleHideSeconds: 45,
    merchant: true,
    kina: true,
  },
  merchantWindow: null,
  mapWindow: { position: null, width: 900, height: 640, minimap: { width: 320, height: 320 } },
  killFeed: { open: false, position: null },
  mapStyles: { pets: {}, marks: {} },
  mapFollow: true,
  hideFromCapture: false,
  faction: 'elyos',
  playerLevel: null,
  autoUpdateCheck: true,
  hideMaxed: true,
  timers: {
    region: 'auto',
    regionChosen: false,
    enabled: Object.fromEntries(TIMERS.map((t) => [t.id, t.defaultOn])) as Record<TimerId, boolean>,
    lead: Object.fromEntries(TIMERS.map((t) => [t.id, t.lead])) as Record<TimerId, number>,
    sounds: Object.fromEntries(TIMERS.map((t) => [t.id, DEFAULT_SOUND])) as Record<TimerId, AlarmSound>,
    sound: true,
    volume: 0.5,
    shake: true,
    share: true,
    shown: Object.fromEntries(TIMERS.map((t) => [t.id, defaultShown(t)])) as Record<TimerId, boolean>,
  },
  sleepWithoutGame: true,
  debugLogging: false,
  tracker: { python: '', dataFile: '' },
  addons: { enabled: {}, values: {}, hud: {} },
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const point = (v: unknown): Point | null => {
  const p = v as Partial<Point> | null
  return p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)
    ? { x: Math.round(p.x), y: Math.round(p.y) }
    : null
}

/** Coerce one setting to a valid value, falling back to the default for anything malformed. */
export function normalise<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  const d = SETTINGS_DEFAULTS
  switch (key) {
    case 'bubble':
    case 'merchantWindow':
      return point(value) as Settings[K]
    case 'killFeed': {
      const v = (value ?? {}) as Partial<Settings['killFeed']>
      return { open: bool(v.open, d.killFeed.open), position: point(v.position) } as Settings[K]
    }
    case 'mapWindow': {
      const v = (value ?? {}) as Partial<Settings['mapWindow']>
      return {
        position: point(v.position),
        width: Math.round(num(v.width, MAP_MIN.width, 2400, d.mapWindow.width)),
        height: Math.round(num(v.height, MAP_MIN.height, 1600, d.mapWindow.height)),
        minimap: {
          width: Math.round(num(v.minimap?.width, MINIMAP_MIN.width, 1200, d.mapWindow.minimap.width)),
          height: Math.round(num(v.minimap?.height, MINIMAP_MIN.height, 1200, d.mapWindow.minimap.height)),
        },
      } as Settings[K]
    }
    case 'panel': {
      const v = (value ?? {}) as Partial<Settings['panel']>
      return {
        width: Math.round(num(v.width, PANEL_MIN.width, PANEL_MAX.width, d.panel.width)),
        height: Math.round(num(v.height, PANEL_MIN.height, PANEL_MAX.height, d.panel.height)),
      } as Settings[K]
    }
    case 'panelOnTop':
    case 'hideFromCapture':
    case 'mapFollow':
    case 'autoUpdateCheck':
    case 'hideMaxed':
    case 'sleepWithoutGame':
    case 'debugLogging':
      return bool(value, d[key] as boolean) as Settings[K]
    case 'hud': {
      const v = (value ?? {}) as Partial<Settings['hud']>
      return {
        enabled: bool(v.enabled, d.hud.enabled),
        position: point(v.position),
        // 'nearby' was a mode before it became its own section (0.1.3).
        mode: v.mode === 'pinned' ? 'pinned' : 'recent',
        nearby: bool(v.nearby, d.hud.nearby),
        nearbyCount: Math.round(num(v.nearbyCount, 1, 8, d.hud.nearbyCount)),
        pinned: Array.isArray(v.pinned) ? [...new Set(v.pinned.filter((n) => Number.isInteger(n)))].slice(0, 12) : [],
        recentCount: Math.round(num(v.recentCount, 1, 8, d.hud.recentCount)),
        toasts: bool(v.toasts, d.hud.toasts),
        opacity: num(v.opacity, 0.3, 1, d.hud.opacity),
        scale: num(v.scale, 0.75, 1.75, d.hud.scale),
        hideWithoutGame: bool(v.hideWithoutGame, d.hud.hideWithoutGame),
        idleHideSeconds: Math.round(num(v.idleHideSeconds, 0, 600, d.hud.idleHideSeconds)),
        merchant: bool(v.merchant, d.hud.merchant),
        kina: bool(v.kina, d.hud.kina),
      } as Settings[K]
    }
    case 'timers': {
      const v = (value ?? {}) as Partial<Settings['timers']>
      const on = (v.enabled ?? {}) as Partial<Record<TimerId, unknown>>
      const lead = (v.lead ?? {}) as Partial<Record<TimerId, unknown>>
      const sounds = (v.sounds ?? {}) as Partial<Record<TimerId, unknown>>
      return {
        // A region older installs saved (before Automatic, always NA East unless changed) is
        // dropped for 'auto' once; one picked by hand since (regionChosen) is kept.
        region:
          v.regionChosen === true && REGIONS.some((r) => r.id === v.region) ? (v.region as RegionSetting) : d.timers.region,
        regionChosen: v.regionChosen === true && REGIONS.some((r) => r.id === v.region),
        enabled: Object.fromEntries(TIMERS.map((t) => [t.id, bool(on[t.id], t.defaultOn)])) as Record<TimerId, boolean>,
        // One of the leads offered for that timer; anything else falls back to its default.
        lead: Object.fromEntries(
          TIMERS.map((t) => [t.id, leadChoices(t).includes(lead[t.id] as number) ? (lead[t.id] as number) : t.lead]),
        ) as Record<TimerId, number>,
        sounds: Object.fromEntries(
          TIMERS.map((t) => [t.id, isAlarmSound(sounds[t.id]) ? sounds[t.id] : DEFAULT_SOUND]),
        ) as Record<TimerId, AlarmSound>,
        sound: bool(v.sound, d.timers.sound),
        volume: num(v.volume, 0, 1, d.timers.volume),
        shake: bool(v.shake, d.timers.shake),
        share: bool(v.share, d.timers.share),
        shown: Object.fromEntries(
          TIMERS.map((t) => [t.id, bool((v.shown as Partial<Record<TimerId, unknown>> | undefined)?.[t.id], defaultShown(t))]),
        ) as Record<TimerId, boolean>,
      } as Settings[K]
    }
    case 'faction':
      return (value === 'asmodians' ? 'asmodians' : 'elyos') as Settings[K]
    case 'playerLevel':
      return (typeof value === 'number' && Number.isFinite(value) ? Math.round(num(value, 1, 99, 1)) : null) as Settings[K]
    case 'tracker': {
      const v = (value ?? {}) as Partial<Settings['tracker']>
      return {
        python: typeof v.python === 'string' ? v.python.trim() : '',
        dataFile: typeof v.dataFile === 'string' ? v.dataFile.trim() : '',
      } as Settings[K]
    }
    case 'mapStyles': {
      const v = (value ?? {}) as Partial<Settings['mapStyles']>
      const styles = (from: unknown, key: (k: string) => boolean): Record<string, MarkStyle> =>
        Object.fromEntries(
          Object.entries(typeof from === 'object' && from !== null ? from : {})
            .filter(([k, st]) => key(k) && typeof st === 'object' && st !== null)
            .map(([k, st]): [string, MarkStyle] => {
              const x = st as Partial<MarkStyle>
              return [
                k,
                {
                  color: typeof x.color === 'string' && HEX_COLOR.test(x.color) ? x.color.toLowerCase() : null,
                  shape: MARK_SHAPES.includes(x.shape as MarkShape) ? (x.shape as MarkShape) : null,
                },
              ]
            })
            // A style with neither picked is the map's own: not kept.
            .filter(([, st]) => st.color !== null || st.shape !== null)
            .slice(0, 1000),
        )
      return {
        pets: styles(v.pets, (k) => /^\d{1,10}$/.test(k)),
        marks: styles(v.marks, (k) => k.length <= 140 && /^[a-z0-9][a-z0-9-]{0,39}\//.test(k)),
      } as Settings[K]
    }
    case 'addons': {
      const v = (value ?? {}) as Partial<Settings['addons']>
      const enabled = typeof v.enabled === 'object' && v.enabled !== null ? v.enabled : {}
      const values = typeof v.values === 'object' && v.values !== null ? v.values : {}
      const hud = typeof v.hud === 'object' && v.hud !== null ? v.hud : {}
      // Checked against each addon's declarations where they are used; here only their shape.
      const primitive = (x: unknown): boolean => typeof x === 'boolean' || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))
      return {
        enabled: Object.fromEntries(Object.entries(enabled).filter(([id, on]) => isAddonId(id) && typeof on === 'boolean').slice(0, 200)),
        values: Object.fromEntries(
          Object.entries(values)
            .filter(([id, vals]) => isAddonId(id) && typeof vals === 'object' && vals !== null)
            .slice(0, 200)
            .map(([id, vals]) => [id, Object.fromEntries(Object.entries(vals).filter(([k, x]) => isSettingKey(k) && primitive(x)).slice(0, 40))]),
        ),
        hud: Object.fromEntries(
          Object.entries(hud)
            .filter(([id, h]) => isAddonId(id) && typeof h === 'object' && h !== null)
            .slice(0, 200)
            .map(([id, h]) => {
              const x = h as Partial<AddonHudPlace>
              return [id, { shown: x.shown === true, detached: x.detached === true, position: point(x.position) }]
            }),
        ),
      } as Settings[K]
    }
  }
  return d[key]
}
