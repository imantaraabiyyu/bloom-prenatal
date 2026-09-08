# Implementation Log — Chat: analisa label vitamin/kemasan + "Simpan sebagai vitamin ke Dashboard"

Branch: `main` (user chose "Pakai branch main langsung" at Step 0).

## Step 1 — `lib/gemini.js`: 3-way classification + prompt + sanitizer

Files: `lib/gemini.js`.

- `buildResponseSchema()` replaced the `is_log: BOOLEAN` field with
  `category: STRING` (enum `food`/`vitamin`/`chat`) and added `vitamins:
  ARRAY<OBJECT>` (via new `buildVitaminItemSchema()`), each item
  `{name, ...NUTRIENT_ORDER, extra_nutrients: ARRAY<{label,unit,value}>}`.
- `SYSTEM_PROMPT` rewritten into the 3 branches from the plan (food —
  including "read label numbers directly" instruction for packaged
  food/drink Nutrition Facts photos; vitamin — multi-item, 0 for unknown
  nutrient values, never invented; chat — unchanged).
- Extracted `sanitizeChatTurnResult(parsed)` (exported) + helper
  `sanitizeVitaminItem(item)` — replaces the old inline sanitization block in
  `streamNutritionChatTurn`; downgrades `food` with no `meal` and `vitamin`
  with zero valid items to `chat`, caps `vitamins` at 10 items and
  `extra_nutrients` at 20 per item, keeps the existing `reply` 800-char cap.
- `streamNutritionChatTurn` now calls `sanitizeChatTurnResult(parsed)` instead
  of the inline block; the SSE/`extractPartialStringValue("reply")` streaming
  loop was not touched.

Commit: `5deb25d` (bundled with Step 2, see below — both were ready and
verified together before the first commit of this run).

## Step 2 — `lib/nutrition.js` + `app/dashboard/page.js`: shared row helpers

Files: `lib/nutrition.js`, `app/dashboard/page.js`.

- Added `buildExtraNutrientsMap(rows)` (pulled out of `handleAddVitamin`'s
  inline loop, identical behavior/comment) and `vitaminItemToRow(item,
  userId)`.
- `app/dashboard/page.js`: `handleAddVitamin` now calls
  `buildExtraNutrientsMap(vitFormExtra)` instead of inlining the conversion;
  removed the now-unused `slugifyNutrientLabel` import (confirmed via grep
  it had no other call site in this file), added `buildExtraNutrientsMap` to
  the import list.

Commit: `5deb25d` — "Add 3-way food/vitamin/chat classification to Gemini
chat + shared vitamin-row helpers".

## Step 3 — `app/dashboard/chat/page.js`: chat UI, save/undo per vitamin item

Files: `app/dashboard/chat/page.js`.

- Added `formatVitaminAnalysisText(result)` alongside the existing
  `formatAnalysisText`.
- `toHistoryEntry` branches on `m.analysis?.category === "vitamin"`; falls
  through to the existing `formatAnalysisText` path otherwise (covers both
  fresh "food" turns and old pre-feature `chat_messages.analysis` rows, which
  have no `category` field at all).
- `handleSend`'s analysis-save condition extended to
  `category==="food" && meal` (equivalent to the old `is_log`) OR
  `category==="vitamin" && vitamins.length > 0`.
