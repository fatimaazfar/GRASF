// spec: src/adapters/agents-md.js — Render graph context slice into AGENTS.md.
//
// Same graph data as CLAUDE.md but formatted for Codex / OpenAI-style agents.
// renderAgentsMd: pure function → string
// writeAgentsMd:  writes to .grasf/generated/AGENTS.md, copies to repo root (always copy — no symlink assumption for Codex)

import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

export function renderAgentsMd(slice, projectName, layerInfo) {
  const layer = layerInfo?.layer ?? 'structural'
  const ts    = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const lines = []

  lines.push(`# Project Context — ${projectName}`)
  lines.push(`Generated: ${ts} | Layer: ${layer} | Scope: ${slice.scope} | Graph: ${slice.totalNodes} nodes (${slice.activeCount} active)`)
  lines.push('')

  // Current direction
  if (slice.lastSession?.goal) {
    lines.push('## Current task')
    lines.push(slice.lastSession.goal)
    if (slice.lastSession.next_step) lines.push(`Next step: ${slice.lastSession.next_step}`)
    if (slice.lastSession.outcome)   lines.push(`Last outcome: ${slice.lastSession.outcome}`)
    lines.push('')
  }

  // Decisions
  if (slice.decisions.length > 0) {
    lines.push('## Key decisions')
    for (const d of slice.decisions) {
      lines.push(`- **${d.name}**: ${d.summary || '(no summary)'}`)
    }
    lines.push('')
  }

  // Active context
  lines.push('## Active context')
  if (slice.activeNodes.length > 0) {
    for (const n of slice.activeNodes) {
      const loc     = n.file_path ? ` (${n.file_path})` : ''
      const summary = n.summary   ? `: ${n.summary}`    : ''
      lines.push(`- \`${n.name}\`${loc}${summary}`)
    }
  } else {
    lines.push('(no active context — run `graasf init` to scan the codebase)')
  }
  lines.push('')

  // Remnants (omit if none)
  if (slice.remnants.length > 0) {
    lines.push('## Previously explored (not adopted)')
    for (const r of slice.remnants) {
      lines.push(`- ~~${r.name}~~: ${r.summary || '(no detail)'}`)
    }
    lines.push('')
  }

  return lines.slice(0, 150).join('\n')
}

export function writeAgentsMd(content, repoRoot) {
  const genDir  = join(repoRoot, '.grasf', 'generated')
  const genPath = join(genDir, 'AGENTS.md')
  const rootPath = join(repoRoot, 'AGENTS.md')

  mkdirSync(genDir, { recursive: true })
  writeFileSync(genPath, content, 'utf8')
  copyFileSync(genPath, rootPath)
}
