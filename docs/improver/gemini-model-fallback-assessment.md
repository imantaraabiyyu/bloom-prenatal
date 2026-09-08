# Assessment — Fall back to a different Gemini model on 429 (quota exceeded)

## Requested improvement
When a request to the configured Gemini model hits a 429 (rate-limit/quota-exceeded), retry the same
request against a different model instead of just failing — across all 4 Gemini call sites in
`lib/gemini.js`. Builds on the just-landed [[gemini-429-quota-handling]] work, which made 429
non-retryable *on the same model* (retrying the exhausted model can't succeed); this is about trying a
*different* model's separate quota bucket instead of giving up.

## Current behavior

### Model selection — read independently at each of the 4 call sites, no shared config
- [lib/gemini.js:335](../../lib/gemini.js#L335) `streamNutritionChatTurn`: `const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";`
- [lib/gemini.js:423](../../lib/gemini.js#L423) `streamTranscribeVoiceNote`: same line.
- [lib/gemini.js:522](../../lib/gemini.js#L522) `generateDailyNudge`: same line.
- [lib/gemini.js:574](../../lib/gemini.js#L574) `generateMealFact`: same line.
- Each then builds a single URL (`.../v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}` for the two streaming calls, `.../v1beta/models/${model}:generateContent?key=${apiKey}` for the two non-streaming ones) and calls `fetchGeminiWithRetries` exactly once with it — there is currently no concept of a second model to fall back to anywhere in this file.
- [README.md:68-71](../../README.md#L68-L71) documents `GEMINI_MODEL` as the only model-related env var (optional, defaults to `gemini-3.6-flash`, reason given: "Google kadang mem-pensiunkan model lama").

### Retry layer — [lib/gemini.js:217-265](../../lib/gemini.js#L217-L265) `fetchGeminiWithRetries`
- Retries 500/502/503/504 up to 3 attempts with backoff; 429 throws immediately (no retry) as of the prior improvement run — this is per-model, single-URL only. It has no knowledge of alternate models; adding fallback means either wrapping it in a new outer loop over candidate models, or extending it to accept a list of URLs to try in order.
- For the 2 streaming call sites (`requireBody: true`), the function only returns once `res.ok` — a 429 is caught and thrown *before* `res.body` is ever read, so no partial stream/onDelta data can have been emitted yet when a 429 happens. A fallback attempt against a second model is safe to start from scratch (no partial-response cleanup needed).

## Files/functions in scope
- [lib/gemini.js](../../lib/gemini.js) — model selection at all 4 call sites, `fetchGeminiWithRetries` (or a new wrapper around it) to add the fallback-to-another-model loop.
- [README.md](../../README.md) — env var documentation section (already documents `GEMINI_MODEL`; a new fallback-related env var needs the same treatment).

## Open ambiguities (the description doesn't resolve these)
1. **Config shape**: one fallback model (`GEMINI_FALLBACK_MODEL=<name>`) or an ordered list of several (`GEMINI_FALLBACK_MODELS=<name1>,<name2>,...`) tried in order until one doesn't 429? The request says "fallback into another **models**" (plural), which reads as wanting more than one candidate.
2. **Default when unset**: no code-side default fallback model exists to guess (model availability/naming is tied to the user's own Google Cloud project/API key) — should fallback simply be a no-op (today's fail-fast behavior, unchanged) when the new env var isn't set, with the user opting in explicitly?
3. **Retry behavior per fallback model**: does each fallback model go through the *same* retry policy as the primary (still retry its own 500/502/503/504, still fail-fast+move-on on its own 429), or should fallback attempts skip retries entirely and just try each model once?
4. **Visibility**: should a successful fallback (or reaching total exhaustion across every model) be logged distinctly (e.g. `console.warn` noting which model actually served the request), so this is diagnosable from Vercel logs the way the reported 429 was?

Triage: COMPLEX — genuine open ambiguity on config shape, default, per-model retry behavior, and logging survives the assessment (fails the "no open ambiguity" SIMPLE criterion); routing through clarifying questions.

## Addendum — two-tier model selection (added mid-session, before plan approval)

While the first round of clarifying questions was being answered, the user raised a second,
related requirement: nutrition-chat and journal transcribe (the two interactive, user-facing
features) should always use the *best* available model; the two cron background calls (daily
nudge, meal fact — text-only, no user watching) should use the *lowest*/cheapest model. This
reshapes the fallback design from "one shared model + fallback chain for all 4 call sites" into
"two independent tiers, each with its own primary + fallback chain", plus a cross-tier last
resort (chat tier exhausted → try the low tier too) with a user-visible caveat when that
cross-tier fallback actually gets used. Superseding round of clarifying questions + their answers
is folded directly into `gemini-model-fallback-improvement-plan.md` rather than duplicated here.

Model IDs for each tier were looked up live (WebFetch against `ai.google.dev/gemini-api/docs/*`,
Sept 2026) rather than guessed, per the user's preference — see the improvement plan's "Proposed
change" section for the sources and final picks (`gemini-2.5-pro` confirmed GA + multimodal +
structured-output capable for the best tier; `gemini-3.5-flash-lite` for the low tier, text-only
use only so multimodal support wasn't a requirement to verify).
