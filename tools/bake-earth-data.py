#!/usr/bin/env python3
"""Bake the equirectangular lookups the globe samples at load time.

Everything here is 2048x1024 equirectangular, -180..180 by 90..-90, so one
`texelAt` in the browser serves all of them.

public/earth-data.png     R surface class  0 ocean | 85 lake | 170 land | 255 ice
                          G land elevation 0..255  -> 0..9500 m
                          B ruggedness     0..255  local relief
public/earth-relief.png   R ocean depth    0..255  -> 0..10935 m below sea level
                          G night lights   0..255  VIIRS, 2016
                          B population     0..255  log-encoded density, /km^2
public/earth-regions.png  R+G region id (little-endian), B Koppen-Geiger class 1..30
public/earth-strata.png   R tectonic plate id, G km to plate boundary (0..2000),
                          B timezone index = (utc_offset + 12) * 4 + 1
public/earth-regions.json id -> country name / iso / continent
public/earth-plates.json  id -> plate name / code
public/earth-cities.json  compact settlement table for "largest place in tile"

Sources are staged in tools/.cache by tools/fetch-sources.sh. Needs the venv it
builds (numpy, Pillow, rasterio, scipy).

Note on licensing: every source is public domain or CC-BY except the
Koppen-Geiger maps (Beck et al. 2023), which are CC BY-NC 4.0. If this globe
ever goes commercial, drop the Koppen channel or swap in another climate map.
"""
import json
import pathlib
import sys

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFilter
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from scipy.spatial import cKDTree

Image.MAX_IMAGE_PIXELS = None

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
OUT = ROOT.parent / "public"
SS = 2                      # supersample factor for the vector rasterisation
W, H = 2048, 1024

OCEAN, LAKE, LAND, ICE = 0, 85, 170, 255
DEEPEST_M = 10935.0         # the NASA/GEBCO bathymetry ramp bottoms out here
MAX_DENSITY = 40000.0       # people/km^2 at the top of the log encoding
MAX_PLATE_KM = 2000.0       # plate-boundary distance saturates here


# --------------------------------------------------------------- vector helpers

def load(name):
    return json.loads((CACHE / name).read_text())


def rings(geom):
    """Yield every (exterior, [holes]) pair in a Polygon / MultiPolygon."""
    kind = geom["type"]
    if kind == "Polygon":
        yield geom["coordinates"][0], geom["coordinates"][1:]
    elif kind == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield poly[0], poly[1:]


def lines(geom):
    """Yield every coordinate run in a LineString / MultiLineString."""
    kind = geom["type"]
    if kind == "LineString":
        yield geom["coordinates"]
    elif kind == "MultiLineString":
        yield from geom["coordinates"]


