# Data licences

The code in this repository is MIT (see LICENSE). The files in `public/` are
not — they are baked derivatives of third-party datasets, and those datasets
keep their own terms. This file says which term applies to which byte.

Short version: everything here permits commercial use with attribution
**except one channel of one file**, and one of the live APIs. Both are called
out below, and both are removable.

## Baked files in `public/`

Each raster packs unrelated sources into separate channels, so the licence is
per channel rather than per file.

| file | channel | source | licence |
| --- | --- | --- | --- |
| `earth-color.jpg` | RGB | NASA Blue Marble Next Generation, Aug 2004 (Reto Stöckli, NASA Earth Observatory) | public domain |
| `earth-data.png` | R — surface class | Natural Earth (`ne_50m_land`, `ne_50m_lakes`, `ne_10m_glaciated_areas`, `ne_10m_antarctic_ice_shelves_polys`) | public domain |
| | G — land elevation | NASA/GEBCO elevation ramp (NASA Earth Observatory) | public domain |
| | B — ruggedness | derived from the same NASA/GEBCO elevation ramp | public domain |
| `earth-relief.png` | R — ocean depth | NASA/GEBCO bathymetry ramp (NASA Earth Observatory) | public domain |
| | G — night lights | NASA VIIRS Black Marble, 2016 | public domain |
| | B — population density | JRC GHS-POP R2023A, 2020 epoch | **CC BY 4.0** |
| `earth-regions.png` | R+G — country id | Natural Earth `ne_50m_admin_0_countries` | public domain |
| | **B — Köppen-Geiger class** | **Beck et al. 2023** | **CC BY-NC 4.0** |
| `earth-strata.png` | R — plate id | PB2002 (Bird 2003; GeoJSON by Hugo Ahlenius / Nordpil) | **ODC-BY 1.0** |
| | G — km to plate boundary | PB2002 boundaries, same source | **ODC-BY 1.0** |
| | B — timezone | Natural Earth `ne_10m_time_zones` | public domain |
| `earth-regions.json` | — | Natural Earth `ne_50m_admin_0_countries` | public domain |
| `earth-plates.json` | — | PB2002, same source as above | **ODC-BY 1.0** |
| `earth-cities.json` | — | Natural Earth `ne_10m_populated_places_simple` | public domain |

### Attribution these require

- **GHS-POP (CC BY 4.0)** — European Commission, Joint Research Centre (JRC),
  GHS-POP R2023A. Data © European Union, 2023. Reuse authorised with
  acknowledgement.
- **PB2002 (ODC-BY 1.0)** — Peter Bird, *An updated digital model of plate
  boundaries*, Geochemistry Geophysics Geosystems 4(3), 2003. GeoJSON
  conversion by Hugo Ahlenius, Nordpil.
- **Köppen-Geiger (CC BY-NC 4.0)** — Beck, H.E. et al., *High-resolution (1 km)
  Köppen-Geiger maps for 1991–2020 and 2071–2099*, Scientific Data 10, 724
  (2023).

Natural Earth and NASA imagery are public domain and require nothing, though
crediting them is the decent thing to do.

## The non-commercial channel

`earth-regions.png` carries the Köppen-Geiger class in its **B channel only**,
and that dataset is **CC BY-NC 4.0**. As shipped, this file therefore cannot be
used commercially.

It is deliberately confined to one channel so it is easy to remove. To produce
a fully permissive build, drop the Köppen read in `bake_regions()` in
`tools/bake-earth-data.py` — write a zero array into the B channel instead of
`koppen` — and re-run `npm run bake`. The climate colour mode then renders as
"no data" and every other view is unaffected.

`src/globe/koppen.js` is MIT along with the rest of the code. It holds class
codes, English labels and the conventional Köppen colour scheme, which are
facts and long-standing convention rather than anything original to the 2023
paper. The paper's contribution is the map, and the map lives in the B channel
described above.

## Live services

Nothing from these is redistributed in this repository. The app queries them
from the browser at runtime, so their terms apply to a deployment, not to a
checkout.

| service | used for | terms |
| --- | --- | --- |
| Wikipedia / Wikidata | articles, dated timeline | CC BY-SA 4.0 |
| USGS FDSNWS | earthquake history | public domain |
| GBIF | species occurrence counts | per-dataset; the facet counts used here are facts |
| Open-Meteo | conditions, marine, ERA5 climate | CC BY 4.0 data; **free API tier is non-commercial only** |

**Open-Meteo is the one that bites a commercial deployment**, and it bites
harder than the Köppen channel, because it affects the running site rather
than redistribution. The free tier is explicitly limited to non-commercial use
(600 calls/min, 10,000/day). A commercial deployment needs one of their paid
tiers; the endpoints in `src/data/provider.js` stay the same.

## Summary

| you want to | Köppen channel | Open-Meteo |
| --- | --- | --- |
| run it yourself, share it, fork it | fine | fine |
| put it on a site with ads or a subscription | re-bake without it | buy a tier |
| ship it inside a commercial product | re-bake without it | buy a tier |

None of this is legal advice.
