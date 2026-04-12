import { useEffect, useRef, useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import {
  AGENTS,
  type Agent,
  type AgentEvent,
  type EventLevel,
} from '@/lib/agents'
import { useRosbridgeImage, useRosbridgeTopic, useRosbridgeStatus, publishRosbridge, sendActionGoal } from '@/hooks/useRosbridge'

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
      <span>{title}</span>
      {right && <span>{right}</span>}
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

function ImageFeed({ url, topic, label }: { url: string; topic: string; label: string }) {
  const [paused, setPaused] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const stream = useRosbridgeImage(url, topic, 100, paused)
  const fps = useFps(stream.frameCount)
  const lastFrameRef = useRef(stream.frameCount)
  const staleSinceRef = useRef<number | null>(null)
  const [stale, setStale] = useState(false)

  // detect stale feed: no new frames for 5s
  useEffect(() => {
    if (stream.frameCount !== lastFrameRef.current) {
      lastFrameRef.current = stream.frameCount
      staleSinceRef.current = null
      setStale(false)
    } else if (stream.src && !paused) {
      if (!staleSinceRef.current) staleSinceRef.current = Date.now()
      else if (Date.now() - staleSinceRef.current > 5000) setStale(true)
    }
  })

  function restartCamera() {
    setRestarting(true)
    // kill and respawn the camera node via ROS
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', {
      data: 'restart the main camera node'
    })
    setTimeout(() => setRestarting(false), 5000)
  }

  return (
    <div className="w-full h-full bg-black relative group">
      {stream.src ? (
        <img src={stream.src} alt={label} className={`w-full h-full object-contain ${stale ? 'opacity-40' : ''}`} />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
          WAITING
        </div>
      )}
      <div className="absolute top-1 left-2 text-[10px] text-term-blue">{label}</div>
      <div className="absolute top-1 right-2 text-[10px] flex items-center gap-1">
        {stale && <span className="text-term-red">STALE</span>}
        {stream.src && !paused && !stale && <span className="text-term-green status-live">●</span>}
        {paused && <span className="text-term-yellow">PAUSED</span>}
        {stream.src && <span className="text-muted-foreground">{fps}fps</span>}
      </div>
      <div className="absolute bottom-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={restartCamera}
          disabled={restarting}
          className="text-[10px] px-1.5 py-0.5 bg-black/60 text-term-yellow hover:text-yellow-300 disabled:opacity-40"
        >
          {restarting ? 'restarting…' : 'restart cam'}
        </button>
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
    <div className="border bg-card col-span-2 row-span-2">
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
        </div>
      </div>
    </div>
  )
}

function CmdVelPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{
    linear?: { x: number; y: number; z: number }
    angular?: { x: number; y: number; z: number }
  }>(url, '/cmd_vel', 'geometry_msgs/msg/Twist', 200)
  return (
    <div className="border bg-card">
      <PanelHeader title="CMD_VEL" />
      <div className="p-2 text-xs space-y-1">
        <TelemetryRow label="lin.x" value={formatNum(data?.linear?.x)} color="text-term-green" />
        <TelemetryRow label="lin.y" value={formatNum(data?.linear?.y)} color="text-term-green" />
        <TelemetryRow label="ang.z" value={formatNum(data?.angular?.z)} color="text-term-yellow" />
      </div>
    </div>
  )
}


function SysStatsPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/robot/sys_stats', 'std_msgs/msg/String', 2000)

  const stats = (() => {
    try { return data?.data ? JSON.parse(data.data) : null } catch { return null }
  })()

  const cpuPct: number | null = stats?.gpu?.cpu_avg_pct ?? null
  const gpuPct: number | null = stats?.gpu?.gpu_pct ?? null
  const ramPct: number | null = stats?.gpu?.ram_pct ?? stats?.memory?.used_pct ?? null
  const hottest: { zone: string; temp_c: number } | null = stats?.thermal?.hottest ?? null
  const load1m: number | null = stats?.cpu?.load_1m ?? null
  const powerMw: number | null = stats?.gpu?.power_mw ?? null

  const bar = (pct: number | null, danger = 80) => {
    const v = pct ?? 0
    const color = v > danger ? '#af5f5f' : v > danger * 0.65 ? '#afaf5f' : '#5faf5f'
    return (
      <div className="h-1.5 w-full bg-muted rounded-sm overflow-hidden">
        <div className="h-full rounded-sm transition-all" style={{ width: `${v}%`, backgroundColor: color }} />
      </div>
    )
  }

  return (
    <div className="border bg-card">
      <PanelHeader title="SYS STATS" right={stats ? 'live' : 'no data'} />
      <div className="p-2 text-xs space-y-2">
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
          {hottest && <TelemetryRow label="temp" value={`${hottest.temp_c}°C (${hottest.zone})`} color={hottest.temp_c > 70 ? 'text-term-red' : hottest.temp_c > 50 ? 'text-term-yellow' : 'text-muted-foreground'} />}
          {powerMw != null && <TelemetryRow label="power" value={`${(powerMw / 1000).toFixed(1)} W`} />}
        </> : <span className="text-muted-foreground">run sys_stats_pub.py on robot</span>}
      </div>
    </div>
  )
}

function BatteryPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{
    voltage?: number
    percentage?: number
    current?: number
    temperature?: number
  }>(url, '/battery_state', 'sensor_msgs/msg/BatteryState', 1000)

  const pct = data?.percentage != null ? Math.round(data.percentage * 100) : null
  const voltage = data?.voltage ?? null
  const current = data?.current ?? null
  const temp = data?.temperature ?? null

  const pctColor = pct == null ? 'text-muted-foreground'
    : pct > 60 ? 'text-term-green'
    : pct > 30 ? 'text-term-yellow'
    : 'text-term-red'

  const barWidth = pct ?? 0
  const barColor = pct == null ? '#333'
    : pct > 60 ? '#5faf5f'
    : pct > 30 ? '#afaf5f'
    : '#af5f5f'

  return (
    <div className="border bg-card">
      <PanelHeader title="BATTERY" right={pct != null ? `${pct}%` : '--'} />
      <div className="p-2 space-y-2">
        {/* bar */}
        <div className="h-2 w-full bg-muted rounded-sm overflow-hidden">
          <div className="h-full rounded-sm transition-all" style={{ width: `${barWidth}%`, backgroundColor: barColor }} />
        </div>
        <div className="text-xs space-y-1">
          <TelemetryRow label="voltage" value={voltage != null ? `${voltage.toFixed(2)} V` : '--'} color={pctColor} />
          <TelemetryRow label="current" value={current != null ? `${current.toFixed(2)} A` : '--'} />
          {temp != null && temp > 0 && (
            <TelemetryRow label="temp" value={`${temp.toFixed(1)} °C`} color={temp > 50 ? 'text-term-red' : 'text-term-yellow'} />
          )}
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

  // sync slider to reported position only when close to target
  useEffect(() => {
    if (!dragging && Math.abs(pos - sliderVal) < 1.5) setSliderVal(pos)
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
    <div className="border bg-card flex flex-col w-16 shrink-0">
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
  return (
    <div className="border bg-card">
      <PanelHeader title="SKILL STATUS" />
      <div className="p-2 text-xs truncate">
        <span className="text-term-green">{data?.data ?? '--'}</span>
      </div>
    </div>
  )
}

function TTSPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: boolean }>(url, '/tts/is_playing', undefined, 500)
  return (
    <div className="border bg-card">
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

function parseChatMsg(raw: string | undefined, fallbackSender: 'user' | 'agent'): ChatMessage | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (fallbackSender === 'agent') {
      // brain state object -- extract to_tell_user, skip if null
      if ('to_tell_user' in parsed) {
        if (!parsed.to_tell_user) return null
        return { text: parsed.to_tell_user, sender: 'agent', timestamp: Date.now() / 1000 }
      }
    }
    return {
      text: parsed.text ?? raw,
      sender: parsed.sender ?? fallbackSender,
      timestamp: parsed.timestamp ?? Date.now() / 1000,
    }
  } catch {
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

  return (
    <div className="border bg-card">
      <PanelHeader title="CHAT" right={messages.length > 0 ? `${messages.length} msgs` : undefined} />
      <div ref={scrollRef} className="max-h-64 overflow-y-auto text-xs font-mono">
        {messages.length === 0 ? (
          <div className="px-2 py-4 text-muted-foreground text-center">no messages</div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="flex gap-2 px-2 py-0.5 hover:bg-accent/50 leading-tight">
              <span className="text-muted-foreground shrink-0">{formatChatTs(msg.timestamp)}</span>
              <span className={`shrink-0 ${msg.sender === 'user' ? 'text-term-cyan' : 'text-term-green'}`}>
                {msg.sender === 'user' ? 'user>' : 'agent>'}
              </span>
              <span className="text-foreground">{msg.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function WaypointsPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/brain/memory_positions', 'std_msgs/msg/String', 2000)
  let waypoints: Array<{ name: string }> = []
  try {
    if (data?.data) waypoints = JSON.parse(data.data)
  } catch { /* ignore */ }
  return (
    <div className="border bg-card">
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
    <div className="border bg-card">
      <PanelHeader title="DRIVE" />
      <div className="p-3 flex flex-col items-center gap-2">
        <button
          onClick={() => setActive((a) => !a)}
          className={`text-xs px-3 py-1 font-bold ${active
            ? 'bg-term-red text-primary-foreground'
            : 'bg-primary text-primary-foreground hover:bg-accent'
            }`}
        >
          {active ? 'RELEASE' : 'CONTROL'}
        </button>

        <div className="grid grid-cols-3 gap-1 w-20">
          <div />
          <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? k.w ? 'bg-term-green text-primary-foreground border-term-green' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>W</div>
          <div />
          <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? k.a ? 'bg-term-green text-primary-foreground border-term-green' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>A</div>
          <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? k.s ? 'bg-term-green text-primary-foreground border-term-green' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>S</div>
          <div className={`text-center text-xs border px-1 py-0.5 transition-colors ${active ? k.d ? 'bg-term-green text-primary-foreground border-term-green' : 'text-muted-foreground border-muted-foreground/50' : 'text-muted-foreground/30 border-muted-foreground/20'}`}>D</div>
        </div>
        <div className="text-[10px] text-muted-foreground">
          lin:{(lin * LIN_SPEED).toFixed(1)} ang:{(ang * ANG_SPEED).toFixed(1)}
        </div>
      </div>
    </div>
  )
}

function ChatInputPanel({ url }: { url: string }) {
  const [text, setText] = useState('')

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', { data: text.trim() })
    setText('')
  }

  return (
    <div className="border bg-card">
      <PanelHeader title="SEND CHAT" />
      <div className="p-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="message..."
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary"
        />
        <button onClick={send} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-accent">
          send
        </button>
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
    <div className="border bg-card">
      <PanelHeader title="SKILL UPDATE" />
      <div className="p-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="status..."
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary"
        />
        <button onClick={send} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-accent">
          send
        </button>
      </div>
    </div>
  )
}

function TTSControlPanel({ url }: { url: string }) {
  return (
    <div className="border bg-card">
      <PanelHeader title="TTS CONTROL" />
      <div className="p-2 flex gap-1">
        <button
          onClick={() => publishRosbridge(url, '/tts/is_playing', 'std_msgs/msg/Bool', { data: true })}
          className="text-xs px-2 py-1 bg-secondary text-secondary-foreground hover:bg-accent flex-1"
        >
          play
        </button>
        <button
          onClick={() => publishRosbridge(url, '/tts/is_playing', 'std_msgs/msg/Bool', { data: false })}
          className="text-xs px-2 py-1 bg-secondary text-secondary-foreground hover:bg-accent flex-1"
        >
          stop
        </button>
      </div>
    </div>
  )
}

function InputConfigPanel({ url }: { url: string }) {
  const [text, setText] = useState('')

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/input_manager/active_inputs', 'std_msgs/msg/String', { data: text.trim() })
    setText('')
  }

  return (
    <div className="border bg-card">
      <PanelHeader title="INPUT CONFIG" />
      <div className="p-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="config json..."
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary"
        />
        <button onClick={send} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-accent">
          send
        </button>
      </div>
    </div>
  )
}

function WaypointSendPanel({ url }: { url: string }) {
  const [text, setText] = useState('')

  function send() {
    if (!text.trim()) return
    publishRosbridge(url, '/brain/memory_positions', 'std_msgs/msg/String', { data: text.trim() })
    setText('')
  }

  return (
    <div className="border bg-card">
      <PanelHeader title="SEND WAYPOINTS" />
      <div className="p-2 flex gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder='[{"name":"home","x":0,"y":0}]'
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary"
        />
        <button onClick={send} className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-accent">
          send
        </button>
      </div>
    </div>
  )
}

// -- point cloud depth view --

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

    // scale: x range ±3m, z range 0–6m
    const xScale = w / 6   // ±3m maps to full width
    const zScale = h / 6   // 0–6m maps to full height (near=bottom)
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

    // centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()

    // distance rings at 1m, 2m, 3m
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
    <div className="border bg-card flex flex-col">
      <PanelHeader title="DEPTH CLOUD" right={data ? `${pointCount} pts` : 'no data'} />
      <div className="p-1">
        <canvas ref={canvasRef} width={320} height={240} className="w-full" style={{ imageRendering: 'pixelated' }} />
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

function LidarPanel({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data } = useRosbridgeTopic<LaserScanMsg>(url, '/scan', 'sensor_msgs/msg/LaserScan', 500)

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
    const maxRange = 2
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
    <div className="border bg-card w-[240px] h-[240px] shrink-0 flex flex-col">
      <PanelHeader title="LIDAR" right="/scan" />
      <div className="p-1 flex-1 min-h-0">
        <canvas ref={canvasRef} width={298} height={298} className="w-full h-full" />
      </div>
    </div>
  )
}

// -- event log --

function EventRow({ event }: { event: AgentEvent }) {
  const levelClass = LEVEL_STYLES[event.level] ?? 'text-foreground'
  const typeClass = TYPE_STYLES[event.type] ?? 'text-muted-foreground'
  return (
    <div className="flex gap-2 px-2 py-0.5 hover:bg-accent/50 leading-tight">
      <span className="text-muted-foreground shrink-0">{formatTs(event.ts)}</span>
      <span className={`shrink-0 uppercase font-bold ${levelClass}`}>{event.level.padEnd(5)}</span>
      <span className={`shrink-0 ${typeClass}`}>[{event.type}]</span>
      <span className="text-foreground">{event.msg}</span>
    </div>
  )
}

// -- location track --

// Fixed-world view: origin stays fixed, robot dot moves with real X/Y.
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

function ImuAccelPanel({ url }: { url: string }) {
  const { data } = useRosbridgeTopic<{ data?: string }>(url, '/robot/imu_odom', 'std_msgs/msg/String', 0)

  const parsed = (() => { try { return data?.data ? JSON.parse(data.data) : null } catch { return null } })()
  const xacc: number = parsed?.xacc ?? 0
  const yacc: number = parsed?.yacc ?? 0
  const zacc: number = parsed?.zacc ?? 0
  const pitch: number = parsed?.pitch ?? 0
  const roll: number  = parsed?.roll  ?? 0
  const yaw: number   = parsed?.yaw   ?? 0

  const MAX_MG = 2000  // display range ±2000 mg

  // centered bar: value can be negative or positive
  const AccelBar = ({ val, color, label }: { val: number; color: string; label: string }) => {
    const pct = Math.min(Math.abs(val) / MAX_MG * 50, 50)  // max 50% each side
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
    <div className="border bg-card flex flex-col">
      <PanelHeader title="IMU ACCEL" right={parsed ? 'live pixhawk' : 'run imu_odom_pub.py'} />
      <div className="p-2 space-y-2 text-xs">
        {parsed ? <>
          <AccelBar val={xacc} color="#af5f5f" label="X (fwd)" />
          <AccelBar val={yacc} color="#5faf5f" label="Y (left)" />
          <AccelBar val={zacc} color="#5f87af" label="Z (up)" />
          <div className="border-t pt-1 mt-1 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
            <span>roll {roll > 0 ? '+' : ''}{roll.toFixed(1)}°</span>
            <span>pitch {pitch > 0 ? '+' : ''}{pitch.toFixed(1)}°</span>
            <span>yaw {yaw > 0 ? '+' : ''}{yaw.toFixed(1)}°</span>
          </div>
        </> : (
          <div className="text-muted-foreground text-center py-2">no data</div>
        )}
      </div>
    </div>
  )
}

const OCC_SIZE = 64
const OCC_RANGE = 6 // meters per half-side

function LidarOccupancy({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<Float32Array>(new Float32Array(OCC_SIZE * OCC_SIZE))
  const maxRef = useRef(1)
  const frameRef = useRef(0)
  const { data } = useRosbridgeTopic<LaserScanMsg>(url, '/scan', 'sensor_msgs/msg/LaserScan', 500)

  useEffect(() => {
    if (!data?.ranges) return
    const grid = gridRef.current
    const { angle_min, angle_increment, ranges, range_min } = data
    const scale = OCC_SIZE / (OCC_RANGE * 2)
    const cx = OCC_SIZE / 2

    // decay existing values slightly
    for (let i = 0; i < grid.length; i++) grid[i] *= 0.995

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (r == null || !isFinite(r) || r < range_min || r > OCC_RANGE * 2) continue
      const angle = angle_min + i * angle_increment
      const gx = Math.floor(cx - Math.sin(angle) * r * scale)
      const gy = Math.floor(cx - Math.cos(angle) * r * scale)
      if (gx >= 0 && gx < OCC_SIZE && gy >= 0 && gy < OCC_SIZE) {
        grid[gy * OCC_SIZE + gx] += 1
      }
    }

    let max = 0
    for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i]
    if (max > 0) maxRef.current = max
    frameRef.current++

    // render
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const S = 256
    const cell = S / OCC_SIZE

    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, S, S)

    for (let y = 0; y < OCC_SIZE; y++) {
      for (let x = 0; x < OCC_SIZE; x++) {
        const n = grid[y * OCC_SIZE + x] / maxRef.current
        if (n < 0.01) continue
        let r: number, g: number, b: number
        if (n < 0.15) { const t = n / 0.15; r = 0; g = t * 120; b = 95 + t * 80 }
        else if (n < 0.35) { const t = (n - 0.15) / 0.2; r = 0; g = 120 + t * 55; b = 175 - t * 80 }
        else if (n < 0.6) { const t = (n - 0.35) / 0.25; r = t * 175; g = 175; b = 95 - t * 95 }
        else if (n < 0.85) { const t = (n - 0.6) / 0.25; r = 175 + t * 40; g = 175 - t * 80; b = 0 }
        else { const t = (n - 0.85) / 0.15; r = 215 + t * 40; g = 95 - t * 95; b = 0 }
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(x * cell, y * cell, cell, cell)
      }
    }

    ctx.strokeStyle = '#1c1c1c'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= OCC_SIZE; i += 8) {
      const p = i * cell
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke()
    }

    ctx.fillStyle = '#5f87af'
    ctx.fillRect(S / 2 - 2, S / 2 - 2, 4, 4)
  }, [data])

  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader title="LIDAR OCCUPANCY" right={`${frameRef.current} scans`} />
      <div className="p-2 flex justify-center">
        <canvas ref={canvasRef} width={256} height={256} style={{ width: 256, height: 256 }} />
      </div>
    </div>
  )
}

