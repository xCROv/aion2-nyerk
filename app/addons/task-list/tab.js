// Task List, the tab: a switcher of every character seen, and for the one picked its Daily, Weekly
// and Event lists (tasks.js), ticked off by hand; a done task folds to its name, at the bottom of
// its group. Counts and checks clear at the reset that applies to them,
// stocks keep and add their refills (logic.js). The reset times and the next festival or invasion
// come from the Timers addon (the `timers` event), never worked out here. Limits a server's
// characters share are kept once, under the server.
//
// What the game says (detect.py's "game" event: each character's content tickets, Season Missions
// and PvP records) takes over a task that has a `game` source: its count is read, not typed, and
// shows its recharge pool. The Season tab lists the Season Missions (season.js) with their counts.
//
// Each row's eye hides its task: it leaves its section for a folded Hidden one at the bottom of its
// tab, out of the tab's count, until its eye brings it back (kept for every character).
'use strict'

const { TASKS, FOLDED_GROUPS } = window.tasks
const { MISSIONS, THEMES } = window.season
const L = window.taskLogic

const TAB_NAMES = { daily: 'Daily', weekly: 'Weekly', event: 'Event', season: 'Season' }
const WEEK = 7 * L.DAY
const TICK_MS = 30_000

/** What is kept (nyerk.storage): the characters seen, membership by server, progress by scope, the view. */
let chars = {}
let members = {}
let progress = {}
let view = { char: null, tab: 'daily', open: {} }
let timers = null
let here = null // the character logged in now: { name, server }
/** What the game said, by character key (`server:name`): tickets, missions, PvP records, when read. */
let game = {}
/** Each character's PvP week: the season records it started from (logic.js pvpBase), by mode. */
let pvp = {}
/** Tasks hidden by their eye, by id: kept in a folded Hidden section at the bottom of their tab. */
let hidden = {}

const HIDDEN = 'Hidden'
/** The Hidden section open: only while this page is up (it always starts collapsed). */
let hiddenOpen = false
const EYE = ['M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z', 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z']
const EYE_OFF = ['M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.6 2.2', 'M4.1 4.9C2.4 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.3 0 2.4-.4 3.3-1', 'M2 2l12 12']
let charMenu = false // the character switcher's menu is open

const $ = (id) => document.getElementById(id)

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : String(v))
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false))
  return e
}

const charKey = (c) => `${c.server}:${c.name}`
const serverName = (server) => nyerk.serverName(server)
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const picked = () => chars[view.char] ?? null

/**
 * When the membership on a character's server ends, as the game last listed it (the server's latest
 * read, any of its characters): 0 for none, null when not read yet.
 */
function memberEnd(c) {
  let best = null
  for (const g of Object.values(game)) {
    if (c && g.server === c.server && g.benefits && (!best || g.benefitsAt > best.benefitsAt)) best = g
  }
  return best ? L.membershipEnd(best.benefits) : null
}

/** Membership on the character's server (logic.js memberOf): as the game says, unless set by hand. */
const memberNow = (c) => L.memberOf(members[c.server], memberEnd(c), Date.now())
const isMember = (c) => Boolean(c && memberNow(c).member)

function save(key, value) {
  nyerk.storage.set(key, value).catch(() => undefined)
}

// ---- progress ---------------------------------------------------------------------------------

function entryOf(task, c) {
  return progress[L.scopeKey(task, c)]?.[task.id]
}

/** A task's entry now: what the game says when it says anything, else what was entered by hand. */
const entryNow = (task, c, member, now) => detected(task, c, member, now)?.entry ?? entryOf(task, c)

/** When a character's game data for a task was read: the part the task takes its count from. */
const readAt = (task, g) =>
  task.game?.duties ? g.dutiesAt : task.game?.shop !== undefined ? g.shops?.[String(task.game.shop)]?.at : task.game?.season ? g.missionsAt : g.tickets?.[String(task.game?.ticket ?? task.game?.hours)]?.at ?? g.ticketsAt

/** The game's data for a task: the character's, or for a limit its server shares, the server's latest read. */
function gameFor(task, c) {
  if (task.scope !== 'server') return game[charKey(c)]
  let best = null
  for (const g of Object.values(game)) {
    if (g.server === c.server && (!best || (readAt(task, g) ?? 0) > (readAt(task, best) ?? 0))) best = g
  }
  return best
}

