/**
 * The starts the game itself gave for the timers' schedules (the tracker's `gameTime` events: the
 * next daily reset at login, the weekly one with the weekly limits, the next siege on entering the
 * Abyss). The Timers follow them (shared/timers.ts nextStart), so a region whose schedule is
 * wrong, or a time the game has moved, comes right from the game itself.
 *
 * Kept by game server across restarts, in `<userData>/gametimes.json`: a reset seen at Monday's
 * login still places Wednesday's, and each server has its own.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './tracker.ts'
import { TIMERS, type GameTimes, type TimerId } from '../shared/timers.ts'

let loaded: Record<string, GameTimes> | null = null

const file = (): string => join(app.getPath('userData'), 'gametimes.json')

/** Read from disk on first use (not on import: the user-data folder is settled by then). */
function all(): Record<string, GameTimes> {
  if (loaded) return loaded
  try {
    loaded = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, GameTimes>
  } catch {
    loaded = {}
  }
  return loaded
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify(all()))
  } catch (err) {
    log(`game times: not saved: ${String(err)}`)
  }
}

export const gameTimes = {
  /** The game's starts for this server (none until one is seen). */
  of: (server: number | null): GameTimes => (server === null ? {} : (all()[server] ?? {})),

  /** A start the game gave, on `server`. False when it was already known (or not a timer's). */
  seen(server: number | null, timer: string, at: number): boolean {
    if (server === null || !Number.isFinite(at) || !TIMERS.some((t) => t.id === timer)) return false
    const times = (all()[server] ??= {})
    if (times[timer as TimerId] === at) return false
    times[timer as TimerId] = at
    log(`game times: ${timer} at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC (server ${server})`)
    save()
    return true
  },
}
