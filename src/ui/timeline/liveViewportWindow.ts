import type { TimelineRow } from "./timelineMeasure.js";
import { buildFrameElisionRow } from "./timelineMeasure.js";

/**
 * Rows kept free below the live window to absorb composer-measurement drift.
 * Ink erases the scrollback (`\x1b[2J\x1b[3J\x1b[H`) on every frame whose live
 * output is taller than the terminal, which drops the user to the bottom while
 * they are reading scrollback. The window must therefore stay strictly inside
 * the viewport even when the composer is one row taller than measured.
 */
export const LIVE_WINDOW_SAFETY_ROWS = 1;

/** Rows a re-capped card costs: its own top border plus the elision notice. */
const FRAME_RECAP_ROWS = 2;

/**
 * Walk back from `start` to the top row of the card `start` sits inside.
 * Returns null when the slice does not cut a card open — either the row carries
 * no frame at all, or it already is a card's top row.
 */
function findOpenFrameTop(
  rows: TimelineRow[],
  start: number,
): { topRow: TimelineRow; topIndex: number } | null {
  const frame = rows[start]?.frame;
  if (!frame || frame.role === "top") return null;

  for (let index = start - 1; index >= 0; index -= 1) {
    const candidate = rows[index];
    const candidateFrame = candidate?.frame;
    if (!candidateFrame || candidateFrame.id !== frame.id) return null;
    if (candidateFrame.role === "top") return { topRow: candidate!, topIndex: index };
  }

  return null;
}

/**
 * Keep only the last `maxRows` live rows. Returns the input array itself when
 * it already fits so memoized consumers keep their identity.
 *
 * The window may only ever shrink — growing past `maxRows` is what makes Ink
 * wipe the scrollback. So when the cut lands inside a bordered card, the card is
 * re-capped rather than extended: two rows of tail are traded for the card's own
 * top border plus an `⋯ N rows hidden` notice, which keeps the box complete
 * instead of leaving a headless frame that starts mid-sentence.
 */
export function windowLiveRows(rows: TimelineRow[], maxRows: number): TimelineRow[] {
  const limit = Math.max(0, Math.floor(maxRows));
  if (rows.length <= limit) return rows;
  if (limit === 0) return [];

  const plainStart = rows.length - limit;
  if (limit <= FRAME_RECAP_ROWS + 1 || !findOpenFrameTop(rows, plainStart)) {
    return rows.slice(plainStart);
  }

  const recapStart = rows.length - (limit - FRAME_RECAP_ROWS);
  const frame = findOpenFrameTop(rows, recapStart);
  if (!frame) return rows.slice(plainStart);

  const hiddenRows = recapStart - frame.topIndex - 1;
  return [
    frame.topRow,
    buildFrameElisionRow(frame.topRow, hiddenRows),
    ...rows.slice(recapStart),
  ];
}
