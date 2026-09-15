import * as THREE from 'three'
import { goldberg, tileCountFor } from './globe/goldberg.js'
import { EarthSampler, toLatLon, ELEVATION_MAX_M } from './globe/sampler.js'
import { TileMesh } from './globe/tileMesh.js'
import { TileMarker } from './globe/marker.js'
import { GlobeScene } from './globe/scene.js'
import { MODES, buildTileColors } from './globe/colorModes.js'
import { Panel } from './ui/panel.js'
import { Inspector } from './ui/inspector.js'
import { BIOMES } from './globe/biomes.js'
import { seasonAngle, spinAngleFor } from './data/solar.js'

const HOME_LON = 20 * (Math.PI / 180)   // Europe and Africa face the camera on load
const HOME_DISTANCE = 3.1
const RADIUS = 1
const LAND_ROUGHNESS = 0.92
/** Slider is "gloss"; the material wants roughness, and pure mirror water blows out. */
const seaRoughness = (gloss) => 1 - 0.72 * gloss
const EARTH_RADIUS_KM = 6371
/** Labels for the sun-azimuth readout; index 0 is the December solstice. */
const SEASONS = ['Dec solstice', 'early Feb', 'Mar equinox', 'early May',
  'Jun solstice', 'early Aug', 'Sep equinox', 'early Nov']

const canvas = document.getElementById('stage')
const globe = new GlobeScene(canvas, { radius: RADIUS })
const inspector = new Inspector(document.getElementById('inspector'))

const hover = new TileMarker(0x9fe8ff, { opacity: 0.16, lineOpacity: 0.55 })
const select = new TileMarker(0x5ad1ff, { opacity: 0.3, lineOpacity: 1 })
globe.spin.add(hover.group, select.group)

let sampler = null
let tiling = null
let tiles = null
let attrs = null

/* ------------------------------------------------------------------ controls */

const controls = [
  {
    title: 'Tiling',
    items: [
      {
        key: 'frequency', label: 'Tile size', type: 'range',
        min: 4, max: 44, step: 1, value: 26, lazy: true,
        format: (v) => `${tileCountFor(v).toLocaleString()} tiles`,
      },
      { key: 'gap', label: 'Tile gap', type: 'range', min: 0, max: 0.5, step: 0.005, value: 0.1, format: 'pct' },
      { key: 'thickness', label: 'Tile depth', type: 'range', min: 0, max: 0.06, step: 0.001, value: 0.012 },
      { key: 'relief', label: 'Terrain relief', type: 'range', min: 0, max: 0.2, step: 0.002, value: 0.05 },
      { key: 'oceanDrop', label: 'Bathymetry relief', type: 'range', min: 0, max: 0.14, step: 0.002, value: 0.04 },
      { key: 'hideOcean', label: 'Land tiles only', type: 'toggle', value: false },
    ],
  },
  {
    title: 'Colour',
    items: [
      { key: 'colorMode', label: 'Colour by', type: 'select', value: 'natural', options: MODES },
      { key: 'blend', label: 'Satellite blend', type: 'range', min: 0, max: 1, step: 0.01, value: 0.18, format: 'pct' },
      { key: 'variation', label: 'Tile variation', type: 'range', min: 0, max: 0.14, step: 0.002, value: 0.035, format: 'pct' },
      { key: 'sideShade', label: 'Bevel shading', type: 'range', min: 0.2, max: 1, step: 0.01, value: 0.55, format: 'pct' },
      { key: 'seaGloss', label: 'Sea gloss', type: 'range', min: 0, max: 1, step: 0.01, value: 0.45, format: 'pct' },
    ],
  },
  {
    title: 'Motion & view',
    items: [
      { key: 'spinSpeed', label: 'Rotation speed', type: 'range', min: -30, max: 30, step: 0.5, value: 4, format: 'dps' },
      { key: 'spinning', label: 'Auto-rotate', type: 'toggle', value: true },
      { key: 'distance', label: 'Zoom', type: 'range', min: 1.15, max: 9, step: 0.01, value: 3.1, format: (v) => `${v.toFixed(2)}×` },
      { key: 'axialTilt', label: 'Axial tilt', type: 'range', min: -45, max: 45, step: 0.01, value: 23.44, format: 'deg1' },
      { key: 'fov', label: 'Field of view', type: 'range', min: 18, max: 70, step: 1, value: 38, format: 'deg' },
      { key: 'recenter', label: 'Reset view', type: 'button' },
    ],
  },
  {
    title: 'Sun & shadow',
    items: [
      { key: 'realtime', label: 'Track real time', type: 'toggle', value: false },
      { key: 'sunNow', label: 'Sun → now', type: 'button' },
      {
        key: 'sunAzimuth', label: 'Sun azimuth / season', type: 'range',
        min: 0, max: 360, step: 1, value: 335,
        // At zero elevation the azimuth *is* the season: 0 is the December
        // solstice, 180 the June one.
        format: (v) => `${v.toFixed(0)}\u00b0 \u00b7 ${SEASONS[Math.round(v / 45) % 8]}`,
      },
      { key: 'sunElevation', label: 'Sun elevation', type: 'range', min: -80, max: 80, step: 1, value: 18, format: 'deg' },
      { key: 'sunIntensity', label: 'Sun intensity', type: 'range', min: 0, max: 7, step: 0.05, value: 3.0 },
      { key: 'sunWarmth', label: 'Sun warmth', type: 'range', min: 0, max: 1, step: 0.01, value: 0.42, format: 'pct' },
      { key: 'ambient', label: 'Night fill', type: 'range', min: 0, max: 1.6, step: 0.02, value: 0.5 },
      { key: 'cityLights', label: 'City lights', type: 'range', min: 0, max: 4, step: 0.05, value: 1.8 },
      { key: 'shadows', label: 'Cast shadows', type: 'toggle', value: true },
      {
        key: 'shadowSize', label: 'Shadow detail', type: 'select', value: 2048,
        options: [
          { value: 1024, label: 'Low' },
          { value: 2048, label: 'Medium' },
          { value: 4096, label: 'High' },
        ],
      },
      { key: 'exposure', label: 'Exposure', type: 'range', min: 0.4, max: 2, step: 0.01, value: 1.05 },
    ],
  },
  {
    title: 'Atmosphere',
    items: [
      { key: 'atmosphere', label: 'Atmosphere', type: 'range', min: 0, max: 2.5, step: 0.05, value: 1 },
      { key: 'stars', label: 'Starfield', type: 'toggle', value: true },
    ],
  },
]

