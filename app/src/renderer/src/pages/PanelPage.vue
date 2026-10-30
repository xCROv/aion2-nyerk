<script setup lang="ts">
// The panel the bubble opens: the collection, this session, the timers, addons' tabs, and settings.
// Escape or × hides it; its outer edges resize it. Maps open in a window of their own (MapPage).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AddonFrame from '@/components/AddonFrame.vue'
import ResizeGrips from '@/components/ResizeGrips.vue'
import CollectionTab from '@/components/panel/CollectionTab.vue'
import SessionTab from '@/components/panel/SessionTab.vue'
import PvpLogTab from '@/components/panel/PvpLogTab.vue'
import SettingsTab from '@/components/panel/SettingsTab.vue'
import TabIcon from '@/components/panel/TabIcon.vue'
import TimersTab from '@/components/panel/TimersTab.vue'
import StatusDot, { statusText } from '@/components/StatusDot.vue'
import { bridge } from '@/lib/bridge.ts'
import { useApp } from '@/stores/app.ts'
import { builtinOn, type BuiltinAddon } from '@shared/addons.ts'
import { DISPLAY_NAME } from '@shared/app.ts'

const store = useApp()
// The Timers and the PvP Log are built-in addons: their tabs show while they are switched on.
const APP_TABS: { id: string; label: string; addon?: BuiltinAddon }[] = [
  { id: 'collection', label: 'Collection' },
  { id: 'session', label: 'Session' },
  { id: 'timers', label: 'Timers', addon: 'timers' },
  { id: 'pvp', label: 'PvP Log', addon: 'pvp-log' },
]
const appTabs = computed(() => APP_TABS.filter((t) => !t.addon || builtinOn(store.settings.addons.enabled, t.addon)))
// Addons' tabs (`addon:<id>`) go after the app's own.
const addonTabs = computed(() =>
  (store.addons?.addons ?? [])
    .filter((a) => a.state === 'on' && a.tab && a.id)
    .map((a) => ({ id: `addon:${a.id}`, label: a.tab!.label, addon: a.id!, page: a.tab!.page, icon: a.tab!.icon })),
)
const TABS = computed(() => [...appTabs.value, ...addonTabs.value])
const tab = ref<string>('collection')
// Settings is the cog by the ×, not a tab: clicked again, it goes back to the tab it came from.
let beforeSettings = 'collection'
const toggleSettings = (): void => {
  if (tab.value === 'settings') tab.value = TABS.value.some((t) => t.id === beforeSettings) ? beforeSettings : 'collection'
  else {
    beforeSettings = tab.value
    tab.value = 'settings'
  }
}
const addonTab = computed(() => addonTabs.value.find((t) => t.id === tab.value) ?? null)
// An addon tab asked for (after an update restart) before the addons are known: shown once they are.
let wanted: string | null = null
watch(addonTabs, () => {
  if (wanted && addonTabs.value.some((t) => t.id === wanted)) {
    tab.value = wanted
    wanted = null
  } else if (tab.value.startsWith('addon:') && !addonTab.value) tab.value = 'collection'
})
// A built-in addon switched off while its tab is open (in Settings, so rarely): back to the collection.
watch(appTabs, () => {
  if (APP_TABS.some((t) => t.id === tab.value) && !appTabs.value.some((t) => t.id === tab.value)) tab.value = 'collection'
})
// Main keeps the tab, so an update restart reopens the panel where it was.
watch(tab, (t) => void bridge().invoke('panel:tab', t), { immediate: true })
// And the Collection's filters, for the map window's collection map to show the same pets.
watch(
  () => store.collectionView,
  (v) => void bridge().invoke('collection:view', JSON.parse(JSON.stringify(v))),
  { deep: true, immediate: true },
)

// The update banner's countdown to the restart.
const clock = ref(Date.now())
const ticker = setInterval(() => (clock.value = Date.now()), 250)
onBeforeUnmount(() => clearInterval(ticker))
const restartIn = computed(() => {
  const at = store.update.restartAt
  return store.update.state === 'restarting' && at ? Math.max(0, Math.ceil((at - clock.value) / 1000)) : 0
})

const hide = (): void => void bridge().invoke('panel:hide')
const onKey = (e: KeyboardEvent): void => {
  if (e.key !== 'Escape' || e.target instanceof HTMLInputElement) return
  hide()
}
// The bubble clicked during an alert: the Timers tab, on the timers that alerted.
let offShowTimers: (() => void) | null = null
// Back from an update restart: the tab it was on.
let offShowTab: (() => void) | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  offShowTimers = bridge().on('panel:showTimers', (ids) => {
    if (!builtinOn(store.settings.addons.enabled, 'timers')) return
    tab.value = 'timers'
    store.timerFocus = { ids, at: Date.now() }
  })
  offShowTab = bridge().on('panel:showTab', (id) => {
    const found = id === 'settings' || TABS.value.some((t) => t.id === id)
    if (found) tab.value = id
    else if (id.startsWith('addon:')) wanted = id
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  offShowTimers?.()
  offShowTab?.()
})
</script>

