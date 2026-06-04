// spec: src/hooks/stop.js — Stop hook: extract + decay + regenerate + session record.
// stdin: { session_id, cwd }
// Runs after every Claude Code response. Must exit 0 always.
//
// Sequence:
//   1. detectLayer()
//   2. findLatestTranscript + parseTranscript
//   3. getChangedFiles (git) + extractStructural
//   4. if api/local: extractSemantic + mergeExtraction
//   5. parseAnnotations from transcript messages
//   6. runDecayPass
//   7. buildContextSlice + renderClaudeMd + writeClaudeMd + renderAgentsMd + writeAgentsMd
//   8. INSERT OR REPLACE sessions record
//   9. exit 0
//
// 25-second timeout guard — logs what completed and exits 0.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'

function appendErrorLog(grasfDir, msg) {
  try {
    mkdirSync(grasfDir, { recursive: true })
    appendFileSync(join(grasfDir, 'error.log'), `[stop] ${new Date().toISOString()} ${msg}\n`, 'utf8')
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

function loadConfig(grasfDir) {
  try { return JSON.parse(readFileSync(join(grasfDir, 'config.json'), 'utf8')) } catch { return {} }
}

// Collect files modified/added since the last commit + current working tree changes.
function getChangedFiles(repoRoot) {
  const SUPPORTED = /\.(js|ts|tsx|jsx|mjs|cjs|py)$/
  const files = new Set()

  const tryExec = (cmd) => {
    try { return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }) } catch { return '' }
  }

  // Uncommitted changes in working tree
  const status = tryExec('git status --porcelain')
  for (const line of status.split('\n')) {
    const f = line.slice(3).trim().split(' -> ').pop() // handle renames
    if (f && SUPPORTED.test(f)) files.add(join(repoRoot, f))
  }

  // Last commit's files
  const committed = tryExec('git diff --name-only HEAD~1 HEAD') ||
                    tryExec('git diff --name-only HEAD')
  for (const f of committed.split('\n').filter(Boolean)) {
    if (SUPPORTED.test(f)) files.add(join(repoRoot, f))
  }

  return [...files].filter(f => existsSync(f))
}

async function main() {
  let payload = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) payload = JSON.parse(raw)
  } catch { /* ignore */ }

  const cwd       = payload.cwd        || process.cwd()
  const sessionId = payload.session_id || `s-${Date.now()}`
  const grasfDir  = join(cwd, '.grasf')
  const dbPath    = join(grasfDir, 'graph.db')

  if (!existsSync(dbPath)) { process.exit(0) }

  // 25-second hard timeout — never block Claude Code
  const timer = setTimeout(() => {
    appendErrorLog(grasfDir, 'timeout exceeded 25s — partial run')
    process.exit(0)
  }, 25000)

  try {
    const cfg         = loadConfig(grasfDir)
    const scope       = cfg.scopes?.[0] || 'root'
    const projectName = cfg.project_name || basename(cwd)
    const repoRoot    = cwd

    const { openDb }            = await import('../graph/db.js')
    const { upsertNode }        = await import('../graph/nodes.js')
    const { runDecayPass }      = await import('../graph/decay.js')
    const { detectLayer }       = await import('../extract/mode.js')
    const { findLatestTranscript, parseTranscript, extractTextContent } = await import('../extract/transcript.js')
    const { extractStructural } = await import('../extract/structural.js')
    const { parseAnnotations }  = await import('../extract/annotations.js')
    const { buildContextSlice } = await import('../retrieval/rank.js')
    const { renderClaudeMd, writeClaudeMd }   = await import('../adapters/claude-md.js')
    const { renderAgentsMd, writeAgentsMd }   = await import('../adapters/agents-md.js')

    const db = openDb(dbPath)

    // 1. Detect extraction layer
    const layerInfo = await detectLayer()

    // 2. Find and parse transcript
    const transcriptPath = findLatestTranscript(cwd)
    let messages    = []
    let transcriptSessionId = sessionId
    if (transcriptPath) {
      const parsed = parseTranscript(transcriptPath)
      messages = parsed.messages
      if (parsed.sessionId) transcriptSessionId = parsed.sessionId
    }

    // 3. Changed files + structural extraction
    const changedFiles = getChangedFiles(repoRoot)
    let gitHash = ''
    try { gitHash = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', timeout: 3000 }).trim() } catch { /* ignore */ }

    if (changedFiles.length > 0) {
      await extractStructural(db, changedFiles, scope, gitHash)
    }

    // 4. Semantic extraction (api / local layers only)
    let semanticResult = null
    if (layerInfo.layer !== 'structural' && messages.length > 0) {
      try {
        const { extractSemantic } = await import('../extract/llm.js')
        const { mergeExtraction } = await import('../extract/merge.js')
        const existingNodes = db.prepare("SELECT name, summary FROM nodes WHERE status = 'active' LIMIT 50").all()
        const existingSummaries = existingNodes.map(n => `${n.name}: ${n.summary || ''}`).join('\n')
        semanticResult = await extractSemantic(layerInfo, messages, existingSummaries)
        if (semanticResult) mergeExtraction(db, semanticResult, scope, transcriptSessionId, repoRoot)
      } catch (err) {
        appendErrorLog(grasfDir, `semantic extraction failed: ${err.message}`)
      }
    }

    // 5. Annotations from all transcript messages
    // spec: dead_end annotations are "remnant from the start" — immediately status='remnant'
    const fullText = messages.map(m => extractTextContent(m)).join(' ')
    for (const ann of parseAnnotations(fullText)) {
      const status = ann.type === 'dead_end' ? 'remnant' : undefined
      upsertNode(db, { type: ann.type, name: ann.text.slice(0, 120), summary: ann.text, scope, ...(status ? { status } : {}) })
    }

    // 6. Decay pass
    runDecayPass(db)

    // 7. Write session record — must be before CLAUDE.md generation so this session
    //    appears in the "Recent session activity" section immediately.
    const goal      = semanticResult?.goal      ?? parseAnnotations(fullText).find(a => a.type === 'goal')?.text ?? null
    const outcome   = semanticResult?.outcome   ?? null
    const nextStep  = semanticResult?.next_step ?? null
    const endedAt   = new Date().toISOString()

    const existing  = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(transcriptSessionId)
    const startedAt = existing?.started_at ?? endedAt

    const relChangedFiles = changedFiles
      .map(f => f.replace(repoRoot + '\\', '').replace(repoRoot + '/', '').replace(/\\/g, '/'))

    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, started_at, ended_at, goal, outcome, next_step, scope, transcript_path, changed_files, extraction_layer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transcriptSessionId, startedAt, endedAt,
      goal, outcome, nextStep,
      scope, transcriptPath,
      JSON.stringify(relChangedFiles),
      layerInfo.layer
    )

    // 8. Regenerate context files — session record is now in DB so it shows in history
    const slice    = buildContextSlice(db, { scope, tokenBudget: cfg.token_budget || 2000 })
    const claudeMd = renderClaudeMd(slice, projectName, layerInfo, repoRoot)
    writeClaudeMd(claudeMd, repoRoot)
    writeAgentsMd(renderAgentsMd(slice, projectName, layerInfo), repoRoot)

  } catch (err) {
    appendErrorLog(grasfDir, err.message)
  }

  clearTimeout(timer)
  process.exit(0)
}

main()