const panel = new Panel(document.getElementById('panel'), controls, onControl)
const state = panel.state

const panelEl = document.getElementById('panel')
const panelToggle = document.getElementById('panel-toggle')
panelToggle.addEventListener('click', () => {
  const hidden = panelEl.classList.toggle('hidden')
  panelToggle.setAttribute('aria-expanded', String(!hidden))
})

/* ------------------------------------------------------------------- building */

function shapeArgs() {
  return {
    radius: RADIUS,
    gap: state.gap,
    thickness: state.thickness,
    relief: state.relief,
    oceanDrop: state.oceanDrop,
    hideOcean: state.hideOcean,
  }
}

function colorArgs() {
  return {
    base: buildTileColors(attrs, { mode: state.colorMode, blend: state.blend }),
    sideShade: state.sideShade,
    variation: state.variation,
  }
}

/** Distance from the globe centre to the top of a tile, for marker placement. */
function tileTopRadius(index) {
  const water = attrs.surface[index] <= 1
  const lift = water
    ? -state.oceanDrop * (0.12 + 0.88 * Math.min(1, attrs.depth[index] / 10935))
    : state.relief * attrs.elevation[index]
  return RADIUS + state.thickness + lift + 0.004
}

function rebuildTiling(frequency) {
  const t0 = performance.now()
  tiling = goldberg(frequency)
  attrs = sampler.resolve(tiling)
  tiles = new TileMesh(tiling, attrs)
  tiles.updateShape(shapeArgs())
  tiles.updateColors(colorArgs())
  globe.setTiles(tiles, tiles.roughness(seaRoughness(state.seaGloss), LAND_ROUGHNESS), tiles.lights())
  hover.clear()
  select.clear()
  inspector.hide()
  buildMs = performance.now() - t0
  refreshStats()
}

function applyShadowState() {
  globe.sun.castShadow = state.shadows
  globe.renderer.shadowMap.enabled = state.shadows
  if (globe.mesh) globe.mesh.material.needsUpdate = true
}

/**
 * Put the light where the sun really is for `date`, and turn the globe so the
 * subsolar point faces it. The terminator then matches the real one.
 */
function alignSunTo(date) {
  panel.set('sunAzimuth', seasonAngle(date))
  panel.set('sunElevation', 0)
  globe.setSun({ azimuth: state.sunAzimuth, elevation: 0 })
  globe.spin.rotation.y = spinAngleFor(date, state.axialTilt) * (Math.PI / 180)
}

/**
 * Swing the camera round to where the day/night line is.
 *
 * Without this, snapping the sun to the real one usually leaves you staring at
 * the unlit half, since the camera has no idea what time it is. Distance and
 * field of view are left alone so a zoomed-in view stays zoomed in.
 */
