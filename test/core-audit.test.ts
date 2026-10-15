import { test } from "node:test"
import assert from "node:assert/strict"
import {
  appendEventText,
  buildRecommendations,
  computeStats,
  contentId,
  createAuditEvent,
  entryRef,
  parseEvents,
  pruneEvents,
  serializeEvents,
} from "../src/core/audit.ts"

function injectEvent(ts: string, sessionID: string, refs: string[]) {
  return createAuditEvent("inject", ts, { sessionID, refs, chars: 100, hash: "s:deadbeef" })
}

test("events round-trip through JSONL and tolerate corrupt lines", () => {
  const first = injectEvent("2026-10-01T00:00:00.000Z", "s1", ["p:aaaa1111"])
  const second = createAuditEvent("fail", "2026-10-01T00:01:00.000Z", { sessionID: "s1", sig: "bash::npm::notfound" })
  const text = appendEventText(appendEventText(null, first), second)
  assert.equal(text.split("\n").filter(Boolean).length, 2)

  const parsed = parseEvents(text)
  assert.deepEqual(parsed[0], first)
  assert.equal(parsed[1]?.type, "fail")

  const tolerant = parseEvents("garbage\n" + serializeEvents([first]))
  assert.equal(tolerant.length, 1)
  assert.equal(parseEvents(null).length, 0)
})

test("pruneEvents drops events outside the retention window", () => {
  const now = new Date("2026-10-15T00:00:00.000Z")
  const events = [
    injectEvent("2026-10-14T00:00:00.000Z", "s1", []),
    injectEvent("2026-08-01T00:00:00.000Z", "s1", []),
    createAuditEvent("review", "not-a-date", {}),
  ]
  const kept = pruneEvents(events, { retentionDays: 30, now })
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.ts, "2026-10-14T00:00:00.000Z")
})

test("computeStats counts injections, sessions and post-injection reoccurrence", () => {
  const events = [
    injectEvent("2026-10-01T00:00:00.000Z", "s1", ["g:g1", "p:aaaa1111"]),
    createAuditEvent("reoccur", "2026-10-01T00:05:00.000Z", { sessionID: "s2", ref: "g:g1" }),
    createAuditEvent("reoccur", "2026-10-01T00:06:00.000Z", { sessionID: "s2", ref: "g:never-injected" }),
    createAuditEvent("preflight", "2026-10-01T00:07:00.000Z", { sessionID: "s2", blocked: true }),
    createAuditEvent("fail", "2026-10-01T00:08:00.000Z", { sessionID: "s2" }),
    createAuditEvent("resolve", "2026-10-01T00:09:00.000Z", { sessionID: "s2", ref: "g:g1" }),
    createAuditEvent("search", "2026-10-01T00:10:00.000Z", { sessionID: "s2" }),
  ]
  const stats = computeStats(events)
  assert.equal(stats.events, 7)
  assert.equal(stats.sessions, 2)
  assert.equal(stats.injections, 1)
  assert.equal(stats.failures, 1)
  assert.equal(stats.resolves, 1)
  assert.equal(stats.preflights, 1)
  assert.equal(stats.blocked, 1)
  assert.equal(stats.searches, 1)

  const guardrailStat = stats.entries.find((entry) => entry.ref === "g:g1")
  assert.equal(guardrailStat?.injected, 1)
  assert.equal(guardrailStat?.reoccurred, 1)
  assert.ok(!stats.entries.some((entry) => entry.ref === "g:never-injected"))
})

test("recommendations: reoccurrence, effectiveness, unused corpus", () => {
  const events: ReturnType<typeof injectEvent>[] = []
  for (let i = 0; i < 10; i++) {
    events.push(injectEvent(`2026-10-0${(i % 9) + 1}T00:00:00.000Z`, `s${i}`, ["g:g1", "g:g2", "j:zzzz9999"]))
  }
  events.push(createAuditEvent("reoccur", "2026-10-10T00:00:00.000Z", { sessionID: "s0", ref: "g:g1" }))
  events.push(createAuditEvent("reoccur", "2026-10-11T00:00:00.000Z", { sessionID: "s0", ref: "g:g1" }))
  const stats = computeStats(events)

  const recommendations = buildRecommendations(stats, {
    corpus: [
      { ref: "j:zzzz9999", label: "correction" },
      { ref: "j:unused000", label: "correction" },
    ],
  })
  assert.ok(recommendations.some((r) => r.includes("g:g1 reoccurred 2×")))
  assert.ok(recommendations.some((r) => r.includes("g:g2 never reoccurred in 10 injections")))
  assert.ok(recommendations.some((r) => r.includes("j:unused000")))
  assert.ok(!recommendations.some((r) => r.includes("j:zzzz9999")))
})

test("content ids are stable and prefixed", () => {
  assert.equal(contentId("x", "hello"), contentId("x", "hello"))
  assert.notEqual(contentId("x", "hello"), contentId("x", "other"))
  assert.match(entryRef("p", "rule text"), /^p:[0-9a-f]{8}$/)
  assert.match(entryRef("j", "fact text"), /^j:[0-9a-f]{8}$/)
  assert.match(entryRef("l", "lesson"), /^l:[0-9a-f]{8}$/)
})
