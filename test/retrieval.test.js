import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/graph/db.js'
import { upsertNode } from '../src/graph/nodes.js'
import { buildContextSlice } from '../src/retrieval/rank.js'
import { renderClaudeMd } from '../src/adapters/claude-md.js'

function makeDb() {
  return openDb(':memory:')
}

function insertSession(db, { id, ended_at, goal = null, outcome = null, next_step = null, scope = 'root', changed_files = '[]' }) {
  db.prepare(`
    INSERT INTO sessions (id, started_at, ended_at, goal, outcome, next_step, scope, changed_files, extraction_layer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'structural')
  `).run(id, ended_at, ended_at, goal, outcome, next_step, scope, changed_files)
}

// ─── buildContextSlice ───────────────────────────────────────────────────────

test('buildContextSlice always includes session history (last 3 sessions)', () => {
  const db = makeDb()
  for (let i = 1; i <= 5; i++) {
    insertSession(db, { id: `s${i}`, ended_at: `2026-01-0${i}T10:00:00Z` })
  }

  const slice = buildContextSlice(db, { scope: 'root' })
  assert.equal(slice.sessions.length, 3)
  // Should be the 3 most recent sessions (s5, s4, s3)
  assert.equal(slice.sessions[0].id, 's5')
  assert.equal(slice.sessions[2].id, 's3')
})

test('buildContextSlice always includes decision nodes', () => {
  const db = makeDb()
  upsertNode(db, { type: 'decision', name: 'Use JWT', summary: 'Chosen for stateless scaling', scope: 'root' })
  upsertNode(db, { type: 'function', name: 'doWork',  summary: 'does work', scope: 'root' })

  const slice = buildContextSlice(db, { scope: 'root' })
  assert.equal(slice.decisions.length, 1)
  assert.equal(slice.decisions[0].name, 'Use JWT')
})

test('buildContextSlice respects token budget; session history is exempt from cut', () => {
  const db = makeDb()
  insertSession(db, { id: 's1', ended_at: '2026-01-01T10:00:00Z', changed_files: '["src/auth.js"]' })

  // Add 20 nodes with long summaries (~120 chars each ≈ 30 tokens each)
  for (let i = 0; i < 20; i++) {
    upsertNode(db, {
      type: 'function',
      name: `longFn${i}`,
      summary: 'A very detailed description of this function that takes up considerable token budget space',
      scope: 'root'
    })
  }

  // Tiny budget — only fits ~1–2 nodes
  const slice = buildContextSlice(db, { scope: 'root', tokenBudget: 50 })

  // Session history always present
  assert.equal(slice.sessions.length, 1)
  // Budget cuts active nodes
  assert.ok(slice.activeNodes.length < 20, `Expected fewer than 20 active nodes, got ${slice.activeNodes.length}`)
})

test('buildContextSlice filters by scope correctly', () => {
  const db = makeDb()
  upsertNode(db, { type: 'function', name: 'apiHandler',  scope: 'apps/api',  summary: 'API handler' })
  upsertNode(db, { type: 'function', name: 'webHandler',  scope: 'apps/web',  summary: 'Web handler' })
  upsertNode(db, { type: 'function', name: 'sharedUtil',  scope: 'root',      summary: 'Shared utility' })

  const slice = buildContextSlice(db, { scope: 'apps/api' })
  const names = slice.activeNodes.map(n => n.name)

  assert.ok(names.includes('apiHandler'),  'should include apps/api node')
  assert.ok(names.includes('sharedUtil'),  'should include root scope node')
  assert.ok(!names.includes('webHandler'), 'should exclude apps/web node')
})

test('buildContextSlice includes remnant nodes in remnants array', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'redisStore', summary: 'Redis session store — abandoned because: adds infra dependency', scope: 'root' })
  db.prepare("UPDATE nodes SET status = 'remnant', decay_score = 0.05 WHERE id = ?").run(id)

  const slice = buildContextSlice(db, { scope: 'root' })
  assert.equal(slice.remnants.length, 1)
  assert.equal(slice.remnants[0].name, 'redisStore')
  // Remnant nodes must NOT appear in activeNodes
  const activeNames = slice.activeNodes.map(n => n.name)
  assert.ok(!activeNames.includes('redisStore'))
})

