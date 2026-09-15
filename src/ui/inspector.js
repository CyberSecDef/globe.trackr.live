import { BIOMES } from '../globe/biomes.js'
import { KOPPEN } from '../globe/koppen.js'
import { hasNews, startLookup } from '../data/provider.js'
import {
  dayLength, formatHours, formatOffset, solarTime, sunAltitude,
} from '../data/solar.js'

const SURFACE = ['Ocean', 'Inland water', 'Land', 'Permanent ice']

const num = (v, digits = 0) => v.toLocaleString(undefined, {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
})

function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} bn`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} M`
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`
  return num(Math.round(n))
}

function coord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lon).toFixed(2)}°${ew}`
}

/**
 * Wikidata stores astronomical year numbering, where year 0 is 1 BC. Printing
 * the raw negative would put every ancient event one year early.
 */
function signedYear(year) {
  return year <= 0 ? `${1 - year} BC` : String(year)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function link(text, href, className) {
  const a = el('a', className, text)
  a.href = href
  a.target = '_blank'
  a.rel = 'noreferrer noopener'
  return a
}

/** Twelve monthly means as a small inline chart. */
function monthlyChart(months) {
  const values = months.filter((m) => m != null)
  if (values.length < 12) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = Math.max(1, hi - lo)
  const W = 236
  const H = 40
  const step = W / 12

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'insp-spark')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label',
    `Monthly mean temperature, ${lo.toFixed(1)} to ${hi.toFixed(1)} degrees Celsius`)

  months.forEach((value, i) => {
    const h = Math.max(2, ((value - lo) / span) * (H - 6) + 3)
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bar.setAttribute('x', (i * step + 1.5).toFixed(1))
    bar.setAttribute('y', (H - h).toFixed(1))
    bar.setAttribute('width', (step - 3).toFixed(1))
    bar.setAttribute('height', h.toFixed(1))
    bar.setAttribute('rx', '1.5')
    // Blue below freezing, warm above: the zero crossing is the thing you look for.
    bar.setAttribute('fill', value < 0 ? '#5aa9ff' : value < 12 ? '#57c2a8' : value < 24 ? '#d8c260' : '#e08a52')
    svg.append(bar)
  })
  return svg
}

