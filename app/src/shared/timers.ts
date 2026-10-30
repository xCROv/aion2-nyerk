/**
 * The game's periodic events, as timers: when each happens next, and when to alert for it.
 *
 * Schedules are kept in UTC. Sources (2026-10-12), and what is confirmed:
 * - Black Cloud Merchant: restocks every hour on the hour. Confirmed: its stock record (`91 56`)
 *   carries the next restock time, 15:00:00 UTC when captured at 14:47.
 * - Spacetime Rift: every 3 hours, 00:00, 03:00 ... 21:00 UTC. Confirmed by the in-game countdown
 *   ("starts in 14m 53s" at about 14:45 UTC); aion2hub.com lists the same hours for the global
 *   servers (server time UTC+9, a multiple of 3 hours away, so the hours are the same in UTC).
 * - Shugo Festival: every hour on the hour, its lobby open 3 minutes before (metabot.gg).
 * - Dimensional Invasion: every hour at half past, a 3-minute entry window (The Games Wiki).
 * - Artifact Siege: Monday, Thursday and Saturday at 21:00 server time, with a 10-minute warning
 *   (metabot.gg). Server time is the region's own: New York for NA East (daylight saving
 *   included), Los Angeles for NA West, Berlin for Europe.
 * Checked 2026-10-13 against a community event timer set to NA East: Shugo and the rift at 03:00
 * UTC, the invasion at 02:30, the siege on Thursday at 21:00 New York time (01:00 UTC Friday). The
 * player confirmed the siege at 20:00 Central (21:00 New York). The NA West and Europe zones are
 * metabot.gg's, not checked.
 *
 * Added 2026-10-13, from the same timer (next starts as it counted them) and guides:
 * - Siege Bosses: 30 minutes into each siege (Thursday 21:30 New York).
 * - Guardian Lord Nahma: Friday and Sunday at 21:00 server time (allthings.how, metabot.gg; the
 *   timer showed Friday 21:00 New York, and so did the game's map on 2026-10-23).
 * - Watcher Kaira: every 3 hours from 02:00 UTC, as the older guides say (not every 4 hours, as
 *   The Games Wiki has it since the 2026-09-02 patch): three readings of the map agree.
 * - Daily reset at 07:00 UTC, weekly reset on Wednesday at the same time, in every region (16:00
 *   UTC+9, no daylight saving). Confirmed 2026-10-29: the game's next-reset packet (`23 e2`) says
 *   07:00 UTC, and the times it sends for after 1 Nov (a monthly limit's reset, item expiries) are
 *   07:00 UTC too, not 08:00; a player in Europe reports 08:00 CET. Before then they were 03:00 in
 *   the region's time zone, five hours early in Europe and an hour late in NA East in winter.
 *
 * The region is the character's game server's by default (its id's second digit, REGIONS).
 */

import { GAME_SERVERS } from './gameServers.ts'

export type TimerId =
  | 'shugo'
  | 'merchant'
  | 'rift'
  | 'invasion'
  | 'kaira'
  | 'siege'
  | 'siegeBosses'
  | 'nahma'
  | 'dailyReset'
  | 'weeklyReset'
  | 'gartua'
  /** A field boss other than Gartua: `fb-<its id in the map's list>`. */
  | `fb-${number}`

export type Schedule =
  /** Every `every` minutes, at `offset` minutes past each period (periods counted from 00:00 UTC). */
  | { kind: 'every'; every: number; offset: number }
  /** On these weekdays (0 = Sunday), at these times (minutes after midnight), in the server
   *  region's time zone, or in UTC where `zone` says so. */
  | { kind: 'zoned'; days: number[]; times: number[]; zone?: 'UTC' }
  /** A field boss: when it respawns, from the map's field boss list (see FieldBossState). */
  | { kind: 'boss'; boss: number }

/** A field boss as the map's list last said: up since `at` (0: not given, since the 2026-10-14
 *  patch), or dead until `at` (ms). */
export interface FieldBossState {
  up: boolean
  at: number
  /** When the list said so. */
  seen: number
  /** Your own map, or other players' (the shared timers, confirmed by several of them). */
  source?: 'map' | 'shared'
}
/** By the list's own boss id (101021 = Eternal Gartua). */
export type FieldBosses = Record<number, FieldBossState>

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const hm = (h: number, m = 0): number => h * 60 + m

