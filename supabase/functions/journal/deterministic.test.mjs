import assert from 'node:assert/strict'
import test from 'node:test'
import { buildJournalNarrative } from './deterministic.ts'

test('journal narrative cites actual weekly totals', () => {
  const narrative = buildJournalNarrative({
    activitiesCount: 4,
    totalDistanceKm: 32.4,
    totalMinutes: 188,
    totalElevationM: 420,
    longestDistanceKm: 14.2,
  })
  assert.match(narrative, /4 activities/)
  assert.match(narrative, /32\.4 km/)
  assert.match(narrative, /14\.2 km/)
  assert.doesNotMatch(narrative, /AI|Claude|Anthropic/i)
})
