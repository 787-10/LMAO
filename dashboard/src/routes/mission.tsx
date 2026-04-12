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
    case 'CLAUDE_MESSAGE': return 'text-term-magenta'
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

type ChatRole = 'user' | 'assistant' | 'tool_use' | 'tool_result'

interface ChatEntry {
  role: ChatRole
  text: string
  ts: number
}

function chatRoleLabel(role: ChatRole): string {
  switch (role) {
    case 'user': return 'you>'
    case 'assistant': return 'hub>'
    case 'tool_use': return '→tool'
    case 'tool_result': return 'tool→'
  }
}

function chatRoleColor(role: ChatRole): string {
  switch (role) {
    case 'user': return 'text-term-cyan'
    case 'assistant': return 'text-term-green'
    case 'tool_use': return 'text-term-yellow'
    case 'tool_result': return 'text-muted-foreground'
  }
}

// -- tool entry rendering: parse `name(args)` or `name → json` into structured view --

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function parseToolText(role: 'tool_use' | 'tool_result', text: string): { name: string; body: unknown } {
  if (role === 'tool_use') {
    const m = text.match(/^([\w./_-]+)\((.*)\)$/s)
    if (m) return { name: m[1], body: tryParseJson(m[2]) ?? m[2] }
  } else {
    const m = text.match(/^([\w./_-]+)\s*→\s*(.*)$/s)
    if (m) return { name: m[1], body: tryParseJson(m[2]) ?? m[2] }
  }
  return { name: '', body: text }
}

function PrettyValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-term-green' : 'text-term-red'}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="text-term-cyan">{value}</span>
  }
  if (typeof value === 'string') {
    // auto-unwrap stringified JSON
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = tryParseJson(trimmed)
      if (parsed !== null) return <PrettyValue value={parsed} depth={depth} />
    }
    return <span className="text-foreground whitespace-pre-wrap break-words">{value}</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>
    return (
      <div className="pl-2 border-l border-border/60">
        {value.map((v, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-muted-foreground shrink-0">[{i}]</span>
            <div className="min-w-0 flex-1"><PrettyValue value={v} depth={depth + 1} /></div>
          </div>
        ))}
      </div>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>
  return (
    <div className={depth > 0 ? 'pl-2 border-l border-border/60' : ''}>
      {entries.map(([k, v]) => {
        const isScalar = v === null || typeof v !== 'object'
        return (
          <div key={k} className={isScalar ? 'flex gap-2' : ''}>
            <span className="text-primary shrink-0">{k}</span>
            <span className="text-muted-foreground shrink-0">{isScalar ? ':' : ''}</span>
            <div className={isScalar ? 'min-w-0 flex-1' : ''}>
              <PrettyValue value={v} depth={depth + 1} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ToolEntry({ role, text }: { role: 'tool_use' | 'tool_result'; text: string }) {
  const { name, body } = parseToolText(role, text)
  const arrow = role === 'tool_use' ? '▶' : '◀'
  const color = role === 'tool_use' ? 'text-term-yellow' : 'text-term-cyan'
  return (
    <div className="flex-1 min-w-0 border border-border/40 bg-background/50 px-2 py-1">
      <div className={`text-[10px] font-bold ${color} flex items-center gap-1`}>
        <span>{arrow}</span>
        <span>{name || 'tool'}</span>
      </div>
      <div className="mt-0.5 text-[11px] leading-snug">
        <PrettyValue value={body} />
      </div>
    </div>
  )
}

function CommandPanel({ events }: { events: WorldEvent[] }) {
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<ChatEntry[]>([])
  const { send, pending } = useSendCommand()
  const scrollRef = useRef<HTMLDivElement>(null)
  const consumedRef = useRef<number>(0)

  // pull CLAUDE_MESSAGE events from the stream into chat history
  useEffect(() => {
    for (let i = consumedRef.current; i < events.length; i++) {
      const evt = events[i]
      if (evt.type !== 'CLAUDE_MESSAGE') continue
      const role = (evt.data.role as string) ?? ''
      const kind = (evt.data.kind as string) ?? ''
      const content = (evt.data.content as string) ?? ''
      // skip user prompts — we already render the local user entry on send
      if (role === 'user') continue
      let entryRole: ChatRole | null = null
      if (role === 'assistant' && kind === 'text') entryRole = 'assistant'
      else if (role === 'assistant' && kind === 'tool_use') entryRole = 'tool_use'
      else if (role === 'tool') entryRole = 'tool_result'
      if (entryRole) {
        setHistory(h => [...h, { role: entryRole!, text: content, ts: evt.timestamp }])
      }
    }
    consumedRef.current = events.length
  }, [events])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [history])

  async function handleSend() {
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setHistory((h) => [...h, { role: 'user', text, ts: Date.now() / 1000 }])
    // fire-and-forget: responses arrive via CLAUDE_MESSAGE events
    void send(text)
  }

  return (
    <div className="border bg-card flex flex-col flex-1 min-h-0">
      <PanelHeader title="COMMAND" right={pending ? 'thinking...' : ''} />
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2 text-xs space-y-1">
        {history.length === 0 && (
          <div className="text-muted-foreground text-center py-4">
            type a command to send to the mission planner
          </div>
        )}
        {history.map((entry, i) => {
          const isTool = entry.role === 'tool_use' || entry.role === 'tool_result'
          return (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-muted-foreground shrink-0">{formatTime(entry.ts)}</span>
              <span className={`shrink-0 font-bold ${chatRoleColor(entry.role)}`}>
                {chatRoleLabel(entry.role)}
              </span>
              {isTool
                ? <ToolEntry role={entry.role as 'tool_use' | 'tool_result'} text={entry.text} />
                : <span className="text-foreground whitespace-pre-wrap break-words">{entry.text}</span>
              }
            </div>
          )
        })}
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
  const visible = events.filter(e => e.type !== 'CLAUDE_MESSAGE')

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [visible.length])

  return (
    <div className="border bg-card flex flex-col">
      <PanelHeader title="EVENT STREAM" right={`${visible.length} events`} />
      <div ref={scrollRef} className="max-h-40 overflow-y-auto text-xs">
        {visible.length === 0 ? (
          <div className="px-2 py-4 text-muted-foreground text-center">waiting for events...</div>
        ) : (
          visible.map((evt, i) => (
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
    <div className="flex flex-col gap-3 h-[calc(100vh-4rem)] min-h-0">
      {/* header */}
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-sm font-bold">~/mission</h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`${orchColor} ${connected ? 'status-live' : ''}`}>●</span>
          <span className={orchColor}>orch: {orchStatus}</span>
        </div>
      </div>

      {/* fleet + mission side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-3 shrink-0">
        <FleetOverviewPanel />
        <MissionTasksPanel />
      </div>

      {/* event stream */}
      <div className="shrink-0">
        <EventStreamPanel events={events} />
      </div>

      {/* command input grows to fill remaining viewport */}
      <CommandPanel events={events} />
    </div>
  )
}
