/**
 * The IPC contract: every channel, its arguments and its result, in one place. Main registers
 * handlers against it, preload builds the bridge from it, the renderer calls the bridge. The
 * pattern is marnis-app's (shared/ipc-contract.ts), with this app's channels.
 */
import type { AddonEvent, AddonMarkers, AddonsStatus } from './addons.ts'
import type { KinaSession } from './kina.ts'
import type { Point, SettingKey, Settings } from './settings.ts'
import type { AlarmSound, FieldBosses, TimerAlert, TimerId, TimersState } from './timers.ts'
import type { Nearby, Pet, PvpKill, ShopStock, SoulToast, TrackerStatus } from './tracker.ts'
import type { UpdateStatus } from './update.ts'

/** What the map window shows: a pet's drop locations, or the collection's map (as a minimap: from the HUD). */
export type MapView = { kind: 'pet'; pet: number } | { kind: 'collection'; minimap?: boolean }

/** The Collection tab's search, sort and filter pills (stores/app.ts), for the map window's copy. */
export interface CollectionView {
  query: string
  sort: string
  filter: string[]
  genus: string[]
  continent: string[]
  continentOnly: boolean
}

/** The panel's edges away from the bubble: the ones it grows from. */
export interface PanelEdges {
  x: 'left' | 'right'
  y: 'top' | 'bottom'
}

/** Renderer → main, request/response. */
export interface InvokeChannels {
  'app:info': { args: []; result: { version: string; settingsFile: string; logFile: string } }
  'app:quit': { args: []; result: void }
  'app:openPath': { args: [path: string]; result: void }

  'settings:all': { args: []; result: Settings }
  'settings:set': { args: [key: SettingKey, value: unknown]; result: void }

  'tracker:get': { args: []; result: { status: TrackerStatus; pets: Pet[]; nearby: Nearby; shop: ShopStock[]; kina: KinaSession; fieldBosses: FieldBosses; pvp: PvpKill[] } }
  'tracker:setSouls': { args: [pet: number, souls: number]; result: void }
  'tracker:setName': { args: [pet: number, name: string]; result: void }
  'tracker:restart': { args: []; result: void }
  /** Start the session again: its souls and its Kina. */
  'tracker:resetSession': { args: []; result: void }
  /** Empty the PvP Log. */
  'tracker:clearPvp': { args: []; result: void }

  'update:get': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: void }
  'update:download': { args: []; result: void }
  'update:install': { args: []; result: void }

  'bubble:moveTo': { args: [to: Point]; result: void }
  'bubble:dragEnd': { args: []; result: void }
  'panel:toggle': { args: []; result: void }
  'panel:hide': { args: []; result: void }
  /** The panel's outer edges (away from the bubble), where its resize grips go. */
  'panel:edges': { args: []; result: PanelEdges }
  /** Dragging a grip on the panel's outer edges: its new size, and (`end`) the drag is over (saved). */
  'panel:resize': { args: [size: { width: number; height: number }, end: boolean]; result: void }
  /** The panel's tab changed: kept in main so an update restart reopens it there. */
  'panel:tab': { args: [tab: string]; result: void }

  'hud:setEditing': { args: [editing: boolean]; result: void }
  'hud:moveTo': { args: [to: Point]; result: void }
  'hud:dragEnd': { args: []; result: void }
  'hud:resize': { args: [size: { width: number; height: number }]; result: void }
  /** The pointer is over (or left) one of the HUD's buttons: it takes the mouse only while it is. */
  'hud:hover': { args: [over: boolean]; result: void }
  /** An addon's detached HUD (windows.ts): moved, dropped (its place saved), sized to its content. */
  'addonHud:moveTo': { args: [id: string, to: Point]; result: void }
  'addonHud:dragEnd': { args: [id: string]; result: void }
  'addonHud:resize': { args: [id: string, size: { width: number; height: number }]; result: void }
  'merchant:moveTo': { args: [to: Point]; result: void }
  'merchant:dragEnd': { args: []; result: void }
  'merchant:resize': { args: [size: { width: number; height: number }]; result: void }
  'merchant:close': { args: []; result: void }
  /** The kill feed window: open or closed (PvP Log → Open HUD, its X), moved, sized to its content. */
  'killfeed:open': { args: []; result: void }
  'killfeed:close': { args: []; result: void }
  'killfeed:moveTo': { args: [to: Point]; result: void }
  'killfeed:dragEnd': { args: []; result: void }
  'killfeed:resize': { args: [size: { width: number; height: number }]; result: void }
  /** The timers alerting now; and dismissing them (a click on the bubble). */
  'timers:get': { args: []; result: TimerAlert[] }
  'timers:dismiss': { args: []; result: void }
  /** The resets and next starts, with the region they follow (as `timers:state` sends them). */
  'timers:state': { args: []; result: TimersState }
  /** The bubble was clicked during an alert: dismiss it and show its timer in the panel. */
  'timers:open': { args: []; result: void }
  /** Open the map window on a pet's drop locations, or on the collection's map. */
  'map:showPet': { args: [pet: number]; result: void }
  'map:showCollection': { args: []; result: void }
  /** From the HUD: the collection's map straight as a minimap, where the minimap last was. */
  'map:showMinimap': { args: []; result: void }
  /** The map window's page, as it loads: what to show, and the Collection tab's filters. */
  'map:get': { args: []; result: { view: MapView | null; collection: CollectionView | null } }
  'map:moveTo': { args: [to: Point]; result: void }
  'map:dragEnd': { args: []; result: void }
  'map:close': { args: []; result: void }
  /** The collection's map as a minimap (only the map, in a small window) or back to the full window. */
  'map:minimap': { args: [on: boolean]; result: void }
  /** The panel's Collection filters changed: passed on to the map window's collection map. */
  'collection:view': { args: [view: CollectionView]; result: void }

  /** The addons found in the addons folder (shared/addons.ts). */
  'addons:get': { args: []; result: AddonsStatus }
  /** Open the addons folder in Explorer (made first if it is not there). */
  'addons:openFolder': { args: []; result: void }
  /** Look at the addons folder again and restart what runs from it. */
  'addons:reload': { args: []; result: AddonsStatus }
  'addons:setEnabled': { args: [id: string, enabled: boolean]; result: void }
  'addons:setSetting': { args: [id: string, key: string, value: unknown]; result: void }
  /**
   * From an addon's frame, relayed by the window holding it (which knows the frame's origin, and
   * so the addon): what the SDK asks for. Main checks it against the addon's permissions.
   */
  'addons:call': { args: [id: string, method: string, args: unknown[]]; result: unknown }
  /** The markers the addons switched on have put on the Collection Map. */
  'addons:markers': { args: []; result: AddonMarkers[] }
}

