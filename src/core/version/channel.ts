import { APP_VERSION } from "../../config/settings.js";

export const UBUME_CHANNEL_ENV = "UBUME_CHANNEL";
export const CODEXA_CHANNEL_ENV = "CODEXA_CHANNEL";
export const LOCAL_DEV_CHANNEL = "local-dev";

export function getUbumeChannel(env: NodeJS.ProcessEnv = process.env): string {
  return env[UBUME_CHANNEL_ENV]?.trim() || env[CODEXA_CHANNEL_ENV]?.trim() || "published";
}
export const getCodexaChannel = getUbumeChannel;

export function isLocalDevChannel(env: NodeJS.ProcessEnv = process.env): boolean {
  return getUbumeChannel(env) === LOCAL_DEV_CHANNEL;
}

export function formatUbumeVersionLabel(
  version: string = APP_VERSION,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isLocalDevChannel(env) ? `${version}-dev local` : version;
}
export const formatCodexaVersionLabel = formatUbumeVersionLabel;

export function formatUbumeBrandLabel(env: NodeJS.ProcessEnv = process.env): string {
  return `Ubume v${formatUbumeVersionLabel(APP_VERSION, env)}`;
}
export const formatCodexaBrandLabel = formatUbumeBrandLabel;
