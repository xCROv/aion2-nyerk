// Task List, the tasks: the daily, weekly and event limits the tab tracks (docs/TASKS.md has where
// each number comes from, and the follow-ups F1–F3 the assumptions below stand in for).
//
// Each task:
//   id, tab ('daily' | 'weekly' | 'event'), group, name, detail
//   kind   'count': `cap` uses a reset (daily or weekly by its tab), ticked off one at a time
//          'check': done once a reset
//          'bank':  a stock that refills (`refill`) up to `cap` and keeps across resets; the player
//                   enters what they have, the tab adds the refills since. No `refill` or `cap`:
//                   a plain number, nothing estimated (F2)
//   cap    a number, or { base, member } (membership raises it), or a list of { until, value } with
//          the last one open-ended (a limit that changes on a date)
//   refill { every: 'day', amount } at each daily reset, or { hours, amount }
//   scope  'char' or 'server' (shared by every character on that server: counted once)
//   timer  a Timers id whose next start the row shows (the Timers addon works it out)
//   optional, member (member-only), ends (the event is over: ms), unlock, tip
//   game   where the game says it (detect.py, the Python part): { ticket } a content ticket whose
//          first count is the stock (a bank) or what is left (`left`, a count: used = cap - left),
//          the second the recharge pool (`second` names it otherwise); { hours } a ticket of time left; { pvp, count } a PvP
//          mode's season record ('matches' or 'wins' this week); { season } the Season Missions;
//          { duties } the duty board (taken today: the game's n/5); { shop } a shop's bought counts
//          (16539 the Command shop in the main bases, 18533 the Abyss one: only seen when a shop is
//          opened or used)
;(function (root) {
  'use strict'

  const HALLOWEEN_ENDS = Date.parse('2026-11-04T07:00:00Z') // the reset after the 3 Nov maintenance (4 Nov in Europe)
  const TRANSFER_ENDS = Date.parse('2026-10-28T07:00:00Z') // the 27 Oct maintenance (28 Oct in Europe)

  const TASKS = [
    // ---- Daily ------------------------------------------------------------------------------------
    {
      id: 'duties', game: { duties: true }, tab: 'daily', group: 'Every day', name: 'Daily Duties', kind: 'count', cap: 5, scope: 'server',
      detail: 'Journal (J). Abandoned duties don’t count, so drop a poor one.', unlock: 'Level 45',
      tip: 'Best picks first: Nightmare ticket, Shugo Festival key, Ascension Trial ticket (if you clear Hard or Extreme), Unknown Fissure ticket, Hidden Cube key, then Small Odyle Energy. Do them on your main.',
    },
    {
      id: 'hidden-cube-keys', tab: 'daily', group: 'Every day', name: 'Hidden Cube keys', kind: 'count', cap: 3, scope: 'char', optional: true,
      detail: 'Quna shop, 50 Quna each.',
    },
    {
      id: 'emergency-supply', tab: 'daily', group: 'Every day', name: 'Emergency Supply Requests', kind: 'count', cap: 10, scope: 'char', optional: true,
      detail: 'Supply Request board (Alt+J).', unlock: 'Level 25',
    },
    {
      id: 'odyle', game: { ticket: 60000001, second: 'charged' }, tab: 'daily', group: 'Stocks up', name: 'Odyle Energy', kind: 'bank', cap: { base: 560, member: 840 }, refill: { hours: 3, amount: 15 }, scope: 'char',
      detail: 'Spent on Conquest, Transcendence and Exploration cubes (most cost 40). Refills offline.',
    },
    {
      id: 'nightmare', game: { ticket: 4 }, tab: 'daily', group: 'Stocks up', name: 'Nightmare', kind: 'bank', cap: 14, refill: { every: 'day', amount: 2 }, scope: 'char',
      detail: 'Solo boss ladder. An attempt is only spent on a clear.',
    },
    {
      id: 'shugo-keys', game: { ticket: 1 }, tab: 'daily', group: 'Stocks up', name: 'Shugo Festival keys', kind: 'bank', cap: { base: 12, member: 21 }, refill: { every: 'day', amount: 3 }, scope: 'server', timer: 'shugo',
      detail: 'Only spent while a festival runs (every hour on the hour): spend them as you go.',
    },
    {
      id: 'invasion-keys', game: { ticket: 8 }, tab: 'daily', group: 'Stocks up', name: 'Dimensional Invasion keys', kind: 'bank', cap: 7, refill: { every: 'day', amount: 1 }, scope: 'char', timer: 'invasion',
      detail: 'Only spent while an invasion runs (every hour at :30).',
    },
    {
      id: 'conquest', tab: 'daily', group: 'Stocks up', name: 'Conquest runs', kind: 'bank', scope: 'char',
      detail: 'Cube runs in the Conquest (Expedition) dungeons. How they refill and bank isn’t confirmed yet.',
    },
    {
      id: 'transcendence', tab: 'daily', group: 'Stocks up', name: 'Transcendence runs', kind: 'bank', scope: 'char', unlock: 'Item level 1,600',
      detail: 'Cube runs in Deus Research Base and Shattered Arkanis. How they refill and bank isn’t confirmed yet.',
    },
    {
      id: 'balaur-fortress', tab: 'daily', group: 'Stocks up', name: 'Abandoned Balaur Fortress', kind: 'bank', cap: 7, refill: { every: 'day', amount: 1 }, scope: 'char',
      detail: 'Dungeon entries.',
    },
    {
      id: 'fafnium-lab', tab: 'daily', group: 'Stocks up', name: 'Fafnium Laboratory', kind: 'bank', cap: 7, refill: { every: 'day', amount: 1 }, scope: 'char',
      detail: 'Dungeon entries.',
    },
    {
      id: 'rifts', tab: 'daily', group: 'Optional', name: 'Spacetime Rifts', kind: 'check', scope: 'char', optional: true, timer: 'rift',
      detail: 'Verteron, Eltnen, Altgard and Morheim. Abyss Points even after the weekly cap.',
    },

    // ---- Weekly -----------------------------------------------------------------------------------
    {
      id: 'daily-dungeon', game: { ticket: 101, left: true }, tab: 'weekly', group: 'Dungeons', name: 'Daily Dungeon (Unknown Fissure)', kind: 'count', cap: 14, scope: 'server',
      detail: 'Weekly despite the name: 2 a day keeps pace. Instant Clear tickets use entries too.', unlock: 'Level 30',
    },
    {
      id: 'ascension', game: { ticket: 80000001, left: true }, tab: 'weekly', group: 'Dungeons', name: 'Ascension Trial', kind: 'count', cap: 3, scope: 'char',
      detail: 'Spent on entry. Dying or running out of time forfeits the rewards.', unlock: 'Item level 1,500 for Normal',
    },
    {
      id: 'ludra', tab: 'weekly', group: 'Dungeons', name: 'Sanctuary: Ludra', kind: 'count', cap: 4, scope: 'char',
      detail: 'Attempts, spent on entry. 1 final-boss kill a week.',
    },
    {
      id: 'decontamination', tab: 'weekly', group: 'Dungeons', name: 'Sanctuary: Corroded Decontamination Facility', kind: 'count', cap: 4, scope: 'char',
      detail: 'Attempts, spent on entry. 2 final-boss kills a week.',
    },
    {
      id: 'muspel', tab: 'weekly', group: 'Dungeons', name: 'Sanctuary: Chalice of Muspel', kind: 'count', cap: 4, scope: 'char',
      detail: 'Attempts, spent on entry. 2 final-boss kills a week.',
    },
    {
      id: 'subjugation', tab: 'weekly', group: 'Dungeons', name: 'Subjugation', kind: 'count', cap: 3, scope: 'char',
      detail: '4-player dungeons, one ticket per entry.',
    },
    {
      id: 'exploration', tab: 'weekly', group: 'Dungeons', name: 'Exploration dungeons', kind: 'check', scope: 'char',
      detail: '7 reward runs in each. Krao Cave and Urugugu Canyon cubes cost only 20 energy.',
    },
    {
      id: 'ordeal', tab: 'weekly', group: 'Dungeons', name: 'Ordeal final bosses', kind: 'count', cap: 7, scope: 'char',
      detail: 'Final-boss kills.',
    },
    {
      id: 'growth-graveyard', tab: 'weekly', group: 'Dungeons', name: 'Silent Graveyard', kind: 'check', scope: 'char',
      detail: 'Growth dungeon: 7 hours, counted only while inside.',
    },
    {
      id: 'growth-amphitheater', tab: 'weekly', group: 'Dungeons', name: 'Fafnite Amphitheater', kind: 'check', scope: 'char',
      detail: 'Growth dungeon: 7 hours, counted only while inside.',
    },
    {
      id: 'faction-command', game: { shop: 16539 }, tab: 'weekly', group: 'Commands and missions', name: 'Faction Command scroll', kind: 'count', cap: 12, scope: 'server',
      detail: 'Bought from the Command Shop Merchant in the main bases. Scrolls you’ve bought keep past the reset.',
    },
    {
      id: 'latesran', game: { shop: 18533 }, tab: 'weekly', group: 'Commands and missions', name: 'Latesran Root Commands', kind: 'count', cap: 20, scope: 'server',
      detail: 'Bought in the Abyss: 5 of each of the four. Bought scrolls keep past the reset.',
    },
    {
      id: 'season-missions', game: { season: true }, tab: 'weekly', group: 'Commands and missions', name: 'Season Missions', kind: 'count', cap: 40, scope: 'char',
      detail: 'Missions finished this week; each one in the Season tab. Up to 94,230 Abyss Points.',
    },
    {
      id: 'daeva-pass', tab: 'weekly', group: 'Commands and missions', name: 'Daeva Pass EXP', kind: 'check', scope: 'char',
      detail: 'Weekly EXP cap: 50,000 (Season 1).',
    },
    {
      id: 'sprout-badge', tab: 'weekly', group: 'Commands and missions', name: 'Sprout Badge rewards', kind: 'count', cap: 14, scope: 'char',
      detail: 'Reward count.',
    },
    {
      id: 'solitude-matches', game: { pvp: 1, count: 'matches' }, tab: 'weekly', group: 'PvP', name: 'Arena of Solitude: matches', kind: 'count', cap: 10, scope: 'char',
      detail: '1v1. Unclaimed rewards are lost.', unlock: 'Level 45',
    },
    {
      id: 'solitude-wins', game: { pvp: 1, count: 'wins' }, tab: 'weekly', group: 'PvP', name: 'Arena of Solitude: wins', kind: 'count', cap: 30, scope: 'char',
      detail: '1v1.', unlock: 'Level 45',
    },
    {
      id: 'cooperation-matches', game: { pvp: 2, count: 'matches' }, tab: 'weekly', group: 'PvP', name: 'Arena of Cooperation: matches', kind: 'count', cap: 10, scope: 'char',
      detail: '5v5. Unclaimed rewards are lost.', unlock: 'Level 45',
    },
    {
      id: 'cooperation-wins', game: { pvp: 2, count: 'wins' }, tab: 'weekly', group: 'PvP', name: 'Arena of Cooperation: wins', kind: 'count', cap: 30, scope: 'char',
      detail: '5v5.', unlock: 'Level 45',
    },
    {
      id: 'battlefield-matches', game: { pvp: 3, count: 'matches' }, tab: 'weekly', group: 'PvP', name: 'Battlefield: matches', kind: 'count', cap: 3, scope: 'char',
      detail: '10v10.', unlock: 'Level 45',
    },
    {
      id: 'battlefield-wins', game: { pvp: 3, count: 'wins' }, tab: 'weekly', group: 'PvP', name: 'Battlefield: wins', kind: 'count', cap: 3, scope: 'char',
      detail: '10v10.', unlock: 'Level 45',
    },
    {
      id: 'abyss-points-cap', tab: 'weekly', group: 'PvP', name: 'Abyss Points cap reached', kind: 'check', scope: 'char', optional: true,
      detail: 'PvE and PvP are capped apart. After it, only Spacetime Rifts give a little.',
    },
    {
      id: 'abyss-lower', game: { hours: 3 }, tab: 'weekly', group: 'Abyss time', name: 'Lower Reshanta', kind: 'check', scope: 'char', optional: true,
      detail: '7 hours a week (14 with membership).',
    },
    {
      id: 'abyss-middle', tab: 'weekly', group: 'Abyss time', name: 'Middle Reshanta', kind: 'check', scope: 'char', optional: true,
      detail: '7 hours a week (14 with membership).',
    },
    {
      id: 'abyss-upper', tab: 'weekly', group: 'Abyss time', name: 'Upper Reshanta', kind: 'check', scope: 'char', optional: true,
      detail: '7 hours a week.',
    },
    {
      id: 'odyle-morph-char', tab: 'weekly', group: 'Resources', name: 'Odyle Energy morphs', kind: 'count', scope: 'char',
      cap: [{ until: TRANSFER_ENDS, value: 20 }, { value: 4 }],
      detail: 'Per character. Members: 20 a week until the 27 Oct maintenance, then 4.',
    },
    {
      id: 'odyle-morph-server', tab: 'weekly', group: 'Resources', name: 'Odyle Energy morphs (server)', kind: 'count', cap: 16, scope: 'server',
      detail: 'Shared by the server’s characters.',
    },
    {
      id: 'sealed-wings', tab: 'weekly', group: 'Resources', name: 'Sealed wings → Enhance Stones', kind: 'count', cap: 20, scope: 'server',
      detail: 'Substance Morph, 10,000 stones each.',
    },
    {
      id: 'weekly-supply', tab: 'weekly', group: 'Resources', name: 'Weekly Supply Requests', kind: 'count', cap: 10, scope: 'char', optional: true,
      detail: 'Supply Request board (Alt+J).', unlock: 'Level 25',
    },
    {
      id: 'conquest-bosses', tab: 'weekly', group: 'Caps to watch', name: 'Conquest final bosses', kind: 'count', cap: 35, scope: 'char',
      detail: 'Kills that pay out. A cap to watch, not to chase.',
    },
    {
      id: 'transcendence-bosses', tab: 'weekly', group: 'Caps to watch', name: 'Transcendence final bosses', kind: 'count', cap: 28, scope: 'char',
      detail: 'Kills that pay out. A cap to watch, not to chase.',
    },
    {
      id: 'unobtained-cubes', game: { ticket: 60000009, left: true }, tab: 'weekly', group: 'Caps to watch', name: 'Unobtained cubes', kind: 'count', cap: 10, scope: 'server',
      detail: 'At 10 you can’t enter Conquest or Transcendence until Wednesday. Clearing without taking the cube still counts.',
    },

    // ---- Weekly shop limits (folded) ------------------------------------------------------------------
    { id: 'shop-spiritstone', tab: 'weekly', group: 'Shop limits', name: 'Resurrection Spiritstone', kind: 'count', cap: 10, scope: 'char', member: true, detail: 'Wind Breeze Merchants.' },
    { id: 'shop-soul-crystal', tab: 'weekly', group: 'Shop limits', name: 'Soul Crystal', kind: 'count', cap: 1000, scope: 'server', member: true, detail: 'Wind Breeze Merchants.' },
    { id: 'shop-instant-clear', tab: 'weekly', group: 'Shop limits', name: 'Instant Clear Ticket: Daily Dungeon', kind: 'count', cap: 7, scope: 'server', member: true, detail: 'Wind Breeze Merchants.' },
    { id: 'shop-manastone', tab: 'weekly', group: 'Shop limits', name: 'Lesser Abyssal Manastone', kind: 'count', cap: 50, scope: 'char', detail: 'Abyss Shop (Consumables).' },
    { id: 'shop-soulstone', tab: 'weekly', group: 'Shop limits', name: 'Lesser Abyssal Soulstone', kind: 'count', cap: 50, scope: 'char', detail: 'Abyss Shop (Consumables).' },
    { id: 'shop-potential', tab: 'weekly', group: 'Shop limits', name: 'Potential Stone: Abyss', kind: 'count', cap: 2, scope: 'server', detail: 'Abyss Shop (Growth).' },
    { id: 'shop-silver-medal', tab: 'weekly', group: 'Shop limits', name: 'Silver Medal', kind: 'count', cap: 10, scope: 'char', detail: 'Abyss Shop (Medal).' },

    // ---- Event: Halloween (weekly limits) ---------------------------------------------------------------
    { id: 'halloween-yellow', tab: 'event', group: 'Halloween', name: 'Yellow Candy', kind: 'count', cap: 1, scope: 'server', ends: HALLOWEEN_ENDS, detail: '10,000 Abyss Points, once a week.' },
    { id: 'halloween-blue', tab: 'event', group: 'Halloween', name: 'Blue Candy', kind: 'count', cap: 1, scope: 'server', ends: HALLOWEEN_ENDS, detail: '4 Odyle Energy, once a week.' },
    { id: 'halloween-shugo', tab: 'event', group: 'Halloween', name: 'Event vendor: Shugo Festival keys', kind: 'count', cap: 3, scope: 'char', ends: HALLOWEEN_ENDS, detail: 'A week.' },
    { id: 'halloween-odyle', tab: 'event', group: 'Halloween', name: 'Event vendor: Odyle Energy', kind: 'count', cap: 4, scope: 'char', ends: HALLOWEEN_ENDS, detail: 'A week.' },
    { id: 'halloween-rift-stones', tab: 'event', group: 'Halloween', name: 'Event vendor: Lower Abyss Rift Stones', kind: 'count', cap: 2, scope: 'char', ends: HALLOWEEN_ENDS, detail: 'A week.' },
  ]

  /** Groups folded until opened. */
  const FOLDED_GROUPS = new Set(['Shop limits'])

  if (typeof module === 'object' && module.exports) module.exports = { TASKS, FOLDED_GROUPS }
  else root.tasks = { TASKS, FOLDED_GROUPS }
})(this)
