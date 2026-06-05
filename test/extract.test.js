import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectLayer } from '../src/extract/mode.js'
import { parseTranscript, extractTextContent } from '../src/extract/transcript.js'
import { parseAnnotations } from '../src/extract/annotations.js'
import { buildExtractionPrompt } from '../src/extract/llm.js'

// ─── detectLayer ────────────────────────────────────────────────────────────

test('detectLayer returns structural when no API key and no Ollama', async () => {
  const saved = process.env.ANTHROPIC_API_KEY
  const savedLayer = process.env.GRASF_LAYER
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GRASF_LAYER
  try {
    const result = await detectLayer()
    // Ollama not running in test env → checkOllama fails fast (connection refused) → structural
    assert.equal(result.layer, 'structural')
    assert.equal(result.model, null)
    assert.equal(result.ollamaUrl, null)
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    if (savedLayer !== undefined) process.env.GRASF_LAYER = savedLayer
  }
})

test('detectLayer returns api when ANTHROPIC_API_KEY is set', async () => {
  const saved = process.env.ANTHROPIC_API_KEY
  const savedLayer = process.env.GRASF_LAYER
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  delete process.env.GRASF_LAYER
  try {
    const result = await detectLayer()
    assert.equal(result.layer, 'api')
    assert.equal(result.model, 'claude-haiku-4-5-20251001')
    assert.equal(result.ollamaUrl, null)
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    else delete process.env.ANTHROPIC_API_KEY
    if (savedLayer !== undefined) process.env.GRASF_LAYER = savedLayer
  }
})

test('detectLayer env override GRASF_LAYER=structural is respected even with API key set', async () => {
  const savedKey   = process.env.ANTHROPIC_API_KEY
  const savedLayer = process.env.GRASF_LAYER
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.GRASF_LAYER = 'structural'
  try {
    const result = await detectLayer()
    assert.equal(result.layer, 'structural')
    assert.equal(result.model, null)
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
    else delete process.env.ANTHROPIC_API_KEY
    if (savedLayer !== undefined) process.env.GRASF_LAYER = savedLayer
    else delete process.env.GRASF_LAYER
  }
})

test('detectLayer env override GRASF_LAYER=api is respected', async () => {
  const savedLayer = process.env.GRASF_LAYER
  const savedKey   = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  process.env.GRASF_LAYER = 'api'
  try {
    const result = await detectLayer()
    assert.equal(result.layer, 'api')
    assert.equal(result.model, 'claude-haiku-4-5-20251001')
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
    if (savedLayer !== undefined) process.env.GRASF_LAYER = savedLayer
    else delete process.env.GRASF_LAYER
  }
})

// ─── parseTranscript ────────────────────────────────────────────────────────

