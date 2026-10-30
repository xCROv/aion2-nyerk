/**
 * The Python tracker as a child process (`python -m aion2_tracker.sidecar`), and the state the
 * windows render from: the pets, the tracker's status, and souls as they arrive.
 *
 * The protocol is JSON lines both ways (aion2_tracker/sidecar.py documents it). The process is
 * restarted with a backoff if it dies, and killed synchronously when the app exits: on Windows a
 * child outlives its parent otherwise (a marnis-app lesson).
 *
 * Environment overrides, for development:
 *   A2T_ROOT          the repo (where aion2_tracker/ is); found by walking up from the app otherwise
 *   A2T_PYTHON        the interpreter (also a setting); <root>/.venv/Scripts/python.exe otherwise
 *   A2T_REPLAY        a .pcap to replay instead of watching the game, to try the UI without it
 *   A2T_REPLAY_SPEED  its speed, as a multiple of real time (default 1)
 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DISPLAY_NAME } from '../shared/app.ts'
import { broadcast } from './broadcast.ts'
import { settings } from './settings.ts'
import { kinaBalance, kinaRebase, NO_KINA, type KinaSession } from '../shared/kina.ts'
import { fieldBosses } from './fieldBosses.ts'
import { gameTimes } from './gameTimes.ts'
import { featureOn } from './builtins.ts'
import { pvpLog } from './pvpLog.ts'
import type { SessionCounts } from './restart.ts'
import { appVersion, shellVersion } from './version.ts'
import type { FieldBosses } from '../shared/timers.ts'
import { GAME_ACTIVE_S, NO_NEARBY, stockExpired, type Nearby, type Pet, type PvpKill, type ShopItem, type ShopStock, type SoulToast, type TrackerStatus } from '../shared/tracker.ts'

const RESTART_DELAYS_MS = [1000, 3000, 10000, 30000]
/** How long an update restart waits for the helper to hand over the session's counts. */
const DUMP_TIMEOUT_MS = 1500

let child: ChildProcessWithoutNullStreams | null = null
/** Whether the sidecar should be capturing: only while the game runs (see idle.ts). */
let capturing = true
let stopping = false
let restarts = 0
let restartTimer: NodeJS.Timeout | null = null
let stderrTail: string[] = []
const pets = new Map<number, Pet>()
let nearby: Nearby = NO_NEARBY
/** The Black Cloud Merchant's stock: the latest of each tab opened, kept until its restock. */
const shopTabs = new Map<number, ShopStock>()
const currentShop = (): ShopStock[] => {
  const now = Date.now()
  for (const [tab, s] of shopTabs) if (stockExpired(s, now)) shopTabs.delete(tab)
  return [...shopTabs.values()]
}

/** Kina earned since the app started (or the last reset). */
let kina: KinaSession = NO_KINA
/** Session counts carried across an update restart, handed to the helper once it is ready. */
let restoring: { sessions: SessionCounts; world: number | null; position: [number, number] | null } | null = null
/** Waiting for the helper's answer to dumpSession. */
let dumpWaiter: ((sessions: SessionCounts | null) => void) | null = null
function setKina(next: KinaSession): void {
  kina = next
  broadcast('tracker:kina', kina)
}
const soulListeners = new Set<(toast: SoulToast) => void>()
const statusListeners = new Set<(status: TrackerStatus) => void>()
const shopListeners = new Set<(stock: ShopStock[]) => void>()
/** Addons' Python parts: `--addon <id>=<file>` for each (main/addons.ts sets them). */
let addonArgs: string[] = []
/** Whether the helper running was started with debug logging. */
let debugArgs = false
const addonLineListeners = new Set<(ev: Record<string, unknown>) => void>()

let status: TrackerStatus = {
  state: 'starting',
  detail: null,
  lastPacketAgo: null,
  gameActive: false,
  replay: false,
  synced: null,
  dataFile: null,
  character: null,
  server: null,
}

/**
 * `<userData>/logs/tracker.log`: what the tracker said on stderr and every state change, started
 * afresh each launch. For testers to send when something goes wrong.
 */