- Added `updateVitaminItemLocal`, `saveVitaminItemToDashboard`,
  `undoSavedVitaminItem` — per-item save/undo, saved-state persisted by
  writing the whole updated `analysis` jsonb object back to `chat_messages`
  (no schema change — see plan's "Data / schema impact: none").
  Saving/error state keyed by array index on the message object so multiple
  buttons in one reply don't interfere.
- Render block: `m.analysis?.category === "vitamin"` renders
  `formatVitaminAnalysisText` + one save/undo control per `vitamins[i]`; the
  existing food/legacy branch is unchanged (moved into the `else` of the new
  conditional, not rewritten).
- Copy: `bloom-sub` and the disclaimer paragraph updated to mention the new
  vitamin/label-reading capability.

Commit: `aa5d224` — "Add vitamin-label chat analysis: per-item Simpan/Hapus
ke Dashboard".

No changes were needed in `app/api/nutrition-chat/route.js` or
`supabase/schema.sql`, as planned (route is a pure passthrough; no new DB
column).

## Step 4 — Tests

Files: `lib/nutrition.test.js` (appended), `lib/gemini.test.js` (new).

- `lib/nutrition.test.js`: added `buildExtraNutrientsMap` (complete row →
  correct slug map; incomplete rows silently dropped, not zeroed; accepts
  both a raw form-string value and an already-numeric Gemini value; missing
  unit defaults to `""`; same-slug labels collapse to the last row; empty/
  undefined input → `{}`) and `vitaminItemToRow` (DB-ready row with
  `user_id`; `NUTRIENT_ORDER` fields coerced via `Number(...)||0`; name
  fallback to `"Vitamin"`; `extra_nutrients` converted through
  `buildExtraNutrientsMap`).
- `lib/gemini.test.js` (new): tests for `sanitizeChatTurnResult` — food happy
  path; food with empty meal downgrades to chat; vitamin happy path with 2
  items + `extra_nutrients`; item with no name dropped; all-invalid vitamins
  array downgrades to chat; 10-item / 20-entry caps enforced; unknown/missing
  `category` defaults to chat; `reply` capped at 800 chars in every branch;
  non-numeric/negative nutrient values coerced to 0.

### Unexpected wrinkle: `server-only` blocks a bare Vitest import

`lib/gemini.js` starts with `import "server-only"`. That package's `default`
export condition (`index.js`) throws unconditionally
(`"This module cannot be imported from a Client Component module..."`); only
Next.js's own `react-server` bundling condition resolves it to a no-op
(`empty.js`) instead. Vitest runs under plain Node, so it hit the throwing
branch and `lib/gemini.test.js` failed to even load, 0 tests collected — this
is exactly *why* this repo had no `gemini.test.js` before this feature (the
file's other exports also all require live Gemini network calls, so nothing
here contradicts that prior state, it's just now visible directly).

Fixed by stubbing the package in the test file only —
`vi.mock("server-only", () => ({}))` before importing `@/lib/gemini` (the
standard workaround for unit-testing a `server-only`-marked module's
network-free exports) — no source file changed for this. Re-ran after the
fix; all tests passed.

### Real test output (`npx vitest run`)

```
 RUN  v4.1.11 /Users/abiyyu.imantara/projects/personal/bloom-prenatal


 Test Files  3 passed (3)
      Tests  43 passed (43)
   Start at  23:25:30
   Duration  452ms (transform 223ms, setup 0ms, import 301ms, tests 85ms, environment 0ms)
```

(3 files = `lib/reminderLogic.test.js` (pre-existing, untouched),
`lib/nutrition.test.js`, `lib/gemini.test.js`.)

## Step 10 — CLAUDE.md

`CLAUDE.md` already carries the `<!-- beehive:improver-skill-auto-invoke -->`
marker from a prior run — skipped the opt-in question per the skill's Step
10.1, no change made here.

## Deferred / follow-ups

- **Live Gemini API smoke test** — the new 3-way schema/prompt (especially
  the nested `vitamins[].extra_nutrients[]` array) has not been exercised
  against the real Gemini API in this session (no live network/API key call
  in this repo's test suite, consistent with `lib/gemini.js`'s pre-existing
  coverage boundary — see the improvement plan's "Out of scope"). Recommend
  trying a few real photos (a vitamin bottle, a doctor's note with 2+
  products, a packaged snack's Nutrition Facts panel) after deploy.
- Concurrent, unrelated work landed on `main` mid-session from another
  session (a "help popover" feature: `components/HelpTip.js`,
  `app/globals.css`, and further edits to `app/dashboard/page.js` /
  `app/dashboard/profile/page.js` beyond this run's scope) — left untouched
  and excluded from every commit in this run.
