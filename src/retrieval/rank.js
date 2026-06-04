// spec: src/retrieval/rank.js — Ranked, scoped, token-budgeted context slice.
//
// Ranking order (always):
//   1. Last 3 sessions (always included, budget-exempt)
//   2. Last session goal + outcome + next_step (derived from sessions[0])
//   3. All active 'decision' nodes for scope
//   4. All active 'goal' nodes for scope
//   5. Top active nodes by decay_score (scope-filtered, budget-limited)
//   6. Top 3 remnant nodes (scope-filtered)
//
// Token budget: chars / 4. Applies only to item 5 (active nodes).
// Never throws — always returns something valid.

function scopeWhere(scope) {
  // Serve nodes matching current scope OR root scope.
  return scope === 'root'
    ? "scope = 'root'"
    : "(scope = ? OR scope = 'root')"
}

function scopeParams(scope) {
  return scope === 'root' ? [] : [scope]
}

function parseSessions(rows) {
  return rows.map(s => ({
    id: s.id,
    ended_at: s.ended_at,
    goal: s.goal,
    outcome: s.outcome,
    next_step: s.next_step,
    scope: s.scope,
    changedFiles: (() => {
      try { return s.changed_files ? JSON.parse(s.changed_files) : [] } catch { return [] }
    })()
  }))
}

export function buildContextSlice(db, { scope = 'root', tokenBudget = 2000 } = {}) {
  try {
    // Total counts (for header)
    const totalNodes  = db.prepare('SELECT COUNT(*) as n FROM nodes').get().n
    const activeCount = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status = 'active'").get().n

    // 1. Last 3 sessions (always included)
    const totalSessionCount = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n
    const sessionRows = db.prepare(
      'SELECT * FROM sessions ORDER BY ended_at DESC LIMIT 3'
    ).all()
    const sessions = parseSessions(sessionRows).map((s, i) => ({
      ...s,
      sessionNumber: totalSessionCount - i
    }))

    // 2. Last session details (derived from sessions[0])
    const lastSession = sessions[0] ?? null

    // 3. Active decision nodes
    const sw = scopeWhere(scope)
    const sp = scopeParams(scope)
    const decisions = db.prepare(
      `SELECT * FROM nodes WHERE type = 'decision' AND status = 'active' AND ${sw} ORDER BY decay_score DESC`
    ).all(...sp)

    // 4. Active goal nodes
    const goals = db.prepare(
      `SELECT * FROM nodes WHERE type = 'goal' AND status = 'active' AND ${sw} ORDER BY decay_score DESC`
    ).all(...sp)

    // 5. Top active nodes by decay_score (budget-limited, skip decision/goal — already included)
    const candidates = db.prepare(
      `SELECT * FROM nodes
       WHERE status = 'active'
         AND type NOT IN ('decision', 'goal')
         AND ${sw}
       ORDER BY decay_score DESC
       LIMIT 100`
    ).all(...sp)

    const maxChars = tokenBudget * 4
    let charCount = 0
    const activeNodes = []
    for (const node of candidates) {
      const cost = (node.name?.length ?? 0) + (node.summary?.length ?? 0) + (node.file_path?.length ?? 0)
      if (charCount + cost > maxChars) break
      activeNodes.push(node)
      charCount += cost
    }

    // 6. Top 3 remnants
    const remnants = db.prepare(
      `SELECT * FROM nodes WHERE status = 'remnant' AND ${sw} ORDER BY decay_score DESC LIMIT 3`
    ).all(...sp)

    return { sessions, lastSession, decisions, goals, activeNodes, remnants, scope, totalNodes, activeCount, totalSessionCount }
  } catch {
    // Never throw — always return something valid (spec error rule 6)
    return { sessions: [], lastSession: null, decisions: [], goals: [], activeNodes: [], remnants: [], scope, totalNodes: 0, activeCount: 0, totalSessionCount: 0 }
  }
}