/** The global servers' regions, and the time zone each one's "server time" is. `digit` is the
 *  region's in a game server id (Kaisinel NA East 1104: 1). Latin America's and Asia's zones are
 *  guesses until a player there checks the siege. */
export type Region = 'na-east' | 'na-west' | 'europe' | 'latam' | 'asia'
export const REGIONS: { id: Region; label: string; zone: string; confirmed: boolean; digit: number }[] = [
  { id: 'na-east', label: 'NA East', zone: 'America/New_York', confirmed: true, digit: 1 },
  { id: 'na-west', label: 'NA West', zone: 'America/Los_Angeles', confirmed: false, digit: 2 },
  { id: 'europe', label: 'Europe', zone: 'Europe/Berlin', confirmed: false, digit: 3 },
  { id: 'latam', label: 'Latin America', zone: 'America/Sao_Paulo', confirmed: false, digit: 4 },
  { id: 'asia', label: 'Asia', zone: 'Asia/Singapore', confirmed: false, digit: 5 },
]
const zoneOf = (region: Region): string => REGIONS.find((r) => r.id === region)?.zone ?? 'America/New_York'

/** The Timers tab's region setting: one region, or the character's server's (the default). */
export type RegionSetting = Region | 'auto'

/** A game server's region, from its id's second digit (2311: Europe); null for one of no global region. */
export function regionOfServer(server: number | null): Region | null {
  if (server === null) return null
  return REGIONS.find((r) => r.digit === Math.floor(server / 100) % 10)?.id ?? null
}

/** "Kaisinel (NA East)": a game server by name (GAME_SERVERS) and region, or its id when not listed. */
export function serverLabel(server: number): string {
  const region = REGIONS.find((r) => r.id === regionOfServer(server))?.label
  const name = GAME_SERVERS[server] ?? `Server ${server}`
  return region ? `${name} (${region})` : name
}

/** The region the timers follow: the one chosen, or with 'auto' the character's server's (NA East
 *  until a character has logged in). */
export function resolveRegion(setting: RegionSetting, server: number | null): Region {
  return setting === 'auto' ? (regionOfServer(server) ?? 'na-east') : setting
}

export interface TimerDef {
  id: TimerId
  name: string
  /** What it is, in a few words. */
  detail: string
  schedule: Schedule
  /** Minutes before the start to alert by default (0 = at the start); the player can change it. */
  lead: number
  /** False until the times are checked against the game. */
  confirmed: boolean
  /** Whether its alert is on until the player says otherwise: none are (every alert is opt-in). */
  defaultOn: boolean
}

/**
 * Listed in the Timers tab (and so able to alert) until the player chooses otherwise: the events
 * and Gartua; the other field bosses are picked in "Choose timers".
 */
export const defaultShown = (def: TimerDef): boolean => def.schedule.kind !== 'boss' || def.id === 'gartua'

/**
 * The field bosses by their id in the map's list (`01 91`): Verteron's named 2026-10-13 from
 * fieldboss_list.pcap, the up ones by their position (each a questlog.gg marker) and the dead ones
 * by their times against the in-game list.
 */
