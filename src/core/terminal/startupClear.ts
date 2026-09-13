export interface StartupClearOptions {
  write: (chunk: string) => boolean | void;
  /** True when --no-clear was passed on the CLI. */
  noClear: boolean;
  env: Record<string, string | undefined>;
}

/**
 * Writes a full terminal clear (viewport + scrollback + cursor home) to stdout
 * before the first Ink render. Skipped when --no-clear or UBUME_NO_CLEAR=1.
 *
 * Only call this from startApp() in TTY mode — never inside render loops.
 */
export function performStartupClear(options: StartupClearOptions): void {
  if (options.noClear || options.env["UBUME_NO_CLEAR"] === "1") return;
  // \x1b[2J: clear visible viewport
  // \x1b[3J: clear scrollback buffer
  // \x1b[H:  move cursor to top-left
  options.write("\x1b[2J\x1b[3J\x1b[H");
}
