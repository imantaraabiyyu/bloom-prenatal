# Assessment — Journal week/trimester label + attachment upload during edit

## Request (verbatim, translated)

1. "di journal history tambahkan keterangan minggu ke berapa dan
   trimester berapa" — in the journal entry history, add a label showing
   which gestational week and which trimester each entry's date falls in.
2. "dan saat edit tambahkan upload lagi sama seperti saat membuat jurnal
   awal" — when editing an existing entry, add attachment upload again,
   the same as when first creating a new entry.

## Current behavior

### File in scope

`app/dashboard/journal/page.js` (701 lines) — the only file involved for
both requests; `lib/journal.js` (constants, unchanged) and
`lib/pregnancy.js` (pure gestational-age math, unchanged, just imported)
are read but not modified.

### Request 1 — week/trimester

The journal page currently fetches **only** `journal_entries` and
`journal_attachments` ([page.js:91-102](../../app/dashboard/journal/page.js#L91-L102)) — it never reads
`profiles.hpht`, so there's no gestational-age data available at all here
yet. The Dashboard page already does exactly this computation for its own
purposes: fetches `profiles.hpht` on load
(`app/dashboard/page.js:82`, `select("*")` on `profiles`), then derives
per-viewed-date trimester via `trimesterForDate(hpht, dateIso)`
(`lib/pregnancy.js:61-64`), and separately displays a `Trimester
1/2/3` label from an inline `[["t1","Trimester 1"], ["t2","Trimester
2"], ["t3","Trimester 3"]]` map (`app/dashboard/page.js:482`). For the
week number, `computeGestationalAge(hpht, dateIso)` (`lib/pregnancy.js:38-43`)
returns `{ totalDays, weeks, days }` — `.weeks` is the "minggu ke-N" value
this request wants, and both functions return `null`/fall back to `t1`
when `hpht` is missing.

### Request 2 — upload during edit

The **new-entry composer** already has a full attachment pipeline: pick
photo/video (`addPendingFiles`, [page.js:145-169](../../app/dashboard/journal/page.js#L145-L169)), record voice
note (`startRecording`/`stopRecording`, [page.js:181-224](../../app/dashboard/journal/page.js#L181-L224)),
optionally transcribe it (`transcribePendingVoice`, [page.js:236-293](../../app/dashboard/journal/page.js#L236-L293)),
remove a pending item before saving (`removePending`, [page.js:171-178](../../app/dashboard/journal/page.js#L171-L178)),
and upload everything on save (`uploadOne` inside `handleSave`,
[page.js:323-339](../../app/dashboard/journal/page.js#L323-L339) — uploads to the `journal-media` storage bucket, then
inserts a `journal_attachments` row per file).

**The edit form has none of this.** `startEditEntry`/`saveEditEntry`
([page.js:363-400](../../app/dashboard/journal/page.js#L363-L400)) only touch `entry_date`/`mood`/`note` — confirmed by
the file's own comment at [page.js:45-46](../../app/dashboard/journal/page.js#L45-L46): "editing an existing
entry — date/mood/note only; attachments keep their own
add-at-creation-time/delete-only management, not touched here". This
matches README's documented limitation verbatim (lampiran "tetap cuma
bisa dihapus, belum ada fitur menambah lampiran baru ke catatan yang
sudah ada").

All the pending-attachment **state** used by the composer
(`pendingPhotos`/`pendingVideos`/`pendingVoiceNotes`,
`isRecording`/`recordSeconds`, the `mediaRecorderRef`/`recordedChunksRef`/
`recordTimerRef`/`streamRef` refs) is **singular**, not per-entry — it
belongs to "the one new-entry composer", which is always on-screen at the
top of the page. `editingEntryId` is also singular (only one entry can be
in edit-mode at a time), but an edit session and the new-entry composer
can be open **at the same time** in the UI (composer is always visible;
the edit form appears inline within whichever history entry got its ✏️
clicked) — so simply reusing the composer's existing pending-attachment
state for edit mode too would risk cross-contaminating a new draft's
attachments with an in-progress edit's, or vice versa. This needs its own
parallel state scoped to "the entry currently being edited", mirroring
the already-singular `editDate`/`editMood`/`editNote` pattern — not a
per-entry-id map, since only one edit session exists at a time.

## Files/functions likely in scope

- `app/dashboard/journal/page.js` — the only file:
  - Request 1: fetch `profiles.hpht` on load (mirroring
    `app/dashboard/page.js:82`); compute + render a week/trimester label
    per entry in the history list.
  - Request 2: new edit-scoped pending-attachment state + handlers
    (parallel to the composer's, not shared); extend `saveEditEntry` to
    also upload any new pending attachments against the existing entry's
    `id`; extend the edit form's JSX with the same attach-row/pending-
    preview UI the composer already has.

## Ambiguities (unresolved — block a SIMPLE classification)

1. **Week/trimester label when HPHT isn't set.** The Dashboard falls back
   to showing "Trimester 1" with an explicit "belum diset" warning for
   its one *current* live view — repeating that same assumption silently
   on every single historical journal entry could read as misleading
   (implying real data). Show nothing when `hpht` is null, or mirror the
   Dashboard's fallback-with-caveat?
2. **Scope of "upload again, same as when first creating" during edit.**
   Does this mean the full composer experience (photo, video, record a
   *new* voice note, and optionally transcribe it into the note text) or
   just adding photo/video files (leaving voice recording/transcription
   as still new-entry-only, since README explicitly documents that as a
   deliberate boundary today: "Transkrip voice note... cuma tersedia saat
   menulis catatan baru... Belum ada tombol transkrip untuk voice note
   lama")? This changes how much of the composer's logic needs to be
   mirrored into edit mode.

Not asking (resolved by existing code/constants, not genuinely open):
attachment count during edit counts against the same
`MAX_ATTACHMENTS_PER_ENTRY` total as existing attachments already on that
entry (the constant is already named "_PER_ENTRY", not "_per session");
new edit-session pending state is separate from the composer's (avoids
the cross-contamination risk above); only one microphone recording can
happen at a time regardless of which session (edit vs. new-entry) started
it, so starting one disables the other's record button meanwhile.

## Triage

**Triage: COMPLEX** — two real open questions above materially change
scope (whether transcription/recording enters edit mode at all, whether a
missing-HPHT state shows a label or nothing), and request 2 is a
non-trivial amount of new state/UI (even though confined to one file) —
not a bounded few-line tweak.
