// Integration test — Layer 2 (Local / Ollama)
// Verifies:
//   - detectLayer() returns 'local' when GRASF_LAYER=local
//   - detectLayer() returns 'structural' when Ollama is not running (graceful)
//   - grasf status shows correct Local layer format
//   - stop.js with GRASF_LAYER=local falls back to structural when Ollama is absent
//
// Run: node test/integration-layer2.mjs

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
section('1. detectLayer() — Ollama scenarios')

const { detectLayer } = await import(new URL('src/extract/mode.js', GRASF_ROOT_URL))

// GRASF_LAYER=local override — returns 'local' regardless of Ollama status
// (if Ollama not running, model will be null but layer is still 'local')
process.env.GRASF_LAYER = 'local'
delete process.env.ANTHROPIC_API_KEY
const r1 = await detectLayer()
delete process.env.GRASF_LAYER
if (r1.layer !== 'local') fail(`GRASF_LAYER=local: expected 'local', got '${r1.layer}'`)
pass(`GRASF_LAYER=local override → layer='local', model='${r1.model}'`)

// Without override and no API key + no Ollama → structural
process.env.ANTHROPIC_API_KEY = ''
const r2 = await detectLayer()
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY // restore
if (r2.layer !== 'structural') fail(`No API key, no Ollama: expected 'structural', got '${r2.layer}'`)
pass(`No API key + Ollama not running → falls back to 'structural' (correct)`)

// ── 2. grasf status shows Local layer format ──────────────────────────────────
section('2. grasf status — Local layer')

const testDir = join(tmpdir(), `grasf-layer2-${Date.now()}`)
mkdirSync(testDir, { recursive: true })
writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'local-test-app' }))
writeFileSync(join(testDir, 'worker.js'), `
export function processJob(job) { return job.id }
export function queueJob(queue, job) { queue.push(job); return queue }
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

// With GRASF_LAYER=local, model preference: mistral:7b (not running) → model=null
// Status should still show the Local format
const statusOut = execFileSync(NODE, [GRASF_BIN, 'status'], {
  cwd: testDir, encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'local', ANTHROPIC_API_KEY: '' }
})
console.log(statusOut.trim().split('\n').map(l => '    ' + l).join('\n'))

if (!statusOut.includes('Extraction layer: Local')) fail('status missing "Extraction layer: Local"')
pass('grasf status shows "Extraction layer: Local"')

if (!statusOut.includes('Ollama')) fail('status missing Ollama reference')
pass('status references Ollama')

// ── 3. stop.js with GRASF_LAYER=local — graceful fallback when Ollama absent ──
section('3. stop.js — graceful fallback when Ollama not running')

const sessionId = `local-test-${Date.now()}`
const encoded   = Buffer.from(testDir).toString('base64url')
const tDir      = join(homedir(), '.claude', 'projects', encoded)
mkdirSync(tDir, { recursive: true })
writeFileSync(join(tDir, `${sessionId}.jsonl`),
  JSON.stringify({ role: 'user',      content: 'Add a cancelJob function to worker.js' }) + '\n' +
  JSON.stringify({ role: 'assistant', content: 'I will add cancelJob that removes a job from the queue' })
)

writeFileSync(join(testDir, 'worker.js'),
  readFileSync(join(testDir, 'worker.js'), 'utf8') +
  '\nexport function cancelJob(queue, jobId) { return queue.filter(j => j.id !== jobId) }\n'
)

const stopResult = spawnSync(NODE, [join(GRASF_ROOT, 'src', 'hooks', 'stop.js')], {
  input: JSON.stringify({ session_id: sessionId, cwd: testDir }),
  encoding: 'utf8',
  env: { ...process.env, GRASF_LAYER: 'local', ANTHROPIC_API_KEY: '' },
  timeout: 30000
})

if (stopResult.status !== 0) {
  console.log('stderr:', stopResult.stderr)
  fail(`stop.js exited ${stopResult.status} — must always exit 0`)
}
pass('stop.js exited 0 when Ollama absent')

// Check error.log — Ollama failure should be logged
const errLogPath = join(testDir, '.grasf', 'error.log')
if (existsSync(errLogPath)) {
  const errLog = readFileSync(errLogPath, 'utf8')
  console.log('    error.log:', errLog.trim().split('\n').map(l => '    │ ' + l).join('\n'))
  pass('Ollama failure logged to error.log')
}

// CLAUDE.md must be generated with local layer header
const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8')
if (!claudeMd.includes('Layer: local')) fail('CLAUDE.md layer header should show local')
pass('CLAUDE.md generated with "Layer: local" header despite Ollama being absent')

if (!claudeMd.includes('Session 1')) fail('CLAUDE.md missing session activity')
pass('Session 1 recorded in CLAUDE.md')

if (!claudeMd.includes('worker')) fail('CLAUDE.md missing worker.js structural nodes')
pass('Structural extraction ran as fallback for Ollama-absent layer')

// ── 4. Cross-layer: all three status formats correct ──────────────────────────
section('4. Cross-layer status format verification')

const layerTests = [
  { env: { GRASF_LAYER: 'structural' }, expect: 'Extraction layer: Structural  (free, code-only)', label: 'Structural' },
  { env: { GRASF_LAYER: 'api', ANTHROPIC_API_KEY: 'sk-test' }, expect: 'Extraction layer: API  ✓  (claude-haiku-4-5)', label: 'API' },
  { env: { GRASF_LAYER: 'local' }, expect: 'Extraction layer: Local', label: 'Local' },
]

for (const { env, expect, label } of layerTests) {
  const out = execFileSync(NODE, [GRASF_BIN, 'status'], {
    cwd: testDir, encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: '', ...env }
  })
  if (!out.includes(expect)) fail(`${label} layer: status output does not match spec format. Expected: "${expect}"`)
  pass(`${label}: "${expect}"`)
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
section('Cleanup')
rmSync(testDir, { recursive: true })
try { rmSync(tDir, { recursive: true }) } catch { /* ignore */ }
pass('test directory cleaned up')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Layer 2 — ALL CHECKS PASSED')
console.log('(Note: Ollama semantic content not verified — requires running Ollama instance)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
