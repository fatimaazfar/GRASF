// spec: src/graph/nodes.js — Node CRUD + deterministic ID generation
// Contract: nodeId(type, name, filePath) → SHA256(type:name:filePath)[:16]
// upsertNode: insert or update (on conflict: summary, access_count, updated_at,
//   last_accessed_at, raw_content if non-null, git_hash — never touches type/scope/status/decay)

import { createHash } from 'node:crypto'

export function nodeId(type, name, filePath = '') {
  return createHash('sha256')
    .update(`${type}:${name}:${filePath}`)
    .digest('hex')
    .slice(0, 16)
}

export function upsertNode(db, node) {
  const id = node.id ?? nodeId(node.type, node.name, node.file_path ?? '')

  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id)

  if (existing) {
    const updates = [
      'summary = ?',
      'access_count = access_count + 1',
      "updated_at = datetime('now')",
      "last_accessed_at = datetime('now')",
    ]
    const params = [node.summary ?? null]

    if (node.raw_content != null) {
      updates.push('raw_content = ?')
      params.push(node.raw_content)
    }
    if (node.git_hash != null) {
      updates.push('git_hash = ?')
      params.push(node.git_hash)
    }

    params.push(id)
    db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  } else {
    db.prepare(`
      INSERT INTO nodes
        (id, type, name, summary, file_path, scope, status, decay_score,
         access_count, extraction_layer, raw_content, git_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      node.type,
      node.name,
      node.summary ?? null,
      node.file_path ?? null,
      node.scope ?? 'root',
      node.status ?? 'active',
      node.decay_score ?? 1.0,
      node.access_count ?? 0,
      node.extraction_layer ?? 'structural',
      node.raw_content ?? null,
      node.git_hash ?? null
    )
  }

  return id
}

export function getNode(db, id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
}

export function searchNodes(db, query) {
  if (!query || !query.trim()) return []
  return db.prepare(`
    SELECT nodes.* FROM nodes
    JOIN nodes_fts ON nodes_fts.rowid = nodes.rowid
    WHERE nodes_fts MATCH ?
    AND nodes.status != 'archived'
    ORDER BY nodes_fts.rank
    LIMIT 20
  `).all(query)
}

// Returns all nodes reachable from startId within the given depth (BFS).
export function getNeighbors(db, startId, depth = 1) {
  const visited = new Set([startId])
  const results = []
  let frontier = [startId]

  for (let d = 0; d < depth; d++) {
    const next = []
    for (const id of frontier) {
      const neighbors = db.prepare(`
        SELECT DISTINCT n.* FROM edges e
        JOIN nodes n ON (n.id = e.to_id OR n.id = e.from_id)
        WHERE (e.from_id = ? OR e.to_id = ?)
        AND n.id != ?
      `).all(id, id, id)

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id)
          results.push(neighbor)
          next.push(neighbor.id)
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return results
}

export function archiveNode(db, id) {
  db.prepare("UPDATE nodes SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(id)
}
