import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/graph/db.js'
import { upsertNode } from '../src/graph/nodes.js'
import { upsertEdge } from '../src/graph/edges.js'
import { runDecayPass } from '../src/graph/decay.js'

function makeDb() {
  return openDb(':memory:')
}

// Sets last_accessed_at to N days ago using SQLite date arithmetic
function setAccessedDaysAgo(db, id, days) {
  db.prepare(
    "UPDATE nodes SET last_accessed_at = datetime('now', ?) WHERE id = ?"
  ).run(`-${days} days`, id)
}

function getScore(db, id) {
  return db.prepare('SELECT decay_score FROM nodes WHERE id = ?').get(id).decay_score
}

function getStatus(db, id) {
  return db.prepare('SELECT status FROM nodes WHERE id = ?').get(id).status
}

// score ≈ (log(2)/log(11))*0.4 + 1.0*0.4 + 0 ≈ 0.52
test('Node accessed recently, count=1 → score well above remnant threshold', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'recentFn', file_path: 'a.js' })
  db.prepare('UPDATE nodes SET access_count = 1 WHERE id = ?').run(id)
  // last_accessed_at is set to now by upsertNode — 0 days ago

  runDecayPass(db)

  const score = getScore(db, id)
  assert.ok(score > 0.4, `Expected score > 0.4, got ${score}`)
  assert.equal(getStatus(db, id), 'active')
})

// score ≈ (log(2)/log(11))*0.4 + (1/31)*0.4 + 0 ≈ 0.129
test('Node not accessed in 30 days, count=1 → score below 0.15', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'staleFn', file_path: 'b.js' })
  db.prepare('UPDATE nodes SET access_count = 1 WHERE id = ?').run(id)
  setAccessedDaysAgo(db, id, 30)

  runDecayPass(db)

  const score = getScore(db, id)
  assert.ok(score < 0.15, `Expected score < 0.15, got ${score}`)
})

// raw score ≈ 0.013, floor raises it to 0.3
test('decision type node never scores below 0.3 (floor enforced)', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'decision', name: 'chooseJWT', file_path: '' })
  setAccessedDaysAgo(db, id, 30)

  runDecayPass(db)

  const score = getScore(db, id)
  assert.ok(score >= 0.3, `Expected score >= 0.3 (floor), got ${score}`)
})

test('goal type node never scores below 0.3 (floor enforced)', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'goal', name: 'refactorAuth', file_path: '' })
  setAccessedDaysAgo(db, id, 30)

  runDecayPass(db)

  const score = getScore(db, id)
  assert.ok(score >= 0.3, `Expected score >= 0.3 (floor), got ${score}`)
})

test('runDecayPass sets status=remnant for nodes below threshold', () => {
  const db = makeDb()
  // access_count=0, 30 days ago → score ≈ 0.013 < 0.15
  const id = upsertNode(db, { type: 'function', name: 'ghostFn', file_path: 'c.js' })
  setAccessedDaysAgo(db, id, 30)

  const { scored, archived } = runDecayPass(db)

  assert.ok(scored >= 1)
  assert.ok(archived >= 1)
  assert.equal(getStatus(db, id), 'remnant')
})

test('runDecayPass never archives decision or goal nodes', () => {
  const db = makeDb()
  const decId  = upsertNode(db, { type: 'decision', name: 'oldDecision', file_path: '' })
  const goalId = upsertNode(db, { type: 'goal',     name: 'oldGoal',     file_path: '' })
  // 90 days, no edges, no accesses → raw score ≈ 0.004 (would be remnant without floor)
  setAccessedDaysAgo(db, decId,  90)
  setAccessedDaysAgo(db, goalId, 90)

  runDecayPass(db)

  assert.equal(getStatus(db, decId),  'active', 'decision must remain active')
  assert.equal(getStatus(db, goalId), 'active', 'goal must remain active')
})

test('runDecayPass updates decay_score in the database', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'fn', file_path: 'd.js' })

  const before = db.prepare('SELECT decay_score FROM nodes WHERE id = ?').get(id).decay_score
  assert.equal(before, 1.0)

  runDecayPass(db)

  const after = getScore(db, id)
  assert.ok(after >= 0 && after <= 1, `Score out of range: ${after}`)
  assert.notEqual(after, 1.0, 'decay_score must be recomputed from formula, not left at default')
})

test('centrality boosts score for highly connected nodes', () => {
  const db = makeDb()
  // Create a hub node with 10 edges, not accessed in 30 days
  const hubId = upsertNode(db, { type: 'function', name: 'hub', file_path: 'hub.js' })
  setAccessedDaysAgo(db, hubId, 30)

  for (let i = 0; i < 10; i++) {
    const leafId = upsertNode(db, { type: 'module', name: `leaf${i}`, file_path: `l${i}.js` })
    upsertEdge(db, { from_id: hubId, to_id: leafId, rel: 'depends_on' })
  }

  // Isolated node for comparison — same age, no edges
  const isoId = upsertNode(db, { type: 'function', name: 'isolated', file_path: 'iso.js' })
  setAccessedDaysAgo(db, isoId, 30)

  runDecayPass(db)

  const hubScore = getScore(db, hubId)
  const isoScore = getScore(db, isoId)
  assert.ok(hubScore > isoScore, `Hub (${hubScore}) should outscore isolated node (${isoScore})`)
})
