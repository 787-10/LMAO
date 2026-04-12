import { useCallback, useEffect, useRef, useState } from 'react'
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

function PanelHeader({ title, right, rightEl }: { title: string; right?: string; rightEl?: React.ReactNode }) {
  return (
    <div className="border-b px-2 py-1 text-xs text-muted-foreground flex items-center justify-between">
      <span><span className="text-border mr-1">&#9552;</span>{title}<span className="text-border ml-1">&#9552;</span></span>
      {rightEl ?? (right && <span>{right}<span className="text-border ml-1">&#9552;</span></span>)}
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

function PoseOdomReadout({ url }: { url: string }) {
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
  const yaw = quatToYaw(ori)

  const Col = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex-1 min-w-[90px] flex flex-col gap-0.5">
      <div className="text-muted-foreground text-[9px] border-b pb-0.5">{label}</div>
      <div className="text-[10px] font-mono space-y-0.5">{children}</div>
    </div>
  )
  const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div className="flex justify-between gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={color ?? 'text-foreground'}>{value}</span>
    </div>
  )

  return (
    <div className="flex flex-wrap gap-3 border-t pt-2 px-2 pb-2 text-xs">
      <Col label="POSE /amcl_pose">
        <Row label="x" value={formatNum(pos.x)} color="text-term-cyan" />
        <Row label="y" value={formatNum(pos.y)} color="text-term-cyan" />
        <Row label="yaw" value={formatNum(yaw * 180 / Math.PI, 1) + '\u00b0'} color="text-term-yellow" />
      </Col>
      <Col label="ODOM /odom">
        <Row label="lin.x" value={formatNum(lin.x)} color="text-term-green" />
        <Row label="lin.y" value={formatNum(lin.y)} color="text-term-green" />
        <Row label="ang.z" value={formatNum(ang.z)} color="text-term-yellow" />
      </Col>
      <Col label="CMD_VEL">
        <Row label="lin.x" value={formatNum(cmdVelData?.linear?.x)} color="text-term-green" />
        <Row label="lin.y" value={formatNum(cmdVelData?.linear?.y)} color="text-term-green" />
        <Row label="ang.z" value={formatNum(cmdVelData?.angular?.z)} color="text-term-yellow" />
      </Col>
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

type AlertKind = 'imu' | 'lidar' | 'critical'
interface CriticalAlert {
  id: string
  kind: AlertKind
  source: string
  sourceLabel: string
  message: string
  ts: string
}

const CRITICAL_PATTERNS: { kind: AlertKind; re: RegExp }[] = [
  { kind: 'imu', re: /\bimu\b/i },
  { kind: 'lidar', re: /\b(lidar|laser[\s_-]?scan|scan)\b/i },
  { kind: 'critical', re: /\b(critical|fatal|hardware[\s_-]?fail|sensor[\s_-]?fail|emergenc)/i },
]

function detectCriticalKind(message: string, ok: boolean): AlertKind | null {
  if (ok) return null
  for (const p of CRITICAL_PATTERNS) {
    if (p.re.test(message)) return p.kind
  }
  return null
}

// -- stream health monitor --
// Watches IMU + LIDAR topics directly; raises alerts on staleness or invalid data.
// Alerts auto-deduplicate: once fired for a stream, don't re-fire until the stream recovers.

const IMU_STALE_MS = 3000
const LIDAR_STALE_MS = 3000
const STREAM_CHECK_INTERVAL_MS = 1000

function useStreamHealthAlerts(
  url: string,
  onAlert: (a: Omit<CriticalAlert, 'id' | 'ts'>) => void,
) {
  const imu = useRosbridgeTopic<{ data?: string }>(url, '/robot/imu_odom', 'std_msgs/msg/String', 0)
  const scan = useRosbridgeTopic<LaserScanMsg>(url, '/scan', 'sensor_msgs/msg/LaserScan', 500)

  const imuLast = useRef(0)
  const scanLast = useRef(0)
  const imuSeen = useRef(false)
  const scanSeen = useRef(false)
  const imuAlerted = useRef(false)
  const scanAlerted = useRef(false)

  useEffect(() => {
    const raw = imu.data?.data
    if (raw === undefined) return
    let valid = false
    let detail = ''
    try {
      const p = JSON.parse(raw)
      const fields = ['xacc', 'yacc', 'zacc', 'pitch', 'roll', 'yaw']
      const bad = fields.filter(f => typeof p[f] !== 'number' || !isFinite(p[f]))
      if (bad.length === 0) valid = true
      else detail = `invalid fields: ${bad.join(',')}`
    } catch (e) {
      detail = `parse failure: ${(e as Error).message}`
    }
    if (valid) {
      imuLast.current = Date.now()
      imuSeen.current = true
      imuAlerted.current = false
    } else if (!imuAlerted.current) {
      imuAlerted.current = true
      onAlert({ kind: 'imu', source: '/robot/imu_odom', sourceLabel: 'IMU stream', message: `IMU data invalid (${detail})` })
    }
  }, [imu.data, onAlert])

  useEffect(() => {
    const d = scan.data
    if (!d) return
    const ranges = d.ranges
    const hasValid = Array.isArray(ranges) && ranges.length > 0 && ranges.some(r => isFinite(r) && r >= d.range_min && r <= d.range_max)
    if (hasValid) {
      scanLast.current = Date.now()
      scanSeen.current = true
      scanAlerted.current = false
    } else if (!scanAlerted.current) {
      scanAlerted.current = true
      const n = ranges?.length ?? 0
      onAlert({ kind: 'lidar', source: '/scan', sourceLabel: 'LIDAR scan', message: `LIDAR scan invalid (${n} ranges, none in [${d.range_min},${d.range_max}])` })
    }
  }, [scan.data, onAlert])

  // reset all health state when url changes
  useEffect(() => {
    imuLast.current = 0
    scanLast.current = 0
    imuSeen.current = false
    scanSeen.current = false
    imuAlerted.current = false
    scanAlerted.current = false
  }, [url])

  useEffect(() => {
    if (!url) return
    const i = setInterval(() => {
      const now = Date.now()
      if (imuSeen.current && !imuAlerted.current && now - imuLast.current > IMU_STALE_MS) {
        imuAlerted.current = true
        const age = ((now - imuLast.current) / 1000).toFixed(1)
        onAlert({ kind: 'imu', source: '/robot/imu_odom', sourceLabel: 'IMU stream', message: `IMU stream stale (no message for ${age}s)` })
      }
      if (scanSeen.current && !scanAlerted.current && now - scanLast.current > LIDAR_STALE_MS) {
        scanAlerted.current = true
        const age = ((now - scanLast.current) / 1000).toFixed(1)
        onAlert({ kind: 'lidar', source: '/scan', sourceLabel: 'LIDAR scan', message: `LIDAR scan stream stale (no message for ${age}s)` })
      }
    }, STREAM_CHECK_INTERVAL_MS)
    return () => clearInterval(i)
  }, [url, onAlert])
}

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

function SkillsPanel({ url, onAlert }: { url: string; onAlert?: (a: Omit<CriticalAlert, 'id' | 'ts'>) => void }) {
  const { data } = useRosbridgeTopic<AvailableSkillsMsg>(
    url, '/brain/available_skills', 'brain_messages/msg/AvailableSkills',
  )
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, SkillResult>>({})
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})

  const skills = (data?.skills ?? []).sort((a, b) =>
    (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase()),
  )

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
      const kind = detectCriticalKind(message, ok)
      if (kind && onAlert) {
        const sk = skills.find(s => (s.id ?? s.skill_type) === skillId)
        onAlert({
          kind,
          source: skillId,
          sourceLabel: `skill: ${sk?.display_name ?? sk?.name ?? skillId}`,
          message,
        })
        setResults((r) => ({ ...r, [skillId]: { ok, message: `${kind.toUpperCase()} fault — see alerts`, ts: new Date().toLocaleTimeString() } }))
      } else {
        setResults((r) => ({ ...r, [skillId]: { ok, message, ts: new Date().toLocaleTimeString() } }))
      }
      setRunning(null)
    }, inputs)
  }

  const inputCls = 'w-14 bg-background border border-border px-1 py-0.5 text-[10px] font-mono focus:outline-none focus:border-term-cyan'

  return (
    <div className="tui-panel bg-card flex flex-col">
      <PanelHeader title="SKILLS" right={skills.length ? `${skills.length} available` : 'loading…'} />
      <div className="flex flex-col divide-y text-xs max-h-128 overflow-y-auto">
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
            <div key={id} className="px-3 py-1.5 space-y-1 hover:bg-accent/50">
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


const ALERT_STYLES: Record<AlertKind, { label: string; cls: string }> = {
  imu: { label: 'IMU FAULT', cls: 'border-term-red text-term-red' },
  lidar: { label: 'LIDAR FAULT', cls: 'border-term-red text-term-red' },
  critical: { label: 'CRITICAL', cls: 'border-term-red text-term-red' },
}

function AlertsPanel({ alerts, onDismiss, onClear }: {
  alerts: CriticalAlert[]
  onDismiss: (id: string) => void
  onClear: () => void
}) {
  if (alerts.length === 0) return null
  return (
    <div className="tui-panel bg-card border-term-red">
      <div className="border-b border-term-red/60 px-2 py-1 text-xs flex items-center justify-between">
        <span className="text-term-red font-bold">
          <span className="text-border mr-1">&#9552;</span>
          ALERTS
          <span className="text-border ml-1">&#9552;</span>
          <span className="ml-2 status-live">●</span>
          <span className="ml-1">{alerts.length} active</span>
        </span>
        <button onClick={onClear} className="text-[10px] text-muted-foreground hover:text-foreground">clear all</button>
      </div>
      <div className="divide-y text-xs max-h-40 overflow-y-auto">
        {alerts.map(a => {
          const style = ALERT_STYLES[a.kind]
          return (
            <div key={a.id} className="flex items-start gap-2 px-2 py-1.5">
              <span className="text-muted-foreground shrink-0">{a.ts}</span>
              <span className={`shrink-0 border px-1 font-bold ${style.cls}`}>{style.label}</span>
              <div className="flex-1 min-w-0">
                <div className="text-foreground break-words">{a.message}</div>
                <div className="text-[10px] text-muted-foreground truncate">{a.sourceLabel} ({a.source})</div>
              </div>
              <button
                onClick={() => onDismiss(a.id)}
                className="shrink-0 text-[10px] text-muted-foreground hover:text-term-red"
              >
                dismiss
              </button>
            </div>
          )
        })}
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
    <div className="tui-panel bg-card flex flex-col">
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
      <div className="mt-auto">
        <PoseOdomReadout url={url} />
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

function LidarPanel({ url, paused, onTogglePause }: { url: string; paused: boolean; onTogglePause?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [viewRange, setViewRange] = useState<number>(2)
  const { data } = useRosbridgeTopic<LaserScanMsg>(url, paused ? '' : '/scan', 'sensor_msgs/msg/LaserScan', 500)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data?.ranges) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const LOGICAL = 300
    const k = canvas.width / LOGICAL
    ctx.setTransform(k, 0, 0, k, 0, 0)

    const W = LOGICAL
    const H = LOGICAL
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
    <div className="tui-panel bg-card flex flex-col w-full">
      <PanelHeader title="LIDAR" right={`${viewRange}m /scan`} />
      <div className="p-1 flex-1">
        <canvas ref={canvasRef} width={900} height={900} className="w-full" style={{ aspectRatio: '1' }} />
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
        {onTogglePause && (
          <button
            onClick={onTogglePause}
            className={`ml-auto px-2 py-0.5 ${paused ? 'bg-term-yellow/10 text-term-yellow' : 'bg-card text-muted-foreground hover:text-foreground'}`}
          >
            {paused ? '> resume' : '|| pause'}
          </button>
        )}
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
  const [waypointMode, setWaypointMode] = useState(false)
  const [waypoint, setWaypoint] = useState<{ x: number; y: number } | null>(null)
  const [navStatus, setNavStatus] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

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

  function handleGridClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!waypointMode) return
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const svgPt = pt.matrixTransform(ctm.inverse())
    // svgPt in 0..100 coords; convert back to world
    const wx = (svgPt.x - 50) / scale
    const wy = -(svgPt.y - 50) / scale   // flip Y back
    setWaypoint({ x: wx, y: wy })
    setNavStatus('sending…')
    // match orchestrator: theta = heading from current pos to goal
    // (atan2(dy, dx)). if we have no pose yet, theta=0. if goal equals
    // current pos, keep current yaw.
    let waypointTheta = 0
    if (rx !== null && ry !== null) {
      const dx = wx - rx
      const dy = wy - ry
      if (dx === 0 && dy === 0) {
        waypointTheta = rawOri
          ? Math.atan2(2 * (rawOri.w * rawOri.z + rawOri.x * rawOri.y), 1 - 2 * (rawOri.y ** 2 + rawOri.z ** 2))
          : 0
      } else {
        waypointTheta = Math.atan2(dy, dx)
      }
    }
    console.log('[waypoint] theta=', waypointTheta, 'from (', rx, ry, ') -> (', wx, wy, ')')
    sendActionGoal(url, 'innate-os/navigate_to_position', (ok, message) => {
      setNavStatus(ok ? 'arrived' : `failed: ${message || 'error'}`)
      setTimeout(() => setNavStatus(null), 10000)
    }, { x: wx, y: wy, theta: waypointTheta, local_frame: false })
  }

  let yaw = 0
  if (rawOri) {
    const o = rawOri
    yaw = Math.atan2(2 * (o.w * o.z + o.x * o.y), 1 - 2 * (o.y ** 2 + o.z ** 2))
  }

  const trail = trailRef.current
  const robotSvg = rx !== null ? toSvg(rx, ry!) : null
  const waypointSvg = waypoint ? toSvg(waypoint.x, waypoint.y) : null

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
    <div className="flex flex-col h-full">
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        className="w-full flex-1"
        preserveAspectRatio="xMidYMid meet"
        onClick={handleGridClick}
        style={{ cursor: waypointMode ? 'crosshair' : 'default' }}
      >
        {gridLines}
        {/* trail */}
        {trail.length > 1 && trail.slice(0, -1).map((p, i) => {
          const { sx: x1, sy: y1 } = toSvg(p.x, p.y)
          const { sx: x2, sy: y2 } = toSvg(trail[i + 1].x, trail[i + 1].y)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#5f87af" strokeWidth={1} opacity={0.2 + (i / trail.length) * 0.7} />
        })}
        {/* waypoint */}
        {waypointSvg && (
          <>
            <circle cx={waypointSvg.sx} cy={waypointSvg.sy} r={3} fill="#d75f5f" />
            <circle cx={waypointSvg.sx} cy={waypointSvg.sy} r={5} fill="none" stroke="#d75f5f" strokeWidth={0.5} opacity={0.5} />
            <text x={waypointSvg.sx} y={waypointSvg.sy + 8} fontSize={3.5} fill="#d75f5f" textAnchor="middle" fontFamily="monospace">
              ({waypoint!.x.toFixed(2)}, {waypoint!.y.toFixed(2)})
            </text>
          </>
        )}
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
      <div className="border-t flex items-center gap-2 px-2 py-1 text-[10px]">
        <button
          onClick={() => setWaypointMode(m => !m)}
          className={`px-2 py-0.5 ${waypointMode ? 'bg-term-red text-primary-foreground' : 'bg-primary text-primary-foreground hover:opacity-80'}`}
        >
          {waypointMode ? 'cancel' : 'set waypoint'}
        </button>
        {waypoint && (
          <button
            onClick={() => { setWaypoint(null); setNavStatus(null) }}
            className="px-2 py-0.5 bg-secondary text-secondary-foreground hover:opacity-80"
          >
            clear
          </button>
        )}
        {navStatus && (
          <span className={navStatus.startsWith('failed') ? 'text-term-red' : navStatus === 'arrived' ? 'text-term-green' : 'text-term-yellow'}>
            {navStatus}
          </span>
        )}
        {!navStatus && waypointMode && <span className="text-muted-foreground">click grid to navigate</span>}
      </div>
    </div>
  )
}

