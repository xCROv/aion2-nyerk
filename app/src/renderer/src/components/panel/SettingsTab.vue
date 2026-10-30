<script setup lang="ts">
// HUD, panel, privacy and tracker settings. Every change applies at once.
import { computed, onMounted, ref } from 'vue'
import Button from '@/components/Button.vue'
import AddonsSection from '@/components/panel/AddonsSection.vue'
import Select from '@/components/Select.vue'
import SettingRow from '@/components/SettingRow.vue'
import Slider from '@/components/Slider.vue'
import Toggle from '@/components/Toggle.vue'
import { bridge } from '@/lib/bridge.ts'
import { useApp } from '@/stores/app.ts'

const store = useApp()
const info = ref<{ version: string; settingsFile: string; logFile: string } | null>(null)
onMounted(async () => (info.value = await bridge().invoke('app:info')))

const pct = (v: number): string => `${Math.round(v * 100)}%`
const FACTIONS = [
  { value: 'elyos', label: 'Elyos' },
  { value: 'asmodians', label: 'Asmodian' },
] as const
const HUD_MODES = [
  { value: 'recent', label: "This session's pets" },
  { value: 'pinned', label: 'Pinned pets' },
] as const

const updateText = computed(() => {
  const u = store.update
  switch (u.state) {
    case 'unsupported':
      return 'A development run: updates come with the installed app.'
    case 'checking':
      return 'Checking…'
    case 'none':
      return 'Up to date.'
    case 'available':
      return `Version ${u.version} is available.`
    case 'downloading':
      return `Downloading ${u.version}… ${u.percent ?? 0}%`
    case 'ready':
      return `Version ${u.version} is downloaded; a restart installs it.`
    case 'restarting':
      return `Restarting to install ${u.version}…`
    case 'error':
      return `${u.error ?? 'The update failed (UNKNOWN).'} Show tracker.log, below, has the details.`
    default:
      return 'Not checked yet.'
  }
})
const python = ref(store.settings.tracker.python)
const savePython = (): Promise<void> => store.set('tracker', { ...store.settings.tracker, python: python.value.trim() })
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-darkest">You</h3>
      <div class="divide-y divide-[color:var(--gray-4)] rounded-lg border border-card bg-card px-3">
        <SettingRow label="Your side" hint="Its zones are listed first where a soul drops.">
          <Select
            :model-value="store.settings.faction"
            :options="FACTIONS"
            @update:model-value="store.set('faction', $event)"
          />
        </SettingRow>
        <SettingRow label="Hide maxed (Lv3) pets" hint="They earn no more souls: left out of the collection, Nearby and the HUD.">
          <Toggle :model-value="store.settings.hideMaxed" @update:model-value="store.set('hideMaxed', $event)" />
        </SettingRow>
        <SettingRow label="Your level" hint="Marks the monsters close enough to it for souls to drop well.">
          <input
            :value="store.settings.playerLevel ?? ''"
            inputmode="numeric"
            placeholder="?"
            class="h-7 w-14 rounded-md border border-light bg-default px-2 text-center text-sm tabular-nums"
            @change="store.set('playerLevel', ($event.target as HTMLInputElement).value.trim() ? Number(($event.target as HTMLInputElement).value) : null)"
          />
        </SettingRow>
      </div>
    </section>

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-darkest">In-game HUD</h3>
      <div class="divide-y divide-[color:var(--gray-4)] rounded-lg border border-card bg-card px-3">
        <SettingRow label="Show the HUD" hint="Works over borderless or windowed mode, not exclusive fullscreen.">
          <Toggle :model-value="store.settings.hud.enabled" @update:model-value="store.setHud({ enabled: $event })" />
        </SettingRow>
        <SettingRow label="Nearby section" hint="At the top: the soul monsters around you, with the pet each drops.">
          <Toggle :model-value="store.settings.hud.nearby" @update:model-value="store.setHud({ nearby: $event })" />
        </SettingRow>
        <SettingRow v-if="store.settings.hud.nearby" label="How many nearby">
          <Slider :model-value="store.settings.hud.nearbyCount" :min="1" :max="8" :step="1" @update:model-value="store.setHud({ nearbyCount: $event })" />
        </SettingRow>
        <SettingRow
          label="Below it"
          :hint="{ pinned: 'Pin pets in the Collection tab.', recent: 'Pets you gained souls for, latest first.' }[store.settings.hud.mode]"
        >
          <Select
            :model-value="store.settings.hud.mode"
            :options="HUD_MODES"
            @update:model-value="store.setHud({ mode: $event })"
          />
        </SettingRow>
        <SettingRow v-if="store.settings.hud.mode !== 'pinned'" label="How many this session">
          <Slider :model-value="store.settings.hud.recentCount" :min="1" :max="8" :step="1" @update:model-value="store.setHud({ recentCount: $event })" />
        </SettingRow>
        <SettingRow label="Soul pop-ups" hint="A line for each soul as it drops.">
          <Toggle :model-value="store.settings.hud.toasts" @update:model-value="store.setHud({ toasts: $event })" />
        </SettingRow>
        <SettingRow label="Hide without game traffic" hint="When the game has sent nothing for 15 seconds.">
          <Toggle :model-value="store.settings.hud.hideWithoutGame" @update:model-value="store.setHud({ hideWithoutGame: $event })" />
        </SettingRow>
        <SettingRow label="Kina per hour" hint="This session's Kina per hour, at the top right of the HUD.">
          <Toggle :model-value="store.settings.hud.kina" @update:model-value="store.setHud({ kina: $event })" />
        </SettingRow>
        <SettingRow label="Black Cloud Merchant pets" hint="When you open one of its tabs, a window lists the pets it sells that you have not maxed: prices, and where they spawn. Its X closes it.">
          <Toggle :model-value="store.settings.hud.merchant" @update:model-value="store.setHud({ merchant: $event })" />
        </SettingRow>
        <SettingRow label="Clear between fights" hint="After this long with no kills or drops the HUD clears and hides until the next fight.">
          <Slider
            :model-value="store.settings.hud.idleHideSeconds"
            :min="0"
            :max="300"
            :step="15"
            :format="(v: number) => (v ? `${v}s` : 'Off')"
            @update:model-value="store.setHud({ idleHideSeconds: $event })"
          />
        </SettingRow>
        <SettingRow label="Opacity">
          <Slider :model-value="store.settings.hud.opacity" :min="0.3" :max="1" :step="0.05" :format="pct" @update:model-value="store.setHud({ opacity: $event })" />
        </SettingRow>
        <SettingRow label="Size">
          <Slider :model-value="store.settings.hud.scale" :min="0.75" :max="1.75" :step="0.05" :format="pct" @update:model-value="store.setHud({ scale: $event })" />
        </SettingRow>
        <SettingRow label="Position" hint="While this panel is open the HUD can be dragged anywhere; it goes back to click-through when you close the panel.">
          <Button size="sm" @click="bridge().invoke('hud:setEditing', !store.hudEditing)">
            {{ store.hudEditing ? 'Done' : 'Move HUD' }}
          </Button>
        </SettingRow>
      </div>
    </section>

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-darkest">Windows</h3>
      <div class="divide-y divide-[color:var(--gray-4)] rounded-lg border border-card bg-card px-3">
        <SettingRow
          label="Sleep while Aion 2 is closed"
          hint="No bubble, HUD or capture until the game starts: only the tray icon, which still opens this panel."
        >
          <Toggle :model-value="store.settings.sleepWithoutGame" @update:model-value="store.set('sleepWithoutGame', $event)" />
        </SettingRow>
        <SettingRow label="Keep this panel on top" hint="Stays above the game while open.">
          <Toggle :model-value="store.settings.panelOnTop" @update:model-value="store.set('panelOnTop', $event)" />
        </SettingRow>
        <SettingRow label="Hide from screen recordings" hint="Keeps the bubble, panel and HUD out of OBS, Discord and screenshots.">
          <Toggle :model-value="store.settings.hideFromCapture" @update:model-value="store.set('hideFromCapture', $event)" />
        </SettingRow>
      </div>
    </section>

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-darkest">Tracker</h3>
      <div class="space-y-2 rounded-lg border border-card bg-card p-3 text-xs">
        <label class="block">
          <span class="text-darker">Python</span>
          <input
            v-model="python"
            class="mt-1 h-7 w-full rounded-md border border-light bg-default px-2 text-xs"
            placeholder="C:\…\python.exe"
            @change="savePython"
          />
        </label>
        <div class="flex items-start justify-between gap-3 pt-1">
          <div>
            <div class="text-darker">Debug logging</div>
            <div class="mt-0.5 text-darkest">
              More in the log for troubleshooting, and the game connection recorded next to it (about 5 MB an hour). Turn it off when done.
            </div>
          </div>
          <Toggle :model-value="store.settings.debugLogging" @update:model-value="store.set('debugLogging', $event)" />
        </div>
        <div class="flex justify-end pt-1">
          <Button size="sm" @click="bridge().invoke('tracker:restart')">Restart tracker</Button>
        </div>
      </div>
    </section>

    <AddonsSection />

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-darkest">Updates</h3>
      <div class="divide-y divide-[color:var(--gray-4)] rounded-lg border border-card bg-card px-3">
        <SettingRow label="Check for updates automatically">
          <Toggle :model-value="store.settings.autoUpdateCheck" @update:model-value="store.set('autoUpdateCheck', $event)" />
        </SettingRow>
        <SettingRow :label="`Version ${store.update.current || info?.version || '…'}`" :hint="updateText">
          <Button
            v-if="store.update.state === 'available'"
            size="sm"
            intent="primary"
            @click="bridge().invoke('update:download')"
          >
            Download {{ store.update.version }}
          </Button>
          <Button v-else-if="store.update.state === 'ready'" size="sm" intent="primary" @click="bridge().invoke('update:install')">
            Restart to install
          </Button>
          <Button
            v-else
            size="sm"
            :loading="store.update.state === 'checking' || store.update.state === 'downloading'"
            :disabled="store.update.state === 'unsupported'"
            @click="bridge().invoke('update:check')"
          >
            Check now
          </Button>
        </SettingRow>
      </div>
    </section>

    <section class="flex items-center justify-end text-xs text-darkest">
      <div class="flex gap-3">
        <button v-if="info" type="button" class="hover:text-default" @click="bridge().invoke('app:openPath', info.logFile)">Show tracker.log</button>
        <button
          v-if="store.status?.dataFile"
          type="button"
          class="hover:text-default"
          :title="store.status.dataFile"
          @click="bridge().invoke('app:openPath', store.status.dataFile)"
        >
          Show collection.json
        </button>
        <button v-if="info" type="button" class="hover:text-default" @click="bridge().invoke('app:openPath', info.settingsFile)">Settings file</button>
        <button type="button" class="text-red hover:underline" @click="bridge().invoke('app:quit')">Quit</button>
      </div>
    </section>
  </div>
</template>