function frameTerminator() {
  const a = (state.sunAzimuth + 42) * (Math.PI / 180)
  const e = 16 * (Math.PI / 180)
  // Read the distance before moving: set() overwrites the vector the getter reads.
  const distance = globe.distance
  globe.camera.position
    .set(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a))
    .setLength(distance)
  globe.controls.target.set(0, 0, 0)
  globe.controls.update()
}

function onControl(key, value) {
  switch (key) {
    case 'frequency':
      rebuildTiling(value)
      break

    case 'gap': case 'thickness': case 'relief': case 'oceanDrop': case 'hideOcean':
      tiles.updateShape(shapeArgs())
      if (select.tile >= 0) select.setTile(tiling, select.tile, tileTopRadius(select.tile))
      hover.clear()
      break

    case 'colorMode': case 'blend': case 'sideShade': case 'variation':
      tiles.updateColors(colorArgs())
      break

    case 'seaGloss':
      globe.mesh.geometry.setAttribute('aRough', new THREE.BufferAttribute(
        tiles.roughness(seaRoughness(value), LAND_ROUGHNESS), 1))
      break

    case 'cityLights':
      globe.lightUniforms.uLightsStrength.value = value
      break

    case 'distance':
      globe.distance = value
      break

    case 'fov':
      globe.camera.fov = value
      globe.camera.updateProjectionMatrix()
      break

    case 'axialTilt':
      globe.setAxialTilt(value)
      break

    case 'sunAzimuth': case 'sunElevation':
      globe.setSun({ azimuth: state.sunAzimuth, elevation: state.sunElevation })
      break

    case 'sunIntensity':
      globe.sun.intensity = value
      break

    case 'sunWarmth':
      // 0 = a hard white star, 1 = low golden sun.
      globe.sun.color.setHSL(0.09, 0.55 * value, 0.5 + 0.22 * (1 - value))
      break

    case 'ambient':
      globe.ambient.intensity = value
      globe.fill.intensity = value * 0.84
      break

    case 'shadows':
      applyShadowState()
      break

    case 'shadowSize':
      globe.setShadowResolution(value)
      break

    case 'exposure':
      globe.renderer.toneMappingExposure = value
      break

    case 'atmosphere':
      globe.atmosphere.visible = value > 0
      globe.atmosphere.material.uniforms.uStrength.value = value
      break

    case 'stars':
      globe.stars.visible = value
      break

    case 'realtime':
      if (value) {
        panel.set('spinning', false)
        alignSunTo(new Date())
        frameTerminator()
      }
      break

    case 'sunNow':
      panel.set('realtime', false)
      panel.set('spinning', false)
      alignSunTo(new Date())
      frameTerminator()
      break

    case 'recenter':
      globe.camera.position.set(
        Math.cos(HOME_LON) * HOME_DISTANCE, 0.9, -Math.sin(HOME_LON) * HOME_DISTANCE)
      globe.controls.target.set(0, 0, 0)
      globe.controls.update()
      panel.set('distance', globe.distance)
      break

    default:
      break
  }
}

/* -------------------------------------------------------------------- picking */

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let pointerMoved = false
let downAt = null

function tileUnderPointer(event) {
  if (!globe.mesh) return -1
  const rect = canvas.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, globe.camera)
  const hit = raycaster.intersectObject(globe.mesh, false)[0]
  if (!hit) return -1
  return tiles.triToTile[hit.faceIndex] ?? -1
}

/** Mean centre-to-corner distance of a tile, in kilometres on the surface. */
function tileRadiusKm(index) {
  const { centers, corners, cornerStart, sides } = tiling
  const n = sides[index]
  const begin = cornerStart[index]
  let sum = 0
  for (let k = 0; k < n; k++) {
    const c = (begin + k) * 3
    const dot = centers[index * 3] * corners[c]
      + centers[index * 3 + 1] * corners[c + 1]
      + centers[index * 3 + 2] * corners[c + 2]
    sum += Math.acos(Math.min(1, Math.max(-1, dot)))
  }
  return (sum / n) * EARTH_RADIUS_KM
}

function pickTile(index) {
  if (index < 0) return
  select.setTile(tiling, index, tileTopRadius(index))
  const { centers } = tiling
  const x = centers[index * 3]
  const y = centers[index * 3 + 1]
  const z = centers[index * 3 + 2]
  const { lat, lon } = toLatLon(x, y, z)
  const radiusKm = tileRadiusKm(index)
  const color = new THREE.Color(
    attrs.palette[index * 3], attrs.palette[index * 3 + 1], attrs.palette[index * 3 + 2])

  inspector.show({
    index,
    lat,
    lon,
    sides: tiling.sides[index],
    biome: attrs.keys[attrs.biome[index]],
    surface: attrs.surface[index],
    elevationM: attrs.elevation[index] * ELEVATION_MAX_M,
    elevationPeakM: attrs.elevationPeak[index] * ELEVATION_MAX_M,
    depthM: attrs.depth[index],
    depthMaxM: attrs.depthMax[index],
    population: attrs.population[index],
    density: attrs.density[index],
    areaKm2: attrs.areaKm2[index],
    koppen: attrs.koppen[index],
    timezone: attrs.timezone[index],
    region: sampler.regionAt(x, y, z),
    plate: sampler.plateAt(x, y, z),
    city: sampler.largestCityWithin(lat, lon, radiusKm),
    radiusKm,
    color: `#${color.getHexString()}`,
  })
}

