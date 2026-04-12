export type AgentStatus = 'online' | 'idle' | 'offline'

export type EventLevel = 'info' | 'warn' | 'error' | 'debug'

export interface AgentEvent {
  id: string
  type: string
  level: EventLevel
  msg: string
  ts: string
}

export interface Point {
  x: number
  y: number
}

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  feedUrl: string
  rosbridgeUrl?: string
  events: AgentEvent[]
  track: Point[]
  heatmap: number[][]
}

function generateHeatmap(hotspots: Point[], intensity: number): number[][] {
  const grid: number[][] = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => 0),
  )
  for (const hs of hotspots) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dist = Math.sqrt((x - hs.x) ** 2 + (y - hs.y) ** 2)
        grid[y][x] += Math.max(0, intensity - dist * 0.8)
      }
    }
  }
  const max = Math.max(...grid.flat())
  if (max > 0) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) grid[y][x] /= max
  }
  return grid
}

export const AGENTS: Agent[] = [
  {
    id: 'arm-01',
    name: 'ARM-01',
    status: 'online',
    feedUrl: '/feeds/arm-01.mjpeg',
    track: [
      { x: 10, y: 80 }, { x: 15, y: 70 }, { x: 25, y: 65 },
      { x: 35, y: 55 }, { x: 40, y: 45 }, { x: 50, y: 40 },
      { x: 55, y: 35 }, { x: 60, y: 30 }, { x: 65, y: 35 },
      { x: 70, y: 40 }, { x: 75, y: 50 }, { x: 80, y: 55 },
      { x: 85, y: 50 }, { x: 90, y: 45 },
    ],
    heatmap: generateHeatmap(
      [{ x: 4, y: 4 }, { x: 10, y: 8 }, { x: 7, y: 12 }, { x: 12, y: 3 }],
      5,
    ),
    events: [
      { id: 'e1', type: 'system', level: 'info', msg: 'agent started', ts: '2026-04-11T12:00:01Z' },
      { id: 'e2', type: 'camera', level: 'info', msg: 'feed connected on /dev/video0', ts: '2026-04-11T12:00:02Z' },
      { id: 'e3', type: 'motor', level: 'debug', msg: 'calibration sequence initiated', ts: '2026-04-11T12:00:05Z' },
      { id: 'e4', type: 'motor', level: 'info', msg: 'calibration complete, 6-axis ready', ts: '2026-04-11T12:00:12Z' },
      { id: 'e5', type: 'system', level: 'warn', msg: 'cpu temp 72C, threshold 80C', ts: '2026-04-11T12:15:33Z' },
      { id: 'e6', type: 'camera', level: 'error', msg: 'frame drop detected, buffer underrun', ts: '2026-04-11T12:20:01Z' },
      { id: 'e7', type: 'system', level: 'info', msg: 'heartbeat ok, uptime 1200s', ts: '2026-04-11T12:20:05Z' },
    ],
  },
  {
    id: 'nav-02',
    name: 'NAV-02',
    status: 'idle',
    feedUrl: '/feeds/nav-02.mjpeg',
    track: [
      { x: 5, y: 50 }, { x: 15, y: 45 }, { x: 25, y: 40 },
      { x: 35, y: 38 }, { x: 45, y: 35 }, { x: 55, y: 30 },
      { x: 60, y: 25 }, { x: 65, y: 20 }, { x: 70, y: 25 },
      { x: 72, y: 30 }, { x: 74, y: 35 }, { x: 73, y: 40 },
      { x: 70, y: 45 }, { x: 75, y: 50 }, { x: 80, y: 55 },
      { x: 85, y: 60 }, { x: 90, y: 65 }, { x: 92, y: 70 },
    ],
    heatmap: generateHeatmap(
      [{ x: 3, y: 6 }, { x: 8, y: 3 }, { x: 13, y: 10 }, { x: 6, y: 13 }],
      4,
    ),
    events: [
      { id: 'e1', type: 'system', level: 'info', msg: 'agent started', ts: '2026-04-11T11:45:00Z' },
      { id: 'e2', type: 'camera', level: 'info', msg: 'feed connected on /dev/video1', ts: '2026-04-11T11:45:01Z' },
      { id: 'e3', type: 'nav', level: 'info', msg: 'lidar initialized, 360 scan active', ts: '2026-04-11T11:45:05Z' },
      { id: 'e4', type: 'nav', level: 'warn', msg: 'obstacle map stale, last update 30s ago', ts: '2026-04-11T12:10:15Z' },
      { id: 'e5', type: 'system', level: 'info', msg: 'entering idle mode, no task queued', ts: '2026-04-11T12:12:00Z' },
    ],
  },
  {
    id: 'sort-03',
    name: 'SORT-03',
    status: 'offline',
    feedUrl: '/feeds/sort-03.mjpeg',
    track: [
      { x: 50, y: 50 }, { x: 52, y: 48 }, { x: 51, y: 46 },
      { x: 50, y: 47 }, { x: 49, y: 49 }, { x: 50, y: 50 },
    ],
    heatmap: generateHeatmap([{ x: 8, y: 8 }], 3),
    events: [
      { id: 'e1', type: 'system', level: 'info', msg: 'agent started', ts: '2026-04-11T10:00:00Z' },
      { id: 'e2', type: 'camera', level: 'error', msg: 'feed timeout, device not found', ts: '2026-04-11T10:00:03Z' },
      { id: 'e3', type: 'vision', level: 'error', msg: 'classification model failed to load', ts: '2026-04-11T10:00:05Z' },
      { id: 'e4', type: 'system', level: 'error', msg: 'shutting down, too many failures', ts: '2026-04-11T10:00:10Z' },
    ],
  },
  {
    id: 'agent-18',
    name: 'AGENT-18',
    status: 'online',
    feedUrl: '/feeds/agent-18.mjpeg',
    rosbridgeUrl: 'ws://172.17.30.66:9090',
    track: [
      { x: 20, y: 30 }, { x: 25, y: 35 }, { x: 30, y: 40 },
      { x: 35, y: 38 }, { x: 40, y: 35 }, { x: 45, y: 30 },
      { x: 50, y: 28 }, { x: 55, y: 32 }, { x: 60, y: 38 },
      { x: 65, y: 45 }, { x: 70, y: 50 }, { x: 75, y: 55 },
    ],
    heatmap: generateHeatmap(
      [{ x: 5, y: 5 }, { x: 11, y: 11 }, { x: 3, y: 12 }, { x: 14, y: 4 }],
      4.5,
    ),
    events: [
      { id: 'e1', type: 'system', level: 'info', msg: 'agent started', ts: '2026-04-11T08:00:00Z' },
      { id: 'e2', type: 'camera', level: 'info', msg: 'rosbridge connected ws://172.17.30.66:9090', ts: '2026-04-11T08:00:01Z' },
      { id: 'e3', type: 'camera', level: 'info', msg: 'subscribed to /mars/main_camera/left/image_raw/compressed', ts: '2026-04-11T08:00:02Z' },
      { id: 'e4', type: 'nav', level: 'info', msg: 'gps lock acquired, 12 satellites', ts: '2026-04-11T08:00:10Z' },
      { id: 'e5', type: 'system', level: 'debug', msg: 'telemetry stream active, 1hz', ts: '2026-04-11T08:00:15Z' },
      { id: 'e6', type: 'nav', level: 'info', msg: 'waypoint 1/8 reached', ts: '2026-04-11T09:30:00Z' },
    ],
  },
]
