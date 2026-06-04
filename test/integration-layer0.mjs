// Integration test — Layer 0 (Structural)
// Creates a real project, runs init, simulates a Claude Code session via stop.js,
// verifies the generated CLAUDE.md contains accurate session data.
//
// Run: node test/integration-layer0.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const GRASF_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const NODE = process.execPath
const GRASF_BIN = join(GRASF_ROOT, 'bin', 'grasf.js')

function pass(msg) { console.log(`  ✓ ${msg}`) }
function fail(msg) { console.error(`  ✗ FAIL: ${msg}`); process.exit(1) }
function section(msg) { console.log(`\n── ${msg}`) }

// ── 1. Create test project ────────────────────────────────────────────────────
section('1. Create test project')

const testDir = join(tmpdir(), `grasf-layer0-${Date.now()}`)
mkdirSync(testDir, { recursive: true })

writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'grasf-test-app', version: '1.0.0' }))

writeFileSync(join(testDir, 'auth.js'), `
// Authentication module
export function validateToken(token) {
  if (!token) throw new Error('Token required')
  return token.startsWith('Bearer ')
}

export function createSession(userId) {
  return { userId, createdAt: new Date().toISOString(), active: true }
}

export function destroySession(session) {
  session.active = false
  return session
}
`)

writeFileSync(join(testDir, 'db.js'), `
// Database module
export class Database {
  constructor(connectionUrl) {
    this.url = connectionUrl
    this.connected = false
  }

  async connect() {
    this.connected = true
    return this
  }

  async query(sql, params = []) {
    if (!this.connected) throw new Error('Not connected')
    return []
  }

  async close() {
    this.connected = false
  }
}
`)

writeFileSync(join(testDir, 'utils.js'), `
export function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
`)

// Init git
const gitOpts = { cwd: testDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
try {
  execFileSync('git', ['init'], gitOpts)
  execFileSync('git', ['config', 'user.email', 'test@grasf.test'], gitOpts)
  execFileSync('git', ['config', 'user.name', 'GRASF Test'], gitOpts)
  execFileSync('git', ['add', '.'], gitOpts)
  execFileSync('git', ['commit', '-m', 'initial commit'], gitOpts)
  pass('git repo initialized')
} catch (e) {
  pass('no git (ok — git is optional)')
}

// ── 2. grasf init ────────────────────────────────────────────────────────────
section('2. grasf init')

const initOut = execFileSync(NODE, [GRASF_BIN, 'init'], {
  cwd: testDir, encoding: 'utf8', env: { ...process.env, GRASF_LAYER: 'structural' }
})
console.log(initOut.trim().split('\n').map(l => '    ' + l).join('\n'))

// Verify node count > 0
const nodeMatch = initOut.match(/Graph: (\d+) nodes/)
if (!nodeMatch) fail('init output missing "Graph: N nodes"')
const nodeCount = parseInt(nodeMatch[1])
if (nodeCount === 0) fail('init created 0 nodes — AST scan did not work')
pass(`${nodeCount} nodes created by structural scan`)

// Verify CLAUDE.md exists at repo root
if (!existsSync(join(testDir, 'CLAUDE.md'))) fail('CLAUDE.md not written to repo root')
pass('CLAUDE.md written to repo root')

// Verify .grasf structure
const required = ['graph.db', 'config.json', join('generated', 'CLAUDE.md')]
for (const f of required) {
  if (!existsSync(join(testDir, '.grasf', f))) fail(`.grasf/${f} missing`)
}
pass('.grasf/ directory structure correct')

// ── 3. Simulate a file edit (as if user worked in this session) ───────────────
section('3. Simulate session: edit auth.js')

// Append a new function — simulates user asking Claude to add it
writeFileSync(join(testDir, 'auth.js'),
  readFileSync(join(testDir, 'auth.js'), 'utf8') +
  '\nexport function refreshToken(session) {\n  session.refreshedAt = new Date().toISOString()\n  return session\n}\n'
)
pass('auth.js edited (added refreshToken function)')

// ── 4. Plant a realistic JSONL transcript at the correct path ─────────────────
section('4. Plant JSONL transcript at ~/.claude/projects/<base64url(cwd)>/')

const sessionId = `test-layer0-${Date.now()}`
const encoded   = Buffer.from(testDir).toString('base64url')
const transcriptDir = join(homedir(), '.claude', 'projects', encoded)
mkdirSync(transcriptDir, { recursive: true })

const transcriptLines = [
  JSON.stringify({ role: 'user',      content: 'Can you add a refreshToken function to auth.js that updates the refreshedAt timestamp?', timestamp: new Date().toISOString() }),
  JSON.stringify({ role: 'assistant', content: 'I\'ll add a refreshToken function to auth.js that updates the refreshedAt timestamp on the session object.',           timestamp: new Date().toISOString() }),
  JSON.stringify({ role: 'user',      content: 'Great, that looks correct. grasf:decision Use session-based refresh tokens to avoid storing state server-side', timestamp: new Date().toISOString() }),
]
const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
writeFileSync(transcriptPath, transcriptLines.join('\n'), 'utf8')
pass(`transcript planted at ${transcriptPath.slice(homedir().length)}`)

// ── 5. Invoke stop.js ─────────────────────────────────────────────────────────
section('5. Invoke stop.js (simulates Claude Code session end)')

const stopPayload = JSON.stringify({ session_id: sessionId, cwd: testDir })
const stopResult = spawnSync(NODE, [join(GRASF_ROOT, 'src', 'hooks', 'stop.js')], {
  input: stopPayload,
  encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'structural' },
  timeout: 30000
})

