# Improvement Plan — Broaden model fallback trigger from 429-only to any GeminiHttpError (SIMPLE)

## Goal
Fix the live bug: `gemini-2.5-pro` returning 404 instead of 429 currently breaks nutrition-chat
outright, since the fallback chain only advances on a 429. Per the user's explicit "fallback
everything" instruction, broaden both fallback-advance conditions (per-model chain, cross-tier
drop) to trigger on any `GeminiHttpError` from the current model, not just a 429 — only re-throw
once the last model in the relevant chain has also failed.

## Current behavior
- [lib/gemini.js:306-318](../../lib/gemini.js#L306-L318) `tryModelChain`: advances only on `e.status === 429`.
- [lib/gemini.js:341-351](../../lib/gemini.js#L341-L351) `fetchGeminiForChat`: same 429-only gate on the cross-tier drop to the low tier.

## Proposed change
- `tryModelChain`: `if (!(e instanceof GeminiHttpError) || isLastModel) throw e;` — drop the `e.status !== 429` check entirely. Update the `console.warn` to include the actual status instead of a hardcoded "429 (quota/rate limit)" message.
- `fetchGeminiForChat`: same — `if (!(e instanceof GeminiHttpError)) throw e;` before trying the low tier.
- Add a code comment on `tryModelChain` documenting the operational tradeoff for the low-tier cron path (see assessment) and that a raw non-HTTP exception still isn't caught here (unrelated, pre-existing boundary).
- `README.md`: one-line note under the existing fallback-chain explanation that a model returning 404 (retired/unavailable) also triggers fallback now, not just 429.

## Scope
- `lib/gemini.js` — `tryModelChain`, `fetchGeminiForChat` advance conditions + comments.
- `lib/gemini.test.js` — update 2 existing tests to the new behavior, add a 404-specific regression test (the exact reported bug) for both the low-tier chain and the chat-tier cross-tier drop.
- `README.md` — one-line clarification.

## Steps
1. Edit `tryModelChain`'s catch condition + `console.warn` message.
2. Edit `fetchGeminiForChat`'s catch condition + `console.warn` message.
3. Add the operational-tradeoff comment.
4. Update `README.md`'s fallback explanation.
5. Update `lib/gemini.test.js`: rename/rewrite the two "does not fall back on non-429" tests into "falls back on any error status, including 404" tests; keep one still asserting the *last* model's error is what ultimately propagates when every model fails.

## Test plan
- **Low tier** (`generateDailyNudge`): primary model 404s → falls back to next model → succeeds. Whole chain fails with mixed statuses (404, then 500-exhausted, then 429) → still exhausts every model in order, propagating the *last* model's error.
- **Chat tier** (`streamNutritionChatTurn`): primary model 404s (the exact reported bug) → falls back within the chat tier → succeeds, reply carries the model caption for whichever model served it (no `GEMINI_LOWER_TIER_NOTICE`, since it stayed within the chat tier).
- **Cross-tier**: whole chat tier fails with non-429 statuses (e.g. two 404s) → still drops to the low tier → reply carries both the notice and the caption, same as the already-shipped 429 case.
- Regression guard: a genuinely last-model failure still propagates with the correct status (not swallowed/masked by the broadened condition).

## Triage
SIMPLE — 2 files (`lib/gemini.js`, `lib/gemini.test.js`) + a 1-line README note, no schema/KDOCS
impact, no open ambiguity (explicit "fallback everything" instruction + the code fully determines
the change), blast radius contained to the fallback-advance condition already covered by tests.
