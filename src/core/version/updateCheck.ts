import { APP_VERSION } from "../../config/settings.js";
import { isLocalDevChannel } from "./channel.js";

export const UBUME_NPM_PACKAGE = "ubume";
export const UBUME_NPM_REGISTRY_URL = "https://registry.npmjs.org/ubume";
export const UBUME_UPDATE_COMMAND = `npm install -g ${UBUME_NPM_PACKAGE}@latest`;

export const CODEXA_NPM_PACKAGE = UBUME_NPM_PACKAGE;
export const CODEXA_NPM_REGISTRY_URL = UBUME_NPM_REGISTRY_URL;
export const CODEXA_UPDATE_COMMAND = UBUME_UPDATE_COMMAND;

export type UpdateStatus = "up-to-date" | "update-available" | "unknown" | "error";

export interface NpmRegistryMetadata {
  "dist-tags"?: { latest?: unknown };
}

export interface UpdateCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  errorMessage?: string;
  checkedAt: number;
  source?: "npm" | "cache";
}

const FETCH_TIMEOUT_MS = 5000;

/** Strip a leading "v" so "v1.0.2" and "1.0.2" are treated as equal. */
export function normalizeVersion(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

export function formatVersionLabel(version: string): string {
  const normalized = normalizeVersion(version.trim());
  return normalized ? `v${normalized}` : version;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Returns true for valid semver strings with or without a leading "v". */
export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(normalizeVersion(v));
}

export function shouldRunStartupUpdateCheck(
  env: NodeJS.ProcessEnv = process.env,
  enabled = true,
): boolean {
  return enabled && !isLocalDevChannel(env);
}

// Compares two semver strings numerically. Returns negative if a < b, 0 if equal, positive if a > b.
// Pre-release versions (e.g. 1.0.2-beta.1) sort below their release counterpart (1.0.2 > 1.0.2-beta.1).
// Leading "v" is stripped before comparison.
export function compareSemver(a: string, b: string): number {
  const parseParts = (v: string): { numeric: number[]; prerelease: string | null } => {
    const norm = normalizeVersion(v);
    const dashIdx = norm.indexOf("-");
    const base = dashIdx === -1 ? norm : norm.slice(0, dashIdx);
    const prerelease = dashIdx === -1 ? null : norm.slice(dashIdx + 1);
    const numeric = base.split(".").map((p) => parseInt(p, 10) || 0);
    return { numeric, prerelease };
  };

  const pa = parseParts(a);
  const pb = parseParts(b);
  const len = Math.max(pa.numeric.length, pb.numeric.length);

  for (let i = 0; i < len; i++) {
    const diff = (pa.numeric[i] ?? 0) - (pb.numeric[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Same numeric version: no pre-release > has pre-release
  if (pa.prerelease === null && pb.prerelease !== null) return 1;
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease !== null && pb.prerelease !== null) {
    return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

export interface UpdateCheckOverrides {
  currentVersion?: string;
  fetchNpmMetadataFn?: (url: string) => Promise<NpmRegistryMetadata>;
}

async function defaultFetchNpmMetadata(url: string): Promise<NpmRegistryMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": `${UBUME_NPM_PACKAGE}-update-checker/1.0` },
    });
    if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
    return await res.json() as NpmRegistryMetadata;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(
  opts?: { enabled?: boolean },
  overrides?: UpdateCheckOverrides,
): Promise<UpdateCheckResult> {
  const currentVersion = normalizeVersion(overrides?.currentVersion ?? APP_VERSION);

  if (opts?.enabled === false) {
    return { status: "unknown", currentVersion, latestVersion: null, checkedAt: Date.now(), source: "npm" };
  }

  try {
    const fetchFn = overrides?.fetchNpmMetadataFn ?? defaultFetchNpmMetadata;
    const metadata = await fetchFn(UBUME_NPM_REGISTRY_URL);
    const rawLatest = metadata["dist-tags"]?.latest;

    if (typeof rawLatest !== "string" || !rawLatest.trim()) {
      return {
        status: "error",
        currentVersion,
        latestVersion: null,
        errorMessage: "npm registry response did not include dist-tags.latest",
        checkedAt: Date.now(),
        source: "npm",
      };
    }

    const latestVersion = normalizeVersion(rawLatest.trim());

    if (!isValidSemver(latestVersion) || !isValidSemver(currentVersion)) {
      return {
        status: "unknown",
        currentVersion,
        latestVersion: rawLatest,
        errorMessage: `Invalid semver — current: "${currentVersion}", latest: "${rawLatest}"`,
        checkedAt: Date.now(),
        source: "npm",
      };
    }

    const status = isNewerVersion(latestVersion, currentVersion) ? "update-available" : "up-to-date";
    return { status, currentVersion, latestVersion, checkedAt: Date.now(), source: "npm" };
  } catch (err) {
    return {
      status: "error",
      currentVersion,
      latestVersion: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
      source: "npm",
    };
  }
}

export function formatUpdateInstructions(
  result: UpdateCheckResult | null,
  updateCommand: string = UBUME_UPDATE_COMMAND,
): string {
  const current = result?.currentVersion ?? APP_VERSION;
  const latest = result?.latestVersion ?? "unknown";

  if (result?.status === "error") {
    return [
      `Current installed version: ${current}`,
      `npm latest version:        ${latest}`,
      `Error checking npm update status: ${result.errorMessage ?? "unknown error"}`,
    ].join("\n");
  }

  if (result?.status === "up-to-date") {
    return [
      "Ubume is up to date.",
      `Current installed version: ${current}`,
      `npm latest version:        ${latest}`,
    ].join("\n");
  }

  const statusLine = result?.status === "update-available" && result.latestVersion
    ? `Update available: Ubume ${formatVersionLabel(result.latestVersion)}`
    : "Status unknown — could not reach npm registry.";

  return [
    `Current installed version: ${current}`,
    `npm latest version:        ${latest}`,
    `Status:          ${statusLine}`,
    "",
    `Run: ${updateCommand}`,
  ].join("\n");
}

export function formatLocalDevUpdateStatus(): string {
  return [
    "Running local-dev Ubume.",
    "Automatic published npm update prompts are disabled for this channel.",
    "Run /update check to explicitly check the published npm package.",
  ].join("\n");
}