def project(ring, w, h):
    return [((lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h) for lon, lat in ring]


def burn(features, img, value_of, hole_value):
    draw = ImageDraw.Draw(img)
    for feat in features:
        geom = feat.get("geometry")
        if not geom:
            continue
        value = value_of(feat)
        if value is None:
            continue
        for shell, holes in rings(geom):
            draw.polygon(project(shell, img.width, img.height), fill=value)
            if hole_value is not None:
                for hole in holes:
                    draw.polygon(project(hole, img.width, img.height), fill=hole_value)


def downsample_classes(arr, factor, priority):
    """Shrink by keeping the highest-priority class present in each block.

    Plain averaging drowns single-pixel islands; this keeps them.
    """
    h, w = arr.shape
    blocks = arr.reshape(h // factor, factor, w // factor, factor)
    out = np.full((h // factor, w // factor), priority[0], dtype=np.uint8)
    for cls in priority[1:]:
        out[np.any(blocks == cls, axis=(1, 3))] = cls
    return out


def grid_unit_vectors():
    """Unit vector for the centre of every cell in the output grid."""
    lat = np.deg2rad(90 - (np.arange(H) + 0.5) / H * 180)
    lon = np.deg2rad((np.arange(W) + 0.5) / W * 360 - 180)
    clat = np.cos(lat)[:, None]
    return np.stack([
        (clat * np.cos(lon)[None, :]).ravel(),
        np.repeat(np.sin(lat), W),
        (-clat * np.sin(lon)[None, :]).ravel(),
    ], axis=1)


# ---------------------------------------------------------------------- bakes

def bake_surface():
    mask = Image.new("L", (W * SS, H * SS), OCEAN)
    burn(load("ne_50m_land.geojson")["features"], mask, lambda f: LAND, OCEAN)
    burn(load("ne_50m_lakes.geojson")["features"], mask, lambda f: LAKE, None)
    burn(load("ne_10m_glaciated_areas.geojson")["features"], mask, lambda f: ICE, None)
    burn(load("ne_10m_antarctic_ice_shelves_polys.geojson")["features"], mask, lambda f: ICE, None)
    cls = downsample_classes(np.array(mask), SS, [OCEAN, LAKE, LAND, ICE])

    elev = np.array(Image.open(CACHE / "gebco.png").convert("L").resize((W, H), Image.LANCZOS))
    low = np.array(Image.fromarray(elev).filter(ImageFilter.MinFilter(5)))
    high = np.array(Image.fromarray(elev).filter(ImageFilter.MaxFilter(5)))
    rug = np.clip((high.astype(int) - low.astype(int)) * 6, 0, 255).astype(np.uint8)

    # Ice caps sit well above sea level even where the bedrock ramp reads zero.
    elev = np.where((cls == ICE) & (elev < 40), 40, elev).astype(np.uint8)

    Image.merge("RGB", [Image.fromarray(cls), Image.fromarray(elev), Image.fromarray(rug)]).save(
        OUT / "earth-data.png", optimize=True)

    weight = np.cos(np.deg2rad(90 - (np.arange(H) + 0.5) / H * 180))[:, None] * np.ones((1, W))
    share = {name: 100 * ((cls == v) * weight).sum() / weight.sum()
             for name, v in (("ocean", OCEAN), ("land", LAND), ("ice", ICE), ("lake", LAKE))}
    print("earth-data.png   ", f"{W}x{H}", {k: round(v, 1) for k, v in share.items()})
    return cls


def bake_relief():
    # Bathymetry. The NASA ramp runs 255 at sea level down to 0 at the Challenger
    # Deep, so depth is the complement; store it that way round so 0 means shore.
    bath = np.array(Image.open(CACHE / "gebco_bath.png").convert("L").resize((W, H), Image.BOX))
    depth = (255 - bath.astype(int)).astype(np.uint8)

    with rasterio.open(CACHE / "blackmarble_gray.tif") as src:
        lights = src.read(1, out_shape=(H, W), resampling=Resampling.average)

    pop = np.zeros((H, W), "float64")
    ghs = next(CACHE.glob("ghspop/*4326_30ss_V1_0.tif"))
    with rasterio.open(ghs) as src:
        # Resampling.sum keeps people conserved; average would silently invent or
        # destroy population wherever the grids do not line up.
        reproject(source=rasterio.band(src, 1), destination=pop,
                  src_transform=src.transform, src_crs=src.crs,
                  dst_transform=from_bounds(-180, -90, 180, 90, W, H), dst_crs="EPSG:4326",
                  resampling=Resampling.sum)
    lat = np.deg2rad(90 - (np.arange(H) + 0.5) / H * 180)
    cell_km2 = (np.cos(lat) * 111.32 * (360 / W)) * (110.57 * (180 / H))
    density = pop / np.maximum(cell_km2, 1e-6)[:, None]
    # Density spans five orders of magnitude, so a linear byte would quantise
    # every rural cell to zero. Log first, decode in the browser.
    encoded = np.clip(255 * np.log1p(density) / np.log1p(MAX_DENSITY), 0, 255).astype(np.uint8)

    Image.merge("RGB", [Image.fromarray(depth), Image.fromarray(lights),
                        Image.fromarray(encoded)]).save(OUT / "earth-relief.png", optimize=True)
    print("earth-relief.png ", f"{W}x{H}",
          f"world pop {pop.sum() / 1e9:.2f}B, peak {density.max():,.0f}/km2, "
          f"{100 * (lights > 8).mean():.1f}% of pixels lit")


def bake_regions():
    feats = load("ne_50m_admin_0_countries.geojson")["features"]
    table, ids = {}, {}
    for i, feat in enumerate(feats, start=1):
        props = feat["properties"]
        ids[id(feat)] = i
        table[i] = {
            "name": props.get("NAME_LONG") or props.get("NAME") or props.get("ADMIN"),
            "short": props.get("NAME") or props.get("ADMIN"),
            "iso": (props.get("ISO_A3") or "").strip("-"),
            "continent": props.get("CONTINENT"),
            "subregion": props.get("SUBREGION"),
        }

    # 16-bit ids do not fit in an 8-bit paletted draw, so burn the bytes apart.
    low = Image.new("L", (W * SS, H * SS), 0)
    high = Image.new("L", (W * SS, H * SS), 0)
    burn(feats, low, lambda f: ids[id(f)] & 0xFF, None)
    burn(feats, high, lambda f: (ids[id(f)] >> 8) & 0xFF, None)
    lo = np.array(low.resize((W, H), Image.NEAREST))
    hi = np.array(high.resize((W, H), Image.NEAREST))

    with rasterio.open(CACHE / "koppen/1991_2020/koppen_geiger_0p00833333.tif") as src:
        koppen = src.read(1, out_shape=(H, W), resampling=Resampling.mode)

    Image.merge("RGB", [Image.fromarray(lo), Image.fromarray(hi),
                        Image.fromarray(koppen)]).save(OUT / "earth-regions.png", optimize=True)
    (OUT / "earth-regions.json").write_text(json.dumps(table, separators=(",", ":")))
    covered = 100 * ((lo.astype(int) | (hi.astype(int) << 8)) > 0).mean()
    print("earth-regions.png", f"{W}x{H}",
          f"{len(table)} regions over {covered:.1f}% of pixels, "
          f"{len(set(koppen.ravel().tolist())) - 1} Koppen classes present")


def densify(points, step_deg=0.25):
    """Insert intermediate vertices so long boundary segments still attract."""
    out = []
    for a, b in zip(points, points[1:]):
        out.append(a)
        span = max(abs(b[0] - a[0]), abs(b[1] - a[1]))
        for k in range(1, int(span / step_deg)):
            t = k * step_deg / span
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    if points:
        out.append(points[-1])
    return out


def bake_strata():
    plates = load("plates.geojson")["features"]
    table, ids = {}, {}
    for i, feat in enumerate(plates, start=1):
        ids[id(feat)] = i
        table[i] = {"name": feat["properties"].get("PlateName"),
                    "code": feat["properties"].get("Code")}

    plate_img = Image.new("L", (W * SS, H * SS), 0)
    burn(plates, plate_img, lambda f: ids[id(f)], None)
    plate = np.array(plate_img.resize((W, H), Image.NEAREST))

    # Distance to the nearest plate boundary. Chasing every cell against every
    # segment is 12 billion comparisons; a KD-tree over densified vertices in 3D
    # gets the same answer in seconds, and chord distance converts back exactly.
    verts = []
    for feat in load("boundaries.geojson")["features"]:
        geom = feat.get("geometry")
        if geom:
            for run in lines(geom):
                verts.extend(densify([(c[0], c[1]) for c in run]))
    lon = np.deg2rad(np.array([v[0] for v in verts]))
    lat = np.deg2rad(np.array([v[1] for v in verts]))
    clat = np.cos(lat)
    tree = cKDTree(np.stack([clat * np.cos(lon), np.sin(lat), -clat * np.sin(lon)], axis=1))
    chord, _ = tree.query(grid_unit_vectors(), workers=-1)
    arc_km = 2 * np.arcsin(np.clip(chord / 2, 0, 1)) * 6371.0
    distance = np.clip(arc_km / MAX_PLATE_KM * 255, 0, 255).astype(np.uint8).reshape(H, W)

    zones = load("ne_10m_time_zones.geojson")["features"]

    def tz_index(feat):
        zone = feat["properties"].get("zone")
        return None if zone is None else int(round((zone + 12) * 4)) + 1

    tz_img = Image.new("L", (W * SS, H * SS), 0)
    burn(zones, tz_img, tz_index, None)
    tz = np.array(tz_img.resize((W, H), Image.NEAREST))

    Image.merge("RGB", [Image.fromarray(plate), Image.fromarray(distance),
                        Image.fromarray(tz)]).save(OUT / "earth-strata.png", optimize=True)
    (OUT / "earth-plates.json").write_text(json.dumps(table, separators=(",", ":")))
    print("earth-strata.png ", f"{W}x{H}",
          f"{len(table)} plates, {len(verts):,} boundary vertices, "
          f"{100 * (tz > 0).mean():.1f}% of pixels have a timezone")


def bake_cities():
    feats = load("ne_10m_populated_places_simple.geojson")["features"]
    rows = []
    for feat in feats:
        props = feat["properties"]
        pop = props.get("pop_max") or 0
        lon, lat = feat["geometry"]["coordinates"][:2]
        if not pop:
            continue
        rows.append([props.get("nameascii") or props.get("name"),
                     round(lat, 3), round(lon, 3), int(pop),
                     props.get("adm0name"), int(props.get("adm0cap") or 0)])
    rows.sort(key=lambda r: -r[3])
    (OUT / "earth-cities.json").write_text(json.dumps(
        {"fields": ["name", "lat", "lon", "pop", "country", "capital"], "rows": rows},
        separators=(",", ":")))
    print("earth-cities.json", f"{len(rows):,} settlements, largest {rows[0][0]} {rows[0][3]:,}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bake_surface()
    bake_relief()
    bake_regions()
    bake_strata()
    bake_cities()


if __name__ == "__main__":
    sys.exit(main())
