/**
 * The Timers tab's alerts: every 15 s, while the game runs, which enabled timers are inside their
 * alert window (from a few minutes before a start until 2 minutes after; shared/timers.ts). A new
 * one is announced once (the bubble chimes), and the bubble shakes while any are up. A click on the
 * bubble dismisses them until their next start.
 *
 * Also, for addons: the next resets and every timer's next start (`timers:state`, the `timers`
 * event), sent when any of them moves on, whether or not the game runs.
 */
import { broadcast } from './broadcast.ts'
import { featureOn } from './builtins.ts'
import { fieldBosses } from './fieldBosses.ts'
import { game } from './game.ts'
import { gameTimes } from './gameTimes.ts'
import { settings } from './settings.ts'
import { log, tracker } from './tracker.ts'
import {
  alertingStart,
  resolveRegion,
  TIMERS,
  timersState,
  type Region,
  type TimerAlert,
  type TimersState,
} from '../shared/timers.ts'

const CHECK_MS = 15_000

let alerting: TimerAlert[] = []
/** Alerts dismissed, as `${id}@${start}`: each start alerts once. */
const done = new Set<string>()
const key = (a: TimerAlert): string => `${a.id}@${a.at}`
/** Alerts the app announced before an update restart: they show again without a second chime. */
let announced = new Set<string>()
let state: TimersState | null = null
/** The setting's region, or with Automatic the last character's server's. */
const region = (): Region => resolveRegion(settings.get('timers').region, fieldBosses.server())
const currentState = (now: number): TimersState =>
  timersState(now, region(), featureOn('timers'), tracker.fieldBosses(), fieldBosses.server(), gameTimes.of(fieldBosses.server()))

function check(): void {
  const now = Date.now()
  const cfg = settings.get('timers')
  const nextState = currentState(now)
  if (JSON.stringify(nextState) !== JSON.stringify(state)) {
    state = nextState
    broadcast('timers:state', state)
  }
  // Only while the game runs (or a replay stands in for it): alerts are for playing. None while the
  // Timers addon is switched off (a settings change: the alerts up go at once).
  const live = featureOn('timers') && (game.running() || Boolean(process.env['A2T_REPLAY']))
  const next: TimerAlert[] = []
  if (live) {
    for (const def of TIMERS) {
      // Only the timers listed in the Timers tab alert: a hidden one would ring unseen.
      if (!cfg.enabled[def.id] || !cfg.shown[def.id]) continue
      const at = alertingStart(def, now, nextState.region, cfg.lead[def.id], tracker.fieldBosses(), nextState.game)
      if (at !== null && !done.has(`${def.id}@${at}`)) next.push({ id: def.id, at })
    }
  }
  const was = new Set(alerting.map(key))
  for (const a of next) {
    if (was.has(key(a)) || announced.has(key(a))) continue
    log(`timer: ${a.id} at ${new Date(a.at).toISOString().slice(11, 16)} UTC`)
    broadcast('timers:alert', a)
  }
  if (next.length !== alerting.length || next.some((a) => !was.has(key(a)))) {
    alerting = next
    broadcast('timers:alerting', alerting)
  }
  // Starts long gone need no remembering.
  for (const k of done) if (Number(k.split('@')[1]) < now - 86_400_000) done.delete(k)
}

export const timers = {
  alerting: (): TimerAlert[] => alerting,
  /** The resets and next starts, as addons get them. */
  state: (): TimersState => (state ??= currentState(Date.now())),
  /** For an update restart: the alerts seen, so the new start does not chime them again. */
  snapshot: (): { done: string[]; alerting: string[] } => ({ done: [...done], alerting: alerting.map(key) }),
  /** After an update restart: alerts already announced stay quiet; dismissed ones stay dismissed. */
  restore(seen: { done: string[]; alerting: string[] }): void {
    for (const k of seen.done) done.add(k)
    announced = new Set(seen.alerting)
  },
  /** A click on the bubble: these alerts are seen. */
  dismiss(): void {
    if (!alerting.length) return
    for (const a of alerting) done.add(key(a))
    alerting = []
    broadcast('timers:alerting', alerting)
  },
}

export function startTimers(): void {
  check()
  setInterval(check, CHECK_MS).unref()
  settings.onChanged(() => check())
}
