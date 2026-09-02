import type { TimelineRow } from "./timelineMeasure.js";

/**
 * Rows kept free below the live window to absorb composer-measurement drift.
 * Ink erases the scrollback (`\x1b[2J\x1b[3J\x1b[H`) on every frame whose live
 * output is taller than the terminal, which drops the user to the bottom while
 * they are reading scrollback. The window must therefore stay strictly inside
 * the viewport even when the composer is one row taller than measured.
 */
export const LIVE_WINDOW_SAFETY_ROWS = 1;

/**
 * Keep only the last `maxRows` live rows. Returns the input array itself when
 * it already fits so memoized consumers keep their identity.
 */
export function windowLiveRows(rows: TimelineRow[], maxRows: number): TimelineRow[] {
  const limit = Math.max(0, Math.floor(maxRows));
  if (rows.length <= limit) return rows;
  return rows.slice(rows.length - limit);
}
