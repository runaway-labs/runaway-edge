import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyRunnerIdentity, identitySummary, frameGoal } from './deterministic.ts'

test('classifies comeback, trail, and weekend patterns deterministically', () => {
  assert.equal(classifyRunnerIdentity({ totalRuns: 8, weekendRuns: 2, avgElevation: 40, hasComeback: true }), 'Comeback Runner')
  assert.equal(classifyRunnerIdentity({ totalRuns: 8, weekendRuns: 2, avgElevation: 180, hasComeback: false }), 'Trail Explorer')
  assert.equal(classifyRunnerIdentity({ totalRuns: 8, weekendRuns: 6, avgElevation: 20, hasComeback: false }), 'Weekend Warrior')
})

test('identity copy is bounded deterministic text', () => {
  assert.match(identitySummary('Consistent Builder'), /consisten/i)
  assert.match(frameGoal('Consistent Builder', 'Finish my first marathon'), /Finish my first marathon/)
})
