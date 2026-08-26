import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const functions = [
  'activity-observations',
  'breakthrough-milestones',
  'classify-races',
  'feedback-workout',
  'goal-assessment',
  'generate-training-plan',
  'regenerate-training-plan',
]

for (const name of functions) {
  test(`${name} has no external LLM provider call`, () => {
    const source = fs.readFileSync(new URL(`./${name}/index.ts`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /api\.anthropic\.com|ANTHROPIC_API_KEY|anthropic-version|claude-|openai|gemini/i)
  })
}
