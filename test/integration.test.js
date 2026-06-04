// Integration test — Mocked Layer 1 (API) and Layer 2 (Local) semantic extraction
// Verifies the full stop.js pipeline end-to-end against a real SQLite database
// using a local HTTP mock server. No live credentials or running Ollama required.
//
// Why async spawn (not spawnSync): the mock HTTP server runs in the same Node.js
// process. spawnSync blocks the event loop, preventing the server from responding
// to the child's requests. spawn() keeps the event loop alive so both run concurrently.
//
// The mock server returns the same JSON structure the real APIs return:
//   Anthropic: POST /v1/messages → { content: [{ type:'text', text: <json> }], ... }
//   Ollama:    GET  /api/tags    → { models: [{ name: 'mistral:7b' }] }
//              POST /api/generate → { response: <json>, done: true }
//
// Asserts CLAUDE.md contains goal, both decisions, dead-end in correct sections.
//
// Run: node test/integration.test.js

import { createServer }                                      from 'node:http'
import { spawn, execFileSync }                               from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync }    from 'node:fs'
import { join }                                              from 'node:path'
import { tmpdir, homedir }                                   from 'node:os'
import { fileURLToPath }                                     from 'node:url'

const GRASF_ROOT_URL = new URL('..', import.meta.url)
const GRASF_ROOT     = fileURLToPath(GRASF_ROOT_URL)
const NODE           = process.execPath
const GRASF_BIN      = join(GRASF_ROOT, 'bin', 'grasf.js')

function pass(msg)    { console.log(`  ✓ ${msg}`) }
function fail(msg)    { console.error(`  ✗ FAIL: ${msg}`); process.exit(1) }
function section(msg) { console.log(`\n── ${msg}`) }

// ── Fake extraction payload ────────────────────────────────────────────────────
// Realistic structured payload that both Anthropic and Ollama mocks return.
// Contains: 1 entity, 2 decisions, 1 dead-end, goal, outcome, next_step.
const EXTRACTION_PAYLOAD = {
  entities: [
    { type: 'function', name: 'processPayment', summary: 'Handles payment via Stripe API', file_path: 'payments.js' }
  ],
  decisions: [
    {
      name:      'Use Stripe over PayPal',
      summary:   'Stripe chosen for better API ergonomics and webhook support',
      rationale: 'PayPal SDK had poor TypeScript support'
    },
    {
      name:      'Store card tokens server-side only',
      summary:   'Raw card data never touches client — only Stripe tokens stored',
      rationale: 'PCI DSS compliance requirement'
    }
  ],
  dead_ends: [
    {
      name:             'Braintree integration attempt',
      summary:          'Tried Braintree SDK but abandoned mid-integration',
      reason_abandoned: 'Documentation outdated, SDK last updated 2021'
    }
  ],
  goal:          'Implement secure payment processing for the checkout flow',
  outcome:       'Stripe integration complete with createCharge and webhook verification',
  next_step:     'Add refund endpoint and test webhook signature verification',
  relationships: []
}

// ── Mock HTTP server ───────────────────────────────────────────────────────────
// Handles both Anthropic (/v1/messages) and Ollama (/api/tags, /api/generate).
// Runs in the same process — MUST use async spawn (not spawnSync) so the event
// loop stays alive to process incoming HTTP requests from the child process.
//
// activePayload is mutable so individual tests can inject a custom payload
// (e.g. with an absolute file_path) without reconstructing the whole server.
let activePayload = EXTRACTION_PAYLOAD

function startMockServer() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        // Force connection close after each response — prevents undici keep-alive pool
        // from holding open handles when the stop.js child exits on Windows (libuv uv_async).
        res.setHeader('Connection', 'close')

        // Ollama: model list
        if (req.method === 'GET' && req.url === '/api/tags') {
          res.writeHead(200)
          res.end(JSON.stringify({ models: [{ name: 'mistral:7b' }] }))
          return
        }

        // Ollama: generate — returns active payload as response string
        if (req.method === 'POST' && req.url === '/api/generate') {
          res.writeHead(200)
          res.end(JSON.stringify({
            model:    'mistral:7b',
            response: JSON.stringify(activePayload),
            done:     true
          }))
          return
        }

        // Anthropic: messages — response matches real Anthropic API wire format
        if (req.method === 'POST' && req.url === '/v1/messages') {
          res.writeHead(200)
          res.end(JSON.stringify({
            id:            'msg_mock_integration_test',
            type:          'message',
            role:          'assistant',
            content:       [{ type: 'text', text: JSON.stringify(activePayload) }],
            model:         'claude-haiku-4-5-20251001',
            stop_reason:   'end_turn',
            stop_sequence: null,
            usage:         { input_tokens: 500, output_tokens: 200 }
          }))
          return
        }

        res.writeHead(404)
        res.end(JSON.stringify({ error: `mock: unhandled ${req.method} ${req.url}` }))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

