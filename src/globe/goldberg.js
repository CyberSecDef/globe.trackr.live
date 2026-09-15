/**
 * Goldberg polyhedron generator.
 *
 * Subdivide an icosahedron `frequency` times, project onto the unit sphere, then
 * take the dual: every geodesic vertex becomes one tile. You get 10f^2 + 2 tiles,
 * of which exactly 12 are pentagons (the original icosahedron corners) and the
 * rest hexagons. That is the soccer-ball topology.
 *
 * Vertices are identified combinatorially — by corner / edge / face slot — rather
 * than by rounding coordinates into a hash. Coordinate hashing looks simpler until
 * two faces compute the same shared edge point in a different order and land on
 * opposite sides of a rounding boundary, which tears a seam down the mesh.
 */

const PHI = (1 + Math.sqrt(5)) / 2

/** The 12 icosahedron corners, normalised. */
function icosahedronCorners() {
  const raw = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ]
  const s = 1 / Math.hypot(1, PHI)
  return raw.map(([x, y, z]) => [x * s, y * s, z * s])
}

/** The 20 faces, wound counter-clockwise seen from outside. */
const ICO_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
]

function normalise(v) {
  const k = 1 / Math.hypot(v[0], v[1], v[2])
  return [v[0] * k, v[1] * k, v[2] * k]
}

/**
 * Build the geodesic sphere: unit-length vertices plus the triangles over them.
 */
function geodesic(frequency) {
  const f = frequency
  const corners = icosahedronCorners()
  const positions = corners.slice()
  const triangles = []

  // Interior points of each of the 30 edges, keyed low-vertex-first so both
  // adjacent faces resolve the same slot.
  const edgeRuns = new Map()
  const edgePoint = (a, b, step) => {
    const flipped = a > b
    const key = flipped ? b * 12 + a : a * 12 + b
    const slot = flipped ? f - step : step
    let run = edgeRuns.get(key)
    if (!run) edgeRuns.set(key, (run = new Int32Array(f + 1).fill(-1)))
    if (run[slot] >= 0) return run[slot]
    const lo = flipped ? b : a
    const hi = flipped ? a : b
    const t = slot / f
    positions.push(normalise([
      corners[lo][0] + (corners[hi][0] - corners[lo][0]) * t,
      corners[lo][1] + (corners[hi][1] - corners[lo][1]) * t,
      corners[lo][2] + (corners[hi][2] - corners[lo][2]) * t,
    ]))
    return (run[slot] = positions.length - 1)
  }

  for (const [ai, bi, ci] of ICO_FACES) {
    const a = corners[ai]
    const b = corners[bi]
    const c = corners[ci]

    // lattice[i][j] is the point i/f of the way toward b and j/f toward c.
    const lattice = []
    for (let i = 0; i <= f; i++) {
      lattice.push(new Int32Array(f - i + 1))
      for (let j = 0; j <= f - i; j++) {
        let index
        if (i === 0 && j === 0) index = ai
        else if (i === f) index = bi
        else if (j === f) index = ci
        else if (j === 0) index = edgePoint(ai, bi, i)
        else if (i === 0) index = edgePoint(ai, ci, j)
        else if (i + j === f) index = edgePoint(bi, ci, j)
        else {
          const u = i / f
          const v = j / f
          positions.push(normalise([
            a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
            a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
            a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
          ]))
          index = positions.length - 1
        }
        lattice[i][j] = index
      }
    }

    for (let i = 0; i < f; i++) {
      for (let j = 0; j < f - i; j++) {
        triangles.push([lattice[i][j], lattice[i + 1][j], lattice[i][j + 1]])
        if (i + j < f - 1) {
          triangles.push([lattice[i + 1][j], lattice[i + 1][j + 1], lattice[i][j + 1]])
        }
      }
    }
  }

  return { positions, triangles }
}

