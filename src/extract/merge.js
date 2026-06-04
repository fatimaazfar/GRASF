// spec: src/extract/merge.js — Merge LLM extraction results into the graph.
//
// Called by stop.js after extractSemantic() succeeds.
// Handles: entities, decisions, dead_ends, relationships.
// goal/outcome/next_step are written to the sessions table by stop.js, not here.
//
// repoRoot (optional): when provided, any absolute entity file_path that falls inside
// repoRoot is stripped to a relative path before storage. LLMs sometimes return absolute
// paths when they infer file locations from context — normalising here keeps the graph
// consistent with the relative paths written by the structural extractor.

import { isAbsolute, relative } from 'node:path'
import { upsertNode, nodeId } from '../graph/nodes.js'
import { upsertEdge } from '../graph/edges.js'

// Strip repoRoot prefix from an absolute path; normalise to forward slashes.
// Returns the path unchanged if it is already relative, null, or outside repoRoot.
function normalizeFilePath(filePath, repoRoot) {
  if (!filePath || !repoRoot || !isAbsolute(filePath)) return filePath || null
  try {
    const rel = relative(repoRoot, filePath)
    // relative() returns a path starting with '..' when filePath is outside repoRoot
    if (rel.startsWith('..')) return filePath
    return rel.replace(/\\/g, '/')
  } catch {
    return filePath
  }
}

// result: { entities, decisions, dead_ends, relationships, ... }
// repoRoot: optional absolute path to the project root — used to normalise file_path fields
// Returns { nodes: number, edges: number } counts of upserted items.
export function mergeExtraction(db, result, scope = 'root', sessionId = null, repoRoot = null) {
  if (!result) return { nodes: 0, edges: 0 }

  let nodes = 0
  let edges = 0

  for (const entity of result.entities || []) {
    if (!entity.name) continue
    upsertNode(db, {
      type: entity.type || 'module',
      name: entity.name,
      summary: entity.summary || null,
      file_path: normalizeFilePath(entity.file_path, repoRoot),
      scope,
      extraction_layer: 'api'  // merge is only called for api/local layers
    })
    nodes++
  }

  for (const decision of result.decisions || []) {
    if (!decision.name) continue
    upsertNode(db, {
      type: 'decision',
      name: decision.name,
      summary: decision.summary
        ? `${decision.summary}${decision.rationale ? ` — ${decision.rationale}` : ''}`
        : (decision.rationale || null),
      scope,
      extraction_layer: 'api'
    })
    nodes++
  }

  for (const deadEnd of result.dead_ends || []) {
    if (!deadEnd.name) continue
    // spec: dead_end nodes are "remnant from the start" — they appear in ## Remnant traces immediately
    upsertNode(db, {
      type: 'dead_end',
      name: deadEnd.name,
      summary: deadEnd.summary
        ? `${deadEnd.summary}${deadEnd.reason_abandoned ? ` — abandoned because: ${deadEnd.reason_abandoned}` : ''}`
        : (deadEnd.reason_abandoned || null),
      status: 'remnant',
      scope,
      extraction_layer: 'api'
    })
    nodes++
  }

  for (const rel of result.relationships || []) {
    if (!rel.from || !rel.to || !rel.rel) continue
    // Look up node IDs by name (first match — names may collide across files)
    const fromRow = db.prepare('SELECT id FROM nodes WHERE name = ? LIMIT 1').get(rel.from)
    const toRow   = db.prepare('SELECT id FROM nodes WHERE name = ? LIMIT 1').get(rel.to)
    if (!fromRow || !toRow) continue
    upsertEdge(db, { from_id: fromRow.id, to_id: toRow.id, rel: rel.rel, session_id: sessionId })
    edges++
  }

  return { nodes, edges }
}
