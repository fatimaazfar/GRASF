// spec: src/graph/decay.js — Decay scoring + archival pass
//
// score = (frequency * 0.4) + (recency * 0.4) + (centrality * 0.2)
//   frequency  = Math.log(access_count + 1) / Math.log(11)   — saturates at 10 accesses
//   recency    = 1 / (daysSince(last_accessed_at) + 1)       — exponential decay
//   centrality = getDegree(db, id) / 20                       — normalised graph degree
//
// Floor : decision|goal → min score 0.3  (never decay to remnant)
// Threshold: score < 0.15 → status = 'remnant'
//
// runDecayPass processes only 'active' nodes.
// Returns { scored: number, archived: number }  (archived = newly set to remnant)

function daysSince(dateStr) {
  // SQLite datetime('now') is UTC: "YYYY-MM-DD HH:MM:SS" — convert to ISO before parsing
  const then = new Date(dateStr.replace(' ', 'T') + 'Z')
  return (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24)
}

function getDegree(db, nodeId) {
  return db.prepare(
    'SELECT COUNT(*) as n FROM edges WHERE from_id = ? OR to_id = ?'
  ).get(nodeId, nodeId).n
}

function computeScore(db, node) {
  const frequency  = Math.log(node.access_count + 1) / Math.log(11)
  const recency    = 1 / (daysSince(node.last_accessed_at) + 1)
  const centrality = getDegree(db, node.id) / 20
  let score = (frequency * 0.4) + (recency * 0.4) + (centrality * 0.2)
  if (node.type === 'decision' || node.type === 'goal') {
    score = Math.max(score, 0.3)
  }
  return score
}

export function runDecayPass(db) {
  const nodes = db.prepare("SELECT * FROM nodes WHERE status = 'active'").all()

  const updateScore = db.prepare(
    "UPDATE nodes SET decay_score = ?, updated_at = datetime('now') WHERE id = ?"
  )
  const setRemnant = db.prepare(
    "UPDATE nodes SET status = 'remnant', updated_at = datetime('now') WHERE id = ?"
  )

  let archived = 0

  const pass = db.transaction(() => {
    for (const node of nodes) {
      const score = computeScore(db, node)
      updateScore.run(score, node.id)
      if (score < 0.15) {
        setRemnant.run(node.id)
        archived++
      }
    }
  })

  pass()

  return { scored: nodes.length, archived }
}
