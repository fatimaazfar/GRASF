// spec: src/init/scanner.js — Full Tree-sitter AST scan of the repo for initial graph population.
//
// Walks the directory tree, respects skip_dirs / skip_extensions from config,
// then delegates to extractStructural() for AST parsing and node creation.
// Returns { filesScanned, nodesCreated }.
//
// This is the FULL scan run once by `graasf init`.
// The per-session incremental rescan is handled by structural.js directly (called by stop.js).

import { readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { extractStructural } from '../extract/structural.js'

const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'vendor', '.grasf']
const DEFAULT_SKIP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.pdf', '.lock',
                                    '.min.js', '.woff', '.woff2', '.ttf', '.eot', '.ico',
                                    '.zip', '.gz', '.tar', '.bin', '.exe'])

function walkDir(dir, skipDirs, skipExts, files = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files // permission error — skip
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skipDirs.includes(entry.name)) {
        walkDir(join(dir, entry.name), skipDirs, skipExts, files)
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (!skipExts.has(ext)) {
        files.push(join(dir, entry.name))
      }
    }
  }
  return files
}

// db        — open Database instance
// repoRoot  — absolute path to the repo root
// config    — parsed .grasf/config.json (or default config object)
// scope     — scope string for created nodes (default 'root')
// gitHash   — current HEAD hash for node tagging (or null)
export async function scanRepo(db, repoRoot, config = {}, scope = 'root', gitHash = null) {
  const skipDirs = config.skip_dirs ?? DEFAULT_SKIP_DIRS
  const skipExts = new Set(config.skip_extensions ?? [...DEFAULT_SKIP_EXTS])

  const countBefore = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status = 'active'").get().n

  const files = walkDir(repoRoot, skipDirs, skipExts)
  await extractStructural(db, files, scope, gitHash)

  const countAfter = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status = 'active'").get().n

  return {
    filesScanned: files.length,
    nodesCreated: countAfter - countBefore
  }
}