/** Main → renderer, broadcast. */
export interface EventChannels {
  'settings:changed': Settings
  'tracker:status': TrackerStatus
  'tracker:pets': Pet[]
  'tracker:pet': Pet
  'tracker:soul': SoulToast
  'tracker:nearby': Nearby
  /** You killed something (at most every 5 s): keeps the HUD up between souls. */
  'tracker:combat': number
  /** The merchant's stock: the latest of each tab opened, until its restock. */
  'tracker:shop': ShopStock[]
  /** This session's Kina, whenever the balance changes. */
  'tracker:kina': KinaSession
  /** The field bosses, whenever the map's list changes them. */
  'tracker:fieldBosses': FieldBosses
  /** The PvP kill feed, whenever a kill is added (or it is cleared). */
  'tracker:pvp': PvpKill[]
  /** One new kill, appended to the list. */
  'tracker:pvpKill': PvpKill
  /** A timer started alerting (once per start: the chime). */
  'timers:alert': TimerAlert
  /** Every timer alerting now (the bubble shakes while there are any). */
  'timers:alerting': TimerAlert[]
  /** The next resets and timer starts, whenever one moves on (for addons: the `timers` event). */
  'timers:state': TimersState
  /** To the map window: show this. */
  'map:show': MapView
  /** To the map window: the Collection tab's filters, as they change. */
  'map:collectionView': CollectionView
  /** To the panel: show this tab (it was open on it before an update restart). */
  'panel:showTab': string
  /** To the panel: show the Timers tab and highlight these timers (the ones that alerted). */
  'panel:showTimers': TimerId[]
  'hud:editing': boolean
  'panel:visible': boolean
  /** The panel moved to the bubble's other side: its grips go to the new outer edges. */
  'panel:edges': PanelEdges
  'update:status': UpdateStatus
  /** The addons, after a reload or a switch, or when the folder changed (a reload would find more). */
  'addons:changed': AddonsStatus
  /** To an addon's frames (the windows pass it on to the frames of that addon only). */
  'addons:event': AddonEvent
  /** An addon asked for attention: the bubble chimes and pulses. */
  'addons:notify': { addon: string }
  /** An addon played one of the alert sounds (shared/timers.ts ALARM_SOUNDS): the bubble plays it. */
  'addons:sound': { addon: string; sound: AlarmSound }
  /** The addons' markers on the Collection Map, whenever one of them changes. */
  'addons:markers': AddonMarkers[]
}

export type InvokeChannel = keyof InvokeChannels
export type EventChannel = keyof EventChannels
export type InvokeArgs<C extends InvokeChannel> = InvokeChannels[C]['args']
export type InvokeResult<C extends InvokeChannel> = InvokeChannels[C]['result']
export type EventPayload<C extends EventChannel> = EventChannels[C]

/** What preload exposes as `window.a2t`. */
export interface Bridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>>
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:info', 'app:quit', 'app:openPath',
  'settings:all', 'settings:set',
  'tracker:get', 'tracker:setSouls', 'tracker:setName', 'tracker:restart', 'tracker:resetSession', 'tracker:clearPvp',
  'update:get', 'update:check', 'update:download', 'update:install',
  'bubble:moveTo', 'bubble:dragEnd', 'panel:toggle', 'panel:hide', 'panel:edges', 'panel:resize', 'panel:tab',
  'hud:setEditing', 'hud:moveTo', 'hud:dragEnd', 'hud:resize', 'hud:hover', 'addonHud:moveTo', 'addonHud:dragEnd', 'addonHud:resize',
  'merchant:moveTo', 'merchant:dragEnd', 'merchant:resize', 'merchant:close',
  'killfeed:open', 'killfeed:close', 'killfeed:moveTo', 'killfeed:dragEnd', 'killfeed:resize', 'timers:get',
  'map:showPet', 'map:showCollection', 'map:showMinimap', 'map:get', 'map:moveTo', 'map:dragEnd', 'map:close', 'map:minimap', 'collection:view', 'timers:dismiss', 'timers:open', 'timers:state',
  'addons:get', 'addons:openFolder', 'addons:reload', 'addons:setEnabled', 'addons:setSetting', 'addons:call', 'addons:markers',
]

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'settings:changed', 'tracker:status', 'tracker:pets', 'tracker:pet', 'tracker:soul', 'tracker:nearby', 'tracker:combat', 'tracker:shop', 'tracker:kina', 'tracker:fieldBosses', 'tracker:pvp', 'tracker:pvpKill', 'map:show', 'map:collectionView', 'panel:showTab', 'panel:showTimers', 'timers:alert', 'timers:alerting', 'timers:state', 'hud:editing', 'panel:visible', 'panel:edges', 'update:status', 'addons:changed', 'addons:event', 'addons:notify', 'addons:sound', 'addons:markers',
]
