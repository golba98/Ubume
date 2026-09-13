# Ubume Release Guide

This guide documents how to publish the npm package `ubume` to the
public npm registry.

## Prepare version 0.1.0

Run these commands from the repository root. NPM versions are immutable, so
never reuse a version that has already been published.

```bash
npm version 0.1.0 --no-git-tag-version
npm run gen-build-info
npm pkg get name version
```

Continue only after the printed version is `0.1.0`.

## Validate the release

```bash
npm whoami --registry=https://registry.npmjs.org
npm view ubume version --registry=https://registry.npmjs.org
bun install
npm run prepublishOnly
npm run audit:ubume-gap
npm run smoke:terminal-bench
npm audit --audit-level=low
git diff --check
npm pack --dry-run --json
```

Inspect the dry-run output to confirm that only the intended package files are
included.

## Authenticate and publish to npm

Authenticate to npmjs.com if needed:

```bash
npm login --registry=https://registry.npmjs.org
```

The package `publishConfig` selects the public npm registry:

```bash
npm publish --access public
```

The `prepublishOnly` lifecycle script automatically regenerates build metadata,
runs the TypeScript typecheck, and runs the full Bun test suite.

## Verify the published package

```bash
npm view ubume@0.1.0 version --registry=https://registry.npmjs.org
npm install -g ubume@0.1.0 --registry=https://registry.npmjs.org
ubume --version
```

After npm's `latest` tag has propagated, verify the tagged package:

```bash
npm view ubume dist-tags --json --registry=https://registry.npmjs.org
npm install -g ubume@latest --registry=https://registry.npmjs.org
ubume --version
```

## Commit and tag the release

```bash
git add -A
git commit -m "release: prepare Ubume v0.1.0"
git tag v0.1.0
git push origin release/ubume-v0-1-0 --follow-tags
```
