# Assessment — Chat label/vitamin analysis + "Simpan vitamin ke Dashboard"

## Request (verbatim)

1. Pada fitur chat (Gemini), tambahkan kemampuan menganalisa komposisi dari foto label —
   mis. label vitamin dari resep dokter, atau label komposisi nutrisi pada kemasan
   minuman/makanan.
2. Tambahkan fitur "tambah vitamin" di dashboard, dengan pola/flow yang sama seperti fitur
   "tambah makanan" yang sudah ada sekarang.

## Current behavior

### Chat + Gemini photo analysis (request #1's starting point)

- [app/dashboard/chat/page.js](../../app/dashboard/chat/page.js) lets a user attach ONE photo
  per turn (camera/gallery/paste/drag), resizes it client-side
  (`resizeImageForChat`, chat/page.js:13-35), and POSTs it + optional text +
  last-12-turns history to `/api/nutrition-chat`.
- [app/api/nutrition-chat/route.js](../../app/api/nutrition-chat/route.js) is a thin
  auth-gated proxy — validates size/length, streams the turn via
  `streamNutritionChatTurn` (lib/gemini.js), never touches the DB itself.
- [lib/gemini.js:22-61](../../lib/gemini.js#L22) — `buildResponseSchema` +
  `SYSTEM_PROMPT` currently force a **binary** classification per turn:
  - `is_log = true` → the photo/text is treated as **a meal being eaten right now**:
    `meal` (name) + all of `NUTRIENT_ORDER` (calories, protein_g, iron_mg, calcium_mg,
    folate_mcg, vitamin_d_mcg, fiber_g, water_ml, dha_mg, vitamin_k_mcg) are filled by
    Gemini's own estimate "based on common portions", explicitly told **not** to invent
    extreme numbers.
  - `is_log = false` → ordinary chat, all nutrient fields 0, `meal` empty.
  - There is **no instruction anywhere** telling Gemini to read printed numbers off a
    label when one is visible, and **no path at all** for "this photo is a
    vitamin/supplement label or a doctor's prescription list", nor for "this is a
    packaged food/drink's own Nutrition Facts panel". Today, photographing a vitamin
    bottle would still be forced through the `is_log=true` "meal" branch — Gemini would
    likely *invent* a meal name/nutrients for something that isn't food being eaten, and
    the UI would offer "Simpan ke Dashboard" wired to insert into `meals`
    (chat/page.js:257-268), which is semantically wrong for a vitamin.
- Result rendering + save action: chat/page.js:337-352 — `m.analysis` (the sanitized
  Gemini result) is rendered via `formatAnalysisText`, and if
  `!m.savedMealId && !m.undone` a **"Simpan ke Dashboard"** button appears
  (`saveAnalysisToMeals`, chat/page.js:257-268) that inserts one row into
  `public.meals` and stores `saved_meal_id` back onto the `chat_messages` row so a
  reload/undo can find it (`undoSavedMeal`, chat/page.js:270-274).
- Persistence: `chat_messages` (supabase/schema.sql:139-149) stores `role`, `text`,
  `had_image` (bool, photo itself is **never** stored/persisted — by design, per the
  in-app disclaimer), `analysis` (jsonb — whatever `streamNutritionChatTurn` returned),
  and `saved_meal_id` (nullable FK → `meals`, `on delete set null`). **There is no
  equivalent `saved_vitamin_id` column** — nothing links a chat turn to a row it
  created in `public.vitamins`.

### "Tambah makanan" / "tambah vitamin manual" — dashboard (request #2's reference point)

This already exists in full, and **already mirrors the meal-add pattern exactly** for
vitamins too — both live in [app/dashboard/page.js](../../app/dashboard/page.js):

| | Meal ("tambah menu manual") | Vitamin ("tambah vitamin manual") |
|---|---|---|
| Toggle button | page.js:530-532 | page.js:584-586 |
| Form state | `mealFormOpen/Name/Date/Values` (page.js:52-57) | `vitFormOpen/Name/Values/Extra` (page.js:60-65) |
| Nutrient grid | page.js:542-556, over `NUTRIENT_ORDER` | page.js:595-609, same `NUTRIENT_ORDER` |
| Extra field | — (meals have no free-form extras) | "Nutrisi lain" rows → `extra_nutrients` jsonb (page.js:611-635, `slugifyNutrientLabel`/`mergeExtraNutrients` in lib/nutrition.js:150-166) |
| Save handler | `handleAddMeal` (page.js:284-301) → insert into `meals` | `handleAddVitamin` (page.js:352-377) → insert into `vitamins` |
| Delete | `handleDeleteMeal` + `ConfirmButton` (page.js:303-306) | `removeVitamin` + `ConfirmButton` (page.js:390-401) |

So a **manual** "tambah vitamin" form with the same UX pattern as "tambah menu manual"
is not a gap — it's already shipped, field-for-field, on `main` right now.

Given request #1 explicitly calls out "label vitamin dari dokter" (a photo, not a manual
form fill-in) and request #2 asks for parity with the **existing food flow**, the much
more likely intent — read together — is the **chat photo flow**: today a food photo in
chat gets analyzed and offers "Simpan ke Dashboard" → `meals`; a **vitamin/supplement
label photo** in chat should get the analogous treatment → "Simpan ke Dashboard" →
`vitamins`. That combined flow does not exist yet. This assessment treats requests #1
and #2 as one connected feature and raises this reading as the first clarifying
question, rather than assuming it silently.

