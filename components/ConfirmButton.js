"use client";
import { useState } from "react";

// Two-step delete confirmation, used by every delete button in the app.
// First click swaps the button for an inline "[Ya, hapus] [Batal]" pair in
// the same spot — no native window.confirm() (its unstyled OS dialog would
// clash with the rest of this app's look), and no floating popover either
// (some delete buttons sit inside an absolutely-positioned overlay — e.g.
// the journal's attachment remove button — where a popover would need to
// fight that same positioning context; an inline swap has no such problem
// since it never leaves the normal flex-row flow it's already in).
export default function ConfirmButton({ onConfirm, className, title, children, confirmLabel = "Ya, hapus", note }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="confirm-inline">
        {note && <span className="confirm-inline-note">{note}</span>}
        <button type="button" className="confirm-inline-yes" onClick={() => { setConfirming(false); onConfirm(); }}>
          {confirmLabel}
        </button>
        <button type="button" className="confirm-inline-cancel" onClick={() => setConfirming(false)}>Batal</button>
      </span>
    );
  }

  return (
    <button type="button" className={className} title={title} onClick={() => setConfirming(true)}>
      {children}
    </button>
  );
}