export const FIELD_BOSSES: { boss: number; name: string }[] = [
  { boss: 101001, name: 'Neikel of the East' },
  { boss: 101002, name: 'Rotten Kutar' },
  { boss: 101003, name: 'Kernon of the West' },
  { boss: 101004, name: 'Kusan the Mad Gladiator' },
  { boss: 101005, name: 'Ritualist Garshim' },
  { boss: 101006, name: 'Bodyguard Teegant' },
  { boss: 101007, name: 'Blooming Korin' },
  { boss: 101008, name: 'Furious Saursus' },
  { boss: 101009, name: 'Bloodfang Pnyn' },
  { boss: 101010, name: 'Heretic Layla' },
  { boss: 101011, name: 'Black Tentacle Lawa' },
  { boss: 101012, name: 'Phantasm Kasia' },
  { boss: 101013, name: 'Centurion Demiros' },
  { boss: 101014, name: 'Divine Ansas' },
  { boss: 101015, name: 'Harvest Manager Moshav' },
  { boss: 101016, name: "Sentinel K'nash" },
  { boss: 101017, name: 'Scholar Aulla' },
  { boss: 101018, name: 'Forest Warrior Aullamu' },
  { boss: 101019, name: 'Chaser Taulo' },
  { boss: 101020, name: 'Researcher Setram' },
  { boss: 101021, name: 'Eternal Gartua' },
  { boss: 101022, name: 'Silent Dartan' },
  { boss: 101023, name: 'Soul Ruler Kashapa' },
  { boss: 101024, name: 'High Commander Lagta' },
  // Altgard (2026-10-17, fieldboss_altgard_list.pcap, on an Asmodian character): the list sends
  // all 24 even when the map shows fewer. The 13 up ones are named by position (each a questlog.gg
  // marker), and they follow questlog's monster ids in order, as Verteron's do; the 11 dead ones
  // are named by that order.
  { boss: 111001, name: 'Melted Danar' },
  { boss: 111002, name: 'Black Warrior Aed' },
  { boss: 111003, name: 'Faithful Rajit' },
  { boss: 111004, name: 'Berserker Vargor' },
  { boss: 111005, name: 'Predator Garsan' },
  { boss: 111006, name: 'Blood Warrior Lannar' },
  { boss: 111007, name: 'Deceiver Trid' },
  { boss: 111008, name: 'Blue Wave Kelpina' },
  { boss: 111009, name: 'High Overseer Nutah' },
  { boss: 111010, name: 'Advisor Resana' },
  { boss: 111011, name: 'Special Operations Leader Linx' },
  { boss: 111012, name: 'Desecrator Newbold' },
  { boss: 111013, name: 'Specter Archon Axios' },
  { boss: 111014, name: 'Addicted Hardirun' },
  { boss: 111015, name: 'Executioner Barthien' },
  { boss: 111016, name: 'Drakan Battalion Weapon Guruta' },
  { boss: 111017, name: 'Veteran Shujakan' },
  { boss: 111018, name: 'Visionary Karuka' },
  { boss: 111019, name: 'Dark Shadow Vishwada' },
  { boss: 111020, name: 'Sharp Shylak' },
  { boss: 111021, name: 'Immortal Gartua' },
  { boss: 111022, name: 'High Commander Lagta' },
  { boss: 111023, name: 'Soul Ruler Kashapa' },
  { boss: 111024, name: 'Silent Dartan' },
  // Chaotic Lower Reshanta (2026-10-13, fieldboss_abyss.pcap): its list names 8 bosses, but only
  // Argo respawns after a kill with a time given; the others (Kaira, Nahma, the Executors) come on
  // schedules, timed above, and the list gives them no time.
  { boss: 2001, name: 'Argo, the Spirit King' },
]

/** The zones with field boss timers, by the zone id their boss ids start with. */
export const FIELD_BOSS_ZONES: { world: number; name: string }[] = [
  { world: 1010, name: 'Verteron' },
  { world: 1110, name: 'Altgard' },
  { world: 20, name: 'Lower Reshanta' },
]
export const bossZone = (boss: number): number => Math.floor(boss / 100)

