// spec: src/retrieval/query.js — FTS5 search + graph traversal
//
// searchByText: raw FTS5 match, used by prompt-submit.js and rank.js
// buildPromptContext: compact context string for real-time prompt injection (< 500 tokens)

// Strip FTS5 special characters; use OR semantics so any matching word is enough.
// camelCase names are stored as single tokens by unicode61, so OR gives better recall.
function sanitizeFtsQuery(text) {
  const words = text
    .replace(/['"()*^:\-]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2)
    .slice(0, 10)
  return words.length > 0 ? words.join(' OR ') : ''
}

// Returns active nodes matching queryText via FTS5, ordered by relevance.
// When scope is provided, returns nodes for that scope + root scope.
export function searchByText(db, queryText, { scope = null, limit = 20 } = {}) {
  if (!queryText?.trim()) return []
  const ftsQuery = sanitizeFtsQuery(queryText)
  if (!ftsQuery) return []

  if (scope) {
    return db.prepare(`
      SELECT n.* FROM nodes n
      JOIN nodes_fts ON nodes_fts.rowid = n.rowid
      WHERE nodes_fts MATCH ?
        AND n.status = 'active'
        AND (n.scope = ? OR n.scope = 'root')
      ORDER BY nodes_fts.rank
      LIMIT ?
    `).all(ftsQuery, scope, limit)
  }

  return db.prepare(`
    SELECT n.* FROM nodes n
    JOIN nodes_fts ON nodes_fts.rowid = n.rowid
    WHERE nodes_fts MATCH ?
      AND n.status = 'active'
    ORDER BY nodes_fts.rank
    LIMIT ?
  `).all(ftsQuery, limit)
}

// Builds a compact context string for real-time prompt injection.
// Used by prompt-submit.js — must stay under tokenBudget * 4 characters.
export function buildPromptContext(db, promptText, scope = 'root', tokenBudget = 500) {
  const nodes = searchByText(db, promptText, { scope, limit: 10 })
  if (nodes.length === 0) return null

  const maxChars = tokenBudget * 4
  const lines = []
  let chars = 0

  for (const node of nodes) {
    const summary = node.summary || ''
    const loc = node.file_path ? ` (${node.file_path})` : ''
    const line = `- \`${node.name}\`${loc}${summary ? ': ' + summary : ''}`
    if (chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length + 1 // +1 for newline
  }

  return lines.length > 0 ? `Relevant context:\n${lines.join('\n')}` : null
}
