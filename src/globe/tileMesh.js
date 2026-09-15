import * as THREE from 'three'

/**
 * Turns a Goldberg tiling plus per-tile attributes into one renderable mesh.
 *
 * Topology is fixed for a given subdivision frequency, so the buffers are
 * allocated once and the sliders only rewrite positions/normals (shape) or
 * colours (palette). Rebuilding the whole BufferGeometry on every slider tick
 * is what makes naive versions of this stutter.
 *
 * Layout, per tile of n sides, non-indexed:
 *   n triangles  top fan      (3n vertices)
 *   2n triangles side walls   (6n vertices)
 */
export class TileMesh {
  constructor(tiling, attrs) {
    this.tiling = tiling
    this.attrs = attrs

    const { tileCount, sides } = tiling
    let vertices = 0
    let triangles = 0
    const vertexStart = new Uint32Array(tileCount + 1)
    const triStart = new Uint32Array(tileCount + 1)
    for (let t = 0; t < tileCount; t++) {
      vertexStart[t] = vertices
      triStart[t] = triangles
      vertices += sides[t] * 9
      triangles += sides[t] * 3
    }
    vertexStart[tileCount] = vertices
    triStart[tileCount] = triangles

    this.vertexStart = vertexStart
    this.triStart = triStart
    this.vertexCount = vertices
    this.triangleCount = triangles

    // faceIndex -> tile, for picking. Runs are contiguous, so a binary search
    // over triStart would also work; the flat table costs 4 bytes a triangle and
    // keeps the click handler O(1).
    this.triToTile = new Uint32Array(triangles)
    for (let t = 0; t < tileCount; t++) {
      this.triToTile.fill(t, triStart[t], triStart[t + 1])
    }

    this.position = new Float32Array(vertices * 3)
    this.normal = new Float32Array(vertices * 3)
    this.color = new Float32Array(vertices * 3)

    // Small stable per-tile brightness jitter keeps large flat regions — the
    // Sahara, the deep Pacific — from reading as one dead sheet of colour.
    this.jitter = new Float32Array(tileCount)
    for (let t = 0; t < tileCount; t++) {
      const h = Math.sin(t * 12.9898) * 43758.5453
      this.jitter[t] = (h - Math.floor(h)) * 2 - 1
    }

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3))
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normal, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.color, 3))
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.4)
  }

  dispose() {
    this.geometry.dispose()
  }

  /**
   * Per-vertex roughness, so the oceans can carry a specular highlight while
   * rock and ice stay matte. Fed to the material's injected `aRough` attribute.
   */
  roughness(water, land) {
    const out = new Float32Array(this.vertexCount)
    const { tileCount } = this.tiling
    const { surface, elevation } = this.attrs
    for (let t = 0; t < tileCount; t++) {
      const wet = surface[t] <= 1
      // Highland rock is rougher than lowland cover; it keeps mountains from
      // flaring in the sunlight the way the sea does.
      const value = wet ? water : Math.min(1, land + elevation[t] * 0.25)
      out.fill(value, this.vertexStart[t], this.vertexStart[t + 1])
    }
    return out
  }

  /**
   * Rewrite vertex positions and normals.
   *
   * @param {object}  o
   * @param {number}  o.radius      sphere radius the tiles sit on
   * @param {number}  o.gap         0..0.6, fraction of each tile shaved off the edge
   * @param {number}  o.thickness   base extrusion of every tile
   * @param {number}  o.relief      extra height per unit of normalised elevation
   * @param {number}  o.oceanDrop   bathymetry exaggeration; how far the deepest
   *                                 trench sits below the land shell
   * @param {boolean} o.hideOcean   collapse water tiles instead of drawing them
   */
  updateShape({ radius, gap, thickness, relief, oceanDrop, hideOcean }) {
    const { tileCount, centers, corners, cornerStart, sides } = this.tiling
    const { elevation, surface, depth } = this.attrs
    const pos = this.position
    const nrm = this.normal
    const keep = 1 - gap

    const topRing = new Float64Array(3 * 6)
    const botRing = new Float64Array(3 * 6)

    for (let t = 0; t < tileCount; t++) {
      const cx = centers[t * 3]
      const cy = centers[t * 3 + 1]
      const cz = centers[t * 3 + 2]
      const n = sides[t]
      const begin = cornerStart[t]

      const water = surface[t] === 0 || surface[t] === 1
      const collapsed = hideOcean && water
      // Water rides on measured bathymetry: a shelf sits just under the coast,
      // the Mariana Trench drops the full slider value. The 0.12 floor keeps
      // lakes and unsurveyed shallows from poking through the land shell.
      const lift = water
        ? -oceanDrop * (0.12 + 0.88 * Math.min(1, depth[t] / 10935))
        : relief * elevation[t]
      const outer = radius + thickness + lift
      const inner = radius - thickness * 0.35

      for (let k = 0; k < n; k++) {
        const c = (begin + k) * 3
        let x = cx + (corners[c] - cx) * keep
        let y = cy + (corners[c + 1] - cy) * keep
        let z = cz + (corners[c + 2] - cz) * keep
        const k1 = 1 / Math.hypot(x, y, z)
        x *= k1; y *= k1; z *= k1
        if (collapsed) { x = cx; y = cy; z = cz }
        topRing[k * 3] = x * outer
        topRing[k * 3 + 1] = y * outer
        topRing[k * 3 + 2] = z * outer
        botRing[k * 3] = x * inner
        botRing[k * 3 + 1] = y * inner
        botRing[k * 3 + 2] = z * inner
      }

      const apexX = cx * outer
      const apexY = cy * outer
      const apexZ = cz * outer

      let v = this.vertexStart[t] * 3

      // Top fan. The whole cap shares the tile normal, which is what gives the
      // faceted, panelled look instead of a smooth ball.
      for (let k = 0; k < n; k++) {
        const a = k * 3
        const b = ((k + 1) % n) * 3
        pos[v] = apexX; pos[v + 1] = apexY; pos[v + 2] = apexZ
        pos[v + 3] = topRing[a]; pos[v + 4] = topRing[a + 1]; pos[v + 5] = topRing[a + 2]
        pos[v + 6] = topRing[b]; pos[v + 7] = topRing[b + 1]; pos[v + 8] = topRing[b + 2]
        for (let q = 0; q < 3; q++) {
          nrm[v + q * 3] = cx
          nrm[v + q * 3 + 1] = cy
          nrm[v + q * 3 + 2] = cz
        }
        v += 9
      }

      // Side walls: quad (top[k], bottom[k], bottom[k+1], top[k+1]). Wound so the
      // outward face is front-facing given the counter-clockwise corner order.
      for (let k = 0; k < n; k++) {
        const a = k * 3
        const b = ((k + 1) % n) * 3
        const ax = topRing[a], ay = topRing[a + 1], az = topRing[a + 2]
        const bx = topRing[b], by = topRing[b + 1], bz = topRing[b + 2]
        const dx = botRing[a], dy = botRing[a + 1], dz = botRing[a + 2]
        const ex = botRing[b], ey = botRing[b + 1], ez = botRing[b + 2]

        const u1 = dx - ax, u2 = dy - ay, u3 = dz - az
        const w1 = ex - ax, w2 = ey - ay, w3 = ez - az
        let nx = u2 * w3 - u3 * w2
        let ny = u3 * w1 - u1 * w3
        let nz = u1 * w2 - u2 * w1
        const len = Math.hypot(nx, ny, nz) || 1
        nx /= len; ny /= len; nz /= len

        const tri = [ax, ay, az, dx, dy, dz, ex, ey, ez, ax, ay, az, ex, ey, ez, bx, by, bz]
        for (let q = 0; q < 18; q++) pos[v + q] = tri[q]
        for (let q = 0; q < 6; q++) {
          nrm[v + q * 3] = nx
          nrm[v + q * 3 + 1] = ny
          nrm[v + q * 3 + 2] = nz
        }
        v += 18
      }
    }

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.normal.needsUpdate = true
  }

  /**
   * Rewrite vertex colours from a per-tile RGB array.
   *
   * @param {Float32Array} base      three floats per tile, from buildTileColors
   * @param {number}       sideShade how much darker the extruded walls are
   * @param {number}       variation strength of the per-tile brightness jitter
   */
  updateColors({ base, sideShade, variation }) {
    const { tileCount, sides } = this.tiling
    const col = this.color
    this.base = base

    for (let t = 0; t < tileCount; t++) {
      const j = 1 + this.jitter[t] * variation
      const r = base[t * 3] * j
      const g = base[t * 3 + 1] * j
      const b = base[t * 3 + 2] * j

      const n = sides[t]
      let v = this.vertexStart[t] * 3
      const capVerts = n * 3
      for (let k = 0; k < capVerts; k++) {
        col[v] = r; col[v + 1] = g; col[v + 2] = b
        v += 3
      }
      const wallVerts = n * 6
      for (let k = 0; k < wallVerts; k++) {
        col[v] = r * sideShade; col[v + 1] = g * sideShade; col[v + 2] = b * sideShade
        v += 3
      }
    }
    const attr = this.geometry.attributes.color
    attr.clearUpdateRanges()
    attr.needsUpdate = true
  }

  /**
   * Per-vertex night-lights emission. Only the tile caps glow; lighting up the
   * bevel walls too makes every city read as a lantern rather than a surface.
   */
  lights() {
    const out = new Float32Array(this.vertexCount)
    const { tileCount, sides } = this.tiling
    const source = this.attrs.lights
    for (let t = 0; t < tileCount; t++) {
      const value = Math.min(1, source[t])
      const start = this.vertexStart[t]
      out.fill(value, start, start + sides[t] * 3)
    }
    return out
  }

  /** Paint one tile a flat colour, or restore it when `rgb` is null. */
  paintTile(tile, rgb, opts) {
    if (tile < 0 || tile >= this.tiling.tileCount) return
    const { sides } = this.tiling
    const col = this.color
    const n = sides[tile]
    let v = this.vertexStart[tile] * 3

    let r, g, b
    if (rgb) {
      [r, g, b] = rgb
    } else {
      const j = 1 + this.jitter[tile] * opts.variation
      r = this.base[tile * 3] * j
      g = this.base[tile * 3 + 1] * j
      b = this.base[tile * 3 + 2] * j
    }
    const shade = rgb ? 1 : opts.sideShade

    const start = v
    for (let k = 0; k < n * 3; k++) { col[v] = r; col[v + 1] = g; col[v + 2] = b; v += 3 }
    for (let k = 0; k < n * 6; k++) {
      col[v] = r * shade; col[v + 1] = g * shade; col[v + 2] = b * shade
      v += 3
    }
    // Upload just this tile's slice. A full re-upload of the colour buffer runs
    // to tens of megabytes at high subdivision and would stall every click.
    const attr = this.geometry.attributes.color
    attr.addUpdateRange(start, v - start)
    attr.needsUpdate = true
  }
}