export function logPath(): string {
  return join(app.getPath('userData'), 'logs', 'tracker.log')
}
let logReady = false
export function log(line: string): void {
  try {
    if (!logReady) {
      mkdirSync(dirname(logPath()), { recursive: true })
      const version = appVersion() === shellVersion() ? appVersion() : `${appVersion()} on shell ${shellVersion()}`
      writeFileSync(logPath(), `${DISPLAY_NAME} ${version} (${app.isPackaged ? 'installed' : 'development'})\n`)
      logReady = true
    }
    appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A log that cannot be written must not stop the tracker.
  }
}

function setStatus(patch: Partial<TrackerStatus>): void {
  if ((patch.state && patch.state !== status.state) || (patch.detail && patch.detail !== status.detail)) {
    log(`status: ${patch.state ?? status.state}${patch.detail ? ` (${patch.detail})` : ''}`)
  }
  const wasActive = status.gameActive
  status = { ...status, ...patch }
  status.gameActive = status.lastPacketAgo !== null && status.lastPacketAgo < GAME_ACTIVE_S
  // What the panel shows as "Tracking" / "Game connection idle", in the log too: when reading
  // stopped, and whether it came back.
  if (status.state === 'locked' && status.gameActive !== wasActive) {
    log(status.gameActive ? 'game connection: reading' : `game connection idle: no game packet for ${GAME_ACTIVE_S}s`)
  }
  broadcast('tracker:status', status)
  for (const fn of statusListeners) fn(status)
}

/** The repo: the folder holding aion2_tracker/, searched upwards from the app. */
function repoRoot(): string | null {
  const env = process.env['A2T_ROOT']
  if (env) return env
  let dir = resolve(app.getAppPath())
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'aion2_tracker', 'sidecar.py'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * The collection file. In development a first run takes over the one the command-line tracker
 * kept in the repo; an installed app starts empty and fills from the next login sync.
 */
function dataFile(root: string | null): string {
  const configured = settings.get('tracker').dataFile
  if (configured) return configured
  const file = join(app.getPath('userData'), 'collection.json')
  const legacy = root ? join(root, 'collection.json') : null
  if (legacy && !existsSync(file) && existsSync(legacy)) {
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(legacy, file)
  }
  return file
}

/** Npcap is what the tracker captures with; it cannot be bundled, so each user installs it. */
function npcapInstalled(): boolean {
  const system = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
  return existsSync(join(system, 'Npcap', 'wpcap.dll')) || existsSync(join(system, 'wpcap.dll'))
}

/**
 * What to run. An installed app runs the packaged helper (resources/sidecar/aion2-tracker.exe,
 * built by PyInstaller: no Python needed); development runs the repo's Python.
 */
function trackerCommand(): { exe: string; args: string[]; cwd: string; root: string | null } | string {
  const packaged = join(process.resourcesPath, 'sidecar', 'aion2-tracker.exe')
  if (app.isPackaged) {
    return existsSync(packaged) ? { exe: packaged, args: [], cwd: dirname(packaged), root: null } : `The tracker is missing from the install (${packaged}). Reinstall the app.`
  }
  const root = repoRoot()
  if (!root) return 'Could not find the aion2_tracker folder next to the app (set A2T_ROOT).'
  const python = settings.get('tracker').python || process.env['A2T_PYTHON'] || join(root, '.venv', 'Scripts', 'python.exe')
  if (!existsSync(python)) return `Python not found at ${python}. Create the venv (.venv in the repo) or set it in Settings.`
  return { exe: python, args: ['-u', '-m', 'aion2_tracker.sidecar'], cwd: root, root }
}

export function startTracker(): void {
  if (child) return
  stopping = false
  const replay = process.env['A2T_REPLAY']
  if (!replay && !npcapInstalled()) {
    setStatus({
      state: 'error',
      detail: 'Npcap is not installed. Install it from https://npcap.com (the default options are fine), then Restart tracker.',
    })
    return
  }
  const cmd = trackerCommand()
  if (typeof cmd === 'string') {
    setStatus({ state: 'error', detail: cmd })
    return
  }
  const data = dataFile(cmd.root)
  const args = [...cmd.args, '--data', data]
  if (replay) args.push('--replay', replay, '--speed', process.env['A2T_REPLAY_SPEED'] ?? '1')
  else if (!capturing) args.push('--paused')
  args.push(...addonArgs)
  if (settings.get('debugLogging')) args.push('--debug-dir', dirname(logPath()))
  debugArgs = settings.get('debugLogging')

  stderrTail = []
  setStatus({ state: 'starting', detail: null, dataFile: data, replay: Boolean(replay), lastPacketAgo: null })
  const proc = spawn(cmd.exe, args, {
    cwd: cmd.cwd,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  })
  child = proc

  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) handleLine(line)
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    const lines = chunk.split(/\r?\n/).filter(Boolean)
    for (const line of lines) log(`tracker: ${line}`)
    stderrTail = [...stderrTail, ...lines].slice(-20)
  })
  proc.on('error', (err) => {
    setStatus({ state: 'error', detail: `Could not start the tracker: ${err.message}` })
  })
  proc.on('exit', (code) => {
    // Stopped on purpose, or replaced by a restart (whose new helper is `child` by now): not a crash.
    if (child !== proc) return
    child = null
    if (stopping) return
    const why = stderrTail.at(-1) ?? `exit code ${code}`
    if (restarts >= RESTART_DELAYS_MS.length) {
      setStatus({ state: 'error', detail: `The tracker keeps stopping: ${why}` })
      return
    }
    const delay = RESTART_DELAYS_MS[restarts++]!
    setStatus({ state: 'exited', detail: `Tracker stopped (${why}); restarting in ${delay / 1000}s` })
    restartTimer = setTimeout(startTracker, delay)
  })
}

