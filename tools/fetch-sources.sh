#!/usr/bin/env bash
# Stage the source rasters and vectors that tools/bake-earth-data.py turns into
# the files in public/. Only needed if you want to re-bake; the baked output is
# committed, so a normal checkout never runs this.
#
# Budget: ~700 MB of downloads, most of it the GHS population grid. Everything
# lands in tools/.cache and is skipped on a re-run.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .cache ../public

NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
BM=https://eoimages.gsfc.nasa.gov/images/imagerecords
PB=https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON
JRC=https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A

grab() { [ -s "$2" ] || { echo "fetch $(basename "$2")"; curl -fL --retry 3 -A "Mozilla/5.0" -o "$2" "$1"; }; }

# --- vectors -----------------------------------------------------------------
for f in ne_50m_land ne_50m_lakes ne_10m_glaciated_areas \
         ne_10m_antarctic_ice_shelves_polys ne_50m_admin_0_countries \
         ne_10m_time_zones ne_10m_populated_places_simple; do
  grab "$NE/$f.geojson" ".cache/$f.geojson"
done
grab "$PB/PB2002_plates.json"     .cache/plates.geojson
grab "$PB/PB2002_boundaries.json" .cache/boundaries.geojson

# --- rasters -----------------------------------------------------------------
# NASA Blue Marble Next Generation, topography + bathymetry, Aug 2004 (peak
# northern greenness). Public domain.
grab "$BM/73000/73776/world.topo.bathy.200408.3x5400x2700.jpg" .cache/bluemarble.jpg
# NASA/GEBCO land elevation ramp and its bathymetry companion. 21600x10800 raw;
# cut the elevation one down before PIL ever sees it.
grab "$BM/73000/73934/gebco_08_rev_elev_21600x10800.png" .cache/gebco-full.png
grab "$BM/73000/73963/gebco_08_rev_bath_21600x10800.png" .cache/gebco_bath.png
# VIIRS night lights, 2016, greyscale (the colour composite mixes in moonlit
# terrain, which would read as population across the Amazon).
grab "$BM/144000/144897/BlackMarble_2016_3km_gray_geo.tif" .cache/blackmarble_gray.tif
# Koppen-Geiger 1991-2020, Beck et al. 2023. CC BY-NC 4.0 — see the note in
# bake-earth-data.py before using this commercially.
grab "https://ndownloader.figshare.com/files/61012822" .cache/koppen.zip
[ -d .cache/koppen ] || unzip -oq .cache/koppen.zip \
  '1991_2020/koppen_geiger_0p00833333.tif' legend.txt -d .cache/koppen/
# JRC GHS-POP 2020, 30 arcsec. 460 MB, and the single reason this script is slow.
grab "$JRC/GHS_POP_E2020_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E2020_GLOBE_R2023A_4326_30ss_V1_0.zip" .cache/ghspop.zip
[ -d .cache/ghspop ] || unzip -oq .cache/ghspop.zip '*.tif' -d .cache/ghspop/

magick .cache/gebco-full.png -resize 4096x2048! -depth 8 .cache/gebco.png
magick .cache/bluemarble.jpg -resize 2048x1024! -quality 88 ../public/earth-color.jpg

# --- python ------------------------------------------------------------------
# rasterio and scipy are heavy and only the bake needs them, so they live in a
# throwaway venv rather than on the system interpreter.
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q numpy pillow rasterio scipy

.venv/bin/python bake-earth-data.py
