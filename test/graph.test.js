import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/graph/db.js'
import { upsertNode, getNode, searchNodes, getNeighbors, archiveNode, nodeId } from '../src/graph/nodes.js'
import { upsertEdge } from '../src/graph/edges.js'

function makeDb() {
  return openDb(':memory:')
}

test('upsertNode creates node with correct deterministic ID', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'doSomething', file_path: 'src/foo.js', summary: 'does something' })
  const expected = nodeId('function', 'doSomething', 'src/foo.js')
  assert.equal(id, expected)
  const node = getNode(db, id)
  assert.ok(node)
  assert.equal(node.type, 'function')
  assert.equal(node.name, 'doSomething')
  assert.equal(node.summary, 'does something')
})

test('upsertNode on duplicate ID updates summary, increments access_count', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'doSomething', file_path: 'src/foo.js', summary: 'original' })

  const first = getNode(db, id)
  assert.equal(first.summary, 'original')
  assert.equal(first.access_count, 0)

  upsertNode(db, { type: 'function', name: 'doSomething', file_path: 'src/foo.js', summary: 'updated' })
  const second = getNode(db, id)
  assert.equal(second.summary, 'updated')
  assert.equal(second.access_count, 1)

  // structural fields must not change
  assert.equal(second.type, 'function')
  assert.equal(second.file_path, 'src/foo.js')
  assert.equal(second.scope, 'root')
  assert.equal(second.status, 'active')
})

test('upsertNode on conflict updates raw_content and git_hash only when non-null', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'fn', file_path: 'a.js', raw_content: 'v1', git_hash: 'abc' })

  upsertNode(db, { type: 'function', name: 'fn', file_path: 'a.js', raw_content: 'v2', git_hash: 'def' })
  const updated = getNode(db, id)
  assert.equal(updated.raw_content, 'v2')
  assert.equal(updated.git_hash, 'def')

  // null values must not overwrite existing
  upsertNode(db, { type: 'function', name: 'fn', file_path: 'a.js', raw_content: null, git_hash: null })
  const unchanged = getNode(db, id)
  assert.equal(unchanged.raw_content, 'v2')
  assert.equal(unchanged.git_hash, 'def')
})

test('searchNodes returns FTS matches', () => {
  const db = makeDb()
  upsertNode(db, { type: 'function', name: 'authenticateUser', file_path: 'src/auth.js', summary: 'validates JWT token' })
  upsertNode(db, { type: 'function', name: 'createOrder', file_path: 'src/orders.js', summary: 'creates a new order' })

  const results = searchNodes(db, 'JWT')
  assert.equal(results.length, 1)
  assert.equal(results[0].name, 'authenticateUser')
})

test('searchNodes excludes archived nodes', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'oldFn', file_path: 'x.js', summary: 'obsolete logic here' })
  archiveNode(db, id)

  const results = searchNodes(db, 'obsolete')
  assert.equal(results.length, 0)
})

test('getNeighbors returns connected nodes at depth 1 and 2', () => {
  const db = makeDb()
  const a = upsertNode(db, { type: 'module', name: 'A', file_path: 'a.js' })
  const b = upsertNode(db, { type: 'module', name: 'B', file_path: 'b.js' })
  const c = upsertNode(db, { type: 'module', name: 'C', file_path: 'c.js' })
  upsertEdge(db, { from_id: a, to_id: b, rel: 'depends_on' })
  upsertEdge(db, { from_id: b, to_id: c, rel: 'depends_on' })

  const depth1 = getNeighbors(db, a, 1)
  assert.equal(depth1.length, 1)
  assert.equal(depth1[0].name, 'B')

  const depth2 = getNeighbors(db, a, 2)
  assert.equal(depth2.length, 2)
  const names = depth2.map(n => n.name).sort()
  assert.deepEqual(names, ['B', 'C'])
})

test('getNeighbors returns empty array for isolated node', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'module', name: 'Isolated', file_path: 'iso.js' })
  const result = getNeighbors(db, id, 2)
  assert.deepEqual(result, [])
})

test('archiveNode sets status to archived', () => {
  const db = makeDb()
  const id = upsertNode(db, { type: 'function', name: 'obsolete', file_path: 'old.js' })
  archiveNode(db, id)
  const node = getNode(db, id)
  assert.equal(node.status, 'archived')
})

test('Node IDs are deterministic: same inputs always produce same ID', () => {
  const id1 = nodeId('function', 'myFunc', 'src/utils.js')
  const id2 = nodeId('function', 'myFunc', 'src/utils.js')
  assert.equal(id1, id2)

  // different file_path → different ID
  const id3 = nodeId('function', 'myFunc', 'src/other.js')
  assert.notEqual(id1, id3)

  // different type → different ID
  const id4 = nodeId('class', 'myFunc', 'src/utils.js')
  assert.notEqual(id1, id4)

  // ID is exactly 16 hex characters
  assert.match(id1, /^[0-9a-f]{16}$/)
})
