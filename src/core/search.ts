/**
 * Dependency-free keyword recall (BM25-lite), ported from pi-memory.
 *
 * Pure: callers assemble the document list from the stores. No LLM, no
 * dependencies, deterministic scoring — safe to run in the model-call path.
 */

export interface SearchDoc {
  name: string
  text: string
  meta?: Record<string, unknown>
}

export interface SearchHit {
  name: string
  snippet: string
  score: number
  meta?: Record<string, unknown>
}

const SNIPPET_CHARS = 160

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 1)
}

export function searchDocs(docs: SearchDoc[], query: string, limit = 5): SearchHit[] {
  const queryTerms = tokenize(query)
  if (docs.length === 0 || queryTerms.length === 0 || limit <= 0) return []

  const total = docs.length
  const docFreq = new Map<string, number>()
  const termLists = docs.map((doc) => {
    const terms = tokenize(doc.text)
    for (const term of new Set(terms)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    return terms
  })

  const scored = docs.map((doc, i) => {
    const terms = termLists[i] ?? []
    const termFrequency = new Map<string, number>()
    for (const term of terms) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1)
    let score = 0
    for (const queryTerm of queryTerms) {
      const frequency = docFreq.get(queryTerm) ?? 0
      const inverseDocFrequency = Math.log(1 + total / (frequency + 1))
      score += (termFrequency.get(queryTerm) ?? 0) * inverseDocFrequency
    }
    return { doc, score }
  })

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
    .slice(0, limit)
    .map(({ doc, score }) => ({
      name: doc.name,
      snippet: snippetAround(doc.text, queryTerms),
      score,
      ...(doc.meta ? { meta: doc.meta } : {}),
    }))
}

function snippetAround(text: string, queryTerms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= SNIPPET_CHARS) return flat
  const lower = flat.toLowerCase()
  let index = -1
  for (const term of queryTerms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (index === -1 || found < index)) index = found
  }
  if (index === -1) return `${flat.slice(0, SNIPPET_CHARS - 1)}…`
  const start = Math.max(0, index - 40)
  const end = Math.min(flat.length, start + SNIPPET_CHARS)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}
