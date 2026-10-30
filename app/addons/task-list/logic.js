// Task List, the arithmetic: limits, what a reset clears, and what a stock holds by now. No page, no
// storage: the tab passes in what it has, and app/tests/taskList.test.ts loads this file in node.
//
// What is stored, by task id, under a character's or a server's key:
//   count: { used, until }   `used` stands until the reset at `until` (the one after it was set)
//   check: { done, until }
//   bank:  { value, at }     what the player had at `at`; the refills since are added on reading
;(function (root) {
  'use strict'

  const DAY = 86_400_000
  const HOUR = 3_600_000

  /** The task's limit now: membership raises some, and some change on a date. Null: unknown. */
  function capOf(task, member, now) {
    const cap = task.cap
    if (cap === undefined || cap === null) return null
    if (typeof cap === 'number') return cap
    if (Array.isArray(cap)) return (cap.find((c) => c.until === undefined || now < c.until) ?? cap[cap.length - 1]).value
    return member && cap.member !== undefined ? cap.member : cap.base
  }

  /** The reset that clears it: daily tasks the daily one, the rest (weekly, events) the weekly one. */
  const resetOf = (task, timers) => (task.tab === 'daily' ? timers.dailyReset : timers.weeklyReset)

  /** What a count or check holds now: nothing once its reset has passed. */
  const current = (entry, now) => (entry && typeof entry.until === 'number' && entry.until > now ? entry : null)
  const usedOf = (entry, now) => current(entry, now)?.used ?? 0
  const doneOf = (entry, now) => current(entry, now)?.done === true

  /** A count's new entry: `used`, clamped to its limit, standing until the next reset. */
  const setUsed = (task, used, member, now, timers) => {
    const cap = capOf(task, member, now)
    return { used: Math.max(0, Math.min(cap ?? Infinity, Math.round(used))), until: resetOf(task, timers) }
  }
  const setDone = (task, done, timers) => ({ done: done === true, until: resetOf(task, timers) })

  /** Daily resets passed after `from`, up to `now`, given the next one (`next`, after now). */
  function resetsBetween(from, now, next) {
    const last = next - DAY // the latest reset at or before now
    if (last <= from || last > now) return 0
    return Math.floor((last - from) / DAY) + 1
  }

  /**
   * A stock now: the value entered plus the refills since (capped), and when it is full (null when
   * it is, or nothing is known). `estimated`: refills were added.
   */
  function bankNow(task, entry, member, now, dailyReset) {
    const cap = capOf(task, member, now)
    const r = task.refill
    if (!entry || typeof entry.value !== 'number') return { value: null, cap, fullAt: null, estimated: false }
    if (!r || cap === null) return { value: entry.value, cap, fullAt: null, estimated: false }
    let gained = 0
    if (r.every === 'day') gained = resetsBetween(entry.at, now, dailyReset) * r.amount
    else if (r.hours) gained = Math.floor((now - entry.at) / (r.hours * HOUR)) * r.amount
    const value = Math.min(cap, entry.value + gained)
    if (value >= cap) return { value, cap, fullAt: null, estimated: gained > 0 }
    const steps = Math.ceil((cap - value) / r.amount)
    let fullAt
    if (r.every === 'day') fullAt = dailyReset + (steps - 1) * DAY
    else {
      const every = r.hours * HOUR
      fullAt = now + (steps - 1) * every + (every - ((now - entry.at) % every))
    }
    return { value, cap, fullAt, estimated: gained > 0 }
  }

  /** A stock's new entry: what the player has now. */
  const setValue = (task, value, member, now) => {
    const cap = capOf(task, member, now)
    return { value: Math.max(0, Math.min(cap ?? Infinity, Math.round(value))), at: now }
  }

  /** Whether a task is shown: its event not over, member-only ones for members, optional ones when asked. */
  const shown = (task, { member, optional, now }) =>
    !(task.ends !== undefined && now >= task.ends) && !(task.member && !member) && !(task.optional && !optional)

  /** Where its progress is kept: the character's, or the server's for limits shared by its characters. */
  const scopeKey = (task, char) => (task.scope === 'server' ? `server:${char.server}` : `char:${char.server}:${char.name}`)

  /** Whether a task needs nothing more this reset (a stock: never; it only warns when full). */
  function isDone(task, entry, member, now) {
    if (task.kind === 'check') return doneOf(entry, now)
    if (task.kind === 'count') {
      const cap = capOf(task, member, now)
      return cap !== null && usedOf(entry, now) >= cap
    }
    return false
  }

  /** The reset before the next one: what was read before it no longer holds for a count. */
  const lastReset = (task, timers) => resetOf(task, timers) - (task.tab === 'daily' ? DAY : 7 * DAY)

  /**
   * What the game said about a task (`task.game`, from detect.py), as the entry the tab keeps
   * (a count's { used, until }, a stock's { value, at }) and what goes beside it: the recharge
   * pool, and when it was read. `g` is the character's game data (for a task its server shares,
   * the server's latest). Null when there is nothing usable: no ticket yet, or a count read before
   * its last reset (it has refilled since). A stock read before then still holds: its refills are
   * added on reading, as for one entered by hand.
   */
  function fromGame(task, g, member, now, timers, missions = []) {
    const src = task.game
    if (!src || !g || !timers) return null
    if (src.ticket !== undefined) {
      const t = g.tickets && g.tickets[String(src.ticket)]
      const at = t && (t.at ?? g.ticketsAt)
      if (!t || !t.n || typeof at !== 'number') return null
      const recharge = t.n.length > 1 ? t.n[1] : null
      if (task.kind === 'bank') return { entry: { value: t.n[0], at }, recharge, at }
      if (at <= lastReset(task, timers)) return null
      const cap = capOf(task, member, now)
      return { entry: { used: Math.max(0, cap - t.n[0]), until: resetOf(task, timers) }, recharge, at }
    }
    if (src.hours !== undefined) {
      const t = g.tickets && g.tickets[String(src.hours)]
      const at = t && (t.at ?? g.ticketsAt)
      if (!t || !t.ms || typeof at !== 'number' || at <= lastReset(task, timers)) return null
      return { left: t.ms[0], added: t.ms[1] || 0, at }
    }
    if (src.duties) {
      // The duty board: the day's duties taken and not given up (2 taken, 3 ready, 4 turned in).
      const d = g.duties
      if (!d || typeof g.dutiesAt !== 'number' || g.dutiesAt <= lastReset(task, timers)) return null
      const taken = Object.values(d.quests || {}).filter((s) => s >= 2 && s <= 4).length
      const refreshes = Math.max(0, 10 - (d.refreshes || 0))
      return { entry: { used: taken, until: resetOf(task, timers) }, recharge: null, at: g.dutiesAt, note: `${d.done} turned in · ${refreshes} refreshes left` }
    }
    if (src.shop !== undefined) {
      // What was bought this week at the shop, read when it was last opened or used.
      const shop = g.shops && g.shops[String(src.shop)]
      if (!shop || typeof shop.at !== 'number' || shop.at <= lastReset(task, timers)) return null
      const bought = Object.entries(shop).filter(([k]) => k !== 'at').reduce((sum, [, n]) => sum + n, 0)
      return { entry: { used: bought, until: resetOf(task, timers) }, recharge: null, at: shop.at, note: 'as the shop said' }
    }
    if (src.season) {
      if (!g.missions || typeof g.missionsAt !== 'number' || g.missionsAt <= lastReset(task, timers)) return null
      const done = missions.filter((m) => (g.missions[String(m.id)] || [0])[0] >= m.goals[m.goals.length - 1]).length
      return { entry: { used: done, until: resetOf(task, timers) }, recharge: null, at: g.missionsAt }
    }
    return null
  }

  /**
   * A character's tickets: those kept (`kept`: { tickets, ticketsAt }) with what detect.py read
   * this run (`read`, the same). A newer whole list replaces the kept one; a ticket read on its own
   * since (a change, with its own `at`: Nyerk started mid-session, no list yet) takes its place.
   */
  function mergeTickets(kept, read) {
    const whole = typeof read.ticketsAt === 'number' && read.ticketsAt >= (kept.ticketsAt ?? 0)
    let tickets = whole ? read.tickets : kept.tickets
    const ticketsAt = whole ? read.ticketsAt : kept.ticketsAt
    for (const [id, t] of Object.entries(read.tickets ?? {})) {
      if (typeof t.at === 'number' && t.at > (tickets?.[id]?.at ?? ticketsAt ?? 0)) tickets = { ...tickets, [id]: t }
    }
    return { tickets, ticketsAt }
  }

  /** A Season Mission's progress: its count, the next goal, the steps done of all, and whether finished. */
  function missionProgress(mission, value) {
    const v = value || 0
    const steps = mission.goals.filter((goal) => v >= goal).length
    const next = mission.goals.find((goal) => v < goal) ?? mission.goals[mission.goals.length - 1]
    return { value: v, next, steps, of: mission.goals.length, done: steps === mission.goals.length }
  }

  /**
   * A PvP mode's matches and wins this week: its season record (wins, losses) now, less the record
   * the week started from.
   */
  const pvpWeek = (record, base) => ({
    matches: Math.max(0, record.wins + record.losses - base.wins - base.losses),
    wins: Math.max(0, record.wins - base.wins),
  })

  /**
   * The record a week starts from (`kept`: { week, base, last, lastAt } from before): the last one
   * read before the week began, so matches between that read and the reset are not lost to the
   * week; failing that (none read last week), the first one read this week.
   */
  function pvpBase(kept, record, readAt, weekStart) {
    if (kept && kept.week === weekStart && kept.base) return { ...kept, last: record, lastAt: readAt }
    const base = kept && kept.last && kept.lastAt < weekStart ? kept.last : record
    return { week: weekStart, base, since: base === record ? readAt : weekStart, last: record, lastAt: readAt }
  }

  /** The membership's benefits (`3b e3`, docs/FINDINGS.md): all bought together, 30 days each. */
  const MEMBERSHIP = ['1058', '1059', '1061', '1062', '1063', '1064', '1065', '1066']

  /**
   * When the membership the game listed ends (`benefits`: { id: [start, end] }): 0 when none was
   * listed, null when nothing was read (the toggle then decides).
   */
  function membershipEnd(benefits) {
    if (!benefits) return null
    return Math.max(0, ...MEMBERSHIP.map((id) => benefits[id]?.[1] ?? 0))
  }

  /**
   * Membership on a server: as the game says (`end` from membershipEnd), unless the player set it
   * by hand. A hand setting (`{ on, game }`, `game` what the game said then; `true` from before
   * the game was read) holds until what the game says changes: a purchase, or the end passing.
   * `auto`: what the game says (null when not read).
   */
  function memberOf(set, end, now) {
    const auto = end === null ? null : end > now
    const hand = set === true ? { on: true, game: null } : set
    const held = hand && hand.game === auto
    return { member: held ? hand.on : auto === true, auto, overridden: Boolean(held && auto !== null) }
  }

  /** "2d 4h", "3h 12m", "8m". */
  function duration(ms) {
    const m = Math.max(0, Math.round(ms / 60_000))
    const d = Math.floor(m / 1440)
    const h = Math.floor((m % 1440) / 60)
    if (d) return `${d}d ${h}h`
    if (h) return `${h}h ${m % 60}m`
    return `${m}m`
  }

  const api = {
    DAY, capOf, resetOf, usedOf, doneOf, setUsed, setDone, resetsBetween, bankNow, setValue, shown, scopeKey, isDone, duration,
    lastReset, fromGame, mergeTickets, missionProgress, pvpWeek, pvpBase, membershipEnd, memberOf,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.taskLogic = api
})(this)
