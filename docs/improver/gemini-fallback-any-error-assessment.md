# Assessment — Broaden model fallback trigger from 429-only to any GeminiHttpError

## Reported problem
Live production error, right after the two-tier model-fallback feature shipped
([[gemini-model-fallback]]): the chat tier's primary model `gemini-2.5-pro` now returns **404
NOT_FOUND** ("This model models/gemini-2.5-pro is no longer available to new users"), not a 429.
Since the fallback chain only advances to the next model on a 429, every nutrition-chat request
fails outright — the configured fallback models (`GEMINI_CHAT_FALLBACK_MODELS`) are never even
tried. User's explicit instruction: "fallback everything."

## Current behavior
- [lib/gemini.js:306-318](../../lib/gemini.js#L306-L318) `tryModelChain`: `if (!(e instanceof GeminiHttpError) || e.status !== 429 || isLastModel) throw e;` — only a 429 advances to the next model in the chain; any other `GeminiHttpError` status (404, 400, 403, or an already-retry-exhausted 500/502/503/504/"timeout") propagates immediately.
- [lib/gemini.js:341-351](../../lib/gemini.js#L341-L351) `fetchGeminiForChat`: same `e.status !== 429` gate on the cross-tier drop from the chat tier to the low tier.
- Both were a deliberate design choice from the prior run (comment: "falling back only ever helps a rate-limit/quota problem") — this run explicitly supersedes that, per the user's new evidence (404 is just as "this model is unusable" as 429) and explicit instruction.
- Existing tests assert the *opposite* of the new desired behavior and need updating: `lib/gemini.test.js`'s "does not fall back to the next low-tier model on a non-429 failure" and "does not fall through to the low tier on a non-429 chat-tier failure".
- A raw network exception (not an HTTP response — DNS failure, connection refused) is **not** wrapped in `GeminiHttpError` by `fetchGeminiWithRetries` ([lib/gemini.js:249-256](../../lib/gemini.js#L249-L256): a non-`AbortError` exception is re-thrown as-is on the first attempt) — so `tryModelChain`'s `!(e instanceof GeminiHttpError)` check already excludes those from fallback, regardless of how the 429-specific condition is broadened. This is an existing, unrelated safety boundary, not something this fix touches.

## Files/functions in scope
- [lib/gemini.js](../../lib/gemini.js) — `tryModelChain` (per-model advance condition), `fetchGeminiForChat` (cross-tier advance condition).
- [lib/gemini.test.js](../../lib/gemini.test.js) — update the two tests above to match the new behavior, add a 404-specific regression test for the exact reported bug.

## Operational tradeoff (flagged per the user's own request, not blocking)
`generateDailyNudge`/`generateMealFact` (low tier) run inside `app/api/cron/reminders/route.js`'s
60s-budget batch job with `CRON_GEMINI_TIMEOUT_MS = 8000`. Before this fix, a 500/502/503/504 that
survives all 3 of its own retries already costs ~26s worst case for *one* model, then fails
outright. After this fix, that same exhausted failure will *also* advance to the next model in
`GEMINI_FALLBACK_MODELS`, multiplying that ~26s by the chain length (e.g. 3 models ≈ 78s), which
can exceed the route's own 60s ceiling. Flagged as a code comment + README note rather than a
blocker — the user's instruction was explicit, this is a personal project, and the existing
per-user `catch { ...fallback... }` in the cron route already degrades gracefully on any failure
regardless of how long a Gemini call took to eventually fail.

## Ambiguity check
None material: "fallback everything" is an unambiguous instruction to broaden the trigger from
"429 only" to "any GeminiHttpError, from either tryModelChain or the cross-tier drop". The only
judgment call (whether to also broaden the raw-exception case) resolves itself — that path already
never reaches `GeminiHttpError`, so there's nothing to broaden there; noted above, not a decision
this fix needs to make.

Triage: SIMPLE — 2 files (`lib/gemini.js`, `lib/gemini.test.js`), no schema/KDOCS impact, no open
ambiguity (explicit instruction + code fully determines the change), blast radius contained to the
fallback-advance condition already covered by existing tests being updated.