export class Inspector {
  constructor(host) {
    this.host = host
    this.token = 0
    this.onClose = () => {}
    host.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.hide()
    })
  }

  hide() {
    this.host.hidden = true
    this.token++
    this.onClose()
  }

  /**
   * @param {object} tile everything main.js resolved locally for the tile
   */
  show(tile) {
    const token = ++this.token
    const host = this.host
    host.hidden = false
    host.scrollTop = 0
    host.replaceChildren()

    const isWater = tile.surface === 0 || tile.surface === 1
    const now = new Date()

    host.append(this.#header(tile, isWater), this.#facts(tile, isWater, now))

    const feed = el('div', 'insp-feed')
    host.append(feed)

    const tasks = startLookup({
      lat: tile.lat,
      lon: tile.lon,
      radiusKm: tile.radiusKm,
      region: tile.region,
      isWater,
    })

    /** Add a section that shows a placeholder until its promise settles. */
    const section = (title, promise, render) => {
      const wrap = el('section', 'insp-sec')
      wrap.append(el('h3', 'insp-h3', title))
      const body = el('div', 'insp-body')
      body.append(el('p', 'insp-skel', '…'))
      wrap.append(body)
      feed.append(wrap)

      promise.then((data) => {
        if (token !== this.token) return
        body.replaceChildren()
        if (data && data.error) {
          body.append(el('p', 'insp-note', data.error))
          return
        }
        const produced = render(data, body)
        if (produced === false) wrap.remove()
      })
    }

    if (isWater) {
      section('Sea state', tasks.marine, (m, body) => this.#marine(m, body))
    } else {
      section('Conditions now', tasks.conditions, (c, body) => this.#conditions(c, body))
      section(`Climate, last ${10} years`, tasks.climate, (c, body) => this.#climate(c, body))
    }
    if (isWater) {
      section('Conditions now', tasks.conditions, (c, body) => this.#conditions(c, body))
    }

    section('Timeline', tasks.timeline, (events, body) => this.#timeline(events, body))
    section('On this ground', tasks.articles, (data, body) => this.#articles(data, body))
    section('Seismic record', tasks.quakes, (data, body) => this.#quakes(data, body))
    section('Recorded life', tasks.species, (data, body) => this.#species(data, body))
    section(tile.region?.short ?? 'Region', tasks.region, (r, body) => {
      if (!r) return false
      body.append(link(r.title, r.url), el('p', null, r.summary))
      return true
    })
    if (hasNews()) {
      section('Recent news', tasks.news, (items, body) => {
        if (!items?.length) return false
        const list = el('ul', 'insp-list')
        for (const item of items) {
          const li = el('li')
          li.append(link(item.title, item.url), el('p', null, item.summary ?? ''))
          list.append(li)
        }
        body.append(list)
        return true
      })
    }
  }

  #header(tile, isWater) {
    const head = el('header', 'insp-head')
    const swatch = el('span', 'insp-swatch')
    swatch.style.background = tile.color
    const titles = el('div', 'insp-titles')
    titles.append(
      el('h2', null, tile.region?.short ?? (isWater ? 'Open water' : 'Unclaimed')),
      el('p', 'insp-sub', coord(tile.lat, tile.lon)),
    )
    const close = el('button', 'insp-close', '×')
    close.type = 'button'
    close.setAttribute('data-close', '')
    close.setAttribute('aria-label', 'Close')
    head.append(swatch, titles, close)
    return head
  }

  #facts(tile, isWater, now) {
    const facts = el('dl', 'insp-facts')
    const add = (k, v) => { if (v != null) facts.append(el('dt', null, k), el('dd', null, v)) }

    add('Surface', SURFACE[tile.surface] ?? null)
    if (isWater) {
      add('Depth', tile.depthM > 5
        ? `${num(Math.round(tile.depthM))} m mean \u00b7 ${num(Math.round(tile.depthMaxM))} m deepest`
        : 'shallow / unsurveyed')
    } else {
      add('Land cover', BIOMES[tile.biome]?.label ?? tile.biome)
      add('Elevation', tile.elevationPeakM - tile.elevationM > 80
        ? `${num(Math.round(tile.elevationM))} m mean \u00b7 ${num(Math.round(tile.elevationPeakM))} m highest`
        : `${num(Math.round(tile.elevationM))} m`)
    }

    const koppen = KOPPEN[tile.koppen]
    if (koppen) add('Climate', `${koppen.code} · ${koppen.label}`)

    if (!isWater) {
      add('Population', tile.population >= 1
        ? `${compact(tile.population)} (${num(tile.density, tile.density < 10 ? 1 : 0)}/km²)`
        : 'uninhabited')
      if (tile.city) {
        add('Largest place', `${tile.city.name}${tile.city.capital ? ' ★' : ''} · ${compact(tile.city.population)}`)
      }
    }

    if (tile.plate) {
      add('Plate', `${tile.plate.name} · ${num(Math.round(tile.plate.boundaryKm))} km to a boundary`)
    }

    const solar = solarTime(now, tile.lon)
    const altitude = sunAltitude(now, tile.lat, tile.lon)
    const civil = formatOffset(tile.timezone)
    if (civil) {
      const local = new Date(now.getTime() + tile.timezone * 3600000)
      add('Local time', `${formatHours(local.getUTCHours() + local.getUTCMinutes() / 60)} · ${civil}`)
    }
    add('Sun', `${Math.abs(altitude).toFixed(0)}° ${altitude > 0 ? 'above' : 'below'} the horizon · solar time ${formatHours(solar)}`)
    add('Daylight', `${dayLength(now, tile.lat).toFixed(1)} h today`)

    add('Tile', `#${tile.index} · ${tile.sides === 5 ? 'pentagon' : 'hexagon'} · ${num(Math.round(tile.radiusKm * 2))} km across · ${compact(tile.areaKm2)} km²`)
    return facts
  }

  #conditions(c, body) {
    if (!c) return false
    const line = [
      `${c.temperatureC?.toFixed(1)}°C`,
      c.description,
      `wind ${c.windKph?.toFixed(0)} km/h`,
      c.humidity != null ? `${c.humidity}% RH` : null,
    ].filter(Boolean).join(' · ')
    body.append(el('p', 'insp-line', line))
    if (c.aqi != null) {
      body.append(el('p', 'insp-note', `Air quality index ${c.aqi} (EAQI), PM2.5 ${c.pm25} µg/m³`))
    }
    return true
  }

  #marine(m, body) {
    if (!m) return false
    const parts = []
    if (m.seaTempC != null) parts.push(`${m.seaTempC.toFixed(1)}°C at the surface`)
    if (m.waveHeightM != null) parts.push(`${m.waveHeightM.toFixed(2)} m swell`)
    if (m.wavePeriodS != null) parts.push(`${m.wavePeriodS.toFixed(1)} s period`)
    if (m.currentKph != null) parts.push(`current ${m.currentKph.toFixed(1)} km/h`)
    if (!parts.length) return false
    body.append(el('p', 'insp-line', parts.join(' · ')))
    return true
  }

  #climate(c, body) {
    if (!c) return false
    const chart = monthlyChart(c.months)
    if (chart) body.append(chart)
    body.append(el('p', 'insp-line',
      `${c.annualMeanC?.toFixed(1)}°C mean · ${num(Math.round(c.annualRainMm))} mm a year`))
    body.append(el('p', 'insp-note',
      `${c.coldestMonthC?.toFixed(1)}°C coldest month to ${c.warmestMonthC?.toFixed(1)}°C warmest. `
      + `Extremes ${c.recordLowC?.toFixed(1)}°C / ${c.recordHighC?.toFixed(1)}°C. `
      + `ERA5 reanalysis ${c.from}–${c.to}, not a 30-year normal.`))
    return true
  }

  #timeline(events, body) {
    if (!events?.length) {
      body.append(el('p', 'insp-note', 'Nothing dated recorded here in Wikidata.'))
      return true
    }
    const scroller = el('div', 'insp-scroll')
    const list = el('ol', 'insp-timeline')
    for (const event of events) {
      const li = el('li')
      li.append(el('span', 'insp-year', signedYear(event.year)))
      const text = el('div')
      text.append(link(event.label, event.url))
      if (event.kind) text.append(el('span', 'insp-kind', `\u00b7 ${event.kind}`))
      li.append(text)
      list.append(li)
    }
    scroller.append(list)
    body.append(scroller)
    if (events.length > 8) {
      body.append(el('p', 'insp-note', `${events.length} dated events, oldest first \u00b7 scroll the list`))
    }
    return true
  }

  #articles(data, body) {
    if (!data?.items?.length) {
      body.append(el('p', 'insp-note', data?.probes > 1
        ? `Nothing georeferenced in ${data.probes} probes across this tile.`
        : 'No georeferenced articles within range.'))
      return true
    }
    const list = el('ul', 'insp-list')
    for (const item of data.items) {
      const li = el('li')
      li.append(link(item.title, item.url))
      if (Number.isFinite(item.distanceKm)) {
        li.append(el('span', 'insp-dist', `${item.distanceKm.toFixed(1)} km`))
      }
      if (item.summary) li.append(el('p', null, item.summary))
      list.append(li)
    }
    body.append(list)
    return true
  }

  #quakes(data, body) {
    if (!data?.events?.length) {
      body.append(el('p', 'insp-note',
        `No quake above M${data?.minMagnitude ?? 4.5} recorded here since 1900.`))
      return true
    }
    const list = el('ul', 'insp-list insp-quakes')
    for (const q of data.events) {
      const li = el('li')
      const mag = el('span', 'insp-mag', `M${q.magnitude.toFixed(1)}`)
      mag.style.setProperty('--heat', String(Math.min(1, Math.max(0, (q.magnitude - 4) / 5))))
      li.append(mag, link(`${new Date(q.time).getUTCFullYear()} · ${q.place}`, q.url))
      if (q.depthKm != null) li.append(el('span', 'insp-dist', `${Math.round(q.depthKm)} km deep`))
      list.append(li)
    }
    body.append(list)
    return true
  }

  #species(data, body) {
    if (!data?.items?.length) {
      body.append(el('p', 'insp-note', 'No species occurrences recorded in this box.'))
      return true
    }
    const list = el('ul', 'insp-list insp-species')
    for (const s of data.items) {
      const li = el('li')
      li.append(link(s.name, `https://www.gbif.org/species/search?q=${encodeURIComponent(s.name)}`, 'insp-sci'))
      li.append(el('span', 'insp-dist', `${compact(s.records)} records`))
      list.append(li)
    }
    body.append(list)
    body.append(el('p', 'insp-note',
      `${compact(data.total)} georeferenced occurrences in this box (GBIF).`))
    return true
  }
}
