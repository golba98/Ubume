import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export const DEFAULT_UNSLOTH_ROOT_URL = "http://127.0.0.1:8888";

type FetchImpl = typeof fetch;

interface UnslothKeyCache {
  servers?: Record<string, {
    saved?: unknown;
    minted?: unknown;
  }>;
}

export interface UnslothConnection {
  rootUrl: string;
  baseUrl: string;
  apiKey: string;
  authSource: "environment" | "agent-cache";
}

export interface UnslothModelInfo {
  id: string;
  loaded: boolean;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
}

export function normalizeUnslothRootUrl(value: string): string {
  const url = new URL(value.trim() || DEFAULT_UNSLOTH_ROOT_URL);
  if (url.hostname.toLowerCase() === "localhost") {
    url.hostname = "127.0.0.1";
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function resolveUnslothRootUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeUnslothRootUrl(env.UNSLOTH_STUDIO_URL?.trim() || DEFAULT_UNSLOTH_ROOT_URL);
}

export function isLoopbackUnslothUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1") return true;
    const parts = hostname.split(".").map(Number);
    return parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 127;
  } catch {
    return false;
  }
}

function readIdentitySecret(env: NodeJS.ProcessEnv): Buffer | null {
  const authDb = join(resolveHome(env), ".unsloth", "studio", "auth", "auth.db");
  if (!existsSync(authDb)) return null;
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options: { readonly: boolean }) => {
        query: (sql: string) => { get: (...params: unknown[]) => unknown };
        close: () => void;
      };
    };
    const database = new Database(authDb, { readonly: true });
    try {
      const row = asRecord(database.query("SELECT value FROM app_secrets WHERE key = ?").get("studio_identity_secret"));
      const value = row?.value;
      return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
        ? Buffer.from(value, "hex")
        : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function proofMessage(nonce: Buffer, hostname: string, port: number): Buffer {
  const normalizedHost = hostname.toLowerCase() === "localhost" ? "127.0.0.1" : hostname.toLowerCase();
  return Buffer.concat([nonce, Buffer.from(`|${normalizedHost}|${port}`)]);
}

export async function verifyUnslothIdentity(options: {
  rootUrl: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  identitySecret?: Buffer | null;
  nonce?: Buffer;
}): Promise<boolean> {
  if (!isLoopbackUnslothUrl(options.rootUrl)) return false;
  const env = options.env ?? process.env;
  const secret = options.identitySecret === undefined ? readIdentitySecret(env) : options.identitySecret;
  if (!secret || secret.length !== 32) return false;

  const url = new URL(options.rootUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const nonce = options.nonce ?? randomBytes(32);
  const encodedNonce = nonce.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const identityUrl = new URL("/api/auth/identity", options.rootUrl);
  identityUrl.searchParams.set("nonce", encodedNonce);

  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(identityUrl, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
    });
    if (!response.ok || response.status >= 300 && response.status < 400) return false;
    const body = asRecord(await response.json());
    const proof = body?.proof;
    if (typeof proof !== "string" || !/^[a-f0-9]{64}$/i.test(proof)) return false;
    const expected = createHmac("sha256", secret)
      .update(proofMessage(nonce, url.hostname, port))
      .digest();
    const actual = Buffer.from(proof, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cachedKeysForServer(rootUrl: string, env: NodeJS.ProcessEnv): string[] {
  const cachePath = join(resolveHome(env), ".unsloth", "studio", "auth", "agent_api_key.json");
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as UnslothKeyCache;
    const entry = parsed.servers?.[rootUrl];
    const keys = [entry?.saved, entry?.minted]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value): value is string => typeof value === "string" && value.startsWith("sk-unsloth-"));
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

async function keyAccepted(rootUrl: string, apiKey: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<boolean> {
  const response = await fetchImpl(`${rootUrl}/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    signal,
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error(`Unsloth returned HTTP ${response.status} while checking its API key.`);
  return true;
}

export async function resolveUnslothConnection(options: {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  identitySecret?: Buffer | null;
} = {}): Promise<UnslothConnection> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rootUrl = resolveUnslothRootUrl(env);
  const explicitKey = env.UNSLOTH_API_KEY?.trim();
  if (explicitKey) {
    if (!await keyAccepted(rootUrl, explicitKey, fetchImpl, options.signal)) {
      throw new Error("UNSLOTH_API_KEY was rejected by the configured Unsloth server.");
    }
    return { rootUrl, baseUrl: `${rootUrl}/v1`, apiKey: explicitKey, authSource: "environment" };
  }

  const identityVerified = await verifyUnslothIdentity({
    rootUrl,
    fetchImpl,
    signal: options.signal,
    env,
    identitySecret: options.identitySecret,
  });
  if (!identityVerified) {
    throw new Error("Could not securely verify the local Unsloth server. Set UNSLOTH_API_KEY or create an API key in Unsloth Settings > API.");
  }

  for (const apiKey of cachedKeysForServer(rootUrl, env)) {
    if (await keyAccepted(rootUrl, apiKey, fetchImpl, options.signal)) {
      return { rootUrl, baseUrl: `${rootUrl}/v1`, apiKey, authSource: "agent-cache" };
    }
  }
  throw new Error("No valid Unsloth agent API key was found. Set UNSLOTH_API_KEY or create an API key in Unsloth Settings > API.");
}

export function parseUnslothModels(value: unknown): UnslothModelInfo[] {
  const data = asRecord(value)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: UnslothModelInfo[] = [];
  for (const item of data) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string" || !record.id.trim()) continue;
    const id = record.id.trim();
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ ...record, id, loaded: record.loaded === true });
  }
  return models;
}
