export type StormMode = 'parallel' | 'sequential'

export type StormStage =
  | 'perspectives'
  | 'research'
  | 'outline'
  | 'writing'
  | 'polish'
  | 'done'
  | 'failed'
  | 'cancelled'

export type StormTaskKind = 'perspectives' | 'research' | 'outline' | 'section' | 'polish'

export type StormTaskStatus = 'queued' | 'starting' | 'running' | 'done' | 'failed'

export type StormTask = {
  id: string
  kind: StormTaskKind
  label: string
  status: StormTaskStatus
  /** Absolute path the subagent's answer is written to. */
  outputPath: string
  /** Index among tasks of its kind (perspective or section number). */
  index: number
  /** Perspective (research) or section heading + outline slice (section). */
  brief: string
  agentId?: string
  error?: string
}

export type StormRun = {
  id: string
  topic: string
  dir: string
  researchMode: StormMode
  writingMode: StormMode
  maxParallel: number
  perspectives: number
  turns: number
  model: string
  stage: StormStage
  tasks: StormTask[]
  startedAt: number
  finishedAt?: number
  articlePath?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    storm: { run: Shaped<StormRun | null> }
  }
}
