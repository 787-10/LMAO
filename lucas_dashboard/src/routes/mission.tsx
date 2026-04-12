import { useEffect, useRef, useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import {
  useOrchestratorEvents,
  useSendCommand,
  useFleet,
  useMissions,
} from '@/hooks/useOrchestrator'
import type {
  HealthTier,
  OrchestratorRobot,
  OrchestratorTask,
  OrchestratorTaskStatus,
  WorldEvent,
} from '@/lib/types'

export const missionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission',
  component: MissionPage,
})

// -- helpers --

function PanelHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="border-b px-2 py-1 text-xs text-muted-foreground flex items-center justify-between">
      <span>{title}</span>
      {right && <span>{right}</span>}
    </div>
  )
}

function tierColor(tier: HealthTier): string {
  switch (tier) {
    case 'FULL_CAPABILITY': return 'text-term-green'
    case 'DEGRADED_SENSORS': return 'text-term-yellow'
    case 'LOCAL_ONLY': return 'text-term-cyan'
    case 'SAFE_MODE': return 'text-term-red'
    case 'HIBERNATION': return 'text-muted-foreground'
  }
}

function tierLabel(tier: HealthTier): string {
  switch (tier) {
    case 'FULL_CAPABILITY': return 'FULL'
    case 'DEGRADED_SENSORS': return 'DEGRADED'
    case 'LOCAL_ONLY': return 'LOCAL'
    case 'SAFE_MODE': return 'SAFE'
    case 'HIBERNATION': return 'HIBERNATE'
  }
}

function taskStatusColor(status: OrchestratorTaskStatus): string {
  switch (status) {
    case 'COMPLETED': return 'text-term-green'
    case 'IN_PROGRESS': return 'text-term-yellow'
    case 'FAILED': return 'text-term-red'
    case 'PENDING': return 'text-muted-foreground'
    case 'IDLE': return 'text-muted-foreground'
  }
}

function eventColor(type: string): string {
  switch (type) {
    case 'ROBOT_DEGRADED': return 'text-term-red'
    case 'ROBOT_RECOVERED': return 'text-term-green'
    case 'TASK_COMPLETED': return 'text-term-green'
    case 'TASK_FAILED': return 'text-term-red'
    case 'COMMS_LOST': return 'text-term-red'
    case 'COMMS_RESTORED': return 'text-term-cyan'
    default: return 'text-muted-foreground'
  }
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { hour12: false })
}

function formatPos(pos: [number, number, number] | null): string {
  if (!pos) return '--'
  return `(${pos[0].toFixed(1)}, ${pos[1].toFixed(1)})`
}

// -- CommandPanel --

interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

function CommandPanel() {
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<ChatEntry[]>([])
  const { send, pending } = useSendCommand()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [history])

  async function handleSend() {
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setHistory((h) => [...h, { role: 'user', text, ts: Date.now() / 1000 }])
    const response = await send(text)
    setHistory((h) => [...h, { role: 'assistant', text: response, ts: Date.now() / 1000 }])
  }

  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader title="COMMAND" right={pending ? 'thinking...' : ''} />
      <div ref={scrollRef} className="h-48 overflow-y-auto p-2 text-xs space-y-1">
        {history.length === 0 && (
          <div className="text-muted-foreground text-center py-4">
            type a command to send to the mission planner
          </div>
        )}
        {history.map((entry, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-muted-foreground shrink-0">{formatTime(entry.ts)}</span>
            <span className={`shrink-0 font-bold ${entry.role === 'user' ? 'text-term-cyan' : 'text-term-green'}`}>
              {entry.role === 'user' ? 'you>' : 'hub>'}
            </span>
            <span className="text-foreground whitespace-pre-wrap">{entry.text}</span>
          </div>
        ))}
      </div>
      <div className="border-t p-2 flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="send scout-1 to position (3, 2)..."
          disabled={pending}
          className="flex-1 bg-secondary text-foreground text-xs px-2 py-1 border outline-none focus:border-primary disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={pending}
          className="text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-accent disabled:opacity-50"
        >
          {pending ? '...' : 'send'}
        </button>
      </div>
    </div>
  )
}

// -- FleetOverviewPanel --

