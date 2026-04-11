/**
 * Hooks for the LMAO orchestrator API (REST + WebSocket).
 *
 * Follows the same singleton-connection pattern as useRosbridge.ts:
 * one WebSocket shared across all consumers, module-level state.
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  HealthReport,
  OrchestratorMission,
  OrchestratorRobot,
  WorldEvent,
} from '@/lib/types'

// ------------------------------------------------------------------
// WebSocket singleton for /ws/events
// ------------------------------------------------------------------

interface OrchestratorWS {
  ws: WebSocket | null
  listeners: Set<(evt: WorldEvent) => void>
  connected: boolean
  cancelled: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

let orchWS: OrchestratorWS | null = null
let orchRefCount = 0

function getOrchestratorWS(): OrchestratorWS {
  if (orchWS) {
    orchRefCount++
    return orchWS
  }

  const state: OrchestratorWS = {
    ws: null,
    listeners: new Set(),
    connected: false,
    cancelled: false,
    reconnectTimer: null,
  }
  orchWS = state
  orchRefCount = 1

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${location.host}/ws/events`

  function connect() {
    if (state.cancelled) return
    const ws = new WebSocket(wsUrl)
    state.ws = ws

    ws.onopen = () => {
      if (state.cancelled) { ws.close(); return }
      state.connected = true
    }

    ws.onmessage = (e) => {
      if (state.cancelled) return
      try {
        const msg = JSON.parse(e.data) as WorldEvent
        for (const fn of state.listeners) fn(msg)
      } catch { /* ignore */ }
    }

    ws.onerror = () => {
      if (!state.cancelled) state.connected = false
    }

    ws.onclose = () => {
      if (!state.cancelled) {
        state.connected = false
        state.reconnectTimer = setTimeout(connect, 3000)
      }
    }
  }

  setTimeout(connect, 0)
  return state
}

function releaseOrchestratorWS() {
  orchRefCount--
  if (orchRefCount <= 0 && orchWS) {
    orchWS.cancelled = true
    if (orchWS.reconnectTimer) clearTimeout(orchWS.reconnectTimer)
    if (orchWS.ws?.readyState === WebSocket.OPEN) orchWS.ws.close()
    orchWS = null
  }
}

// ------------------------------------------------------------------
// useOrchestratorEvents — streams WorldEvents + health snapshots
// ------------------------------------------------------------------

const MAX_EVENTS = 200

export function useOrchestratorEvents() {
  const [events, setEvents] = useState<WorldEvent[]>([])
  const [healthSnapshot, setHealthSnapshot] = useState<HealthReport | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const conn = getOrchestratorWS()

    const listener = (evt: WorldEvent) => {
      if (evt.type === 'HEALTH_SNAPSHOT') {
        setHealthSnapshot(evt.data as unknown as HealthReport)
      } else {
        setEvents((prev) => {
          const next = [...prev, evt]
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
        })
      }
    }
    conn.listeners.add(listener)

    const interval = setInterval(() => {
      setConnected(conn.connected)
    }, 500)

    return () => {
      conn.listeners.delete(listener)
      clearInterval(interval)
      releaseOrchestratorWS()
    }
  }, [])

  return { events, healthSnapshot, connected }
}

// ------------------------------------------------------------------
// useSendCommand — POST /api/command
// ------------------------------------------------------------------

export function useSendCommand() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(async (text: string): Promise<string> => {
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return data.response as string
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return `Error: ${msg}`
    } finally {
      setPending(false)
    }
  }, [])

  return { send, pending, error }
}

// ------------------------------------------------------------------
// useFleet — polls GET /api/fleet every 3s
// ------------------------------------------------------------------

export function useFleet() {
  const [robots, setRobots] = useState<OrchestratorRobot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/fleet')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) {
          setRobots(data.robots ?? [])
          setLoading(false)
        }
      } catch { /* ignore */ }
    }

    poll()
    const interval = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return { robots, loading }
}

// ------------------------------------------------------------------
// useMissions — polls GET /api/missions every 5s
// ------------------------------------------------------------------

export function useMissions() {
  const [missions, setMissions] = useState<OrchestratorMission[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/missions')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) {
          setMissions(data.missions ?? [])
          setLoading(false)
        }
      } catch { /* ignore */ }
    }

    poll()
    const interval = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return { missions, loading }
}
