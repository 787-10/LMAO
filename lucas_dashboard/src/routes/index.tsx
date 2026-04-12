import { useState } from 'react'
import { createRoute, Link } from '@tanstack/react-router'
import { rootRoute } from './__root'
import { AGENTS, type Agent, type AgentStatus } from '@/lib/agents'

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexPage,
})

function statusColor(status: AgentStatus): string {
  if (status === 'online') return 'text-term-green'
  if (status === 'idle') return 'text-term-yellow'
  return 'text-term-red'
}

function CameraFeed({ agent }: { agent: Agent }) {
  return (
    <div className="bg-secondary border aspect-video flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-muted-foreground text-xs flex flex-col items-center gap-1">
          <span className="text-lg">⣿</span>
          <span>NO SIGNAL</span>
          <span className="text-[10px]">{agent.feedUrl}</span>
        </div>
      </div>
      <div className="absolute top-1 left-2 text-[10px] text-term-red">● REC</div>
      <div className="absolute top-1 right-2 text-[10px] text-muted-foreground">
        {agent.id}
      </div>
      <div className="absolute bottom-1 left-2 text-[10px] text-muted-foreground">
        cam-0
      </div>
    </div>
  )
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      to="/$agentId"
      params={{ agentId: agent.id }}
      className="block border bg-card text-card-foreground no-underline hover:border-primary transition-colors"
    >
      <CameraFeed agent={agent} />
      <div className="p-3 border-t">
        <div className="flex items-center justify-between mb-1">
          <span className="font-bold text-xs">{agent.name}</span>
          <span className={`text-xs flex items-center gap-1 ${statusColor(agent.status)}`}>
            {agent.status === 'online' && <span className="status-live">●</span>}
            [{agent.status}]
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground">id: {agent.id}</div>
      </div>
    </Link>
  )
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <Link
      to="/$agentId"
      params={{ agentId: agent.id }}
      className="flex items-center border bg-card text-card-foreground no-underline hover:border-primary transition-colors"
    >
      <div className="w-32 h-20 shrink-0 border-r">
        <div className="bg-secondary h-full flex items-center justify-center">
          <span className="text-muted-foreground text-[10px]">NO SIGNAL</span>
        </div>
      </div>
      <div className="flex-1 px-3 py-2 flex items-center justify-between">
        <div>
          <div className="font-bold text-xs">{agent.name}</div>
          <div className="text-[10px] text-muted-foreground">
            id: {agent.id}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs flex items-center gap-1 ${statusColor(agent.status)}`}>
            {agent.status === 'online' && <span className="status-live">●</span>}
            [{agent.status}]
          </span>
          <span className="text-muted-foreground text-xs">&gt;</span>
        </div>
      </div>
    </Link>
  )
}

function IndexPage() {
  const [view, setView] = useState<'grid' | 'list'>('grid')

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-sm font-bold">~/agents</h1>
        <div className="flex border text-xs">
          <button
            onClick={() => setView('grid')}
            className={`px-2 py-0.5 ${view === 'grid' ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground hover:bg-accent'}`}
          >
            grid
          </button>
          <button
            onClick={() => setView('list')}
            className={`px-2 py-0.5 border-l ${view === 'list' ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground hover:bg-accent'}`}
          >
            list
          </button>
        </div>
      </div>

      {view === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {AGENTS.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {AGENTS.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  )
}