function RobotCard({ robot }: { robot: OrchestratorRobot }) {
  const battPct = robot.battery_percentage ?? 0
  return (
    <div className="border bg-secondary p-2 text-xs space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-bold">{robot.name}</span>
        <span className={`${robot.connected ? 'text-term-green' : 'text-term-red'} ${robot.connected ? 'status-live' : ''}`}>
          {robot.connected ? '●' : '○'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-bold ${tierColor(robot.health_tier)}`}>
          [{tierLabel(robot.health_tier)}]
        </span>
      </div>
      <div className="flex items-center justify-between text-muted-foreground">
        <span>pos: {formatPos(robot.position)}</span>
        <span>bat: {robot.battery_percentage != null ? `${battPct.toFixed(0)}%` : '?'}</span>
      </div>
      {/* battery bar */}
      <div className="h-1 bg-background">
        <div
          className={`h-full transition-all ${battPct > 30 ? 'bg-term-green' : battPct > 10 ? 'bg-term-yellow' : 'bg-term-red'}`}
          style={{ width: `${Math.max(0, Math.min(100, battPct))}%` }}
        />
      </div>
      <div className="text-muted-foreground">
        task: {robot.current_task_id ?? 'idle'}
        {robot.current_task_id && (
          <span className={` ml-1 ${taskStatusColor(robot.task_status)}`}>[{robot.task_status}]</span>
        )}
      </div>
    </div>
  )
}

function FleetOverviewPanel() {
  const { robots, loading } = useFleet()
  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader title="FLEET OVERVIEW" right={`${robots.length} robots`} />
      <div className="p-2 space-y-2 overflow-y-auto max-h-64">
        {loading && <div className="text-xs text-muted-foreground text-center py-4">loading...</div>}
        {!loading && robots.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">no robots</div>
        )}
        {robots.map((r) => <RobotCard key={r.name} robot={r} />)}
      </div>
    </div>
  )
}

// -- MissionTasksPanel --

function TaskRow({ task }: { task: OrchestratorTask }) {
  return (
    <div className="flex gap-3 px-2 py-0.5 hover:bg-accent/50 text-xs">
      <span className="text-muted-foreground w-16 shrink-0">{task.id}</span>
      <span className="text-term-blue w-16 shrink-0">{task.task_type}</span>
      <span className="text-term-cyan w-16 shrink-0">{task.assigned_robot ?? '--'}</span>
      <span className={`w-20 shrink-0 font-bold ${taskStatusColor(task.status)}`}>{task.status}</span>
      <span className="text-foreground truncate">{task.description}</span>
    </div>
  )
}

function MissionTasksPanel() {
  const { missions, loading } = useMissions()
  const active = missions.find((m) => m.status === 'ACTIVE' || m.status === 'REPLANNING')

  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader
        title="MISSION / TASKS"
        right={active ? `[${active.status}]` : 'none'}
      />
      <div className="overflow-y-auto max-h-64">
        {loading && <div className="text-xs text-muted-foreground text-center py-4">loading...</div>}
        {!loading && !active && (
          <div className="text-xs text-muted-foreground text-center py-4">
            no active mission — send a command to create one
          </div>
        )}
        {active && (
          <>
            <div className="px-2 py-1 text-xs text-muted-foreground border-b">
              {active.description} <span className="text-term-cyan">({active.id})</span>
            </div>
            {/* header row */}
            <div className="flex gap-3 px-2 py-0.5 text-xs text-muted-foreground border-b">
              <span className="w-16 shrink-0">ID</span>
              <span className="w-16 shrink-0">TYPE</span>
              <span className="w-16 shrink-0">ROBOT</span>
              <span className="w-20 shrink-0">STATUS</span>
              <span>DESCRIPTION</span>
            </div>
            {active.tasks.map((t) => <TaskRow key={t.id} task={t} />)}
          </>
        )}
      </div>
    </div>
  )
}

// -- EventStreamPanel --

function EventStreamPanel({ events }: { events: WorldEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [events])

  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader title="EVENT STREAM" right={`${events.length} events`} />
      <div ref={scrollRef} className="max-h-40 overflow-y-auto text-xs">
        {events.length === 0 ? (
          <div className="px-2 py-4 text-muted-foreground text-center">waiting for events...</div>
        ) : (
          events.map((evt, i) => (
            <div key={i} className="flex gap-2 px-2 py-0.5 hover:bg-accent/50 leading-tight">
              <span className="text-muted-foreground shrink-0">{formatTime(evt.timestamp)}</span>
              <span className={`shrink-0 font-bold ${eventColor(evt.type)}`}>{evt.type}</span>
              <span className="text-term-cyan shrink-0">{evt.robot}</span>
              <span className="text-foreground truncate">
                {JSON.stringify(evt.data)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// -- MissionPage --

function MissionPage() {
  const { events, connected } = useOrchestratorEvents()
  const orchColor = connected ? 'text-term-green' : 'text-term-red'
  const orchStatus = connected ? 'connected' : 'disconnected'

  return (
    <div className="flex flex-col gap-3">
      {/* header */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold">~/mission</h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`${orchColor} ${connected ? 'status-live' : ''}`}>●</span>
          <span className={orchColor}>orch: {orchStatus}</span>
        </div>
      </div>

      {/* command input */}
      <CommandPanel />

      {/* fleet + mission side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-3">
        <FleetOverviewPanel />
        <MissionTasksPanel />
      </div>

      {/* event stream */}
      <EventStreamPanel events={events} />
    </div>
  )
}
