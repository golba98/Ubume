# Developer Scripts

This directory contains Ubume's standalone development, validation, build-metadata, and smoke utilities. The executable scripts use Node.js ESM; their colocated TypeScript tests run through Bun.

## Command index

| File or entry point | Package command | Direct command | Purpose |
| --- | --- | --- | --- |
| `run-local-dev.mjs` | `bun run dev:run` | `node scripts/run-local-dev.mjs [args]` | Launch the current checkout or direct native-model chat through `ubume-dev native`. |
| `install-local-dev-bin.mjs` | `bun run install:dev-bin` | `node scripts/install-local-dev-bin.mjs` | Install `ubume-dev` and `cxd` shims that point to this checkout without changing published `ubume`. |
| `gen-build-info.mjs` | `bun run gen-build-info` | `node scripts/gen-build-info.mjs` | Generate the tracked version/commit constants consumed by the application. |
| `audit-ubume-capabilities.mjs` | `bun run audit:ubume-gap` | `node scripts/audit-ubume-capabilities.mjs` | Perform a read-only static capability audit against the current source layout. |
| `smoke-terminal-bench.mjs` | `bun run smoke:terminal-bench` | `node scripts/smoke-terminal-bench.mjs` | Run a real headless Ubume request through the installed launcher path. |
| `install-local-dev-bin.test.ts` | `bun test scripts/install-local-dev-bin.test.ts` | — | Protect bin-directory resolution, published-command isolation, shim contents, and local version output. |
| `run-local-dev.test.ts` | `bun test scripts/run-local-dev.test.ts` | — | Protect interactive/headless entry selection, argument forwarding, and both local shim names. |
| `audit-ubume-capabilities.test.ts` | `bun test scripts/audit-ubume-capabilities.test.ts` | — | Prevent source moves from silently turning implemented capabilities into false audit failures. |

## How each script works

### `run-local-dev.mjs`

This is the local equivalent of the installed `bin/ubume.js` launcher.

1. Resolves the repository root from the script location rather than the caller's working directory.
2. Sends normal interactive launches to `src/index.tsx`.
3. Sends `exec` and `--headless-benchmark` launches to `src/exec.ts`, removing the mode token before forwarding arguments.
4. Spawns Bun with inherited stdio and keeps the caller's current directory as the Ubume workspace.
5. Marks the child as a local development launch through `UBUME_CHANNEL=local-dev` and the related relaunch/package environment fields.
6. Forwards child exit codes and signals to the calling terminal.

Useful forms:

```bash
bun run dev:run
bun run dev:run -- "explain this repository"
bun run dev:run -- exec "print the current directory"
node scripts/run-local-dev.mjs --version
ubume-dev native
```

Inputs and effects:

- `UBUME_BUN_EXECUTABLE` overrides the Bun executable.
- `ubume-dev native` launches the local 900M SFT v2 checkpoint directly through
  native PyTorch inference, bypassing LM Studio and GGUF.
- `CODEXA_NATIVE_MODEL_ROOT`, `CODEXA_NATIVE_PYTHON`,
  `CODEXA_NATIVE_CHECKPOINT`, `CODEXA_NATIVE_TOKENIZER`, and
  `CODEXA_NATIVE_DEVICE` override the native model command defaults.
- `UBUME_DEBUG_LAUNCH=1` prints the resolved local entry point.
- `--help` and `--version` are handled without starting Ink.
- The script does not install a command or modify the published package.
- It fails non-zero when Bun cannot start or when the child application fails.

### `install-local-dev-bin.mjs`

This installer creates two equivalent local-development commands:

- `ubume-dev` — explicit local Ubume command;
- `cxd` — short alias for `ubume-dev`.

Both shims invoke `scripts/run-local-dev.mjs`. The installer never creates, replaces, or removes the published `ubume` command.

Bin-directory precedence:

1. `UBUME_DEV_BIN_DIR`, when explicitly set;
2. the global npm prefix (`npm prefix -g`), using its `bin` directory on non-Windows platforms;
3. `~/.local/bin` when npm prefix discovery fails.

