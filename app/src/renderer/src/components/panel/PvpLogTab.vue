<script setup lang="ts">
// The PvP kill feed: every player killed by a player around you this session, newest first, as the
// game credits it (the killing blow). Your kills in green, your deaths in red; players from other
// servers carry their server's tag ([LUM]).
import { computed, onBeforeUnmount, ref } from 'vue'
import Button from '@/components/Button.vue'
import { bridge } from '@/lib/bridge.ts'
import { useApp } from '@/stores/app.ts'
import { serverName, serverTag } from '@shared/servers.ts'
import type { PvpKill } from '@shared/tracker.ts'

const store = useApp()
const kills = computed(() => [...store.pvp].reverse())
const myServer = computed(() => store.status?.server ?? null)
const tag = (server: number | null): string | null => (server === null || server === myServer.value ? null : serverTag(server))
// One filter at a time; clicking the active one shows everything again.
type Filter = 'mine' | 'legion' | 'server'
const filters: { id: Filter; label: string; title: string; empty: string }[] = [
  { id: 'mine', label: 'Mine', title: 'Your kills and deaths', empty: 'No kills or deaths of yours yet.' },
  { id: 'legion', label: 'My Guild', title: "Kills and deaths of your legion's members, yours included", empty: 'No kills or deaths of your legion yet.' },
  { id: 'server', label: 'Server vs Server', title: 'Kills between your server and other servers', empty: 'No kills between your server and another yet.' },
]
const filter = ref<Filter | null>(null)
/** Server vs Server narrowed to one enemy server (a click on its tally). */
const enemy = ref<number | null>(null)
function pick(id: Filter): void {
  filter.value = filter.value === id ? null : id
  enemy.value = null
  limit.value = PAGE
}
function pickEnemy(server: number): void {
  enemy.value = enemy.value === server ? null : server
  limit.value = PAGE
}
/** The other server of a kill between ours and another, and whether we got the kill; null for any other kill. */
function versus(k: PvpKill): { server: number; ours: boolean } | null {
  const me = myServer.value
  const victim = k.victim?.server ?? null
  if (me === null || victim === null) return null
  if (k.killer.server === me && victim !== me) return { server: victim, ours: true }
  if (victim === me && k.killer.server !== me) return { server: k.killer.server, ours: false }
  return null
}
const filtered = computed(() => {
  if (filter.value === 'mine') return kills.value.filter((k) => k.mine || k.died)
  if (filter.value === 'legion') return kills.value.filter((k) => k.legion)
  if (filter.value === 'server')
    return kills.value.filter((k) => {
      const v = versus(k)
      return v !== null && (enemy.value === null || v.server === enemy.value)
    })
  return kills.value
})
/** Per enemy server: our kills on them and theirs on us, the most fought first. */
const tallies = computed(() => {
  const by = new Map<number, { server: number; us: number; them: number }>()
  for (const k of store.pvp) {
    const v = versus(k)
    if (!v) continue
    const t = by.get(v.server) ?? { server: v.server, us: 0, them: 0 }
    if (v.ours) t.us++
    else t.them++
    by.set(v.server, t)
  }
  return [...by.values()].sort((a, b) => b.us + b.them - (a.us + a.them))
})
// The newest rows only (a siege lists thousands); more on request.
const PAGE = 200
const limit = ref(PAGE)
const shown = computed(() => filtered.value.slice(0, limit.value))
const counts = computed(() => ({
  kills: store.pvp.filter((k) => k.mine).length,
  deaths: store.pvp.filter((k) => k.died).length,
}))

