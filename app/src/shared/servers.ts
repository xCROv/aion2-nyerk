import { GAME_SERVERS } from './gameServers.ts'

/** A game server by the id the game uses (in kill credits and player records): its name (Kaisinel
 *  for 1104, from GAME_SERVERS), or the id when the list doesn't have it. */
export const serverName = (id: number): string => GAME_SERVERS[id] ?? String(id)

/**
 * Tags the game was seen showing next to a cross-server player ("xKanekii [LUM]"): Kaisinel 1104
 * from the owner's character (2026-10-13), LUM 2104 from the owner reading the tag on a player
 * whose records say 2104 (pvp_kills.pcap). Both are the name's first three letters, which is what
 * the other servers get (a guess: two Europe pairs share theirs, Kasaka/Kashapa and Beritra/Berk).
 */
const SERVER_TAGS: Record<number, string> = {
  1104: 'KAI',
  2104: 'LUM',
}

/** A game server's short tag, as the game shows it beside a player's name (KAI); the id when it
 *  has no name. For the PvP log and kill feed, where the full name goes in the tooltip. */
export const serverTag = (id: number): string =>
  SERVER_TAGS[id] ?? GAME_SERVERS[id]?.slice(0, 3).toUpperCase() ?? String(id)
