// src/when.mjs — turning a stored instant into the time on Grayson's watch.
//
// Everything here is stored as `new Date().toISOString()`, which is right: UTC
// is unambiguous, sorts lexically, and survives being copied between machines.
// The mistake was rendering it by slicing the string — `"2026-08-13T17:56"` with
// the T swapped for a space is not a time anyone in Georgia recognises. On a
// four-hour offset the job list showed a run at 17:56 while the clock on the
// wall said 14:25, so the last run appeared to be in the future.
//
// That cost something real: reading its own panel, this session scheduled work
// for after an 18:00 job had "already fired" when 18:00 was still hours away.
// The panel was not lying about the instant, only about which clock it was on.
//
// It matters more where these strings reach the model. recall_chat and the
// conversation digest hand timestamps straight into the prompt, so Cleetus
// telling Grayson "we talked at 17:56" about a 13:56 conversation is not a
// formatting nit — it is the assistant being wrong about his day, in the
// confident voice it uses for everything else.
//
// So: keep storing UTC, and render local at the edge, which is the ordinary
// answer to this and the one that was skipped.

const two = (n) => String(n).padStart(2, "0");

/**
 * An ISO instant as local wall-clock time: "2026-08-13 13:56".
 *
 * Anything unparseable comes back unchanged rather than as "NaN-NaN-NaN". These
 * strings are read by a human and pasted into a model prompt; a stamp that is
 * merely odd can be worked around, and one that is confidently wrong cannot.
 */
export function localStamp(iso, { seconds = false } = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
  return `${date} ${time}`;
}

/**
 * How long ago, in words, for cases where the instant matters less than the
 * distance from now — "3 minutes ago" answers "is this stale?" without the
 * reader having to subtract.
 */
export function ago(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const secs = Math.round((now - t) / 1000);
  if (secs < 0) return "in the future";       // a real signal: clock skew, or a bad stamp
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