On Windows it writes `.cmd` shims. On Unix-like systems it writes executable shell shims with mode `0755`. Re-running the command replaces only the two local-development shims in the resolved bin directory.

### `gen-build-info.mjs`

The build metadata generator:

1. reads the current commit with `git rev-parse HEAD`, falling back to `unknown` outside a Git checkout;
2. reads the application version from `package.json`;
3. rewrites `src/config/buildInfo.ts` with `BUILD_COMMIT` and `APP_VERSION` constants;
4. prints the abbreviated commit and version it wrote.

This script has an intentional tracked-file side effect. Do not hand-edit `src/config/buildInfo.ts`; inspect its diff after `bun run build`, especially before committing unrelated work.

### `audit-ubume-capabilities.mjs`

The capability audit is a read-only static inspection. It resolves the repository root, checks expected source files and implementation evidence, then prints a PASS/MISSING report for 17 Ubume capabilities.

- Exit `0`: every capability check passed.
- Exit `1`: one or more capabilities are missing, incomplete, or referenced through a stale audit path.

When files move, update the audit evidence paths and `audit-ubume-capabilities.test.ts` in the same change. A failing audit is evidence to investigate; it must not be treated automatically as proof that the product feature is absent.

### `smoke-terminal-bench.mjs`

The smoke script starts the real installed launcher path:

```text
scripts/smoke-terminal-bench.mjs
  -> node bin/ubume.js exec "Print the current directory, list files, and stop."
  -> src/exec.ts
  -> configured Codex backend
```

It inherits the current directory, stdio, environment, provider configuration, and authentication. It forwards the child exit code and fails when the launcher cannot start or is terminated by a signal.

This is an integration smoke, not an isolated unit test. It can contact an external provider, consume provider quota, and expose the current workspace to the configured coding agent. Run it deliberately from a safe workspace with a working Codex installation and authentication; it is not part of `bun test`.

## All package commands

| Command | What it does | Important behavior |
| --- | --- | --- |
| `bun run start` | Runs `src/index.tsx` once. | Interactive TUI; requires a supported terminal. |
| `bun run dev` | Runs `src/index.tsx` with Bun watch mode. | Restarts as source files change. |
| `bun run dev:run` | Runs the local launcher described above. | Supports interactive, `exec`, and benchmark modes. |
| `bun run install:dev-bin` | Installs `ubume-dev` and `cxd`. | Does not modify `ubume`. |
| `bun run debug:claude-models` | Runs Claude Code model discovery diagnostics. | May inspect the locally installed Claude CLI/package/cache/config. |
| `bun run typecheck` | Runs `tsc --noEmit`. | Validation only; does not emit JavaScript. |
| `bun test` | Runs the full Bun test suite. | Discovers colocated `*.test.ts` and `*.test.tsx` files. |
| `bun run audit:ubume-gap` | Runs the static capability audit. | Read-only; non-zero when any check is missing. |
| `bun run smoke:terminal-bench` | Runs the real headless provider smoke. | External/integration side effects; not an isolated test. |
| `bun run gen-build-info` | Regenerates build metadata. | Rewrites tracked `src/config/buildInfo.ts`. |
| `bun run build` | Generates build metadata, then typechecks. | May leave a build-info diff even when typechecking passes. |
| `npm run prepublishOnly` | Generates metadata, typechecks, then tests. | Runs automatically before npm publication and rewrites build info first. |

## Maintenance rules

- Keep package aliases and this guide synchronized.
- Resolve paths from the script location when the script needs repository files; use `process.cwd()` only when the caller's workspace is intentional.
- Use argument arrays with `spawn`/`execFile` rather than shell-concatenated commands.
- Preserve child exit codes, signals, and inherited stdio for launcher and smoke utilities.
- Export pure resolution helpers and guard direct execution with `import.meta.url` when a script needs focused tests.
- Add or update a colocated test whenever entry selection, shim names, path discovery, or audit evidence changes.
- Never add provider-dependent smoke commands to the default unit-test path.
