// The `date-time-pattern` custom setting renderer (ADR 0034, ADR 0062):
// a text box over `date_time_pattern` plus a live preview of *now*,
// rendered through the same `formatDatePattern` every display site
// renders calendar time through — so what the control shows is what
// the setting will actually produce, not a second rendering of the
// pattern.
//
// The preview re-renders every second rather than once per keystroke
// alone: "a live preview of now" means the clock in the box keeps
// ticking while the panel is open, not just on each edit.

import { useEffect, useState } from "react";

import { formatDatePattern, parseDatePattern } from "./datePattern";

export function DateTimePatternEditor({
  value,
  onCommit,
}: {
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const stored = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState<string | null>(null);
  // A value that changed underneath us (a hand-edit, another panel)
  // replaces an untouched box.
  useEffect(() => setDraft(null), [stored]);
  const pattern = draft ?? stored;
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text !== stored) onCommit(text);
  };

  // Ticks once a second so the preview reads as a clock, not a snapshot
  // taken when the panel opened.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const parsed = parseDatePattern(pattern);
  const failed = "error" in parsed;
  const offsetMinutes = -new Date(now).getTimezoneOffset();
  const preview = failed
    ? parsed.error
    : formatDatePattern(parsed, { seconds: Math.floor(now / 1000), nanos: 0 }, offsetMinutes);

  return (
    <div className="date-time-pattern">
      <input
        type="text"
        aria-label="Date/time pattern"
        value={pattern}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className={failed ? "date-time-pattern-error" : "date-time-pattern-preview"}>
        {preview}
      </span>
    </div>
  );
}