export const TIMERS: TimerDef[] = [
  {
    id: 'shugo',
    name: 'Shugo Festival',
    detail: 'Minigames in Verteron and Altgard; the lobby opens 3 minutes before',
    schedule: { kind: 'every', every: 60, offset: 0 },
    lead: 3,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'merchant',
    name: 'Black Cloud Merchant',
    detail: 'New stock, every hour',
    schedule: { kind: 'every', every: 60, offset: 0 },
    lead: 0,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'rift',
    name: 'Spacetime Rift',
    detail: 'Rifts to the other side open (level 45+)',
    schedule: { kind: 'every', every: 180, offset: 0 },
    lead: 5,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'invasion',
    name: 'Dimensional Invasion',
    detail: 'A 3-minute entry window',
    schedule: { kind: 'every', every: 60, offset: 30 },
    lead: 3,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'kaira',
    name: 'Watcher Kaira',
    detail: 'Abyss boss in Lower Reshanta, at a random spot',
    // Every 3 hours from 02:00 UTC (02:00, 05:00 … 23:00). The map's countdowns: 05:00 UTC
    // (2026-10-14 03:38, fieldboss_abyss.pcap), 23:00 UTC (2026-10-23), 02:00 UTC (2026-10-30,
    // 30 minutes after the Executors). Whether it follows New York's daylight saving is not known.
    schedule: { kind: 'every', every: 180, offset: 120 },
    lead: 10,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'siege',
    name: 'Artifact Siege',
    detail: 'Elyos and Asmodians fight over the artifacts in Lower Reshanta',
    schedule: { kind: 'zoned', days: [1, 4, 6], times: [hm(21)] },
    lead: 10,
    // Confirmed by the player (2026-10-17).
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'siegeBosses',
    name: 'Executors (siege bosses)',
    detail: 'Executor Tamasa, Argo and Kaira in Lower Reshanta, shortly after the siege',
    // 30 minutes after the siege: the map counted down to Thursday 21:30 New York (2026-10-14
    // capture) and Saturday 21:30 New York (2026-10-23). Monday is assumed.
    schedule: { kind: 'zoned', days: [1, 4, 6], times: [hm(21, 30)] },
    lead: 5,
    confirmed: false,
    defaultOn: false,
  },
  {
    id: 'nahma',
    name: 'Guardian Lord Nahma',
    detail: 'Abyss field boss in Lower Reshanta (three of them)',
    // 21:00 server time: the map counted down to Friday 21:00 New York for all three (2026-10-14
    // capture, 2026-10-23, 2026-10-29).
    schedule: { kind: 'zoned', days: [0, 5], times: [hm(21)] },
    lead: 10,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'gartua',
    name: 'Eternal Gartua',
    detail: 'Verteron field boss on Eternal Isle, 12 h after it dies: open the map to update',
    schedule: { kind: 'boss', boss: 101021 },
    lead: 10,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'dailyReset',
    name: 'Daily Reset',
    detail: 'Daily quests and limits reset',
    schedule: { kind: 'zoned', days: EVERY_DAY, times: [hm(7)], zone: 'UTC' },
    lead: 0,
    confirmed: true,
    defaultOn: false,
  },
  {
    id: 'weeklyReset',
    name: 'Weekly Reset',
    detail: 'Weekly quests and limits reset (Wednesday)',
    schedule: { kind: 'zoned', days: [3], times: [hm(7)], zone: 'UTC' },
    lead: 0,
    confirmed: true,
    defaultOn: false,
  },
]
// Gartua above (its own id, kept from before); the others after the events.
for (const b of FIELD_BOSSES) {
  if (b.boss === 101021) continue
  TIMERS.push({
    id: `fb-${b.boss}`,
    name: b.name,
    detail: `${FIELD_BOSS_ZONES.find((z) => z.world === bossZone(b.boss))?.name ?? 'Field'} field boss: open the map to update`,
    schedule: { kind: 'boss', boss: b.boss },
    lead: 5,
    confirmed: true,
    defaultOn: false,
  })
}


const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** How far `zone`'s wall clock is ahead of UTC at instant `t` (ms; daylight saving included). */
function zoneOffset(zone: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(t)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return wall - Math.floor(t / 1000) * 1000
}

/**
 * Starts the game itself gave, by timer (ms; from its packets: the next daily reset at login, the
 * weekly one with the weekly limits, the next siege on entering the Abyss). Kept per game server.
 */
export type GameTimes = Partial<Record<TimerId, number>>

/** How far a start the game gave may sit from the schedule's own and still move it. */
const MAX_SHIFT = 6 * 60 * MINUTE

/**
 * The first start at or after `from` (ms since epoch). Zoned ones in `region`'s time zone. With
 * `game`, a start the game gave for this timer, the schedule is moved onto it: by however far its
 * own start nearest it is (the region's time zone wrong, or the game's times changed), for every
 * start after it too. One more than MAX_SHIFT away is not this schedule's, and is ignored.
 */
export function nextStart(s: Schedule, from: number, region: Region = 'na-east', bosses: FieldBosses = {}, game?: number): number {
  if (game !== undefined && s.kind !== 'boss') {
    // The schedule's own start nearest the game's: the first after it, or one before it in reach.
    const before = scheduled(s, game - MAX_SHIFT, region)
    const after = scheduled(s, game, region)
    const shift = game - (game - before < after - game ? before : after)
    if (Math.abs(shift) <= MAX_SHIFT) return scheduled(s, from - shift, region) + shift
  }
  return scheduled(s, from, region, bosses)
}

function scheduled(s: Schedule, from: number, region: Region, bosses: FieldBosses = {}): number {
  if (s.kind === 'boss') {
    // Its respawn, if the map said it is dead; up, or never seen, there is no next start to give.
    const b = bosses[s.boss]
    return b && !b.up && b.at >= from ? b.at : Number.POSITIVE_INFINITY
  }
  if (s.kind === 'every') {
    const period = s.every * MINUTE
    return Math.ceil((from - s.offset * MINUTE) / period) * period + s.offset * MINUTE
  }
  // Zoned: the next 8 days of the zone's calendar, each start at its own UTC offset.
  const zone = s.zone ?? zoneOf(region)
  const today = from + zoneOffset(zone, from)
  const midnight = Math.floor(today / DAY) * DAY
  const times = [...s.times].sort((a, b) => a - b)
  for (let d = 0; d <= 7; d++) {
    const day = midnight + d * DAY
    if (!s.days.includes(new Date(day).getUTCDay())) continue
    for (const t of times) {
      const wall = day + t * MINUTE
      // The offset that applies at the start itself (it can differ from today's across a change).
      const start = wall - zoneOffset(zone, wall - zoneOffset(zone, wall))
      if (start >= from) return start
    }
  }
  return Number.POSITIVE_INFINITY
}