inspector.onClose = () => select.clear()

canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY }
  pointerMoved = false
})

canvas.addEventListener('pointermove', (e) => {
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) pointerMoved = true
  if (pointerMoved || e.pointerType === 'touch') return
  const index = tileUnderPointer(e)
  canvas.classList.toggle('pickable', index >= 0)
  if (index === hover.tile) return
  if (index < 0) hover.clear()
  else hover.setTile(tiling, index, tileTopRadius(index))
})

canvas.addEventListener('pointerleave', () => hover.clear())

canvas.addEventListener('pointerup', (e) => {
  const dragged = pointerMoved
  downAt = null
  pointerMoved = false
  if (dragged) return
  pickTile(tileUnderPointer(e))
})

// Damped orbiting fires 'change' every frame; only touch the DOM when the
// readout would actually differ.
let shownDistance = 0
globe.controls.addEventListener('change', () => {
  const d = globe.distance
  if (Math.abs(d - shownDistance) < 0.005) return
  shownDistance = d
  panel.set('distance', d)
})

/* ----------------------------------------------------------------------- loop */

const statsEl = document.getElementById('stats')
let buildMs = 0
let frames = 0
let fpsClock = performance.now()
let fps = 0

function refreshStats() {
  if (!tiling) return
  statsEl.textContent =
    `${tiling.tileCount.toLocaleString()} tiles (12 pentagons) · ` +
    `${tiles.triangleCount.toLocaleString()} tris · built in ${buildMs.toFixed(0)} ms · ${fps} fps`
}

let last = performance.now()
function frame(now) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now

  if (state.realtime) {
    const date = new Date()
    const azimuth = seasonAngle(date)
    if (Math.abs(azimuth - state.sunAzimuth) > 0.2) {
      panel.set('sunAzimuth', azimuth)
      globe.setSun({ azimuth, elevation: state.sunElevation })
    }
    globe.spin.rotation.y = spinAngleFor(date, state.axialTilt) * (Math.PI / 180)
  } else if (state.spinning) {
    globe.spin.rotation.y += state.spinSpeed * (Math.PI / 180) * dt
  }

  globe.resize()
  globe.render()

  frames++
  if (now - fpsClock > 500) {
    fps = Math.round((frames * 1000) / (now - fpsClock))
    frames = 0
    fpsClock = now
    refreshStats()
  }
}

/* ----------------------------------------------------------------------- boot */

/**
 * Apply `?gap=0.2&colorMode=climate` style overrides so a particular look is a
 * shareable link. Unknown keys are ignored; bad values fall back to the default.
 */
function applyQueryOverrides() {
  for (const [key, raw] of new URLSearchParams(location.search)) {
    if (!(key in state)) continue
    const current = state[key]
    let value
    if (typeof current === 'boolean') value = raw !== '0' && raw !== 'false'
    else if (typeof current === 'number') value = Number(raw)
    else value = raw
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    panel.set(key, value)
  }
}

async function boot() {
  sampler = await EarthSampler.load(import.meta.env.BASE_URL)
  applyQueryOverrides()

  // Push every initial control value through the same path the sliders use, so
  // there is one definition of what each setting does.
  for (const key of ['sunAzimuth', 'sunIntensity', 'sunWarmth', 'ambient', 'exposure',
    'atmosphere', 'stars', 'shadows', 'shadowSize', 'axialTilt', 'fov',
    'cityLights', 'distance']) {
    onControl(key, state[key])
  }
  rebuildTiling(state.frequency)
  if (state.realtime) {
    alignSunTo(new Date())
    frameTerminator()
  }

  const boot = document.getElementById('boot')
  boot.classList.add('done')
  setTimeout(() => boot.remove(), 600)
  requestAnimationFrame(frame)
}

boot().catch((err) => {
  console.error(err)
  const boot = document.getElementById('boot')
  boot.textContent = `Failed to load: ${err.message}`
  boot.style.color = '#ff8f8f'
})

// Handy in the console while tuning palettes.
globalThis.globeDebug = {
  get tiling() { return tiling },
  get attrs() { return attrs },
  globe,
  BIOMES,
  pick: (clientX, clientY) => tileUnderPointer({ clientX, clientY }),
  select: pickTile,
}
