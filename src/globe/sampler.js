/**
 * Loads the baked equirectangular lookups and resolves per-tile facts from them.
 *
 * Everything here runs once per rebuild, over every tile, so it is written as
 * flat loops over typed arrays rather than as per-tile objects.
 */
import { BIOMES, CLASS, classify, decodeClass } from './biomes.js'
import { DEPTH, sample } from './ramps.js'

const EARTH_RADIUS_KM = 6371
const DEEPEST_M = 10935        // bottom of the NASA/GEBCO bathymetry ramp
const MAX_DENSITY = 40000      // people/km^2 at the top of the log encoding
const MAX_PLATE_KM = 2000      // plate-boundary distance saturates here
const ELEVATION_MAX_M = 9500   // top of the NASA/GEBCO elevation ramp

const RASTERS = {
  color: 'earth-color.jpg',
  data: 'earth-data.png',
  relief: 'earth-relief.png',
  regions: 'earth-regions.png',
  strata: 'earth-strata.png',
}

async function readPixels(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  const bitmap = await createImageBitmap(await response.blob())
  // Read the dimensions out before close(); closing an ImageBitmap zeroes them.
  const width = bitmap.width
  const height = bitmap.height
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  bitmap.close()
  return { data, width, height }
}

/**
 * Unit vector -> equirectangular pixel index. Longitude wraps, latitude clamps.
 *
 * The +X = 0 deg, -Z = 90 deg E convention matches THREE.SphereGeometry's own UV
 * layout, so a plain equirectangular texture and these lookups agree.
 */
function texelAt(raster, x, y, z) {
  const u = (Math.atan2(-z, x) / (2 * Math.PI)) + 0.5
  const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI
  let px = Math.floor(u * raster.width)
  let py = Math.floor(v * raster.height)
  px = ((px % raster.width) + raster.width) % raster.width
  py = Math.max(0, Math.min(raster.height - 1, py))
  return (py * raster.width + px) * 4
}

export function toLatLon(x, y, z) {
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI,
    lon: Math.atan2(-z, x) * 180 / Math.PI,
  }
}

export function toVector(lat, lon) {
  const a = lat * Math.PI / 180
  const o = lon * Math.PI / 180
  const c = Math.cos(a)
  return [c * Math.cos(o), Math.sin(a), -c * Math.sin(o)]
}

/** Decode the log-encoded population byte back to people per square kilometre. */
function decodeDensity(byte) {
  return Math.expm1((byte / 255) * Math.log1p(MAX_DENSITY))
}

export class EarthSampler {
  constructor(rasters, tables) {
    Object.assign(this, rasters)
    this.regionTable = tables.regions
    this.plateTable = tables.plates
    this.cities = tables.cities
  }

  static async load(base = './') {
    const prefix = base.endsWith('/') ? base : base + '/'
    const names = Object.keys(RASTERS)
    const [pixels, regions, plates, cities] = await Promise.all([
      Promise.all(names.map((n) => readPixels(prefix + RASTERS[n]))),
      fetch(prefix + 'earth-regions.json').then((r) => r.json()),
      fetch(prefix + 'earth-plates.json').then((r) => r.json()),
      fetch(prefix + 'earth-cities.json').then((r) => r.json()),
    ])
    const rasters = Object.fromEntries(names.map((n, i) => [n, pixels[i]]))
    return new EarthSampler(rasters, { regions, plates, cities })
  }

  regionAt(x, y, z) {
    const i = texelAt(this.regions, x, y, z)
    const id = this.regions.data[i] | (this.regions.data[i + 1] << 8)
    return id ? this.regionTable[id] ?? null : null
  }

  plateAt(x, y, z) {
    const i = texelAt(this.strata, x, y, z)
    const plate = this.plateTable[this.strata.data[i]] ?? null
    return plate && { ...plate, boundaryKm: (this.strata.data[i + 1] / 255) * MAX_PLATE_KM }
  }

