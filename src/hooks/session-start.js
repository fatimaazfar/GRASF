// spec: src/hooks/session-start.js — SessionStart hook: record session open.
// stdin: { session_id, cwd }
// INSERT OR IGNORE partial session row — stop.js will INSERT OR REPLACE with full data.
// Exit 0 always. Append errors to .grasf/error.log, never crash Claude Code.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function appendErrorLog(grasfDir, msg) {
  try {
    mkdirSync(grasfDir, { recursive: true })
    appendFileSync(join(grasfDir, 'error.log'), `[session-start] ${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch { /* ignore */ }
}

function readStdin() {
  return new Promise(resolve => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(''))
  })
}

async function main() {
  let payload = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) payload = JSON.parse(raw)
  } catch { /* ignore malformed input */ }

  const cwd       = payload.cwd        || process.cwd()
  const sessionId = payload.session_id || `s-${Date.now()}`
  const grasfDir  = join(cwd, '.grasf')
  const dbPath    = join(grasfDir, 'graph.db')

  if (!existsSync(dbPath)) { process.exit(0) }

  try {
    const { openDb } = await import('../graph/db.js')
    const db  = openDb(dbPath)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT OR IGNORE INTO sessions (id, started_at, ended_at, scope, changed_files, extraction_layer)
      VALUES (?, ?, ?, 'root', '[]', 'structural')
    `).run(sessionId, now, now)
  } catch (err) {
    appendErrorLog(grasfDir, err.message)
  }
  process.exit(0)
}

main()