const OCC_SIZE = 298
const OCC_RANGE = 8 // meters per half-side (16m total)
const OCC_RES = (OCC_RANGE * 2) / OCC_SIZE // meters per cell
const LOG_OCC = 0.4
const LOG_FREE = -0.12
const LOG_CLAMP = 6

// North-up map convention: world +x (forward) -> screen up, world +y (left) -> screen left.
function worldToGrid(wx: number, wy: number, originX: number, originY: number): [number, number] {
  const gx = Math.floor(OCC_SIZE / 2 - (wy - originY) / OCC_RES)
  const gy = Math.floor(OCC_SIZE / 2 - (wx - originX) / OCC_RES)
  return [gx, gy]
}

function inGrid(gx: number, gy: number): boolean {
  return gx >= 0 && gx < OCC_SIZE && gy >= 0 && gy < OCC_SIZE
}

function LidarOccupancy({ url, paused }: { url: string; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const gridRef = useRef<Float32Array>(new Float32Array(OCC_SIZE * OCC_SIZE))
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const poseRef = useRef({ x: 0, y: 0, yaw: 0 })
  const frameRef = useRef(0)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  if (!offscreenRef.current) {
    const tmp = document.createElement('canvas')
    tmp.width = OCC_SIZE
    tmp.height = OCC_SIZE
    offscreenRef.current = tmp
  }

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

    // render: grid to offscreen at OCC_SIZE, then scaled to main canvas; overlays in OCC_SIZE logical coords
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const offscreen = offscreenRef.current
    if (!offscreen) return
    const tmpCtx = offscreen.getContext('2d')
    if (!tmpCtx) return

    const S = OCC_SIZE
    const imgData = tmpCtx.createImageData(S, S)

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
    tmpCtx.putImageData(imgData, 0, 0)

    // scale to main canvas; overlays draw in OCC_SIZE logical coords
    const k = canvas.width / OCC_SIZE
    ctx.setTransform(k, 0, 0, k, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(offscreen, 0, 0)

    // robot position on map
    const [botGx, botGy] = worldToGrid(rx, ry, origin.x, origin.y)

    // heading indicator (north-up: +x forward = canvas up, +y left = canvas left)
    ctx.strokeStyle = 'rgba(95,175,95,0.6)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(botGx, botGy)
    ctx.lineTo(botGx - Math.sin(yaw) * 14, botGy - Math.cos(yaw) * 14)
    ctx.stroke()

    // robot triangle
    ctx.fillStyle = '#5f87af'
    ctx.save()
    ctx.translate(botGx, botGy)
    ctx.rotate(-yaw)
    ctx.beginPath()
    ctx.moveTo(0, -5)
    ctx.lineTo(-3, 4)
    ctx.lineTo(3, 4)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }, [scanData])

  return (
    <div className="tui-panel bg-card flex flex-col w-full">
      <PanelHeader title="LIDAR MAP" right={`${frameRef.current}`} />
      <div className="p-1 flex-1">
        <canvas ref={canvasRef} width={OCC_SIZE * 3} height={OCC_SIZE * 3} className="w-full" style={{ aspectRatio: '1' }} />
      </div>
    </div>
  )
}

