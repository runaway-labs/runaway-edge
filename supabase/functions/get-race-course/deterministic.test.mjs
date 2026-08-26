import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTacticalInsights, findGpxUrlInHtml } from './deterministic.ts'

test('extracts an absolute or relative GPX link from HTML', () => {
  assert.equal(findGpxUrlInHtml('<a href="https://race.test/course.gpx">GPX</a>', 'https://race.test'), 'https://race.test/course.gpx')
  assert.equal(findGpxUrlInHtml('<a href="/files/route.gpx?download=1">Map</a>', 'https://race.test/event'), 'https://race.test/files/route.gpx?download=1')
})

test('derives bounded tactical insights from significant grades', () => {
  const insights = deriveTacticalInsights([
    { distance: 0, elevation: 10, grade: 0 },
    { distance: 1.2, elevation: 60, grade: 5.4 },
    { distance: 2.5, elevation: 20, grade: -4.8 },
  ])
  assert.equal(insights.length, 2)
  assert.match(insights[0].description, /climb/i)
  assert.match(insights[1].description, /downhill/i)
})
