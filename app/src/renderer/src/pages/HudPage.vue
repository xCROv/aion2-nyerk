<script setup lang="ts">
// The in-game overlay. Click-through, and exactly as big as what it shows: it measures itself and
// main sizes the window to fit (an empty HUD is a hidden window). In edit mode it takes the mouse
// so it can be dragged; Escape or Done ends that. Addons' HUD sections (frames sized to their
// pages) go below the app's own, while their pages have them shown and not detached (a detached
// one is a window of its own: AddonHudPage).
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AddonFrame from '@/components/AddonFrame.vue'
import GenusPill from '@/components/GenusPill.vue'
import LevelBadge from '@/components/LevelBadge.vue'
import LevelBar from '@/components/LevelBar.vue'
import PetIcon from '@/components/PetIcon.vue'
import Sparkline from '@/components/Sparkline.vue'
import { bridge } from '@/lib/bridge.ts'
import { displayName, GENUS_LABEL, petInfo } from '@/lib/petDb.ts'
import { nearbyPets, useSpawns, type NearbyPet } from '@/lib/spawns.ts'
import { windowDrag } from '@/lib/windowDrag.ts'
import { useApp } from '@/stores/app.ts'
import { formatKina } from '@shared/kina.ts'
import { blankPet, nextLevelSouls, type Pet } from '@shared/tracker.ts'

const store = useApp()
const root = ref<HTMLElement | null>(null)
const hud = computed(() => store.settings.hud)

const spawns = useSpawns()
/** How many of each pet's soul monsters are around you (nearby mode). */
const near = computed(
  () =>
    new Map<number, NearbyPet>(
      (spawns.value ? nearbyPets(store.nearby, spawns.value) : []).filter((n) => !store.hiddenPet(n.pet)).map((n) => [n.pet, n]),
    ),
)
/** In nearby mode a row is named by the monsters around you, not the pet whose souls they drop. */
const monsterLabel = (pet: number): string =>
  (near.value.get(pet)?.monsters ?? []).map((m) => `${m.name}${m.count > 1 ? ` ×${m.count}` : ''}`).join(', ')

/** Top section: the pets whose soul monsters are around you (a pet with no souls yet included). */
const nearRows = computed<Pet[]>(() => {
  if (!hud.value.nearby) return []
  const known = new Map(store.pets.map((p) => [p.id, p]))
  return [...near.value.keys()]
    .slice(0, hud.value.nearbyCount)
    .map((id) => known.get(id) ?? blankPet(id))
})

/**
 * Middle section: this fight's pets, or the pinned ones. A pet the Nearby section shows already is
 * left out (it was listed twice), and the next one takes its row.
 */
const rows = computed<Pet[]>(() => {
  const shown = new Set(nearRows.value.map((p) => p.id))
  return hud.value.mode === 'pinned'
    ? hud.value.pinned.map((id) => store.pets.find((p) => p.id === id)).filter((p): p is Pet => !!p && !shown.has(p.id))
    : store.recentPets.filter((p) => !shown.has(p.id)).slice(0, hud.value.recentCount)
})
const toasts = computed(() => (hud.value.toasts ? store.toasts : []))
/** The count towards the next level, against what it needs: 0/5 at Lv0, 5/25 at Lv1, 9/75 at Lv2. */
const progressText = (pet: Pet): string => {
  const need = nextLevelSouls(pet)
  return need === null ? 'max' : `${pet.souls}/${need}`
}
/** "Fera crystal": a maxed pet's drop is its genus's crystal. */
const crystalLabel = (pet: number): string => {
  const genus = petInfo(pet)?.genus
  return genus ? `${GENUS_LABEL[genus]} crystal` : 'crystal'
}
/** Kina per hour at the top right, once there is a rate. */
const kinaText = computed(() => {
  if (!hud.value.kina) return null
  if (store.kinaRate !== null) return `${formatKina(store.kinaRate)} Kina/h`
  // Kina is coming in, but under a minute of it: no rate yet.
  return store.kina.earned ? 'Kina/h measuring…' : null
})
/** Between fights (idle timeout): the pets have nothing to show, so they hide; pinned pets included. */
const resting = computed(() => !!hud.value.idleHideSeconds && !store.fighting)
const petsShown = computed(() => !resting.value && (nearRows.value.length > 0 || rows.value.length > 0 || toasts.value.length > 0))