function SystemStatsBody({ url }: { url: string }) {
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
    <div className="text-xs space-y-2">
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
      <PanelHeader title="IMU ACCEL" right={parsed ? 'live pixhawk' : 'run imu_odom_pub2.py'} />
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

// -- status bar --

function BatteryIcon({ pct, color }: { pct: number | null; color: string }) {
  const fill = pct ?? 0
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" className="shrink-0">
      <rect x="0.5" y="0.5" width="19" height="11" fill="none" stroke="currentColor" strokeWidth="1" className="text-muted-foreground" />
      <rect x="20" y="3" width="2" height="6" fill="currentColor" className="text-muted-foreground" />
      <rect x="2" y="2" width={Math.max(0, Math.min(16, (fill / 100) * 16))} height="8" fill={color} />
    </svg>
  )
}

function StatusBar({
  agent,
  url,
  wsStatus,
}: {
  agent: { id: string; name: string; status: string }
  url?: string
  wsStatus: 'connecting' | 'connected' | 'disconnected'
}) {
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

  const batPct = batData?.percentage != null ? Math.round(batData.percentage * 100) : null
  const voltage = batData?.voltage ?? null
  const current = batData?.current ?? null

  const batColor = batPct == null ? '#555'
    : batPct > 60 ? '#5faf5f'
      : batPct > 30 ? '#afaf5f'
        : '#af5f5f'
  const batTextColor = batPct == null ? 'text-muted-foreground'
    : batPct > 60 ? 'text-term-green'
      : batPct > 30 ? 'text-term-yellow'
        : 'text-term-red'

  const statusColor = agent.status === 'online' ? 'text-term-green' : agent.status === 'idle' ? 'text-term-yellow' : 'text-term-red'
  const wsColor = wsStatus === 'connected' ? 'text-term-green' : wsStatus === 'disconnected' ? 'text-term-red' : 'text-term-yellow'

  const pctColor = (v: number | null, danger = 80) =>
    v == null ? 'text-muted-foreground' : v > danger ? 'text-term-red' : v > danger * 0.65 ? 'text-term-yellow' : 'text-term-green'

  return (
    <div className="tui-panel bg-card px-3 flex items-center gap-4 text-xs h-12 shrink-0 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0">
        <span className={`${statusColor} ${agent.status === 'online' ? 'status-live' : ''}`}>●</span>
        <span className="font-bold text-foreground">{agent.name}</span>
        <span className="text-muted-foreground">{agent.id}</span>
        <span className={statusColor}>{agent.status}</span>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      <div className="flex items-center gap-2 shrink-0 w-96">
        <span className={`${wsColor} ${wsStatus === 'connected' ? 'status-live' : ''}`}>●</span>
        <span className={wsColor}>{wsStatus}</span>
        {url && <span className="text-muted-foreground truncate max-w-[240px]">{url}</span>}
      </div>

      {url && <>
        <div className="w-px h-5 bg-border shrink-0" />

        <div className="flex items-center gap-2 shrink-0">
          <BatteryIcon pct={batPct} color={batColor} />
          <span className={batTextColor}>{batPct != null ? `${batPct}%` : '--'}</span>
          {voltage != null && <span className="text-muted-foreground">{voltage.toFixed(1)}<span className="opacity-60">V</span></span>}
          {current != null && <span className="text-muted-foreground">{current.toFixed(1)}<span className="opacity-60">A</span></span>}
        </div>

        <div className="w-px h-5 bg-border shrink-0" />

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-muted-foreground">CPU <span className={pctColor(cpuPct)}>{cpuPct != null ? `${cpuPct}%` : '--'}</span></span>
          <span className="text-muted-foreground">GPU <span className={pctColor(gpuPct)}>{gpuPct != null ? `${gpuPct}%` : '--'}</span></span>
          <span className="text-muted-foreground">RAM <span className={pctColor(ramPct, 85)}>{ramPct != null ? `${ramPct}%` : '--'}</span></span>
          {hottest && (
            <span className="text-muted-foreground">T <span className={hottest.temp_c > 70 ? 'text-term-red' : hottest.temp_c > 50 ? 'text-term-yellow' : 'text-foreground'}>{hottest.temp_c}{'\u00b0'}C</span></span>
          )}
        </div>
      </>}
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

  const [alerts, setAlerts] = useState<CriticalAlert[]>([])
  const pushAlert = useCallback((a: Omit<CriticalAlert, 'id' | 'ts'>) => {
    setAlerts(prev => [
      { ...a, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toLocaleTimeString() },
      ...prev,
    ].slice(0, 20))
  }, [])
  const dismissAlert = (id: string) => setAlerts(prev => prev.filter(a => a.id !== id))
  const clearAlerts = () => setAlerts([])

  useStreamHealthAlerts(url ?? '', pushAlert)

  const [lidarPaused, setLidarPaused] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <StatusBar agent={agent} url={url} wsStatus={wsStatus} />

      <AlertsPanel alerts={alerts} onDismiss={dismissAlert} onClear={clearAlerts} />

      {/* cameras + lidars: flow-card (100%/50%/25%); telemetry flex-1; skills full width */}
      <div className="flex flex-wrap gap-3">
        <div className="flow-card flex gap-0">
          <div className="tui-panel bg-card flex flex-col flex-1 min-w-0">
            <PanelHeader title="MAIN CAMERA" right="/main_camera/left" />
            <div className="aspect-square bg-black overflow-hidden">
              {url ? (
                <ImageFeed url={url} topic="/mars/main_camera/left/image_raw/compressed" label="MAIN" depthTopic="/mars/main_camera/depth/image_rect_raw" />
              ) : (
                <SimulatedFeed agent={agent} />
              )}
            </div>
          </div>
          {url && <HeadPositionPanel url={url} />}
        </div>

        <div className="flow-card tui-panel bg-card flex flex-col">
          <PanelHeader title="ARM CAMERA" right="/arm/image_raw" />
          <div className="aspect-square bg-black overflow-hidden">
            {url ? (
              <ImageFeed url={url} topic="/mars/arm/image_raw/compressed" label="ARM" />
            ) : (
              <SimulatedFeed agent={agent} />
            )}
          </div>
        </div>

        {url && (
          <>
            <div className="flow-card flex"><LidarPanel url={url} paused={lidarPaused} onTogglePause={() => setLidarPaused(p => !p)} /></div>
            <div className="flow-card flex"><LidarOccupancy url={url} paused={lidarPaused} /></div>
            <div className="tui-panel bg-card flex flex-col flex-1 basis-[240px] min-w-[240px]">
              <PanelHeader title="ENCODER ODOM" right="map frame /amcl_pose" />
              <div className="p-1 aspect-square">
                <LiveLocationTrack url={url} />
              </div>
            </div>
            <div className="flex-1 basis-[240px] min-w-[240px] grid"><ImuAccelPanel url={url} /></div>
            <div className="flex-1 basis-[240px] min-w-[240px] grid"><DrivePanel url={url} /></div>
            <div className="flex-1 basis-[240px] min-w-[240px] grid"><DepthCloudPanel url={url} /></div>
            <div className="w-full grid"><SkillsPanel url={url} onAlert={pushAlert} /></div>
          </>
        )}
      </div>

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
