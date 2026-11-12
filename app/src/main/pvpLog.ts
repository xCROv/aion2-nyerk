/**
 * The PvP kill feed: every player kill around you, oldest first, kept until Clear. Saved to
 * `<userData>/pvp.json` (a moment after each kill, so a siege's burst is one write), so a restart
 * or an update keeps it. Windows get each new kill on its own (`tracker:pvpKill`); the whole list
 * only when they open or it is cleared (`tracker:pvp`).
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, writeFileAtomicAsync } from './atomicWrite.ts'
import { broadcast } from './broadcast.ts'
import type { PvpKill } from '../shared/tracker.ts'

/** A siege gave some 3,000 an hour (2026-10-16); this only guards against a list never cleared. */
const KEEP = 50_000
const SAVE_AFTER_MS = 3000

let kills: PvpKill[] | null = null
let saveTimer: NodeJS.Timeout | null = null
const file = (): string => join(app.getPath('userData'), 'pvp.json')

function list(): PvpKill[] {
  if (kills === null) {
    try {
      const saved = JSON.parse(readFileSync(file(), 'utf8')) as unknown
      kills = Array.isArray(saved) ? (saved as PvpKill[]).map((k) => ({ ...k, legion: k.legion === true })) : []
    } catch {
      kills = [] // none saved yet, or unreadable: start empty
    }
  }
  return kills
}

function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeFileAtomicAsync(file(), JSON.stringify(list())).catch(() => {})
  }, SAVE_AFTER_MS)
}

export const pvpLog = {
  all: (): PvpKill[] => list(),
  add(kill: PvpKill): void {
    const all = list()
    all.push(kill)
    if (all.length > KEEP) all.splice(0, all.length - KEEP)
    broadcast('tracker:pvpKill', kill)
    save()
  },
  /** Write a pending save now (the app is quitting). */
  flush(): void {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    try {
      writeFileAtomic(file(), JSON.stringify(list()))
    } catch {
      // a full disk or a locked file: the last save stands
    }
  },
  clear(): void {
    kills = []
    broadcast('tracker:pvp', kills)
    save()
  },
}
