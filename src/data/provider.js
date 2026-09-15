/**
 * Where a tile turns into content.
 *
 * Every source here is keyless and CORS-open, so the whole thing runs from a
 * static bundle with no backend. Each lookup is independent and returns its own
 * promise, which lets the inspector paint sections as they land instead of
 * waiting on the slowest one.
 *
 * Failures are values, not exceptions: a section that cannot load says so and
 * the rest of the card still renders.
 */

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const WIKI_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/'
const WDQS = 'https://query.wikidata.org/sparql'
const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
const GBIF = 'https://api.gbif.org/v1/occurrence/search'
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive'
const OPEN_METEO_MARINE = 'https://marine-api.open-meteo.com/v1/marine'
const OPEN_METEO_AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality'

/** Years of ERA5 averaged into the "recent normals" block. */
const NORMAL_YEARS = 10

let newsBackend = null

/**
 * Optional: point this at your own backend to add a news section.
 *
 * @param {(q: {lat:number, lon:number, radiusKm:number, region:object|null}) =>
 *          Promise<Array<{title:string, summary:string, url:string, published:string}>>} fn
 */
export function configureNews(fn) {
  newsBackend = fn
}

export function hasNews() {
  return typeof newsBackend === 'function'
}

/** Statuses worth one retry: the service is up but busy, not wrong. */
const TRANSIENT = new Set([429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function getJson(url, { service = 'Source', retries = 0, ...init } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.ok) return res.json()
    if (attempt < retries && TRANSIENT.has(res.status)) {
      await sleep(900 * (attempt + 1))
      continue
    }
    throw new Error(TRANSIENT.has(res.status)
      ? `${service} is busy right now (${res.status}).`
      : `${service} returned ${res.status} ${res.statusText}.`)
  }
}

