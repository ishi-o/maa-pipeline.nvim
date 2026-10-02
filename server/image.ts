import { spawn } from "node:child_process";
import { glob, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CroppedScreenshot } from "./types.ts";
import {
  absolutePath,
  findRepositoryRoot,
  imageCropperVenvDir,
  imageCropperVenvPython,
  isRegularFile,
  log,
  systemPythonExecutable,
} from "./utils.ts";

export async function findImageCropper(root: string) {
  const repository = await findRepositoryRoot(root);
  const searchRoot = repository ?? path.dirname(absolutePath(root));
  for await (const entry of glob("**/ImageCropper/main.py", {
    cwd: searchRoot,
    exclude: ["**/node_modules/**", "**/.git/**"],
  })) {
    return path.dirname(path.join(searchRoot, entry));
  }
  throw new Error(`ImageCropper was not found under ${searchRoot}`);
}

async function clearPngFiles(directory: string) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => unlink(path.join(directory, entry.name))),
  );
}

async function ensureVenv(root: string) {
  const venv = imageCropperVenvDir();
  const python = imageCropperVenvPython(venv);
  const marker = path.join(venv, ".deps-installed");
  if (await isRegularFile(marker)) return python;

  if (!(await isRegularFile(python))) {
    log({
      level: "info",
      message: "Creating the ImageCropper Python environment",
      source: "image-cropper",
    });
    await mkdir(path.dirname(venv), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(systemPythonExecutable(), ["-m", "venv", venv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (data) => (stderr += data));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const message = `Failed to create venv${stderr ? `: ${stderr.trim()}` : ""}`;
        log({ level: "error", message, source: "image-cropper" });
        reject(new Error(message));
      });
    });
  }

  await new Promise<void>((resolve, reject) => {
    log({
      level: "info",
      message: "Installing ImageCropper requirements",
      source: "image-cropper",
    });
    const child = spawn(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = `Failed to install ImageCropper dependencies${
        stderr ? `: ${stderr.trim()}` : ""
      }`;
      log({ level: "error", message, source: "image-cropper" });
      reject(new Error(message));
    });
  });

  log({
    level: "info",
    message: "ImageCropper requirements installed",
    source: "image-cropper",
  });
  await writeFile(marker, "");
  return python;
}

export function parseImageCropperOutput(output: string): CroppedScreenshot {
  const file = [...output.matchAll(/^dst: (.+)$/gm)].at(-1)?.[1];
  const roi = [...output.matchAll(/^original roi: \[([^\]]+)\]/gm)].at(-1)?.[1];
  return {
    ...(file ? { file } : {}),
    ...(roi ? { roi: `[${roi}]` } : {}),
  };
}

export async function runImageCropper(root: string, image: string) {
  const main = path.join(root, "main.py");
  if (!(await isRegularFile(main)))
    throw new Error(`ImageCropper main.py was not found in ${root}`);

  const python = await ensureVenv(root);

  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  await clearPngFiles(src);
  await clearPngFiles(dst);
  await writeFile(path.join(src, "screenshot.png"), Buffer.from(image, "base64"));

  const child = spawn(python, ["main.py"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end("0\n");

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (data) => (stdout += data));
  child.stderr?.setEncoding("utf8").on("data", (data) => (stderr += data));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`ImageCropper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  const result = parseImageCropperOutput(stdout);
  if (!result.file && !result.roi) {
    throw new Error("ImageCropper exited without a ROI or saved image");
  }
  return result;
}
