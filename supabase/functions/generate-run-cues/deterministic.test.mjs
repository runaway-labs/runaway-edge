import assert from 'node:assert/strict'
import test from 'node:test'
import { generateRunCues } from './deterministic.ts'

test('returns at least five personalized cues without a model', () => {
  const cues = generateRunCues({
    runnerIdentity: 'Consistent Builder',
    whyIRun: 'To do hard things',
    coreValues: ['Courage'],
    earnedMilestoneKeys: ['first_run'],
  })
  assert.ok(cues.length >= 5)
  assert.ok(cues.some((cue) => cue.includes('To do hard things')))
  assert.ok(cues.every((cue) => typeof cue === 'string' && cue.length > 8))
})
