// spec: src/extract/ollama.js — Ollama HTTP client using Node.js built-in fetch
// No extra HTTP dependency — fetch is available in Node.js 20+.

// Returns { running: bool, models: string[] }
export async function checkOllama(url = 'http://localhost:11434') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { running: false, models: [] }
    const data = await res.json()
    const models = (data.models || []).map(m => (typeof m === 'string' ? m : m.name))
    return { running: true, models }
  } catch {
    clearTimeout(timer)
    return { running: false, models: [] }
  }
}

// Returns text response string, or null on timeout / error.
export async function generate(url, model, prompt, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    return data.response || null
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      console.warn('[GRAASF] Ollama generate timed out — falling back to structural')
    }
    return null
  }
}
