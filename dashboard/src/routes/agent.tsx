import { useEffect, useRef } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import {
  AGENTS,
  type Agent,
  type AgentEvent,
  type EventLevel,
} from '@/lib/agents'

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
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function PanelHeader({
  title,
  right,
}: {
  title: string
  right?: string
}) {
  return (
    <div className="border-b px-2 py-1 text-xs text-muted-foreground flex items-center justify-between">
      <span>{title}</span>
      {right && <span>{right}</span>}
    </div>
  )
}

function CameraFeed({ agent }: { agent: Agent }) {
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
      const w = canvas.width
      const h = canvas.height

      ctx.fillStyle = '#080808'
      ctx.fillRect(0, 0, w, h)

      if (agent.status === 'offline') {
        // static noise
        const imgData = ctx.createImageData(w, h)
        for (let i = 0; i < imgData.data.length; i += 4) {
          const v = Math.random() * 40
          imgData.data[i] = v
          imgData.data[i + 1] = v
          imgData.data[i + 2] = v
          imgData.data[i + 3] = 255
        }
        ctx.putImageData(imgData, 0, 0)
      } else {
        // simulated scene: moving scanlines + noise
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x += 3) {
            const noise = Math.random() * 15
            const scanline = Math.sin((y + frame * 0.5) * 0.1) * 8 + 20
            const v = Math.max(0, Math.min(50, scanline + noise))
            ctx.fillStyle = `rgb(${v}, ${v + 2}, ${v + 5})`
            ctx.fillRect(x, y, 3, 1)
          }
        }

        // crosshair
        ctx.strokeStyle = 'rgba(95, 135, 175, 0.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(w / 2, 0)
        ctx.lineTo(w / 2, h)
        ctx.moveTo(0, h / 2)
        ctx.lineTo(w, h / 2)
        ctx.stroke()

        // center reticle
        ctx.strokeStyle = 'rgba(95, 135, 175, 0.7)'
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, 20, 0, Math.PI * 2)
        ctx.stroke()
      }

      // overlay text
      ctx.font = '10px monospace'
      ctx.fillStyle = agent.status === 'offline' ? '#d75f5f' : '#5f87af'
      ctx.fillText(agent.id.toUpperCase(), 6, 14)

      ctx.fillStyle = '#6c6c6c'
      ctx.fillText(`f:${String(frame).padStart(5, '0')}`, w - 60, 14)

      if (agent.status === 'online') {
        ctx.fillStyle = '#d75f5f'
        ctx.beginPath()
        ctx.arc(w - 70, 10, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#d75f5f'
        ctx.fillText('REC', w - 64, 14)
      }

      if (agent.status === 'offline') {
        ctx.font = '14px monospace'
        ctx.fillStyle = '#d75f5f'
        const text = 'NO SIGNAL'
        const tw = ctx.measureText(text).width
        ctx.fillText(text, (w - tw) / 2, h / 2)
      } else if (agent.status === 'idle') {
        ctx.font = '11px monospace'
        ctx.fillStyle = '#afaf5f'
        const text = 'STANDBY'
        const tw = ctx.measureText(text).width
        ctx.fillText(text, (w - tw) / 2, h - 10)
      }

      frame++
      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [agent])

  return <canvas ref={canvasRef} width={384} height={216} className="w-full h-full" />
}

function LocationTrack({ agent }: { agent: Agent }) {
  const { track } = agent
  if (track.length < 2) return null

  const points = track.map((p) => `${p.x},${p.y}`).join(' ')
  const last = track[track.length - 1]

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {/* grid */}
      {Array.from({ length: 11 }, (_, i) => (
        <line
          key={`gx-${i}`}
          x1={i * 10} y1={0} x2={i * 10} y2={100}
          stroke="currentColor" className="text-border" strokeWidth={0.3}
        />
      ))}
      {Array.from({ length: 11 }, (_, i) => (
        <line
          key={`gy-${i}`}
          x1={0} y1={i * 10} x2={100} y2={i * 10}
          stroke="currentColor" className="text-border" strokeWidth={0.3}
        />
      ))}

      {/* trail fade */}
      {track.slice(0, -1).map((p, i) => {
        const next = track[i + 1]
        const opacity = 0.15 + (i / track.length) * 0.6
        return (
          <line
            key={i}
            x1={p.x} y1={p.y} x2={next.x} y2={next.y}
            stroke="#5f87af" strokeWidth={1} opacity={opacity}
          />
        )
      })}

      {/* track points */}
      {track.map((p, i) => (
        <circle
          key={i}
          cx={p.x} cy={p.y} r={i === track.length - 1 ? 2.5 : 1}
          fill={i === track.length - 1 ? '#5f87af' : '#6c6c6c'}
        />
      ))}

      {/* current position label */}
      <text
        x={last.x} y={last.y - 5}
        fontSize={5} fill="#5f87af" textAnchor="middle" fontFamily="monospace"
      >
        ({last.x},{last.y})
      </text>

      {/* polyline overlay */}
      <polyline
        points={points}
        fill="none" stroke="#5f87af" strokeWidth={0.5}
        strokeDasharray="2 1" opacity={0.3}
      />
    </svg>
  )
}

