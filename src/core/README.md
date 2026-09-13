# `src/core`

Non-UI runtime logic for Ubume: launching backends, talking to provider CLIs,
terminal I/O, workspace resolution, and supporting utilities. UI lives in `src/ui`,
app state in `src/session`, config in `src/config`. The top level of `src/core` is
folders-only — every file lives in a domain folder so the directory stays scannable.

## Folder map

| Folder | Responsibility |
| --- | --- |
| `providers/` | **Low-level Codex subprocess I/O.** Spawns the `codex` binary and parses its output (`codexSubprocess`, `codexJsonStream`, `codexTranscript`), plus the backend registry/types and the `openaiNative` stub. |
| `providerRuntime/` | **Multi-provider runtimes + discovery.** One runtime per provider (`anthropic`, `gemini`, `local`, `antigravity`) behind a shared interface, plus routing (`registry`), model/metadata helpers (`models`, `capabilityProfile`, `contextMetadata`, `reasoning`) and Claude Code discovery. |
| `providerLauncher/` | **Workspace provider config + CLI launching.** Which provider is active per workspace (`workspaceConfig`), provider UI state (`registry`), and spawning provider CLIs (`launcher`). |
| `codex/` | Codex CLI launch/prompt assembly: `codexExecArgs`, `codexLaunch`, `codexPrompt`. |
| `models/` | Codex CLI capability discovery (`codexCapabilities`, `codexModelCapabilities`) and the legacy model-spec service (`modelSpecs`). |
| `executables/` | Resolve external CLI binaries with PATH/env handling (`executableResolver` + per-CLI resolvers). |
| `auth/` | Codex auth status probing. |
| `process/` | Generic process spawning (`CommandRunner`) and executable-path validation. |
| `terminal/` | Terminal I/O: ANSI sanitize, raw mode / cursor, title sequences, capability detection, and the `/clear` + resize repaint boundary (`clearFrameBoundary`, `inkRenderReset`). |
| `workspace/` | Workspace resolution and state: `workspaceRoot`, `workspaceGuard`, `workspaceActivity`, `projectInstructions`, `planStorage`, `launchContext`. |
| `version/` | Build channel / version branding (`channel`) and update checking (`updateCheck`). |
| `shared/` | Small cross-cutting utilities: `clipboard`, `cleanupFastFail`, `githubDiagnostics`, `attachments`, `hollowResponseFormat`. |
| `perf/` | Performance + render instrumentation (`profiler`, `renderDebug`). |
| `debug/` | Dev-only tracing helpers (`inputDebug`). |

## The three provider layers

`providers/`, `providerRuntime/`, and `providerLauncher/` have similar names but are
distinct layers — they are **not** duplicates:

```
providerLauncher/   which provider is active for this workspace + how to spawn its CLI
        │
providerRuntime/    per-provider runtimes (anthropic/gemini/local/antigravity),
        │           routing, model discovery, capability/context metadata
        │
providers/          low-level Codex subprocess I/O + output parsing
```

The default Codex backend flows through `providers/`; the other providers are
implemented as `providerRuntime/` runtimes.

## Debug instrumentation

These are intentional, env-gated diagnostics (not dead code) — keep them named clearly:

- `debug/inputDebug.ts` — stdin state tracing (`UBUME_DEBUG_INPUT=1`).
- `debug/localStreamDebug.ts` — privacy-aware Local streaming diagnostics
  (`UBUME_DEBUG_LOCAL_STREAM=1`; add `UBUME_DEBUG_LOCAL_STREAM_CONTENT=1`
  only when response text is safe to record).
- `perf/renderDebug.ts` — Ink render/flicker tracing (`UBUME_RENDER_DEBUG=1`). Kept in
  `perf/` rather than `debug/` because it is imported widely across the UI.
- `providerRuntime/claudeCodeDiscoveryDebug.ts` — entry point for the
  `bun run debug:claude-models` script; lives next to the discovery code it exercises.
