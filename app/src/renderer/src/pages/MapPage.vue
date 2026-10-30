<script setup lang="ts">
// The map window: a pet's drop locations, or the collection's map, opened from the panel (or the
// merchant window) and kept beside the game while the panel goes back to its tabs. It moves by its
// header and resizes by its edges (main remembers both); the X or Escape closes it.
import { onBeforeUnmount, onMounted } from 'vue'
import CollectionMap from '@/components/panel/CollectionMap.vue'
import PetDetail from '@/components/panel/PetDetail.vue'
import { bridge } from '@/lib/bridge.ts'
import { windowDrag } from '@/lib/windowDrag.ts'
import { useApp } from '@/stores/app.ts'
import type { MapView } from '@shared/ipc.ts'

const store = useApp()
const drag = windowDrag({ move: 'map:moveTo', end: 'map:dragEnd' })
const close = (): void => void bridge().invoke('map:close')

function show(view: MapView): void {
  // A pet's drop locations need the full window.
  if (view.kind === 'pet') store.setMapMinimap(false)
  // The HUD's button opens the collection's map as a minimap (main has sized the window already).
  else if (view.minimap) store.setMapMinimap(true)
  store.openCollectionMap(view.kind === 'collection')
  store.openPet(view.kind === 'pet' ? view.pet : null)
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key !== 'Escape' || e.target instanceof HTMLInputElement) return
  // Escape leaves the minimap, or backs out of a pet opened from the collection's map, before it
  // closes the window.
  if (store.mapMinimap) store.setMapMinimap(false)
  else if (store.openPetId !== null && store.collectionMapOpen) store.openPet(null)
  else close()
}

const offs: (() => void)[] = []
onMounted(async () => {
  window.addEventListener('keydown', onKey)
  offs.push(bridge().on('map:show', show))
  offs.push(bridge().on('map:collectionView', (v) => store.applyCollectionView(v)))
  const { view, collection } = await bridge().invoke('map:get')
  if (collection) store.applyCollectionView(collection)
  if (view) show(view)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  for (const off of offs) off()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-app">
    <header v-if="!store.mapMinimap" class="flex cursor-move items-center gap-2 border-b border-card px-3 py-1.5" title="Drag to move" @pointerdown="drag.onPointerDown">
      <img src="/icon.png" alt="" class="size-5" draggable="false" />
      <span class="text-xs font-semibold uppercase tracking-wide text-darker">
        {{ store.openPetId !== null ? 'Drop locations' : 'Collection map' }}
      </span>
      <button
        type="button"
        title="Close (Esc)"
        class="ml-auto flex size-6 items-center justify-center rounded-md text-darker transition hover:bg-light hover:text-default"
        @pointerdown.stop
        @click="close"
      >
        <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>
    <main :class="['min-h-0 flex-1', store.mapMinimap ? 'overflow-hidden' : 'overflow-y-auto']">
      <div v-if="!store.ready" class="p-6 text-center text-sm text-darker">Loading…</div>
      <PetDetail v-else-if="store.openPetId !== null" :id="store.openPetId" />
      <CollectionMap v-else-if="store.collectionMapOpen" />
    </main>
  </div>
</template>
