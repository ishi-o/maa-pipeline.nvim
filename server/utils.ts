import fs, { copyFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { RuntimeLogPayload } from "./types.ts";

declare global {
  var maaPipelineRuntime: { log(payload: RuntimeLogPayload): void } | null | undefined;
}

export function log(payload: RuntimeLogPayload) {
  globalThis.maaPipelineRuntime?.log(payload);
}

export function normalizePath(file: string) {
  return path.normalize(path.resolve(file));
}

export function fileUriPath(uri: string | null | undefined) {
  if (!uri || !uri.startsWith("file://")) return null;
  try {
    return normalizePath(fileURLToPath(uri));
  } catch {
    return null;
  }
}

export function pathUri(file: string) {
  return pathToFileURL(normalizePath(file)).toString();
}

export function inside(file: string, root: string) {
  const relative = path.relative(normalizePath(root), normalizePath(file));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function fileExists(file: string) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export function textDocument(file: string, text: string) {
  const uri = pathUri(file);
  return TextDocument.create(uri, "jsonc", 0, text);
}

export async function sourceDocument(project: any, file: string) {
  return textDocument(file, (await project.loader.get(file)) ?? "");
}

export function range(document: any, offset: number, length: number) {
  return {
    start: document.positionAt(offset),
    end: document.positionAt(offset + length),
  };
}

export function nodeRange(document: any, node: any, startDelta = 0, endDelta = 0) {
  return range(
    document,
    Math.max(0, node.offset + startDelta),
    Math.max(0, node.length + endDelta),
  );
}

export function offsetRange(document: any, location: any, deltaRight = 0, deltaLeft = 0) {
  const start = Math.max(0, location.offset + deltaLeft);
  const end = Math.max(start, location.offset + location.length + deltaRight);
  return { start: document.positionAt(start), end: document.positionAt(end) };
}

export function escaped(value: unknown) {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

export function markdownText(value: unknown) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export function hsv2rgb(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((value) => (value + m) * 255);
}

export function replaceProjectDir(value: string, root: string) {
  return value.replaceAll("{PROJECT_DIR}", root);
}

export function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function pngSize(image: string) {
  const buffer = Buffer.from(image, "base64");
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Maa server returned a non-PNG screenshot");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    if (await fileExists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function pythonExecutable() {
  return process.platform === "win32" ? "python" : "python3";
}

export function venvDir() {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"));
  return path.join(base, "maaend", "imagecropper-venv");
}

export function venvPython(venv: string) {
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}

export async function moveFile(source: string, target: string) {
  await copyFile(source, target);
  await unlink(source);
}

export function commandRoot(args: unknown[]) {
  const first = args[0] as string | { root?: string } | undefined;
  return typeof first === "string" ? first : first?.root;
}

export async function readConfig(loader: any, root: string) {
  const text = await loader.get(path.join(root, "config", "maa_pi_config.json"));
  if (!text) return {};
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length === 0 && value && typeof value === "object" ? value : {};
}

export function configName(value: any) {
  return typeof value === "string" ? value : (value?.name ?? "");
}

export async function findInterface(file: string, roots: string[]) {
  let current = normalizePath(path.dirname(file));
  while (true) {
    for (const name of ["interface.json", "interface.jsonc"]) {
      const candidate = path.join(current, name);
      if (await fileExists(candidate)) return candidate;
    }
    if (roots.some((root) => normalizePath(root) === current)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
