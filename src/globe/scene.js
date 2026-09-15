import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const DEG = Math.PI / 180

/** Rayleigh-ish rim glow, drawn on the inside of a slightly larger sphere. */
function makeAtmosphere(radius) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x5aa9ff) },
      uPower: { value: 3.2 },
      uStrength: { value: 1.0 },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uStrength;
      uniform vec3 uSun;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), uPower);
        // Fade the halo out on the night side so it reads as scattered sunlight.
        float lit = smoothstep(-0.55, 0.35, dot(normalize(vNormalW), normalize(uSun)));
        gl_FragColor = vec4(uColor, rim * uStrength * lit);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), material)
  mesh.renderOrder = 2
  return mesh
}

function makeStars(count = 4200) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const tint = new THREE.Color()
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: the acos keeps them off the poles' clumping.
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    const d = 60 + Math.random() * 40
    positions[i * 3] = Math.cos(theta) * r * d
    positions[i * 3 + 1] = u * d
    positions[i * 3 + 2] = Math.sin(theta) * r * d
    tint.setHSL(0.55 + Math.random() * 0.12, 0.35 * Math.random(), 0.55 + Math.random() * 0.45)
    colors[i * 3] = tint.r
    colors[i * 3 + 1] = tint.g
    colors[i * 3 + 2] = tint.b
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.42,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  }))
}

export class GlobeScene {
  constructor(canvas, { radius = 1 } = {}) {
    this.radius = radius

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x03060d)

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400)
    // Start over 20 deg E: Europe and Africa face the viewer rather than
    // the empty middle of the Pacific.
    this.camera.position.set(Math.cos(20 * DEG) * 3.1, 0.9, -Math.sin(20 * DEG) * 3.1)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.rotateSpeed = 0.55
    this.controls.zoomSpeed = 0.9
    this.controls.enablePan = false
    this.controls.minDistance = radius * 1.12
    this.controls.maxDistance = radius * 9

    // tilt -> spin -> tiles. The axis stays put in world space, so the season is
    // carried by where the sun sits relative to it rather than by a fourth group
    // that would swing the camera's whole view around with it.
    this.tilt = new THREE.Group()
    this.spin = new THREE.Group()
    this.tilt.add(this.spin)
    this.scene.add(this.tilt)

    this.sun = new THREE.DirectionalLight(0xfff2de, 3.0)
    this.sun.castShadow = true
    this.sun.shadow.camera.left = -radius * 1.35
    this.sun.shadow.camera.right = radius * 1.35
    this.sun.shadow.camera.top = radius * 1.35
    this.sun.shadow.camera.bottom = -radius * 1.35
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.006
    this.setShadowResolution(2048)
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    this.fill = new THREE.HemisphereLight(0x5c7fb0, 0x0a0f18, 0.42)
    this.scene.add(this.fill)
    this.ambient = new THREE.AmbientLight(0x2b3d57, 0.5)
    this.scene.add(this.ambient)

    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.965, 96, 64),
      new THREE.MeshStandardMaterial({ color: 0x08182c, roughness: 1, metalness: 0 }),
    )
    this.core.receiveShadow = true
    this.spin.add(this.core)

    this.atmosphere = makeAtmosphere(radius * 1.16)
    this.scene.add(this.atmosphere)

    this.stars = makeStars()
    this.scene.add(this.stars)

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.02,
      flatShading: false,
    })
    // Two things MeshStandardMaterial cannot do on its own, patched in rather
    // than forked into a whole custom material:
    //   aRough  per-vertex roughness, so water glints and rock does not
    //   aLights per-vertex night-lights emission, gated on the terminator
    this.lightUniforms = {
      uSunView: { value: new THREE.Vector3(1, 0, 0) },
      uLightsColor: { value: new THREE.Color(0xffc98a) },
      uLightsStrength: { value: 1.0 },
    }
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.lightUniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aRough;\nattribute float aLights;\n'
          + 'varying float vRough;\nvarying float vLights;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvRough = aRough;\nvLights = aLights;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uLightsColor;\n'
          + 'uniform float uLightsStrength;\nvarying float vRough;\nvarying float vLights;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
        .replace('#include <opaque_fragment>',
          '#include <opaque_fragment>\n'
          // Squaring concentrates the glow on real cities instead of smearing a
          // haze over every faintly-lit hexagon.
          + 'float nightside = smoothstep(0.08, -0.22, dot(normalize(normal), normalize(uSunView)));\n'
          + 'gl_FragColor.rgb += uLightsColor * vLights * vLights * nightside * uLightsStrength;')
    }

    this.mesh = null
    this._sunDirection = new THREE.Vector3(1, 0, 0)
    this.setAxialTilt(23.44)
    this.setSun({ azimuth: 335, elevation: 18, distance: 8 })
  }

  setShadowResolution(size) {
    this.sun.shadow.mapSize.set(size, size)
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose()
      this.sun.shadow.map = null
    }
  }

  setAxialTilt(degrees) {
    this.tilt.rotation.z = degrees * DEG
  }

  /** Place the light on a sphere around the globe. Azimuth 0 points at +X. */
  setSun({ azimuth, elevation, distance = 8 }) {
    const a = azimuth * DEG
    const e = elevation * DEG
    const d = this._sunDirection.set(
      Math.cos(e) * Math.cos(a),
      Math.sin(e),
      -Math.cos(e) * Math.sin(a),
    )
    this.sun.position.copy(d).multiplyScalar(distance)
    this.sun.target.position.set(0, 0, 0)
    this.sun.shadow.camera.near = Math.max(0.1, distance - this.radius * 2)
    this.sun.shadow.camera.far = distance + this.radius * 2
    this.sun.shadow.camera.updateProjectionMatrix()
    this.atmosphere.material.uniforms.uSun.value.copy(d)
  }

  /** The city-light term needs the sun in view space; it moves with the camera. */
  updateNightSide() {
    this.lightUniforms.uSunView.value
      .copy(this._sunDirection)
      .transformDirection(this.camera.matrixWorldInverse)
  }

  /** Swap in a new tile mesh, disposing the previous one. */
  setTiles(tileMesh, roughness, lights) {
    if (this.mesh) {
      this.spin.remove(this.mesh)
      this.mesh.geometry.dispose()
    }
    tileMesh.geometry.setAttribute('aRough', new THREE.BufferAttribute(roughness, 1))
    tileMesh.geometry.setAttribute('aLights', new THREE.BufferAttribute(lights, 1))
    const mesh = new THREE.Mesh(tileMesh.geometry, this.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    this.spin.add(mesh)
    this.mesh = mesh
    return mesh
  }

  get distance() {
    return this.camera.position.length()
  }

  set distance(value) {
    this.camera.position.setLength(value)
    this.controls.update()
  }

  /** Called every frame; does nothing unless the canvas actually changed size. */
  resize() {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0 || (w === this._width && h === this._height)) return
    this._width = w
    this._height = h
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render() {
    this.controls.update()
    this.camera.updateMatrixWorld()
    this.updateNightSide()
    this.renderer.render(this.scene, this.camera)
  }
}