test('parseTranscript correctly parses a sample JSONL', () => {
  const dir = join(tmpdir(), `grasf-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'abc123.jsonl')

  const lines = [
    JSON.stringify({ role: 'user', content: 'Hello, help me refactor auth', timestamp: '2026-01-01T10:00:00Z' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Sure, let me look at the auth module.' }], timestamp: '2026-01-01T10:00:01Z' }),
    // nested message format (older Claude Code)
    JSON.stringify({ message: { role: 'user', content: 'graasf:decision Use JWT' }, timestamp: '2026-01-01T10:00:02Z' }),
    '', // empty line — should be skipped
    'not-json', // malformed — should be skipped
  ].join('\n')

  writeFileSync(filePath, lines, 'utf8')

  try {
    const { messages, sessionId } = parseTranscript(filePath)
    assert.equal(sessionId, 'abc123')
    assert.equal(messages.length, 3)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content, 'Hello, help me refactor auth')
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[2].role, 'user') // nested format resolved
    assert.equal(messages[2].content, 'graasf:decision Use JWT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── extractTextContent ──────────────────────────────────────────────────────

test('extractTextContent handles string content', () => {
  const msg = { role: 'user', content: 'plain string content' }
  assert.equal(extractTextContent(msg), 'plain string content')
})

test('extractTextContent handles array content blocks', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here is my answer.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} }, // non-text block — ignored
      { type: 'text', text: 'Second paragraph.' }
    ]
  }
  const result = extractTextContent(msg)
  assert.equal(result, 'Here is my answer.\nSecond paragraph.')
})

test('extractTextContent returns empty string for unexpected content', () => {
  assert.equal(extractTextContent({ role: 'user', content: null }), '')
  assert.equal(extractTextContent({ role: 'user', content: 42 }), '')
})

// ─── Annotation parser ───────────────────────────────────────────────────────

test('parseAnnotations extracts all four annotation types from a prompt', () => {
  const prompt = [
    'I want to make some notes.',
    'graasf:goal Build stateless auth using JWT tokens',
    'graasf:decision Use RS256 signing — required for gateway verification',
    'graasf:note Token TTL should be 15 minutes per security policy',
    'graasf:dead-end Redis session store — adds infra dependency, abandoned',
  ].join('\n')

  const results = parseAnnotations(prompt)
  assert.equal(results.length, 4)

  const goal = results.find(r => r.type === 'goal')
  assert.ok(goal)
  assert.ok(goal.text.includes('stateless auth'))

  const decision = results.find(r => r.type === 'decision')
  assert.ok(decision)
  assert.ok(decision.text.includes('RS256'))

  const note = results.find(r => r.type === 'note')
  assert.ok(note)
  assert.ok(note.text.includes('15 minutes'))

  const deadEnd = results.find(r => r.type === 'dead_end')
  assert.ok(deadEnd)
  assert.ok(deadEnd.text.includes('Redis'))
})

test('parseAnnotations returns empty array for prompt with no annotations', () => {
  assert.deepEqual(parseAnnotations('Just a normal prompt with no special markers.'), [])
  assert.deepEqual(parseAnnotations(''), [])
  assert.deepEqual(parseAnnotations(null), [])
})

test('parseAnnotations handles single annotation with no trailing text', () => {
  const results = parseAnnotations('graasf:decision Use PostgreSQL')
  assert.equal(results.length, 1)
  assert.equal(results[0].type, 'decision')
  assert.equal(results[0].text, 'Use PostgreSQL')
})

// ─── Identical extraction prompt ─────────────────────────────────────────────

test('buildExtractionPrompt produces consistent output for both API and Local paths', () => {
  const transcript = [
    { role: 'user', content: 'Refactor the auth module' },
    { role: 'assistant', content: 'I will start with the middleware.' }
  ]
  const existingSummaries = 'authMiddleware: validates JWT tokens'

  // Both extractViaAnthropic and extractViaOllama call buildExtractionPrompt with
  // the same arguments — testing the shared function confirms both paths use the same prompt.
  const prompt = buildExtractionPrompt(transcript, existingSummaries)

  // Must contain all required JSON keys
  assert.ok(prompt.includes('"entities"'))
  assert.ok(prompt.includes('"decisions"'))
  assert.ok(prompt.includes('"dead_ends"'))
  assert.ok(prompt.includes('"goal"'))
  assert.ok(prompt.includes('"outcome"'))
  assert.ok(prompt.includes('"next_step"'))
  assert.ok(prompt.includes('"relationships"'))

  // Must embed existing context
  assert.ok(prompt.includes('authMiddleware'))

  // Must embed transcript content
  assert.ok(prompt.includes('Refactor the auth module'))

  // Calling it twice with the same inputs must produce identical output
  const prompt2 = buildExtractionPrompt(transcript, existingSummaries)
  assert.equal(prompt, prompt2)
})

test('buildExtractionPrompt truncates transcript to ~8000 tokens', () => {
  const longContent = 'x'.repeat(40000) // > 32000 char limit
  const transcript = [{ role: 'user', content: longContent }]
  const prompt = buildExtractionPrompt(transcript, '')
  // The transcript section should be truncated; total prompt well under 40000 + overhead
  assert.ok(prompt.length < 40000)
})
