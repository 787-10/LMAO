import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { AGENTS } from '@/lib/agents'

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
  return <span className={color}>●</span>
}

function RootLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-4 py-2 flex items-center justify-between">
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
        <nav className="w-48 border-r p-2 flex flex-col gap-1">
          <div className="text-xs text-muted-foreground px-2 py-1 border-b mb-1">
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
          <div className="mt-auto border-t pt-2 px-2 text-xs text-muted-foreground">
            <div>sys: nominal</div>
            <div>uptime: 14d 7h</div>
          </div>
        </nav>

        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
