import React, { useMemo, useRef, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Stars, Html, Line } from '@react-three/drei'
import * as THREE from 'three'

// --- Utility math helpers ---
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// Map 2D stereographic coordinates (x,y) -> unit sphere S^2 in R^3
function stereoToSphere([x, y]) {
  const r2 = x * x + y * y
  const denom = r2 + 1
  const s = 2 / denom
  return [s * x, s * y, (r2 - 1) / denom]
}

// Differential speed scaling for sphere in stereographic chart: ds^2 = λ^2 (dx^2 + dy^2), λ = 2/(1+r^2)
function sphereLambda([x, y]) {
  const r2 = x * x + y * y
  return 2 / (1 + r2)
}

// Simple saddle surface embedding: z = (x^2 - y^2) * k
function saddleEmbed([x, y], k = 0.15) {
  return [x, y, (x * x - y * y) * k]
}

// Approximate metric scaling for saddle (demo)
function saddleLambda([x, y], k = 0.15) {
  const s = Math.sqrt(1 + 4 * k * k * (x * x + y * y))
  return 1 / s
}

// Color legend arrows (X=red, Y=green, Z=blue)
function AxisArrows({ length = 1, origin = [0, 0, 0] }) {
  return (
    <group position={origin}>
      {/* X (red) */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.02, 0.02, length, 16]} />
        <meshStandardMaterial color={'#ef4444'} />
      </mesh>
      {/* Y (green) */}
      <mesh>
        <cylinderGeometry args={[0.02, 0.02, length, 16]} />
        <meshStandardMaterial color={'#10b981'} />
      </mesh>
      {/* Z (blue) */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.02, 0.02, length, 16]} />
        <meshStandardMaterial color={'#3b82f6'} />
      </mesh>
    </group>
  )
}

// --- Portal transition FX (expanding torus that fades out) ---
function PortalFX({ enabled, ts, position = [0,0,0] }) {
  const ring = useRef()
  const mat = useRef()
  useFrame(() => {
    if (!enabled || !ts || !ring.current || !mat.current) return
    const t = (performance.now() - ts) / 1000
    const D = 0.9
    if (t > D) { if (ring.current.visible) ring.current.visible = false; return }
    const p = Math.min(1, Math.max(0, t / D))
    ring.current.visible = true
    const s = 0.4 + 3.2 * p
    ring.current.scale.setScalar(s)
    mat.current.opacity = 1 - p
    mat.current.emissiveIntensity = 1.5 * (1 - p) + 0.2
  })
  return (
    <group position={position}>
      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[1, 0.06, 24, 256]} />
        <meshStandardMaterial ref={mat} color={'#a78bfa'} emissive={'#a78bfa'} transparent />
      </mesh>
    </group>
  )
}

// --- Geodesic tracers (Sphere great circles) ---
function GeodesicTracers({ enabled, manifold, pose }) {
  if (!enabled || !pose || manifold !== 'sphere') return null
  const p = new THREE.Vector3(...(pose.pos || [0, 0, 0]))
  const offsets = [-0.6, 0, 0.6]
  const arc = Math.PI * 1.3
  const N = 220

  const makeGreatCircle = (p0, yaw) => {
    const dirFlat = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const t = dirFlat.clone().sub(p0.clone().multiplyScalar(dirFlat.dot(p0)))
    if (t.lengthSq() < 1e-6) t.copy(new THREE.Vector3().randomDirection().sub(p0.clone().multiplyScalar(Math.random())).normalize())
    const v = t.normalize()
    const pts = []
    for (let i = 0; i <= N; i++) {
      const s = (i / N - 0.5) * arc
      const cs = Math.cos(s), ss = Math.sin(s)
      const g = p0.clone().multiplyScalar(cs).add(v.clone().multiplyScalar(ss))
      g.normalize()
      pts.push(g.toArray())
    }
    return pts
  }

  const sets = offsets.map(off => makeGreatCircle(p.clone().normalize(), (pose.yaw || 0) + off))
  const colors = ['#22d3ee', '#f472b6', '#a3e635']

  return (
    <group>
      {sets.map((pts, i) => (
        <Line key={i} points={pts} color={colors[i % colors.length]} />
      ))}
    </group>
  )
}