  /**
   * Largest settlement whose centre falls inside a cap of `radiusKm` around a
   * point. The table is sorted by population, so the first hit is the answer.
   */
  largestCityWithin(lat, lon, radiusKm) {
    const [cx, cy, cz] = toVector(lat, lon)
    const cosLimit = Math.cos(radiusKm / EARTH_RADIUS_KM)
    for (const row of this.cities.rows) {
      const [, clat, clon] = row
      const [x, y, z] = toVector(clat, clon)
      if (x * cx + y * cy + z * cz >= cosLimit) {
        return { name: row[0], lat: clat, lon: clon, population: row[3], country: row[4], capital: !!row[5] }
      }
    }
    return null
  }

  /**
   * Resolve every tile in one pass.
   *
   * Each tile is sampled across its own footprint — the centre plus two rings
   * inside its corners — because at low subdivision a tile spans several degrees
   * and a single texel would let one river or one cloud decide the whole hexagon.
   */
  resolve({ tileCount, centers, corners, cornerStart, sides }) {
    const keys = Object.keys(BIOMES)
    const keyIndex = new Map(keys.map((k, i) => [k, i]))

    const biome = new Uint8Array(tileCount)
    const palette = new Float32Array(tileCount * 3)
    const satellite = new Float32Array(tileCount * 3)
    const elevation = new Float32Array(tileCount)
    const elevationPeak = new Float32Array(tileCount)
    const depth = new Float32Array(tileCount)
    const depthMax = new Float32Array(tileCount)
    const surface = new Uint8Array(tileCount)
    const lights = new Float32Array(tileCount)
    const density = new Float32Array(tileCount)
    const population = new Float32Array(tileCount)
    const areaKm2 = new Float32Array(tileCount)
    const koppen = new Uint8Array(tileCount)
    const plate = new Uint8Array(tileCount)
    const plateKm = new Float32Array(tileCount)
    const timezone = new Float32Array(tileCount)

    const paletteRgb = keys.map((k) => {
      const c = BIOMES[k].color
      return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]
    })

    const RINGS = [0.42, 0.78]
    const classVotes = new Uint16Array(4)
    const koppenVotes = new Uint16Array(31)
    const rgbOut = [0, 0, 0]

