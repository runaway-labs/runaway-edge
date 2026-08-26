import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('comprehensive analysis has no external LLM provider path', () => {
  assert.doesNotMatch(source, /anthropic|claude|api\.anthropic\.com|ANTHROPIC_API_KEY/i)
})

test('recommendations always use deterministic athlete metrics', () => {
  assert.match(source, /priorityRecommendations = generateFallbackRecommendations\(trainingLoad\)/)
  assert.doesNotMatch(source, /generateAIAnalysis/)
})
