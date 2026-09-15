/**
 * Thematic colouring. Each mode turns the resolved per-tile attributes into one
 * RGB triple per tile; the mesh never knows which view it is drawing.
 */
import { KOPPEN } from './koppen.js'
import { DEPTH, ELEVATION, LIGHTS, POPULATION, sample } from './ramps.js'
import { DEEPEST_M, MAX_DENSITY } from './sampler.js'

export const MODES = [
  { value: 'natural', label: 'Land cover' },
  { value: 'climate', label: 'Köppen climate' },
  { value: 'relief', label: 'Elevation & depth' },
  { value: 'population', label: 'Population' },
  { value: 'lights', label: 'Night lights' },
  { value: 'plates', label: 'Tectonic plates' },
]

const DRY_WATER = [0.043, 0.071, 0.106]   // water in the land-focused views
const NO_DATA = [0.13, 0.14, 0.16]

/** Stable, well-spread categorical colour for an integer id. */
function categorical(id, out) {
  const hue = (id * 0.381966) % 1              // golden angle, so neighbours differ
  const s = 0.52
  const v = id % 3 === 0 ? 0.78 : id % 3 === 1 ? 0.62 : 0.9
  const i = Math.floor(hue * 6)
  const f = hue * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const table = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]]
  const rgb = table[i % 6]
  out[0] = rgb[0]; out[1] = rgb[1]; out[2] = rgb[2]
  return out
}

/**
 * @param {object} attrs   output of EarthSampler.resolve
 * @param {{mode: string, blend: number}} opts  blend only applies to 'natural'
 * @returns {Float32Array} three floats per tile
 */
export function buildTileColors(attrs, { mode, blend }) {
  const { surface, palette, satellite, elevation, depth, lights, density, koppen, plate } = attrs
  const count = surface.length
  const out = new Float32Array(count * 3)
  const rgb = [0, 0, 0]
  const logMax = Math.log1p(MAX_DENSITY)

  for (let t = 0; t < count; t++) {
    const water = surface[t] === 0 || surface[t] === 1
    let r, g, b

    switch (mode) {
      case 'climate': {
        const k = KOPPEN[koppen[t]]
        if (k) {
          r = (k.color >> 16 & 255) / 255
          g = (k.color >> 8 & 255) / 255
          b = (k.color & 255) / 255
        } else {
          [r, g, b] = water ? DRY_WATER : NO_DATA
        }
        break
      }
      case 'relief': {
        sample(water ? DEPTH : ELEVATION, water ? depth[t] / DEEPEST_M : elevation[t], rgb)
        ;[r, g, b] = rgb
        break
      }
      case 'population': {
        if (water) { [r, g, b] = DRY_WATER; break }
        sample(POPULATION, Math.log1p(density[t]) / logMax, rgb)
        ;[r, g, b] = rgb
        break
      }
      case 'lights': {
        // Night lights are extremely skewed — 2% of the planet is lit at all, and
        // a city is 200x a village. The square root lifts small towns out of the
        // floor without letting the metros clip.
        sample(LIGHTS, Math.sqrt(lights[t]), rgb)
        ;[r, g, b] = rgb
        break
      }
      case 'plates': {
        if (!plate[t]) { [r, g, b] = NO_DATA; break }
        categorical(plate[t], rgb)
        ;[r, g, b] = rgb
        break
      }
      default: {
        // Natural: the stylised palette, cross-faded toward the raw satellite
        // average. Water already carries its bathymetric colour from the sampler.
        const k = blend
        r = palette[t * 3] + (satellite[t * 3] - palette[t * 3]) * k
        g = palette[t * 3 + 1] + (satellite[t * 3 + 1] - palette[t * 3 + 1]) * k
        b = palette[t * 3 + 2] + (satellite[t * 3 + 2] - palette[t * 3 + 2]) * k
      }
    }

    out[t * 3] = r
    out[t * 3 + 1] = g
    out[t * 3 + 2] = b
  }
  return out
}
