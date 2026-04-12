import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { AGENTS } from '@/lib/agents'
import { useOrchestratorEvents } from '@/hooks/useOrchestrator'
import type { HealthTier } from '@/lib/types'

export const rootRoute = createRootRoute({
  component: RootLayout,
})

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'online'
      ? 'text-term-green'
      : status === 'idle'
        ? 'text-term-yellow'
        : 'text-term-red'
  const live = status === 'online' || status === 'idle'
  return <span className={`${color} ${live ? 'status-live' : ''}`}>●</span>
}

function tierShortColor(tier: HealthTier): string {
  switch (tier) {
    case 'FULL_CAPABILITY': return 'text-term-green'
    case 'DEGRADED_SENSORS': return 'text-term-yellow'
    case 'LOCAL_ONLY': return 'text-term-cyan'
    case 'SAFE_MODE': return 'text-term-red'
    case 'HIBERNATION': return 'text-muted-foreground'
  }
}

function tierShort(tier: HealthTier): string {
  return tier.split('_')[0].toLowerCase()
}

function RootLayout() {
  const { healthSnapshot, connected: orchConnected } = useOrchestratorEvents()

  return (
    <div className="min-h-screen flex flex-col">
      <header className="tui-topbar px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-primary no-underline font-bold">
            [LMAO]
          </Link>
          <span className="text-muted-foreground text-xs">
            agent dashboard v0.1
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>agents: {AGENTS.length}</span>
          <span>
            online: {AGENTS.filter((a) => a.status === 'online').length}
          </span>
        </div>
      </header>

      <div className="flex flex-1">
        <nav className="w-48 tui-sidebar p-2 flex flex-col gap-1">
          {/* orchestrator section */}
          <div className="text-xs text-muted-foreground px-2 py-1 border-b mb-1 tui-hatch-dense">
            ORCHESTRATOR
          </div>
          <Link
            to="/mission"
            className="flex items-center gap-2 px-2 py-1 text-xs no-underline text-foreground hover:bg-accent"
            activeProps={{ className: 'bg-accent text-accent-foreground' }}
          >
            <span className="text-term-cyan">&gt;</span>
            <span>mission</span>
            <span className={`ml-auto ${orchConnected ? 'text-term-green status-live' : 'text-term-red'}`}>●</span>
          </Link>

          {/* agents section */}
          <div className="text-xs text-muted-foreground px-2 py-1 border-b mb-1 mt-2 tui-hatch-dense">
            AGENTS
          </div>
          {AGENTS.map((agent) => (
            <Link
              key={agent.id}
              to="/$agentId"
              params={{ agentId: agent.id }}
              className="flex items-center gap-2 px-2 py-1 text-xs no-underline text-foreground hover:bg-accent"
              activeProps={{ className: 'bg-accent text-accent-foreground' }}
            >
              <StatusDot status={agent.status} />
              <span>{agent.name}</span>
              <span className="ml-auto text-muted-foreground">
                {agent.status}
              </span>
            </Link>
          ))}

          {/* fleet health widget */}
          <div className="mt-auto border-t pt-2 px-2 text-xs text-muted-foreground space-y-0.5 tui-hatch-subtle">
            <div>
              orch:{' '}
              <span className={orchConnected ? 'text-term-green' : 'text-term-red'}>
                {orchConnected ? 'online' : 'offline'}
              </span>
            </div>
            {healthSnapshot && Object.entries(healthSnapshot).map(([name, info]) => (
              <div key={name}>
                {name}:{' '}
                <span className={tierShortColor(info.tier)}>
                  {tierShort(info.tier)}
                </span>
              </div>
            ))}
            {!healthSnapshot && <div>fleet: --</div>}
          </div>
        </nav>

        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