/**
 * What the game says about a task now, if anything: { entry, recharge, at } as logic.js fromGame
 * gives it, a PvP count from the week's records, or { left, added, at } for hours.
 */
function detected(task, c, member, now) {
  if (!task.game || !c) return null
  if (task.game.pvp !== undefined) {
    const week = pvp[charKey(c)]?.[task.game.pvp]
    const g = game[charKey(c)]
    if (!week || !timers || week.week !== timers.weeklyReset - WEEK) return null
    const n = L.pvpWeek(week.last, week.base)[task.game.count]
    return { entry: { used: Math.min(L.capOf(task, member, now), n), until: timers.weeklyReset }, recharge: null, at: g?.pvpAt ?? week.lastAt, since: week.since }
  }
  return L.fromGame(task, gameFor(task, c), member, now, timers, MISSIONS)
}

/**
 * Store a task's new progress and redraw, animated: a task that becomes done first folds to its name
 * where it is, then every row of its tab glides from where it was to where it now goes (the done
 * one to the bottom of its group, the rest up into its place).
 */
async function setEntry(task, c, entry) {
  if (busy.has(task.id)) return
  busy.add(task.id)
  try {
    const key = L.scopeKey(task, c)
    const member = isMember(c)
    const now = Date.now()
    const wasDone = L.isDone(task, entryOf(task, c), member, now)
    const nowDone = L.isDone(task, entry, member, now)
    const row = rowOf(task.id)
    if (row && !wasDone && nowDone) await fold(row)
    const before = positions()
    progress = { ...progress, [key]: { ...progress[key], [task.id]: entry } }
    save('progress', progress)
    render()
    if (wasDone !== nowDone) glide(before)
  } finally {
    busy.delete(task.id)
  }
}

// ---- animation --------------------------------------------------------------------------------

const FOLD_MS = 280
const GLIDE_MS = 520
const EASE = 'cubic-bezier(.2, .7, .2, 1)'
/** Tasks mid-animation: a second click on one waits for the first to finish. */
const busy = new Set()
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const rowOf = (id) => $('groups').querySelector(`li[data-id="${CSS.escape(id)}"]`)

/** Where each task's row is now, by id. */
function positions() {
  const at = new Map()
  for (const li of $('groups').querySelectorAll('li[data-id]')) {
    const r = li.getBoundingClientRect()
    at.set(li.dataset.id, { top: r.top, height: r.height })
  }
  return at
}

/** Fold a row down to its name, in place: its other lines fade, and it shrinks. */
function fold(li) {
  if (calm()) return Promise.resolve()
  const name = li.querySelector('.name')
  const from = li.getBoundingClientRect().height
  const to = (name?.getBoundingClientRect().height ?? 20) + 12 // the done row's padding: 6 + 6
  const extras = li.querySelectorAll('.detail, .tip, .meta, .amount')
  for (const x of extras) x.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FOLD_MS * 0.7, easing: 'ease-out', fill: 'forwards' })
  return li.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: FOLD_MS, easing: EASE, fill: 'forwards' }).finished.catch(() => undefined)
}

/** Every row that moved or changed height goes from how it was to how it is now. */
function glide(before) {
  if (calm()) return
  for (const li of $('groups').querySelectorAll('li[data-id]')) {
    const was = before.get(li.dataset.id)
    if (!was) continue
    const r = li.getBoundingClientRect()
    const dy = was.top - r.top
    if (Math.abs(dy) < 1 && Math.abs(was.height - r.height) < 1) continue
    // The row going furthest passes over the others.
    li.style.zIndex = String(Math.round(Math.abs(dy)))
    li.animate(
      [
        { transform: `translateY(${dy}px)`, height: `${was.height}px` },
        { transform: 'none', height: `${r.height}px` },
      ],
      { duration: GLIDE_MS, easing: EASE },
    ).finished.then(
      () => (li.style.zIndex = ''),
      () => undefined,
    )
  }
}

// ---- rendering --------------------------------------------------------------------------------

