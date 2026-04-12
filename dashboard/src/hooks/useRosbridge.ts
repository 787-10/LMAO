import { useEffect, useRef, useState } from 'react'

type Listener = (topic: string, msg: Record<string, unknown>) => void

interface Subscription {
  topic: string
  type?: string
  throttleRate?: number
}

interface Connection {
  ws: WebSocket | null
  listeners: Set<Listener>
  subscriptions: Map<string, Subscription>
  connected: boolean
  refCount: number
  cancelled: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  startTimer: ReturnType<typeof setTimeout> | null
  lastEventAt: number
}

const connections = new Map<string, Connection>()

// action_result listeners keyed by action id
type ActionResultListener = (result: Record<string, unknown>) => void
const actionListeners = new Map<string, ActionResultListener>()

function sendAllSubscriptions(conn: Connection) {
  if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
  for (const sub of conn.subscriptions.values()) {
    conn.ws.send(JSON.stringify({
      op: 'subscribe',
      topic: sub.topic,
      ...(sub.type && { type: sub.type }),
      ...(sub.throttleRate && { throttle_rate: sub.throttleRate }),
    }))
  }
}

function getOrCreateConnection(url: string): Connection {
  let conn = connections.get(url)
  if (conn) {
    conn.refCount++
    return conn
  }

  conn = {
    ws: null,
    listeners: new Set(),
    subscriptions: new Map(),
    connected: false,
    refCount: 1,
    cancelled: false,
    reconnectTimer: null,
    startTimer: null,
    lastEventAt: 0,
  }
  connections.set(url, conn)

  function connect() {
    if (conn!.cancelled) return
    const ws = new WebSocket(url)
    conn!.ws = ws

    ws.onopen = () => {
      if (conn!.cancelled) { ws.close(); return }
      conn!.connected = true
      conn!.lastEventAt = Date.now()
      // clear advertised cache so topics get re-advertised on new connection
      for (const key of advertised) {
        if (key.startsWith(url + '::')) advertised.delete(key)
      }
      console.log('[rosbridge] connected to', url, 'subs:', [...conn!.subscriptions.keys()])
      sendAllSubscriptions(conn!)
    }

    ws.onmessage = (e) => {
      if (conn!.cancelled) return
      conn!.lastEventAt = Date.now()
      try {
        // rws sends ,, and [, for null values in arrays -- fix before parsing
        const raw = typeof e.data === 'string'
          ? e.data.replace(/\[,/g, '[null,').replace(/,(?=[\],])/g, ',null')
          : e.data
        const msg = JSON.parse(raw)
        if (msg.op === 'publish' && msg.topic) {
          for (const fn of conn!.listeners) fn(msg.topic, msg.msg)
        } else if (msg.op === 'action_result') {
          const id = msg.id as string
          const cb = actionListeners.get(id)
          if (cb) { actionListeners.delete(id); cb(msg.values as Record<string, unknown>) }
        } else {
          console.log('[rosbridge] non-publish msg:', msg.op, msg.id ?? '', msg.msg ?? '')
        }
      } catch (err) {
        console.error('[rosbridge] parse error:', err, 'data length:', e.data?.length)
      }
    }

    ws.onerror = () => {
      if (!conn!.cancelled) conn!.connected = false
    }

    ws.onclose = () => {
      if (!conn!.cancelled) {
        conn!.connected = false
        console.log('[rosbridge] disconnected from', url, '-- reconnecting in 3s')
        conn!.reconnectTimer = setTimeout(connect, 3000)
      }
    }
  }

  conn.startTimer = setTimeout(connect, 0)
  return conn
}

function addSubscription(url: string, sub: Subscription) {
  const conn = connections.get(url)
  if (!conn) return
  conn.subscriptions.set(sub.topic, sub)
  if (conn.ws?.readyState === WebSocket.OPEN) {
    console.log('[rosbridge] sending subscribe for', sub.topic, 'ws readyState:', conn.ws.readyState)
    conn.ws.send(JSON.stringify({
      op: 'subscribe',
      topic: sub.topic,
      ...(sub.type && { type: sub.type }),
      ...(sub.throttleRate && { throttle_rate: sub.throttleRate }),
    }))
  } else {
    console.log('[rosbridge] queued subscribe for', sub.topic, 'ws not open yet, readyState:', conn.ws?.readyState)
  }
}

