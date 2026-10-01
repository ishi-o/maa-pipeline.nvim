import { spawn } from "node:child_process";
import { access, copyFile, glob, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CroppedScreenshot {
  file?: string;
  roi?: string;
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function findImageCropper(root: string) {
  const repo = (await findRepoRoot(root)) ?? path.resolve(root);
  for await (const entry of glob("**/ImageCropper/main.py", {
    cwd: repo,
    exclude: ["**/node_modules/**", "**/.git/**"],
  })) {
    return path.dirname(path.join(repo, entry));
  }
  throw new Error(`ImageCropper was not found under ${repo}`);
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

function pythonExecutable() {
  return process.platform === "win32" ? "python" : "python3";
}

function venvDir() {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"));
  return path.join(base, "maaend", "imagecropper-venv");
}

function venvPython(venv: string) {
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}

async function ensureVenv(root: string) {
  const venv = venvDir();
  const python = venvPython(venv);
  const marker = path.join(venv, ".deps-installed");
  if (await exists(marker)) return python;

  if (!(await exists(python))) {
    await mkdir(path.dirname(venv), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonExecutable(), ["-m", "venv", venv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (data) => (stderr += data));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Failed to create venv${stderr ? `: ${stderr.trim()}` : ""}`)),
      );
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Failed to install ImageCropper dependencies${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          ),
    );
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
  if (!(await exists(main))) throw new Error(`ImageCropper main.py was not found in ${root}`);

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

export async function moveFile(source: string, target: string) {
  await copyFile(source, target);
  await unlink(source);
}
