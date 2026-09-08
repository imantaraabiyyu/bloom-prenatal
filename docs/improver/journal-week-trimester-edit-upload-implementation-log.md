# Implementation Log — Journal week/trimester label + attachment upload during edit

Branch: `main` (per the user's choice; working tree was clean and in sync
with origin at Step 0).

## Part 1 — week/trimester label

- Added `computeGestationalAge`/`trimesterForWeeks` import from
  `lib/pregnancy.js` (unchanged file).
- Added `hpht` state, fetched read-only from `profiles` on load
  ([page.js:129-130](../../app/dashboard/journal/page.js#L129-L130)) — no auto-create of a missing profile row
  (unlike the Dashboard), since a missing/null `hpht` is exactly the
  "hide the label" case the user asked for, nothing to create.
- Added `weekTrimesterLabel(hpht, entryDate)` ([page.js:28-32](../../app/dashboard/journal/page.js#L28-L32)) — returns
  `null` (not a fallback string) whenever `computeGestationalAge` does,
  covering both "no HPHT" and "entry predates HPHT" in one place with no
  new logic of its own.
- Rendered conditionally next to each entry's date
  ([page.js:756,761](../../app/dashboard/journal/page.js#L756-L761)) — nothing renders when the label is `null`.
- New CSS class `.journal-entry-week` (`app/globals.css`), matching
  `.journal-entry-date`'s existing muted styling.

## Part 2 — attachment upload during edit

Followed the approved plan's `target` parameter design exactly:

- New parallel edit-pending state (`editPendingPhotos`/`editPendingVideos`/
  `editPendingVoiceNotes`/`editAttachError`) plus `recordingTarget`
  ([page.js:88-101](../../app/dashboard/journal/page.js#L88-L101)).
- `pendingCount`, `addPendingFiles`, `removePending`, `startRecording`,
  `transcribePendingVoice`, `dismissTranscribePrompt`, `useTidiedNote` all
  gained a `target` parameter ([page.js:189-377](../../app/dashboard/journal/page.js#L189-L377)) — verified via
  `grep` that every call site (all now inside the new
  `renderAttachSection` helper, see below) passes one; no stale
  no-argument call sites remain.
- `pendingCount("edit")` adds the entry's *existing* attachment count
  (looked up via `entries.find((e) => e.id === editingEntryId)`) to the
  edit-pending count before comparing to `MAX_ATTACHMENTS_PER_ENTRY`, so
  the cap is genuinely per-entry, not per add-session.
- `uploadAttachment(entryId, kind, fileOrBlob, fallbackName, mimeType)`
  extracted from `handleSave`'s old inline `uploadOne` ([page.js:384-396](../../app/dashboard/journal/page.js#L384-L396))
  — identical behavior, now reusable. `handleSave` calls it via its own
  small `uploadAndCollect` wrapper (unchanged shape, just delegating the
  actual upload+insert to the shared helper); `saveEditEntry` gained the
  same `uploadAndCollect`-style loop against the *existing* entry's `id`.
- `saveEditEntry` ([page.js:471-519](../../app/dashboard/journal/page.js#L471-L519)): after the entry fields update
  succeeds, uploads any edit-pending attachments, merges the newly
  signed-URL'd rows into that entry's `attachments` array in state, and
  clears the edit-pending state either way. **Deviation from the
  plan's literal wording, decided during implementation**: on a partial
  attachment failure, the edit form is kept open (`editingEntryId` stays
  set) instead of always closing, so the "N lampiran gagal diunggah"
  warning is actually visible — closing it unconditionally (as the date/
  mood/note-only path always did before) would have made `editError`
  invisible the instant it was set, since the edit form's JSX unmounts
  when `editingEntryId` clears.
- `cancelEditEntry`/`startEditEntry` both clear/revoke edit-pending
  attachments via a new shared `clearEditPendingAttachments()` helper
  ([page.js:448-454](../../app/dashboard/journal/page.js#L448-L454)) — `startEditEntry`'s call is defensive (should
  already be empty by the time a new edit starts, given `cancelEditEntry`/
  a successful `saveEditEntry` both clear it).
- **JSX**: rather than writing the composer's ~130-line attach-row/
  pending-preview/transcription block out a second time for the edit
  form (real duplication risk — any future tweak to one copy silently
  drifting from the other), factored it into one `renderAttachSection(target)`
  function ([page.js:551-673](../../app/dashboard/journal/page.js#L551-L673)) called from both the composer
  (`renderAttachSection("compose")`, replacing its old inline block
  1-for-1) and the edit form (`renderAttachSection("edit")`, new). This
  wasn't spelled out as its own plan step, but is a direct, in-scope
  consequence of the plan's own "identical capability in two places"
  framing — not a separate refactor decision.
- Record-button UX: whichever target *isn't* currently recording shows a
  disabled button with a "Sedang merekam di catatan lain" tooltip instead
  of offering a second simultaneous recording (`isRecording`/
  `recordingTarget` are shared, only one `MediaRecorder` exists).

## Regression check on the now-shared compose-mode handlers

Confirmed via `grep` that every existing compose call site (file inputs,
record/stop buttons, pending-item remove buttons, transcribe prompt/
button/retry, "Gunakan sebagai catatan") was updated to pass `"compose"`
explicitly, and none were missed — the composer's own behavior is
unchanged, just routed through the same parameterized functions edit mode
now also uses.

## Tests

No new pure-logic function was introduced beyond what already lives in
`lib/pregnancy.js` (unchanged, just now imported into this file too) —
this is client-component UI/state wiring with Supabase network calls,
matching this repo's documented testing philosophy (network/UI verified
manually). Regression guard:

```
$ npm test
 Test Files  2 passed (2)
      Tests  23 passed (23)

$ npm run build
✓ Compiled successfully
✓ Generating static pages (13/13)
```

Both green, no regressions, no new lint warnings.

## CLAUDE.md (Step 10)

Marker `<!-- beehive:improver-skill-auto-invoke -->` already present —
already enabled, no question asked, no edit made.

## Deferred / follow-ups (not in scope for this run)

- Real manual verification (HPHT set → labels match Dashboard's own
  numbers; HPHT unset → no labels; edit-mode photo/video/record/
  transcribe end-to-end against real Supabase Storage) is left to the
  user, same as prior runs this session — this machine's local
  `.env.local` has no real Supabase credentials to exercise these calls
  against.
- No change to `handleDeleteAttachment`/existing-attachment deletion —
  unrelated to this request, untouched.
