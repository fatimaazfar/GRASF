// spec: src/graph/edges.js — Edge CRUD
// Contract: edgeId deterministic from SHA256(from_id:to_id:rel)[:16]

import { createHash } from 'node:crypto'

export function edgeId(fromId, toId, rel) {
  return createHash('sha256')
    .update(`${fromId}:${toId}:${rel}`)
    .digest('hex')
    .slice(0, 16)
}

export function upsertEdge(db, edge) {
  const id = edge.id ?? edgeId(edge.from_id, edge.to_id, edge.rel)
  db.prepare(`
    INSERT INTO edges (id, from_id, to_id, rel, weight, session_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      weight     = excluded.weight,
      session_id = excluded.session_id
  `).run(
    id,
    edge.from_id,
    edge.to_id,
    edge.rel,
    edge.weight ?? 1.0,
    edge.session_id ?? null
  )
  return id
}

export function getEdges(db, nodeId) {
  return db.prepare('SELECT * FROM edges WHERE from_id = ? OR to_id = ?').all(nodeId, nodeId)
}

export function deleteEdge(db, id) {
  db.prepare('DELETE FROM edges WHERE id = ?').run(id)
}
