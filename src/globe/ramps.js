/**
 * Colour ramps for the thematic views.
 *
 * Each ramp is a list of [stop, r, g, b] with stops in 0..1 and channels in
 * 0..255; `sample` walks them linearly. Keeping them as data rather than code
 * means a new view is a new array, not a new branch.
 */

/** Hypsometric bathymetry: shelf to trench. Sea level at 0, 11 km at 1. */
export const DEPTH = [
  [0.000, 158, 224, 236],
  [0.011, 108, 196, 222],
  [0.055, 68, 160, 204],
  [0.137, 47, 128, 184],
  [0.256, 35, 104, 166],
  [0.366, 28, 86, 148],
  [0.476, 23, 70, 128],
  [0.594, 18, 55, 106],
  [0.732, 14, 42, 84],
  [1.000, 9, 27, 58],
]

/** Land hypsometry: lowland green to peak white. 0 at sea level, 1 at 9500 m. */
export const ELEVATION = [
  [0.000, 86, 140, 96],
  [0.060, 140, 172, 100],
  [0.130, 191, 186, 108],
  [0.230, 198, 156, 96],
  [0.360, 176, 124, 90],
  [0.520, 148, 108, 96],
  [0.680, 168, 160, 158],
  [0.840, 218, 220, 224],
  [1.000, 255, 255, 255],
]

/** Population density, applied to the log-encoded byte. */
export const POPULATION = [
  [0.000, 22, 30, 42],
  [0.140, 34, 62, 78],
  [0.300, 40, 110, 110],
  [0.460, 96, 162, 90],
  [0.600, 196, 190, 74],
  [0.760, 232, 138, 48],
  [0.880, 236, 78, 52],
  [1.000, 255, 236, 200],
]

/** Night lights: the familiar sodium-to-white city glow. */
export const LIGHTS = [
  [0.000, 12, 16, 26],
  [0.100, 38, 30, 24],
  [0.260, 104, 66, 22],
  [0.460, 176, 116, 34],
  [0.680, 230, 182, 80],
  [1.000, 255, 248, 218],
]

/** Interpolate a ramp at t in 0..1. Writes into `out` as 0..1 floats. */
export function sample(ramp, t, out) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t
  let i = 1
  while (i < ramp.length - 1 && ramp[i][0] < x) i++
  const a = ramp[i - 1]
  const b = ramp[i]
  const span = b[0] - a[0]
  const f = span > 0 ? (x - a[0]) / span : 0
  out[0] = (a[1] + (b[1] - a[1]) * f) / 255
  out[1] = (a[2] + (b[2] - a[2]) * f) / 255
  out[2] = (a[3] + (b[3] - a[3]) * f) / 255
  return out
}