## Files / areas in scope (subject to clarifying answers)

- `lib/gemini.js` — `buildResponseSchema`, `SYSTEM_PROMPT`, `streamNutritionChatTurn` (classification + schema need a third branch for "vitamin/supplement label", and the prompt should say to read printed numbers off a label when one is visible rather than only estimating from a plate of food).
- `app/api/nutrition-chat/route.js` — passthrough only; likely unaffected beyond whatever new field shape flows through it.
- `app/dashboard/chat/page.js` — `formatAnalysisText`, `toHistoryEntry`, the save-button block (chat/page.js:337-352), a new `saveAnalysisToVitamins` handler mirroring `saveAnalysisToMeals` (chat/page.js:257-268), `undoSavedMeal` counterpart.
- `supabase/schema.sql` — likely a new nullable `saved_vitamin_id uuid references public.vitamins(id) on delete set null` column on `chat_messages`, mirroring `saved_meal_id` (schema.sql:139-149). Postgres (Supabase) confirmed as the dialect from this file.
- `lib/nutrition.js` — no change expected (reuses `NUTRIENT_ORDER`, `slugifyNutrientLabel`, `mergeExtraNutrients` already built for the manual vitamin form).
- `app/dashboard/page.js` — the manual "tambah vitamin" form already exists; no change expected there for request #2's literal ask, pending the clarifying question below.

## Ambiguities the description does not resolve

1. **What does request #2 actually add**, given the manual "tambah vitamin" form already
   exists and already mirrors "tambah menu manual" field-for-field? (chat-flow parity vs.
   "already satisfied" vs. something else entirely.)
2. **How should the analysis classify a photo** — keep it binary (`is_log`) with vitamin
   handling bolted on some other way, or move to a 3-way classification
   (food / vitamin / chat) so a packaged drink/food's own printed Nutrition Facts panel
   can also be read more accurately under the existing "food" path, while a
   vitamin/supplement label or doctor's prescription gets its own new path into
   `vitamins`?
3. **Multiple items in one photo** — a doctor's prescription note or a shelf of
   supplements could show more than one vitamin/product in a single frame. Should Gemini
   return one item per turn only (ask the user to send one photo per item, or clarify
   over chat which one), or a list Gemini can extract several items from in one photo?

## Triage

Triage: **COMPLEX** — fails multiple SIMPLE criteria: (a) touches more than 3
files/areas (lib/gemini.js schema+prompt, chat page.js UI+handlers, nutrition-chat route
passthrough shape, supabase/schema.sql), (b) schema/data impact (new nullable column on
`chat_messages` to mirror `saved_meal_id` for vitamins), (c) open ambiguity on all three
points above that the description does not resolve. Proceeding to clarifying questions.
