/**
 * Everything the windows render from, kept in step with main. Each window has its own copy of
 * this store (separate renderers); main broadcasts every change to all of them.
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref, toRaw } from 'vue'
import { SETTINGS_DEFAULTS, type SettingKey, type Settings } from '@shared/settings.ts'
import { MAX_LEVEL, NO_NEARBY, type Nearby, type Pet, type PvpKill, type ShopStock, type SoulToast, type TrackerStatus } from '@shared/tracker.ts'
import { kinaPerHour, kinaSeries, NO_KINA, type KinaSession } from '@shared/kina.ts'
import type { FieldBosses, TimerAlert, TimerId, TimersState } from '@shared/timers.ts'
import { initialUpdateStatus, type UpdateStatus } from '@shared/update.ts'
import type { AddonsStatus } from '@shared/addons.ts'
import type { CollectionView } from '@shared/ipc.ts'
import { bridge } from '@/lib/bridge.ts'
import type { Genus } from '@/lib/petDb.ts'
import type { Continent } from '@/lib/spawns.ts'

const TOAST_MS = 5000

export const useApp = defineStore('app', () => {
  const settings = ref<Settings>(structuredClone(SETTINGS_DEFAULTS))
  const status = ref<TrackerStatus | null>(null)
  const petMap = ref(new Map<number, Pet>())
  const toasts = ref<SoulToast[]>([])
  const hudEditing = ref(false)
  const panelVisible = ref(false)
  const ready = ref(false)
  const nearby = ref<Nearby>(NO_NEARBY)
  /** The timers alerting now (the bubble shakes while there are any). */
  const alerting = ref<TimerAlert[]>([])
  /** The resets and next starts, and the region they follow (the character's server's with Automatic). */
  const timersState = ref<TimersState | null>(null)
  /** The field bosses as the map last listed them (the Gartua timer). */
  const fieldBosses = ref<FieldBosses>({})
  /** The PvP kill feed (main keeps it for the session). */
  const pvp = ref<PvpKill[]>([])
  /** Timers to scroll to and highlight in the Timers tab (the bubble was clicked on their alert). */
  const timerFocus = ref<{ ids: TimerId[]; at: number } | null>(null)
  /** The Black Cloud Merchant's stock: the tabs opened, until their restock. */
  const shop = ref<ShopStock[]>([])
  const update = ref<UpdateStatus>(initialUpdateStatus(''))
  /** The addons folder and what is in it (main/addons.ts). */
  const addons = ref<AddonsStatus | null>(null)
  /** This session's Kina; the rate is redrawn every few seconds as active time runs on. */
  const kina = ref<KinaSession>(NO_KINA)
  const now = ref(Date.now())
  setInterval(() => (now.value = Date.now()), 5000)
  const kinaRate = computed(() => kinaPerHour(kina.value, now.value))
  /** Kina per hour over time, for the sparklines. */
  const kinaTimeline = computed(() => kinaSeries(kina.value, now.value))
  /**
   * The collection's search, sort and filter pills. Kept here, not in the tab, so the map window's
   * collection map can follow them: the panel sends every change to main, which passes it on.
   * Each group takes several pills at once; an empty list is "All".
   */
  const collectionView = reactive({
    query: '',
    sort: 'souls' as 'souls' | 'name' | 'level' | 'recent' | 'range',
    filter: [] as ('nearby' | 'pinned' | 'unfinished' | 'session')[],
    genus: [] as Genus[],
    continent: [] as Continent[],
    /** The continent pills match pets found on exactly those continents and nowhere else. */
    continentOnly: false,
  })
  /** The map window: the pet whose drop locations it is showing, if any. */
  const openPetId = ref<number | null>(null)
  /** The map window: showing the collection's map (its filtered pets); a pet opened from it comes back to it. */
  const collectionMapOpen = ref(false)
  /** The map window: the collection's map as a minimap, only the map in a small window. */
  const mapMinimap = ref(false)

  const pets = computed(() => [...petMap.value.values()])
  const sessionSouls = computed(() => pets.value.reduce((n, p) => n + p.session, 0))
  /** Pets that gained souls this session, most recent first (by the last toast, then by count). */
  const lastSoulAt = ref(new Map<number, number>())
  /**
   * The current fight: when it began and when anything last happened (a kill, a soul, a crystal).
   * After settings.hud.idleHideSeconds of nothing, `fighting` turns false: the HUD clears and hides
   * until the next one, which then lists only its own pets.
   */
  const fightStart = ref(0)
  const lastActivity = ref(0)
  const fighting = ref(false)
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  function activity(at = Date.now()): void {
    if (!fighting.value) fightStart.value = at
    lastActivity.value = at
    fighting.value = true
    armIdle()
  }
  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const secs = settings.value.hud.idleHideSeconds
    if (!secs || !fighting.value) return
    const left = lastActivity.value + secs * 1000 - Date.now()
    if (left <= 0) fighting.value = false
    else idleTimer = setTimeout(armIdle, left)
  }
  const recentPets = computed(() =>
    pets.value
      .filter((p) => p.session > 0 && !(settings.value.hideMaxed && p.level >= MAX_LEVEL))
      // With the idle timeout on, only this fight's pets: the last one's are cleared.
      .filter((p) => !settings.value.hud.idleHideSeconds || (lastSoulAt.value.get(p.id) ?? 0) >= fightStart.value)
      .sort((a, b) => (lastSoulAt.value.get(b.id) ?? 0) - (lastSoulAt.value.get(a.id) ?? 0) || b.session - a.session),
  )

  function addToast(t: SoulToast): void {
    toasts.value = [...toasts.value, t].slice(-4)
    activity(t.at)
    lastSoulAt.value = new Map(lastSoulAt.value).set(t.pet.id, t.at)
    // The array holds reactive proxies of the toasts, so compare the raw object: comparing the
    // proxy to `t` never matched, and lines stayed up until newer ones pushed them out.
    setTimeout(() => (toasts.value = toasts.value.filter((x) => toRaw(x) !== t)), TOAST_MS)
  }

  function setPet(p: Pet): void {
    petMap.value = new Map(petMap.value).set(p.id, p)
  }

  async function init(): Promise<void> {
    const api = bridge()
    api.on('settings:changed', (s) => {
      settings.value = s
      armIdle()
    })
    api.on('tracker:combat', (at) => activity(at))
    api.on('tracker:status', (s) => (status.value = s))
    api.on('tracker:pets', (list) => (petMap.value = new Map(list.map((p) => [p.id, p]))))
    api.on('tracker:pet', setPet)
    api.on('tracker:soul', (t) => {
      setPet(t.pet)
      addToast(t)
    })
    api.on('tracker:nearby', (n) => (nearby.value = n))
    api.on('tracker:shop', (s) => (shop.value = s))
    api.on('tracker:fieldBosses', (b) => (fieldBosses.value = b))
    api.on('tracker:pvp', (k) => (pvp.value = k))
    // A new list each time, so watchers of the whole list (the kill feed HUD) see the change.
    api.on('tracker:pvpKill', (k) => (pvp.value = [...pvp.value, k]))
    api.on('tracker:kina', (k) => {
      kina.value = k
      now.value = Date.now()
    })
    api.on('timers:alerting', (a) => (alerting.value = a))
    api.on('timers:state', (t) => (timersState.value = t))
    api.on('update:status', (u) => (update.value = u))
    api.on('hud:editing', (e) => (hudEditing.value = e))
    api.on('panel:visible', (v) => (panelVisible.value = v))
    api.on('addons:changed', (a) => (addons.value = a))
    const [s, t] = await Promise.all([api.invoke('settings:all'), api.invoke('tracker:get')])
    settings.value = s
    status.value = t.status
    petMap.value = new Map(t.pets.map((p) => [p.id, p]))
    nearby.value = t.nearby
    shop.value = t.shop
    kina.value = t.kina
    fieldBosses.value = t.fieldBosses
    pvp.value = t.pvp
    alerting.value = await api.invoke('timers:get')
    timersState.value = await api.invoke('timers:state')
    update.value = await api.invoke('update:get')
    addons.value = await api.invoke('addons:get')
    ready.value = true
  }

  /** Optimistic: the local copy changes now, main's broadcast confirms it. */
  async function set<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
    settings.value = { ...settings.value, [key]: value }
    await bridge().invoke('settings:set', key, JSON.parse(JSON.stringify(value)))
  }

  async function setHud(patch: Partial<Settings['hud']>): Promise<void> {
    await set('hud', { ...settings.value.hud, ...patch })
  }

  function togglePin(id: number): Promise<void> {
    const pinned = settings.value.hud.pinned
    return setHud({ pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] })
  }

  /** A pet at the cap that the "hide maxed pets" setting leaves out (no more souls to collect). */
  function hiddenPet(id: number): boolean {
    return settings.value.hideMaxed && (petMap.value.get(id)?.level ?? 0) >= MAX_LEVEL
  }

  /** In the map window: show a pet's drop locations (null: back to the collection's map). */
  function openPet(id: number | null): void {
    openPetId.value = id
  }
  /** In the map window: show (or leave) the collection's map, the pets its filters show. */
  function openCollectionMap(open: boolean): void {
    collectionMapOpen.value = open
  }
  /** In the map window: the collection's map as a minimap, or back to the full window. */
  function setMapMinimap(on: boolean): void {
    if (on === mapMinimap.value) return
    mapMinimap.value = on
    void bridge().invoke('map:minimap', on)
  }
  /** From any other window: open the map window on a pet's drop locations. */
  function showPetMap(id: number): void {
    void bridge().invoke('map:showPet', id)
  }
  /** From the Collection tab: open the map window on the pets its filters show. */
  function showCollectionMap(): void {
    void bridge().invoke('map:showCollection')
  }
  /** In the map window: the Collection tab's filters, as the panel last had them. */
  function applyCollectionView(v: CollectionView): void {
    Object.assign(collectionView, v)
  }

  return {
    settings, status, pets, toasts, fighting, collectionView, shop, kina, kinaRate, kinaTimeline, alerting, timersState, timerFocus, fieldBosses, pvp, hudEditing, panelVisible, ready, sessionSouls, recentPets, openPetId, collectionMapOpen, mapMinimap, nearby, update, addons,
    init, set, setHud, togglePin, openPet, openCollectionMap, setMapMinimap, showPetMap, showCollectionMap, applyCollectionView, hiddenPet,
  }
})
