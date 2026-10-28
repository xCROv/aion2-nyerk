<script setup lang="ts">
// One addon page in a sandboxed frame: its own nyerk-addon:// origin, no Node and no bridge. Its
// calls and events go through lib/addonFrame.ts. `fit`: as tall as the page says it is (the HUD's
// sections), rather than filling its parent.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { connectAddonFrame } from '@/lib/addonFrame.ts'
import { ADDON_SCHEME } from '@shared/addons.ts'

const props = defineProps<{ addon: string; page: string; fit?: boolean; width?: number }>()
const emit = defineEmits<{ size: [height: number] }>()
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(0)
let disconnect: (() => void) | null = null
onMounted(() => {
  if (frame.value) {
    disconnect = connectAddonFrame(frame.value, props.addon, (h) => {
      height.value = h
      emit('size', h)
    })
  }
})
onBeforeUnmount(() => disconnect?.())
</script>

<template>
  <!-- Its colour scheme as the page's (dark, nyerk.css): where they differ, Chromium paints the
       frame an opaque backdrop instead of letting the window show through. -->
  <iframe
    ref="frame"
    :src="`${ADDON_SCHEME}://${addon}/${page}`"
    :title="addon"
    sandbox="allow-scripts allow-same-origin"
    :class="['block w-full border-0 bg-transparent [color-scheme:dark]', fit ? '' : 'h-full']"
    :style="{
      ...(fit ? { height: `${height}px` } : {}),
      ...(props.width && Number.isFinite(props.width) ? { width: `${props.width}px` } : {}),
    }"
  />
</template>
