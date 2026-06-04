// spec: src/extract/llm.js — Unified semantic extraction for Layer 1 (API) and Layer 2 (Local).
//
// Both extractViaAnthropic and extractViaOllama use the IDENTICAL prompt built by
// buildExtractionPrompt(). The only difference is the HTTP client used.
// Transcript is truncated to 8000 tokens (≈ 32 000 chars) before sending.

import Anthropic from '@anthropic-ai/sdk'
import { generate } from './ollama.js'

const EXTRACTION_SYSTEM = `You are a knowledge extraction engine for software projects.
Extract structured technical knowledge from AI coding session transcripts.
Be precise, concise, and technically accurate.
Return ONLY valid JSON. No markdown fences. No explanation. No preamble.`

// Exported so tests can verify both paths use the same prompt construction.
export function buildExtractionPrompt(transcript, existingNodeSummaries) {
  const MAX_CHARS = 32000 // ≈ 8000 tokens
  const transcriptText = transcript
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')
    .slice(0, MAX_CHARS)

  return `Extract knowledge from this coding session transcript.

EXISTING PROJECT CONTEXT (already known — do not re-extract these):
${existingNodeSummaries || '(none)'}

SESSION TRANSCRIPT:
${transcriptText}

Return JSON with this exact structure:
{
  "entities": [
    { "type": "function|module|pattern|api|type|config", "name": "", "summary": "", "file_path": "" }
  ],
  "decisions": [
    { "name": "", "summary": "", "rationale": "" }
  ],
  "dead_ends": [
    { "name": "", "summary": "", "reason_abandoned": "" }
  ],
  "goal": "",
  "outcome": "",
  "next_step": "",
  "relationships": [
    { "from": "entity_name", "to": "entity_name", "rel": "depends_on|replaces|contradicts|derives_from|blocks" }
  ]
}

Rules:
- Only extract NEW information not already in existing context
- Dead ends are approaches TRIED and ABANDONED this session
- Decisions are explicit choices about architecture, approach, or tooling
- Keep all summaries under 30 words
- Return empty arrays for categories with nothing new
- goal, outcome, next_step are required — use null only if transcript is empty`
}

function parseResponse(text) {
  if (!text) return null
  try {
    const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    return JSON.parse(clean)
  } catch {
    return null
  }
}

async function extractViaAnthropic(layerInfo, transcript, existingNodeSummaries) {
  const client = new Anthropic()
  const prompt = buildExtractionPrompt(transcript, existingNodeSummaries)
  const msg = await client.messages.create({
    model: layerInfo.model,
    max_tokens: 2048,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  })
  const text = msg.content[0]?.type === 'text' ? msg.content[0].text : null
  return parseResponse(text)
}

async function extractViaOllama(layerInfo, transcript, existingNodeSummaries) {
  const prompt = buildExtractionPrompt(transcript, existingNodeSummaries)
  const fullPrompt = `${EXTRACTION_SYSTEM}\n\n${prompt}`
  const text = await generate(layerInfo.ollamaUrl, layerInfo.model, fullPrompt)
  return parseResponse(text)
}

export async function extractSemantic(layerInfo, transcript, existingNodeSummaries) {
  if (layerInfo.layer === 'api')   return extractViaAnthropic(layerInfo, transcript, existingNodeSummaries)
  if (layerInfo.layer === 'local') return extractViaOllama(layerInfo, transcript, existingNodeSummaries)
  return null
}