/**
 * What addons hear of the timers (the `timers` event, 'events:timers'): the next resets, and each
 * timer's next start. Worked out here only, so an addon never keeps schedules of its own. The resets
 * are there even while the Timers addon is switched off (`on`); the starts are not.
 */
export interface TimersState {
  /** The region the times follow (the setting's, or the character's server's with Automatic). */
  region: Region
  /** The character's game server (Kaisinel 1104), null until one has logged in. */
  server: number | null
  /** The Timers addon is switched on. */
  on: boolean
  dailyReset: number
  weeklyReset: number
  /** Every timer's next start (ms), null when not known (a field boss nobody has seen die). */
  next: { id: TimerId; name: string; at: number | null }[]
  /** The starts the game gave on this server, which the schedules above follow (nextStart's `game`). */
  game: GameTimes
}

export function timersState(
  now: number,
  region: Region,
  on: boolean,
  bosses: FieldBosses = {},
  server: number | null = null,
  game: GameTimes = {},
): TimersState {
  const start = (id: TimerId): number => nextStart(TIMERS.find((t) => t.id === id)!.schedule, now, region, {}, game[id])
  const at = (t: TimerDef): number | null => {
    const n = nextStart(t.schedule, now, region, bosses, game[t.id])
    return Number.isFinite(n) ? n : null
  }
  return {
    region,
    server,
    on,
    dailyReset: start('dailyReset'),
    weeklyReset: start('weeklyReset'),
    next: on ? TIMERS.map((t) => ({ id: t.id, name: t.name, at: at(t) })) : [],
    game,
  }
}

/** The alert leads the player can pick, in minutes. */
export const LEAD_CHOICES = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60]

/**
 * The leads that make sense for a timer: shorter than the gap between its starts, so an alert never
 * begins before the previous start's is over (an hourly event cannot alert an hour early).
 */
export function leadChoices(def: TimerDef): number[] {
  const s = def.schedule
  const gap =
    s.kind === 'boss'
      ? Number.POSITIVE_INFINITY
      : s.kind === 'every'
      ? s.every
      : s.days.length === 7 && s.times.length > 1
        ? Math.min(...s.times.slice(1).map((t, i) => t - s.times[i]!))
        : Number.POSITIVE_INFINITY
  return LEAD_CHOICES.filter((m) => m < gap)
}

/** How long an alert stays up after the start, unless dismissed. */
export const ALERT_AFTER_MS = 2 * MINUTE

/**
 * The start an alert is up for at `now`, or null: from `lead` minutes before a start (the timer's
 * default unless given) until ALERT_AFTER_MS after it.
 */
export function alertingStart(
  def: TimerDef,
  now: number,
  region: Region = 'na-east',
  lead = def.lead,
  bosses: FieldBosses = {},
  game: GameTimes = {},
): number | null {
  const next = nextStart(def.schedule, now - ALERT_AFTER_MS, region, bosses, game[def.id])
  return now >= next - lead * MINUTE && now < next + ALERT_AFTER_MS ? next : null
}

/** A timer alerting now: which, and for the start at `at`. */
export interface TimerAlert {
  id: TimerId
  at: number
}

/** The alert sounds a timer can play (made in the renderer, lib/chime.ts). */
export const ALARM_SOUNDS = [
  { id: 'chime', label: 'Chime' },
  { id: 'bell', label: 'Bell' },
  { id: 'beeps', label: 'Beeps' },
  { id: 'fanfare', label: 'Fanfare' },
  { id: 'marimba', label: 'Marimba' },
] as const
export type AlarmSound = (typeof ALARM_SOUNDS)[number]['id']
export const DEFAULT_SOUND: AlarmSound = 'chime'
export const isAlarmSound = (v: unknown): v is AlarmSound => ALARM_SOUNDS.some((s) => s.id === v)