<template>
  <div class="relative flex h-full flex-col overflow-hidden rounded-xl border border-card bg-app shadow-card">
    <ResizeGrips />
    <header class="flex items-center gap-2.5 border-b border-card px-3 py-2.5">
      <img src="/icon.png" alt="" class="size-7" draggable="false" />
      <div class="min-w-0 flex-1">
        <!-- The version beside the name, so a screenshot says which build it came from. -->
        <div class="text-sm font-semibold leading-tight">
          {{ DISPLAY_NAME }}
          <span v-if="store.update.current" class="ml-1 text-xs font-normal text-darker">v{{ store.update.current }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-darker">
          <StatusDot :status="store.status" />
          <span class="truncate">{{ statusText(store.status) }}</span>
          <span v-if="store.status?.character" class="truncate text-dark" title="The character whose pets these are">· {{ store.status.character }}</span>
          <span v-if="store.sessionSouls" class="text-green">· +{{ store.sessionSouls }} souls</span>
        </div>
      </div>
      <button
        type="button"
        title="Settings"
        :class="[
          'flex size-7 items-center justify-center rounded-md transition hover:bg-light',
          tab === 'settings' ? 'bg-light text-accent' : 'text-darker hover:text-default',
        ]"
        @click="toggleSettings"
      >
        <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <button
        type="button"
        title="Hide (Esc)"
        class="flex size-7 items-center justify-center rounded-md text-darker transition hover:bg-light hover:text-default"
        @click="hide"
      >
        <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <div
      v-if="['available', 'downloading', 'ready', 'restarting'].includes(store.update.state)"
      class="flex items-center gap-2 border-b border-card bg-accent-soft/60 px-3 py-2 text-xs"
    >
      <span class="min-w-0 flex-1 text-dark">
        <template v-if="store.update.state === 'available'">Version {{ store.update.version }} is available.</template>
        <template v-else-if="store.update.state === 'downloading'">Update {{ store.update.version }} found. Downloading… {{ store.update.percent ?? 0 }}%</template>
        <template v-else-if="store.update.state === 'restarting'">
          Update {{ store.update.version }} found. Restarting to install it{{ restartIn ? ` in ${restartIn} s` : '' }}…
        </template>
        <template v-else>Version {{ store.update.version }} is ready.</template>
      </span>
      <button
        v-if="store.update.state === 'available'"
        type="button"
        class="rounded bg-accent px-2 py-0.5 font-semibold text-white hover:bg-accent-hover"
        @click="bridge().invoke('update:download')"
      >
        Download
      </button>
      <button
        v-if="store.update.state === 'ready'"
        type="button"
        class="rounded bg-accent px-2 py-0.5 font-semibold text-white hover:bg-accent-hover"
        @click="bridge().invoke('update:install')"
      >
        Restart to install
      </button>
    </div>

    <!-- Each tab is its icon; the open one has its name beside it, the others on hover. -->
    <nav class="flex gap-1 border-b border-card px-2 pt-1.5">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        :title="tab !== t.id ? t.label : undefined"
        :class="[
          '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1 text-sm font-medium transition',
          tab === t.id ? 'border-accent text-default' : 'border-transparent text-darker hover:text-default',
        ]"
        @click="tab = t.id"
      >
        <TabIcon :id="t.id" :label="t.label" :addon="'addon' in t ? t.addon : undefined" :icon="'icon' in t ? t.icon : undefined" />
        <span v-if="tab === t.id">{{ t.label }}</span>
      </button>
    </nav>

    <!-- An addon's page scrolls itself, inside its frame. -->
    <main :class="['min-h-0 flex-1', addonTab ? 'overflow-hidden' : 'overflow-y-auto']">
      <div v-if="!store.ready" class="p-6 text-center text-sm text-darker">Loading…</div>
      <CollectionTab v-else-if="tab === 'collection'" />
      <SessionTab v-else-if="tab === 'session'" />
      <TimersTab v-else-if="tab === 'timers'" />
      <PvpLogTab v-else-if="tab === 'pvp'" />
      <AddonFrame v-else-if="addonTab" :key="`${addonTab.addon}@${store.addons?.generation}`" :addon="addonTab.addon" :page="addonTab.page" />
      <SettingsTab v-else />
    </main>
  </div>
</template>
