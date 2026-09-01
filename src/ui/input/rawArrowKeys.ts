export type ArrowDirection = "up" | "down" | "left" | "right";
export type HorizontalArrowDirection = "left" | "right";

const ESC = String.fromCharCode(27);

const FINAL_BYTE_DIRECTIONS: Record<string, ArrowDirection> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
};

// CSI form (`ESC [ C`, `ESC [ 1;5C`) and SS3/application-cursor form (`ESC O C`).
// Terminals emit either depending on DECCKM, and modifier presses add parameters.
// Kitty encodes arrows the same way; its CSI-u codepoint space does not cover them.
const ARROW_PATTERN = new RegExp(`${ESC}(?:\\[[0-9;]*|O)([ABCD])`);

/** Resolve an arrow key from a raw stdin chunk, or null when it holds none. */
export function getArrowDirection(raw: string): ArrowDirection | null {
  const finalByte = ARROW_PATTERN.exec(raw)?.[1];
  return finalByte ? FINAL_BYTE_DIRECTIONS[finalByte] ?? null : null;
}

/** Horizontal-only variant for menus that ignore vertical movement. */
export function getHorizontalArrowDirection(raw: string): HorizontalArrowDirection | null {
  const direction = getArrowDirection(raw);
  return direction === "left" || direction === "right" ? direction : null;
}
