import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyBrief } from './deterministic.ts'

const metrics = {
  acwr: 1.42,
  weeklyVolumeMi: 31.2,
  totalVolumeMi: 102.8,
  cumulativeMi84d: 301.4,
  peakWeeklyMi: 42.1,
  trainingTrend: 'ramping_up',
}

test('caution brief cites load and volume', () => {
  const brief = buildDailyBrief({ firstName: 'Jack', metrics, acwrState: 'caution' })
  assert.equal(brief.tone, 'cautionary')
  assert.match(brief.brief, /Jack/)
  assert.match(brief.brief, /1\.42/)
  assert.match(brief.insight, /31\.2/)
})

test('taper brief treats declining load as intentional', () => {
  const brief = buildDailyBrief({
    firstName: 'Jack',
    metrics: { ...metrics, acwr: 0.82, trainingTrend: 'tapering' },
    acwrState: 'maintenance',
    raceName: 'Lakefront Marathon',
    daysOut: 8,
    taperPhase: 'Taper - Trust Phase',
  })
  assert.equal(brief.tone, 'positive')
  assert.equal(brief.taper_mode_active, true)
  assert.match(brief.brief, /301\.4/)
  assert.match(brief.today_action, /easy|rest/i)
})
