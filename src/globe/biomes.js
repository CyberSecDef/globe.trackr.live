/**
 * Stylised palette the tiles snap toward, and the rules that pick an entry.
 *
 * Classification runs off the averaged Blue Marble pixel under each tile plus
 * the baked class / elevation / ruggedness channels. The averaged satellite
 * colour is kept around so the UI can cross-fade between "stylised" and
 * "photoreal" without reclassifying anything.
 */

export const BIOMES = {
  abyss:      { color: 0x081f3d, label: 'Abyssal ocean' },
  ocean:      { color: 0x0e3f6b, label: 'Open ocean' },
  sea:        { color: 0x17608f, label: 'Ocean' },
  shelf:      { color: 0x2a86ad, label: 'Continental shelf' },
  seaIce:     { color: 0xbcd6e4, label: 'Sea ice' },
  lake:       { color: 0x2c6f9e, label: 'Inland water' },
  iceSheet:   { color: 0xeef4f8, label: 'Ice sheet' },
  glacier:    { color: 0xd4e4ee, label: 'Glacier' },
  tundra:     { color: 0x92a086, label: 'Tundra' },
  taiga:      { color: 0x2c5638, label: 'Boreal forest' },
  forest:     { color: 0x3c7a41, label: 'Temperate forest' },
  rainforest: { color: 0x1a6630, label: 'Tropical forest' },
  grassland:  { color: 0x8fae5a, label: 'Grassland' },
  steppe:     { color: 0xa79a5f, label: 'Steppe & shrubland' },
  savanna:    { color: 0xbb9c4c, label: 'Savanna' },
  desert:     { color: 0xd8c08c, label: 'Desert' },
  badlands:   { color: 0xae8862, label: 'Arid highland' },
  alpine:     { color: 0x8a8175, label: 'Mountain' },
  snowcap:    { color: 0xe6eef4, label: 'Snowcap' },
}

export const CLASS = { OCEAN: 0, LAKE: 1, LAND: 2, ICE: 3 }

/** Baked R channel values -> class enum. */
export function decodeClass(r) {
  if (r > 210) return CLASS.ICE
  if (r > 130) return CLASS.LAND
  if (r > 40) return CLASS.LAKE
  return CLASS.OCEAN
}

/**
 * Pick a biome key.
 *
 * @param {number} cls      CLASS enum from the baked mask
 * @param {number[]} rgb    averaged satellite colour, 0..1
 * @param {number} elev     0..1 (roughly 0..9500 m)
 * @param {number} rugged   0..1 local relief
 * @param {number} absLat   0..90
 */
export function classify(cls, rgb, elev, rugged, absLat) {
  const [r, g, b] = rgb
  const value = (r + g + b) / 3

  if (cls === CLASS.OCEAN) {
    if (absLat > 70 && value > 0.34) return 'seaIce'
    if (value < 0.055) return 'abyss'
    if (value < 0.1) return 'ocean'
    if (value < 0.19) return 'sea'
    return 'shelf'
  }
  if (cls === CLASS.LAKE) return absLat > 72 ? 'seaIce' : 'lake'
  if (cls === CLASS.ICE) return absLat > 62 ? 'iceSheet' : 'glacier'

  // Land. Height and relief win over colour: a bright summit is rock, not sand.
  if (elev > 0.74) return 'snowcap'
  if (elev > 0.5 || (elev > 0.3 && rugged > 0.6)) return 'alpine'
  if (absLat > 66) return value > 0.5 ? 'glacier' : 'tundra'

  // Blue Marble is a dark image; dense canopy sits near value 0.1, not 0.4. So
  // greenness decides whether a tile is vegetated at all, and latitude decides
  // which forest it is. Using brightness for the forest split misreads every
  // temperate forest on the planet as boreal.
  const green = g - (r + b) / 2
  // Boreal tiles read less green than they are: at these latitudes a hexagon is
  // part lake, part bog, part burn scar. Lower the bar rather than call Finland
  // tundra.
  if (green > (absLat > 55 ? 0.035 : 0.058)) {
    if (absLat > 55) return 'taiga'
    if (absLat > 40) return value < 0.125 ? 'taiga' : 'forest'
    if (absLat > 23) return 'forest'
    return value < 0.14 ? 'rainforest' : 'forest'
  }
  // Sand reads faintly "green" on this imagery — g sits midway between r and b —
  // so the desert tests have to run before the grassland test, or the Sahara
  // comes out a prairie. Two kinds: bright pale sand, and dark red iron sand.
  if (green < 0.05 && value > 0.43) return 'desert'
  if (green < -0.015 && r - b > 0.22 && value > 0.25) return 'desert'
  if (green > 0.03) return absLat > 58 ? 'tundra' : 'grassland'
  if (rugged > 0.55) return 'badlands'
  if (value > 0.28) return absLat < 32 ? 'savanna' : 'steppe'
  if (absLat > 50) return 'taiga'
  if (value < 0.18) return absLat < 30 ? 'rainforest' : 'forest'
  return 'steppe'
}
