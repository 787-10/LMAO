import { useEffect, useRef, useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import {
  AGENTS,
  type Agent,
  type AgentEvent,
  type EventLevel,
} from '@/lib/agents'
import { useRosbridgeImage, useRosbridgeTopic, useRosbridgeStatus, publishRosbridge, sampleFromShared } from '@/hooks/useRosbridge'

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
    <div className="tui-panel bg-card col-span-2 row-span-2">
      <PanelHeader title="POSE + ODOM" />
      <div className="flex">
        <div className="flex-1 p-2">
          <svg viewBox="0 0 400 280" className="w-full" style={{ minHeight: 220 }}>
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

// @ts-expect-error moved to telemetry grid
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

function SkillStatusPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/brain/skill_status_update', 'std_msgs/msg/String', 1000)
  const [skill, setSkill] = useState('')

  function runSkill() {
    if (!skill.trim()) return
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', {
      data: JSON.stringify({ text: `run ${skill.trim()}`, sender: 'user', timestamp: Date.now() / 1000 }),
    })
    setSkill('')
  }

  let statusText = data?.data ?? '--'
  let statusColor = 'text-muted-foreground'
  try {
    if (data?.data) {
      const parsed = JSON.parse(data.data)
      statusText = parsed.status ?? parsed.skill ?? data.data
      if (parsed.status === 'running') statusColor = 'text-term-yellow'
      else if (parsed.status === 'done' || parsed.status === 'success') statusColor = 'text-term-green'
      else if (parsed.status === 'error' || parsed.status === 'failed') statusColor = 'text-term-red'
    }
  } catch { /* use raw */ }

  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="SKILLS" />
      <div className="p-2 text-xs space-y-2">
        <div className="truncate">
          <span className={statusColor}>{statusText}</span>
        </div>
        <div className="flex gap-1">
          <input
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSkill()}
            placeholder="skill name..."
            className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary min-w-0"
          />
          <button onClick={runSkill} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:opacity-80 shrink-0">
            run
          </button>
        </div>
      </div>
    </div>
  )
}

function TTSPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: boolean }>(url, '/tts/is_playing', undefined, 500)
  return (
    <div className="tui-panel bg-card">
      <PanelHeader title="TTS" />
      <div className="p-2 text-xs">
        <span className={data?.data ? 'text-term-green font-bold' : 'text-muted-foreground'}>
          {data?.data ? 'PLAYING' : 'IDLE'}
        </span>
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
    const maxRange = Math.min(data.range_max, 8)
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
  }, [data])

  return (
    <div className="tui-panel bg-card w-[310px] shrink-0">
      <PanelHeader title="LIDAR" right="/scan" />
      <div className="p-1">
        <canvas ref={canvasRef} width={298} height={298} className="w-full" style={{ aspectRatio: '1' }} />
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

const TRACK_MAX = 500
const TRACK_MIN_DIST = 0.05 // meters between recorded points

function LiveLocationTrack({ url }: { url: string }) {
  const trackRef = useRef<{ x: number; y: number }[]>([])
  const [track, setTrack] = useState<{ x: number; y: number }[]>([])
  const { data } = useRosbridgeTopic<{
    pose?: { pose?: { position?: { x: number; y: number } } }
  }>(url, '/odom', 'nav_msgs/msg/Odometry', 300)

  useEffect(() => {
    if (!data?.pose?.pose?.position) return
    const { x, y } = data.pose.pose.position
    const pts = trackRef.current
    if (pts.length > 0) {
      const last = pts[pts.length - 1]
      const dist = Math.sqrt((x - last.x) ** 2 + (y - last.y) ** 2)
      if (dist < TRACK_MIN_DIST) return
    }
    pts.push({ x, y })
    if (pts.length > TRACK_MAX) pts.shift()
    setTrack([...pts])
  }, [data])

  if (track.length < 2) {
    return (
      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
        waiting for odom...
      </div>
    )
  }

  // compute bounds with padding
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of track) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const rangeX = maxX - minX || 1
  const rangeY = maxY - minY || 1
  const range = Math.max(rangeX, rangeY) * 1.3
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  // map world to SVG [5..95]
  function toSvg(wx: number, wy: number): { sx: number; sy: number } {
    return {
      sx: 50 + ((wx - cx) / range) * 90,
      sy: 50 - ((wy - cy) / range) * 90, // flip y
    }
  }

  const last = track[track.length - 1]
  const lastSvg = toSvg(last.x, last.y)

  // grid spacing in meters (snap to nice values)
  const gridStep = range > 8 ? 2 : range > 3 ? 1 : range > 1 ? 0.5 : 0.2
  const gridStart = { x: Math.floor(minX / gridStep) * gridStep, y: Math.floor(minY / gridStep) * gridStep }

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {/* dynamic grid */}
      {Array.from({ length: Math.ceil(range / gridStep) + 2 }, (_, i) => {
        const wx = gridStart.x + i * gridStep
        const { sx } = toSvg(wx, 0)
        if (sx < 2 || sx > 98) return null
        return <line key={`gx-${i}`} x1={sx} y1={0} x2={sx} y2={100} stroke="currentColor" className="text-border" strokeWidth={0.2} />
      })}
      {Array.from({ length: Math.ceil(range / gridStep) + 2 }, (_, i) => {
        const wy = gridStart.y + i * gridStep
        const { sy } = toSvg(0, wy)
        if (sy < 2 || sy > 98) return null
        return <line key={`gy-${i}`} x1={0} y1={sy} x2={100} y2={sy} stroke="currentColor" className="text-border" strokeWidth={0.2} />
      })}

      {/* origin axes */}
      {(() => {
        const o = toSvg(0, 0)
        return (
          <>
            {o.sx > 2 && o.sx < 98 && <line x1={o.sx} y1={0} x2={o.sx} y2={100} stroke="#d75f5f" strokeWidth={0.3} opacity={0.3} />}
            {o.sy > 2 && o.sy < 98 && <line x1={0} y1={o.sy} x2={100} y2={o.sy} stroke="#5faf5f" strokeWidth={0.3} opacity={0.3} />}
          </>
        )
      })()}

      {/* trail */}
      {track.slice(0, -1).map((p, i) => {
        const a = toSvg(p.x, p.y)
        const b = toSvg(track[i + 1].x, track[i + 1].y)
        const opacity = 0.1 + (i / track.length) * 0.7
        return <line key={i} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} stroke="#5f87af" strokeWidth={0.8} opacity={opacity} />
      })}

      {/* current position */}
      <circle cx={lastSvg.sx} cy={lastSvg.sy} r={2} fill="#5f87af" />

      {/* start position */}
      {(() => {
        const s = toSvg(track[0].x, track[0].y)
        return <circle cx={s.sx} cy={s.sy} r={1.5} fill="none" stroke="#6c6c6c" strokeWidth={0.5} />
      })()}

      {/* position label */}
      <text x={lastSvg.sx} y={lastSvg.sy - 4} fontSize={4} fill="#5f87af" textAnchor="middle" fontFamily="monospace">
        ({last.x.toFixed(2)}, {last.y.toFixed(2)})
      </text>

      {/* scale */}
      <text x={3} y={97} fontSize={3.5} fill="#6c6c6c" fontFamily="monospace">{range.toFixed(1)}m</text>
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
        <div className="tui-panel bg-card flex flex-col w-[400px] shrink-0">
          <PanelHeader title="MAIN CAMERA" right="/main_camera/left" />
          <div className="aspect-video bg-black overflow-hidden">
            {url ? (
              <ImageFeed url={url} topic="/mars/main_camera/left/image_raw/compressed" label="MAIN" depthTopic="/mars/main_camera/depth/image_rect_raw" />
            ) : (
              <SimulatedFeed agent={agent} />
            )}
          </div>
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

      {/* telemetry grid */}
      {url && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <RobotPosePanel url={url} />
          <DrivePanel url={url} />
          <SkillStatusPanel url={url} />
          <TTSPanel url={url} />
        </div>
      )}

      {/* chat */}
      {url && <ChatPanel url={url} />}

      {/* location track */}
      {url && (
        <div className="tui-panel bg-card flex flex-col" style={{ maxWidth: 300 }}>
          <PanelHeader title="LOCATION TRACK" right="/odom" />
          <div className="p-2 aspect-square max-h-64">
            <LiveLocationTrack url={url} />
          </div>
        </div>
      )}

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
