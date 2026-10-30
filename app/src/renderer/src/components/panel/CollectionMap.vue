<script setup lang="ts">
// The collection's map: the pets the Collection tab's filters show, on one zone's map, the ones
// in that zone nearest you first. Click a pet to pick its spawns out; the arrow opens its drop
// locations (and back comes here). The icon at the map's top right makes it a minimap: only the
// map, in a small window, moved by the arrows at its bottom right and back to the full window by
// clicking the icon again. The crosshair beside it (shown while your position is known here) keeps
// you in the map's middle, the map gliding along as you move, until you drag it. Each pet's swatch,
// and each kind of addon marker in the key under the map, picks its colour and shape (kept in
// settings.json `mapStyles`). Addons' markers (nyerk.map.markers) in the zone shown draw on top.
import { computed, ref, watch } from 'vue'
import GenusPill from '@/components/GenusPill.vue'
import LevelBadge from '@/components/LevelBadge.vue'
import MarkStyleButton from '@/components/MarkStyleButton.vue'
import PetIcon from '@/components/PetIcon.vue'
import Select from '@/components/Select.vue'
import WorldMap, { type MapLayer, type MapMark } from '@/components/WorldMap.vue'
import { useAddonMarkers } from '@/lib/addonMarkers.ts'
import { useCollectionList } from '@/lib/collectionList.ts'
import { windowDrag } from '@/lib/windowDrag.ts'
import { displayName } from '@/lib/petDb.ts'
import { formatDistance } from '@/lib/spawns.ts'
import { useApp } from '@/stores/app.ts'
import type { MarkShape, MarkStyle } from '@shared/settings.ts'
import { nextLevelSouls, type Pet } from '@shared/tracker.ts'

const store = useApp()
const { spawns, list, here, near } = useCollectionList()
const drag = windowDrag({ move: 'map:moveTo', end: 'map:dragEnd' })
const addonMarkers = useAddonMarkers()

/** One colour per pet, as on a pet's own map: the selected one in the accent. */
const PALETTE = ['#f76b15', '#30a46c', '#0090ff', '#ffc53d', '#e54666', '#12a594', '#ab4aba', '#8e8c99']
const SELECTED = '#a3acff'

/** Each listed pet's soul monster spawns, by zone, with the monsters that spawn there. */
const placed = computed(() => {
  const out = new Map<number, Map<number, { points: [number, number][]; monsters: { name: string; level: number }[] }>>()
  for (const p of list.value) {
    const byWorld = new Map<number, { points: [number, number][]; monsters: { name: string; level: number }[] }>()
    for (const d of spawns.value?.pets[p.id] ?? []) {
      for (const w of d.worlds) {
        const entry = byWorld.get(w.world) ?? { points: [], monsters: [] }
        entry.points.push(...w.points)
        entry.monsters.push({ name: d.name, level: d.level })
        byWorld.set(w.world, entry)
      }
    }
    out.set(p.id, byWorld)
  }
  return out
})

/**
 * The zones the listed pets spawn in: yours first, then by how many of them spawn there. A zone
 * with a map and no pets is listed too while you are in it or an addon marks something there (the
 * Shugo Festival's chests).
 */
const zones = computed(() => {
  const counts = new Map<number, number>()
  for (const byWorld of placed.value.values()) for (const w of byWorld.keys()) counts.set(w, (counts.get(w) ?? 0) + 1)
  for (const a of addonMarkers.value) for (const m of a.markers) if (!counts.has(m.world)) counts.set(m.world, 0)
  if (here.value && !counts.has(here.value.world)) counts.set(here.value.world, 0)
  return [...counts.entries()]
    .map(([id, pets]) => ({ id, pets, name: spawns.value?.worlds[id]?.name ?? `#${id}`, yours: id === here.value?.world }))
    .filter((z) => spawns.value?.worlds[z.id])
    .sort((a, b) => Number(b.yours) - Number(a.yours) || b.pets - a.pets || a.name.localeCompare(b.name))
})
const zoneOptions = computed(() =>
  zones.value.map((z) => ({ value: z.id, label: `${z.name}${z.pets ? ` (${z.pets})` : ''}${z.yours ? ' · you are here' : ''}` })),
)
const worldId = ref<number | null>(null)
watch(
  zones,
  (list) => {
    if (!list.some((z) => z.id === worldId.value)) worldId.value = list[0]?.id ?? null
  },
  { immediate: true },
)
// Moving to another zone (a Spacetime rift to the other continent, and back) shows its map, when
// the listed pets spawn there; a zone picked by hand stays until you move again.
watch(
  () => store.nearby.world,
  (now) => {
    if (now !== null && zones.value.some((z) => z.id === now)) worldId.value = now
  },
)
const world = computed(() => (spawns.value && worldId.value !== null ? spawns.value.worlds[worldId.value] ?? null : null))
const worldName = (id: number): string => spawns.value?.worlds[id]?.name ?? `#${id}`