function query(base, params) {
  const url = new URL(base)
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Great-circle distance in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Points to probe inside one tile: the centre, then a ring at half-radius. */
function probePoints(lat, lon, radiusKm) {
  const points = [[lat, lon]]
  if (radiusKm < 20) return points
  const spread = Math.min(radiusKm * 0.55, 400)
  for (let k = 0; k < 6; k++) {
    const bearing = (k * Math.PI) / 3
    const dLat = (spread / 111) * Math.cos(bearing)
    const cosLat = Math.max(0.12, Math.cos((lat * Math.PI) / 180))
    const dLon = (spread / (111 * cosLat)) * Math.sin(bearing)
    const nextLat = lat + dLat
    if (Math.abs(nextLat) < 89) points.push([nextLat, ((lon + dLon + 540) % 360) - 180])

  }
  return points
}

// ------------------------------------------------------------------ wikipedia

async function geosearch(lat, lon, radiusM, limit) {
  const body = await getJson(query(WIKI_API, {
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat.toFixed(5)}|${lon.toFixed(5)}`,
    gsradius: String(Math.min(10000, Math.round(radiusM))),
    gslimit: String(limit),
    format: 'json',
    origin: '*',
  }), { service: 'Wikipedia' })
  return body?.query?.geosearch ?? []
}

export async function summarise(title) {
  try {
    const body = await getJson(WIKI_REST + encodeURIComponent(title.replace(/ /g, '_')),
      { service: 'Wikipedia' })
    return {
      title: body.title,
      summary: body.extract ?? '',
      url: body.content_urls?.desktop?.page
        ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      thumb: body.thumbnail?.source ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Articles anchored inside the hexagon.
 *
 * Geosearch is hard-capped at a 10 km radius while a default tile is 340 km
 * across, so one probe at the centre finds nothing anywhere rural. Probing a
 * ring covers far more of the tile for the same wall-clock time.
 */
async function nearbyArticles(lat, lon, radiusKm) {
  const probes = probePoints(lat, lon, radiusKm)
  const batches = await Promise.all(
    probes.map(([a, o]) => geosearch(a, o, 10000, 6).catch(() => [])),
  )
  const seen = new Set()
  const hits = []
  for (const batch of batches) {
    for (const hit of batch) {
      if (seen.has(hit.pageid)) continue
      seen.add(hit.pageid)
      hits.push(hit)
    }
  }
  // geosearch reports distance from whichever probe found the article, so
  // re-measure from the tile centre before ranking.
  for (const hit of hits) hit.centreKm = haversineKm(lat, lon, hit.lat, hit.lon)
  hits.sort((a, b) => a.centreKm - b.centreKm)

  const picked = hits.slice(0, 6)
  const detailed = await Promise.all(picked.map((h) => summarise(h.title)))
  return {
    items: detailed
      .map((d, i) => (d ? { ...d, distanceKm: picked[i].centreKm } : null))
      .filter(Boolean),
    probes: probes.length,
  }
}

// -------------------------------------------------------------------- wikidata

const AROUND = `SERVICE wikibase:around {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point(%LON% %LAT%)"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "%R%" .
  }`

/**
 * The public WDQS endpoint sheds load with 429s and 502s under pressure, often
 * enough that a single retry is the difference between a timeline and an error.
 */
async function sparql(text) {
  const body = await getJson(query(WDQS, { query: text, format: 'json' }), {
    service: 'Wikidata',
    retries: 1,
    headers: { Accept: 'application/sparql-results+json' },
  })
  return body?.results?.bindings ?? []
}

const QID = /^Q\d+$/

/**
 * Dated events on this ground, from Wikidata's geospatial index.
 *
 * P585 ("point in time") is what separates this from the article search: it
 * returns things that *happened* here, with a date to sort them by, rather than
 * things that merely *are* here.
 *
 * Split into two queries on purpose. Asking for the type and the Wikipedia
 * sitelink inside the geospatial query costs 10 s over a dense area; finding the
 * events first and then looking those few up by id costs about 2 s for the same
 * answer.
 */
async function timeline(lat, lon, radiusKm) {
  const around = AROUND
    .replace('%LON%', clamp(lon, -180, 180).toFixed(4))
    .replace('%LAT%', clamp(lat, -89.9, 89.9).toFixed(4))
    .replace('%R%', String(Math.max(15, Math.min(250, Math.round(radiusKm)))))

  const rows = await sparql(`SELECT ?item ?itemLabel ?when WHERE {
  ${around}
  ?item wdt:P585 ?when .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?when
LIMIT 60`)

  const events = new Map()
  for (const row of rows) {
    const uri = row.item?.value
    const label = row.itemLabel?.value
    // An unlabelled item comes back as its own QID, which is no use to a reader.
    if (!uri || !label || QID.test(label) || events.has(uri)) continue
    const when = row.when?.value ?? ''
    const negative = when.startsWith('-')
    const year = negative ? -parseInt(when.slice(1, 5), 10) : parseInt(when.slice(0, 4), 10)
    if (!Number.isFinite(year)) continue
    const rest = when.slice(negative ? 6 : 5, negative ? 11 : 10)
    events.set(uri, {
      id: uri.slice(uri.lastIndexOf('/') + 1),
      label,
      year,
      month: rest,
      kind: null,
      url: uri,
    })
  }
  if (!events.size) return []

  const ids = [...events.values()].map((e) => `wd:${e.id}`).join(' ')
  const detail = await sparql(`SELECT ?item ?typeLabel ?article WHERE {
  VALUES ?item { ${ids} }
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}`).catch(() => [])

  for (const row of detail) {
    const event = events.get(row.item?.value)
    if (!event) continue
    if (!event.kind && row.typeLabel?.value && !QID.test(row.typeLabel.value)) {
      event.kind = row.typeLabel.value
    }
    if (row.article?.value) event.url = row.article.value
  }

  return [...events.values()].sort((a, b) => a.year - b.year)
}

// ------------------------------------------------------------------ earthquakes

/**
 * Recorded quakes under this tile since 1900.
 *
 * FDSNWS silently defaults to the last 30 days, which is why a naive query over
 * Tokyo comes back empty; an explicit starttime is what makes it a history.
 */
async function earthquakes(lat, lon, radiusKm) {
  const minMagnitude = radiusKm > 200 ? 5.5 : radiusKm > 90 ? 5 : 4.2
  const body = await getJson(query(USGS, {
    format: 'geojson',
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    maxradiuskm: Math.max(10, Math.round(radiusKm)),
    minmagnitude: minMagnitude,
    starttime: '1900-01-01',
    orderby: 'magnitude',
    limit: 6,
  }), { service: 'USGS' })
  const events = (body.features ?? []).map((f) => ({
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: f.properties.time,
    depthKm: f.geometry?.coordinates?.[2] ?? null,
    url: f.properties.url,
  }))
  return { events, minMagnitude }
}

// -------------------------------------------------------------------- species

const AUTHORSHIP = /\s*\(?[A-ZÀ-Þ][\wÀ-ÿ.'-]*(?:\s*&\s*[\w.'-]+)*,?\s*\d{4}\)?\s*$/

/**
 * Most-recorded species inside the tile's bounding box, from GBIF.
 *
 * The box is clamped rather than wrapped: GBIF rejects a latitude past the pole
 * or a longitude past the antimeridian with a 400, and a polar tile would
 * otherwise produce one on every click.
 */
async function species(lat, lon, radiusKm) {
  const dLat = Math.min(radiusKm / 111, 8)
  const dLon = Math.min(radiusKm / (111 * Math.max(0.1, Math.cos(lat * Math.PI / 180))), 20)
  const body = await getJson(query(GBIF, {
    decimalLatitude: `${clamp(lat - dLat, -90, 90).toFixed(3)},${clamp(lat + dLat, -90, 90).toFixed(3)}`,
    decimalLongitude: `${clamp(lon - dLon, -180, 180).toFixed(3)},${clamp(lon + dLon, -180, 180).toFixed(3)}`,
    hasCoordinate: 'true',
    limit: '0',
    facet: 'scientificName',
    facetLimit: '14',
  }), { service: 'GBIF' })
  const counts = body?.facets?.[0]?.counts ?? []
  const items = counts
    // Facet values include higher taxa ("Animalia", "Aves") alongside binomials;
    // only the two-part names are actual species.
    .map((c) => ({ name: c.name.replace(AUTHORSHIP, '').trim(), records: c.count }))
    .filter((c) => c.name.split(' ').length >= 2)
    .slice(0, 6)
  return { items, total: body?.count ?? 0 }
}

// -------------------------------------------------------------------- weather

const WEATHER_CODES = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
  65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
  73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers',
  81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers',
  86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
}

async function conditions(lat, lon) {
  const [weather, air] = await Promise.allSettled([
    getJson(query(OPEN_METEO, {
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'UTC',
      current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    }), { service: 'Open-Meteo' }),
    getJson(query(OPEN_METEO_AIR, {
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'UTC',
      current: 'pm2_5,european_aqi',
    }), { service: 'Open-Meteo' }),
  ])
  const w = weather.status === 'fulfilled' ? weather.value.current : null
  const a = air.status === 'fulfilled' ? air.value.current : null
  if (!w) throw new Error('weather unavailable')
  return {
    temperatureC: w.temperature_2m,
    humidity: w.relative_humidity_2m,
    windKph: w.wind_speed_10m,
    description: WEATHER_CODES[w.weather_code] ?? null,
    isDay: !!w.is_day,
    pm25: a?.pm2_5 ?? null,
    aqi: a?.european_aqi ?? null,
  }
}

async function marine(lat, lon) {
  const body = await getJson(query(OPEN_METEO_MARINE, {
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'UTC',
    current: 'wave_height,wave_period,wave_direction,sea_surface_temperature,ocean_current_velocity',
  }), { service: 'Open-Meteo Marine' })
  const c = body.current ?? {}
  // The marine model answers for land points too, with nulls; treat that as
  // "no data" rather than rendering a wave height of nothing.
  if (c.wave_height == null && c.sea_surface_temperature == null) return null
  return {
    waveHeightM: c.wave_height,
    wavePeriodS: c.wave_period,
    waveDirection: c.wave_direction,
    seaTempC: c.sea_surface_temperature,
    currentKph: c.ocean_current_velocity,
  }
}

/**
 * Recent climate normals from the ERA5 reanalysis.
 *
 * Open-Meteo has no monthly aggregation, so this pulls daily values for the last
 * ten complete years (~80 KB) and reduces them here. Ten years is a decade of
 * weather, not a WMO 30-year normal, and the UI says so.
 */
async function climate(lat, lon) {
  const end = new Date()
  const lastYear = end.getUTCFullYear() - 1
  const body = await getJson(query(OPEN_METEO_ARCHIVE, {
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'UTC',
    start_date: `${lastYear - NORMAL_YEARS + 1}-01-01`,
    end_date: `${lastYear}-12-31`,
    daily: 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum',
  }), { service: 'Open-Meteo' })
  const daily = body.daily ?? {}
  const times = daily.time ?? []
  const mean = daily.temperature_2m_mean ?? []
  const max = daily.temperature_2m_max ?? []
  const min = daily.temperature_2m_min ?? []
  const rain = daily.precipitation_sum ?? []
  if (!times.length) throw new Error('no reanalysis for this point')

  const monthMean = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }))
  let tSum = 0, tN = 0, rainSum = 0, hottest = -Infinity, coldest = Infinity
  for (let i = 0; i < times.length; i++) {
    const m = Number(times[i].slice(5, 7)) - 1
    if (Number.isFinite(mean[i])) {
      monthMean[m].sum += mean[i]
      monthMean[m].n++
      tSum += mean[i]
      tN++
    }
    if (Number.isFinite(rain[i])) rainSum += rain[i]
    if (Number.isFinite(max[i])) hottest = Math.max(hottest, max[i])
    if (Number.isFinite(min[i])) coldest = Math.min(coldest, min[i])
  }
  const months = monthMean.map((m) => (m.n ? m.sum / m.n : null))
  const valid = months.filter((m) => m != null)
  return {
    years: NORMAL_YEARS,
    from: lastYear - NORMAL_YEARS + 1,
    to: lastYear,
    annualMeanC: tN ? tSum / tN : null,
    annualRainMm: rainSum / NORMAL_YEARS,
    warmestMonthC: valid.length ? Math.max(...valid) : null,
    coldestMonthC: valid.length ? Math.min(...valid) : null,
    recordHighC: Number.isFinite(hottest) ? hottest : null,
    recordLowC: Number.isFinite(coldest) ? coldest : null,
    months,
  }
}

// ----------------------------------------------------------------------- entry

/**
 * Start every lookup for a tile at once.
 *
 * Returns promises rather than awaiting them so the caller can render each
 * section the moment it resolves. Nothing here rejects: every section settles to
 * either data or `{ error }`.
 *
 * @param {{lat:number, lon:number, radiusKm:number, region:object|null,
 *          isWater:boolean}} tile
 */
export function startLookup({ lat, lon, radiusKm, region, isWater }) {
  const guard = (promise) => promise.catch((err) => ({ error: err.message || String(err) }))

  return {
    region: guard(region?.name ? summarise(region.name) : Promise.resolve(null)),
    articles: guard(nearbyArticles(lat, lon, radiusKm)),
    timeline: guard(timeline(lat, lon, radiusKm)),
    quakes: guard(earthquakes(lat, lon, radiusKm)),
    species: guard(species(lat, lon, radiusKm)),
    conditions: guard(conditions(lat, lon)),
    climate: guard(isWater ? Promise.resolve(null) : climate(lat, lon)),
    marine: guard(isWater ? marine(lat, lon) : Promise.resolve(null)),
    news: guard(newsBackend
      ? Promise.resolve(newsBackend({ lat, lon, radiusKm, region }))
      : Promise.resolve(null)),
  }
}