function removeSubscription(url: string, topic: string) {
  const conn = connections.get(url)
  if (!conn) return
  conn.subscriptions.delete(topic)
  // only unsubscribe if no other hook is still using this topic
  // (StrictMode can cause remove+add races)
  setTimeout(() => {
    if (conn.subscriptions.has(topic)) return
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ op: 'unsubscribe', topic }))
    }
  }, 100)
}

const advertised = new Set<string>()

export function publishRosbridge(
  url: string,
  topic: string,
  type: string,
  msg: Record<string, unknown>,
) {
  const conn = connections.get(url)
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return

  const key = `${url}::${topic}`
  if (!advertised.has(key)) {
    conn.ws.send(JSON.stringify({ op: 'advertise', topic, type }))
    advertised.add(key)
  }
  conn.ws.send(JSON.stringify({ op: 'publish', topic, msg }))
}

let _actionMsgId = 0

export function sendActionGoal(
  url: string,
  skillType: string,
  onResult: (ok: boolean, message: string) => void,
  inputs: Record<string, unknown> = {},
): void {
  const conn = connections.get(url)
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) {
    onResult(false, 'not connected')
    return
  }
  const id = `act${_actionMsgId++}`
  actionListeners.set(id, (values) => {
    const ok = values?.success === true || values?.success_type === 'success'
    onResult(ok as boolean, (values?.message as string) ?? '')
  })
  conn.ws.send(JSON.stringify({
    op: 'send_action_goal',
    id,
    action: '/execute_skill',
    action_type: 'brain_messages/action/ExecuteSkill',
    args: { skill_type: skillType, inputs: JSON.stringify(inputs).replace(/:(-?\d+)([,}])/g, ':$1.0$2') },
  }))
}

function releaseConnection(url: string) {
  const conn = connections.get(url)
  if (!conn) return
  conn.refCount--
  if (conn.refCount <= 0) {
    conn.cancelled = true
    if (conn.startTimer) clearTimeout(conn.startTimer)
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.close()
    connections.delete(url)
  }
}

export type RosbridgeStatus = 'connecting' | 'connected' | 'disconnected'

// Treat the socket as disconnected if no inbound message has arrived for this long.
export const WS_IDLE_TIMEOUT_MS = 5000

export function useRosbridgeStatus(url: string | undefined): RosbridgeStatus {
  const [status, setStatus] = useState<RosbridgeStatus>('connecting')

  useEffect(() => {
    if (!url) return
    const conn = getOrCreateConnection(url)
    const interval = setInterval(() => {
      if (conn.cancelled) { setStatus('disconnected'); return }
      if (conn.ws && conn.ws.readyState === WebSocket.CLOSED) { setStatus('disconnected'); return }
      if (!conn.connected) { setStatus('connecting'); return }
      const idle = conn.lastEventAt > 0 && Date.now() - conn.lastEventAt > WS_IDLE_TIMEOUT_MS
      setStatus(idle ? 'disconnected' : 'connected')
    }, 300)
    return () => {
      clearInterval(interval)
      releaseConnection(url)
    }
  }, [url])

  return status
}

export function useRosbridgeTopic<T = Record<string, unknown>>(
  url: string | undefined,
  topic: string,
  type?: string,
  throttleRate?: number,
): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!url || !topic) return

    const conn = getOrCreateConnection(url)

    const listener: Listener = (t, msg) => {
      if (t === topic) setData(msg as T)
    }
    conn.listeners.add(listener)
    addSubscription(url, { topic, type, throttleRate })

    const interval = setInterval(() => {
      setConnected(conn.connected)
    }, 500)

    return () => {
      conn.listeners.delete(listener)
      removeSubscription(url, topic)
      clearInterval(interval)
      releaseConnection(url)
    }
  }, [url, topic, type, throttleRate])

  return { data, connected }
}

