// spec: src/config.js — Load/save .grasf/config.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

export const DEFAULT_CONFIG = {
  version:                  '0.1.0',
  project_name:             '',
  monorepo:                 false,
  scopes:                   ['root'],
  token_budget:             2000,
  decay_threshold:          0.15,
  decision_floor:           0.3,
  max_inject_lines:         150,
  extraction_layer:         'auto',
  ollama_url:               'http://localhost:11434',
  ollama_model_preference:  ['mistral:7b', 'llama3.2:3b', 'llama3:8b', 'phi3:mini'],
  anthropic_model:          'claude-haiku-4-5-20251001',
  skip_dirs:                ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'vendor'],
  skip_extensions:          ['.jpg', '.png', '.gif', '.svg', '.pdf', '.lock', '.min.js'],
  hooks_installed:          false,
  created_at:               null,
  last_session_at:          null,
}

export function loadConfig(repoRoot) {
  const path = join(repoRoot, '.grasf', 'config.json')
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, 'utf8')) } } catch { return { ...DEFAULT_CONFIG } }
}

export function saveConfig(repoRoot, config) {
  const dir = join(repoRoot, '.grasf')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

export function inferProjectName(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    if (pkg.name) return pkg.name
  } catch { /* not a Node project or no package.json */ }
  return basename(repoRoot)
}

// Walk up from cwd until a directory containing .grasf/ is found.
// Returns the repo root path, or null if not found.
export function findRepoRoot(cwd = process.cwd()) {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.grasf'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
