// spec: src/init/monorepo.js — Detect monorepo structure and map workspace package scopes.
//
// Detects: pnpm-workspace.yaml, nx.json, turbo.json, lerna.json
// Scope assignment: each workspace package gets scope = its path relative to repo root
//                   (e.g. "apps/api", "packages/core"). Cross-cutting nodes use scope = "root".
//
// Returns:
//   { isMonorepo: bool, scopes: string[], packages: [{ name, path, scope }] }

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

const MONOREPO_MARKERS = ['pnpm-workspace.yaml', 'nx.json', 'turbo.json', 'lerna.json']
const WORKSPACE_DIRS   = ['packages', 'apps', 'libs', 'services', 'modules']
const SKIP_DIRS        = ['node_modules', '.git', 'dist', 'build', '.next']

// Parse the packages glob patterns from lerna.json (plain JSON, easy to handle).
function lernaPackages(repoRoot) {
  try {
    const lerna = JSON.parse(readFileSync(join(repoRoot, 'lerna.json'), 'utf8'))
    return lerna.packages || []
  } catch {
    return []
  }
}

// Minimal YAML line scanner — extracts unquoted / single-quoted / double-quoted items
// from the `packages:` list in pnpm-workspace.yaml. Avoids adding a YAML dependency.
function pnpmPackages(repoRoot) {
  try {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    const inPackages = { value: false }
    const globs = []
    for (const line of yaml.split('\n')) {
      if (/^packages\s*:/.test(line)) { inPackages.value = true; continue }
      if (inPackages.value) {
        if (/^\s+-\s+/.test(line)) {
          const item = line.replace(/^\s+-\s+/, '').replace(/^['"]|['"]$/g, '').trim()
          if (item) globs.push(item)
        } else if (/^\S/.test(line)) {
          break // new top-level key — done
        }
      }
    }
    return globs
  } catch {
    return []
  }
}

// Expand simple glob patterns like "packages/*" → find matching dirs.
function expandGlobs(repoRoot, patterns) {
  const dirs = new Set()
  for (const pattern of patterns) {
    // Support "dir/*" and "dir/**" — scan one level of the prefix dir.
    const parts = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '').replace(/\/$/, '')
    const base = join(repoRoot, parts)
    if (!existsSync(base)) continue
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && !SKIP_DIRS.includes(entry.name)) {
          dirs.add(join(base, entry.name))
        }
      }
    } catch { /* skip */ }
  }
  return [...dirs]
}

// Fall back: scan WORKSPACE_DIRS for subdirectories that contain a package.json.
function discoverPackageDirs(repoRoot) {
  const dirs = []
  for (const wsDir of WORKSPACE_DIRS) {
    const base = join(repoRoot, wsDir)
    if (!existsSync(base)) continue
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP_DIRS.includes(entry.name)) continue
        const pkgDir = join(base, entry.name)
        if (existsSync(join(pkgDir, 'package.json'))) dirs.push(pkgDir)
      }
    } catch { /* skip */ }
  }
  return dirs
}

export function detectMonorepo(repoRoot) {
  const hasMarker = MONOREPO_MARKERS.some(m => existsSync(join(repoRoot, m)))
  if (!hasMarker) return { isMonorepo: false, scopes: ['root'], packages: [] }

  // Collect candidate package directories from config files, then fall back to filesystem.
  let globs = [...lernaPackages(repoRoot), ...pnpmPackages(repoRoot)]
  let pkgDirs = globs.length > 0
    ? expandGlobs(repoRoot, globs)
    : discoverPackageDirs(repoRoot)

  const packages = []
  for (const dir of pkgDirs) {
    let name = basename(dir)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name) name = pkg.name
    } catch { /* use dirname as name */ }
    const scope = relative(repoRoot, dir).replace(/\\/g, '/')
    packages.push({ name, path: dir, scope })
  }

  const scopes = ['root', ...packages.map(p => p.scope)]
  return { isMonorepo: true, scopes, packages }
}
