// spec: src/hooks/prompt-submit.js — UserPromptSubmit hook.
// stdin: { prompt, session_id, cwd }
// stdout: { additionalContext: "..." }  — or nothing to skip injection
//
// MUST complete in < 200ms cold. NEVER import mode.js. NEVER make network calls.
// DB path is pre-resolved from cwd — no directory walking on the hot path.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

function appendErrorLog(grasfDir, msg) {
  try {
    mkdirSync(grasfDir, { recursive: true })
    appendFileSync(join(grasfDir, 'error.log'), `[prompt-submit] ${new Date().toISOString()} ${msg}\n`, 'utf8')
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

// Resolve scope from config.json (fast file read, ~0.5ms).
// Falls back to 'root' if config missing or monorepo not configured.
function resolveScope(grasfDir, cwd) {
  try {
    const cfg = JSON.parse(readFileSync(join(grasfDir, 'config.json'), 'utf8'))
    if (cfg.scopes && cfg.scopes.length > 1) {
      const repoRoot = join(grasfDir, '..')
      const rel = relative(repoRoot, cwd).replace(/\\/g, '/')
      return cfg.scopes.find(s => s !== 'root' && rel.startsWith(s)) || 'root'
    }
  } catch { /* no config or parse error */ }
  return 'root'
}

async function main() {
  let payload = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) payload = JSON.parse(raw)
  } catch { process.exit(0) }

  const cwd    = payload.cwd    || process.cwd()
  const prompt = payload.prompt || ''

  const grasfDir = join(cwd, '.grasf')
  const dbPath   = join(grasfDir, 'graph.db')

  if (!existsSync(dbPath)) { process.exit(0) }

  try {
    // Time the DB open — skip injection if too slow to stay under 200ms total
    const t0 = Date.now()
    const { openDb } = await import('../graph/db.js')
    const db = openDb(dbPath)
    if (Date.now() - t0 > 100) { process.exit(0) }

    const scope = resolveScope(grasfDir, cwd)

    // 1. Parse annotations from prompt and write to graph immediately
    const { parseAnnotations } = await import('../extract/annotations.js')
    const { upsertNode }       = await import('../graph/nodes.js')
    for (const ann of parseAnnotations(prompt)) {
      upsertNode(db, {
        type:    ann.type,
        name:    ann.text.slice(0, 120),
        summary: ann.text,
        scope,
      })
    }

    // 2. FTS5 context injection — skip if graph is empty
    const nodeCount = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status = 'active'").get().n
    if (nodeCount === 0) { process.exit(0) }

    const { buildPromptContext } = await import('../retrieval/query.js')
    const context = buildPromptContext(db, prompt, scope, 500)
    if (context) {
      process.stdout.write(JSON.stringify({ additionalContext: context }))
    }
  } catch (err) {
    appendErrorLog(grasfDir, err.message)
  }
  process.exit(0)
}

main()