export interface ImageStreamState {
  src: string | null
  connected: boolean
  frameCount: number
}

function toDataUrl(data: number[] | string, format: string): string {
  if (typeof data === 'string') {
    return `data:image/${format};base64,${data}`
  }
  const bytes = new Uint8Array(data)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `data:image/${format};base64,${btoa(binary)}`
}

// one-shot grab via shared connection
export function sampleFromShared<T = Record<string, unknown>>(
  url: string,
  topic: string,
  timeoutMs = 15000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = connections.get(url)
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected'))
      return
    }

    const timer = setTimeout(() => {
      conn.listeners.delete(listener)
      removeSubscription(url, topic)
      reject(new Error('timeout'))
    }, timeoutMs)

    const listener: Listener = (t, msg) => {
      if (t !== topic) return
      clearTimeout(timer)
      conn.listeners.delete(listener)
      removeSubscription(url, topic)
      resolve(msg as T)
    }

    conn.listeners.add(listener)
    addSubscription(url, { topic })
  })
}

// one-shot topic fetch via dedicated WS
export function fetchRosbridgeOnce<T = Record<string, unknown>>(
  url: string,
  topic: string,
  type?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    console.log('[fetchOnce] opening ws to', url, 'for', topic)
    const ws = new WebSocket(url)
    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('[fetchOnce] timeout for', topic)
        ws.close()
        reject(new Error('timeout'))
      }
    }, 15000)

    ws.onopen = () => {
      console.log('[fetchOnce] ws open, subscribing to', topic)
      ws.send(JSON.stringify({
        op: 'subscribe',
        topic,
        ...(type && { type }),
      }))
    }

    ws.onmessage = (e) => {
      try {
        const raw = typeof e.data === 'string'
          ? e.data.replace(/\[,/g, '[null,').replace(/,(?=[\],])/g, ',null')
          : e.data
        const msg = JSON.parse(raw)
        console.log('[fetchOnce] msg:', msg.op, msg.topic ?? '', msg.op !== 'publish' ? (msg.msg ?? '') : `(${typeof msg.msg?.data} data)`)
        if (msg.op === 'publish' && msg.topic === topic) {
          resolved = true
          clearTimeout(timeout)
          ws.send(JSON.stringify({ op: 'unsubscribe', topic }))
          ws.close()
          resolve(msg.msg as T)
        }
      } catch { /* ignore */ }
    }

    ws.onerror = () => {
      console.log('[fetchOnce] ws error')
      clearTimeout(timeout)
      if (!resolved) reject(new Error('ws error'))
    }

    ws.onclose = () => {
      console.log('[fetchOnce] ws closed')
      clearTimeout(timeout)
    }
  })
}

// image stream via shared connection
export function useRosbridgeImage(
  url: string | undefined,
  topic: string,
  throttleRate = 100,
  paused = false,
): ImageStreamState {
  const [state, setState] = useState<ImageStreamState>({
    src: null,
    connected: false,
    frameCount: 0,
  })
  const frameRef = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!url || !topic) return

    const conn = getOrCreateConnection(url)

    const listener: Listener = (t, msg) => {
      if (t !== topic || pausedRef.current) return
      const imgMsg = msg as { data?: number[] | string; format?: string }
      if (!imgMsg.data) return
      frameRef.current++
      setState({
        src: toDataUrl(imgMsg.data, imgMsg.format ?? 'jpeg'),
        connected: true,
        frameCount: frameRef.current,
      })
    }
    conn.listeners.add(listener)
    addSubscription(url, { topic, type: 'sensor_msgs/msg/CompressedImage', throttleRate })

    const interval = setInterval(() => {
      setState((s) => ({ ...s, connected: conn.connected }))
    }, 500)

    return () => {
      conn.listeners.delete(listener)
      removeSubscription(url, topic)
      clearInterval(interval)
      releaseConnection(url)
    }
  }, [url, topic, throttleRate])

  return state
}