function Player({ mode, manifold, setHud, onPose }) {
  const { camera } = useThree()
  const ref = useRef()
  const vel = useRef([0, 0, 0])
  const chart = useRef([0, 0])
  const speed = 2.8
  const jumpSpeed = 4
  const gravity = -9.8
  const onGround = useRef(true)

  const keys = useRef({})
  useEffect(() => {
    const down = e => (keys.current[e.code] = true)
    const up = e => (keys.current[e.code] = false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  useEffect(() => {
    if (ref.current) ref.current.position.set(0, 1.2, 4)
    vel.current = [0, 0, 0]
    chart.current = [0, 0]
  }, [])

  useFrame((_, dt) => {
    dt = Math.min(dt, 1 / 30)

    if (mode === 'euclid') {
      const forward = (keys.current['KeyW'] ? 1 : 0) - (keys.current['KeyS'] ? 1 : 0)
      const strafe = (keys.current['KeyD'] ? 1 : 0) - (keys.current['KeyA'] ? 1 : 0)
      const jump = keys.current['Space']

      const obj = ref.current
      if (!obj) return

      const dir = new THREE.Vector3()
      camera.getWorldDirection(dir)
      dir.y = 0
      dir.normalize()
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).negate()

      const move = new THREE.Vector3()
      move.addScaledVector(dir, forward)
      move.addScaledVector(right, strafe)
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed)

      vel.current[0] = move.x
      vel.current[2] = move.z
      vel.current[1] += gravity * dt

      if (jump && onGround.current) {
        vel.current[1] = jumpSpeed
        onGround.current = false
      }

      obj.position.x += vel.current[0] * dt
      obj.position.y += vel.current[1] * dt
      obj.position.z += vel.current[2] * dt

      if (obj.position.y < 1) {
        obj.position.y = 1
        vel.current[1] = 0
        onGround.current = true
      }

      const yaw = Math.atan2(dir.x, dir.z)
      if (onPose) onPose({ pos: obj.position.toArray(), yaw })

      setHud({
        mode: 'Euclidean (flat space)',
        pos: obj.position.toArray().map(n => n.toFixed(2)).join(', '),
        help: 'W/A/S/D move, Space jump, drag to look. Toggle worlds above.',
      })
    } else {
      const obj = ref.current
      if (!obj) return

      const forward = (keys.current['KeyW'] ? 1 : 0) - (keys.current['KeyS'] ? 1 : 0)
      const strafe = (keys.current['KeyD'] ? 1 : 0) - (keys.current['KeyA'] ? 1 : 0)
      const want = new THREE.Vector2(strafe, forward)

      let lam = 1
      if (manifold === 'sphere') lam = sphereLambda(chart.current)
      if (manifold === 'saddle') lam = saddleLambda(chart.current)

      let du = new THREE.Vector2(0, 0)
      let yaw = 0
      if (want.lengthSq() > 0) {
        want.normalize()
        const dir3 = new THREE.Vector3()
        camera.getWorldDirection(dir3)
        yaw = Math.atan2(dir3.x, dir3.z)
        const localToWorld = new THREE.Matrix3().set(
          Math.cos(yaw), -Math.sin(yaw), 0,
          Math.sin(yaw),  Math.cos(yaw), 0,
          0,              0,             1
        )
        const v = new THREE.Vector3(want.x, want.y, 1).applyMatrix3(localToWorld)
        du = new THREE.Vector2(v.x, v.y)
        du.normalize().multiplyScalar((speed / Math.max(lam, 1e-4)) * dt)
      } else {
        const dir3 = new THREE.Vector3()
        camera.getWorldDirection(dir3)
        yaw = Math.atan2(dir3.x, dir3.z)
      }

      chart.current[0] += du.x
      chart.current[1] += du.y

      let p = [0, 0, 0]
      if (manifold === 'sphere') p = stereoToSphere(chart.current)
      if (manifold === 'saddle') p = saddleEmbed(chart.current)

      obj.position.set(p[0], p[1], p[2])

      if (onPose) onPose({ pos: [p[0], p[1], p[2]], yaw })

      setHud({
        mode: manifold === 'sphere' ? 'Riemann world: Sphere (stereographic chart)' : 'Riemann world: Saddle surface (demo)',
        pos: `${p.map(n => n.toFixed(2)).join(', ')} | chart: ${chart.current.map(n => n.toFixed(2)).join(', ')}`,
        help: 'W/A/S/D move along tangent; drag to change heading. Speed is constant in the manifold metric.',
      })
    }
  })

  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshStandardMaterial emissive={'#eab308'} emissiveIntensity={1} />
      </mesh>
      <Html position={[0, 0.4, 0]} center>
        <div className="px-2 py-0.5 text-xs rounded-full bg-black/60 text-white">you</div>
      </Html>
    </group>
  )
}

