interface BriefMetrics {
  acwr: number
  weeklyVolumeMi: number
  totalVolumeMi: number
  cumulativeMi84d: number
  peakWeeklyMi: number
  trainingTrend: string
}

interface BriefInput {
  firstName: string
  metrics: BriefMetrics
  acwrState: string
  raceName?: string
  daysOut?: number
  taperPhase?: string
}

export interface DeterministicDailyBrief {
  brief: string
  today_action: string
  insight: string
  tone: 'positive' | 'cautionary' | 'neutral'
  taper_mode_active?: boolean
  taper_phase?: string
}

export function buildDailyBrief(input: BriefInput): DeterministicDailyBrief {
  const { firstName, metrics } = input
  const tapering = Boolean(input.taperPhase)

  if (tapering) {
    return {
      brief: `${firstName}, ${metrics.cumulativeMi84d.toFixed(1)} miles over 12 weeks and a ${metrics.peakWeeklyMi.toFixed(1)}-mile peak week are the evidence. ${input.raceName ?? 'Race day'} is ${input.daysOut ?? 0} days away; lower load now is the plan working.`,
      today_action: 'Keep it easy or rest; protect the fitness already built.',
      insight: `${metrics.weeklyVolumeMi.toFixed(1)} miles this week reflects an intentional taper, not lost fitness.`,
      tone: 'positive',
      taper_mode_active: true,
      taper_phase: input.taperPhase,
    }
  }

  const cautionary = input.acwrState === 'caution' || input.acwrState === 'danger'
  const underloading = input.acwrState === 'underloading'
  const tone: DeterministicDailyBrief['tone'] = cautionary ? 'cautionary' : underloading ? 'neutral' : 'positive'
  const stateText = cautionary
    ? 'Your recent load is running ahead of your established base.'
    : underloading
      ? 'Your recent load is below the capacity built over the last month.'
      : 'Your recent load and established base are reasonably aligned.'
  const action = cautionary
    ? 'Choose easy running or rest today; avoid adding intensity.'
    : underloading
      ? 'Add a controlled easy session if recovery signals are normal.'
      : 'Follow today’s planned session without adding extra volume.'

  return {
    brief: `${firstName}, your ACWR is ${metrics.acwr.toFixed(2)} after ${metrics.weeklyVolumeMi.toFixed(1)} miles this week. ${stateText}`,
    today_action: action,
    insight: `${metrics.weeklyVolumeMi.toFixed(1)} miles this week; 28-day volume is ${metrics.totalVolumeMi.toFixed(1)} miles.`,
    tone,
  }
}
