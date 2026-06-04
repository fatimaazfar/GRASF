// Pure string parser for grasf:* annotations embedded in prompt text.
// No LLM, no network, no side effects — always safe to call.
//
// Supported annotations (spec: Annotation System):
//   grasf:goal <text>      → type: 'goal'
//   grasf:decision <text>  → type: 'decision'
//   grasf:note <text>      → type: 'note'
//   grasf:dead-end <text>  → type: 'dead_end'
//
// Returns array of { type, text } objects.
// Multiple annotations in one prompt are supported.

const ANNOTATION_RE = /grasf:(goal|decision|note|dead-end)\s+(.+?)(?=\s*grasf:|$)/gs

export function parseAnnotations(promptText) {
  if (!promptText) return []
  const results = []
  for (const match of promptText.matchAll(ANNOTATION_RE)) {
    results.push({
      type: match[1] === 'dead-end' ? 'dead_end' : match[1],
      text: match[2].trim()
    })
  }
  return results
}