/** Addons' HUD sections their pages have shown, and how tall each page is now (0: nothing to show). */
const addonSections = computed(() =>
  (store.addons?.addons ?? [])
    .filter((a) => a.state === 'on' && a.id && a.hud && a.hudShown && !a.hudDetached)
    .map((a) => {
      const widthKey = a.hud!.widthSetting
      const widthValue = widthKey ? Number(a.values[widthKey]) : 320
      const frameKey = a.hud!.frameSetting
      return {
        addon: a.id!,
        page: a.hud!.page,
        key: `${a.id}@${store.addons?.generation}`,
        width: Number.isFinite(widthValue) ? Math.max(180, Math.min(2000, widthValue)) : 320,
        showFrame: frameKey ? a.values[frameKey] !== false : true,
      }
    }),
)
const sectionHeights = reactive(new Map<string, number>())
watch(addonSections, (list) => {
  for (const key of [...sectionHeights.keys()]) if (!list.some((s) => s.key === key)) sectionHeights.delete(key)
})
/** While it is being moved with no pets in it, it says where they would be. */
const petsHint = computed(() => store.hudEditing && !nearRows.value.length && !rows.value.length)
const hasAppHudContent = computed(() => petsShown.value || petsHint.value || store.hudEditing)
const appCardStyle = computed(() => ({
  opacity: store.hudEditing ? 1 : hud.value.opacity,
  width: '320px',
}))
const addonCardStyle = (section: (typeof addonSections.value)[number]) => ({
  opacity: store.hudEditing ? 1 : hud.value.opacity,
  width: `${section.width + (section.showFrame || store.hudEditing ? 22 : 0)}px`,
})

const drag = windowDrag({ move: 'hud:moveTo', end: 'hud:dragEnd' })
const done = (): void => void bridge().invoke('hud:setEditing', false)
const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && store.hudEditing) done()
}

