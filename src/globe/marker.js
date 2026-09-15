import * as THREE from 'three'

const MAX_SIDES = 6

/**
 * Highlight that floats just above one tile: a glowing cap plus a crisp rim.
 *
 * Kept as its own tiny geometry so hover never has to touch the globe's colour
 * buffer, which is tens of megabytes once you turn the subdivision up.
 */
export class TileMarker {
  constructor(color, { opacity = 0.32, lineOpacity = 0.9 } = {}) {
    this.capPositions = new Float32Array(MAX_SIDES * 3 * 3)
    this.rimPositions = new Float32Array((MAX_SIDES + 1) * 3)

    const capGeom = new THREE.BufferGeometry()
    capGeom.setAttribute('position', new THREE.BufferAttribute(this.capPositions, 3))
    this.cap = new THREE.Mesh(capGeom, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    }))

    const rimGeom = new THREE.BufferGeometry()
    rimGeom.setAttribute('position', new THREE.BufferAttribute(this.rimPositions, 3))
    this.rim = new THREE.Line(rimGeom, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: lineOpacity, depthWrite: false,
    }))

    this.group = new THREE.Group()
    this.group.add(this.cap, this.rim)
    this.group.visible = false
    this.group.renderOrder = 3
    this.tile = -1
  }

  clear() {
    this.group.visible = false
    this.tile = -1
  }

  /**
   * @param {object} tiling  output of goldberg()
   * @param {number} tile    tile index
   * @param {number} radius  distance from the globe centre to place the marker
   * @param {number} spread  1 = tile edge, >1 overhangs the neighbours slightly
   */
  setTile(tiling, tile, radius, spread = 1.02) {
    if (tile < 0) return this.clear()
    const { centers, corners, cornerStart, sides } = tiling
    const n = sides[tile]
    const begin = cornerStart[tile]
    const cx = centers[tile * 3]
    const cy = centers[tile * 3 + 1]
    const cz = centers[tile * 3 + 2]

    const ring = []
    for (let k = 0; k < n; k++) {
      const c = (begin + k) * 3
      let x = cx + (corners[c] - cx) * spread
      let y = cy + (corners[c + 1] - cy) * spread
      let z = cz + (corners[c + 2] - cz) * spread
      const s = radius / Math.hypot(x, y, z)
      ring.push([x * s, y * s, z * s])
    }

    let v = 0
    for (let k = 0; k < n; k++) {
      const a = ring[k]
      const b = ring[(k + 1) % n]
      this.capPositions[v++] = cx * radius
      this.capPositions[v++] = cy * radius
      this.capPositions[v++] = cz * radius
      this.capPositions[v++] = a[0]; this.capPositions[v++] = a[1]; this.capPositions[v++] = a[2]
      this.capPositions[v++] = b[0]; this.capPositions[v++] = b[1]; this.capPositions[v++] = b[2]
    }
    // Pentagons leave the last triangle unused; collapse it instead of resizing.
    while (v < this.capPositions.length) this.capPositions[v++] = cx * radius

    for (let k = 0; k <= n; k++) {
      const p = ring[k % n]
      this.rimPositions[k * 3] = p[0]
      this.rimPositions[k * 3 + 1] = p[1]
      this.rimPositions[k * 3 + 2] = p[2]
    }
    this.rim.geometry.setDrawRange(0, n + 1)

    this.cap.geometry.attributes.position.needsUpdate = true
    this.rim.geometry.attributes.position.needsUpdate = true
    this.cap.geometry.computeBoundingSphere()
    this.group.visible = true
    this.tile = tile
  }
}
