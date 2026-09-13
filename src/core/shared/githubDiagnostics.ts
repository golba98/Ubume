import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RepoIdentity {
  owner: string;
  repo: string;
  provider: "github" | "other";
  remoteUrl: string;
}

export interface DiagnosticResult {
  path: string;
  status: "PASS" | "FAIL" | "PARTIAL";
  evidence: string;
  blocker: string | null;
  recommendedUse: boolean;
}

export interface DiagnosticsReport {
  repo: RepoIdentity | null;
  defaultBranch: string | null;
  ghCliUser: string | null;
  connectorUser: string | null;
  paths: {
    ghCli: DiagnosticResult;
    localGit: DiagnosticResult;
    localGitWrite: DiagnosticResult;
    connector: DiagnosticResult;
  };
  recommendedFlow:
    | "Local Git + GH CLI"
    | "Local Git + connector PR creation"
    | "Connector-only"
    | "Cannot publish yet";
}

export function parseRepoIdentity(remoteUrl: string | undefined | null): RepoIdentity | null {
  if (!remoteUrl) return null;

  const url = remoteUrl.trim();

  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      provider: "github",
      remoteUrl: url,
    };
  }

  // SSH: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const sshMatch = url.match(/^(?:ssh:\/\/)?git@github\.com[:\/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      provider: "github",
      remoteUrl: url,
    };
  }

  return {
    owner: "",
    repo: "",
    provider: "other",
    remoteUrl: url,
  };
}

export function getLocalGitRemoteUrl(): string | null {
  try {
    return execSync("git remote get-url origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function checkGhCli(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "GH CLI",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  try {
    const version = execSync("gh --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0];
    result.evidence = version ?? "Unknown version";
  } catch {
    result.blocker = "gh CLI not installed or not in PATH";
    return result;
  }

  try {
    // gh auth status output format is not structured JSON; pattern-match on known strings.
    const authStatus = execSync("gh auth status", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    result.evidence += " | Authenticated";
    if (authStatus.includes("Token scopes")) {
      const scopes = authStatus.match(/Token scopes: (.*)/)?.[1];
      if (scopes && !scopes.includes("repo")) {
        result.status = "PARTIAL";
        result.blocker = "Token missing 'repo' scope";
      } else {
        result.status = "PASS";
      }
    } else {
      result.status = "PASS";
    }
  } catch {
    result.blocker = "Not logged in to GitHub CLI";
  }

  return result;
}

export function checkLocalGitRemote(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "Local git remote",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  try {
    const remote = execSync("git remote -v", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0];
    result.evidence = remote ?? "No remote found";

    execSync("git ls-remote origin HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    result.status = "PASS";
  } catch {
    result.blocker = "Cannot reach origin remote (check connectivity or remote URL)";
  }

  return result;
}

export function checkLocalGitWrite(): DiagnosticResult {
  const result: DiagnosticResult = {
    path: "Local .git write",
    status: "FAIL",
    evidence: "",
    blocker: null,
    recommendedUse: false,
  };

  const indexLock = join(".git", "index.lock");
  if (existsSync(indexLock)) {
    result.blocker = ".git/index.lock exists (git process might be running)";
    return result;
  }

  try {
    execSync("git update-ref refs/heads/ubume-diagnostic-lock-test HEAD", { stdio: "ignore" });
    execSync("git update-ref -d refs/heads/ubume-diagnostic-lock-test", { stdio: "ignore" });
    result.status = "PASS";
    result.evidence = "Can create/delete refs";
  } catch (error) {
    result.blocker = "Failed to create/delete ref lock (permission denied?)";
    result.evidence = error instanceof Error ? error.message : String(error);
  }

  return result;
}

export function classifyDiagnostics(
  repo: RepoIdentity | null,
  ghCli: DiagnosticResult,
  localGit: DiagnosticResult,
  localGitWrite: DiagnosticResult,
  connector: DiagnosticResult
): DiagnosticsReport["recommendedFlow"] {
  const isGitHub = repo?.provider === "github";
  if (!isGitHub) return "Cannot publish yet";

  const ghCliOk = ghCli.status === "PASS";
  const gitRemoteOk = localGit.status === "PASS";
  const gitWriteOk = localGitWrite.status === "PASS";
  const connectorOk = connector.status === "PASS" || (connector.status === "PARTIAL" && !connector.blocker?.includes("auth"));

  if (ghCliOk && gitRemoteOk && gitWriteOk) {
    return "Local Git + GH CLI";
  }

  if (connectorOk) {
    if (gitWriteOk && gitRemoteOk) {
      return "Local Git + connector PR creation";
    }
    return "Connector-only";
  }

  return "Cannot publish yet";
}

export function printDiagnosticsTable(report: DiagnosticsReport) {
  const rows = [
    report.paths.ghCli,
    report.paths.localGit,
    report.paths.localGitWrite,
    report.paths.connector,
  ];

  console.log("\nPath                | Status  | Evidence                      | Blocker");
  console.log("--------------------|---------|-------------------------------|---------------------------");
  for (const row of rows) {
    const p = row.path.padEnd(20);
    const s = row.status.padEnd(8);
    const e = (row.evidence || "").substring(0, 30).padEnd(30);
    const b = row.blocker || "";
    console.log(`${p}| ${s}| ${e}| ${b}`);
  }

  console.log(`\nResolved repo: ${report.repo ? `${report.repo.owner}/${report.repo.repo}` : "Unknown"}`);
  console.log(`Default branch: ${report.defaultBranch || "Unknown"}`);
  console.log(`Authenticated GH CLI user: ${report.ghCliUser || "Unknown"}`);
  console.log(`Authenticated connector user: ${report.connectorUser || "Unknown"}`);
  console.log(`Recommended PR flow: ${report.recommendedFlow}`);
}
