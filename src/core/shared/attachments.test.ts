import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isImageFile,
  resolveAttachmentDestPath,
  importExternalFile,
  rewritePromptWithImportedPaths,
} from "./attachments.js";

// ─── isImageFile ─────────────────────────────────────────────────────────────

test("isImageFile returns true for .png", () => {
  assert.equal(isImageFile("screenshot.png"), true);
});

test("isImageFile returns true for .jpg", () => {
  assert.equal(isImageFile("photo.jpg"), true);
});

test("isImageFile returns true for .jpeg", () => {
  assert.equal(isImageFile("image.jpeg"), true);
});

test("isImageFile returns true for uppercase extension", () => {
  assert.equal(isImageFile("PHOTO.JPG"), true);
});

test("isImageFile returns true for .webp", () => {
  assert.equal(isImageFile("img.webp"), true);
});

test("isImageFile returns false for .txt", () => {
  assert.equal(isImageFile("document.txt"), false);
});

test("isImageFile returns false for .ts", () => {
  assert.equal(isImageFile("component.ts"), false);
});

test("isImageFile returns false for no extension", () => {
  assert.equal(isImageFile("noext"), false);
});

// ─── resolveAttachmentDestPath ────────────────────────────────────────────────

test("resolveAttachmentDestPath returns base filename when no collision", async () => {
  const dir = path.join(tmpdir(), `ubume-attach-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const dest = await resolveAttachmentDestPath("/some/path/file.png", dir);
    assert.equal(path.basename(dest), "file.png");
    assert.equal(path.dirname(dest), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAttachmentDestPath appends -1 on collision", async () => {
  const dir = path.join(tmpdir(), `ubume-attach-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    // Create a file that would collide
    await writeFile(path.join(dir, "file.png"), "existing");
    const dest = await resolveAttachmentDestPath("/some/path/file.png", dir);
    assert.equal(path.basename(dest), "file-1.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAttachmentDestPath appends -2 on double collision", async () => {
  const dir = path.join(tmpdir(), `ubume-attach-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "file.png"), "existing");
    await writeFile(path.join(dir, "file-1.png"), "existing-1");
    const dest = await resolveAttachmentDestPath("/some/path/file.png", dir);
    assert.equal(path.basename(dest), "file-2.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── importExternalFile ───────────────────────────────────────────────────────

test("importExternalFile creates attachments dir if missing and copies file", async () => {
  const baseDir = path.join(tmpdir(), `ubume-import-test-${Date.now()}`);
  const srcDir = path.join(baseDir, "src");
  const destDir = path.join(baseDir, "attachments");
  await mkdir(srcDir, { recursive: true });
  const srcPath = path.join(srcDir, "test.png");
  await writeFile(srcPath, "image-content");
  try {
    const destPath = await importExternalFile(srcPath, destDir);
    assert.ok(destPath);
    assert.equal(path.basename(destPath), "test.png");
    // Verify the file was copied
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(destPath, "utf8");
    assert.equal(content, "image-content");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("importExternalFile skips Cargo registry files without copying", async () => {
  const baseDir = path.join(tmpdir(), `ubume-import-test-${Date.now()}`);
  const srcDir = path.join(baseDir, ".cargo", "registry", "src", "index.crates.io-123", "iced_widget", "src");
  const destDir = path.join(baseDir, "attachments");
  await mkdir(srcDir, { recursive: true });
  const srcPath = path.join(srcDir, "container.rs");
  await writeFile(srcPath, "dependency source");
  try {
    const destPath = await importExternalFile(`${srcPath}:109:12`, destDir);
    assert.equal(destPath, null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("importExternalFile skips non-existent diagnostic paths without throwing", async () => {
  const baseDir = path.join(tmpdir(), `ubume-import-test-${Date.now()}`);
  const destDir = path.join(baseDir, "attachments");
  try {
    const destPath = await importExternalFile(path.join(baseDir, "missing.rs") + ":10:5", destDir);
    assert.equal(destPath, null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── rewritePromptWithImportedPaths ──────────────────────────────────────────

test("rewritePromptWithImportedPaths rewrites quoted path with spaces", () => {
  const prompt = '"C:\\Users\\jorda\\OneDrive\\Screenshots\\Screenshot 2026.png" what is this?';
  const result = rewritePromptWithImportedPaths(prompt, [{
    rawPath: "C:\\Users\\jorda\\OneDrive\\Screenshots\\Screenshot 2026.png",
    replacementPath: "/home/test/.local/share/ubume/attachments/Screenshot 2026.png",
  }]);
  assert.equal(result, '"/home/test/.local/share/ubume/attachments/Screenshot 2026.png" what is this?');
});

test("rewritePromptWithImportedPaths rewrites unquoted path without spaces", () => {
  const prompt = "Look at C:\\Users\\jorda\\file.png please";
  const result = rewritePromptWithImportedPaths(prompt, [{
    rawPath: "C:\\Users\\jorda\\file.png",
    replacementPath: "/home/test/.local/share/ubume/attachments/file.png",
  }]);
  assert.equal(result, "Look at /home/test/.local/share/ubume/attachments/file.png please");
});

test("rewritePromptWithImportedPaths leaves non-matched text unchanged", () => {
  const prompt = "hello world, no paths here";
  const result = rewritePromptWithImportedPaths(prompt, [{
    rawPath: "C:\\some\\other\\path.png",
    replacementPath: "/home/test/.local/share/ubume/attachments/path.png",
  }]);
  assert.equal(result, "hello world, no paths here");
});

test("rewritePromptWithImportedPaths does not double-quote already-quoted replacement path with spaces", () => {
  const prompt = '"C:\\Users\\file with spaces.png" describe';
  const result = rewritePromptWithImportedPaths(prompt, [{
    rawPath: "C:\\Users\\file with spaces.png",
    replacementPath: "/home/test/.local/share/ubume/attachments/file with spaces.png",
  }]);
  // replacementPath has spaces → re-quoted; original was quoted → double-quoted match replaced
  assert.equal(result, '"/home/test/.local/share/ubume/attachments/file with spaces.png" describe');
});

test("rewritePromptWithImportedPaths handles multiple replacements", () => {
  // Paths without spaces get no quotes; the enclosing quotes from the original are consumed
  const prompt = '"C:\\path\\a.png" and "C:\\path\\b.png" compare them';
  const result = rewritePromptWithImportedPaths(prompt, [
    { rawPath: "C:\\path\\a.png", replacementPath: "/home/test/.local/share/ubume/attachments/a.png" },
    { rawPath: "C:\\path\\b.png", replacementPath: "/home/test/.local/share/ubume/attachments/b.png" },
  ]);
  assert.equal(result, "/home/test/.local/share/ubume/attachments/a.png and /home/test/.local/share/ubume/attachments/b.png compare them");
});
