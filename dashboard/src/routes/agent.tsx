import { useEffect, useRef, useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import {
  AGENTS,
  type Agent,
  type AgentEvent,
  type EventLevel,
} from '@/lib/agents'
import { useRosbridgeImage, useRosbridgeTopic, useRosbridgeStatus, publishRosbridge, sampleFromShared, sendActionGoal } from '@/hooks/useRosbridge'

export const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$agentId',
  component: AgentPage,
})

const LEVEL_STYLES: Record<EventLevel, string> = {
  info: 'text-term-blue',
  warn: 'text-term-yellow',
  error: 'text-term-red',
  debug: 'text-muted-foreground',
}

const TYPE_STYLES: Record<string, string> = {
  system: 'text-term-cyan',
  camera: 'text-term-magenta',
  motor: 'text-term-green',
  nav: 'text-term-blue',
  vision: 'text-term-yellow',
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
}

function formatNum(n: unknown, decimals = 3): string {
  if (typeof n === 'number' && !isNaN(n)) return n.toFixed(decimals)
  return '--'
}

function PanelHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="border-b px-2 py-1 text-xs text-muted-foreground flex items-center justify-between">
      <span><span className="text-border mr-1">&#9552;</span>{title}<span className="text-border ml-1">&#9552;</span></span>
      {right && <span>{right}<span className="text-border ml-1">&#9552;</span></span>}
    </div>
  )
}

// -- camera feeds --

function SimulatedFeed({ agent }: { agent: Agent }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    let raf: number
    function draw() {
      if (!ctx || !canvas) return
      const w = canvas.width, h = canvas.height
      ctx.fillStyle = '#080808'
      ctx.fillRect(0, 0, w, h)
      if (agent.status === 'offline') {
        const imgData = ctx.createImageData(w, h)
        for (let i = 0; i < imgData.data.length; i += 4) {
          const v = Math.random() * 40
          imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v; imgData.data[i + 3] = 255
        }
        ctx.putImageData(imgData, 0, 0)
      } else {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 3) {
          const v = Math.max(0, Math.min(50, Math.sin((y + frame * 0.5) * 0.1) * 8 + 20 + Math.random() * 15))
          ctx.fillStyle = `rgb(${v},${v + 2},${v + 5})`
          ctx.fillRect(x, y, 3, 1)
        }
        ctx.strokeStyle = 'rgba(95,135,175,0.5)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
        ctx.strokeStyle = 'rgba(95,135,175,0.7)'; ctx.beginPath(); ctx.arc(w / 2, h / 2, 20, 0, Math.PI * 2); ctx.stroke()
      }
      ctx.font = '10px monospace'
      ctx.fillStyle = agent.status === 'offline' ? '#d75f5f' : '#5f87af'
      ctx.fillText(agent.id.toUpperCase(), 6, 14)
      if (agent.status === 'offline') {
        ctx.font = '14px monospace'; ctx.fillStyle = '#d75f5f'
        const t = 'NO SIGNAL'; ctx.fillText(t, (w - ctx.measureText(t).width) / 2, h / 2)
      }
      frame++; raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [agent])
  return <canvas ref={canvasRef} width={384} height={216} className="w-full h-full" />
}

function useFps(frameCount: number): number {
  const [fps, setFps] = useState(0)
  const prevRef = useRef({ count: 0, time: performance.now() })

  useEffect(() => {
    const now = performance.now()
    const dt = now - prevRef.current.time
    if (dt >= 1000) {
      setFps(Math.round(((frameCount - prevRef.current.count) / dt) * 1000))
      prevRef.current = { count: frameCount, time: now }
    }
  }, [frameCount])

  return fps
}

function renderDepthOverlay(
  canvas: HTMLCanvasElement,
  msg: { width: number; height: number; encoding: string; data: number[] },
) {
  const { width: w, height: h, encoding, data: d } = msg
  if (!w || !h || !d?.length) return
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const imgData = ctx.createImageData(w, h)
  const is16 = encoding === '16UC1' || encoding === '16SC1'
  const signed = encoding === '16SC1'
  const pixels = w * h

  if (is16) {
    const bytes = new Uint8Array(d)
    const depth = signed ? new Int16Array(bytes.buffer) : new Uint16Array(bytes.buffer)
    let max = 0
    for (let i = 0; i < pixels; i++) if (depth[i] > max) max = depth[i]
    if (max === 0) max = 1
    for (let i = 0; i < pixels; i++) {
      const v = depth[i]
      if (v <= 0) { imgData.data[i * 4 + 3] = 0; continue }
      const n = Math.min(1, v / max)
      // blue (near) -> cyan -> green -> yellow -> red (far)
      let r: number, g: number, b: number
      if (n < 0.25) { const t = n / 0.25; r = 0; g = t * 200; b = 200 }
      else if (n < 0.5) { const t = (n - 0.25) / 0.25; r = 0; g = 200; b = 200 - t * 200 }
      else if (n < 0.75) { const t = (n - 0.5) / 0.25; r = t * 255; g = 200; b = 0 }
      else { const t = (n - 0.75) / 0.25; r = 255; g = 200 - t * 200; b = 0 }
      imgData.data[i * 4] = r
      imgData.data[i * 4 + 1] = g
      imgData.data[i * 4 + 2] = b
      imgData.data[i * 4 + 3] = 140
    }
  } else {
    const bytes = new Uint8Array(d)
    const depth = new Float32Array(bytes.buffer)
    let max = 0
    for (let i = 0; i < pixels; i++) { const v = depth[i]; if (isFinite(v) && v > max) max = v }
    if (max === 0) max = 1
    for (let i = 0; i < pixels; i++) {
      const v = depth[i]
      if (!isFinite(v) || v <= 0) { imgData.data[i * 4 + 3] = 0; continue }
      const n = Math.min(1, v / max)
      let r: number, g: number, b: number
      if (n < 0.25) { const t = n / 0.25; r = 0; g = t * 200; b = 200 }
      else if (n < 0.5) { const t = (n - 0.25) / 0.25; r = 0; g = 200; b = 200 - t * 200 }
      else if (n < 0.75) { const t = (n - 0.5) / 0.25; r = t * 255; g = 200; b = 0 }
      else { const t = (n - 0.75) / 0.25; r = 255; g = 200 - t * 200; b = 0 }
      imgData.data[i * 4] = r
      imgData.data[i * 4 + 1] = g
      imgData.data[i * 4 + 2] = b
      imgData.data[i * 4 + 3] = 140
    }
  }
  ctx.putImageData(imgData, 0, 0)
}

function ImageFeed({ url, topic, label, depthTopic }: { url: string; topic: string; label: string; depthTopic?: string }) {
  const [paused, setPaused] = useState(false)
  const [depthOn, setDepthOn] = useState(false)
  const [depthLoading, setDepthLoading] = useState(false)
  const depthCanvasRef = useRef<HTMLCanvasElement>(null)
  const depthOnRef = useRef(false)
  depthOnRef.current = depthOn
  const stream = useRosbridgeImage(url, topic, 100, paused)
  const fps = useFps(stream.frameCount)

  function fetchDepth() {
    if (!depthTopic) return
    sampleFromShared<{ width: number; height: number; encoding: string; data: number[] }>(url, depthTopic)
      .then((msg) => {
        if (depthCanvasRef.current) renderDepthOverlay(depthCanvasRef.current, msg)
      })
      .catch(() => { /* ignore */ })
      .finally(() => setDepthLoading(false))
  }

  // auto-refresh depth every 4s when on
  useEffect(() => {
    if (!depthOn || !depthTopic) return
    fetchDepth()
    const interval = setInterval(fetchDepth, 4000)
    return () => clearInterval(interval)
  }, [depthOn, depthTopic, url])

  function toggleDepth() {
    if (depthOn) {
      setDepthOn(false)
    } else {
      setDepthLoading(true)
      setDepthOn(true)
    }
  }

  return (
    <div className="w-full h-full bg-black relative group overflow-hidden">
      {stream.src ? (
        <img src={stream.src} alt={label} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
          WAITING
        </div>
      )}
      {depthTopic && (
        <canvas
          ref={depthCanvasRef}
          className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
          style={{ display: depthOn ? 'block' : 'none' }}
        />
      )}
      <div className="absolute top-1 left-2 text-[10px] text-term-blue">{label}</div>
      <div className="absolute top-1 right-2 text-[10px] flex items-center gap-1">
        {stream.src && !paused && <span className="text-term-green status-live">●</span>}
        {paused && <span className="text-term-yellow">PAUSED</span>}
        {depthOn && <span className="text-term-cyan">DEPTH</span>}
        {stream.src && <span className="text-muted-foreground">{fps}fps f:{stream.frameCount}</span>}
      </div>
      <div className="absolute bottom-1 right-1 flex gap-1">
        {depthTopic && (
          <button
            onClick={toggleDepth}
            disabled={depthLoading}
            className={`text-[10px] px-1.5 py-0.5 ${depthOn ? 'bg-term-cyan/80 text-black' : 'bg-black/60 text-muted-foreground hover:text-foreground'}`}
          >
            {depthLoading ? '...' : depthOn ? 'depth off' : 'depth'}
          </button>
        )}
        <button
          onClick={() => setPaused((p) => !p)}
          className="text-[10px] px-1.5 py-0.5 bg-black/60 text-muted-foreground hover:text-foreground"
        >
          {paused ? 'play' : 'pause'}
        </button>
      </div>
    </div>
  )
}

// -- telemetry value display --

function TelemetryRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right truncate ${color ?? 'text-foreground'}`}>{value}</span>
    </div>
  )
}

// -- telemetry panels --

function quatToYaw(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
}

function isoProject(x: number, y: number, z: number): { sx: number; sy: number } {
  return {
    sx: (x - y) * 0.866,
    sy: (x + y) * 0.5 - z,
  }
}

// -- 3D geometry helpers --
type V3 = [number, number, number]

function rotZ3(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a)
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]
}

function proj3(p: V3): [number, number] {
  const r = isoProject(p[0], p[1], p[2])
  return [r.sx, r.sy]
}

interface Face3D { pts: string; stroke: string; strokeOp: number; depth: number }

function boxFaces(
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw: number, color: string,
): Face3D[] {
  const corners: V3[] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ]
  const world = corners.map(c => {
    const r = rotZ3(c, yaw)
    return [cx + r[0], cy + r[1], cz + r[2]] as V3
  })
  const scr = world.map(proj3)
  const faceIdx = [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [3, 0, 4, 7], [1, 2, 6, 5]]
  const normals: V3[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]]
  const light: V3 = [-0.4, -0.7, 0.6]
  const result: Face3D[] = []
  for (let i = 0; i < 6; i++) {
    const idx = faceIdx[i]
    const [a, b, c] = [scr[idx[0]], scr[idx[1]], scr[idx[2]]]
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) continue
    const rn = rotZ3(normals[i], yaw)
    const ndl = rn[0] * light[0] + rn[1] * light[1] + rn[2] * light[2]
    const brightness = 0.35 + Math.max(0, ndl) * 0.55
    const pts = idx.map(j => `${scr[j][0].toFixed(1)},${scr[j][1].toFixed(1)}`).join(' ')
    const depth = idx.reduce((s, j) => s + world[j][0] + world[j][1] + world[j][2], 0) / 4
    result.push({ pts, stroke: color, strokeOp: brightness, depth })
  }
  return result
}

// 3D Wall-E: boxes rotated by yaw, projected to isometric, back-face culled
function Robot3D({ yaw, linX }: { yaw: number; linX: number; angZ: number }) {
  const moving = Math.abs(linX) > 0.01
  const allFaces: Face3D[] = [
    ...boxFaces(-4.5, 0, 2.5, 1, 2.5, 2.5, yaw, '#5faf5f'),
    ...boxFaces(4.5, 0, 2.5, 1, 2.5, 2.5, yaw, '#5faf5f'),
    ...boxFaces(0, 0, 4.5, 3, 2.5, 3, yaw, '#5f87af'),
    ...boxFaces(0, 0, 8, 0.6, 0.6, 0.5, yaw, '#5f87af'),
    ...boxFaces(0, 0, 10, 2.8, 1.5, 1.5, yaw, '#5f87af'),
  ]
  allFaces.sort((a, b) => a.depth - b.depth)

  const viewDir: V3 = [-1, -1, -1]
  const frontN = rotZ3([1, 0, 0], yaw)
  const frontVis = frontN[0] * viewDir[0] + frontN[1] * viewDir[1] + frontN[2] * viewDir[2] < 0
  const eyeL = proj3(rotZ3([2.8, -0.8, 10], yaw))
  const eyeR = proj3(rotZ3([2.8, 0.8, 10], yaw))
  const pwPos = proj3(rotZ3([3, 0, 6.5], yaw))

  return (
    <g>
      {allFaces.map((f, i) => (
        <polygon key={i} points={f.pts}
          style={{ fill: 'var(--card)' }}
          stroke={f.stroke} strokeWidth={1.2}
          strokeLinejoin="round" strokeOpacity={f.strokeOp}
        />
      ))}
      {frontVis && <>
        <circle cx={eyeL[0]} cy={eyeL[1]} r={1.8} fill="none" stroke="#5fafaf" strokeWidth={1} opacity={0.9} />
        <circle cx={eyeL[0]} cy={eyeL[1]} r={0.7} fill="#5fafaf" opacity={0.9} />
        <circle cx={eyeR[0]} cy={eyeR[1]} r={1.8} fill="none" stroke="#5fafaf" strokeWidth={1} opacity={0.9} />
        <circle cx={eyeR[0]} cy={eyeR[1]} r={0.7} fill="#5fafaf" opacity={0.9} />
        <circle cx={pwPos[0]} cy={pwPos[1]} r={0.8} fill={moving ? '#5faf5f' : '#6c6c6c'} opacity={0.7} />
      </>}
    </g>
  )
}

function RobotPosePanel({ url }: { url: string }) {
  const { data: poseData } = useRosbridgeTopic<{
    pose?: { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } } }
  }>(url, '/amcl_pose', 'geometry_msgs/msg/PoseWithCovarianceStamped', 500)

  const { data: odomData } = useRosbridgeTopic<{
    twist?: { twist?: { linear?: { x: number; y: number }; angular?: { z: number } } }
    pose?: { pose?: { position?: { x: number; y: number } } }
  }>(url, '/odom', 'nav_msgs/msg/Odometry', 200)

  const { data: cmdVelData } = useRosbridgeTopic<{
    linear?: { x: number; y: number; z: number }
    angular?: { x: number; y: number; z: number }
  }>(url, '/cmd_vel', 'geometry_msgs/msg/Twist', 200)

  const pos = poseData?.pose?.pose?.position ?? { x: 0, y: 0, z: 0 }
  const ori = poseData?.pose?.pose?.orientation ?? { x: 0, y: 0, z: 0, w: 1 }
  const lin = odomData?.twist?.twist?.linear ?? { x: 0, y: 0 }
  const ang = odomData?.twist?.twist?.angular ?? { z: 0 }
  const odomPos = odomData?.pose?.pose?.position

  const yaw = quatToYaw(ori)

  // viewBox dimensions
  const CX = 200, CY = 140
  // map +-5m world range to +-80 iso units
  const S = 16
  const gx = Math.max(-5, Math.min(5, pos.x)) * S
  const gy = Math.max(-5, Math.min(5, pos.y)) * S
  const gz = Math.max(-2, Math.min(2, pos.z)) * 10

  const projected = isoProject(gx, gy, gz)
  const robotX = CX + projected.sx
  const robotY = CY + projected.sy

  // grid spans +-80 iso units (10 lines each way)
  const GRID = 80
  const LINES = 9

  return (
    <div className="tui-panel bg-card col-span-2">
      <PanelHeader title="POSE + ODOM" />
      <div className="flex">
        <div className="flex-1 p-2" style={{ maxHeight: 320 }}>
          <svg viewBox="0 0 400 280" className="w-full h-full" preserveAspectRatio="xMidYMid meet" style={{ maxHeight: 300 }}>
            <defs>
              <marker id="arrowHead" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
                <path d="M0,0 L6,2 L0,4" fill="#5fafaf" opacity="0.7" />
              </marker>
            </defs>

            {/* isometric ground grid */}
            {Array.from({ length: LINES }, (_, i) => {
              const v = ((i - (LINES - 1) / 2) / ((LINES - 1) / 2)) * GRID
              const a = isoProject(v, -GRID, 0)
              const b = isoProject(v, GRID, 0)
              return <line key={`gx${i}`} x1={CX + a.sx} y1={CY + a.sy} x2={CX + b.sx} y2={CY + b.sy}
                stroke="#5f87af" strokeWidth={0.4} opacity={i === (LINES - 1) / 2 ? 0.35 : 0.15} />
            })}
            {Array.from({ length: LINES }, (_, i) => {
              const v = ((i - (LINES - 1) / 2) / ((LINES - 1) / 2)) * GRID
              const a = isoProject(-GRID, v, 0)
              const b = isoProject(GRID, v, 0)
              return <line key={`gy${i}`} x1={CX + a.sx} y1={CY + a.sy} x2={CX + b.sx} y2={CY + b.sy}
                stroke="#5f87af" strokeWidth={0.4} opacity={i === (LINES - 1) / 2 ? 0.35 : 0.15} />
            })}

            {/* origin axes */}
            {(() => {
              const o = isoProject(0, 0, 0)
              const ax = isoProject(20, 0, 0)
              const ay = isoProject(0, 20, 0)
              const az = isoProject(0, 0, 20)
              return (
                <>
                  <line x1={CX + o.sx} y1={CY + o.sy} x2={CX + ax.sx} y2={CY + ax.sy} stroke="#d75f5f" strokeWidth={1} opacity={0.5} />
                  <text x={CX + ax.sx + 4} y={CY + ax.sy + 1} fontSize={8} fill="#d75f5f" opacity={0.6} fontFamily="monospace">X</text>
                  <line x1={CX + o.sx} y1={CY + o.sy} x2={CX + ay.sx} y2={CY + ay.sy} stroke="#5faf5f" strokeWidth={1} opacity={0.5} />
                  <text x={CX + ay.sx - 10} y={CY + ay.sy + 1} fontSize={8} fill="#5faf5f" opacity={0.6} fontFamily="monospace">Y</text>
                  <line x1={CX + o.sx} y1={CY + o.sy} x2={CX + az.sx} y2={CY + az.sy} stroke="#5fafaf" strokeWidth={1} opacity={0.5} />
                  <text x={CX + az.sx + 4} y={CY + az.sy + 1} fontSize={8} fill="#5fafaf" opacity={0.6} fontFamily="monospace">Z</text>
                </>
              )
            })()}

            {/* ground shadow */}
            {(() => {
              const sh = isoProject(gx, gy, 0)
              return <ellipse cx={CX + sh.sx} cy={CY + sh.sy} rx={8} ry={3} fill="#5f87af" opacity={0.08} />
            })()}

            {/* heading line on ground plane */}
            {(() => {
              const from = isoProject(gx, gy, 0)
              const to = isoProject(gx + Math.cos(yaw) * 20, gy + Math.sin(yaw) * 20, 0)
              return <line x1={CX + from.sx} y1={CY + from.sy} x2={CX + to.sx} y2={CY + to.sy}
                stroke="#afaf5f" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.3} />
            })()}

            {/* velocity vector */}
            {Math.abs(lin.x) > 0.01 && (() => {
              const from = isoProject(gx, gy, 0)
              const to = isoProject(gx + Math.cos(yaw) * lin.x * 30, gy + Math.sin(yaw) * lin.x * 30, 0)
              return <line x1={CX + from.sx} y1={CY + from.sy} x2={CX + to.sx} y2={CY + to.sy}
                stroke="#5faf5f" strokeWidth={1.2} opacity={0.7} markerEnd="url(#arrowHead)" />
            })()}

            {/* 3D robot */}
            <g transform={`translate(${robotX}, ${robotY})`}>
              <Robot3D yaw={yaw} linX={lin.x} angZ={ang.z} />
            </g>

            {/* position label */}
            <text x={robotX} y={robotY + 18} fontSize={8} fill="#5fafaf" textAnchor="middle" fontFamily="monospace" opacity={0.6}>
              ({formatNum(pos.x, 2)}, {formatNum(pos.y, 2)}, {formatNum(pos.z, 2)})
            </text>
          </svg>
        </div>

        {/* telemetry readout */}
        <div className="w-36 border-l p-2 text-xs space-y-1">
          <div className="text-muted-foreground text-[10px] border-b pb-1 mb-1">POSE /amcl_pose</div>
          <TelemetryRow label="x" value={formatNum(pos.x)} color="text-term-cyan" />
          <TelemetryRow label="y" value={formatNum(pos.y)} color="text-term-cyan" />
          <TelemetryRow label="z" value={formatNum(pos.z)} color="text-term-cyan" />
          <TelemetryRow label="yaw" value={formatNum(yaw * 180 / Math.PI, 1) + '\u00b0'} color="text-term-yellow" />
          <div className="border-t pt-1 mt-1" />
          <div className="text-muted-foreground text-[10px] border-b pb-1 mb-1">ODOM /odom</div>
          {odomPos && <>
            <TelemetryRow label="pos.x" value={formatNum(odomPos.x)} />
            <TelemetryRow label="pos.y" value={formatNum(odomPos.y)} />
          </>}
          <TelemetryRow label="lin.x" value={formatNum(lin.x)} color="text-term-green" />
          <TelemetryRow label="lin.y" value={formatNum(lin.y)} color="text-term-green" />
          <TelemetryRow label="ang.z" value={formatNum(ang.z)} color="text-term-yellow" />
          <div className="border-t pt-1 mt-1" />
          <div className="text-muted-foreground text-[10px] border-b pb-1 mb-1">CMD_VEL</div>
          <TelemetryRow label="lin.x" value={formatNum(cmdVelData?.linear?.x)} color="text-term-green" />
          <TelemetryRow label="lin.y" value={formatNum(cmdVelData?.linear?.y)} color="text-term-green" />
          <TelemetryRow label="ang.z" value={formatNum(cmdVelData?.angular?.z)} color="text-term-yellow" />
        </div>
      </div>
    </div>
  )
}



interface HeadState {
  current_position: number
  default_angle: number
  max_angle: number
  min_angle: number
}

function HeadPositionPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/mars/head/current_position', 'std_msgs/msg/String', 500)
  const [dragging, setDragging] = useState(false)
  const [sliderVal, setSliderVal] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sliderRef = useRef(0)

  let head: HeadState | null = null
  try { if (data?.data) head = JSON.parse(data.data) } catch { /* ignore */ }

  const pos = head?.current_position ?? 0
  const min = head?.min_angle ?? -25
  const max = head?.max_angle ?? 25

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // sync slider to reported position when not dragging
  useEffect(() => {
    if (!dragging) setSliderVal(pos)
  }, [pos, dragging])

  function startDrag(val: number) {
    setDragging(true)
    if (settleTimer.current) clearTimeout(settleTimer.current)
    setSliderVal(val)
    sliderRef.current = val
    intervalRef.current = setInterval(() => {
      publishRosbridge(url, '/mars/head/set_position', 'std_msgs/msg/Int32', { data: Math.round(sliderRef.current) })
    }, 100)
  }

  function onDrag(val: number) {
    setSliderVal(val)
    sliderRef.current = val
  }

  function stopDrag() {
    if (intervalRef.current) clearInterval(intervalRef.current)
    publishRosbridge(url, '/mars/head/set_position', 'std_msgs/msg/Int32', { data: Math.round(sliderRef.current) })
    // keep slider pinned until the servo catches up
    settleTimer.current = setTimeout(() => setDragging(false), 1500)
  }

  function resetHead() {
    const angle = head?.default_angle ?? 0
    publishRosbridge(url, '/mars/head/set_position', 'std_msgs/msg/Int32', { data: Math.round(angle) })
  }

  return (
    <div className="tui-panel bg-card flex flex-col w-16 shrink-0">
      <PanelHeader title="HEAD" />
      <div className="flex-1 flex flex-col items-center py-2 gap-1">
        <span className="text-[10px] text-muted-foreground">{formatNum(max, 0)}°</span>
        <input
          type="range"
          min={min}
          max={max}
          step={0.5}
          value={sliderVal}
          onMouseDown={(e) => startDrag(parseFloat((e.target as HTMLInputElement).value))}
          onTouchStart={(e) => startDrag(parseFloat((e.target as HTMLInputElement).value))}
          onChange={(e) => onDrag(parseFloat(e.target.value))}
          onMouseUp={stopDrag}
          onTouchEnd={stopDrag}
          className="flex-1 accent-[#5fafaf] bg-secondary rounded-sm appearance-auto cursor-pointer"
          style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
        />
        <span className="text-[10px] text-muted-foreground">{formatNum(min, 0)}°</span>
        <span className="text-[10px] text-term-cyan font-bold">{head ? formatNum(pos, 1) + '°' : '--'}</span>
        <button
          onClick={resetHead}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          reset
        </button>
      </div>
    </div>
  )
}


interface SkillMsg { id: string; skill_type?: string; display_name?: string; name?: string }
interface AvailableSkillsMsg { skills: SkillMsg[] }

interface SkillResult { ok: boolean; message: string; ts: string }

// Skills that require inline parameter inputs before running
const SKILL_PARAMS: Record<string, { label: string; key: string; placeholder: string }[]> = {
  'navigate_to_position': [
    { label: 'X', key: 'x', placeholder: '0.0' },
    { label: 'Y', key: 'y', placeholder: '0.0' },
    { label: 'θ', key: 'theta', placeholder: '0.0' },
  ],
}

function skillParamKey(id: string): string | null {
  for (const key of Object.keys(SKILL_PARAMS)) {
    if (id.includes(key)) return key
  }
  return null
}

function SkillsPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<AvailableSkillsMsg>(
    url, '/brain/available_skills', 'brain_messages/msg/AvailableSkills',
  )
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, SkillResult>>({})
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})

  const skills = data?.skills ?? []

  function setParam(skillId: string, key: string, value: string) {
    setParams(p => ({ ...p, [skillId]: { ...p[skillId], [key]: value } }))
  }

  function run(skillId: string) {
    if (running) return
    setRunning(skillId)
    setResults((r) => ({ ...r, [skillId]: { ok: false, message: 'running…', ts: new Date().toLocaleTimeString() } }))

    const paramKey = skillParamKey(skillId)
    const inputs: Record<string, unknown> = {}
    if (paramKey) {
      for (const field of SKILL_PARAMS[paramKey]) {
        const raw = params[skillId]?.[field.key] ?? ''
        const num = parseFloat(raw)
        inputs[field.key] = isNaN(num) ? 0 : num
      }
    }

    sendActionGoal(url, skillId, (ok, message) => {
      setResults((r) => ({ ...r, [skillId]: { ok, message, ts: new Date().toLocaleTimeString() } }))
      setRunning(null)
    }, inputs)
  }

  const inputCls = 'w-14 bg-background border border-border px-1 py-0.5 text-[10px] font-mono focus:outline-none focus:border-term-cyan'

  return (
    <div className="tui-panel bg-card flex flex-col col-span-2 row-span-2">
      <PanelHeader title="SKILLS" right={skills.length ? `${skills.length} available` : 'loading…'} />
      <div className="flex flex-col divide-y text-xs max-h-48 overflow-y-auto">
        {skills.length === 0 && (
          <div className="px-3 py-3 text-muted-foreground">no skills received</div>
        )}
        {skills.map((sk) => {
          const id = sk.id ?? sk.skill_type ?? '?'
          const name = sk.display_name ?? sk.name ?? id
          const res = results[id]
          const isRunning = running === id
          const paramKey = skillParamKey(id)
          const fields = paramKey ? SKILL_PARAMS[paramKey] : null

          return (
            <div key={id} className="px-3 py-1.5 space-y-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-foreground truncate">{name}</div>
                  <div className="text-muted-foreground text-[10px] truncate">{id}</div>
                </div>
                {fields && (
                  <div className="flex items-center gap-1 shrink-0">
                    {fields.map(f => (
                      <div key={f.key} className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] text-muted-foreground">{f.label}</span>
                        <input
                          className={inputCls}
                          placeholder={f.placeholder}
                          value={params[id]?.[f.key] ?? ''}
                          onChange={e => setParam(id, f.key, e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && run(id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => run(id)}
                  disabled={!!running}
                  className="shrink-0 text-[10px] px-2 py-0.5 border border-term-green text-term-green bg-transparent hover:bg-term-green/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                >
                  {isRunning ? '…' : '▶ RUN'}
                </button>
              </div>
              {res && (
                <div className={`text-[10px] ${res.message === 'running…' ? 'text-term-cyan' : res.ok ? 'text-term-green' : 'text-term-red'}`}>
                  {res.ts} — {res.message}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GotoPanel({ url }: { url: string }) {
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [theta, setTheta] = useState('0')
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [running, setRunning] = useState(false)

  function send() {
    const px = parseFloat(x)
    const py = parseFloat(y)
    const pt = parseFloat(theta)
    if (isNaN(px) || isNaN(py)) { setStatus({ ok: false, msg: 'invalid x or y' }); return }
    setRunning(true)
    setStatus({ ok: true, msg: `sending → (${px}, ${py}, θ=${isNaN(pt) ? 0 : pt})…` })
    sendActionGoal(url, 'innate-os/goto_coordinates', (ok, msg) => {
      setStatus({ ok, msg: msg || (ok ? 'done' : 'failed') })
      setRunning(false)
    }, { x: px, y: py, theta: isNaN(pt) ? 0 : pt })
  }

  const inputCls = 'w-full bg-background border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-term-cyan'

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="GO TO COORDINATES" />
      <div className="p-2 space-y-2 text-xs">
        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <div className="text-muted-foreground mb-0.5">X (m)</div>
            <input className={inputCls} placeholder="0.0" value={x} onChange={e => setX(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
          </div>
          <div>
            <div className="text-muted-foreground mb-0.5">Y (m)</div>
            <input className={inputCls} placeholder="0.0" value={y} onChange={e => setY(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
          </div>
          <div>
            <div className="text-muted-foreground mb-0.5">θ (rad)</div>
            <input className={inputCls} placeholder="0.0" value={theta} onChange={e => setTheta(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
          </div>
        </div>
        <button
          onClick={send}
          disabled={running}
          className="w-full py-1 border border-term-green text-term-green bg-transparent hover:bg-term-green/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs"
        >
          {running ? 'NAVIGATING…' : '▶ GO'}
        </button>
        {status && (
          <div className={`font-mono truncate ${status.ok ? 'text-term-green' : 'text-term-red'}`}>
            {status.msg}
          </div>
        )}
      </div>
    </div>
  )
}

function SkillUpdatePanel({ url }: { url: string }) {
  const [text, setText] = useState('')

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/brain/skill_status_update', 'std_msgs/msg/String', { data: text.trim() })
    setText('')
  }

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="SKILL UPDATE" />
      <div className="p-2 space-y-2 text-xs">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="status update..."
          className="w-full bg-background border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-term-cyan"
        />
        <button
          onClick={send}
          className="w-full py-1 border border-term-green text-term-green bg-transparent hover:bg-term-green/10 font-mono text-xs"
        >
          ▶ PUBLISH
        </button>
      </div>
    </div>
  )
}

interface ChatMessage {
  text: string
  sender: 'user' | 'agent'
  timestamp: number
}

const CHAT_NOISE = /^frame #\d|^inference|^obs age|^\s*$/

function parseChatMsg(raw: string | undefined, fallbackSender: 'user' | 'agent'): ChatMessage | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (fallbackSender === 'agent') {
      if ('to_tell_user' in parsed) {
        if (!parsed.to_tell_user) return null
        return { text: parsed.to_tell_user, sender: 'agent', timestamp: Date.now() / 1000 }
      }
    }
    const text = parsed.text ?? raw
    if (CHAT_NOISE.test(text)) return null
    return {
      text,
      sender: parsed.sender ?? fallbackSender,
      timestamp: parsed.timestamp ?? Date.now() / 1000,
    }
  } catch {
    if (CHAT_NOISE.test(raw)) return null
    return { text: raw, sender: fallbackSender, timestamp: Date.now() / 1000 }
  }
}

function formatChatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ChatPanel({ url }: { url: string }) {
  const chatIn = useRosbridgeTopic<{ data?: string }>(url, '/brain/chat_in', 'std_msgs/msg/String', 0)
  const chatOut = useRosbridgeTopic<{ data?: string }>(url, '/brain/chat_out', 'std_msgs/msg/String', 0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastInRef = useRef<string | null>(null)
  const lastOutRef = useRef<string | null>(null)

  useEffect(() => {
    const raw = chatIn.data?.data
    if (raw && raw !== lastInRef.current) {
      lastInRef.current = raw
      const msg = parseChatMsg(raw, 'user')
      if (msg) setMessages(prev => [...prev, msg])
    }
  }, [chatIn.data?.data])

  useEffect(() => {
    const raw = chatOut.data?.data
    if (raw && raw !== lastOutRef.current) {
      lastOutRef.current = raw
      const msg = parseChatMsg(raw, 'agent')
      if (msg) setMessages(prev => [...prev, msg])
    }
  }, [chatOut.data?.data])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', {
      data: JSON.stringify({ text: text.trim(), sender: 'user', timestamp: Date.now() / 1000 }),
    })
    setText('')
  }

  return (
    <div className="tui-panel bg-card flex flex-col">
      <PanelHeader title="CHAT" right={messages.length > 0 ? `${messages.length} msgs` : undefined} />
      <div ref={scrollRef} className="max-h-64 overflow-y-auto text-xs font-mono flex-1">
        {messages.length === 0 ? (
          <div className="px-2 py-4 text-muted-foreground text-center">no messages</div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="flex gap-2 px-2 py-0.5 hover:opacity-80/50 leading-tight">
              <span className="text-muted-foreground shrink-0">{formatChatTs(msg.timestamp)}</span>
              <span className={`shrink-0 ${msg.sender === 'user' ? 'text-term-cyan' : 'text-term-green'}`}>
                {msg.sender === 'user' ? 'user>' : 'agent>'}
              </span>
              <span className="text-foreground">{msg.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="border-t px-2 py-1.5 flex gap-2 items-center">
        <span className="text-xs text-term-cyan shrink-0">{'>'}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="send message..."
          className="flex-1 bg-transparent text-foreground text-xs outline-none placeholder:text-muted-foreground/50 font-mono"
        />
        <button
          onClick={send}
          disabled={!text.trim()}
          className="text-xs px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          send
        </button>
      </div>
    </div>
  )
}

// @ts-expect-error not yet wired
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function WaypointsPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/brain/memory_positions', 'std_msgs/msg/String', 2000)
  let waypoints: Array<{ name: string }> = []
  try {
    if (data?.data) waypoints = JSON.parse(data.data)
  } catch { /* ignore */ }
  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="WAYPOINTS" right={waypoints.length > 0 ? `${waypoints.length}` : undefined} />
      <div className="p-2 text-xs max-h-24 overflow-y-auto space-y-0.5">
        {waypoints.length > 0 ? waypoints.map((w, i) => (
          <div key={i} className="text-term-blue">{w.name ?? JSON.stringify(w)}</div>
        )) : (
          <span className="text-muted-foreground">--</span>
        )}
      </div>
    </div>
  )
}

// -- controls --

const LIN_SPEED = 0.3
const ANG_SPEED = 0.5

function DrivePanel({ url }: { url: string }) {
  const [active, setActive] = useState(false)
  const [keys, setKeys] = useState({ w: false, a: false, s: false, d: false })
  const keysRef = useRef(keys)
  keysRef.current = keys
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!active) return

    function onKey(e: KeyboardEvent, down: boolean) {
      const k = e.key.toLowerCase()
      if (['w', 'a', 's', 'd'].includes(k)) {
        e.preventDefault()
        setKeys((prev) => ({ ...prev, [k]: down }))
      }
    }
    const onDown = (e: KeyboardEvent) => onKey(e, true)
    const onUp = (e: KeyboardEvent) => onKey(e, false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)

    intervalRef.current = setInterval(() => {
      const k = keysRef.current
      const lin = (k.w ? 1 : 0) - (k.s ? 1 : 0)
      const ang = (k.a ? 1 : 0) - (k.d ? 1 : 0)
      publishRosbridge(url, '/cmd_vel', 'geometry_msgs/msg/Twist', {
        linear: { x: lin * LIN_SPEED, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: ang * ANG_SPEED },
      })
    }, 100)

    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      if (intervalRef.current) clearInterval(intervalRef.current)
      // send stop
      publishRosbridge(url, '/cmd_vel', 'geometry_msgs/msg/Twist', {
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      })
      setKeys({ w: false, a: false, s: false, d: false })
    }
  }, [active, url])

  const k = keys
  const lin = (k.w ? 1 : 0) - (k.s ? 1 : 0)
  const ang = (k.a ? 1 : 0) - (k.d ? 1 : 0)

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="DRIVE" />
      <div className="p-4 flex flex-col items-center justify-center gap-3">
        <button
          onClick={() => setActive((a) => !a)}
          className={`text-xs px-3 py-1 font-bold ${active
            ? 'tui-btn-active bg-term-red text-primary-foreground'
            : 'tui-hatch-dense bg-primary text-primary-foreground hover:opacity-80'
            }`}
        >
          {active ? 'RELEASE' : 'CONTROL'}
        </button>

        <div className="grid grid-cols-3 gap-2 w-36 select-none">
          {(['', 'w', '', 'a', 's', 'd'] as const).map((key, i) => {
            if (!key) return <div key={i} />
            const pressed = k[key]
            return (
              <div
                key={key}
                onMouseDown={() => active && setKeys(prev => ({ ...prev, [key]: true }))}
                onMouseUp={() => active && setKeys(prev => ({ ...prev, [key]: false }))}
                onMouseLeave={() => active && setKeys(prev => ({ ...prev, [key]: false }))}
                className={`text-center text-base font-bold border-2 py-2.5 rounded transition-colors cursor-pointer ${active
                  ? pressed
                    ? 'bg-term-green text-primary-foreground border-term-green shadow-[0_0_10px_rgba(95,175,95,0.6)]'
                    : 'text-foreground border-muted-foreground/60 hover:bg-accent/40 hover:border-muted-foreground'
                  : 'text-muted-foreground/30 border-muted-foreground/20'
                  }`}
              >
                {key.toUpperCase()}
              </div>
            )
          })}
        </div>
        <div className="text-[10px] text-muted-foreground">
          lin:{(lin * LIN_SPEED).toFixed(1)} ang:{(ang * ANG_SPEED).toFixed(1)}
        </div>
      </div>
    </div>
  )
}


const ARM_JOINTS = [
  { name: 'J1 base', min: -1.5708, max: 1.5708 },
  { name: 'J2 shldr', min: -1.5708, max: 1.22 },
  { name: 'J3 elbow', min: -1.5708, max: 1.7453 },
  { name: 'J4 wrist', min: -1.9199, max: 1.7453 },
  { name: 'J5 roll', min: -1.5708, max: 1.5708 },
  { name: 'J6 grip', min: -0.8727, max: 0.3491 },
]
const ARM_STEP = 0.03

// @ts-expect-error not yet wired into layout
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ArmControlPanel({ url }: { url: string }) {
  const { data: armState } = useRosbridgeTopic<{
    position?: number[]
  }>(url, '/mars/arm/state', 'sensor_msgs/msg/JointState', 100)

  const [active, setActive] = useState(false)
  const [selectedJoint, setSelectedJoint] = useState(0)
  const [joints, setJoints] = useState<number[]>([0, 0, 0, 0, 0, 0])
  const [keysDown, setKeysDown] = useState({ up: false, down: false })
  const jointsRef = useRef(joints)
  const keysRef = useRef(keysDown)
  const selectedRef = useRef(selectedJoint)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncedRef = useRef(false)
  jointsRef.current = joints
  keysRef.current = keysDown
  selectedRef.current = selectedJoint

  // sync from arm state when not active
  useEffect(() => {
    if (!active && armState?.position && armState.position.length >= 6) {
      setJoints(armState.position.slice(0, 6))
      syncedRef.current = true
    }
  }, [armState?.position, active])

  // sync once when activating
  useEffect(() => {
    if (active && armState?.position && armState.position.length >= 6 && !syncedRef.current) {
      setJoints(armState.position.slice(0, 6))
      syncedRef.current = true
    }
  }, [active, armState?.position])

  useEffect(() => {
    if (!active) {
      syncedRef.current = false
      return
    }

    function onKey(e: KeyboardEvent, down: boolean) {
      const k = e.key
      if (k >= '1' && k <= '6') {
        e.preventDefault()
        if (down) setSelectedJoint(parseInt(k) - 1)
        return
      }
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault()
        setKeysDown(prev => ({
          ...prev,
          [k === 'ArrowUp' ? 'up' : 'down']: down,
        }))
      }
    }
    const onDown = (e: KeyboardEvent) => onKey(e, true)
    const onUp = (e: KeyboardEvent) => onKey(e, false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)

    intervalRef.current = setInterval(() => {
      const k = keysRef.current
      const dir = (k.up ? 1 : 0) - (k.down ? 1 : 0)
      if (dir !== 0) {
        const j = selectedRef.current
        const cfg = ARM_JOINTS[j]
        const newJoints = [...jointsRef.current]
        newJoints[j] = Math.max(cfg.min, Math.min(cfg.max, newJoints[j] + dir * ARM_STEP))
        setJoints(newJoints)
        jointsRef.current = newJoints
      }
      publishRosbridge(url, '/mars/arm/commands', 'std_msgs/msg/Float64MultiArray', {
        layout: { dim: [], data_offset: 0 },
        data: jointsRef.current,
      })
    }, 50)

    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      if (intervalRef.current) clearInterval(intervalRef.current)
      setKeysDown({ up: false, down: false })
    }
  }, [active, url])

  const pos = armState?.position

  return (
    <div className="tui-panel bg-card col-span-2">
      <PanelHeader title="ARM CONTROL" right={active ? 'ACTIVE' : undefined} />
      <div className="p-3 flex gap-4">
        {/* joint list */}
        <div className="flex-1 text-xs font-mono space-y-0.5">
          {ARM_JOINTS.map((j, i) => {
            const cur = pos?.[i] ?? 0
            const target = joints[i]
            const pct = ((target - j.min) / (j.max - j.min)) * 100
            const isSelected = active && selectedJoint === i
            return (
              <div
                key={i}
                onClick={() => active && setSelectedJoint(i)}
                className={`flex items-center gap-2 px-1 py-0.5 cursor-pointer rounded-sm transition-colors ${isSelected ? 'bg-accent' : 'hover:opacity-80/50'}`}
              >
                <span className={`w-4 shrink-0 ${isSelected ? 'text-term-cyan' : 'text-muted-foreground'}`}>{i + 1}</span>
                <span className={`w-14 shrink-0 ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>{j.name}</span>
                <div className="flex-1 h-2 bg-secondary rounded-sm relative overflow-hidden">
                  <div
                    className={`absolute top-0 bottom-0 w-1 rounded-sm ${isSelected ? 'bg-term-cyan' : 'bg-muted-foreground/50'}`}
                    style={{ left: `calc(${pct}% - 2px)` }}
                  />
                </div>
                <span className={`w-12 text-right shrink-0 ${isSelected ? 'text-term-cyan' : 'text-muted-foreground'}`}>
                  {formatNum(cur, 2)}
                </span>
              </div>
            )
          })}
        </div>

        {/* controls */}
        <div className="flex flex-col items-center gap-2 w-20">
          <button
            onClick={() => setActive(a => !a)}
            className={`text-xs px-3 py-1 font-bold ${active
              ? 'bg-term-red text-primary-foreground'
              : 'bg-primary text-primary-foreground hover:opacity-80'
              }`}
          >
            {active ? 'RELEASE' : 'CONTROL'}
          </button>

          <div className="grid grid-cols-1 gap-1 w-8">
            <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? keysDown.up ? 'bg-term-cyan text-primary-foreground border-term-cyan' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>{'\u2191'}</div>
            <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? keysDown.down ? 'bg-term-cyan text-primary-foreground border-term-cyan' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>{'\u2193'}</div>
          </div>

          <div className="text-[10px] text-muted-foreground text-center">
            <div>1-6: joint</div>
            <div>{'\u2191\u2193'}: move</div>
          </div>

          <div className="grid grid-cols-6 gap-0.5 w-full">
            {ARM_JOINTS.map((_, i) => (
              <div
                key={i}
                onClick={() => active && setSelectedJoint(i)}
                className={`text-center text-[9px] border px-0 py-0.5 cursor-pointer transition-colors ${active && selectedJoint === i
                  ? 'bg-term-cyan text-primary-foreground border-term-cyan'
                  : active
                    ? 'text-muted-foreground border-muted-foreground/50'
                    : 'text-muted-foreground/30 border-muted-foreground/20'
                  }`}
              >
                {i + 1}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}



// @ts-expect-error not yet wired
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function WaypointSendPanel({ url }: { url: string }) {
  const [text, setText] = useState('')

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/brain/memory_positions', 'std_msgs/msg/String', { data: text.trim() })
    setText('')
  }

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="SEND WAYPOINTS" />
      <div className="p-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder='[{"name":"home","x":0,"y":0}]'
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary"
        />
        <button onClick={send} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:opacity-80">
          send
        </button>
      </div>
    </div>
  )
}