/**
 * Tiles of the dual polyhedron.
 *
 * Returns flat typed arrays so the mesh builder can walk them without chasing
 * object pointers every frame:
 *   centers   Float32Array(3 * tileCount)   unit vector at the middle of the tile
 *   corners   Float32Array(3 * cornerCount) unit vectors, tile n occupies
 *             [cornerStart[n], cornerStart[n + 1])
 */
export function goldberg(frequency) {
  const { positions, triangles } = geodesic(Math.max(1, Math.floor(frequency)))
  const tileCount = positions.length

  // Triangles incident on each vertex. Every vertex has 5 or 6 of them.
  const incidentCount = new Uint8Array(tileCount)
  for (const tri of triangles) for (const v of tri) incidentCount[v]++

  const cornerStart = new Uint32Array(tileCount + 1)
  for (let i = 0; i < tileCount; i++) cornerStart[i + 1] = cornerStart[i] + incidentCount[i]
  const total = cornerStart[tileCount]

  const fill = new Uint32Array(tileCount)
  const incident = new Uint32Array(total)
  for (let t = 0; t < triangles.length; t++) {
    for (const v of triangles[t]) incident[cornerStart[v] + fill[v]++] = t
  }

  // Dual vertices: the circumcentre of each triangle, approximated by the
  // normalised centroid. On a geodesic sphere the two agree to within a rounding
  // error, and the centroid never degenerates.
  const centroids = new Float32Array(triangles.length * 3)
  for (let t = 0; t < triangles.length; t++) {
    const [p, q, r] = triangles[t]
    const c = normalise([
      positions[p][0] + positions[q][0] + positions[r][0],
      positions[p][1] + positions[q][1] + positions[r][1],
      positions[p][2] + positions[q][2] + positions[r][2],
    ])
    centroids[t * 3] = c[0]
    centroids[t * 3 + 1] = c[1]
    centroids[t * 3 + 2] = c[2]
  }

  const centers = new Float32Array(tileCount * 3)
  const corners = new Float32Array(total * 3)
  const sides = new Uint8Array(tileCount)

  const angles = new Float64Array(6)
  const order = new Uint8Array(6)

  for (let v = 0; v < tileCount; v++) {
    const n = positions[v]
    centers[v * 3] = n[0]
    centers[v * 3 + 1] = n[1]
    centers[v * 3 + 2] = n[2]

    const begin = cornerStart[v]
    const count = cornerStart[v + 1] - begin
    sides[v] = count

    // Tangent basis, so the incident centroids can be sorted into a ring.
    const helper = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const ux = helper[1] * n[2] - helper[2] * n[1]
    const uy = helper[2] * n[0] - helper[0] * n[2]
    const uz = helper[0] * n[1] - helper[1] * n[0]
    const uk = 1 / Math.hypot(ux, uy, uz)
    const u = [ux * uk, uy * uk, uz * uk]
    const w = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ]

    for (let k = 0; k < count; k++) {
      const t = incident[begin + k] * 3
      const cx = centroids[t]
      const cy = centroids[t + 1]
      const cz = centroids[t + 2]
      angles[k] = Math.atan2(
        cx * w[0] + cy * w[1] + cz * w[2],
        cx * u[0] + cy * u[1] + cz * u[2],
      )
      order[k] = k
    }
    // Insertion sort: count is 5 or 6, so anything fancier is slower.
    for (let i = 1; i < count; i++) {
      const key = order[i]
      const a = angles[key]
      let j = i - 1
      while (j >= 0 && angles[order[j]] > a) { order[j + 1] = order[j]; j-- }
      order[j + 1] = key
    }

    for (let k = 0; k < count; k++) {
      const t = incident[begin + order[k]] * 3
      const out = (begin + k) * 3
      corners[out] = centroids[t]
      corners[out + 1] = centroids[t + 1]
      corners[out + 2] = centroids[t + 2]
    }
  }

  return { tileCount, centers, corners, cornerStart, sides }
}

/** Tiles produced by a given subdivision frequency, without building anything. */
export function tileCountFor(frequency) {
  const f = Math.max(1, Math.floor(frequency))
  return 10 * f * f + 2
}
