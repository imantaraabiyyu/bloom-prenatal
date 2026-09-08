# Improvement Plan — Journal week/trimester label + attachment upload during edit

## Goal

Show which gestational week + trimester each journal entry falls in
(history list), and let editing an existing entry add new attachments
(photo/video/record voice note + optional transcription) — the same
capability the new-entry composer already has, per the user's explicit
"sama seperti saat membuat jurnal awal" ask.

## Current behavior

`app/dashboard/journal/page.js` fetches only `journal_entries` +
`journal_attachments` ([page.js:91-102](../../app/dashboard/journal/page.js#L91-L102)) — never `profiles.hpht`.
`lib/pregnancy.js`'s `computeGestationalAge(hpht, dateIso)` (returns
`null` for missing HPHT or a pre-HPHT date) and `trimesterForWeeks(weeks)`
are already used this same way by `app/dashboard/page.js` (fetches
`profiles.hpht` at page.js:82, labels t1/t2/t3 as "Trimester N" at
page.js:482).

The composer already has a full pending-attachment pipeline: pick
(`addPendingFiles`, page.js:145-169), record (`startRecording`/
`stopRecording`, page.js:181-224), transcribe (`transcribePendingVoice`,
page.js:236-293), remove (`removePending`, page.js:171-178), upload-on-
save (`uploadOne` inside `handleSave`, page.js:323-339). The edit form
(`startEditEntry`/`saveEditEntry`, page.js:363-400) only touches
`entry_date`/`mood`/`note` — confirmed by the file's own comment
(page.js:45-46) and README's documented limitation.

## Proposed change

### Part 1 — week/trimester label

1. Add `profiles.hpht` fetch on load (read-only, no auto-create — a
   missing profile/hpht just means the label stays hidden).
2. Per entry in the history list: `computeGestationalAge(hpht,
   e.entry_date)` → if non-null, render `Minggu ke-{ga.weeks} ·
   Trimester {n}` (n from `trimesterForWeeks(ga.weeks)`, mapped via the
   same t1→"1"/t2→"2"/t3→"3" the Dashboard uses); if null (no HPHT, or
   entry dated before HPHT), render nothing — no fallback assumption.

### Part 2 — attachment upload during edit

Thread a `target` parameter (`"compose"` | `"edit"`) through the existing
attachment handlers instead of duplicating them, so the composer's
current behavior is preserved exactly (same functions, now parameterized)
while edit mode gets the identical capability via its own parallel state:

1. New state: `editPendingPhotos`, `editPendingVideos`,
   `editPendingVoiceNotes`, `editAttachError`, `recordingTarget` (which
   of compose/edit is currently recording, since only one microphone
   recording can happen at once).
2. `pendingCount(target)`, `addPendingFiles(target, kind, fileList)`,
   `removePending(target, kind, idx)` — pick the right state pair per
   target; `pendingCount("edit")` also counts the entry-being-edited's
   *existing* attachments, so the combined total still respects
   `MAX_ATTACHMENTS_PER_ENTRY`.
3. `startRecording(target)`/`stopRecording()` — `onstop` delivers the
   blob to whichever target started it (`recordingTarget`); the record
   button for the *other* target is disabled meanwhile.
4. `transcribePendingVoice(target, idx)`, `dismissTranscribePrompt(target,
   idx)`, `useTidiedNote(target, idx)` — same target-based dispatch;
   `useTidiedNote` appends into `note` or `editNote` depending on target.
5. Extract `uploadAttachment(supabase, userId, entryId, kind, fileOrBlob,
   fallbackName, mimeType)` out of `handleSave`'s inline `uploadOne` —
   identical behavior, just reusable. `handleSave` calls it for a
   brand-new `entry.id` (post-insert); `saveEditEntry` calls it for the
   existing entry's `id` directly, then merges newly-uploaded (signed-
   URL'd) rows into that entry's `attachments` in state.
6. `cancelEditEntry` and a successful `saveEditEntry` clear/revoke the
   edit-session's pending attachments; `startEditEntry` resets them
   defensively at the start of a new edit session.
7. Edit form JSX gains the same attach-row + pending-attachment preview
   block the composer has (photo/video pick, record/stop button, pending
   thumbnails with remove, transcribe prompt/preview), wired to `"edit"`.

## Scope

### In scope
- `app/dashboard/journal/page.js` — everything above.
- `app/globals.css` — one small class for the week/trimester label.

### Out of scope / non-goals
- No change to `lib/pregnancy.js`/`lib/journal.js` — both already have
  everything needed.
- No per-entry-id map for edit-pending state — `editingEntryId` is
  already singular (only one entry editable at a time).
- No change to the Dashboard or Profile pages.

## Steps

1. `page.js`: fetch `profiles.hpht` on load; add the week/trimester label
   to the history list JSX.
2. `page.js`: add edit-scoped pending-attachment state +
   `recordingTarget`.
3. `page.js`: parameterize `pendingCount`/`addPendingFiles`/
   `removePending`/`startRecording`/`stopRecording`/
   `transcribePendingVoice`/`dismissTranscribePrompt`/`useTidiedNote`
   with `target`; verify every existing compose-mode call site still
   passes `"compose"` so current behavior is unchanged.
4. `page.js`: extract `uploadAttachment`; wire it into both `handleSave`
   (unchanged behavior, just calling the extracted helper) and the new
   attachment-upload step inside `saveEditEntry`.
5. `page.js`: extend the edit form's JSX with the attach UI, wired to
   `"edit"`.
6. `globals.css`: add the week/trimester label style.
7. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — existing `journal_attachments`/`journal_entries` tables and
columns are reused as-is; no migration.

## Risks & mitigations

- **Regressing the existing, working new-entry composer** while
  parameterizing its handlers — mitigated by keeping every compose call
  site passing `"compose"` unchanged in behavior, and a careful pass to
  confirm the branching per target doesn't alter compose's existing
  code path at all; `npm run build`/`npm test` plus a manual regression
  check of composing a new entry (per the Verification/Test plan below).
- **Two simultaneous recordings** (compose + edit both trying to record)
  — prevented by `recordingTarget` gating: the non-initiating target's
  record button is disabled with an explanatory title while a recording
  from the other target is in progress.
- **Attachment cap double-counting or under-counting during edit** — edit
  mode's room calculation explicitly adds the entry's existing attachment
  count to its own pending count before comparing to
  `MAX_ATTACHMENTS_PER_ENTRY`, matching the constant's per-entry (not
  per-session) intent.

## Test plan

- No new pure-logic function — this is client-component UI/state wiring
  with Supabase network calls, matching this repo's documented testing
  philosophy (network/UI verified manually). Regression guard: `npm test`
  (existing 23 tests, all in `lib/`, untouched) stays green; `npm run
  build` succeeds.
- Manual: HPHT set → each entry's week/trimester label matches the
  Dashboard's own number for that date; HPHT unset → no label anywhere.
  Edit an entry, add a photo, a video, and a recorded+transcribed voice
  note, save → all appear in that entry's attachments, signed URLs load.
  Try exceeding `MAX_ATTACHMENTS_PER_ENTRY` combined with existing
  attachments during edit → capped/warned the same way the composer
  already warns. Compose a brand-new entry with attachments exactly as
  before → unchanged behavior (regression check on the now-shared
  handlers).

## Standards notes

No `kredivo-docs` areas touched — client-side UI/state change only.