function handleLine(line: string): void {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(line)
  } catch {
    stderrTail = [...stderrTail, `unparsed: ${line}`].slice(-20)
    return
  }
  switch (ev['type']) {
    case 'addon':
    case 'addonLoaded':
    case 'addonError':
      for (const fn of addonLineListeners) fn(ev)
      break
    case 'ready':
      restarts = 0
      replacePets(ev['pets'] as Pet[])
      if (restoring) {
        // After an update restart: the session's counts as they were (answered with a snapshot).
        command({ cmd: 'restoreSession', ...restoring })
        log(`session restored from before the restart: ${Object.values(restoring.sessions).reduce((n, pets) => n + Object.values(pets).reduce((a, b) => a + b, 0), 0)} souls`)
        restoring = null
      }
      setStatus({
        character: (ev['character'] as { name: string } | null)?.name ?? null,
        server: (ev['character'] as { server?: number } | null)?.server ?? null,
      })
      fieldBosses.setServer((ev['character'] as { server?: number } | null)?.server ?? null)
      break
    case 'character': {
      // Another character entered the world: its own collection (pet levels are per character).
      const name = ev['name'] as string
      log(`character: ${name}${ev['server'] ? ` (server ${ev['server']})` : ''}${ev['switched'] ? ', switched collection' : ''}`)
      replacePets(ev['pets'] as Pet[])
      setStatus({ character: name, server: (ev['server'] as number | undefined) ?? null })
      fieldBosses.setServer((ev['server'] as number | undefined) ?? null)
      break
    }
    case 'status': {
      const state = ev['state'] as TrackerStatus['state']
      const detail = state === 'locked' ? `Game server ${ev['server']}` : ((ev['detail'] as string | undefined) ?? null)
      // Paused, the heartbeats stop: the last one must not keep saying the game is active.
      setStatus(state === 'idle' ? { state, detail, lastPacketAgo: null } : { state, detail })
      break
    }
    case 'heartbeat':
      setStatus({ lastPacketAgo: ev['lastPacketAgo'] as number | null })
      break
    case 'sync': {
      log(`login sync: ${ev['pets']} pets, ${ev['souls']} souls`)
      // Entering the world, maybe as another character: its Kina is a new starting point.
      setKina(kinaRebase(kina))
      replacePets(ev['collection'] as Pet[])
      setStatus({ synced: { at: Date.now(), pets: ev['pets'] as number, souls: ev['souls'] as number } })
      break
    }
    case 'soul': {
      const pet = ev['pet'] as Pet
      updatePet(pet)
      // Every soul, with the running totals: what to compare against when counts look wrong.
      const sessionTotal = [...pets.values()].reduce((n, p) => n + p.session, 0)
      log(`soul: +${ev['amount']} pet ${pet.id}${pet.name ? ` (${pet.name})` : ''} -> ${pet.souls} souls; session ${pet.session} for this pet, ${sessionTotal} in all`)
      const toast: SoulToast = {
        pet,
        amount: ev['amount'] as number,
        at: Date.now(),
        levelUp: ev['levelUp'] === true,
        crystal: false,
      }
      if (ev['levelUndone'] === true) log(`level: pet ${pet.id}${pet.name ? ` (${pet.name})` : ''} got a soul, so it is not Lv3: back to Lv${pet.level}, its crystals since taken off`)
      if (toast.levelUp) log(`level up: pet ${pet.id}${pet.name ? ` (${pet.name})` : ''} is now Lv${pet.level}`)
      broadcast('tracker:soul', toast)
      for (const fn of soulListeners) fn(toast)
      break
    }
    case 'crystal': {
      // Genus crystals: the pet is maxed. No pet when none of the kills just before could be it;
      // the kills it considered are logged then, and the raw body always.
      const pet = ev['pet'] as Pet | null
      const kills = (ev['kills'] as { npc: number | null; name: string | null; pet: number | null; ago: number }[] | undefined) ?? []
      const considered = kills.length
        ? kills.map((k) => `${k.name ?? `monster ${k.npc ?? '?'}`}${k.pet ? ` (pet ${k.pet})` : ' (no pet)'} ${k.ago}s before`).join(', ')
        : 'no kill just before'
      log(`crystal: +${ev['amount']} ${ev['genus'] ?? 'unknown genus'} ${pet ? `pet ${pet.id}${pet.name ? ` (${pet.name})` : ''} -> ${pet.crystals} crystals` : `credited to no pet; kills: ${considered}`} [${ev['raw']}]`)
      if (ev['levelCorrected'] === true && pet) log(`level: pet ${pet.id}${pet.name ? ` (${pet.name})` : ''} is at Lv${pet.level} in game (it gets crystals): corrected`)
      if (!pet) break
      updatePet(pet)
      const toast: SoulToast = { pet, amount: ev['amount'] as number, at: Date.now(), levelUp: false, crystal: true }
      broadcast('tracker:soul', toast)
      for (const fn of soulListeners) fn(toast)
      break
    }
    case 'combat':
      broadcast('tracker:combat', Date.now())
      break
    case 'fieldBosses':
      fieldBosses.fromMap(ev['world'] as number, ev['bosses'] as { id: number; up: boolean; at: number }[])
      break
    case 'gameTime':
      // A start the game gave for a timer (the next reset, the next siege): the Timers follow it.
      gameTimes.seen(fieldBosses.server(), ev['timer'] as string, ev['at'] as number)
      break
    case 'pvpKill': {
      // The PvP Log addon switched off: no kills kept (those kept stay for when it is back on).
      if (!featureOn('pvp-log')) break
      const kill: PvpKill = {
        at: Date.now(),
        killer: ev['killer'] as PvpKill['killer'],
        victim: (ev['victim'] as PvpKill['victim']) ?? null,
        mine: ev['mine'] === true,
        died: ev['died'] === true,
        legion: ev['legion'] === true,
      }
      pvpLog.add(kill)
      log(`pvp: ${kill.killer.name} (${kill.killer.server}) killed ${kill.victim ? `${kill.victim.name} (${kill.victim.server ?? '?'})` : 'a player out of view'}${kill.mine ? ' [you]' : kill.died ? ' [you died]' : ''}`)
      break
    }
    case 'kina':
      setKina(kinaBalance(kina, ev['balance'] as number, Date.now()))
      break
    case 'shop': {
      const stock: ShopStock = {
        tab: ev['tab'] as number,
        nextAt: (ev['nextAt'] as number | null) ?? null,
        at: Date.now(),
        items: ev['items'] as ShopItem[],
      }
      shopTabs.set(stock.tab, stock)
      const restock = stock.nextAt ? new Date(stock.nextAt).toISOString().slice(11, 16) + ' UTC' : 'unknown'
      log(`merchant: tab ${stock.tab}, ${stock.items.length} items (${stock.items.map((i) => `${i.item}@${i.price}`).join(' ')}); restocks ${restock}`)
      broadcast('tracker:shop', currentShop())
      for (const fn of shopListeners) fn(currentShop())
      break
    }
    case 'pet':
      updatePet(ev['pet'] as Pet)
      break
    case 'snapshot':
      replacePets(ev['pets'] as Pet[])
      break
    case 'nearby': {
      const position = ev['position'] as Nearby['position']
      // Stamped here, on change only: the helper resends the same position with every Nearby update.
      const moved = String(position) !== String(nearby.position) || ev['world'] !== nearby.world
      // A zone entered (login, teleport, another server): proof in the log that the stream is read.
      if (ev['world'] != null && ev['world'] !== nearby.world) {
        log(`zone: ${ev['world']}${position ? ` at ${position.map(Math.round).join(', ')}` : ''}`)
      }
      nearby = {
        world: ev['world'] as number | null,
        position,
        positionAt: position ? (moved ? Date.now() : nearby.positionAt) : null,
        monsters: ev['monsters'] as Nearby['monsters'],
        height: (ev['height'] as number | null | undefined) ?? null,
      }
      broadcast('tracker:nearby', nearby)
      break
    }
    case 'session':
      dumpWaiter?.((ev['sessions'] as SessionCounts | undefined) ?? null)
      break
    case 'error':
      stderrTail = [...stderrTail, `sidecar: ${ev['detail']}`].slice(-20)
      // A helper from before dumpSession existed: no counts to carry, and no reason to wait.
      if (String(ev['detail']).includes('dumpSession')) dumpWaiter?.(null)
      break
  }
}