/** Tell main how big the HUD is: main sizes the window to it, and shows or hides it. */
let sent = ''
function report(): void {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const key = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`
  if (key === sent) return
  sent = key
  void bridge().invoke('hud:resize', { width: r.width, height: r.height })
}

// A hidden window does not run ResizeObserver (Chromium pauses rendering there), and the HUD is
// hidden exactly while it is empty: the first soul would never show it. So it also measures
// itself after every change to what it shows, which works hidden or not.
watch(
  [nearRows, rows, toasts, kinaText, resting, addonSections, sectionHeights, () => store.hudEditing, () => hud.value.scale, () => store.nearby],
  () => void nextTick(report),
  { deep: true },
)

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
      <div
        v-if="hasAppHudContent"
        :class="[
          'm-1.5 rounded-lg border bg-darker/90 p-2.5 shadow-card',
          store.hudEditing ? 'cursor-move border-dashed border-accent' : 'border-card',
        ]"
        :style="appCardStyle"
        @pointerdown="store.hudEditing && drag.onPointerDown($event)"
      >
        <div v-if="store.hudEditing" class="mb-2 flex items-center justify-between gap-2 text-xs">
          <span class="text-accent">Drag to move the HUD</span>
          <button
            type="button"
            class="rounded bg-accent px-2 py-0.5 font-semibold text-white"
            @pointerdown.stop
            @click="done"
          >
            Done
          </button>
        </div>

        <template v-if="!resting || store.hudEditing">
        <div v-if="nearRows.length || kinaText" class="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
          <template v-if="nearRows.length"><span class="size-1.5 rounded-full bg-green" /><span class="text-green">Nearby</span></template>
          <Sparkline
            v-if="kinaText && store.kinaTimeline.length"
            :values="store.kinaTimeline.map((p) => p.perHour)"
            :stroke="1.5"
            class="mx-1 h-3 min-w-0 flex-1 text-yellow opacity-80"
          />
          <span v-if="kinaText" class="ml-auto shrink-0 normal-case tabular-nums text-yellow" title="This session's Kina per hour">{{ kinaText }}</span>
        </div>
        <section v-if="nearRows.length">
          <div class="space-y-2">
            <div v-for="pet in nearRows" :key="pet.id" class="flex items-center gap-2">
              <PetIcon :id="pet.id" :size="30" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2 text-[13px]">
                  <span class="truncate font-medium text-dark">{{ monsterLabel(pet.id) }}</span>
                  <span class="flex shrink-0 items-center gap-1.5 tabular-nums">
                    <span v-if="pet.session" class="text-xs text-green">+{{ pet.session }}</span>
                    <span class="font-semibold">{{ progressText(pet) }}</span>
                    <LevelBadge :pet="pet" />
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-darker">
                  <span class="truncate">{{ displayName(pet) }} pet</span>
                  <GenusPill :id="pet.id" />
                </div>
                <LevelBar :pet="pet" thin class="mt-1" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="rows.length" :class="nearRows.length ? 'mt-2.5 border-t border-card pt-2.5' : ''">
          <div class="space-y-2">
            <div v-for="pet in rows" :key="pet.id" class="flex items-center gap-2">
              <PetIcon :id="pet.id" :size="30" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2 text-[13px]">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate font-medium text-dark">{{ displayName(pet) }}</span>
                    <GenusPill :id="pet.id" />
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5 tabular-nums">
                    <span v-if="pet.session" class="text-xs text-green">+{{ pet.session }}</span>
                    <span class="font-semibold">{{ progressText(pet) }}</span>
                    <LevelBadge :pet="pet" />
                  </span>
                </div>
                <LevelBar :pet="pet" thin class="mt-1" />
              </div>
            </div>
          </div>
        </section>

        <p v-if="petsHint" class="text-xs text-darker">
          {{
            hud.mode === 'pinned'
              ? 'Nothing nearby, and no pinned pets: pin some in the panel.'
              : 'Soul monsters around you, and pets you gain souls for, show up here.'
          }}
        </p>

        <TransitionGroup
          v-if="toasts.length"
          tag="div"
          name="toast"
          :class="['space-y-1', (nearRows.length || rows.length) && 'mt-2.5 border-t border-card pt-2']"
        >
          <div v-for="t in toasts" :key="t.at + '-' + t.pet.id" class="flex items-center gap-2 text-xs">
            <span :class="['font-bold', t.crystal ? 'text-yellow' : 'text-accent']">+{{ t.amount }}</span>
            <PetIcon :id="t.pet.id" :size="18" />
            <span class="truncate">{{ displayName(t.pet) }}<span v-if="t.crystal" class="text-yellow"> · {{ crystalLabel(t.pet.id) }}</span></span>
            <span v-if="t.levelUp" class="shrink-0 rounded bg-green/20 px-1 text-[10px] font-bold text-green">Lv{{ t.pet.level }}!</span>
            <span class="ml-auto tabular-nums text-darker">{{ t.crystal ? t.pet.crystals : progressText(t.pet) }}</span>
          </div>
        </TransitionGroup>
        </template>

      </div>
      <!-- Each addon gets its own card so its frame setting never controls Nyerk's pet HUD card. -->
      <div
        v-for="s in addonSections"
        :key="s.key"
        :class="[
          'm-1.5 rounded-lg',
          s.showFrame || store.hudEditing ? 'border bg-darker/90 p-2.5 shadow-card' : 'border-0 bg-transparent p-0 shadow-none',
          store.hudEditing ? 'cursor-move border-dashed border-accent' : s.showFrame ? 'border-card' : 'border-transparent',
          (sectionHeights.get(s.key) ?? 0) === 0 && !store.hudEditing && 'invisible absolute',
        ]"
        :style="addonCardStyle(s)"
        @pointerdown="store.hudEditing && drag.onPointerDown($event)"
      >
        <div class="pointer-events-none">
          <AddonFrame :addon="s.addon" :page="s.page" :width="s.width" fit @size="(h) => sectionHeights.set(s.key, h)" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 300ms ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(12px);
}
.toast-leave-to {
  opacity: 0;
}
</style>
