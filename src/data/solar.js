/**
 * Solar geometry. No network, no data files — just enough astronomy to put the
 * terminator where it actually is and tell a tile what time the sun thinks it is.
 *
 * Accurate to roughly a minute of time and a tenth of a degree of declination,
 * which is far better than a 200 km hexagon can express.
 */

const DEG = Math.PI / 180
const DAY_MS = 86400000
const TROPICAL_YEAR = 365.2422
/** Day-of-year of the December solstice, the zero point of the season angle. */
const DECEMBER_SOLSTICE_DOY = 355

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  return (date.getTime() - start) / DAY_MS
}

/** Fractional UTC hours. */
export function utcHours(date) {
  return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
}

/**
 * Equation of time, in minutes. The difference between sundial and clock, caused
 * by the orbit being elliptical and the axis being tilted.
 */
export function equationOfTime(date) {
  const b = (2 * Math.PI * (dayOfYear(date) - 81)) / 364
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b)
}

/** Solar declination in degrees: the latitude the sun is overhead. */
export function declination(date) {
  const b = (2 * Math.PI * (dayOfYear(date) + 10)) / TROPICAL_YEAR
  return -23.44 * Math.cos(b)
}

/** Longitude the sun is directly over, in degrees east. */
export function subsolarLongitude(date) {
  const solar = utcHours(date) + equationOfTime(date) / 60
  return (((180 - solar * 15) + 540) % 360) - 180
}

/**
 * Sun azimuth for a date, in degrees, with the sun in the equatorial plane.
 *
 * With a fixed axial tilt and the sun at zero elevation, the azimuth alone fixes
 * the subsolar latitude: sin(declination) = -sin(tilt) * cos(azimuth). Azimuth 0
 * is the December solstice, 180 the June one. So "season" and "sun azimuth" are
 * the same control, and this app only has the one.
 */
export function seasonAngle(date) {
  const doy = dayOfYear(date)
  return (((doy - DECEMBER_SOLSTICE_DOY) % TROPICAL_YEAR + TROPICAL_YEAR) % TROPICAL_YEAR)
    / TROPICAL_YEAR * 360
}

/**
 * Spin angle that brings the subsolar point round to face the sun.
 *
 * Scene graph is tilt(Z, obliquity) -> spin(Y, this), and the sun sits at
 * azimuth `seasonAngle(date)` with zero elevation. Rotating about Y leaves
 * latitude alone, so only the longitude has to be solved: undo the tilt, then
 * match the two azimuths in the XZ plane.
 */
export function spinAngleFor(date, tiltDeg) {
  const azimuth = seasonAngle(date) * DEG
  const tilt = tiltDeg * DEG
  const lon = subsolarLongitude(date) * DEG

  // Sun direction in world space, then rotated back out of the tilt.
  const d = [Math.cos(azimuth), 0, -Math.sin(azimuth)]
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  const q = [d[0] * ct + d[1] * st, -d[0] * st + d[1] * ct, d[2]]

  // A surface point at longitude L sits at azimuth -L, and Ry(s) subtracts s.
  return ((-lon - Math.atan2(q[2], q[0])) / DEG + 540) % 360 - 180
}

/** Local mean solar time at a longitude, as fractional hours 0..24. */
export function solarTime(date, lon) {
  const h = utcHours(date) + lon / 15 + equationOfTime(date) / 60
  return ((h % 24) + 24) % 24
}

export function formatHours(hours) {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  const carry = m === 60
  return `${String(carry ? (h + 1) % 24 : h).padStart(2, '0')}:${String(carry ? 0 : m).padStart(2, '0')}`
}

/**
 * Hours of daylight at a latitude on a date. Returns 24 or 0 inside the polar
 * day and night, where the sunrise equation has no solution.
 */
export function dayLength(date, lat) {
  const d = declination(date) * DEG
  const p = lat * DEG
  const cosH = -Math.tan(p) * Math.tan(d)
  if (cosH <= -1) return 24
  if (cosH >= 1) return 0
  return (2 * Math.acos(cosH) * 180 / Math.PI) / 15
}

/** Sun altitude above the horizon right now, in degrees. */
export function sunAltitude(date, lat, lon) {
  const d = declination(date) * DEG
  const p = lat * DEG
  const hourAngle = (solarTime(date, lon) - 12) * 15 * DEG
  return Math.asin(
    Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(hourAngle),
  ) / DEG
}

/** UTC offset as the familiar +05:30 / -08:00 string. */
export function formatOffset(hours) {
  if (!Number.isFinite(hours)) return null
  const sign = hours < 0 ? '-' : '+'
  const abs = Math.abs(hours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