function World({ mode, manifold, heatmap }) {
  const boxes = useMemo(() => new Array(20).fill(0).map(() => ({
    position: [Math.random() * 16 - 8, 0.5, Math.random() * -16],
    scale: 0.5 + Math.random(),
  })), [])

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 6, 2]} intensity={1} castShadow />
      <Stars radius={50} depth={30} count={1000} factor={2} fade />

      {mode === 'euclid' && (
        <group>
          <Grid args={[40, 40]} cellSize={1} cellThickness={0.6} infiniteGrid position={[0, -0.01, 0]} />
          {boxes.map((b, i) => (
            <mesh key={i} position={b.position} castShadow>
              <boxGeometry args={[b.scale, b.scale, b.scale]} />
              <meshStandardMaterial metalness={0.1} roughness={0.7} />
            </mesh>
          ))}
          <AxisArrows length={1.2} origin={[0, 0.01, 0]} />
        </group>
      )}

      {mode !== 'euclid' && (
        <group>
          {manifold === 'sphere'
            ? <SphereSurface heatmap={heatmap} />
            : <SaddleSurface heatmap={heatmap} />}
          <AxisArrows length={1.0} origin={[0, 0, 0]} />
        </group>
      )}
    </>
  )
}

function SphereSurface({ heatmap = false }) {
  return (
    <mesh>
      <sphereGeometry args={[1, 48, 48]} />
      {heatmap
        ? <meshStandardMaterial color={'#ef4444'} transparent opacity={0.85} />
        : <meshStandardMaterial wireframe transparent opacity={0.4} />}
    </mesh>
  )
}

function SaddleSurface({ heatmap = false }) {
  const seg = 80
  const size = 3
  const k = 0.15
  const positions = []
  const indices = []
  const colors = []
  const Kmax = 4 * k * k

  for (let i = 0; i <= seg; i++) {
    for (let j = 0; j <= seg; j++) {
      const u = (i / seg - 0.5) * size * 2
      const v = (j / seg - 0.5) * size * 2
      const [x, y, z] = saddleEmbed([u, v], k)
      positions.push(x, y, z)

      if (heatmap) {
        const r2 = u * u + v * v
        const K = -4 * k * k / Math.pow(1 + 4 * k * k * r2, 2)
        const t = clamp(Math.abs(K) / Kmax, 0, 1)
        const c1 = new THREE.Color('#e5e7eb')
        const c2 = new THREE.Color('#3b82f6')
        const c = c1.lerp(c2, t)
        colors.push(c.r, c.g, c.b)
      }
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j
      const b = a + 1
      const c = a + (seg + 1)
      const d = c + 1
      indices.push(a, b, d, a, d, c)
    }
  }
  const geomRef = useRef()
  useEffect(() => { if (geomRef.current) geomRef.current.computeVertexNormals() }, [])
  return (
    <mesh>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute attach="attributes-position" array={new Float32Array(positions)} count={positions.length / 3} itemSize={3} />
        <bufferAttribute attach="index" array={new Uint32Array(indices)} count={indices.length} itemSize={1} />
        {heatmap && (
          <bufferAttribute attach="attributes-color" array={new Float32Array(colors)} count={colors.length / 3} itemSize={3} />
        )}
      </bufferGeometry>
      {heatmap
        ? <meshStandardMaterial vertexColors transparent opacity={0.9} />
        : <meshStandardMaterial wireframe transparent opacity={0.45} />}
    </mesh>
  )
}

