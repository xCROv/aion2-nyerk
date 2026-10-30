/**
 * The field bosses (the Gartua timer): what the game's map said, and what other players' maps said.
 *
 * - The map: the tracker passes on the field boss list whenever it changes while the map is open.
 * - Sharing (Settings → Timers, on unless switched off): each list read from the map is sent to
 *   nyerk.app/a2/timers with the game server it came from (no character, no positions), and the
 *   crowd's confirmed state for that server is read back every POLL_MS while the game runs. The
 *   server serves a state only once several machines agree on it (server/aion2-api); the newer of
 *   the map's and the crowd's wins, boss by boss.
 * - Sharing is part of the Timers addon: nothing is sent or read while it is switched off.
 * - A "banned" answer stops sharing until the app restarts: nothing is asked again.
 *
 * Kept across restarts in `<userData>/fieldbosses.json`, by game server (a respawn 12 h away
 * outlives the app, and each server has its own bosses).
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { broadcast } from './broadcast.ts'
import { featureOn } from './builtins.ts'
import { game } from './game.ts'
import { machineHash } from './machine.ts'
import { settings } from './settings.ts'
import { log } from './tracker.ts'
import type { FieldBosses } from '../shared/timers.ts'

// A2T_API: another server, to try the sharing against a local aion2-api.
const API = process.env['A2T_API'] ?? 'https://nyerk.app/a2/timers'
const POLL_MS = 90_000
/** Uploads at most this often (the list comes every 3 s while the map is open). */
const UPLOAD_EVERY_MS = 30_000
const MAX_BOSSES = 64

export interface MapBoss {
  id: number
  up: boolean
  at: number
}

let server: number | null = null
let bosses: FieldBosses = {}
let banned = false
let lastUpload = 0
let pending: { world: number; list: MapBoss[]; seen: number } | null = null
let uploadTimer: NodeJS.Timeout | null = null

const file = (): string => join(app.getPath('userData'), 'fieldbosses.json')

function load(): void {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as { server?: number | null; bosses?: FieldBosses }
    server = saved.server ?? null
    bosses = saved.bosses ?? {}
  } catch {
    bosses = {}
  }
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify({ server, bosses }))
  } catch (err) {
    log(`field bosses: not saved: ${String(err)}`)
  }
}

function changed(): void {
  save()
  broadcast('tracker:fieldBosses', bosses)
}

export const fieldBosses = {
  all: (): FieldBosses => bosses,
  /** The last character's game server (kept across restarts), null until one has logged in. */
  server: (): number | null => server,

  /** The character's game server: field bosses are per server, so another one starts afresh. */
  setServer(next: number | null): void {
    if (next === null || next === server) return
    if (server !== null) log(`field bosses: server ${server} -> ${next}, starting afresh`)
    server = next
    bosses = {}
    changed()
    void poll()
  },

  /** A list read from the game's map. */
  fromMap(world: number, list: MapBoss[]): void {
    const seen = Date.now()
    bosses = { ...bosses, ...Object.fromEntries(list.map((b) => [b.id, { up: b.up, at: b.at, seen, source: 'map' as const }])) }
    // The Gartua of the list just read (Verteron's Eternal, Altgard's Immortal): a saved one from
    // another zone read as this list's (2026-10-30: a respawn hours gone, in an Altgard log).
    const g = list.find((b) => b.id === 101021 || b.id === 111021)
    log(
      `field bosses: zone ${world}, ${list.filter((b) => b.up).length}/${list.length} up` +
        (g ? `; Gartua ${g.up ? 'up' : `respawns ${new Date(g.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`}` : ''),
    )
    changed()
    queueUpload(world, list, seen)
  },
}

// A replay (A2T_REPLAY) never shares with the real server: its lists are old, and a trusted
// address would have them served to everyone. Only with A2T_API, a test server.
const replayOnly = Boolean(process.env['A2T_REPLAY']) && !process.env['A2T_API']
const sharing = (): boolean => !banned && !replayOnly && featureOn('timers') && settings.get('timers').share && server !== null

function headers(): Record<string, string> {
  return { 'X-A2-Machine': machineHash(), 'User-Agent': `Nyerk/${app.getVersion()}` }
}

/** A 403 saying "banned": stop asking. */
async function checkBanned(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  if ((await res.text()).trim() !== 'banned') return false
  banned = true
  log('field bosses: this machine is banned from the shared timers; sharing stopped')
  return true
}

function queueUpload(world: number, list: MapBoss[], seen: number): void {
  // An empty list, or zone 0 (the game sends both, from instances): nothing worth sharing.
  if (!list.length || !world) return
  pending = { world, list: list.slice(0, MAX_BOSSES), seen }
  if (uploadTimer) return
  const wait = Math.max(0, lastUpload + UPLOAD_EVERY_MS - Date.now())
  uploadTimer = setTimeout(() => {
    uploadTimer = null
    void upload()
  }, wait)
}

async function upload(): Promise<void> {
  const p = pending
  pending = null
  if (!p || !sharing()) return
  lastUpload = Date.now()
  const body = JSON.stringify({ server, world: p.world, observed: p.seen, bosses: p.list.map(({ id, up, at }) => ({ id, up, at })) })
  try {
    const res = await fetch(API, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body })
    if (await checkBanned(res)) return
    if (!res.ok) log(`field bosses: upload answered ${res.status}`)
  } catch (err) {
    log(`field bosses: upload failed: ${String(err)}`)
  }
}

async function poll(): Promise<void> {
  if (!sharing() || !(game.running() || process.env['A2T_REPLAY'])) return
  try {
    const res = await fetch(`${API}?server=${server}`, { headers: headers() })
    if (await checkBanned(res)) return
    if (!res.ok) return
    const data = (await res.json()) as { server?: unknown; bosses?: unknown }
    if (data.server !== server || typeof data.bosses !== 'object' || data.bosses === null) return
    let n = 0
    const next = { ...bosses }
    for (const [key, v] of Object.entries(data.bosses as Record<string, unknown>)) {
      const id = Number(key)
      const s = v as { up?: unknown; at?: unknown; observed?: unknown }
      // Only what fits the shape: the server builds it from numbers, but nothing is taken on trust.
      if (!Number.isInteger(id) || typeof s.up !== 'boolean' || !Number.isFinite(s.at) || !Number.isFinite(s.observed)) continue
      const mine = next[id]
      if (mine && mine.seen >= (s.observed as number)) continue
      next[id] = { up: s.up, at: s.at as number, seen: s.observed as number, source: 'shared' }
      n++
    }
    if (n) {
      bosses = next
      changed()
    }
  } catch {
    // Offline or the server is down: the map's own data stands.
  }
}

export function startFieldBosses(): void {
  load()
  setInterval(() => void poll(), POLL_MS).unref()
}