// -- lidar vision check --

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

  // "blocked" = reading is 0, null, non-finite, or below min range (object touching/blocking lidar)
  // "suspicious" = reading is valid but unusually close (< 35% of median)
  const isBlocked = (r: number | null) =>
    r == null || !isFinite(r) || r <= 0 || r < rmin

  const valid = ranges.filter(r => r != null && isFinite(r) && r > rmin && r < rmax) as number[]
  const median = valid.length >= 20
    ? [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)]
    : null

  // flag indices that are either blocked OR suspiciously close
  const hot = ranges.reduce<number[]>((acc, r, i) => {
    if (isBlocked(r)) { acc.push(i); return acc }
    if (median && (r as number) < median * 0.35) { acc.push(i); return acc }
    return acc
  }, [])

  if (hot.length < 5) return null

  // find longest contiguous cluster (gap ≤ 3)
  const clusters: number[][] = []
  let cur = [hot[0]]
  for (let i = 1; i < hot.length; i++) {
    if (hot[i] - cur[cur.length - 1] <= 3) cur.push(hot[i])
    else { clusters.push(cur); cur = [hot[i]] }
  }
  clusters.push(cur)
  const best = clusters.reduce((a, b) => b.length > a.length ? b : a)
  console.log('[lidar-check] hot beams:', hot.length, 'best cluster:', best.length, 'all clusters:', clusters.map(c => c.length))
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
  }, [chatOut])

  useEffect(() => {
    if (tts?.data) handleBrainReply(tts.data)
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
      setResult({ verdict: 'no_anomaly', message: 'Lidar looks normal — no close-range anomalies detected.' })
      setState('done')
      return
    }

    setState('waiting_brain')
    waitingSession.current = session
    const question = `Look straight ahead. Is there a solid physical object, wall, or obstacle directly blocking the camera view or the robot's immediate path? Answer with YES or NO followed by one sentence of explanation.`
    publishRosbridge(url, '/brain/chat_in', 'std_msgs/msg/String', { data: question })

    setResult({ verdict: 'clear', message: `Anomaly at ${anomaly.angleDeg}° / ${anomaly.rangeM}m — asking brain…`, anomaly })

    // timeout after 20s
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
    <div className="border bg-card flex flex-col col-span-2">
      <PanelHeader title="LIDAR ✕ VISION CHECK" right={scan ? `${scan.ranges?.length ?? 0} beams` : 'no scan'} />
      <div className="p-3 space-y-2 text-xs">
        <button
          onClick={runCheck}
          disabled={state === 'checking' || state === 'waiting_brain'}
          className="w-full py-1 border border-term-cyan text-term-cyan bg-transparent hover:bg-term-cyan/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs"
        >
          {state === 'checking' ? 'ANALYZING LIDAR…' : state === 'waiting_brain' ? 'ASKING BRAIN…' : '▶ RUN LIDAR × VISION CHECK'}
        </button>
        {result && (
          <div className="space-y-1">
            <div className={`font-mono ${verdictColor}`}>{result.message}</div>
            {result.anomaly && (
              <div className="text-muted-foreground">
                anomaly: {result.anomaly.angleDeg}° · {result.anomaly.rangeM}m · {result.anomaly.clusterSize} beams · median {result.anomaly.medianM}m
              </div>
            )}
            {result.brainReply && (
              <div className="text-muted-foreground italic">brain: "{result.brainReply}"</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// -- skills panel --

function OdomFdirPanel({ url }: { url: string }) {
  const { data: odomData } = useRosbridgeTopic<Record<string, unknown>>(url, '/odom', 'nav_msgs/msg/Odometry', 200)
  const { data: amclData } = useRosbridgeTopic<Record<string, unknown>>(url, '/amcl_pose', 'geometry_msgs/msg/PoseWithCovarianceStamped', 200)

  const baselineRef = useRef<{ odom: [number,number] | null; amcl: [number,number] | null } | null>(null)
  const [running, setRunning] = useState(false)
  const [verdict, setVerdict] = useState<{ status: string; msg: string } | null>(null)

  // refs so the setTimeout callback always reads the latest values
  const latestOdomDeltaRef = useRef<number | null>(null)
  const latestAmclDeltaRef = useRef<number | null>(null)

  const getPos = (d: Record<string, unknown> | null): [number,number] | null => {
    try {
      const p = (d as any)?.pose?.pose?.position
      if (typeof p?.x === 'number' && typeof p?.y === 'number') return [p.x, p.y]
    } catch {}
    return null
  }

  const odomPos = getPos(odomData as any)
  const amclPos = getPos(amclData as any)

  const dist = (a: [number,number] | null, b: [number,number] | null) =>
    a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null

  const odomDelta = running ? dist(baselineRef.current?.odom ?? null, odomPos) : null
  const amclDelta = running ? dist(baselineRef.current?.amcl ?? null, amclPos) : null

  // keep refs in sync with latest rendered values
  latestOdomDeltaRef.current = odomDelta
  latestAmclDeltaRef.current = amclDelta

  const divergence = odomDelta != null && amclDelta != null ? odomDelta - amclDelta : null
  const isFault = divergence != null && odomDelta! > 0.15 && divergence > odomDelta! * 0.5

  function startCheck() {
    baselineRef.current = { odom: odomPos, amcl: amclPos }
    latestOdomDeltaRef.current = null
    latestAmclDeltaRef.current = null
    setRunning(true)
    setVerdict(null)
    setTimeout(() => {
      // read refs — these have the latest values, not stale closure values
      const od = latestOdomDeltaRef.current
      const ad = latestAmclDeltaRef.current
      const fault = od != null && od > 0.15 && ad != null && ad < od * 0.5
      setRunning(false)
      setVerdict(fault
        ? { status: 'fault', msg: `Wheel slip! Odom: ${od?.toFixed(3)}m  AMCL: ${ad?.toFixed(3)}m` }
        : { status: 'nominal', msg: `All sources agree — odom: ${od?.toFixed(3)}m  amcl: ${ad?.toFixed(3)}m` }
      )
    }, 20000)
  }

  const bar = (val: number | null, max: number, color: string) => (
    <div className="h-2 w-full bg-muted rounded-sm overflow-hidden">
      <div className="h-full rounded-sm transition-all" style={{ width: `${Math.min(100, ((val ?? 0) / max) * 100)}%`, backgroundColor: color }} />
    </div>
  )

  return (
    <div className="border bg-card flex flex-col col-span-2">
      <PanelHeader title="ODOM FDIR" right="wheel slip detection" />
      <div className="p-3 space-y-3 text-xs">
        <button
          onClick={startCheck}
          disabled={running}
          className="w-full py-1 border border-term-cyan text-term-cyan bg-transparent hover:bg-term-cyan/10 disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs"
        >
          {running ? 'MONITORING… (lift wheels now)' : '▶ START ODOM FDIR CHECK'}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-muted-foreground">ODOM Δ</span>
              <span className="text-term-yellow font-mono">{odomDelta != null ? `${odomDelta.toFixed(3)}m` : '--'}</span>
            </div>
            {bar(odomDelta, 1.2, '#afaf5f')}
            <div className="text-[10px] text-muted-foreground mt-0.5">wheel encoders</div>
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-muted-foreground">AMCL Δ</span>
              <span className="text-term-green font-mono">{amclDelta != null ? `${amclDelta.toFixed(3)}m` : '--'}</span>
            </div>
            {bar(amclDelta, 1.2, '#5faf5f')}
            <div className="text-[10px] text-muted-foreground mt-0.5">lidar map-match</div>
          </div>
        </div>

        {running && divergence != null && (
          <div className={`font-mono text-center py-1 border ${isFault ? 'border-term-red text-term-red' : 'border-term-green text-term-green'}`}>
            {isFault
              ? `⚠ WHEEL SLIP  divergence: ${divergence.toFixed(3)}m`
              : `✓ NOMINAL  divergence: ${divergence.toFixed(3)}m`}
          </div>
        )}

        {verdict && !running && (
          <div className={`font-mono text-center py-1 border ${verdict.status === 'fault' ? 'border-term-red text-term-red' : 'border-term-green text-term-green'}`}>
            {verdict.status === 'fault' ? '⚠ FAULT' : '✓ NOMINAL'} — {verdict.msg}
          </div>
        )}
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
    <div className="border bg-card flex flex-col col-span-2">
      <PanelHeader title="SKILLS" right={skills.length ? `${skills.length} available` : 'loading…'} />
      <div className="flex flex-col divide-y text-xs max-h-72 overflow-y-auto">
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
    <div className="border bg-card">
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
          <div className="border bg-card flex flex-col w-[400px]">
            <PanelHeader title="MAIN CAMERA" right="/main_camera/left" />
            <div className="aspect-video bg-black">
              {url ? (
                <ImageFeed url={url} topic="/mars/main_camera/left/image_raw/compressed" label="MAIN" />
              ) : (
                <SimulatedFeed agent={agent} />
              )}
            </div>
          </div>
          {url && <HeadPositionPanel url={url} />}
        </div>

        <div className="border bg-card flex flex-col w-[400px] shrink-0">
          <PanelHeader title="ARM CAMERA" right="/arm/image_raw" />
          <div className="aspect-video bg-black">
            {url ? (
              <ImageFeed url={url} topic="/mars/arm/image_raw/compressed" label="ARM" />
            ) : (
              <SimulatedFeed agent={agent} />
            )}
          </div>
        </div>

        <div className="border bg-card flex flex-col flex-1 min-w-[200px]">
          <PanelHeader title="AGENT INFO" />
          <div className="p-3 text-xs space-y-2 flex-1">
            <TelemetryRow label="name" value={agent.name} />
            <TelemetryRow label="id" value={agent.id} />
            <TelemetryRow label="status" value={agent.status} color={statusColor} />
            {url && <TelemetryRow label="ws" value={url} color="text-term-cyan" />}
          </div>
        </div>

        {url && <LidarPanel url={url} />}
      </div>

      {/* telemetry grid */}
      {url && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="border bg-card flex flex-col">
            <PanelHeader title="ENCODER ODOM" right="map frame /amcl_pose" />
            <div className="p-1 aspect-square">
              <LiveLocationTrack url={url} />
            </div>
          </div>
          <ImuAccelPanel url={url} />
          <BatteryPanel url={url} />
          <SysStatsPanel url={url} />
          <DrivePanel url={url} />
          <SkillStatusPanel url={url} />
          <TTSPanel url={url} />
          <WaypointsPanel url={url} />
          <SkillsPanel url={url} />
          <LidarVisionCheck url={url} />
          <OdomFdirPanel url={url} />
        </div>
      )}

      {/* controls */}
      {url && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <GotoPanel url={url} />
          <ChatInputPanel url={url} />
          <SkillUpdatePanel url={url} />
          <TTSControlPanel url={url} />
          <InputConfigPanel url={url} />
          <WaypointSendPanel url={url} />
        </div>
      )}

      {/* chat */}
      {url && <ChatPanel url={url} />}

      {/* lidar occupancy + depth cloud */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {url ? (
          <LidarOccupancy url={url} />
        ) : (
          <div className="border bg-card flex flex-col">
            <PanelHeader title="LIDAR OCCUPANCY" />
            <div className="p-2 aspect-square max-h-64 flex items-center justify-center text-xs text-muted-foreground">
              no rosbridge
            </div>
          </div>
        )}
        {url && <DepthCloudPanel url={url} />}
      </div>

      {/* event log */}
      <div className="border bg-card flex flex-col">
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
