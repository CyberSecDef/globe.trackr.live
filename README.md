# globe.trackr.live

A slowly spinning Earth built out of hexagonal tiles — a Goldberg polyhedron, so
6,762 hexagons and exactly 12 pentagons at the default setting, the same topology
as a football. Every tile is coloured from real data, lit by a single off-screen
sun, and casts shadows on its neighbours.

Click a tile and it tells you what is there: surface, land cover, Köppen climate,
elevation or ocean depth, population, the largest settlement, which tectonic
plate and how far to its boundary, local and solar time, daylight hours. Then it
goes and fetches the rest — a dated timeline of things that happened on that
ground, the Wikipedia articles anchored inside the hexagon, the earthquakes
recorded under it since 1900, the species logged in it, current conditions, sea
state, and ten years of climate normals.

No API keys. No backend. `dist/` is plain static files.

```bash
npm install
npm run dev        # prints its URL; tries 5180, steps up if taken
npm run build
npm run preview
```

## What a tile knows before it asks anyone

Five baked equirectangular rasters ship in `public/` (3.4 MB all in). They are
sampled once at load time, in JavaScript, not used as GPU textures:

| file | channels |
| --- | --- |
| `earth-color.jpg` | NASA Blue Marble, August 2004, topography + bathymetry |
| `earth-data.png` | R surface class · G land elevation · B ruggedness |
| `earth-relief.png` | R ocean depth · G night lights · B population density |
| `earth-regions.png` | R+G country id · B Köppen-Geiger class |
| `earth-strata.png` | R tectonic plate · G km to plate boundary · B timezone |

Plus three small tables: `earth-regions.json`, `earth-plates.json`, and
`earth-cities.json` (7,334 settlements, used for "largest place in this tile").

Each tile samples its own footprint — the centre plus two rings inside its
corners — and averages what it finds. Population comes out of that: mean density
across the footprint times the tile's own spherical area, which is why a hexagon
over Paris reads 6.4 million and one over the Sahara reads uninhabited.

Country, plate and timezone are read at the centre only. They are
administrative-style lookups, where a majority vote over the footprint would just
blur the boundary you are trying to read.

## Ocean depth

The bathymetry channel is real GEBCO data, not an inference from how blue the
satellite pixel looks. It drives three things: the colour ramp (pale cyan on the
shelf down to near-black in the trenches), the tile's height (shelves sit just
under the coast, the Mariana Trench drops the full "bathymetry relief" slider),
and the readout, which gives both the tile mean and its deepest sample. The tile
covering the Japan Trench reads 2,444 m mean, 9,091 m deepest.

## Colouring

Six views, switchable from the panel:

- **Land cover** — a stylised biome palette cross-faded toward the raw satellite
  average, with water taking its colour from measured depth.
- **Köppen climate** — Beck et al. 2023, 1991–2020, in the paper's own colours.
- **Elevation & depth** — hypsometric, land and sea on one continuous scheme.
- **Population** — log-scaled density, because it spans five orders of magnitude.
- **Night lights** — VIIRS 2016.
- **Tectonic plates** — 54 plates, categorical.

The night-lights channel does double duty: it also lights the dark half of the
globe. The Nile shows up as a thread.

Two things about the land-cover classifier in `src/globe/biomes.js`, both of
which the obvious implementation gets wrong. Blue Marble is a dark image, so
closed canopy sits near 0.1 luminance rather than 0.4 — splitting forest types on
brightness turns every temperate forest into taiga, and latitude has to do that
job instead. And sand reads faintly "green", because g sits midway between r and
b, so the desert test runs before the grassland test or the Sahara comes out a
prairie.

## Sun, season, terminator

The axial tilt is a fixed rotation and the sun moves around it, so at zero sun
elevation the azimuth *is* the season: 0° is the December solstice, 180° the June
one. That is why there is one control and not two. The readout names the season
as you drag it.

**Sun → now** puts the light at the real subsolar point for this instant, turns
the globe so the right meridian faces it, and swings the camera round to where
the day/night line is. **Track real time** keeps doing that every frame. The
solar maths is in `src/data/solar.js` — declination, equation of time, day
length, sun altitude — and needs no network.

## Where a tile becomes content

Everything in `src/data/provider.js` is keyless and CORS-open. Each lookup
returns its own promise and the inspector paints sections as they land, so one
slow source does not hold up the card.

| section | source | note |
| --- | --- | --- |
| Timeline | Wikidata SPARQL | items with P585 ("point in time") near the tile |
| On this ground | Wikipedia geosearch | articles anchored in the hexagon |
| Seismic record | USGS FDSNWS | biggest quakes since 1900 |
| Recorded life | GBIF | most-recorded species in the tile's box |
| Conditions now | Open-Meteo | temperature, wind, air quality |
| Sea state | Open-Meteo Marine | swell, period, SST, current — ocean tiles |
| Climate | Open-Meteo ERA5 archive | ten years of daily values, reduced here |
| Region | Wikipedia | the country's own article |