function replacePets(list: Pet[]): void {
  pets.clear()
  for (const p of list) pets.set(p.id, p)
  broadcast('tracker:pets', [...pets.values()])
}

function updatePet(pet: Pet): void {
  pets.set(pet.id, pet)
  broadcast('tracker:pet', pet)
}

function command(cmd: Record<string, unknown>): void {
  if (child?.stdin.writable) child.stdin.write(JSON.stringify(cmd) + '\n')
}

export const tracker = {
  status: (): TrackerStatus => status,
  pets: (): Pet[] => [...pets.values()],
  nearby: (): Nearby => nearby,
  shop: (): ShopStock[] => currentShop(),
  kina: (): KinaSession => kina,
  pvp: (): PvpKill[] => pvpLog.all(),
  clearPvp: (): void => pvpLog.clear(),
  fieldBosses: (): FieldBosses => fieldBosses.all(),
  /** Start the session again: the souls (the helper answers with every pet) and the Kina. */
  resetSession(): void {
    log('session reset')
    command({ cmd: 'resetSession' })
    setKina({ ...NO_KINA, balance: kina.balance, gains: [] })
  },
  setSouls: (pet: number, souls: number): void => command({ cmd: 'set', pet, souls }),
  setName: (pet: number, name: string): void => command({ cmd: 'name', pet, name }),
  onSoul(fn: (toast: SoulToast) => void): () => void {
    soulListeners.add(fn)
    return () => soulListeners.delete(fn)
  },
  /** A tab of the Black Cloud Merchant was opened: its stock (with the other tabs'). */
  onShop(fn: (stock: ShopStock[]) => void): () => void {
    shopListeners.add(fn)
    return () => shopListeners.delete(fn)
  },
  onStatus(fn: (status: TrackerStatus) => void): () => void {
    statusListeners.add(fn)
    return () => statusListeners.delete(fn)
  },
  /** The sidecar process is up (capturing or not). */
  running: (): boolean => child !== null,
  /**
   * Capture or not. A running sidecar is told; one that is not running starts when capture is
   * wanted, and otherwise is left off.
   */
  setCapture(on: boolean): void {
    const changed = capturing !== on
    capturing = on
    if (changed) log(`capture ${on ? 'on' : 'off'}`)
    if (child) {
      if (changed) command({ cmd: 'capture', on })
    } else if (on) startTracker()
    else setStatus({ state: 'idle', detail: null, lastPacketAgo: null })
  },
  /** The session's soul counts, every character's, from the helper; null if it cannot say. */
  dumpSession(): Promise<SessionCounts | null> {
    if (!child?.stdin.writable) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), DUMP_TIMEOUT_MS)
      const finish = (sessions: SessionCounts | null): void => {
        clearTimeout(timer)
        dumpWaiter = null
        resolve(sessions)
      }
      dumpWaiter = finish
      command({ cmd: 'dumpSession' })
    })
  },
  /**
   * After an update restart: the session as it was. Kina and the merchant's stock now; the soul
   * counts (and where you were) once the helper is ready, which it may not be until the game runs.
   */
  restoreSession(saved: {
    kina: KinaSession | null
    shop: ShopStock[]
    sessions: SessionCounts | null
    world: number | null
    position: [number, number] | null
  }): void {
    // The next balance is a new starting point, as after entering the world: the old one may be stale.
    if (saved.kina) setKina(kinaRebase(saved.kina))
    for (const stock of saved.shop) shopTabs.set(stock.tab, stock)
    if (saved.shop.length) broadcast('tracker:shop', currentShop())
    if (saved.sessions && Object.keys(saved.sessions).length) restoring = { sessions: saved.sessions, world: saved.world, position: saved.position }
  },
  restart(): void {
    restarts = 0
    stopTracker()
    startTracker()
  },
  /** Restart the helper with the session's soul counts carried across (an addon reload). */
  async restartKeepingSession(): Promise<void> {
    const sessions = await this.dumpSession()
    if (sessions && Object.keys(sessions).length) restoring = { sessions, world: nearby.world, position: nearby.position }
    if (child) this.restart()
  },
  /** Settings → Debug logging switched: the helper restarted with it (or without), the session kept. */
  applyDebugLogging(): void {
    const on = settings.get('debugLogging')
    if (!child || on === debugArgs) return
    debugArgs = on
    log(`debug logging ${on ? 'on' : 'off'}: restarting the tracker`)
    void this.restartKeepingSession()
  },
  /** The addons' Python parts the next start loads. */
  setAddonArgs(args: string[]): void {
    addonArgs = args
  },
  /** An addon line from the helper (addon, addonLoaded, addonError). */
  onAddonLine(fn: (ev: Record<string, unknown>) => void): () => void {
    addonLineListeners.add(fn)
    return () => addonLineListeners.delete(fn)
  },
  /** To an addon's Python part (sidecar.py: addon, addonSettings). */
  addonCommand: (cmd: Record<string, unknown>): void => command(cmd),
}

/** Ask the sidecar to quit, and make sure it is gone. Safe to call from `process.on('exit')`. */
export function stopTracker(): void {
  stopping = true
  pvpLog.flush()
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  const proc = child
  child = null
  if (!proc) return
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n')
    proc.stdin.end()
  } catch {
    // already closed
  }
  // The capture thread may be blocked in Npcap; a quit it cannot act on promptly is a kill.
  setTimeout(() => proc.exitCode === null && killTree(proc), 1500).unref()
}

/**
 * A venv's python.exe is a launcher that runs the real interpreter as its own child, so killing
 * the process we started would leave the tracker running. taskkill /T takes the whole tree.
 */
function killTree(proc: ChildProcessWithoutNullStreams): void {
  if (proc.pid === undefined) return
  spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
}

/** For process exit, where timers never fire. */
export function killTrackerNow(): void {
  stopping = true
  pvpLog.flush()
  if (child && child.exitCode === null) killTree(child)
  child = null
}
