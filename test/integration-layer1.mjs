// Integration test — Layer 1 (API)
// Verifies:
//   - detectLayer() returns api when ANTHROPIC_API_KEY is set
//   - grasf status shows correct API layer format
//   - stop.js falls back gracefully when API call fails (bad key)
//   - CLAUDE.md is still generated with correct layer header
//
// NOTE: This test uses an invalid API key to verify graceful fallback.
// A test with a real API key producing semantic content requires manual verification.
//
// Run: node test/integration-layer1.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const GRASF_ROOT_URL = new URL('..', import.meta.url)
const GRASF_ROOT = fileURLToPath(GRASF_ROOT_URL)
const NODE = process.execPath
const GRASF_BIN = join(GRASF_ROOT, 'bin', 'grasf.js')

function pass(msg) { console.log(`  ✓ ${msg}`) }
function fail(msg) { console.error(`  ✗ FAIL: ${msg}`); process.exit(1) }
function section(msg) { console.log(`\n── ${msg}`) }

// ── 1. Layer detection ────────────────────────────────────────────────────────
section('1. detectLayer() with ANTHROPIC_API_KEY')

const { detectLayer } = await import(new URL('src/extract/mode.js', GRASF_ROOT_URL))

// Test GRASF_LAYER=api override
process.env.GRASF_LAYER = 'api'
const r1 = await detectLayer()
delete process.env.GRASF_LAYER
if (r1.layer !== 'api') fail(`GRASF_LAYER=api override: expected 'api', got '${r1.layer}'`)
if (r1.model !== 'claude-haiku-4-5-20251001') fail(`Expected haiku model, got '${r1.model}'`)
pass(`GRASF_LAYER=api override → layer='api', model='${r1.model}'`)

// Test ANTHROPIC_API_KEY detection
const origKey = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
const r2 = await detectLayer()
process.env.ANTHROPIC_API_KEY = origKey
if (r2.layer !== 'api') fail(`ANTHROPIC_API_KEY set: expected 'api', got '${r2.layer}'`)
pass(`ANTHROPIC_API_KEY set → layer='api' (correct)')`)

// ── 2. grasf status shows API layer format ────────────────────────────────────
section('2. grasf status — API layer')

const testDir = join(tmpdir(), `grasf-layer1-${Date.now()}`)
mkdirSync(testDir, { recursive: true })
writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'api-test-app' }))
writeFileSync(join(testDir, 'server.js'), `
export function startServer(port) { return port }
export function stopServer(server) { server.close() }
`)

try {
  execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: testDir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir, stdio: 'pipe' })
} catch { /* git optional */ }

execFileSync(NODE, [GRASF_BIN, 'init'], {
  cwd: testDir, encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'structural', ANTHROPIC_API_KEY: '' }
})
pass('grasf init completed on test project')

const statusOut = execFileSync(NODE, [GRASF_BIN, 'status'], {
  cwd: testDir, encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'api', ANTHROPIC_API_KEY: 'sk-ant-test' }
})
console.log(statusOut.trim().split('\n').map(l => '    ' + l).join('\n'))

if (!statusOut.includes('Extraction layer: API  ✓  (claude-haiku-4-5)'))
  fail('status does not match spec format "Extraction layer: API  ✓  (claude-haiku-4-5)"')
pass('grasf status shows correct API layer format per spec')

if (!statusOut.includes('Semantic extraction active. ~$0.01'))
  fail('status missing semantic extraction cost note')
pass('status includes semantic extraction cost note')

// ── 3. stop.js with invalid API key — graceful fallback ───────────────────────
section('3. stop.js — graceful fallback when API call fails')

const sessionId = `api-test-${Date.now()}`
const encoded   = Buffer.from(testDir).toString('base64url')
const tDir      = join(homedir(), '.claude', 'projects', encoded)
mkdirSync(tDir, { recursive: true })
writeFileSync(join(tDir, `${sessionId}.jsonl`),
  JSON.stringify({ role: 'user',      content: 'Add a restartServer function that stops then starts the server' }) + '\n' +
  JSON.stringify({ role: 'assistant', content: 'I will add restartServer that calls stopServer then startServer' })
)

// Modify a file to give the structural pass something to find
writeFileSync(join(testDir, 'server.js'),
  readFileSync(join(testDir, 'server.js'), 'utf8') +
  '\nexport function restartServer(server, port) { stopServer(server); return startServer(port) }\n'
)

const stopResult = spawnSync(NODE, [join(GRASF_ROOT, 'src', 'hooks', 'stop.js')], {
  input: JSON.stringify({ session_id: sessionId, cwd: testDir }),
  encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'api', ANTHROPIC_API_KEY: 'sk-ant-invalidkey' },
  timeout: 30000
})

if (stopResult.status !== 0) {
  console.log('stderr:', stopResult.stderr)
  fail(`stop.js exited ${stopResult.status} — must always exit 0`)
}
pass('stop.js exited 0 despite API failure (never crashes Claude Code)')

// error.log should contain the API failure — gracefully logged
const errLogPath = join(testDir, '.grasf', 'error.log')
if (existsSync(errLogPath)) {
  const errLog = readFileSync(errLogPath, 'utf8')
  console.log('    error.log:', errLog.trim().split('\n').map(l => '    │ ' + l).join('\n'))
  if (!errLog.includes('semantic extraction failed')) fail('error.log does not mention semantic extraction failure')
  pass('semantic extraction failure logged to .grasf/error.log (not surfaced to user)')
}

// CLAUDE.md must still be generated
const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8')
if (!claudeMd.includes('Layer: api')) fail('CLAUDE.md layer header should show api even on failure')
pass('CLAUDE.md generated with "Layer: api" header despite API failure')

if (!claudeMd.includes('Session 1')) fail('CLAUDE.md missing session activity after fallback run')
pass('Session 1 recorded in CLAUDE.md session activity')

// Structural extraction still worked — server.js nodes should be present
if (!claudeMd.includes('server')) fail('CLAUDE.md missing server.js nodes from structural fallback')
pass('Structural extraction ran successfully as fallback')

// ── Cleanup ───────────────────────────────────────────────────────────────────
section('Cleanup')
rmSync(testDir, { recursive: true })
try { rmSync(tDir, { recursive: true }) } catch { /* ignore */ }
pass('test directory cleaned up')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Layer 1 — ALL CHECKS PASSED')
console.log('(Note: semantic content from real API not verified — requires valid ANTHROPIC_API_KEY)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