export default function App() {
  const [mode, setMode] = useState('euclid')
  const [manifold, setManifold] = useState('sphere')
  const [hud, setHud] = useState({ mode: '', pos: '', help: '' })

  const [showPortal, setShowPortal] = useState(true)
  const [showGeodesics, setShowGeodesics] = useState(true)
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [pose, setPose] = useState({ pos: [0, 0, 0], yaw: 0 })
  const [transitionTS, setTransitionTS] = useState(0)
  useEffect(() => { setTransitionTS(performance.now()) }, [mode, manifold])

  const camRef = useRef()

  return (
    <div className="w-full h-screen bg-slate-900 text-slate-100">
      <div className="absolute z-10 top-3 left-3 flex flex-col gap-2">
        <div className="backdrop-blur bg-black/40 border border-white/10 rounded-2xl p-3 max-w-md">
          <h1 className="text-lg font-semibold">3D ↔ Riemann Manifold Explorer</h1>
          <p className="text-xs opacity-80">Move with <b>W/A/S/D</b>. Drag to look. <b>Space</b> to jump (flat only).</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={`px-3 py-1 rounded-xl ${mode==='euclid'?'bg-emerald-500 text-black':'bg-white/10'}`} onClick={()=>setMode('euclid')}>Flat (Euclidean)</button>
            <button className={`px-3 py-1 rounded-xl ${mode!=='euclid'?'bg-emerald-500 text-black':'bg-white/10'}`} onClick={()=>setMode('riemann')}>Riemann world</button>
            {mode!=='euclid' && (
              <div className="flex gap-2">
                <button className={`px-3 py-1 rounded-xl ${manifold==='sphere'?'bg-indigo-400 text-black':'bg-white/10'}`} onClick={()=>setManifold('sphere')}>Sphere</button>
                <button className={`px-3 py-1 rounded-xl ${manifold==='saddle'?'bg-indigo-400 text-black':'bg-white/10'}`} onClick={()=>setManifold('saddle')}>Saddle</button>
              </div>
            )}
          </div>
          {mode!=='euclid' && (
            <div className="flex gap-2 mt-2">
              <button className={`px-3 py-1 rounded-xl ${showPortal?'bg-fuchsia-400 text-black':'bg-white/10'}`} onClick={()=>setShowPortal(v=>!v)}>Portal FX</button>
              <button className={`px-3 py-1 rounded-xl ${showGeodesics?'bg-cyan-400 text-black':'bg-white/10'}`} onClick={()=>setShowGeodesics(v=>!v)}>Geodesics</button>
              <button className={`px-3 py-1 rounded-xl ${showHeatmap?'bg-amber-400 text-black':'bg-white/10'}`} onClick={()=>setShowHeatmap(v=>!v)}>Curvature Heatmap</button>
            </div>
          )}
          <div className="mt-2 text-xs grid grid-cols-3 gap-2">
            <div className="col-span-3"><span className="opacity-60">Mode:</span> {hud.mode}</div>
            <div className="col-span-3"><span className="opacity-60">Position:</span> {hud.pos}</div>
            <div className="col-span-3 opacity-80">{hud.help}</div>
            <div className="col-span-3 mt-1 italic text-[10px] opacity-70">Colors: X (red), Y (green), Z/normal (blue)</div>
          </div>
        </div>
      </div>

      <Canvas shadows camera={{ position: [0, 2, 6], fov: 60 }} onCreated={({ gl }) => { gl.setClearColor('#0b1220') }}>
        <React.Suspense fallback={<Html>Loading…</Html>}>
          <World mode={mode==='euclid'?'euclid':'riemann'} manifold={manifold} heatmap={showHeatmap} />
          <Player mode={mode==='euclid'?'euclid':'riemann'} manifold={manifold} setHud={setHud} onPose={setPose} />
          <OrbitControls ref={camRef} enablePan={false} enableZoom={true} />
          <GeodesicTracers enabled={showGeodesics && mode!=='euclid' && manifold==='sphere'} manifold={manifold} pose={pose} />
          <PortalFX enabled={showPortal} ts={transitionTS} position={pose.pos} />
        </React.Suspense>
      </Canvas>

      <div className="absolute right-3 bottom-3 text-xs opacity-70">
        Built with <code>@react-three/fiber</code> • metric-aware navigation on sphere via stereographic chart
      </div>
    </div>
  )
}

