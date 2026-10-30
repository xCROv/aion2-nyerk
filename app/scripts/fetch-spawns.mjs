/**
 * Snapshot where every pet's souls drop: pet -> soul item -> the monsters that drop it (with their
 * level) -> their spawn points, plus the map images to draw them on.
 *
 *   node scripts/fetch-spawns.mjs [--force]
 *
 * Writes src/renderer/public/maps/spawns.json and the map images beside it (maps/<key>.webp, or
 * maps/<key>/<x>_<y>.webp for zones questlog.gg serves as tiles). Run fetch-pets.mjs first: pet
 * ids come from its pets.json. Images already present are kept unless --force.
 *
 * Source: questlog.gg's Aion 2 database and map (global client, `en`), used with credit. About 210
 * small requests, one ~20 MB marker download (filtered down here to soul-dropping monsters) and
 * the map images; sequential, with a pause between requests. Re-run after a patch.
 *
 * Coordinates: a world's `sectors` [x0, y0, nx, ny, size] say it spans x0..x0+nx*size and
 * y0..y0+ny*size, drawn as nx*1024 by ny*1024 pixels. questlog.gg stores y negated, so on the
 * image u = (x - x0) / (nx*size) and v = 1 + (y0 - y) / (ny*size). Checked against their own
 * render of Meadow Sparkie's spawns.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const PETS = join(APP, 'src', 'renderer', 'src', 'data', 'pets.json')
const OUT = join(APP, 'src', 'renderer', 'public', 'maps')
const API = 'https://questlog.gg/aion-2/api/trpc'
const IMAGE_CDN = 'https://cdn.questlog.gg/aion-2/map/v3'
const TILE_CDN = 'https://cdn.questlog.gg/aion-2/assets/Game/UI/Map/WorldMap'
const LANGUAGE = 'en'
const HEADERS = { 'user-agent': 'aion2-drop-tracker (personal pet collection tracker)', accept: 'application/json' }
const PAUSE_MS = 300
const force = process.argv.includes('--force')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * questlog.gg's world table (their map client's config, 2026-10-10): name, group, image key and
 * sectors [x0, y0, nx, ny, size]. Worlds in IMAGE_WORLDS are one image; the rest are 1024 px tiles.
 */
