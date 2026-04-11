import { createRouter } from '@tanstack/react-router'
import { rootRoute } from './routes/__root'
import { indexRoute } from './routes/index'
import { agentRoute } from './routes/agent'
import { missionRoute } from './routes/mission'

const routeTree = rootRoute.addChildren([indexRoute, agentRoute, missionRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
