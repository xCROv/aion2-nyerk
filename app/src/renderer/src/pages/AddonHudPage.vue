<script setup lang="ts">
// An addon's HUD section detached from the HUD (main/windows.ts): a HUD of its own, in the HUD's
// look, opacity and scale. Like the HUD it is click-through and as big as what it shows (nothing:
// a hidden window), and moves while the panel is open; Escape or Done ends that. Its place is kept
// with the addon's HUD settings.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AddonFrame from '@/components/AddonFrame.vue'
import { bridge } from '@/lib/bridge.ts'
import { windowDrag } from '@/lib/windowDrag.ts'
import { useApp } from '@/stores/app.ts'

const props = defineProps<{ addon: string }>()
const store = useApp()
const root = ref<HTMLElement | null>(null)
const hud = computed(() => store.settings.hud)
const info = computed(() => store.addons?.addons.find((a) => a.id === props.addon && a.state === 'on' && a.hud) ?? null)
const frameKey = computed(() => `${props.addon}@${store.addons?.generation}`)
const frameWidth = computed(() => {
  const key = info.value?.hud?.widthSetting
  const width = key ? Number(info.value?.values[key]) : 320
  return Number.isFinite(width) ? Math.max(180, Math.min(2000, width)) : 320
})
const frameVisible = computed(() => {
  const key = info.value?.hud?.frameSetting
  return key ? info.value?.values[key] !== false : true
})
// Keep the frame visible as a drag target while the HUD is being arranged.
const drawFrame = computed(() => frameVisible.value || store.hudEditing)
const frameStyle = computed(() => ({
  opacity: store.hudEditing ? 1 : hud.value.opacity,
  width: `${frameWidth.value + (drawFrame.value ? 22 : 0)}px`,
}))
/** How tall its page is now: 0 while it has nothing to show. */
const height = ref(0)
watch(frameKey, () => (height.value = 0))
const empty = computed(() => height.value === 0)

const drag = windowDrag({ move: 'addonHud:moveTo', end: 'addonHud:dragEnd', addon: props.addon })
const done = (): void => void bridge().invoke('hud:setEditing', false)
const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && store.hudEditing) done()
}

/** Tell main how big it is: main sizes the window to it, and shows or hides it. */
let sent = ''
function report(): void {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const key = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`
  if (key === sent) return
  sent = key
  void bridge().invoke('addonHud:resize', props.addon, { width: r.width, height: r.height })
}
// Measured after every change too: a hidden window runs no ResizeObserver (see HudPage).
watch([height, info, () => store.hudEditing, () => hud.value.scale], () => void nextTick(report))

let observer: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  observer = new ResizeObserver(report)
  if (root.value) observer.observe(root.value)
  report()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  observer?.disconnect()
})
</script>

<template>
  <div class="inline-block">
    <div ref="root" class="inline-block" :style="{ zoom: hud.scale }">
      <!-- Kept while empty, invisible and out of the measured size: its frame has to be loaded to
           say when it has something. -->
      <div
        v-if="info"
        :class="[
          'm-1.5 rounded-lg',
          drawFrame ? 'border bg-darker/90 p-2.5 shadow-card' : 'border-0 bg-transparent p-0 shadow-none',
          store.hudEditing ? 'cursor-move border-dashed border-accent' : drawFrame ? 'border-card' : 'border-transparent',
          empty && !store.hudEditing && 'invisible absolute',
        ]"
        :style="frameStyle"
        @pointerdown="store.hudEditing && drag.onPointerDown($event)"
      >
        <div v-if="store.hudEditing" class="mb-2 flex items-center justify-between gap-2 text-xs">
          <span class="truncate text-accent">Drag to move {{ info.name }}</span>
          <button
            type="button"
            class="shrink-0 rounded bg-accent px-2 py-0.5 font-semibold text-white"
            @pointerdown.stop
            @click="done"
          >
            Done
          </button>
        </div>
        <p v-if="store.hudEditing && empty" class="text-xs text-darker">{{ info.name }} shows here when it has something to show.</p>
        <div class="pointer-events-none">
          <AddonFrame :key="frameKey" :addon="addon" :page="info.hud!.page" :width="frameWidth" fit @size="(h) => (height = h)" />
        </div>
      </div>
    </div>
  </div>
</template>
