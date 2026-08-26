export const RUNNER_IDENTITIES = [
  'Morning Runner',
  'Trail Explorer',
  'Consistent Builder',
  'Weekend Warrior',
  'Comeback Runner',
] as const

export type RunnerIdentity = typeof RUNNER_IDENTITIES[number]

export interface IdentityStats {
  totalRuns: number
  weekendRuns: number
  avgElevation: number
  hasComeback: boolean
  morningRuns?: number
}

export function classifyRunnerIdentity(stats: IdentityStats): RunnerIdentity {
  if (stats.hasComeback) return 'Comeback Runner'
  if (stats.totalRuns > 0 && (stats.morningRuns ?? 0) / stats.totalRuns >= 0.6) return 'Morning Runner'
  if (stats.avgElevation >= 100) return 'Trail Explorer'
  if (stats.totalRuns > 0 && stats.weekendRuns / stats.totalRuns >= 0.6) return 'Weekend Warrior'
  return 'Consistent Builder'
}

const SUMMARIES: Record<RunnerIdentity, string> = {
  'Morning Runner': 'You create momentum by showing up early and starting with intention.',
  'Trail Explorer': 'You build strength and curiosity by seeking varied terrain.',
  'Consistent Builder': 'You show up consistently and keep building your running practice.',
  'Weekend Warrior': 'You protect time for running and make your weekends count.',
  'Comeback Runner': 'You returned to running and are rebuilding with purpose.',
}

export function identitySummary(identity: RunnerIdentity): string {
  return SUMMARIES[identity]
}

export function frameGoal(identity: RunnerIdentity, goalTitle: string): string {
  return `As a ${identity}, ${goalTitle} is another way to practice who you are becoming.`
}
