/** Every invoke handler, typed against the contract in shared/ipc.ts. */
import { app, ipcMain, shell } from 'electron'
import { addons } from './addons.ts'
import { settings } from './settings.ts'
import { timers } from './timers.ts'
import { logPath, tracker } from './tracker.ts'
import { updates } from './update.ts'
import { appVersion } from './version.ts'
import {
  bubbleDragEnded,
  closeMap,
  closeMerchant,
  getPanelEdges,
  mapDragEnded,
  mapState,
  moveMap,
  resizePanel,
  setCollectionView,
  setMapMinimap,
  showMap,
  hidePanel,
  hudDragEnded,
  addonHudDragEnded,
  moveAddonHud,
  resizeAddonHud,
  markQuitting,
  merchantDragEnded,
  killFeedDragEnded,
  moveKillFeed,
  resizeKillFeed,
  setKillFeedOpen,
  moveBubble,
  moveHud,
  moveMerchant,
  resizeHud,
  resizeMerchant,
  setHudEditing,
  setHudHover,
  setPanelTab,
  showTimersInPanel,
  togglePanel,
} from './windows.ts'
import type { InvokeArgs, InvokeChannel, InvokeResult } from '../shared/ipc.ts'
import type { SettingKey } from '../shared/settings.ts'
import { SETTINGS_DEFAULTS } from '../shared/settings.ts'
import { isAddonId } from '../shared/addons.ts'

function handle<C extends InvokeChannel>(
  channel: C,
  fn: (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>,
): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as InvokeArgs<C>)))
}

const isPoint = (p: unknown): p is { x: number; y: number } =>
  typeof p === 'object' && p !== null && Number.isFinite((p as { x: unknown }).x) && Number.isFinite((p as { y: unknown }).y)