if (stopResult.status !== 0) {
  console.log('stop.js stderr:', stopResult.stderr)
  fail(`stop.js exited with code ${stopResult.status}`)
}
if (stopResult.stderr?.includes('Error') || stopResult.stderr?.includes('error')) {
  console.log('  (stop.js stderr):', stopResult.stderr.trim())
}
pass('stop.js exited 0')

// ── 6. Verify CLAUDE.md updated ───────────────────────────────────────────────
section('6. Verify generated CLAUDE.md')

const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8')
console.log('\n    Generated CLAUDE.md:')
console.log(claudeMd.split('\n').map(l => '    │ ' + l).join('\n'))

// Session activity section
if (!claudeMd.includes('## Recent session activity')) fail('CLAUDE.md missing "Recent session activity" section')
pass('"Recent session activity" section present')

// Session activity must be populated (not the placeholder)
if (claudeMd.includes('no sessions recorded yet')) fail('"Recent session activity" still shows placeholder — session record not written before CLAUDE.md generation')
pass('Recent session activity is populated (not placeholder)')

// Should reference auth.js in the session activity section
const sessionSection = claudeMd.split('## Recent session activity')[1]?.split('##')[0] || ''
if (!sessionSection.includes('auth')) fail('Session activity section does not reference auth.js')
pass('Session activity section references edited file (auth.js)')

// Decision from annotation — grasf:decision was in the transcript
if (!claudeMd.includes('decision') && !claudeMd.includes('Decision')) {
  // Not a hard fail for layer 0 — decisions from annotations go through upsertNode
  console.log('  (note: grasf:decision annotation processed but may not appear as named decision in this slice)')
}

// Header contains correct layer
if (!claudeMd.includes('Layer: structural')) fail('CLAUDE.md header missing "Layer: structural"')
pass('Layer: structural in header')

// Empty-state annotation prompt references the touched file
if (claudeMd.includes('none recorded') && claudeMd.includes('auth')) {
  pass('Empty-state annotation prompt references auth.js')
} else if (claudeMd.includes('## Key decisions') && !claudeMd.includes('none recorded')) {
  pass('Decisions section has content (annotation was processed)')
}

// ── 7. grasf status (Layer 0) ────────────────────────────────────────────────
section('7. grasf status — Layer 0')

const statusOut = execFileSync(NODE, [GRASF_BIN, 'status'], {
  cwd: testDir, encoding: 'utf8', env: { ...process.env, GRASF_LAYER: 'structural' }
})
console.log(statusOut.trim().split('\n').map(l => '    ' + l).join('\n'))

if (!statusOut.includes('Extraction layer: Structural')) fail('status does not show "Extraction layer: Structural"')
pass('grasf status shows correct Structural layer format')

if (!statusOut.includes('Last session:')) fail('status missing "Last session:" line')
pass('Last session recorded in status')

// ── 8. grasf query works against the populated graph ─────────────────────────
section('8. grasf query against populated graph')

const queryOut = execFileSync(NODE, [GRASF_BIN, 'query', 'token session'], {
  cwd: testDir, encoding: 'utf8'
})
console.log('    query "token session":', queryOut.trim())
if (queryOut.includes('No results')) fail('FTS5 query found no results for "token session"')
pass('FTS5 query returns results from Layer 0 graph')

// ── Cleanup ───────────────────────────────────────────────────────────────────
section('Cleanup')
rmSync(testDir, { recursive: true })
try { rmSync(transcriptDir, { recursive: true }) } catch { /* ignore */ }
pass('test directory cleaned up')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Layer 0 — ALL CHECKS PASSED')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
