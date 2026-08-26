export interface RunCueInput {
  runnerIdentity: string
  whyIRun: string
  coreValues: string[]
  earnedMilestoneKeys: string[]
}

export function generateRunCues(input: RunCueInput): string[] {
  const value = input.coreValues[0] ?? 'patience'
  const cues = [
    `Settle in. You are here because ${input.whyIRun}.`,
    `Let ${value.toLowerCase()} guide the effort, not the clock.`,
    'Run this part with control; there is no need to prove it all at once.',
    'Your next steady step is enough right now.',
    'Stay relaxed through the shoulders and honest with the effort.',
    `You are practicing the habits of a ${input.runnerIdentity.toLowerCase()}.`,
    'Keep the effort sustainable and leave room to finish well.',
    'Close with intention, not tension.',
  ]
  if (input.earnedMilestoneKeys.length > 0) {
    cues.splice(4, 0, 'You have already built evidence that you can keep showing up.')
  }
  return cues
}