// "2 min ago": redrawn every 15 s.
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 15_000)
onBeforeUnmount(() => clearInterval(ticker))
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function ago(ms: number): string {
  const s = Math.max(0, Math.round((now.value - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : time(ms)
}
const rowClass = (k: PvpKill): string =>
  k.mine ? 'bg-green/10 border-l-2 border-green' : k.died ? 'bg-danger/10 border-l-2 border-danger' : 'border-l-2 border-transparent'
const clear = (): void => void bridge().invoke('tracker:clearPvp')
/** The kill feed over the game (its own small window). */
const hudOpen = computed(() => store.settings.killFeed.open)
const toggleHud = (): void => void bridge().invoke(hudOpen.value ? 'killfeed:close' : 'killfeed:open')
</script>

<template>
  <div class="space-y-3 p-3">
    <div class="flex items-center gap-2 text-xs">
      <span class="rounded-md bg-card px-2 py-1"><span class="font-semibold text-green">{{ counts.kills }}</span> kills</span>
      <span class="rounded-md bg-card px-2 py-1"><span class="font-semibold text-danger">{{ counts.deaths }}</span> deaths</span>
      <Button size="sm" class="ml-auto" :disabled="!store.pvp.length" @click="clear">Clear</Button>
      <Button size="sm" :intent="hudOpen ? 'default' : 'primary'" :title="hudOpen ? 'Close the kill feed over the game' : 'A small kill feed over the game'" @click="toggleHud">
        {{ hudOpen ? 'Close HUD' : 'Open HUD' }}
      </Button>
    </div>

    <div class="flex items-center gap-1.5 text-xs">
      <button
        v-for="f in filters"
        :key="f.id"
        type="button"
        :title="f.title"
        :class="['rounded-full border px-2.5 py-0.5', filter === f.id ? 'border-accent bg-accent/15 text-default' : 'border-light text-darker hover:text-dark']"
        @click="pick(f.id)"
      >
        {{ f.label }}
      </button>
      <!-- How many kills the list below holds (with the filter). -->
      <span class="ml-auto rounded-full bg-card px-2 py-0.5 tabular-nums text-dark" :title="`${filtered.length} kill${filtered.length === 1 ? '' : 's'} in the list`">{{ filtered.length }}</span>
    </div>

    <!-- Server vs Server: each enemy server's score against ours; a click shows that server only. -->
    <div v-if="filter === 'server' && tallies.length" class="flex flex-wrap gap-1.5 text-xs">
      <button
        v-for="t in tallies"
        :key="t.server"
        type="button"
        :title="`Us ${t.us} kills on ${serverName(t.server)}, ${serverName(t.server)} ${t.them} kills on us`"
        :class="['flex items-center gap-1.5 rounded-md border px-2 py-1', enemy === t.server ? 'border-accent bg-accent/15' : 'border-card bg-card hover:border-light']"
        @click="pickEnemy(t.server)"
      >
        <span class="font-semibold text-yellow">[{{ serverTag(t.server) }}]</span>
        <span class="font-semibold tabular-nums text-danger">{{ t.them }}</span>
        <span class="text-darker">vs</span>
        <span class="font-semibold tabular-nums text-green">{{ t.us }}</span>
        <span class="text-dark">us</span>
      </button>
    </div>

    <ul v-if="filtered.length" class="divide-y divide-[color:var(--gray-4)] overflow-hidden rounded-lg border border-card bg-card">
      <li v-for="(k, i) in shown" :key="`${k.at}-${i}`" :class="['flex items-center gap-2 px-3 py-2 text-sm', rowClass(k)]">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate font-medium" :class="k.mine && 'text-green'">{{ k.killer.name }}</span>
            <span v-if="tag(k.killer.server)" class="shrink-0 text-[11px] text-yellow" :title="serverName(k.killer.server)">[{{ tag(k.killer.server) }}]</span>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-darker" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="truncate font-medium" :class="k.died && 'text-danger'">{{ k.victim?.name ?? 'a player out of view' }}</span>
            <span v-if="k.victim && tag(k.victim.server)" class="shrink-0 text-[11px] text-yellow" :title="serverName(k.victim.server!)">[{{ tag(k.victim.server) }}]</span>
          </div>
          <div v-if="k.killer.guild" class="truncate text-[11px] text-darker">{{ k.killer.guild }}</div>
        </div>
        <span class="shrink-0 text-[11px] tabular-nums text-darker" :title="time(k.at)">{{ ago(k.at) }}</span>
      </li>
    </ul>
    <button
      v-if="filtered.length > shown.length"
      type="button"
      class="w-full rounded-lg border border-card bg-card py-1.5 text-xs text-darker hover:text-dark"
      @click="limit += PAGE"
    >
      Show older ({{ filtered.length - shown.length }} more)
    </button>
    <p v-if="!filtered.length" class="rounded-lg border border-card bg-card px-3 py-6 text-center text-sm text-darker">
      {{ filters.find((f) => f.id === filter)?.empty ?? 'No player kills seen yet.' }}
    </p>

    <p class="text-[11px] text-darkest">
      Player kills around you, as the game credits them: the killing blow only, so an assist is not
      a kill here. Kept until you clear them, across restarts.
    </p>
  </div>
</template>