const WORLDS = {
  20: ['Chaotic Lower Reshanta', 'abyss', 'Abyss_Reshanta_A', [-204000, -204000, 4, 4, 102000]],
  22: ['Chaotic Middle Reshanta', 'abyss', 'Abyss_Reshanta_C', [-102000, -102000, 2, 2, 102000]],
  23: ['Chaotic Upper Reshanta', 'abyss', 'Abyss_Reshanta_D', [-102000, -102000, 2, 2, 102000]],
  1000: ['Poeta', 'elyos', 'World_L_Starter', [-204000, -204000, 4, 4, 102000]],
  1010: ['Verteron', 'elyos', 'World_L_A', [-408000, -408000, 8, 8, 102000]],
  1011: ['Eltnen', 'elyos', 'World_L_B', [-408000, -408000, 8, 8, 102000]],
  1100: ['Ishalgen', 'asmodians', 'World_D_Starter', [-329748, -257999.78, 5, 5, 102000]],
  1110: ['Altgard', 'asmodians', 'World_D_A', [-408000, -408000, 8, 8, 102000]],
  1111: ['Morheim', 'asmodians', 'World_D_B', [-408000, -408000, 8, 8, 102000]],
  200004: ["Narun's Dream", 'dungeons', 'Dungeon_0004', [-46174.91, -61276.02, 1, 1, 102000]],
  200005: ['Subspace of Ascension', 'dungeons', 'Dungeon_0005', [-51156.95, -417943.59, 1, 5, 102000]],
  200006: ['Dream of Shattered Fragments', 'dungeons', 'Dungeon_0006', [-51000, -51000, 1, 1, 102000]],
  210001: ['Coastal Cave', 'elyos-dungeons', 'CoastalCave', [-43724.83, -57582.75, 1, 1, 102000]],
  210004: ['Illusion Sanctum', 'elyos-dungeons', 'Dungeon_L_0004', [-18136.75, -25165.92, 1, 1, 51000]],
  210006: ['Root Cellar', 'elyos-dungeons', 'RootCellar', [-54389.18, -64571.44, 1, 1, 102000]],
  210007: ['Aullaeu Altar', 'elyos-dungeons', 'StrigikAltar', [-45664.97, -58587.48, 1, 1, 102000]],
  210008: ['Illusion Hideout', 'elyos-dungeons', 'Dungeon_L_0008', [-15952.84, -23843.57, 1, 1, 51000]],
  210009: ['Zumion Relic Storage', 'elyos-dungeons', 'Dungeon_L_0009', [-26637, -21416.43, 1, 1, 51000]],
  210010: ['Nahid Disposal Plant', 'elyos-dungeons', 'Dungeon_L_0010', [-17388.82, -30869.57, 1, 1, 51000]],
  210011: ['Ardus Shrine', 'elyos-dungeons', 'Dungeon_L_0011', [-25490, -21947.5, 1, 1, 51000]],
  210012: ['Illicit Trade Spot', 'elyos-dungeons', 'IllicitTradeSpot', [-13646.35, -11975.75, 1, 1, 25500]],
  210014: ["Zikel's Collapsed Barracks", 'elyos-dungeons', 'Dungeon_L_0014', [-24151.74, -25541.03, 1, 1, 51000]],
  210017: ['Fountain of Life', 'elyos-dungeons', 'Dungeon_L_0017', [-22759.66, -35356.69, 1, 1, 51000]],
  210018: ['Light Crash Site', 'elyos-dungeons', 'Dungeon_L_0018', [-31530, -19325, 1, 1, 51000]],
  210019: ['Lepharist Research Center', 'elyos-dungeons', 'Dungeon_L_0019', [-23495.46, -18936.11, 1, 1, 51000]],
  220001: ['Crypt', 'asmodian-dungeons', 'Dungeon_D_0001', [-51000, -51000, 1, 1, 102000]],
  220002: ["Zikel's Sanctum", 'asmodian-dungeons', 'Dungeon_D_0002', [-21837.5, -37157.5, 1, 1, 51000]],
  220006: ['Collapsed Oracle', 'asmodian-dungeons', 'Dungeon_D_0006', [-17829.98, -33533.82, 1, 1, 51000]],
  220007: ['Root of the Sacred Tree', 'asmodian-dungeons', 'Dungeon_D_0007', [-26357.8, -33778.64, 1, 1, 51000]],
  220008: ['Dranactus Underkeep', 'asmodian-dungeons', 'Dungeon_D_0008', [-14458.5, -27098.5, 1, 1, 51000]],
  220009: ['Destruction Archon Underground Fortress', 'asmodian-dungeons', 'Dungeon_D_0009', [-35548.83, -52910.19, 1, 1, 102000]],
  220010: ['Blades Hideout', 'asmodian-dungeons', 'Dungeon_D_0010', [-32310.21, -27053.81, 1, 1, 51000]],
  220011: ['Impetusium', 'asmodian-dungeons', 'Dungeon_D_0011', [-12703.5, -12921, 1, 1, 25500]],
  220014: ["Kaisinel's Collapsed Sanctum", 'asmodian-dungeons', 'Dungeon_D_0014', [-19978.5, -23755, 1, 1, 51000]],
  220019: ['Blades Secret Storage', 'asmodian-dungeons', 'Dungeon_D_0019', [-23351.33, -19036.24, 1, 1, 51000]],
  220020: ["Executioner's Tower", 'asmodian-dungeons', 'Dungeon_D_0020', [-24472.6, -28511.45, 1, 1, 51000]],
  220021: ['Floating Temple of Arkanis', 'asmodian-dungeons', 'Dungeon_D_0021', [-25500, -25500, 1, 1, 51000]],
  220022: ['Fire Temple', 'asmodian-dungeons', 'Dungeon_D_0022', [-28982.5, 697.5, 1, 1, 25500]],
}
/**
 * Zones with no soul monsters whose map ships in maps/ by hand (not downloaded here), kept in
 * spawns.json so addons can mark things on them. Goldrin's Treasure, the Shugo Festival's arena:
 * interactivemap.app's tiles (their image g500041, stitched to 2048 px); sectors
 * fitted to the spires in a capture.
 */
const LOCAL_WORLDS = {
  500041: ["Goldrin's Treasure", 'events', 'Event_GoldrinsTreasure', [-29950, -65202, 1, 1, 102000]],
}
const IMAGE_WORLDS = new Set(['World_L_Starter', 'World_L_A', 'World_L_B', 'World_D_Starter', 'World_D_A', 'World_D_B', 'Abyss_Reshanta_A'])

