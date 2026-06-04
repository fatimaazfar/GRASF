// spec: src/init/git.js — Read git metadata for the current repo.
//
// Returns:
//   { branch, hash, commits: [{hash, message}], recentlyChanged: string[] }
//
// `hash` is used to tag nodes with git_hash so the same entity extracted by
// two developers produces the same node ID (deterministic merge strategy).
// All git errors are caught silently — git is optional, not required.

import { execSync } from 'node:child_process'

function exec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

export function getGitMetadata(repoRoot) {
  const branch = exec('git rev-parse --abbrev-ref HEAD', repoRoot)
  const hash   = exec('git rev-parse HEAD', repoRoot)

  const logRaw = exec('git log --oneline -10', repoRoot)
  const commits = logRaw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const space = line.indexOf(' ')
      return { hash: line.slice(0, space), message: line.slice(space + 1) }
    })

  // Files touched in the last 5 commits — used to seed the "recently changed" context.
  // Try HEAD~5 first; fall back to HEAD (single-commit repos have no HEAD~5).
  const changedRaw = exec('git diff --name-only HEAD~5 HEAD', repoRoot)
    || exec('git diff --name-only HEAD', repoRoot)
  const recentlyChanged = changedRaw.split('\n').filter(Boolean)

  return { branch, hash, commits, recentlyChanged }
}