// -- lidar scan --

interface LaserScanMsg {
  angle_min: number
  angle_max: number
  angle_increment: number
  range_min: number
  range_max: number
  ranges: number[]
}

function LidarPanel({ url, paused }: { url: string; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [viewRange, setViewRange] = useState<number>(2)
  const { data } = useRosbridgeTopic<LaserScanMsg>(url, paused ? '' : '/scan', 'sensor_msgs/msg/LaserScan', 500)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data?.ranges) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    const cx = W / 2
    const cy = H / 2

    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, W, H)

    // range rings
    const maxRange = Math.min(data.range_max, viewRange)
    const ringCount = 4
    ctx.strokeStyle = '#303030'
    ctx.lineWidth = 0.5
    for (let i = 1; i <= ringCount; i++) {
      const r = (i / ringCount) * (Math.min(cx, cy) - 10)
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }

    // crosshair
    ctx.strokeStyle = '#303030'
    ctx.beginPath()
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
    ctx.moveTo(0, cy); ctx.lineTo(W, cy)
    ctx.stroke()

    // range labels
    ctx.font = '8px monospace'
    ctx.fillStyle = '#6c6c6c'
    for (let i = 1; i <= ringCount; i++) {
      const r = (i / ringCount) * (Math.min(cx, cy) - 10)
      const label = ((i / ringCount) * maxRange).toFixed(1) + 'm'
      ctx.fillText(label, cx + 2, cy - r + 10)
    }

    // scan points
    const scale = (Math.min(cx, cy) - 10) / maxRange
    const { angle_min, angle_increment, ranges } = data

    ctx.beginPath()
    let started = false
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (!isFinite(r) || r < data.range_min || r > maxRange) continue
      const angle = angle_min + i * angle_increment
      // ROS: x=forward, y=left. Canvas: x=right, y=down
      const px = cx - Math.sin(angle) * r * scale
      const py = cy - Math.cos(angle) * r * scale
      if (!started) { ctx.moveTo(px, py); started = true }
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#5faf5f'
    ctx.lineWidth = 1
    ctx.stroke()

    // individual points
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (!isFinite(r) || r < data.range_min || r > maxRange) continue
      const angle = angle_min + i * angle_increment
      const px = cx - Math.sin(angle) * r * scale
      const py = cy - Math.cos(angle) * r * scale

      // color by distance
      const norm = r / maxRange
      const red = Math.floor(norm * 215)
      const green = Math.floor((1 - norm) * 175)
      ctx.fillStyle = `rgb(${red},${green},95)`
      ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5)
    }

    // robot marker
    ctx.fillStyle = '#5f87af'
    ctx.beginPath()
    ctx.moveTo(cx, cy - 6)
    ctx.lineTo(cx - 4, cy + 4)
    ctx.lineTo(cx + 4, cy + 4)
    ctx.closePath()
    ctx.fill()

    // info
    ctx.fillStyle = '#6c6c6c'
    ctx.font = '8px monospace'
    ctx.fillText(`${ranges.length} pts`, 4, 10)
  }, [data, viewRange])

  return (
    <div className="tui-panel bg-card w-[310px] shrink-0">
      <PanelHeader title="LIDAR" right={`${viewRange}m /scan`} />
      <div className="p-1">
        <canvas ref={canvasRef} width={298} height={298} className="w-full" style={{ aspectRatio: '1' }} />
      </div>
      <div className="border-t px-2 py-1 flex gap-1 text-[10px]">
        {[2, 4, 8].map((r) => (
          <button
            key={r}
            onClick={() => setViewRange(r)}
            className={`px-2 py-0.5 ${viewRange === r ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
          >
            {r}m
          </button>
        ))}
      </div>
    </div>
  )
}

// -- event log --

function EventRow({ event }: { event: AgentEvent }) {
  const levelClass = LEVEL_STYLES[event.level] ?? 'text-foreground'
  const typeClass = TYPE_STYLES[event.type] ?? 'text-muted-foreground'
  return (
    <div className="flex gap-2 px-2 py-0.5 hover:opacity-80/50 leading-tight">
      <span className="text-muted-foreground shrink-0">{formatTs(event.ts)}</span>
      <span className={`shrink-0 uppercase font-bold ${levelClass}`}>{event.level.padEnd(5)}</span>
      <span className={`shrink-0 ${typeClass}`}>[{event.type}]</span>
      <span className="text-foreground">{event.msg}</span>
    </div>
  )
}

// -- live location track from odom --

// View spans ±TRACK_RANGE meters from origin.
const TRACK_RANGE = 4  // meters per half-side

function LiveLocationTrack({ url }: { url: string }) {
  // /amcl_pose = map frame — same coordinate system as navigate_to_position
  const { data: amcl } = useRosbridgeTopic<Record<string, unknown>>(url, '/amcl_pose', 'geometry_msgs/msg/PoseWithCovarianceStamped', 200)
  const trailRef = useRef<{ x: number; y: number }[]>([])
  const [, setTick] = useState(0)

  const poseData = amcl as { pose?: { pose?: { position?: { x: number; y: number }; orientation?: { x: number; y: number; z: number; w: number } } } } | null
  const rawPos = poseData?.pose?.pose?.position
  const rawOri = poseData?.pose?.pose?.orientation
  const rx = typeof rawPos?.x === 'number' ? rawPos.x : null
  const ry = typeof rawPos?.y === 'number' ? rawPos.y : null

  useEffect(() => {
    if (rx === null || ry === null) return
    const trail = trailRef.current
    const last = trail[trail.length - 1]
    if (!last || Math.hypot(rx - last.x, ry - last.y) > 0.03) {
      trail.push({ x: rx, y: ry })
      if (trail.length > 600) trail.shift()
      setTick(n => n + 1)
    }
  }, [rx, ry])

  // SVG 100×100: world (0,0) always maps to (50,50)
  const scale = 100 / (2 * TRACK_RANGE)
  const toSvg = (wx: number, wy: number) => ({
    sx: 50 + wx * scale,
    sy: 50 - wy * scale,   // flip Y
  })

  let yaw = 0
  if (rawOri) {
    const o = rawOri
    yaw = Math.atan2(2 * (o.w * o.z + o.x * o.y), 1 - 2 * (o.y ** 2 + o.z ** 2))
  }

  const trail = trailRef.current
  const robotSvg = rx !== null ? toSvg(rx, ry!) : null

  // grid lines at integer meters relative to origin
  const gridLines = []
  const minG = Math.floor(-TRACK_RANGE)
  const maxG = Math.ceil(TRACK_RANGE)
  for (let d = minG; d <= maxG; d++) {
    const gx = 50 + d * scale
    const gy = 50 + d * scale
    const isMajor = d === 0
    gridLines.push(
      <line key={`gx${d}`} x1={gx} y1={0} x2={gx} y2={100} stroke={isMajor ? '#444' : '#1e1e1e'} strokeWidth={isMajor ? 0.6 : 0.3} />,
      <line key={`gy${d}`} x1={0} y1={gy} x2={100} y2={gy} stroke={isMajor ? '#444' : '#1e1e1e'} strokeWidth={isMajor ? 0.6 : 0.3} />,
    )
    if (d !== 0) {
      gridLines.push(
        <text key={`lx${d}`} x={gx} y={98} fontSize={2.8} fill="#444" textAnchor="middle" fontFamily="monospace">{d}</text>,
        <text key={`ly${d}`} x={1.5} y={gy + 1} fontSize={2.8} fill="#444" fontFamily="monospace">{-d}</text>,
      )
    }
  }

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {gridLines}
      {/* trail */}
      {trail.length > 1 && trail.slice(0, -1).map((p, i) => {
        const { sx: x1, sy: y1 } = toSvg(p.x, p.y)
        const { sx: x2, sy: y2 } = toSvg(trail[i + 1].x, trail[i + 1].y)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#5f87af" strokeWidth={1} opacity={0.2 + (i / trail.length) * 0.7} />
      })}
      {/* robot dot */}
      {robotSvg ? <>
        <circle cx={robotSvg.sx} cy={robotSvg.sy} r={3} fill="#5f87af" />
        <line
          x1={robotSvg.sx} y1={robotSvg.sy}
          x2={robotSvg.sx + Math.cos(yaw) * 6}
          y2={robotSvg.sy - Math.sin(yaw) * 6}
          stroke="#7df" strokeWidth={1.5}
        />
        <text x={robotSvg.sx} y={robotSvg.sy - 4} fontSize={3.5} fill="#5f87af" textAnchor="middle" fontFamily="monospace">
          ({rx!.toFixed(2)}, {ry!.toFixed(2)})
        </text>
      </> : (
        <text x={50} y={50} fontSize={5} fill="#444" textAnchor="middle" fontFamily="monospace">no odom</text>
      )}
    </svg>
  )
}

const OCC_SIZE = 298
const OCC_RANGE = 8 // meters per half-side (16m total)
const OCC_RES = (OCC_RANGE * 2) / OCC_SIZE // meters per cell
const LOG_OCC = 0.4
const LOG_FREE = -0.12
const LOG_CLAMP = 6

function worldToGrid(wx: number, wy: number, originX: number, originY: number): [number, number] {
  const gx = Math.floor((wx - originX) / OCC_RES + OCC_SIZE / 2)
  const gy = Math.floor((wy - originY) / OCC_RES + OCC_SIZE / 2)
  return [gx, gy]
}

function inGrid(gx: number, gy: number): boolean {
  return gx >= 0 && gx < OCC_SIZE && gy >= 0 && gy < OCC_SIZE
}

function LidarOccupancy({ url, paused }: { url: string; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<Float32Array>(new Float32Array(OCC_SIZE * OCC_SIZE))
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const poseRef = useRef({ x: 0, y: 0, yaw: 0 })
  const frameRef = useRef(0)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  const { data: scanData } = useRosbridgeTopic<LaserScanMsg>(url, paused ? '' : '/scan', 'sensor_msgs/msg/LaserScan', 500)
  const { data: odomData } = useRosbridgeTopic<{
    pose?: { pose?: { position?: { x: number; y: number }; orientation?: { x: number; y: number; z: number; w: number } } }
  }>(url, '/odom', 'nav_msgs/msg/Odometry', 200)

  // update pose from odom
  useEffect(() => {
    if (!odomData?.pose?.pose) return
    const pos = odomData.pose.pose.position
    const ori = odomData.pose.pose.orientation
    if (!pos || !ori) return
    const yaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z))
    poseRef.current = { x: pos.x, y: pos.y, yaw }
    if (!originRef.current) {
      originRef.current = { x: pos.x, y: pos.y }
    }
  }, [odomData])

  // process scan in world frame
  useEffect(() => {
    if (!scanData?.ranges || pausedRef.current) return
    const origin = originRef.current
    if (!origin) return // need pose first

    const grid = gridRef.current
    const { x: rx, y: ry, yaw } = poseRef.current
    const { angle_min, angle_increment, ranges, range_min } = scanData

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (r == null || !isFinite(r) || r < range_min) continue
      const angle = yaw + angle_min + i * angle_increment
      const clampedR = Math.min(r, OCC_RANGE * 1.5)

      // world-frame hit point
      const hitWx = rx + Math.cos(angle) * clampedR
      const hitWy = ry + Math.sin(angle) * clampedR
      const [hgx, hgy] = worldToGrid(hitWx, hitWy, origin.x, origin.y)

      // raytrace from robot to hit in grid coords
      const [rgx, rgy] = worldToGrid(rx, ry, origin.x, origin.y)
      const ddx = hgx - rgx
      const ddy = hgy - rgy
      const steps = Math.max(Math.abs(ddx), Math.abs(ddy))
      if (steps === 0) continue

      for (let s = 0; s < steps; s++) {
        const gx = Math.floor(rgx + (ddx * s) / steps)
        const gy = Math.floor(rgy + (ddy * s) / steps)
        if (!inGrid(gx, gy)) continue
        const idx = gy * OCC_SIZE + gx
        grid[idx] = Math.max(-LOG_CLAMP, grid[idx] + LOG_FREE)
      }

      // mark hit as occupied
      if (r <= OCC_RANGE * 1.5 && inGrid(hgx, hgy)) {
        const idx = hgy * OCC_SIZE + hgx
        grid[idx] = Math.min(LOG_CLAMP, grid[idx] + LOG_OCC)
      }
    }

    frameRef.current++

    // render -- 1:1 pixel mapping (OCC_SIZE === canvas size)
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const S = OCC_SIZE
    const imgData = ctx.createImageData(S, S)

    for (let i = 0; i < grid.length; i++) {
      const v = grid[i]
      let cr: number, cg: number, cb: number
      if (v > 0.3) {
        const t = Math.min(1, v / LOG_CLAMP)
        cr = Math.floor(80 + t * 175)
        cg = cr; cb = cr
      } else if (v < -0.2) {
        cr = 18; cg = 18; cb = 20
      } else {
        cr = 10; cg = 10; cb = 12
      }
      imgData.data[i * 4] = cr
      imgData.data[i * 4 + 1] = cg
      imgData.data[i * 4 + 2] = cb
      imgData.data[i * 4 + 3] = 255
    }
    ctx.putImageData(imgData, 0, 0)

    // robot position on map
    const [botGx, botGy] = worldToGrid(rx, ry, origin.x, origin.y)

    // heading indicator
    ctx.strokeStyle = 'rgba(95,175,95,0.6)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(botGx, botGy)
    ctx.lineTo(botGx + Math.cos(-yaw + Math.PI / 2) * 14, botGy - Math.sin(-yaw + Math.PI / 2) * 14)
    ctx.stroke()

    // robot triangle
    ctx.fillStyle = '#5f87af'
    ctx.save()
    ctx.translate(botGx, botGy)
    ctx.rotate(-yaw + Math.PI / 2)
    ctx.beginPath()
    ctx.moveTo(0, -5)
    ctx.lineTo(-3, 4)
    ctx.lineTo(3, 4)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }, [scanData])

  return (
    <div className="tui-panel bg-card w-[310px] shrink-0">
      <PanelHeader title="LIDAR MAP" right={`${frameRef.current}`} />
      <div className="p-1">
        <canvas ref={canvasRef} width={OCC_SIZE} height={OCC_SIZE} className="w-full" style={{ aspectRatio: '1', imageRendering: 'pixelated' }} />
      </div>
    </div>
  )
}

// -- lidar group with shared pause --

function LidarGroup({ url }: { url: string }) {
  const [paused, setPaused] = useState(false)
  return (
    <div className="flex items-stretch gap-0">
      <LidarPanel url={url} paused={paused} />
      <button
        onClick={() => setPaused((p) => !p)}
        className={`border-y px-2 text-xs flex items-center ${paused ? 'tui-hatch-dense bg-term-yellow/10 text-term-yellow' : 'tui-hatch-subtle bg-card text-muted-foreground hover:text-foreground'
          }`}
      >
        {paused ? '>' : '||'}
      </button>
      <LidarOccupancy url={url} paused={paused} />
    </div>
  )
}


function SystemStatsPanel({ url }: { url: string }) {
  const { data: sysData } = useRosbridgeTopic<{ data?: string }>(url, '/robot/sys_stats', 'std_msgs/msg/String', 2000)
  const { data: batData } = useRosbridgeTopic<{
    voltage?: number
    percentage?: number
    current?: number
    temperature?: number
  }>(url, '/battery_state', 'sensor_msgs/msg/BatteryState', 1000)

  const stats = (() => {
    try { return sysData?.data ? JSON.parse(sysData.data) : null } catch { return null }
  })()

  const cpuPct: number | null = stats?.gpu?.cpu_avg_pct ?? null
  const gpuPct: number | null = stats?.gpu?.gpu_pct ?? null
  const ramPct: number | null = stats?.gpu?.ram_pct ?? stats?.memory?.used_pct ?? null
  const hottest: { zone: string; temp_c: number } | null = stats?.thermal?.hottest ?? null
  const load1m: number | null = stats?.cpu?.load_1m ?? null
  const powerMw: number | null = stats?.gpu?.power_mw ?? null

  const batPct = batData?.percentage != null ? Math.round(batData.percentage * 100) : null
  const voltage = batData?.voltage ?? null
  const current = batData?.current ?? null
  const batTemp = batData?.temperature ?? null

  const bar = (pct: number | null, danger = 80) => {
    const v = pct ?? 0
    const color = v > danger ? '#af5f5f' : v > danger * 0.65 ? '#afaf5f' : '#5faf5f'
    return (
      <div className="h-1.5 w-full bg-muted rounded-sm overflow-hidden">
        <div className="h-full rounded-sm transition-all" style={{ width: `${v}%`, backgroundColor: color }} />
      </div>
    )
  }

  const batBarColor = batPct == null ? '#333'
    : batPct > 60 ? '#5faf5f'
      : batPct > 30 ? '#afaf5f'
        : '#af5f5f'
  const batPctColor = batPct == null ? 'text-muted-foreground'
    : batPct > 60 ? 'text-term-green'
      : batPct > 30 ? 'text-term-yellow'
        : 'text-term-red'

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="SYSTEM STATS" right={batPct != null ? `bat ${batPct}%` : stats ? 'live' : 'no data'} />
      <div className="p-2 text-xs space-y-2">
        {/* battery */}
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-muted-foreground">BAT</span>
            <span className={batPctColor}>{batPct != null ? `${batPct}%` : '--'}</span>
          </div>
          <div className="h-1.5 w-full bg-muted rounded-sm overflow-hidden">
            <div className="h-full rounded-sm transition-all" style={{ width: `${batPct ?? 0}%`, backgroundColor: batBarColor }} />
          </div>
        </div>
        {(voltage != null || current != null || (batTemp != null && batTemp > 0)) && (
          <div className="flex gap-3 text-[10px]">
            {voltage != null && <span className="text-muted-foreground">V <span className="text-foreground">{voltage.toFixed(2)}</span></span>}
            {current != null && <span className="text-muted-foreground">A <span className="text-foreground">{current.toFixed(2)}</span></span>}
            {batTemp != null && batTemp > 0 && <span className="text-muted-foreground">T <span className={batTemp > 50 ? 'text-term-red' : 'text-foreground'}>{batTemp.toFixed(1)}{'\u00b0'}C</span></span>}
          </div>
        )}

        <div className="border-t my-1" />

        {/* system */}
        {stats ? <>
          <div>
            <div className="flex justify-between mb-0.5"><span className="text-muted-foreground">CPU</span><span className={cpuPct != null && cpuPct > 80 ? 'text-term-red' : 'text-term-green'}>{cpuPct != null ? `${cpuPct}%` : `load ${load1m?.toFixed(2) ?? '--'}`}</span></div>
            {bar(cpuPct)}
          </div>
          <div>
            <div className="flex justify-between mb-0.5"><span className="text-muted-foreground">GPU</span><span className={gpuPct != null && gpuPct > 80 ? 'text-term-red' : 'text-term-green'}>{gpuPct != null ? `${gpuPct}%` : '--'}</span></div>
            {bar(gpuPct)}
          </div>
          <div>
            <div className="flex justify-between mb-0.5"><span className="text-muted-foreground">RAM</span><span className="text-term-yellow">{ramPct != null ? `${ramPct}%` : '--'}</span></div>
            {bar(ramPct, 85)}
          </div>
          {hottest && <TelemetryRow label="temp" value={`${hottest.temp_c}\u00b0C (${hottest.zone})`} color={hottest.temp_c > 70 ? 'text-term-red' : hottest.temp_c > 50 ? 'text-term-yellow' : 'text-muted-foreground'} />}
          {powerMw != null && <TelemetryRow label="power" value={`${(powerMw / 1000).toFixed(1)} W`} />}
        </> : <span className="text-muted-foreground">run sys_stats_pub.py on robot</span>}
      </div>
    </div>
  )
}

function ImuAccelPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/robot/imu_odom', 'std_msgs/msg/String', 0)

  const parsed = (() => { try { return data?.data ? JSON.parse(data.data) : null } catch { return null } })()
  const xacc: number = parsed?.xacc ?? 0
  const yacc: number = parsed?.yacc ?? 0
  const zacc: number = parsed?.zacc ?? 0
  const pitch: number = parsed?.pitch ?? 0
  const roll: number = parsed?.roll ?? 0
  const yaw: number = parsed?.yaw ?? 0

  const MAX_MG = 2000

  const AccelBar = ({ val, color, label }: { val: number; color: string; label: string }) => {
    const pct = Math.min(Math.abs(val) / MAX_MG * 50, 50)
    const isNeg = val < 0
    return (
      <div className="space-y-0.5">
        <div className="flex justify-between text-[10px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono" style={{ color }}>{val > 0 ? '+' : ''}{val} mg</span>
        </div>
        <div className="h-2 w-full bg-muted rounded-sm relative overflow-hidden">
          <div className="absolute top-0 bottom-0 bg-muted-foreground/20" style={{ left: '50%', width: '1px' }} />
          <div
            className="absolute top-0 bottom-0 rounded-sm transition-all duration-75"
            style={{
              backgroundColor: color,
              width: `${pct}%`,
              left: isNeg ? `${50 - pct}%` : '50%',
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="tui-panel bg-card flex flex-col">
      <PanelHeader title="IMU ACCEL" right={parsed ? 'live pixhawk' : 'run imu_odom_pub.py'} />
      <div className="p-2 space-y-2 text-xs">
        {parsed ? <>
          <AccelBar val={xacc} color="#af5f5f" label="X (fwd)" />
          <AccelBar val={yacc} color="#5faf5f" label="Y (left)" />
          <AccelBar val={zacc} color="#5f87af" label="Z (up)" />
          <div className="border-t pt-1 mt-1 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
            <span>roll {roll > 0 ? '+' : ''}{roll.toFixed(1)}{'\u00b0'}</span>
            <span>pitch {pitch > 0 ? '+' : ''}{pitch.toFixed(1)}{'\u00b0'}</span>
            <span>yaw {yaw > 0 ? '+' : ''}{yaw.toFixed(1)}{'\u00b0'}</span>
          </div>
        </> : (
          <div className="text-muted-foreground text-center py-2">no data</div>
        )}
      </div>
    </div>
  )
}

// -- depth cloud (top-down XZ projection from PointCloud2) --

interface PCLField { name: string; offset: number; datatype: number; count: number }
interface PointCloud2Msg {
  height: number
  width: number
  fields: PCLField[]
  is_bigendian: boolean
  point_step: number
  row_step: number
  data: number[] | string
  is_dense: boolean
}

function decodePointCloudXZ(msg: PointCloud2Msg, sample = 20): [number, number][] {
  const { fields, point_step, data } = msg
  const xField = fields.find(f => f.name === 'x')
  const zField = fields.find(f => f.name === 'z')
  if (!xField || !zField) return []

  let bytes: Uint8Array
  if (typeof data === 'string') {
    const bin = atob(data)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else {
    bytes = new Uint8Array(data)
  }

  const view = new DataView(bytes.buffer)
  const points: [number, number][] = []
  const le = !msg.is_bigendian
  const total = Math.floor(bytes.length / point_step)

  for (let i = 0; i < total; i += sample) {
    const base = i * point_step
    const x = view.getFloat32(base + xField.offset, le)
    const z = view.getFloat32(base + zField.offset, le)
    if (isFinite(x) && isFinite(z) && z > 0 && z < 10) {
      points.push([x, z])
    }
  }
  return points
}

function DepthCloudPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<PointCloud2Msg>(
    url, '/mars/main_camera/points', 'sensor_msgs/msg/PointCloud2', 2000,
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pointCount, setPointCount] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width, h = canvas.height
    ctx.fillStyle = '#080808'
    ctx.fillRect(0, 0, w, h)

    const pts = decodePointCloudXZ(data, 15)
    setPointCount(pts.length)
    if (!pts.length) return

    const xScale = w / 6
    const zScale = h / 6
    const cx = w / 2

    for (const [x, z] of pts) {
      const px = cx + x * xScale
      const py = h - z * zScale
      if (px < 0 || px > w || py < 0 || py > h) continue
      const norm = Math.min(z / 5, 1)
      const r = Math.round((1 - norm) * 220)
      const g = Math.round(norm * 180)
      ctx.fillStyle = `rgb(${r},${g},60)`
      ctx.fillRect(px, py, 2, 2)
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()

    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    for (const d of [1, 2, 3, 4, 5]) {
      const py = h - d * zScale
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '9px monospace'
      ctx.fillText(`${d}m`, 2, py - 2)
    }
  }, [data])

  return (
    <div className="tui-panel bg-card flex flex-col">
      <PanelHeader title="DEPTH CLOUD" right={data ? `${pointCount} pts` : 'no data'} />
      <div className="p-1">
        <canvas ref={canvasRef} width={320} height={240} className="w-full" style={{ imageRendering: 'pixelated' }} />
      </div>
    </div>
  )
}

// -- lidar x vision cross-check --

type CheckState = 'idle' | 'checking' | 'waiting_brain' | 'done'

interface CheckResult {
  verdict: 'clear' | 'lidar_error' | 'obstacle_confirmed' | 'no_anomaly'
  message: string
  anomaly?: { angleDeg: number; rangeM: number; clusterSize: number; medianM: number }
  brainReply?: string
}

function findLidarAnomaly(scan: LaserScanMsg): CheckResult['anomaly'] | null {
  const { ranges, range_min, range_max, angle_min, angle_increment } = scan
  const rmin = range_min ?? 0.15
  const rmax = range_max ?? 12.0

  const isBlocked = (r: number | null) =>
    r == null || !isFinite(r) || r <= 0 || r < rmin

  const valid = ranges.filter(r => r != null && isFinite(r) && r > rmin && r < rmax) as number[]
  const median = valid.length >= 20
    ? [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)]
    : null

  const hot = ranges.reduce<number[]>((acc, r, i) => {
    if (isBlocked(r)) { acc.push(i); return acc }
    if (median && (r as number) < median * 0.35) { acc.push(i); return acc }
    return acc
  }, [])

  if (hot.length < 5) return null

  const clusters: number[][] = []
  let cur = [hot[0]]
  for (let i = 1; i < hot.length; i++) {
    if (hot[i] - cur[cur.length - 1] <= 3) cur.push(hot[i])
    else { clusters.push(cur); cur = [hot[i]] }
  }
  clusters.push(cur)
  const best = clusters.reduce((a, b) => b.length > a.length ? b : a)
  if (best.length < 5) return null

  const midIdx = best[Math.floor(best.length / 2)]
  const midAngle = angle_min + midIdx * angle_increment
  const midRange = ranges[midIdx]
  return {
    angleDeg: Math.round(midAngle * (180 / Math.PI) * 10) / 10,
    rangeM: midRange != null && isFinite(midRange) ? Math.round(midRange * 1000) / 1000 : 0,
    clusterSize: best.length,
    medianM: median ? Math.round(median * 1000) / 1000 : 0,
  }
}

function LidarVisionCheck({ url }: { url: string }) {
  const { data: scan } = useRosbridgeTopic<LaserScanMsg>(url, '/scan', 'sensor_msgs/msg/LaserScan', 500)
  const { data: chatOut } = useRosbridgeTopic<{ data?: string }>(url, '/brain/chat_out', 'std_msgs/msg/String', 0)
  const { data: tts } = useRosbridgeTopic<{ data?: string }>(url, '/brain/tts', 'std_msgs/msg/String', 0)
  const [state, setState] = useState<CheckState>('idle')
  const [result, setResult] = useState<CheckResult | null>(null)
  const sessionRef = useRef(0)
  const waitingSession = useRef(-1)

  function handleBrainReply(reply: string) {
    if (waitingSession.current < 0) return
    const session = waitingSession.current
    waitingSession.current = -1
    const confirmed = reply.trim().toUpperCase().startsWith('YES')
    setResult((prev) => {
      if (session !== sessionRef.current) return prev
      return {
        verdict: confirmed ? 'obstacle_confirmed' : 'lidar_error',
        message: confirmed
          ? `Obstacle confirmed by camera.`
          : `LIDAR ERROR: sensor sees obstacle but camera sees nothing.`,
        anomaly: prev?.anomaly,
        brainReply: reply,
      }
    })
    setState('done')
  }

  useEffect(() => {
    if (chatOut?.data) handleBrainReply(chatOut.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOut])

  useEffect(() => {
    if (tts?.data) handleBrainReply(tts.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tts])

  function runCheck() {
    if (state === 'checking' || state === 'waiting_brain') return
    if (!scan) { setResult({ verdict: 'clear', message: 'No scan data yet.' }); setState('done'); return }

    const session = ++sessionRef.current
    setState('checking')
    setResult(null)
    waitingSession.current = -1

    const anomaly = findLidarAnomaly(scan)
    if (!anomaly) {
      setResult({ verdict: 'no_anomaly', message: 'Lidar looks normal \u2014 no close-range anomalies detected.' })
      setState('done')
      return
    }

    setState('waiting_brain')
    waitingSession.current = session
    const question = `Look straight ahead. Is there a solid physical object, wall, or obstacle directly blocking the camera view or the robot's immediate path? Answer with YES or NO followed by one sentence of explanation.`
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', { data: question })

    setResult({ verdict: 'clear', message: `Anomaly at ${anomaly.angleDeg}\u00b0 / ${anomaly.rangeM}m \u2014 asking brain\u2026`, anomaly })

    setTimeout(() => {
      if (waitingSession.current !== session) return
      waitingSession.current = -1
      setResult({ verdict: 'clear', message: 'Brain did not respond in time.', anomaly })
      setState('done')
    }, 20000)
  }

  const verdictColor = !result ? '' :
    result.verdict === 'lidar_error' ? 'text-term-red' :
      result.verdict === 'obstacle_confirmed' ? 'text-term-green' :
        result.verdict === 'no_anomaly' ? 'text-term-green' : 'text-term-yellow'

  return (
    <div className="tui-panel bg-card flex flex-col col-span-2">
      <PanelHeader title="LIDAR x VISION CHECK" right={scan ? `${scan.ranges?.length ?? 0} beams` : 'no scan'} />
      <div className="p-3 space-y-2 text-xs">
        <button
          onClick={runCheck}
          disabled={state === 'checking' || state === 'waiting_brain'}
          className="w-full py-1 border border-term-cyan text-term-cyan bg-transparent hover:bg-term-cyan/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs"
        >
          {state === 'checking' ? 'ANALYZING LIDAR\u2026' : state === 'waiting_brain' ? 'ASKING BRAIN\u2026' : '\u25b6 RUN LIDAR x VISION CHECK'}
        </button>
        {result && (
          <div className="space-y-1">
            <div className={`font-mono ${verdictColor}`}>{result.message}</div>
            {result.anomaly && (
              <div className="text-muted-foreground">
                anomaly: {result.anomaly.angleDeg}{'\u00b0'} - {result.anomaly.rangeM}m - {result.anomaly.clusterSize} beams - median {result.anomaly.medianM}m
              </div>
            )}
            {result.brainReply && (
              <div className="text-muted-foreground italic">brain: &quot;{result.brainReply}&quot;</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// -- odom fdir (wheel slip detection) --

function OdomFdirPanel({ url }: { url: string }) {
  const { data: odomData } = useRosbridgeTopic<Record<string, unknown>>(url, '/odom', 'nav_msgs/msg/Odometry', 200)
  const { data: amclData } = useRosbridgeTopic<Record<string, unknown>>(url, '/amcl_pose', 'geometry_msgs/msg/PoseWithCovarianceStamped', 200)

  const baselineRef = useRef<{ odom: [number, number] | null; amcl: [number, number] | null } | null>(null)
  const [running, setRunning] = useState(false)
  const [verdict, setVerdict] = useState<{ status: string; msg: string } | null>(null)

  const latestOdomDeltaRef = useRef<number | null>(null)
  const latestAmclDeltaRef = useRef<number | null>(null)

  const getPos = (d: Record<string, unknown> | null): [number, number] | null => {
    try {
      const pose = (d as { pose?: { pose?: { position?: { x?: unknown; y?: unknown } } } } | null)?.pose?.pose?.position
      if (typeof pose?.x === 'number' && typeof pose?.y === 'number') return [pose.x, pose.y]
    } catch { /* ignore */ }
    return null
  }

  const odomPos = getPos(odomData)
  const amclPos = getPos(amclData)

  const dist = (a: [number, number] | null, b: [number, number] | null) =>
    a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null

  const odomDelta = running ? dist(baselineRef.current?.odom ?? null, odomPos) : null
  const amclDelta = running ? dist(baselineRef.current?.amcl ?? null, amclPos) : null

  latestOdomDeltaRef.current = odomDelta
  latestAmclDeltaRef.current = amclDelta

  const divergence = odomDelta != null && amclDelta != null ? odomDelta - amclDelta : null
  const isFault = divergence != null && odomDelta != null && odomDelta > 0.15 && divergence > odomDelta * 0.5

  function startCheck() {
    baselineRef.current = { odom: odomPos, amcl: amclPos }
    latestOdomDeltaRef.current = null
    latestAmclDeltaRef.current = null
    setRunning(true)
    setVerdict(null)
    setTimeout(() => {
      const od = latestOdomDeltaRef.current
      const ad = latestAmclDeltaRef.current
      const fault = od != null && od > 0.15 && ad != null && ad < od * 0.5
      setRunning(false)
      setVerdict(fault
        ? { status: 'fault', msg: `Wheel slip! Odom: ${od?.toFixed(3)}m  AMCL: ${ad?.toFixed(3)}m` }
        : { status: 'nominal', msg: `All sources agree \u2014 odom: ${od?.toFixed(3)}m  amcl: ${ad?.toFixed(3)}m` }
      )
    }, 20000)
  }

  const bar = (val: number | null, max: number, color: string) => (
    <div className="h-2 w-full bg-muted rounded-sm overflow-hidden">
      <div className="h-full rounded-sm transition-all" style={{ width: `${Math.min(100, ((val ?? 0) / max) * 100)}%`, backgroundColor: color }} />
    </div>
  )

  return (
    <div className="tui-panel bg-card flex flex-col col-span-2">
      <PanelHeader title="ODOM FDIR" right="wheel slip detection" />
      <div className="p-3 space-y-3 text-xs">
        <button
          onClick={startCheck}
          disabled={running}
          className="w-full py-1 border border-term-cyan text-term-cyan bg-transparent hover:bg-term-cyan/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs"
        >
          {running ? 'MONITORING\u2026 (lift wheels now)' : '\u25b6 START ODOM FDIR CHECK'}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-muted-foreground">ODOM {'\u0394'}</span>
              <span className="text-term-yellow font-mono">{odomDelta != null ? `${odomDelta.toFixed(3)}m` : '--'}</span>
            </div>
            {bar(odomDelta, 1.2, '#afaf5f')}
            <div className="text-[10px] text-muted-foreground mt-0.5">wheel encoders</div>
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-muted-foreground">AMCL {'\u0394'}</span>
              <span className="text-term-green font-mono">{amclDelta != null ? `${amclDelta.toFixed(3)}m` : '--'}</span>
            </div>
            {bar(amclDelta, 1.2, '#5faf5f')}
            <div className="text-[10px] text-muted-foreground mt-0.5">lidar map-match</div>
          </div>
        </div>

        {running && divergence != null && (
          <div className={`font-mono text-center py-1 border ${isFault ? 'border-term-red text-term-red' : 'border-term-green text-term-green'}`}>
            {isFault
              ? `\u26a0 WHEEL SLIP  divergence: ${divergence.toFixed(3)}m`
              : `\u2713 NOMINAL  divergence: ${divergence.toFixed(3)}m`}
          </div>
        )}

        {verdict && !running && (
          <div className={`font-mono text-center py-1 border ${verdict.status === 'fault' ? 'border-term-red text-term-red' : 'border-term-green text-term-green'}`}>
            {verdict.status === 'fault' ? '\u26a0 FAULT' : '\u2713 NOMINAL'} {'\u2014'} {verdict.msg}
          </div>
        )}
      </div>
    </div>
  )
}

// -- main page --

function AgentPage() {
  const { agentId } = agentRoute.useParams()
  const agent = AGENTS.find((a) => a.id === agentId)

  if (!agent) {
    return <div className="text-destructive text-xs">error: agent &quot;{agentId}&quot; not found</div>
  }

  const url = agent.rosbridgeUrl
  const wsStatus = useRosbridgeStatus(url)
  const statusColor = agent.status === 'online' ? 'text-term-green' : agent.status === 'idle' ? 'text-term-yellow' : 'text-term-red'
  const wsColor = wsStatus === 'connected' ? 'text-term-green' : wsStatus === 'disconnected' ? 'text-term-red' : 'text-term-yellow'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold">~/agents/{agent.id}</h1>
        {url && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`${wsColor} ${wsStatus === 'connected' ? 'status-live' : ''}`}>●</span>
            <span className={wsColor}>{wsStatus}</span>
            <span className="text-muted-foreground">{url}</span>
          </div>
        )}
      </div>

      {/* cameras + info */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-0 shrink-0">
          <div className="tui-panel bg-card flex flex-col w-[400px]">
            <PanelHeader title="MAIN CAMERA" right="/main_camera/left" />
            <div className="aspect-video bg-black overflow-hidden">
              {url ? (
                <ImageFeed url={url} topic="/mars/main_camera/left/image_raw/compressed" label="MAIN" depthTopic="/mars/main_camera/depth/image_rect_raw" />
              ) : (
                <SimulatedFeed agent={agent} />
              )}
            </div>
          </div>
          {url && <HeadPositionPanel url={url} />}
        </div>

        <div className="tui-panel bg-card flex flex-col w-[400px] shrink-0">
          <PanelHeader title="ARM CAMERA" right="/arm/image_raw" />
          <div className="aspect-video bg-black overflow-hidden">
            {url ? (
              <ImageFeed url={url} topic="/mars/arm/image_raw/compressed" label="ARM" />
            ) : (
              <SimulatedFeed agent={agent} />
            )}
          </div>
        </div>

        <div className="tui-panel bg-card flex flex-col flex-1 min-w-[200px]">
          <PanelHeader title="AGENT INFO" />
          <div className="p-3 text-xs space-y-2 flex-1">
            <TelemetryRow label="name" value={agent.name} />
            <TelemetryRow label="id" value={agent.id} />
            <TelemetryRow label="status" value={agent.status} color={statusColor} />
            {url && <TelemetryRow label="ws" value={url} color="text-term-cyan" />}
          </div>
        </div>

        {url && <LidarGroup url={url} />}
      </div>

      {/* telemetry grid: visualizations + readouts */}
      {url && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 auto-rows-min">
          <div className="tui-panel bg-card flex flex-col">
            <PanelHeader title="ENCODER ODOM" right="map frame /amcl_pose" />
            <div className="p-1 aspect-square">
              <LiveLocationTrack url={url} />
            </div>
          </div>
          <ImuAccelPanel url={url} />
          <SystemStatsPanel url={url} />
          <DrivePanel url={url} />
          <SkillsPanel url={url} />
          <LidarVisionCheck url={url} />
          <OdomFdirPanel url={url} />
          <RobotPosePanel url={url} />
          <DepthCloudPanel url={url} />
          <div className="flex flex-col gap-3">
            <GotoPanel url={url} />
            <SkillUpdatePanel url={url} />
          </div>
        </div>
      )}

      {/* chat */}
      {url && <ChatPanel url={url} />}

      {/* event log */}
      <div className="tui-panel bg-card flex flex-col">
        <PanelHeader title="EVENT LOG" right={`${agent.events.length} entries`} />
        <div className="max-h-48 overflow-y-auto text-xs">
          {agent.events.length === 0 ? (
            <div className="px-2 py-4 text-muted-foreground text-center">no events recorded</div>
          ) : (
            agent.events.map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      </div>
    </div>
  )
}
