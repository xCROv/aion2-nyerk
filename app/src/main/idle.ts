/**
 * Asleep while Aion 2 is closed, so the app can be left running and cost next to nothing.
 *
 * Asleep: no bubble and no HUD (their windows are closed, not hidden: a hidden window keeps its
 * renderer process), no capture and no tracker process. Only the tray icon is left, and the game
 * watcher's check every few seconds (game.ts). The panel can still be opened from the tray; the
 * tracker then runs paused to serve the collection, and stops again LINGER_MS after the panel is
 * closed.
 *
 * Awake: everything as before. The game starting wakes the app at once, well before a character
 * enters the world and the login sync arrives. The game closing puts it to sleep after
 * EXIT_GRACE_MS, so a client restart does not lose the session's counts.
 *
 * Settings → "Sleep while Aion 2 is closed" turns this off; a replay (A2T_REPLAY) never sleeps.
 */
import { game } from './game.ts'
import { logNetworkSoftware } from './netcheck.ts'
import { settings } from './settings.ts'
import { log, startTracker, stopTracker, tracker } from './tracker.ts'
import { closeOverlays, createBubble, createHud, createKillFeed, onPanelVisible, panelVisible } from './windows.ts'

const EXIT_GRACE_MS = 20_000
const LINGER_MS = 120_000

let asleep: boolean | null = null
let graceTimer: NodeJS.Timeout | null = null
let lingerTimer: NodeJS.Timeout | null = null

const replay = Boolean(process.env['A2T_REPLAY'])

function sleepWanted(): boolean {
  return !replay && settings.get('sleepWithoutGame') && !game.running()
}

function clearTimers(): void {
  if (graceTimer) clearTimeout(graceTimer)
  if (lingerTimer) clearTimeout(lingerTimer)
  graceTimer = lingerTimer = null
}

function wake(why: string): void {
  clearTimers()
  if (asleep === false) return
  asleep = false
  log(`awake: ${why}`)
  void logNetworkSoftware(log)
  createBubble()
  createKillFeed()
  createHud()
  tracker.setCapture(true)
}

function sleep(why: string): void {
  clearTimers()
  if (asleep === true) return
  asleep = true
  log(`asleep: ${why}`)
  closeOverlays()
  tracker.setCapture(false)
  if (!panelVisible()) stopTracker()
}

/** Apply the current state: the game, the setting. */
function update(why: string): void {
  if (sleepWanted()) sleep(why)
  else wake(why)
}

/** Look for the game, wake or sleep accordingly, then follow the game and the setting. */
export async function startIdleWatch(): Promise<void> {
  await game.watch()
  update(game.running() ? 'Aion 2 is running' : 'Aion 2 is not running')

  game.onChange((running) => {
    if (running) return wake(`Aion 2 started (pid ${game.pid()})`)
    if (!sleepWanted() || graceTimer) return
    log(`Aion 2 closed; asleep in ${EXIT_GRACE_MS / 1000} s unless it starts again`)
    graceTimer = setTimeout(() => update('Aion 2 closed'), EXIT_GRACE_MS)
  })

  settings.onChanged(() => {
    if (sleepWanted() !== (asleep === true)) update('the setting changed')
  })

  onPanelVisible((visible) => {
    if (asleep !== true) return
    if (lingerTimer) clearTimeout(lingerTimer)
    lingerTimer = null
    // Paused (capture stays off while asleep): only to show and edit the collection.
    if (visible && !tracker.running()) startTracker()
    if (!visible) lingerTimer = setTimeout(() => asleep === true && !panelVisible() && stopTracker(), LINGER_MS)
  })
}
