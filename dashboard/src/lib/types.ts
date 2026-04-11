/** Orchestrator data model — matches Python dataclasses in orchestrator/world_model/ */

export type HealthTier =
  | 'FULL_CAPABILITY'
  | 'DEGRADED_SENSORS'
  | 'LOCAL_ONLY'
  | 'SAFE_MODE'
  | 'HIBERNATION'

export type OrchestratorTaskStatus =
  | 'IDLE'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'

export interface OrchestratorRobot {
  name: string
  connected: boolean
  health_tier: HealthTier
  position: [number, number, number] | null
  velocity: [number, number] | null
  battery_voltage: number | null
  battery_percentage: number | null
  current_task_id: string | null
  task_status: OrchestratorTaskStatus
  capabilities: string[]
}

export interface OrchestratorTask {
  id: string
  description: string
  task_type: 'navigate' | 'manipulate' | 'scan' | 'wait'
  assigned_robot: string | null
  status: OrchestratorTaskStatus
  target: Record<string, unknown>
  created_at: number
}

export interface OrchestratorMission {
  id: string
  description: string
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'REPLANNING'
  tasks: OrchestratorTask[]
  created_at: number
}

export type WorldEventType =
  | 'ROBOT_DEGRADED'
  | 'ROBOT_RECOVERED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'COMMS_LOST'
  | 'COMMS_RESTORED'
  | 'HEALTH_SNAPSHOT'

export interface WorldEvent {
  type: WorldEventType
  robot: string
  data: Record<string, unknown>
  timestamp: number
}

export interface HealthReport {
  [robotName: string]: {
    tier: HealthTier
    topic_rates_hz: Record<string, number>
  }
}
