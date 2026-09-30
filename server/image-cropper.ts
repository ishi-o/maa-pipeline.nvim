import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
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

async function clearPngFiles(directory: string) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => unlink(path.join(directory, entry.name))),
  );
}

async function pythonExecutable(root: string) {
  const venvPython = path.join(
    root,
    "venv",
    process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
  );
  if (await exists(venvPython)) return venvPython;
  return process.platform === "win32" ? "python" : "python3";
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

  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  await clearPngFiles(src);
  await clearPngFiles(dst);
  await writeFile(path.join(src, "screenshot.png"), Buffer.from(image, "base64"));

  const child = spawn(await pythonExecutable(root), ["main.py"], {
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