// ── Async stop.js runner ───────────────────────────────────────────────────────
// Uses spawn() not spawnSync() — the event loop must stay alive so the mock
// HTTP server can respond to requests from the stop.js child process.
function runStop(testDir, sessionId, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [join(GRASF_ROOT, 'src', 'hooks', 'stop.js')], {
      stdio:   ['pipe', 'pipe', 'pipe'],
      env:     { ...process.env, ANTHROPIC_API_KEY: '', ...extraEnv },
      timeout: 30000
    })

    child.stdin.write(JSON.stringify({ session_id: sessionId, cwd: testDir }))
    child.stdin.end()

    let stderr = ''
    child.stderr.on('data', d => { stderr += d.toString() })

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`stop.js exited ${code}\nstderr: ${stderr.slice(0, 400)}`))
      } else {
        try {
          resolve(readFileSync(join(testDir, 'CLAUDE.md'), 'utf8'))
        } catch (e) {
          reject(new Error(`CLAUDE.md not found after stop.js: ${e.message}`))
        }
      }
    })

    child.on('error', reject)
  })
}

// ── Project setup ──────────────────────────────────────────────────────────────
function setupProject(testDir, sessionId) {
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'payment-service' }))
  writeFileSync(join(testDir, 'payments.js'), `
export function processPayment(amount, cardToken) {
  return stripe.charges.create({ amount, source: cardToken })
}
export function refundPayment(chargeId) {
  return stripe.refunds.create({ charge: chargeId })
}
`)

  try {
    execFileSync('git', ['init'],                                    { cwd: testDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@test.com'],  { cwd: testDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Test'],            { cwd: testDir, stdio: 'pipe' })
    execFileSync('git', ['add', '.'],                               { cwd: testDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'],                   { cwd: testDir, stdio: 'pipe' })
  } catch { /* git optional */ }

  // grasf init — builds the SQLite DB using structural layer (no API calls)
  execFileSync(NODE, [GRASF_BIN, 'init'], {
    cwd: testDir, encoding: 'utf8',
    env: { ...process.env, GRASF_LAYER: 'structural', ANTHROPIC_API_KEY: '' }
  })

  // Plant JSONL transcript at ~/.claude/projects/<base64url(cwd)>/
  const encoded = Buffer.from(testDir).toString('base64url')
  const tDir    = join(homedir(), '.claude', 'projects', encoded)
  mkdirSync(tDir, { recursive: true })
  writeFileSync(join(tDir, `${sessionId}.jsonl`),
    JSON.stringify({ role: 'user',      content: 'We need payment processing. We tried Braintree first but the SDK was outdated so we switched to Stripe.' }) + '\n' +
    JSON.stringify({ role: 'assistant', content: 'I will implement Stripe payment processing using stripe.charges.create. We store only server-side tokens for PCI compliance.' })
  )

  return { tDir }
}

// ── Assertions ─────────────────────────────────────────────────────────────────
function assertSemanticContent(claudeMd, label) {
  console.log('\n    CLAUDE.md:')
  console.log(claudeMd.split('\n').map(l => '    │ ' + l).join('\n'))
  console.log()

  // Goal in ## Current direction
  if (!claudeMd.includes('Implement secure payment processing'))
    fail(`${label}: CLAUDE.md missing goal in "## Current direction"`)
  pass(`${label}: goal "Implement secure payment processing" in Current direction`)

  // Both decisions in ## Key decisions
  const decisionSection = claudeMd.split('## Key decisions')[1]?.split('##')[0] ?? ''
  if (!decisionSection.includes('Use Stripe over PayPal'))
    fail(`${label}: decision "Use Stripe over PayPal" missing from ## Key decisions`)
  pass(`${label}: decision "Use Stripe over PayPal" in Key decisions`)

  if (!decisionSection.includes('Store card tokens server-side only'))
    fail(`${label}: decision "Store card tokens server-side only" missing from ## Key decisions`)
  pass(`${label}: decision "Store card tokens server-side only" in Key decisions`)

  // Dead-end in ## Remnant traces
  if (!claudeMd.includes('## Remnant traces'))
    fail(`${label}: CLAUDE.md missing "## Remnant traces" section`)
  pass(`${label}: "## Remnant traces" section present`)

  const remnantSection = claudeMd.split('## Remnant traces')[1]?.split('##')[0] ?? ''
  if (!remnantSection.includes('Braintree integration attempt'))
    fail(`${label}: dead-end "Braintree integration attempt" missing from ## Remnant traces`)
  pass(`${label}: dead-end "Braintree integration attempt" in Remnant traces`)

  // Session 1 in ## Recent session activity
  if (!claudeMd.includes('Session 1'))
    fail(`${label}: CLAUDE.md missing Session 1 in session activity`)
  pass(`${label}: Session 1 recorded in session activity`)
}

// ── Main ───────────────────────────────────────────────────────────────────────
const { server, url: mockUrl } = await startMockServer()
const cleanupDirs = []

try {

  // ── 1. Layer 1 (API) — mock Anthropic endpoint via ANTHROPIC_BASE_URL ─────────
  section('1. Layer 1 (API) — mocked Anthropic extraction')

  const apiDir       = join(tmpdir(), `grasf-mock-api-${Date.now()}`)
  const apiSessionId = `mock-api-${Date.now()}`
  cleanupDirs.push(apiDir)

  const { tDir: apiTDir } = setupProject(apiDir, apiSessionId)
  cleanupDirs.push(apiTDir)
  pass('project initialized, transcript planted')

  const apiClaudeMd = await runStop(apiDir, apiSessionId, {
    GRASF_LAYER:        'api',
    ANTHROPIC_API_KEY:  'sk-ant-mock-key-for-integration-test',
    ANTHROPIC_BASE_URL: mockUrl,
  })
  pass('stop.js completed (Layer 1 with mocked Anthropic endpoint)')

  assertSemanticContent(apiClaudeMd, 'Layer 1')

  if (!apiClaudeMd.includes('Layer: api'))
    fail('Layer 1: CLAUDE.md header missing "Layer: api"')
  pass('Layer 1: CLAUDE.md header shows "Layer: api"')

  // ── 2. Layer 2 (Local) — mock Ollama endpoint via OLLAMA_URL ──────────────────
  section('2. Layer 2 (Local) — mocked Ollama extraction')

  const localDir       = join(tmpdir(), `grasf-mock-local-${Date.now()}`)
  const localSessionId = `mock-local-${Date.now()}`
  cleanupDirs.push(localDir)

  const { tDir: localTDir } = setupProject(localDir, localSessionId)
  cleanupDirs.push(localTDir)
  pass('project initialized, transcript planted')

  const localClaudeMd = await runStop(localDir, localSessionId, {
    GRASF_LAYER:       'local',
    ANTHROPIC_API_KEY: '',
    OLLAMA_URL:        mockUrl,
  })
  pass('stop.js completed (Layer 2 with mocked Ollama endpoint)')

  assertSemanticContent(localClaudeMd, 'Layer 2')

  if (!localClaudeMd.includes('Layer: local'))
    fail('Layer 2: CLAUDE.md header missing "Layer: local"')
  pass('Layer 2: CLAUDE.md header shows "Layer: local"')

  // ── 3. merge.js path normalisation — absolute entity file_path → relative ──────
  // LLMs sometimes return absolute file paths when inferring file locations from
  // the session transcript. mergeExtraction must strip the repoRoot prefix before
  // storing so the graph is consistent with the relative paths from structural extraction.
  section('3. merge.js — absolute entity file_path normalised to relative')

  const normDir       = join(tmpdir(), `grasf-mock-norm-${Date.now()}`)
  const normSessionId = `mock-norm-${Date.now()}`
  cleanupDirs.push(normDir)

  const { tDir: normTDir } = setupProject(normDir, normSessionId)
  cleanupDirs.push(normTDir)
  pass('project initialized, transcript planted')

  // Inject a payload where the entity file_path is absolute (repoRoot + filename).
  // After the fix, the DB should store only the basename ("payments.js").
  activePayload = {
    ...EXTRACTION_PAYLOAD,
    entities: [
      {
        type:      'function',
        name:      'processPayment',
        summary:   'Handles payment via Stripe API',
        file_path: join(normDir, 'payments.js')   // ← absolute path — must be stripped
      }
    ]
  }

  await runStop(normDir, normSessionId, {
    GRASF_LAYER:        'api',
    ANTHROPIC_API_KEY:  'sk-ant-mock-key-for-integration-test',
    ANTHROPIC_BASE_URL: mockUrl,
  })
  activePayload = EXTRACTION_PAYLOAD  // restore default for any subsequent tests

  // Open the DB directly to verify the stored file_path is relative, not absolute.
  const { createRequire } = await import('node:module')
  const requireCJS = createRequire(import.meta.url)
  const BetterSqlite = requireCJS('better-sqlite3')
  const normDb = new BetterSqlite(join(normDir, '.grasf', 'graph.db'), { readonly: true })
  const storedNode = normDb.prepare(
    "SELECT file_path FROM nodes WHERE name = 'processPayment' AND extraction_layer = 'api' LIMIT 1"
  ).get()
  normDb.close()

  if (!storedNode)
    fail('processPayment node not found in DB after merge')
  if (storedNode.file_path !== 'payments.js')
    fail(`absolute path not normalised: stored "${storedNode.file_path}", expected "payments.js"`)
  pass(`absolute file_path stripped to relative: stored "${storedNode.file_path}"`)

} finally {
  server.close()
  section('Cleanup')
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
  }
  pass('test directories cleaned up')
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Mocked semantic extraction — ALL CHECKS PASSED')
console.log('  Layer 1 wiring confirmed: Anthropic SDK → mock endpoint → CLAUDE.md populated')
console.log('  Layer 2 wiring confirmed: Ollama fetch  → mock endpoint → CLAUDE.md populated')
console.log('  Path normalisation confirmed: absolute entity file_path stripped to relative')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