function render() {
  renderChars()
  const c = picked()
  const now = Date.now()
  const member = isMember(c)
  const optional = nyerk.settings.optional !== false

  const visible = (tab) => TASKS.filter((t) => t.tab === tab && L.shown(t, { member, optional, now }))
  const hasEvent = visible('event').length > 0
  if (view.tab === 'event' && !hasEvent) view.tab = 'daily'

  $('tabs').replaceChildren(
    ...Object.keys(TAB_NAMES)
      .filter((tab) => tab !== 'event' || hasEvent)
      .map((tab) => {
        let count = null
        if (c && timers && tab === 'season') {
          const missions = seasonNow(c)
          if (missions) count = `${MISSIONS.filter((m) => L.missionProgress(m, missions[String(m.id)]?.[0]).done).length}/${MISSIONS.length}`
        } else if (c && timers) {
          const list = visible(tab).filter((t) => t.kind !== 'bank' && t.group !== 'Shop limits' && !hidden[t.id])
          count = `${list.filter((t) => L.isDone(t, entryNow(t, c, member, now), member, now)).length}/${list.length}`
        }
        return el(
          'button',
          { type: 'button', role: 'tab', class: `n-pill${view.tab === tab ? ' on' : ''}`, 'aria-selected': String(view.tab === tab), onclick: () => pick({ tab }) },
          TAB_NAMES[tab],
          count ? el('b', {}, count) : null,
        )
      }),
  )

  const memberButton = $('member')
  memberButton.hidden = !c
  memberButton.classList.toggle('on', member)
  memberButton.setAttribute('aria-pressed', String(member))
  memberButton.textContent = member ? 'Sub' : 'Sub?'
  if (c) {
    const { auto, overridden } = memberNow(c)
    const end = memberEnd(c)
    const until = end ? ` until ${new Date(end).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''
    const source =
      auto === null ? '' : overridden ? ` (set by hand; the game says ${auto ? 'on' : 'off'})` : ` (from the game${auto ? until : ''})`
    memberButton.title =
      `The monthly membership (Special Quai) on ${serverName(c.server)}: ${member ? 'on' : 'off'}${source}. ` +
      'It covers every character on that server: higher caps, and the member-only rows.'
  }

  renderReset(now)

  const waiting = !c ? 'Log in to a character and its tasks show here.' : !timers ? 'Waiting for the reset times…' : null
  $('waiting').hidden = !waiting
  $('waiting').textContent = waiting ?? ''
  if (waiting) {
    $('groups').replaceChildren()
    return
  }

  if (view.tab === 'season') {
    $('groups').replaceChildren(...seasonEl(c))
    return
  }

  const groups = new Map()
  const tucked = []
  for (const t of visible(view.tab)) {
    if (hidden[t.id]) {
      tucked.push(t)
      continue
    }
    if (!groups.has(t.group)) groups.set(t.group, [])
    groups.get(t.group).push(t)
  }
  if (tucked.length) groups.set(HIDDEN, tucked)
  $('groups').replaceChildren(...[...groups].map(([name, tasks]) => groupEl(name, tasks, c, member, now)))
}

/** This week's Season Mission counts for a character, by id; null until the game has sent them this week. */
function seasonNow(c) {
  const g = game[charKey(c)]
  if (!g?.missions || !timers || (g.missionsAt ?? 0) <= timers.weeklyReset - WEEK) return null
  return g.missions
}

/** The Season tab: each theme's missions, its count against the next goal, the steps done of all. */
function seasonEl(c) {
  const missions = seasonNow(c)
  if (!missions) {
    return [el('p', { class: 'n-card empty n-hint' }, 'The Season Missions show once the game has sent them this week: log in, or change zone.')]
  }
  const g = game[charKey(c)]
  return THEMES.map((theme) => {
    // What is left first, the finished ones after it, as in the other tabs.
    const finished = (m) => L.missionProgress(m, missions[String(m.id)]?.[0]).done
    const ordered = MISSIONS.filter((m) => m.theme === theme).sort((a, b) => Number(finished(a)) - Number(finished(b)))
    const rows = ordered.map((m) => {
      const p = L.missionProgress(m, missions[String(m.id)]?.[0])
      return el(
        'li',
        { class: p.done ? 'done' : '' },
        el('span', { class: `tick${p.done ? ' on' : ''}`, 'aria-hidden': 'true' }),
        el(
          'div',
          { class: 'text' },
          el('span', { class: 'name' }, m.name),
          p.done ? null : el('span', { class: 'detail' }, m.what),
          p.done || m.goals.length < 2 ? null : el('div', { class: 'meta' }, el('span', {}, `step ${p.steps + 1} of ${p.of}`)),
        ),
        p.done ? null : el('span', { class: 'amount count' }, `${p.value} / ${p.next}`),
      )
    })
    const done = MISSIONS.filter((m) => m.theme === theme && L.missionProgress(m, missions[String(m.id)]?.[0]).done).length
    return el('section', { class: 'group' }, el('h3', { class: 'n-heading' }, `${theme} · ${done}/${rows.length}`), el('ul', { class: 'n-card list' }, ...rows))
  }).concat(el('p', { class: 'note n-muted' }, `From the game, ${ago(g.missionsAt)}. Counted by the game; they start over at the weekly reset.`))
}

/** "just now", "5 min ago", "3 h ago". */
function ago(at) {
  const m = Math.round((Date.now() - at) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** The switcher: the picked character, and on a click a menu of every one seen, the latest first. */
function renderChars() {
  const list = Object.entries(chars).sort((a, b) => b[1].seen - a[1].seen)
  const c = picked()
  if (!c || !list.length) {
    $('chars').replaceChildren()
    return
  }
  const isHere = (key) => here !== null && charKey(here) === key
  const dot = (key) => el('span', { class: `dot${isHere(key) ? ' here' : ''}`, title: isHere(key) ? 'Logged in now' : null })
  const current = el(
    'button',
    {
      type: 'button',
      class: 'n-pill current',
      'aria-haspopup': 'listbox',
      'aria-expanded': String(charMenu),
      title: `${c.name} on ${serverName(c.server)}: switch character`,
      onclick: (e) => {
        e.stopPropagation()
        charMenu = !charMenu
        renderChars()
        $('chars').querySelector('.menu button.on')?.focus()
      },
    },
    dot(view.char),
    el('span', {}, c.name),
  )
  const menu = charMenu
    ? el(
        'ul',
        { class: 'n-card menu', role: 'listbox', 'aria-label': 'Characters' },
        ...list.map(([key, ch]) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                type: 'button',
                role: 'option',
                class: view.char === key ? 'on' : '',
                'aria-selected': String(view.char === key),
                onclick: () => {
                  charMenu = false
                  pick({ char: key })
                },
              },
              dot(key),
              ch.name,
              el('span', { class: 'server' }, serverName(ch.server)),
            ),
          ),
        ),
      )
    : null
  $('chars').replaceChildren(current, ...(menu ? [menu] : []))
}

// The menu closes on a click anywhere else, and on Escape.
document.addEventListener('click', (e) => {
  if (charMenu && !$('chars').contains(e.target)) {
    charMenu = false
    renderChars()
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && charMenu) {
    charMenu = false
    renderChars()
    $('chars').querySelector('.current')?.focus()
  }
})

function renderReset(now) {
  if (!timers) {
    $('reset').textContent = ''
    return
  }
  const at = view.tab === 'daily' ? timers.dailyReset : timers.weeklyReset
  const which = view.tab === 'daily' ? 'Daily' : 'Weekly'
  $('reset').textContent = `${which} reset in ${L.duration(at - now)} (${new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})`
}

function groupEl(name, tasks, c, member, now) {
  const folded = FOLDED_GROUPS.has(name) || name === HIDDEN
  // What is left first, in the list's order; the done ones after it.
  const done = (t) => L.isDone(t, entryNow(t, c, member, now), member, now)
  const ordered = [...tasks.filter((t) => !done(t)), ...tasks.filter(done)]
  const list = el('ul', { class: 'n-card list' }, ...ordered.map((t) => rowEl(t, c, member, now)))
  const heading = el('h3', { class: 'n-heading' }, name === HIDDEN ? `${HIDDEN} · ${tasks.length}` : name)
  if (!folded) return el('section', { class: 'group' }, heading, list)
  const isOpen = name === HIDDEN ? hiddenOpen : view.open[name] === true
  const details = el('details', { class: 'group', open: isOpen }, el('summary', {}, heading), list)
  details.addEventListener('toggle', () => {
    // The Hidden section is not remembered: it starts collapsed every time.
    if (name === HIDDEN) hiddenOpen = details.open
    else pick({ open: { ...view.open, [name]: details.open } }, false)
  })
  return details
}

function rowEl(t, c, member, now) {
  // What the game says, when it says anything, takes over from what was entered: read, not typed.
  const d = detected(t, c, member, now)
  const entry = d?.entry ?? entryOf(t, c)
  const meta = []
  if (t.scope === 'server') meta.push(el('span', { class: 'badge', title: `Shared by every character on ${serverName(c.server)}` }, 'Server'))
  if (t.unlock) meta.push(el('span', {}, t.unlock))
  if (t.timer && timers?.on) {
    const next = timers.next.find((n) => n.id === t.timer)?.at
    if (next) meta.push(el('span', { title: 'From the Timers tab' }, `next ${time(next)}`))
  }
  if (t.ends) meta.push(el('span', {}, `until ${new Date(t.ends).toLocaleDateString([], { day: 'numeric', month: 'short' })}`))
  if (d) {
    meta.push(el('span', { class: 'game', title: `Read from the game ${ago(d.at)}` }, 'from the game'))
    if (d.recharge) meta.push(el('span', { class: 'recharge', title: 'The second pool: spent after the default one' }, `+${d.recharge} ${t.game.second ?? 'recharge'}`))
    if (d.note) meta.push(el('span', {}, d.note))
    if (d.left !== undefined) meta.push(el('span', {}, `${L.duration(d.left)} left${d.added ? `, +${L.duration(d.added)} added` : ''}`))
    if (d.since && timers && d.since > timers.weeklyReset - WEEK) meta.push(el('span', { title: 'No record from before this week: counted from when the first one was read' }, `counted since ${new Date(d.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`))
  }

  let tick
  let amount = null
  /** What a click on the row does: the same as its tick (a stock's row has none). */
  let toggle = null
  if (t.kind === 'bank') {
    const b = L.bankNow(t, entry, member, now, timers.dailyReset)
    const full = b.value !== null && b.cap !== null && b.value >= b.cap
    tick = el('span', { class: `tick stock${full ? ' full' : ''}`, title: full ? 'Full: refills are being lost' : 'Stocks up' })
    if (b.value === null) meta.push(el('span', {}, 'enter what you have'))
    else if (full) meta.push(el('span', { class: 'bad' }, 'full: spend some'))
    else if (b.fullAt) meta.push(el('span', { class: b.fullAt - now < L.DAY ? 'warn' : '' }, `full in ${L.duration(b.fullAt - now)}`))
    if (b.estimated) meta.push(el('span', { title: `${d?.entry ? 'The game said' : 'You entered'} ${entry.value} at ${new Date(entry.at).toLocaleString()}` }, 'estimated'))
    amount = d?.entry ? readEl(b.value, b.cap) : amountEl(b.value, b.cap, (v) => setEntry(t, c, L.setValue(t, v, member, Date.now())))
  } else if (t.kind === 'count') {
    const cap = L.capOf(t, member, now)
    const used = L.usedOf(entry, now)
    const done = used >= cap
    if (d?.entry) {
      // Counted by the game: shown as the game shows it (what is left, for an entry count).
      tick = el('span', { class: `tick read${done ? ' on' : ''}`, title: 'Counted by the game' })
      amount = t.game.left ? readEl(cap - used, cap, 'left') : readEl(used, cap)
    } else {
      toggle = () => setEntry(t, c, L.setUsed(t, done ? 0 : cap, member, Date.now(), timers))
      tick = el('button', {
        type: 'button',
        class: `tick${done ? ' on' : ''}`,
        title: done ? 'Clear' : 'All done',
        'aria-pressed': String(done),
        onclick: toggle,
      })
      amount = amountEl(used, cap, (v) => setEntry(t, c, L.setUsed(t, v, member, Date.now(), timers)))
    }
  } else {
    const done = L.doneOf(entry, now)
    toggle = () => setEntry(t, c, L.setDone(t, !done, timers))
    tick = el('button', {
      type: 'button',
      class: `tick${done ? ' on' : ''}`,
      title: done ? 'Not done' : 'Done',
      'aria-pressed': String(done),
      onclick: toggle,
    })
  }

  // A click anywhere on the row ticks it, except on its own controls (the tick, the amount).
  const onRow = toggle
    ? (e) => {
        if (!e.target.closest('button, input, a, .amount')) toggle()
      }
    : null
  const rowAttrs = { 'data-id': t.id, class: toggle ? 'clickable' : null, onclick: onRow }
  // Done: its name only, and a click (on it or its tick) undoes it.
  if (L.isDone(t, entry, member, now)) {
    if (!toggle) return el('li', { 'data-id': t.id, class: 'done', title: 'Done, as the game counts it' }, tick, el('div', { class: 'text' }, el('span', { class: 'name' }, t.name)), eyeEl(t))
    return el('li', { ...rowAttrs, class: 'done clickable', title: 'Done: click to undo' }, tick, el('div', { class: 'text' }, el('span', { class: 'name' }, t.name)), eyeEl(t))
  }
  return el(
    'li',
    rowAttrs,
    tick,
    el(
      'div',
      { class: 'text' },
      el('span', { class: 'name' }, t.name),
      t.detail ? el('span', { class: 'detail' }, t.detail) : null,
      t.tip ? el('span', { class: 'tip' }, t.tip) : null,
      meta.length ? el('div', { class: 'meta' }, ...meta) : null,
    ),
    amount,
    eyeEl(t),
  )
}

/** The eye at the end of a row: hide the task to the Hidden section, or bring it back to its own. */
function eyeEl(t) {
  const off = hidden[t.id] === true
  const b = el('button', {
    type: 'button',
    class: `n-pill round eye${off ? '' : ' on'}`,
    title: off ? `Show ${t.name} in ${t.group} again` : `Hide ${t.name} (to the Hidden section below)`,
    'aria-pressed': String(!off),
    onclick: () => {
      hidden = { ...hidden }
      if (off) delete hidden[t.id]
      else hidden[t.id] = true
      save('hidden', hidden)
      render()
    },
  })
  b.append(svg(off ? EYE_OFF : EYE))
  return b
}

function svg(paths) {
  const ns = 'http://www.w3.org/2000/svg'
  const s = document.createElementNS(ns, 'svg')
  s.setAttribute('viewBox', '0 0 16 16')
  s.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    s.append(p)
  }
  return s
}

/** A count the game keeps: shown, not edited. */
const readEl = (value, cap, unit = '') =>
  el('span', { class: 'amount count' }, `${value ?? '–'}${cap !== null && cap !== undefined ? ` / ${cap}` : ''}${unit ? ` ${unit}` : ''}`)

/** − [value] / cap +: typed or stepped. A blank value with no cap is a stock not entered yet. */
function amountEl(value, cap, set) {
  const input = el('input', { class: 'n-input', type: 'number', min: '0', max: cap ?? null, inputmode: 'numeric', value: value ?? '', placeholder: '–', 'aria-label': 'Amount' })
  input.addEventListener('change', () => {
    if (input.value.trim() === '') return render()
    const v = Number(input.value)
    if (Number.isFinite(v)) set(v)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
  })
  const step = (d) => el('button', { type: 'button', class: 'n-button step', 'aria-label': d > 0 ? 'One more' : 'One less', onclick: () => set((value ?? 0) + d) }, d > 0 ? '+' : '−')
  return el('div', { class: 'amount' }, step(-1), input, cap !== null ? el('span', { class: 'cap' }, `/ ${cap}`) : null, step(1))
}

// ---- choices ----------------------------------------------------------------------------------

function pick(change, redraw = true) {
  view = { ...view, ...change }
  save('view', view)
  if (redraw) render()
}

$('member').addEventListener('click', () => {
  const c = picked()
  if (!c) return
  // Set by hand against what the game says now; back to what it says, the game decides again.
  const { member, auto } = memberNow(c)
  members = { ...members, [c.server]: { on: !member, game: auto } }
  if (!member === (auto === true)) delete members[c.server]
  save('members', members)
  render()
})

// ---- the app ----------------------------------------------------------------------------------

function seeCharacter(status) {
  if (!status || !status.character || status.server === null || status.server === undefined) return
  here = { name: status.character, server: status.server }
  const key = charKey(here)
  const fresh = !chars[key]
  chars = { ...chars, [key]: { ...here, seen: Date.now() } }
  // Logging in to a character shows its tasks.
  if (fresh || view.char !== key) view = { ...view, char: key }
  save('chars', chars)
  save('view', view)
}

/**
 * What detect.py says (each character seen this run): kept per character, each part (tickets,
 * missions, PvP records) only when newer than what is kept, so a later run's first reads do not
 * undo an earlier one's later ones. Then the PvP weeks move on.
 */
function seeGame(state) {
  let changed = false
  for (const [key, g] of Object.entries(state?.chars ?? {})) {
    const kept = game[key] ?? {}
    const next = { ...kept, name: g.name ?? kept.name, server: g.server ?? kept.server }
    for (const part of ['missions', 'pvp', 'duties', 'benefits']) {
      const at = g[`${part}At`]
      if (g[part] && typeof at === 'number' && at >= (kept[`${part}At`] ?? 0)) {
        next[part] = g[part]
        next[`${part}At`] = at
      }
    }
    // Tickets: a newer whole list, and each ticket changed since on its own.
    const t = L.mergeTickets(kept, g)
    if (t.tickets) Object.assign(next, t.ticketsAt === undefined ? { tickets: t.tickets } : t)
    // Shops: each one as last read (opened or bought from), the newer read kept.
    for (const [shop, read] of Object.entries(g.shops ?? {})) {
      if ((read.at ?? 0) >= (kept.shops?.[shop]?.at ?? 0)) next.shops = { ...(next.shops ?? kept.shops ?? {}), [shop]: read }
    }
    if (!same(next, kept)) {
      game = { ...game, [key]: next }
      changed = true
    }
  }
  if (changed) save('game', game)
  if (movePvp() || changed) render()
}

/** Each character's PvP week (logic.js pvpBase) from its latest records, once the reset is known. */
function movePvp() {
  if (!timers) return false
  const weekStart = timers.weeklyReset - WEEK
  let changed = false
  for (const [key, g] of Object.entries(game)) {
    if (!g.pvp || typeof g.pvpAt !== 'number') continue
    const weeks = { ...(pvp[key] ?? {}) }
    for (const [mode, record] of Object.entries(g.pvp)) {
      const kept = weeks[mode]
      if (kept && kept.week === weekStart && kept.lastAt === g.pvpAt) continue
      weeks[mode] = L.pvpBase(kept, record, g.pvpAt, weekStart)
      changed = true
    }
    pvp = { ...pvp, [key]: weeks }
  }
  if (changed) save('pvp', pvp)
  return changed
}

const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

async function start() {
  const stored = await nyerk.storage.all()
  game = stored.game ?? {}
  pvp = stored.pvp ?? {}
  hidden = stored.hidden ?? {}
  chars = stored.chars ?? {}
  members = stored.members ?? {}
  progress = stored.progress ?? {}
  view = { ...view, ...(stored.view ?? {}) }
  if (!chars[view.char]) view.char = Object.entries(chars).sort((a, b) => b[1].seen - a[1].seen)[0]?.[0] ?? null

  let lastHere = null
  nyerk.on('status', (s) => {
    const key = s?.character && s.server != null ? `${s.server}:${s.character}` : null
    if (key === lastHere) return
    lastHere = key
    seeCharacter(s)
    render()
  })
  nyerk.on('timers', (t) => {
    timers = t
    movePvp()
    render()
  })
  nyerk.on('game', seeGame)
  nyerk.on('settings', render)
  // Another of its pages saved: keep in step. This page's own saves come back here too, and are
  // left alone: redrawing for them would cut short the rows' animation (setEntry).
  nyerk.on('storage', ({ key, value }) => {
    if (key === 'progress' && !same(value, progress)) progress = value ?? {}
    else if (key === 'members' && !same(value, members)) members = value ?? {}
    else if (key === 'chars' && !same(value, chars)) chars = value ?? {}
    else if (key === 'game' && !same(value, game)) game = value ?? {}
    else if (key === 'pvp' && !same(value, pvp)) pvp = value ?? {}
    else if (key === 'hidden' && !same(value, hidden)) hidden = value ?? {}
    else return
    render()
  })
  render()
  // Countdowns move on; a field being typed in is left alone.
  setInterval(() => {
    if (document.activeElement?.tagName === 'INPUT') renderReset(Date.now())
    else render()
  }, TICK_MS)
}

// A failure reaches the addon's card in Settings (the SDK reports unhandled rejections).
start()