    for (let t = 0; t < tileCount; t++) {
      const cx = centers[t * 3]
      const cy = centers[t * 3 + 1]
      const cz = centers[t * 3 + 2]
      const begin = cornerStart[t]
      const n = sides[t]

      let sr = 0, sg = 0, sb = 0, samples = 0
      let elevSum = 0, rugSum = 0, depthSum = 0, lightSum = 0, densitySum = 0
      let elevPeak = 0, deepest = 0
      let plateId = 0, plateDist = 0, tzIndex = 0
      classVotes.fill(0)
      koppenVotes.fill(0)

      const accumulate = (x, y, z) => {
        const k = 1 / Math.hypot(x, y, z)
        x *= k; y *= k; z *= k
        const ci = texelAt(this.color, x, y, z)
        sr += this.color.data[ci]
        sg += this.color.data[ci + 1]
        sb += this.color.data[ci + 2]
        const di = texelAt(this.data, x, y, z)
        classVotes[decodeClass(this.data.data[di])]++
        elevSum += this.data.data[di + 1]
        if (this.data.data[di + 1] > elevPeak) elevPeak = this.data.data[di + 1]
        rugSum += this.data.data[di + 2]
        const ri = texelAt(this.relief, x, y, z)
        depthSum += this.relief.data[ri]
        if (this.relief.data[ri] > deepest) deepest = this.relief.data[ri]
        lightSum += this.relief.data[ri + 1]
        densitySum += decodeDensity(this.relief.data[ri + 2])
        koppenVotes[this.regions.data[texelAt(this.regions, x, y, z) + 2]]++
        samples++
      }

      accumulate(cx, cy, cz)
      for (const f of RINGS) {
        for (let k = 0; k < n; k++) {
          const c = (begin + k) * 3
          accumulate(
            cx + (corners[c] - cx) * f,
            cy + (corners[c + 1] - cy) * f,
            cz + (corners[c + 2] - cz) * f,
          )
        }
      }

      // Plate, timezone and region come from the centre alone: they are
      // administrative-style lookups where a majority vote over the footprint
      // would just blur the boundary the user is trying to read.
      const si = texelAt(this.strata, cx, cy, cz)
      plateId = this.strata.data[si]
      plateDist = (this.strata.data[si + 1] / 255) * MAX_PLATE_KM
      tzIndex = this.strata.data[si + 2]

      const inv = 1 / (samples * 255)
      const rgb = [sr * inv, sg * inv, sb * inv]
      const elev = elevSum / (samples * 255)
      const rugged = rugSum / (samples * 255)

      // Land is the minority surface almost everywhere, so a plain majority vote
      // erodes coastlines and small islands. Let land win on a third of the votes.
      let cls = CLASS.OCEAN
      let best = classVotes[CLASS.OCEAN]
      if (classVotes[CLASS.LAND] * 3 >= samples) { cls = CLASS.LAND; best = classVotes[CLASS.LAND] }
      if (classVotes[CLASS.ICE] * 3 >= samples && classVotes[CLASS.ICE] >= best) cls = CLASS.ICE
      if (classVotes[CLASS.LAKE] > samples * 0.5) cls = CLASS.LAKE

      let topKoppen = 0
      for (let k = 1; k <= 30; k++) if (koppenVotes[k] > koppenVotes[topKoppen]) topKoppen = k

      const absLat = Math.abs(Math.asin(Math.max(-1, Math.min(1, cy))) * 180 / Math.PI)
      const key = classify(cls, rgb, elev, rugged, absLat)
      const bi = keyIndex.get(key)
      const metres = (depthSum / samples / 255) * DEEPEST_M

      // Spherical area, as the fan of triangles from the tile centre. On a unit
      // sphere the planar and spherical areas agree to about one part in 10^4 at
      // these tile sizes, which is far inside the population data's own error.
      let area = 0
      for (let k = 0; k < n; k++) {
        const a = (begin + k) * 3
        const b = (begin + (k + 1) % n) * 3
        const e1 = [corners[a] - cx, corners[a + 1] - cy, corners[a + 2] - cz]
        const e2 = [corners[b] - cx, corners[b + 1] - cy, corners[b + 2] - cz]
        area += 0.5 * Math.hypot(
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        )
      }
      area *= EARTH_RADIUS_KM * EARTH_RADIUS_KM

      biome[t] = bi
      surface[t] = cls
      elevation[t] = elev
      elevationPeak[t] = elevPeak / 255
      depth[t] = cls === CLASS.OCEAN ? metres : 0
      depthMax[t] = cls === CLASS.OCEAN ? (deepest / 255) * DEEPEST_M : 0
      lights[t] = lightSum / (samples * 255)
      density[t] = densitySum / samples
      areaKm2[t] = area
      population[t] = density[t] * area
      koppen[t] = topKoppen
      plate[t] = plateId
      plateKm[t] = plateDist
      timezone[t] = tzIndex ? (tzIndex - 1) / 4 - 12 : NaN
      satellite[t * 3] = rgb[0]
      satellite[t * 3 + 1] = rgb[1]
      satellite[t * 3 + 2] = rgb[2]

      // Water takes its colour from measured depth rather than from how blue the
      // satellite pixel happens to be; that is the whole point of carrying a
      // bathymetry channel. Ice-covered sea keeps the biome palette.
      if ((cls === CLASS.OCEAN || cls === CLASS.LAKE) && key !== 'seaIce') {
        sample(DEPTH, metres / DEEPEST_M, rgbOut)
        palette[t * 3] = rgbOut[0]
        palette[t * 3 + 1] = rgbOut[1]
        palette[t * 3 + 2] = rgbOut[2]
      } else {
        palette[t * 3] = paletteRgb[bi][0]
        palette[t * 3 + 1] = paletteRgb[bi][1]
        palette[t * 3 + 2] = paletteRgb[bi][2]
      }
    }

    return {
      biome, palette, satellite, elevation, elevationPeak, depth, depthMax,
      surface, lights, density, population, areaKm2, koppen, plate, plateKm,
      timezone, keys,
      constants: { EARTH_RADIUS_KM, DEEPEST_M, ELEVATION_MAX_M, MAX_DENSITY, MAX_PLATE_KM },
    }
  }
}

export { EARTH_RADIUS_KM, DEEPEST_M, ELEVATION_MAX_M, MAX_DENSITY }