export function registerIpc(): void {
  handle('app:info', () => ({ version: appVersion(), settingsFile: settings.path, logFile: logPath() }))
  handle('app:quit', () => {
    markQuitting()
    app.quit()
  })
  handle('app:openPath', (path) => {
    // Only the app's own files: the settings and the collection.
    const allowed = [settings.path, tracker.status().dataFile, logPath()].filter(Boolean)
    if (allowed.includes(path)) shell.showItemInFolder(path)
  })

  handle('settings:all', () => settings.all())
  handle('settings:set', (key, value) => {
    if (!(key in SETTINGS_DEFAULTS)) return
    settings.set(key as SettingKey, value)
  })

  handle('tracker:get', () => ({ status: tracker.status(), pets: tracker.pets(), nearby: tracker.nearby(), shop: tracker.shop(), kina: tracker.kina(), fieldBosses: tracker.fieldBosses(), pvp: tracker.pvp() }))
  handle('tracker:setSouls', (pet, souls) => {
    if (Number.isInteger(pet) && Number.isInteger(souls) && souls >= 0 && souls < 100000) tracker.setSouls(pet, souls)
  })
  handle('tracker:setName', (pet, name) => {
    if (Number.isInteger(pet) && typeof name === 'string' && name.trim()) tracker.setName(pet, name.trim().slice(0, 60))
  })
  handle('tracker:restart', () => tracker.restart())
  handle('tracker:resetSession', () => tracker.resetSession())
  handle('tracker:clearPvp', () => tracker.clearPvp())

  handle('update:get', () => updates.status())
  handle('update:check', () => updates.check())
  handle('update:download', () => updates.download())
  handle('update:install', () => updates.install())

  handle('bubble:moveTo', (to) => {
    if (isPoint(to)) moveBubble(to)
  })
  handle('bubble:dragEnd', () => bubbleDragEnded())
  handle('panel:toggle', () => togglePanel())
  handle('panel:hide', () => hidePanel())
  handle('panel:edges', () => getPanelEdges())
  handle('panel:resize', (size, end) => {
    if (isPoint({ x: size?.width, y: size?.height })) resizePanel(size, Boolean(end))
  })
  handle('panel:tab', (tab) => {
    // An app tab, or an addon's (`addon:<id>`).
    if (typeof tab === 'string' && /^(?:[a-z]{1,20}|addon:[a-z0-9][a-z0-9-]{0,39})$/.test(tab)) setPanelTab(tab)
  })

  handle('hud:setEditing', (editing) => setHudEditing(Boolean(editing)))
  handle('hud:moveTo', (to) => {
    if (isPoint(to)) moveHud(to)
  })
  handle('hud:dragEnd', () => hudDragEnded())
  handle('hud:hover', (over) => setHudHover(Boolean(over)))
  handle('hud:resize', (size) => {
    if (isPoint({ x: size?.width, y: size?.height })) resizeHud(size)
  })

  handle('addonHud:moveTo', (id, to) => {
    if (isAddonId(id) && isPoint(to)) moveAddonHud(id, to)
  })
  handle('addonHud:dragEnd', (id) => {
    if (isAddonId(id)) addonHudDragEnded(id)
  })
  handle('addonHud:resize', (id, size) => {
    if (isAddonId(id) && isPoint({ x: size?.width, y: size?.height })) resizeAddonHud(id, size)
  })

  handle('merchant:moveTo', (to) => {
    if (isPoint(to)) moveMerchant(to)
  })
  handle('merchant:dragEnd', () => merchantDragEnded())
  handle('merchant:resize', (size) => {
    if (isPoint({ x: size?.width, y: size?.height })) resizeMerchant(size)
  })
  handle('merchant:close', () => closeMerchant())
  handle('killfeed:open', () => setKillFeedOpen(true))
  handle('killfeed:close', () => setKillFeedOpen(false))
  handle('killfeed:moveTo', (to) => {
    if (isPoint(to)) moveKillFeed(to)
  })
  handle('killfeed:dragEnd', () => killFeedDragEnded())
  handle('killfeed:resize', (size) => {
    if (isPoint({ x: size?.width, y: size?.height })) resizeKillFeed(size)
  })
  handle('timers:get', () => timers.alerting())
  handle('timers:dismiss', () => timers.dismiss())
  handle('timers:state', () => timers.state())
  handle('timers:open', () => {
    const ids = timers.alerting().map((a) => a.id)
    timers.dismiss()
    showTimersInPanel(ids)
  })
  handle('map:showPet', (pet) => {
    if (Number.isInteger(pet)) showMap({ kind: 'pet', pet })
  })
  handle('map:showCollection', () => showMap({ kind: 'collection' }))
  handle('map:showMinimap', () => showMap({ kind: 'collection', minimap: true }))
  handle('map:get', () => mapState())
  handle('map:moveTo', (to) => {
    if (isPoint(to)) moveMap(to)
  })
  handle('map:dragEnd', () => mapDragEnded())
  handle('map:close', () => closeMap())
  handle('map:minimap', (on) => setMapMinimap(on))
  handle('collection:view', (view) => {
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [])
    if (typeof view !== 'object' || view === null) return
    setCollectionView({
      query: typeof view.query === 'string' ? view.query.slice(0, 100) : '',
      sort: typeof view.sort === 'string' ? view.sort.slice(0, 20) : 'souls',
      filter: strings(view.filter),
      genus: strings(view.genus),
      continent: strings(view.continent),
      continentOnly: view.continentOnly === true,
    })
  })

  handle('addons:get', () => addons.status())
  handle('addons:openFolder', () => addons.openFolder())
  handle('addons:reload', () => addons.reload())
  handle('addons:setEnabled', (id, enabled) => {
    if (isAddonId(id)) addons.setEnabled(id, Boolean(enabled))
  })
  handle('addons:setSetting', (id, key, value) => {
    if (isAddonId(id) && typeof key === 'string') addons.setSetting(id, key, value)
  })
  handle('addons:call', (id, method, args) => {
    if (!isAddonId(id) || typeof method !== 'string') throw new Error('bad addon call')
    return addons.call(id, method, Array.isArray(args) ? args : [])
  })
  handle('addons:markers', () => addons.markers())
}
