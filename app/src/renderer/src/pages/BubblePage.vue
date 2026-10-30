<script setup lang="ts">
// The floating icon. Drag it anywhere (it stays where it is dropped); click it to open or close
// the panel. The ring says what the tracker is doing; the badge counts this session's souls and
// the icon pulses when one drops. A timer alerting chimes once and shakes the bubble every few
// seconds until a click dismisses it.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { statusText, statusTone } from '@/components/StatusDot.vue'
import { bridge } from '@/lib/bridge.ts'
import { playChime } from '@/lib/chime.ts'
import { DEFAULT_SOUND } from '@shared/timers.ts'
import { windowDrag } from '@/lib/windowDrag.ts'
import { useApp } from '@/stores/app.ts'

const store = useApp()
const tone = computed(() => statusTone(store.status))
const RING = { green: 'ring-green', amber: 'ring-yellow', red: 'ring-red', gray: 'ring-darkest' } as const

const pulse = ref(0)
watch(
  () => store.toasts.length,
  (n, was) => {
    if (n > was) pulse.value++
  },
)

// The chime plays here: the bubble is up whenever the game is, and one window plays it once. Each
// timer plays its own sound; timers alerting together with the same sound play it once.
let offAlert: (() => void) | null = null
const lastPlayed = new Map<string, number>()
// An addon asking for attention: a chime (as the timers' sound and volume say) and a pulse.
let offNotify: (() => void) | null = null
// An addon playing a sound it picked (Nearby Nodes' per type): at the timers' volume.
let offSound: (() => void) | null = null
onMounted(() => {
  offNotify = bridge().on('addons:notify', () => {
    pulse.value++
    if (store.settings.timers.sound) playChime(store.settings.timers.volume, DEFAULT_SOUND)
  })
  offSound = bridge().on('addons:sound', (s) => playChime(store.settings.timers.volume, s.sound))
  offAlert = bridge().on('timers:alert', (a) => {
    const cfg = store.settings.timers
    if (!cfg.sound) return
    const sound = cfg.sounds[a.id] ?? DEFAULT_SOUND
    const now = Date.now()
    if (now - (lastPlayed.get(sound) ?? 0) < 1000) return
    lastPlayed.set(sound, now)
    playChime(cfg.volume, sound)
  })
})
onBeforeUnmount(() => {
  offAlert?.()
  offNotify?.()
  offSound?.()
})
const shaking = computed(() => store.alerting.length > 0 && store.settings.timers.shake)

const drag = windowDrag({
  move: 'bubble:moveTo',
  end: 'bubble:dragEnd',
  onClick: () => {
    // A click with an alert up dismisses it and opens the panel on that timer; otherwise it opens
    // or closes the panel.
    void bridge().invoke(store.alerting.length ? 'timers:open' : 'panel:toggle')
  },
})

const title = computed(() =>
  store.alerting.length
    ? 'A timer is up: click to see it'
    : `${statusText(store.status)} · ${store.sessionSouls} souls this session`,
)
</script>

<template>
  <div class="flex h-full w-full items-center justify-center">
    <button
      type="button"
      :title="title"
      :class="[
        'relative size-12 cursor-grab touch-none rounded-full ring-2 ring-offset-2 ring-offset-transparent transition active:cursor-grabbing',
        RING[tone],
        store.panelVisible ? 'scale-95' : 'hover:scale-105',
        shaking && 'animate-alert',
      ]"
      @pointerdown="drag.onPointerDown"
      @pointerup="drag.onPointerUp"
    >
      <img :key="pulse" src="/icon.png" alt="" draggable="false" :class="['size-12 rounded-full', pulse && 'animate-soul']" />
      <span
        v-if="store.sessionSouls > 0"
        class="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold tabular-nums text-white shadow"
      >
        {{ store.sessionSouls > 99 ? '99+' : store.sessionSouls }}
      </span>
    </button>
  </div>
</template>

<style scoped>
@keyframes soul {
  0% {
    transform: scale(1);
    filter: brightness(1);
  }
  35% {
    transform: scale(1.18);
    filter: brightness(1.6);
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
  }
}
.animate-soul {
  animation: soul 700ms ease-out;
}
/* A timer is up: a short rotating shake, then still, every 3 s. */
@keyframes alert {
  0%,
  30%,
  100% {
    transform: rotate(0);
  }
  5% {
    transform: rotate(-14deg);
  }
  10% {
    transform: rotate(12deg);
  }
  15% {
    transform: rotate(-9deg);
  }
  20% {
    transform: rotate(6deg);
  }
  25% {
    transform: rotate(-3deg);
  }
}
.animate-alert {
  animation: alert 3s ease-in-out infinite;
}
</style>
