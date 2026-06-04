// spec: src/adapters/claude-md.js — Render graph context slice into CLAUDE.md.
//
// renderClaudeMd: pure function → string (≤ 150 lines)
// writeClaudeMd:  writes to .grasf/generated/CLAUDE.md, symlinks from repo root (copy on Windows)

import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, copyFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

// If repoRoot is known, display paths relative to it; otherwise show as-is.
function displayPath(filePath, repoRoot) {
  if (!filePath || !repoRoot) return filePath || ''
  try {
    return isAbsolute(filePath)
      ? relative(repoRoot, filePath).replace(/\\/g, '/')
      : filePath
  } catch {
    return filePath
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown time'
  const then = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z')
  const diffMins = Math.floor((Date.now() - then.getTime()) / 60000)
  if (diffMins < 2)    return 'just now'
  if (diffMins < 60)   return `${diffMins} minutes ago`
  const hrs = Math.floor(diffMins / 60)
  if (hrs < 24)        return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  if (days === 1)      return 'yesterday'
  if (days < 7)        return `${days} days ago`
  const weeks = Math.floor(days / 7)
  return `${weeks} week${weeks !== 1 ? 's' : ''} ago`
}

function formatFileList(files, max = 5) {
  if (!files?.length) return ''
  const shown = files.slice(0, max)
  const rest  = files.length - shown.length
  const list  = shown.map(f => f.split('/').pop() || f).join(', ')
  return rest > 0 ? `${list} (+${rest} more)` : list
}

// Pure render function — no file I/O.
// repoRoot (optional): when provided, file paths in Active context are shown relative to it.
export function renderClaudeMd(slice, projectName, layerInfo, repoRoot = null) {
  const layer = layerInfo?.layer ?? 'structural'
  const model = layerInfo?.model ?? null
  const ts    = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const lines = []

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`# GRASF Context — ${projectName}`)
  lines.push(`Generated: ${ts} | Layer: ${layer}${model ? ` (${model})` : ''} | Scope: ${slice.scope} | Graph: ${slice.totalNodes} nodes (${slice.activeCount} active)`)
  if (layer === 'structural') {
    lines.push('Note: Semantic extraction inactive. Type `grasf:decision <text>` in any prompt to record decisions.')
  }
  lines.push('')

  // ── Recent session activity (always included, budget-exempt) ─────────────────
  lines.push('## Recent session activity')
  if (slice.sessions.length === 0) {
    lines.push('(no sessions recorded yet — run a Claude Code session to populate this)')
  } else {
    // Display newest first (sessions are already DESC-sorted)
    for (const s of slice.sessions) {
      const when  = timeAgo(s.ended_at)
      const files = formatFileList(s.changedFiles)
      lines.push(`- Session ${s.sessionNumber} (${when})${files ? ': edited ' + files : ''}`)
    }
  }
  lines.push('')

  // ── Current direction ────────────────────────────────────────────────────────
  lines.push('## Current direction')
  if (slice.lastSession?.goal) {
    lines.push(slice.lastSession.goal)
    if (slice.lastSession.next_step) lines.push(`Next: ${slice.lastSession.next_step}`)
  } else if (layer === 'structural') {
    lines.push('(not recorded — type `grasf:goal <text>` in your next prompt)')
  }
  lines.push('')

  // ── Key decisions ────────────────────────────────────────────────────────────
  lines.push('## Key decisions')
  if (slice.decisions.length > 0) {
    for (const d of slice.decisions) {
      lines.push(`- **${d.name}**: ${d.summary || '(no summary)'}`)
    }
  } else if (layer === 'structural') {
    // Layer 0 empty state: reference files from last session
    const lastFiles = slice.sessions[0]?.changedFiles ?? []
    if (lastFiles.length > 0) {
      const fileList = lastFiles.slice(0, 3).map(f => f.split('/').pop() || f).join(' and ')
      lines.push(`(none recorded — last session touched ${fileList}.`)
      lines.push(' Type `grasf:decision <text>` to record why.)')
    } else {
      lines.push('(none recorded — type `grasf:decision <text>` in any prompt to record decisions)')
    }
  } else {
    lines.push('(none recorded this session)')
  }
  lines.push('')

  // ── Active context ───────────────────────────────────────────────────────────
  lines.push('## Active context')
  if (slice.activeNodes.length > 0) {
    for (const n of slice.activeNodes) {
      const dispPath   = displayPath(n.file_path, repoRoot)
      const dispName   = displayPath(n.name, repoRoot)
      // When name IS the file path (module node), skip redundant parenthetical
      const nameIsPath = n.file_path && n.name === n.file_path
      const loc        = nameIsPath ? '' : (dispPath ? ` (${dispPath})` : '')
      const summary    = n.summary  ? `: ${n.summary}` : ''
      lines.push(`- \`${dispName}\`${loc}${summary}`)
    }
  } else {
    lines.push('(graph empty — run `grasf init` to scan the codebase)')
  }
  lines.push('')

  // ── Remnant traces (omit section entirely if none) ───────────────────────────
  if (slice.remnants.length > 0) {
    lines.push('## Remnant traces (explored, not adopted)')
    for (const r of slice.remnants) {
      const reason = r.summary?.includes('abandoned because:')
        ? r.summary
        : r.summary ? `${r.summary}` : '(no detail)'
      lines.push(`- ~~${r.name}~~: ${reason}`)
    }
    lines.push('')
  }

  // Cap at 150 lines
  const capped = lines.slice(0, 150)
  return capped.join('\n')
}

// Writes CLAUDE.md to .grasf/generated/ and links from repo root.
export function writeClaudeMd(content, repoRoot) {
  const genDir  = join(repoRoot, '.grasf', 'generated')
  const genPath = join(genDir, 'CLAUDE.md')
  const rootPath = join(repoRoot, 'CLAUDE.md')

  mkdirSync(genDir, { recursive: true })
  writeFileSync(genPath, content, 'utf8')

  // Remove existing CLAUDE.md or symlink at repo root
  try { unlinkSync(rootPath) } catch { /* didn't exist */ }

  if (process.platform === 'win32') {
    copyFileSync(genPath, rootPath)
  } else {
    // Relative symlink so the repo stays portable
    symlinkSync(join('.grasf', 'generated', 'CLAUDE.md'), rootPath)
  }
}