/** You, on this map, when you are in this zone and the tracker knows where. */
const you = computed<[number, number] | null>(() => (here.value && here.value.world === worldId.value ? here.value.at : null))
/**
 * The map follows you (in the full window and the minimap alike), until it is dragged. It opens
 * following, at the zoom it opens at, unless the crosshair was last clicked off (kept in settings).
 */
const follow = ref(store.settings.mapFollow)
function toggleFollow(): void {
  follow.value = !follow.value
  void store.set('mapFollow', follow.value)
}

interface Row {
  pet: Pet
  points: [number, number][]
  monsters: { name: string; level: number }[]
  distance: number | null
}
/** The listed pets in this zone, nearest first when your position is known (else as the tab sorts them). */
const inZone = computed<Row[]>(() => {
  const rows: Row[] = []
  for (const pet of list.value) {
    const spawned = worldId.value !== null ? placed.value.get(pet.id)?.get(worldId.value) : undefined
    if (!spawned) continue
    const at = you.value
    const distance = at ? Math.min(...spawned.points.map(([x, y]) => Math.hypot(x - at[0], y - at[1]))) : null
    rows.push({ pet, points: spawned.points, monsters: spawned.monsters, distance })
  }
  return rows.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
})
/** The listed pets that do not spawn in this zone, with the zones they do. */
const elsewhere = computed(() =>
  list.value
    .filter((p) => worldId.value === null || !placed.value.get(p.id)?.has(worldId.value))
    .map((pet) => ({ pet, worlds: [...(placed.value.get(pet.id)?.keys() ?? [])].filter((w) => spawns.value?.worlds[w]) })),
)

const selected = ref<number | null>(null)
watch(
  inZone,
  (rows) => {
    if (!rows.some((r) => r.pet.id === selected.value)) selected.value = rows[0]?.pet.id ?? null
  },
  { immediate: true },
)
/**
 * Each pet keeps the colour it was first given while the map is open: the list re-sorts as you move
 * (Range, Nearby first), and colours by place in it changed under you. The next unused colour each
 * time, so the pets in view differ while there are colours left.
 */
const given = new Map<number, string>()
const colorOf = (id: number): string => {
  // A colour you picked stays, selected or not (the selected pet's spawns are bigger anyway).
  const picked = store.settings.mapStyles.pets[String(id)]?.color
  if (picked) return picked
  if (id === selected.value) return SELECTED
  let color = given.get(id)
  if (!color) {
    color = PALETTE[given.size % PALETTE.length]!
    given.set(id, color)
  }
  return color
}

const petStyle = (id: number): MarkStyle | null => store.settings.mapStyles.pets[String(id)] ?? null
const shapeOf = (id: number): MarkShape => petStyle(id)?.shape ?? 'circle'
const layers = computed<MapLayer[]>(() =>
  inZone.value.map((r) => ({
    key: r.pet.id,
    points: r.points,
    color: colorOf(r.pet.id),
    shape: shapeOf(r.pet.id),
    active: r.pet.id === selected.value,
  })),
)

/** A pet's or a kind of marker's picked look saved (null: back to the map's own). */
function setStyle(group: 'pets' | 'marks', key: string, style: MarkStyle | null): void {
  const styles = { ...store.settings.mapStyles[group] }
  if (style) styles[key] = style
  else delete styles[key]
  void store.set('mapStyles', { ...store.settings.mapStyles, [group]: styles })
}

/** A kind of addon marker: one addon's markers with one label (Nearby Nodes' "Odyle"). */
const kindKey = (addon: string, label: string | null): string => `${addon}/${label ?? ''}`
/** The addons' markers in the zone shown, in the look picked for their kind. */
const marks = computed<MapMark[]>(() =>
  addonMarkers.value.flatMap((a) =>
    a.markers
      .filter((m) => m.world === worldId.value)
      .map((m) => {
        const picked = store.settings.mapStyles.marks[kindKey(a.addon, m.label)]
        return { ...m, color: picked?.color ?? m.color, shape: picked?.shape ?? undefined }
      }),
  ),
)
/** The key under the map: each addon's kinds of marker in this zone, with how many and their look. */
const markKinds = computed(() =>
  addonMarkers.value
    .map((a) => {
      const kinds = new Map<string, { key: string; label: string | null; color: string; count: number }>()
      for (const m of a.markers) {
        if (m.world !== worldId.value) continue
        const key = kindKey(a.addon, m.label)
        const kind = kinds.get(key) ?? { key, label: m.label, color: m.color, count: 0 }
        kind.count++
        kinds.set(key, kind)
      }
      const list = [...kinds.values()]
        .map((k) => {
          const picked = store.settings.mapStyles.marks[k.key] ?? null
          return { ...k, picked, color: picked?.color ?? k.color, shape: picked?.shape ?? ('diamond' as MarkShape) }
        })
        .sort((x, y) => (x.label ?? '').localeCompare(y.label ?? ''))
      return { addon: a.addon, name: a.name, kinds: list }
    })
    .filter((a) => a.kinds.length),
)

