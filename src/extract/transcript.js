// spec: src/extract/transcript.js — Parse Claude Code JSONL session transcripts.
//
// Claude Code writes JSONL to: ~/.claude/projects/<base64url-of-cwd>/<session-id>.jsonl
// Each line is a JSON object. Messages may nest content under a 'message' key (older format)
// or carry 'role'/'content' at top level (newer format).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

// Returns path to most recently modified .jsonl file for the given cwd, or null.
export function findLatestTranscript(cwd) {
  try {
    const encoded = Buffer.from(cwd).toString('base64url')
    const dir = join(homedir(), '.claude', 'projects', encoded)
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    return files
      .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].path
  } catch {
    return null
  }
}

// Parses a JSONL file into { messages: [{role, content, timestamp}], sessionId }.
export function parseTranscript(filePath) {
  const sessionId = basename(filePath, '.jsonl')
  const raw = readFileSync(filePath, 'utf8')
  const messages = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      // Support both flat format {role, content} and nested {message: {role, content}}
      const role    = obj.role    ?? obj.message?.role
      const content = obj.content ?? obj.message?.content
      const timestamp = obj.timestamp ?? null
      if (role && content !== undefined) {
        messages.push({ role, content, timestamp })
      }
    } catch {
      // skip malformed lines per error rule 5
    }
  }

  return { messages, sessionId }
}

// Flattens Claude content (string or content-block array) to plain text.
export function extractTextContent(message) {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text || '')
      .join('\n')
  }
  return ''
}