async function trpc(proc, input) {
  const url = `${API}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`${proc}: HTTP ${res.status}`)
  return (await res.json()).result.data
}

async function download(url, file) {
  if (existsSync(file) && !force) return 0
  const res = await fetch(url)
  if (!res.ok) {
    console.warn(`  ${url}: HTTP ${res.status}`)
    return 0
  }
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buf)
  await sleep(PAUSE_MS)
  return buf.length
}

/** Ray casting; `ring` is [[x, y], ...]. */
function inside([x, y], ring) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

const ringArea = (ring) => Math.abs(ring.reduce((a, [x, y], i) => {
  const [x2, y2] = ring[(i + 1) % ring.length]
  return a + x * y2 - x2 * y
}, 0)) / 2

// ---- 1. pet -> soul item ---------------------------------------------------------------------

const pets = JSON.parse(readFileSync(PETS, 'utf8')).pets
const petByName = new Map(pets.map((p) => [p.name, p.id]))

console.log('soul items…')
let items = []
const first = await trpc('database.getItems', { language: LANGUAGE, page: 1, mainCategory: 'usable', subCategory: 'vehiclesoul' })
items = first.pageData
for (let p = 2; p <= first.pageCount; p++) {
  await sleep(PAUSE_MS)
  items = items.concat((await trpc('database.getItems', { language: LANGUAGE, page: p, mainCategory: 'usable', subCategory: 'vehiclesoul' })).pageData)
}
const soulItems = items
  .map((i) => ({ item: i.id, pet: petByName.get(i.name.match(/^Soul: (.*) \(Bound\)$/)?.[1]) }))
  .filter((s) => s.pet !== undefined)
console.log(`  ${soulItems.length} soul items matched to pets`)

// ---- 2. soul item -> monsters that drop it ---------------------------------------------------

console.log('who drops each soul…')
const droppers = new Map() // pet id -> [{ npc, name, level, chance }]
for (const [n, s] of soulItems.entries()) {
  await sleep(PAUSE_MS)
  const item = await trpc('database.getItem', { id: s.item, language: LANGUAGE })
  const list = (item.itemIsDroppedByNpcs ?? []).map((d) => ({ npc: Number(d.id), name: d.name, level: d.level, chance: d.chance }))
  droppers.set(s.pet, list)
  if ((n + 1) % 25 === 0) console.log(`  ${n + 1}/${soulItems.length}`)
}
const npcIds = new Set([...droppers.values()].flat().map((d) => d.npc))
console.log(`  ${npcIds.size} monsters drop souls`)

// ---- 3. monsters -> spawn points -------------------------------------------------------------

console.log('map markers (one large download)…')
const markers = await trpc('map.getMarkers', { language: LANGUAGE })
const spawns = new Map() // npc -> { world -> [[x, y]] }
for (const m of markers) {
  if (m.dbType !== 'npc' || !npcIds.has(Number(m.dbId))) continue
  const byWorld = spawns.get(Number(m.dbId)) ?? {}
  for (const [x, y] of m.coordinates) (byWorld[m.mapWorldId] ??= []).push([Math.round(x), Math.round(y)])
  spawns.set(Number(m.dbId), byWorld)
}
console.log(`  ${spawns.size} of them have spawn points on the map`)

console.log('regions…')
const regions = (await trpc('map.getRegions', { language: LANGUAGE })).map((r) => ({
  world: r.mapWorldId,
  name: r.name,
  kind: r.kind,
  rings: r.polygons ?? [],
  area: (r.polygons ?? []).reduce((a, ring) => a + ringArea(ring), 0),
}))

/** The smallest named region a point falls in (regions are stored with y as markers are). */
function regionAt(world, [x, y]) {
  let best = null
  for (const r of regions) {
    if (r.world !== world || !r.rings.some((ring) => inside([x, y], ring))) continue
    if (!best || r.area < best.area) best = r
  }
  return best?.name ?? null
}

// ---- 4. assemble, and the images the spawns need ---------------------------------------------

const usedWorlds = new Set()
const outPets = {}
for (const [pet, list] of droppers) {
  outPets[pet] = list.map((d) => {
    const byWorld = spawns.get(d.npc) ?? {}
    const worlds = Object.entries(byWorld)
      .filter(([w]) => WORLDS[w])
      .map(([w, points]) => {
        usedWorlds.add(w)
        // Label by where most of the spawns are.
        const names = new Map()
        for (const p of points) {
          const r = regionAt(w, p)
          if (r) names.set(r, (names.get(r) ?? 0) + 1)
        }
        const area = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        return { world: Number(w), area, points }
      })
    return { ...d, worlds }
  })
}

const outWorlds = {}
let bytes = 0
for (const w of [...usedWorlds].sort((a, b) => a - b)) {
  const [name, group, key, sectors] = WORLDS[w]
  const [, , nx, ny] = sectors
  const image = IMAGE_WORLDS.has(key)
  outWorlds[w] = { name, group, key, sectors, image }
  console.log(`map ${name} (${key})…`)
  if (image) {
    bytes += await download(`${IMAGE_CDN}/${key}.webp`, join(OUT, `${key}.webp`))
  } else {
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++) {
        const xy = `${String(x).padStart(2, '0')}_${String(y).padStart(2, '0')}`
        bytes += await download(`${TILE_CDN}/${key}/Res/${key}_${xy}.webp`, join(OUT, key, `${xy}.webp`))
      }
  }
}

for (const [w, [name, group, key, sectors]] of Object.entries(LOCAL_WORLDS)) {
  if (!existsSync(join(OUT, `${key}.webp`))) console.warn(`  ${key}.webp is missing (shipped by hand, not downloaded)`)
  outWorlds[w] = { name, group, key, sectors, image: true }
}

const out = {
  source: `https://questlog.gg/aion-2/${LANGUAGE}/map`,
  fetched: new Date().toISOString().slice(0, 10),
  worlds: outWorlds,
  pets: outPets,
}
writeFileSync(join(OUT, 'spawns.json'), JSON.stringify(out))

const points = Object.values(outPets).flat().flatMap((d) => d.worlds).reduce((n, w) => n + w.points.length, 0)
const labelled = Object.values(outPets).flat().flatMap((d) => d.worlds)
console.log(`pets with drop data: ${Object.keys(outPets).length}; spawn points: ${points}; worlds: ${usedWorlds.size}`)
console.log(`area labels: ${labelled.filter((w) => w.area).length}/${labelled.length}`)
console.log(`images: ${(bytes / 1024 / 1024).toFixed(1)} MB downloaded`)