/**
 * The selected pet's spawns, and you when you are here, so the view shows the way there. Set only
 * when the pet or zone changes: the map refits on every new focus, and you move all the time.
 */
const focus = ref<[number, number][]>([])
watch(
  [selected, worldId],
  () => {
    const row = inZone.value.find((r) => r.pet.id === selected.value)
    focus.value = row ? [...row.points, ...(you.value ? [you.value] : [])] : []
  },
  { immediate: true },
)

/** A pet from another zone: its zone's map, with it picked out. */
function showElsewhere(pet: Pet, worlds: number[]): void {
  if (!worlds.length) return
  worldId.value = worlds[0]!
  selected.value = pet.id
}
const monsterLine = (r: Row): string =>
  [...new Map(r.monsters.map((m) => [m.name, m])).values()].map((m) => `${m.name} (Lv${m.level})`).join(', ')
const progress = (pet: Pet): string => {
  const next = nextLevelSouls(pet)
  return next === null ? 'max' : `${pet.souls} / ${next}`
}
</script>

<template>
  <div v-if="store.mapMinimap" class="relative h-full">
    <WorldMap v-if="world" :world="world" :layers="layers" :focus="focus" :you="you" :marks="marks" :follow="follow" @unfollow="follow = false" bare />
    <div v-else class="flex h-full items-center justify-center p-2 text-center text-xs text-darker">No pets on this map.</div>
    <button
      v-if="world && you"
      type="button"
      :title="follow ? 'Following you: drag the map or click to stop' : 'Follow you: keep you in the middle'"
      :class="[
        'absolute right-7 top-1.5 flex size-5 items-center justify-center rounded transition',
        follow ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-black/55 text-white/85 hover:bg-black/75 hover:text-white',
      ]"
      @pointerdown.stop
      @dblclick.stop
      @click="toggleFollow"
    >
      <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <circle cx="8" cy="8" r="4.5" />
        <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
        <circle v-if="follow" cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    </button>
    <button
      type="button"
      title="Back to the full map"
      class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded bg-black/55 text-white/85 transition hover:bg-black/75 hover:text-white"
      @pointerdown.stop
      @dblclick.stop
      @click="store.setMapMinimap(false)"
    >
      <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
      </svg>
    </button>
    <div
      title="Drag to move"
      class="absolute bottom-1.5 right-1.5 flex size-5 cursor-move items-center justify-center rounded bg-black/55 text-white/85 transition hover:bg-black/75 hover:text-white"
      @pointerdown.stop="drag.onPointerDown"
      @dblclick.stop
    >
      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
      </svg>
    </div>
  </div>

  <div v-else class="flex h-full flex-col gap-3 p-3">
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-base font-semibold">Collection map</div>
        <div class="truncate text-xs text-darker">
          {{ list.length }} pet{{ list.length === 1 ? '' : 's' }} match the Collection's filters<template v-if="world">
            · {{ inZone.length }} in {{ world.name }}</template>
        </div>
      </div>
      <div v-if="zones.length" class="flex shrink-0 items-center gap-1.5 text-xs text-darker">
        Zone
        <Select
          :model-value="worldId ?? undefined"
          :options="zoneOptions"
          class="max-w-[220px]"
          title="Zone"
          @update:model-value="worldId = $event"
        />
      </div>
    </div>

    <p v-if="!spawns" class="text-sm text-darker">Loading drop locations…</p>
    <p v-else-if="!list.length" class="text-sm text-darker">No pets match the Collection's filters.</p>

    <div v-else class="flex min-h-0 flex-1 gap-3">
      <ul class="w-[300px] shrink-0 space-y-1 overflow-y-auto pr-1">
        <li
          v-for="r in inZone"
          :key="r.pet.id"
          :class="[
            'group cursor-pointer rounded-lg border px-2.5 py-2 transition',
            r.pet.id === selected ? 'border-accent bg-accent-soft/50' : 'border-card bg-card hover:border-light',
          ]"
          @click="selected = r.pet.id"
        >
          <div class="flex items-center gap-2">
            <MarkStyleButton
              :color="colorOf(r.pet.id)"
              :shape="shapeOf(r.pet.id)"
              :picked="petStyle(r.pet.id)"
              title="Colour and shape of its spawns on the map"
              @change="setStyle('pets', String(r.pet.id), $event)"
            />
            <PetIcon :id="r.pet.id" :size="26" />
            <span class="min-w-0 truncate text-sm font-medium">{{ displayName(r.pet) }}</span>
            <GenusPill :id="r.pet.id" />
            <span v-if="r.distance !== null" class="ml-auto shrink-0 text-xs font-semibold tabular-nums">
              {{ formatDistance(r.distance) }}
            </span>
            <button
              type="button"
              :class="['flex size-5 shrink-0 items-center justify-center rounded text-darkest transition hover:text-default', r.distance === null ? 'ml-auto' : '']"
              title="Show where its souls drop"
              @click.stop="store.openPet(r.pet.id)"
            >
              <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3l5 5-5 5" />
              </svg>
            </button>
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 pl-[18px] text-[11px] text-darker">
            <span class="truncate" :title="monsterLine(r)">{{ monsterLine(r) }}</span>
          </div>
          <div class="flex items-center gap-2 pl-[18px] text-[11px]">
            <LevelBadge :pet="r.pet" />
            <span class="tabular-nums text-darkest">{{ progress(r.pet) }}</span>
            <span v-if="near.get(r.pet.id)" class="font-semibold text-green">{{ near.get(r.pet.id)!.count }} around you</span>
          </div>
        </li>
        <li v-if="world && !inZone.length" class="px-1 py-2 text-xs text-darker">None of these pets spawn in {{ world.name }}.</li>

        <template v-if="elsewhere.length">
          <li class="px-1 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-darkest">Other zones</li>
          <li
            v-for="e in elsewhere"
            :key="e.pet.id"
            :class="[
              'flex items-center gap-2 rounded-lg border border-card px-2.5 py-1.5 opacity-70 transition',
              e.worlds.length ? 'cursor-pointer hover:border-light hover:opacity-100' : '',
            ]"
            :title="e.worlds.length ? `Show it on the ${worldName(e.worlds[0]!)} map` : ''"
            @click="showElsewhere(e.pet, e.worlds)"
          >
            <PetIcon :id="e.pet.id" :size="22" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-xs font-medium">{{ displayName(e.pet) }}</div>
              <div class="truncate text-[11px] text-darkest">
                {{ e.worlds.length ? e.worlds.map(worldName).join(', ') : 'not on the map' }}
              </div>
            </div>
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-darkest transition hover:text-default"
              title="Show where its souls drop"
              @click.stop="store.openPet(e.pet.id)"
            >
              <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3l5 5-5 5" />
              </svg>
            </button>
          </li>
        </template>
      </ul>

      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div class="relative min-h-0 flex-1">
          <WorldMap v-if="world" :world="world" :layers="layers" :focus="focus" :you="you" :marks="marks" :follow="follow" @unfollow="follow = false" />
          <button
            v-if="world && you"
            type="button"
            :title="follow ? 'Following you: drag the map or click to stop' : 'Follow you: keep you in the middle'"
            :class="[
              'absolute right-10 top-2 flex size-7 items-center justify-center rounded-md transition',
              follow ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-black/55 text-white/85 hover:bg-black/75 hover:text-white',
            ]"
            @pointerdown.stop
            @dblclick.stop
            @click="toggleFollow"
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <circle cx="8" cy="8" r="4.5" />
              <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
              <circle v-if="follow" cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button
            v-if="world"
            type="button"
            title="Minimap: only the map, in a small window"
            class="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md bg-black/55 text-white/85 transition hover:bg-black/75 hover:text-white"
            @pointerdown.stop
            @dblclick.stop
            @click="store.setMapMinimap(true)"
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.5 2.5L9 7M9 3.5V7h3.5M2.5 13.5L7 9M7 12.5V9H3.5" />
            </svg>
          </button>
          <div v-else class="flex h-full items-center justify-center rounded-lg border border-card text-sm text-darker">
            None of these pets' soul monsters are on the map.
          </div>
        </div>
        <div v-for="a in markKinds" :key="a.addon" class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-darker">
          <span class="font-semibold text-darkest">{{ a.name }}</span>
          <span v-for="k in a.kinds" :key="k.key" class="flex items-center gap-1">
            <MarkStyleButton
              :color="k.color"
              :shape="k.shape"
              :picked="k.picked"
              :title="`Colour and shape of ${k.label ?? 'these markers'} on the map`"
              @change="setStyle('marks', k.key, $event)"
            />
            {{ k.label ?? 'Marker' }}
            <span class="tabular-nums text-darkest">{{ k.count }}</span>
          </span>
        </div>
        <!-- Only while it says something, so the map has the room otherwise (questlog.gg is credited on the Collection tab and each pet's drop locations). -->
        <p v-if="world && !you" class="text-[11px] text-darkest">Your position shows here once the tracker knows it in {{ world.name }}.</p>
      </div>
    </div>
  </div>
</template>