function Heatmap({ agent }: { agent: Agent }) {
  const { heatmap } = agent
  const size = heatmap.length

  function cellColor(val: number): string {
    if (val < 0.1) return 'rgba(28, 28, 28, 0.8)'
    if (val < 0.25) return 'rgba(95, 135, 175, 0.25)'
    if (val < 0.4) return 'rgba(95, 175, 175, 0.4)'
    if (val < 0.6) return 'rgba(95, 175, 95, 0.5)'
    if (val < 0.75) return 'rgba(175, 175, 95, 0.6)'
    if (val < 0.9) return 'rgba(175, 135, 95, 0.75)'
    return 'rgba(215, 95, 95, 0.85)'
  }

  const cellSize = 100 / size

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {heatmap.map((row, y) =>
        row.map((val, x) => (
          <rect
            key={`${x}-${y}`}
            x={x * cellSize} y={y * cellSize}
            width={cellSize} height={cellSize}
            fill={cellColor(val)}
          />
        )),
      )}
      {/* grid overlay */}
      {Array.from({ length: size + 1 }, (_, i) => (
        <line
          key={`hx-${i}`}
          x1={i * cellSize} y1={0} x2={i * cellSize} y2={100}
          stroke="currentColor" className="text-border" strokeWidth={0.15}
        />
      ))}
      {Array.from({ length: size + 1 }, (_, i) => (
        <line
          key={`hy-${i}`}
          x1={0} y1={i * cellSize} x2={100} y2={i * cellSize}
          stroke="currentColor" className="text-border" strokeWidth={0.15}
        />
      ))}
    </svg>
  )
}

function EventRow({ event }: { event: AgentEvent }) {
  const levelClass = LEVEL_STYLES[event.level] ?? 'text-foreground'
  const typeClass = TYPE_STYLES[event.type] ?? 'text-muted-foreground'

  return (
    <div className="flex gap-2 px-2 py-0.5 hover:bg-accent/50 leading-tight">
      <span className="text-muted-foreground shrink-0">
        {formatTs(event.ts)}
      </span>
      <span className={`shrink-0 uppercase font-bold ${levelClass}`}>
        {event.level.padEnd(5)}
      </span>
      <span className={`shrink-0 ${typeClass}`}>[{event.type}]</span>
      <span className="text-foreground">{event.msg}</span>
    </div>
  )
}

function AgentPage() {
  const { agentId } = agentRoute.useParams()
  const agent = AGENTS.find((a) => a.id === agentId)

  if (!agent) {
    return (
      <div className="text-destructive text-xs">
        error: agent &quot;{agentId}&quot; not found
      </div>
    )
  }

  const statusColor =
    agent.status === 'online'
      ? 'text-term-green'
      : agent.status === 'idle'
        ? 'text-term-yellow'
        : 'text-term-red'

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-sm font-bold">~/agents/{agent.id}</h1>

      {/* top row: camera + info */}
      <div className="flex flex-wrap gap-3">
        {/* camera feed */}
        <div className="border bg-card flex flex-col w-[400px] shrink-0">
          <PanelHeader
            title="CAMERA FEED"
            right={agent.status === 'online' ? 'LIVE' : agent.status.toUpperCase()}
          />
          <div className="aspect-video bg-black">
            <CameraFeed agent={agent} />
          </div>
        </div>

        {/* agent info */}
        <div className="border bg-card flex flex-col flex-1 min-w-[200px]">
          <PanelHeader title="AGENT INFO" />
          <div className="p-3 text-xs space-y-2 flex-1">
            <div>
              name: <span className="font-bold">{agent.name}</span>
            </div>
            <div>
              id: <span className="text-muted-foreground">{agent.id}</span>
            </div>
            <div>
              status: <span className={statusColor}>{agent.status}</span>
            </div>
            <div>
              feed: <span className="text-muted-foreground">{agent.feedUrl}</span>
            </div>
            <div className="border-t pt-2 mt-3">
              <div>track pts: <span className="text-muted-foreground">{agent.track.length}</span></div>
              <div>last pos: <span className="text-term-blue">({agent.track[agent.track.length - 1]?.x},{agent.track[agent.track.length - 1]?.y})</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* middle row: location track + heatmap */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="border bg-card flex flex-col">
          <PanelHeader title="LOCATION TRACK" right={`${agent.track.length} pts`} />
          <div className="p-2 aspect-square max-h-64">
            <LocationTrack agent={agent} />
          </div>
        </div>

        <div className="border bg-card flex flex-col">
          <PanelHeader title="LOCATION HEATMAP" right="16x16 grid" />
          <div className="p-2 aspect-square max-h-64">
            <Heatmap agent={agent} />
          </div>
        </div>
      </div>

      {/* event log */}
      <div className="border bg-card flex flex-col">
        <PanelHeader title="EVENT LOG" right={`${agent.events.length} entries`} />
        <div className="max-h-48 overflow-y-auto text-xs">
          {agent.events.length === 0 ? (
            <div className="px-2 py-4 text-muted-foreground text-center">
              no events recorded
            </div>
          ) : (
            agent.events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
