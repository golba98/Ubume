import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ClipboardImage {
  data: Buffer;
  mediaType: "image/png";
}

type CommandRunner = (file: string, args: string[]) => Promise<Buffer>;

function runBuffer(file: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "buffer", maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES + 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}

function isPng(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function validatePng(data: Buffer): ClipboardImage {
  if (!isPng(data)) throw new Error("The clipboard does not contain a supported PNG image.");
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("The clipboard image exceeds the 20 MiB limit.");
  return { data, mediaType: "image/png" };
}

async function firstSuccessful(attempts: Array<() => Promise<Buffer>>): Promise<Buffer> {
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      if (data.length > 0) return data;
    } catch {
      // Try the next platform-appropriate clipboard bridge.
    }
  }
  throw new Error("No PNG image is available on the system clipboard.");
}

async function readMacClipboard(run: CommandRunner): Promise<Buffer> {
  try {
    return await run("pngpaste", ["-"]);
  } catch {
    const tempDir = await mkdtemp(join(tmpdir(), "codexa-clipboard-"));
    const outputPath = join(tempDir, "clipboard.png");
    const applePath = outputPath.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
    try {
      await run("osascript", [
        "-e", "set imageData to the clipboard as «class PNGf»",
        "-e", `set imageFile to open for access POSIX file \"${applePath}\" with write permission`,
        "-e", "set eof imageFile to 0",
        "-e", "write imageData to imageFile",
        "-e", "close access imageFile",
      ]);
      return await readFile(outputPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

const WINDOWS_CLIPBOARD_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "Add-Type -AssemblyName System.Drawing;",
  "$image=[System.Windows.Forms.Clipboard]::GetImage();",
  "if ($null -eq $image) { exit 2 };",
  "$stream=New-Object System.IO.MemoryStream;",
  "$image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);",
  "[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()));",
].join("");

async function readWindowsClipboard(run: CommandRunner, executable = "powershell.exe"): Promise<Buffer> {
  const encoded = await run(executable, ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_CLIPBOARD_SCRIPT]);
  return Buffer.from(encoded.toString("utf8").trim(), "base64");
}

export async function readClipboardImage(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): Promise<ClipboardImage> {
  const targetPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runBuffer;
  let data: Buffer;

  if (targetPlatform === "win32") {
    data = await readWindowsClipboard(run);
  } else if (targetPlatform === "darwin") {
    data = await readMacClipboard(run);
  } else if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    data = await firstSuccessful([
      () => readWindowsClipboard(run),
      () => run("wl-paste", ["--no-newline", "--type", "image/png"]),
      () => run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ]);
  } else {
    data = await firstSuccessful([
      () => run("wl-paste", ["--no-newline", "--type", "image/png"]),
      () => run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ]);
  }

  return validatePng(data);
}