test('buildContextSlice never throws on empty database', () => {
  const db = makeDb()
  assert.doesNotThrow(() => buildContextSlice(db, { scope: 'root' }))
  const slice = buildContextSlice(db, { scope: 'root' })
  assert.equal(slice.sessions.length, 0)
  assert.equal(slice.decisions.length, 0)
  assert.equal(slice.activeNodes.length, 0)
})

// ─── renderClaudeMd ───────────────────────────────────────────────────────────

function baseSlice(overrides = {}) {
  return {
    sessions: [],
    lastSession: null,
    decisions: [],
    goals: [],
    activeNodes: [],
    remnants: [],
    scope: 'root',
    totalNodes: 0,
    activeCount: 0,
    totalSessionCount: 0,
    ...overrides
  }
}

test('Generated CLAUDE.md is under 150 lines', () => {
  const db = makeDb()
  // Populate with many nodes
  for (let i = 0; i < 200; i++) {
    upsertNode(db, { type: 'function', name: `fn${i}`, summary: `Function ${i}`, scope: 'root' })
  }
  const slice = buildContextSlice(db, { scope: 'root', tokenBudget: 2000 })
  const content = renderClaudeMd(slice, 'test-project', { layer: 'structural' })
  const lineCount = content.split('\n').length
  assert.ok(lineCount <= 150, `Expected ≤ 150 lines, got ${lineCount}`)
})

test('Generated CLAUDE.md shows active extraction layer in header', () => {
  const content = renderClaudeMd(baseSlice(), 'my-project', { layer: 'api', model: 'claude-haiku-4-5-20251001' })
  assert.ok(content.includes('Layer: api'), 'Header must show extraction layer')
  assert.ok(content.includes('claude-haiku'), 'Header must show model name')
})

test('Generated CLAUDE.md Layer 0 shows structural note in header', () => {
  const content = renderClaudeMd(baseSlice(), 'my-project', { layer: 'structural' })
  assert.ok(content.includes('Semantic extraction inactive'), 'Must prompt to add API key')
})

test('Generated CLAUDE.md Layer 0 with no sessions shows placeholder', () => {
  const slice = baseSlice({ sessions: [] })
  const content = renderClaudeMd(slice, 'my-project', { layer: 'structural' })
  assert.ok(content.includes('no sessions recorded yet'), 'Must show no-sessions placeholder')
})

test('Generated CLAUDE.md Layer 0 empty-state annotation prompt includes files from last session', () => {
  const slice = baseSlice({
    sessions: [{
      id: 's1',
      sessionNumber: 1,
      ended_at: '2026-01-01T10:00:00Z',
      changedFiles: ['src/middleware/auth.js', 'src/services/token.js'],
      goal: null, outcome: null, next_step: null
    }],
    lastSession: { goal: null, outcome: null, next_step: null },
    decisions: []  // no decisions → triggers empty state
  })

  const content = renderClaudeMd(slice, 'my-project', { layer: 'structural' })
  // The decisions empty-state must mention the touched files
  assert.ok(content.includes('auth.js') || content.includes('token.js'),
    'Empty-state must reference files from last session')
  assert.ok(content.includes('graasf:decision'), 'Empty-state must prompt to record a decision')
})

test('Generated CLAUDE.md omits Remnant traces section entirely when no remnants', () => {
  const content = renderClaudeMd(baseSlice({ remnants: [] }), 'my-project', { layer: 'structural' })
  assert.ok(!content.includes('Remnant traces'), 'Remnant section must be omitted when empty')
})

test('Generated CLAUDE.md includes remnant traces when they exist', () => {
  const slice = baseSlice({
    remnants: [{ id: 'r1', name: 'redisStore', summary: 'Redis sessions — abandoned because: adds infra dependency', status: 'remnant' }]
  })
  const content = renderClaudeMd(slice, 'my-project', { layer: 'structural' })
  assert.ok(content.includes('Remnant traces'), 'Remnant section must appear')
  assert.ok(content.includes('~~redisStore~~'), 'Remnant name must use strikethrough')
})
