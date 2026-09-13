export interface SlashCommandSuggestion {
  cmd: string;
  desc: string;
  aliases?: readonly string[];
}

export const SLASH_COMMANDS = [
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/clear", desc: "Clear chat and cancel active run" },
  { cmd: "/resume", desc: "Resume a previous conversation" },
  { cmd: "/providers", desc: "Open AI provider picker", aliases: ["/provider"] },
  { cmd: "/model", desc: "Change active model" },
  { cmd: "/models", desc: "Open model picker" },
  { cmd: "/mode", desc: "Change execution mode" },
  { cmd: "/route", desc: "Show active chat route" },
  { cmd: "/backend", desc: "Change active backend" },
  { cmd: "/reasoning", desc: "Change reasoning level" },
  { cmd: "/plan", desc: "Show or toggle session plan mode" },
  { cmd: "/settings", desc: "Open the settings picker", aliases: ["/setting"] },
  { cmd: "/status", desc: "Show effective runtime configuration" },
  { cmd: "/permissions", desc: "Inspect or update permissions and sandbox controls" },
  { cmd: "/runtime", desc: "Compatibility runtime policy controls" },
  { cmd: "/themes", desc: "Open visual theme picker" },
  { cmd: "/verbose", desc: "Toggle verbose mode (detailed processing info)" },
  { cmd: "/auth", desc: "Manage authentication" },
  { cmd: "/workspace", desc: "Show the locked workspace" },
  { cmd: "/copy", desc: "Copy the full conversation transcript to clipboard" },
  { cmd: "/paste-image", desc: "Attach the image currently on the clipboard" },
  { cmd: "/update", desc: "Check for updates and install the latest Ubume" },
  { cmd: "/exit", desc: "Quit the application" },
] as const satisfies readonly SlashCommandSuggestion[];

export type CommandSuggestion = (typeof SLASH_COMMANDS)[number];

function matchesPrefix(suggestion: SlashCommandSuggestion, prefix: string): boolean {
  if (suggestion.cmd.startsWith(prefix)) return true;
  return suggestion.aliases?.some((alias) => alias.startsWith(prefix)) ?? false;
}

export function getSlashCommandSuggestions(prefix: string): readonly CommandSuggestion[] {
  const normalized = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((command) => matchesPrefix(command, normalized)).slice(0, 5);
}