Three of those have a gotcha worth knowing:

- **Wikipedia geosearch caps at a 10 km radius** while a default tile is 340 km
  across, so one probe at the centre finds nothing anywhere rural. The provider
  probes a ring of seven points and re-measures each hit from the tile centre.
- **USGS silently defaults to the last 30 days**, which is why a naive query over
  Tokyo comes back empty. An explicit `starttime` is what makes it a history.
- **Wikidata is slow if you ask for everything at once.** Requesting the type and
  the Wikipedia sitelink inside the geospatial query costs about 10 s over a
  dense area. Finding the events first and then looking those few up by id costs
  about 2 s for the same answer, so the timeline is two queries.

Wikidata stores BCE dates in astronomical year numbering, where year 0 is 1 BC —
Actium is `-0030`. Printing the raw negative puts every ancient event a year
early.

### News

Still an adapter, because every usable news API wants a key and a key belongs
behind your own backend rather than in a bundle:

```js
import { configureNews } from './data/provider.js'

configureNews(async ({ lat, lon, radiusKm, region }) => {
  const res = await fetch(`/api/news?lat=${lat}&lon=${lon}&iso=${region?.iso ?? ''}`)
  return res.json()   // [{ title, summary, url, published }]
})
```

The inspector grows a "Recent news" section as soon as that is set.

## Layout

```
src/globe/goldberg.js    icosahedron -> geodesic sphere -> dual. Tiles as flat typed arrays.
src/globe/sampler.js     loads the rasters, resolves every per-tile fact from them
src/globe/biomes.js      land-cover palette and the classification rules
src/globe/koppen.js      the 30 Köppen classes and their published colours
src/globe/ramps.js       colour ramps for the thematic views
src/globe/colorModes.js  attributes -> one RGB triple per tile
src/globe/tileMesh.js    tiling + attributes -> one BufferGeometry
src/globe/marker.js      the hover / selection highlight
src/globe/scene.js       renderer, camera, sun, shadows, night lights, atmosphere
src/data/provider.js     every external lookup
src/data/solar.js        declination, equation of time, day length
src/ui/panel.js          the control panel
src/ui/inspector.js      the click-a-tile card
```

Topology is fixed for a given subdivision frequency, so buffers are allocated
once per rebuild and the sliders only rewrite positions (shape) or colours
(palette). Only `Tile size` triggers a full rebuild, and it waits for you to let
go of the slider. At the maximum setting that is 19,362 tiles and 348k triangles,
rebuilt in about 100 ms.

Picking raycasts the real mesh and maps `faceIndex` through a flat
triangle-to-tile table. Hover never touches the colour buffer — the highlight is
its own six-triangle geometry — because at high subdivision that buffer runs to
tens of megabytes.

Two things `MeshStandardMaterial` cannot do on its own are patched in through
`onBeforeCompile` rather than forked into a custom material: per-vertex roughness
(so water glints and rock does not) and per-vertex night-lights emission, gated
on the terminator.

## Shareable views

Any control can be set from the query string, which is also how the screenshots
get checked:

```
?colorMode=climate&frequency=36&gap=0.18&sunAzimuth=168&ambient=0.22&cityLights=2.6
?realtime=1&distance=3&spinning=0
```

## Re-baking

Only needed for different source imagery or a different resolution. The baked
output is committed, so a normal checkout never runs this.

```bash
npm run bake     # ~700 MB of downloads, most of it the population grid
```

Needs ImageMagick and Python 3. It builds its own venv in `tools/` for numpy,
Pillow, rasterio and scipy, stages the sources into `tools/.cache/`, then
`tools/bake-earth-data.py` rasterises them.

## Data credits and licensing

Public domain or CC-BY, except where noted:

- **NASA Earth Observatory** — Blue Marble Next Generation (Reto Stöckli), the
  GEBCO-derived elevation and bathymetry ramps, VIIRS Black Marble 2016.
- **Natural Earth** — land, lakes, glaciated areas, Antarctic ice shelves,
  admin-0 countries, time zones, populated places.
- **Bird & Ahlenius** — PB2002 tectonic plates and boundaries.
- **JRC GHSL** — GHS-POP R2023A, 2020 epoch (CC BY 4.0). World total resolves to
  7.84 billion, which is the published figure.
- **Beck et al. 2023** — Köppen-Geiger 1991–2020, *Scientific Data* 10, 724.
  **CC BY-NC 4.0.** This is the one non-commercial source in the set; if this
  globe ever goes commercial, drop the Köppen channel or swap in another climate
  map.
- Live text and records from Wikipedia and Wikidata (CC BY-SA), GBIF, USGS, and
  Open-Meteo.
