"use client";
import { useEffect, useRef, useState } from "react";

// Small "?" trigger that reveals arbitrary content (usually a paragraph of
// reference text that would otherwise sit always-visible and cluttering a
// panel/heading) in a popup on click. Closes on a second click or an
// outside tap -- same mousedown+touchstart technique as the attach-menu
// dropdown in app/dashboard/chat/page.js (attachMenuOpen/attachMenuRef),
// reused here for consistency rather than a second toggle-close pattern.
export default function HelpTip({ children, label = "Info" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={ref}>
      <button
        type="button"
        className="help-tip-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        title={label}
      >
        ?
      </button>
      {open && <span className="help-tip-bubble">{children}</span>}
    </span>
  );
}
