import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";

import pacote from "pacote";
import { x as extractTar } from "tar";
import { MaaVersionManager } from "@nekosu/maa-version-manager";
import { buildControllerRuntime, buildResourceRuntime } from "@nekosu/maa-pipeline-manager";
import {
  hostToSubReq,
  initNoti,
  logNoti,
  shutdownNoti,
  subToHostReq,
} from "@nekosu/maa-server-proto";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc";

import { resolveAgent, runtimeAgents } from "./agent.ts";

const runtimeScript = path.join(__dirname, "maa-runtime.mjs");

type RuntimeLogLevel = "info" | "warn" | "error";

interface RuntimeOptions {
  data_dir?: string;
  version?: string;
  timeout?: number;
  debug_mode?: boolean;
  save_draw?: boolean;
  save_on_error?: boolean;
  locale?: string;
  daemon?: boolean;
  require_admin?: boolean;
}

interface RuntimeProject {
  root: string;
  config: Record<string, any>;
  bundle: {
    content: {
      object: Record<string, any>;
    };
  };
}

interface RuntimeConnection {
  sendNotification(method: string, params?: unknown): void;
  window: {
    showInformationMessage(
      message: string,
      ...actions: { title: string }[]
    ): Promise<{ title: string } | undefined>;
  };
}

interface AgentProcess {
  name: string;
  child: ChildProcess;
  daemon: boolean;
}

interface ActiveTask {
  handle: string;
  task: string;
}

interface RuntimeSetupResult {
  handle?: string;
  error?: string;
}

export class RuntimeSetupError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RuntimeSetupError";
  }
}

class NpmConfigVersionManager extends MaaVersionManager {
  downloadProgress?: (bytes: number) => void;
  downloadLabel?: string;

  async extract(packageSpec: string, destination: string, registry?: string) {
    await mkdir(destination, { recursive: true });
    await pacote.tarball.stream(
      packageSpec,
      async (stream) => {
        let downloaded = 0;
        let reported = 0;
        stream.on("data", (chunk) => {
          downloaded += chunk.length;
          if (downloaded - reported >= 1024 * 1024) {
            reported = downloaded;
            this.downloadProgress?.(downloaded);
          }
        });
        await pipeline(
          stream,
          extractTar({
            cwd: destination,
            strip: 1,
            noMtime: true,
            preserveOwner: false,
            filter: (_, entry: any) => !/Link$/.test(entry.type),
          }),
        );
      },
      { registry },
    );
  }

  async fetchLatest() {
    return pacote.manifest("@maaxyz/maa-node@latest");
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function runtimeConfig(project: RuntimeProject, constants: any) {
  const data = project.bundle.content.object;
  const controller = buildControllerRuntime(data, project.config, constants);
  if (typeof controller === "string") throw new Error(controller);
  const resource = buildResourceRuntime(data, project.config);
  if (typeof resource === "string") throw new Error(resource);
  return {
    root: project.root,
    controller,
    resource,
    task: { tasks: [] },
    agent: runtimeAgents(project),
  };
}

function pngSize(image: string) {
  const buffer = Buffer.from(image, "base64");
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Maa server returned a non-PNG screenshot");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export class RuntimeClient {
  connection: RuntimeConnection;
  options: {
    dataDir?: string;
    requestedVersion: string;
    resolvedVersion: string | null;
    timeout: number;
    debugMode: boolean;
    saveDraw: boolean;
    saveOnError: boolean;
    locale: string;
    daemon: boolean;
    requireAdmin: boolean;
  };
  manager: MaaVersionManager | null = null;
  rpc: MessageConnection | null = null;
  server: net.Server | null = null;
  process: ChildProcess | null = null;
  active: ActiveTask | null = null;
  running: string | null = null;
  agents = new Map<string, AgentProcess>();
  failedAgents = new Set<string>();
  agentOptions = new Map<string, boolean>();
  controllerType: string | null = null;
  daemonHandle: string | null = null;

  constructor(connection: RuntimeConnection, options: RuntimeOptions = {}) {
    this.connection = connection;
    this.options = {
      dataDir: options.data_dir,
      requestedVersion: options.version ?? "latest",
      resolvedVersion: null,
      timeout: options.timeout ?? 60_000,
      debugMode: options.debug_mode ?? true,
      saveDraw: options.save_draw ?? false,
      saveOnError: options.save_on_error ?? true,
      locale: options.locale === "zh" ? "zh" : "en",
      daemon: options.daemon ?? false,
      requireAdmin: options.require_admin ?? false,
    };
  }

  notify(level: RuntimeLogLevel, message: string, task?: string) {
    this.connection.sendNotification("maa-pipeline/runtimeLog", {
      level,
      message,
      task,
    });
  }

  async prepare() {
    if (!this.options.dataDir) throw new Error("init_options.runtime.data_dir is required");
    if (!this.manager) {
      this.manager = new NpmConfigVersionManager(path.join(this.options.dataDir, "native"));
      await this.manager.init();
    }
    let version = this.options.resolvedVersion;
    if (!version) {
      version = this.options.requestedVersion;
      if (version === "latest") {
        const latest = await this.manager.fetchLatest();
        if (!latest?.version) throw new Error("Failed to resolve the latest MaaFramework version");
        version = latest.version;
      }
    }
    this.options.resolvedVersion = version;

    const manager = this.manager as any;
    const labels = {
      "prepare-folder": "Preparing MaaFramework",
      "download-scripts": `Downloading MaaFramework ${version}`,
      "download-binary": "Downloading MaaFramework native library",
      "move-folders": "Installing MaaFramework",
      finish: "MaaFramework is ready",
    };
    const progress = (step: string) => {
      const label = labels[step] ?? step;
      if (step === "download-scripts" || step === "download-binary") manager.downloadLabel = label;
      this.notify("info", label);
    };
    manager.downloadProgress = (bytes: number) =>
      this.notify("info", `${manager.downloadLabel} (${formatSize(bytes)})`);

    const prepared = await manager.prepare(version, progress);
    if (!prepared) throw new Error(`Failed to prepare MaaFramework ${version}`);
  }

  private async isAdmin() {
    if (process.platform !== "win32") return false;
    return await new Promise<boolean>((resolve) => {
      execFile("net.exe", ["session"], (error) => resolve(!error));
    });
  }

  async ensure() {
    if (this.rpc) return this.rpc;
    await this.prepare();
    await mkdir(path.join(this.options.dataDir!, "logs"), { recursive: true });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
      server.once("listening", () => resolve());
    });
    this.server = server;
    const id = randomUUID();
    const address = server.address() as net.AddressInfo;
    let rejectConnection: (error: unknown) => void;
    let connectionTimer: NodeJS.Timeout;
    const connected = new Promise((resolve, reject) => {
      rejectConnection = reject;
      connectionTimer = setTimeout(
        () => reject(new Error("Maa server connection timed out")),
        60_000,
      );
      server.once("connection", (socket) => {
        const rpc = createMessageConnection(socket as any, socket as any);
        rpc.onNotification(initNoti, (clientId) => {
          if (clientId !== id) return;
          clearTimeout(connectionTimer);
          this.rpc = rpc;
          this.bind(rpc);
          resolve(rpc);
        });
        rpc.listen();
      });
    });

    const runtimeArgs = [
      runtimeScript,
      encode({
        id,
        port: address.port,
        module: this.manager!.moduleFolder(this.options.resolvedVersion!),
        maaLog: path.join(this.options.dataDir!, "logs"),
        debugMode: this.options.debugMode,
        saveDraw: this.options.saveDraw,
        saveOnError: this.options.saveOnError,
      }),
    ];
    const elevated =
      this.options.requireAdmin && process.platform === "win32" && !(await this.isAdmin());
    const child = elevated
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList @('${runtimeArgs[0].replaceAll("'", "''")}', '${runtimeArgs[1].replaceAll("'", "''")}') -Verb RunAs -WindowStyle Hidden`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        )
      : spawn(process.execPath, runtimeArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = elevated ? null : child;
    child.stdout?.on("data", (data) => this.notify("info", data.toString().trim()));
    child.stderr?.on("data", (data) => this.notify("error", data.toString().trim()));
    if (elevated) {
      child.once("exit", (code) => {
        if (code === 0) return;
        clearTimeout(connectionTimer);
        rejectConnection(
          new Error(
            "Failed to start MaaServer with administrator permissions; UAC request was denied",
          ),
        );
      });
    }
    child.once("error", (error) => {
      clearTimeout(connectionTimer);
      rejectConnection(error);
    });
    child.once("exit", (code) => {
      if (this.process !== child) return;
      this.notify(code === 0 ? "info" : "error", `Maa server exited with code ${code}`);
      if (!this.rpc) {
        clearTimeout(connectionTimer);
        rejectConnection(new Error(`Maa server exited with code ${code}`));
      }
      this.process = null;
      this.rpc = null;
      this.active = null;
    });
    try {
      return await connected;
    } catch (error) {
      if (this.process === child) {
        child.kill();
        this.process = null;
      }
      if (this.server === server) {
        server.close();
        this.server = null;
      }
      throw error;
    }
  }

  bind(rpc: MessageConnection) {
    rpc.onNotification(logNoti, (level, message) => this.notify(level, message));
    rpc.onRequest(subToHostReq, async (method, args) => {
      if (method === "pushNotify") {
        this.notify("info", JSON.stringify(args[1]), this.active?.task);
        return null;
      }
      if (method === "startTask")
        return this.startAgent(...(args as [string, string[], string, Record<string, string>]));
      if (method === "stopAgent") return this.stopAgent(args[0]);
      if (method === "startDebugSession") {
        this.notify("error", "Debug-session agents require VS Code and are not supported");
        return null;
      }
      if (method === "quickPick") {
        const actions = (args[0] as string[]).map((title) => ({ title }));
        const selected = await this.connection.window.showInformationMessage(
          "Select a Maa item",
          ...actions,
        );
        return selected?.title ?? null;
      }
      return null;
    });
  }

  request<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.rpc) throw new Error("Maa server is not connected");
    return this.rpc.sendRequest(hostToSubReq, method, args) as Promise<T>;
  }

  controllerReady(project: RuntimeProject) {
    if (project.config.controller === "$fixed") return !!project.config.vscFixed?.image;
    const controller = project.bundle.content.object.controller?.find(
      (item: any) => item.name === project.config.controller,
    );
    if (!controller) return false;
    if (controller.type === "Adb") {
      const value = project.config.adb;
      return (
        !!value?.adb_path &&
        !!value?.address &&
        value.screencap !== undefined &&
        value.input !== undefined &&
        value.config !== undefined
      );
    }
    if (controller.type === "Win32") return !!project.config.win32?.hwnd;
    if (controller.type === "Gamepad") return !!project.config.gamepad?.hwnd;
    if (controller.type === "PlayCover") return !!project.config.playcover?.address;
    if (controller.type === "Linux") return !!project.config.linux;
    return false;
  }

  async discoverController(project: RuntimeProject, name: string) {
    if (name === "$fixed") {
      return {
        config_key: "vscFixed",
        fields: [{ key: "image", label: "Absolute image path", required: true }],
      };
    }
    const controller = project.bundle.content.object.controller?.find(
      (item: any) => item.name === name,
    );
    if (!controller) throw new Error(`Unknown controller ${name}`);
    if (controller.type === "Adb") {
      await this.ensure();
      const devices = await this.request<any[]>("refreshAdb", project.config.adb?.adb_path);
      return {
        items: devices.map((device) => ({
          label: `${device[0]} — ${device[2]}`,
          config: {
            adb: {
              adb_path: device[1],
              address: device[2],
              screencap: device[3],
              input: device[4],
              config: JSON.parse(device[5]),
            },
          },
        })),
      };
    }
    if (controller.type === "Win32" || controller.type === "Gamepad") {
      await this.ensure();
      const desktop = controller.type === "Win32" ? controller.win32 : controller.gamepad;
      const classRegex = desktop?.class_regex ? new RegExp(desktop.class_regex) : null;
      const windowRegex = desktop?.window_regex ? new RegExp(desktop.window_regex) : null;
      const devices = (await this.request<any[]>("refreshDesktop")).filter(
        (device) =>
          (!classRegex || classRegex.test(device[1])) &&
          (!windowRegex || windowRegex.test(device[2])),
      );
      const key = controller.type === "Win32" ? "win32" : "gamepad";
      return {
        items: devices.map((device) => ({
          label: `${device[2]} — ${device[1]}`,
          config: { [key]: { hwnd: device[0] } },
        })),
      };
    }
    if (controller.type === "PlayCover") {
      return {
        config_key: "playcover",
        fields: [
          {
            key: "address",
            label: "PlayCover address (host:port)",
            required: true,
          },
        ],
      };
    }
    if (controller.type === "Linux") {
      await this.ensure();
      const meta = controller.linux ?? {};
      const screencap = meta.screencap ?? "Wlr";
      const input = meta.input ?? "Wlr";
      if (screencap === "PipeWire" && meta.pipewire_source === "Portal") {
        throw new Error(
          "Linux PipeWire Portal controllers are not supported by the upstream Maa server",
        );
      }
      const fields: any[] = [];
      if ((screencap === "PipeWire" && meta.pipewire_source !== "Portal") || input === "Libei") {
        const instances = await this.request<any[]>("refreshGamescope");
        fields.push({
          key: "display_no",
          label: "Gamescope display",
          items: instances.map((item) => ({
            label: `Display ${item[0]} — ${item[2]}`,
            value: item[0],
          })),
        });
      }
      if (screencap === "Wlr" || input === "Wlr") {
        const compositors = await this.request<any[]>("refreshWlrCompositor");
        fields.push({
          key: "wlr_socket_path",
          label: "Wayland compositor",
          items: compositors.map((item) => ({
            label: `${item[2]} — ${item[1]}`,
            value: item[1],
          })),
        });
      }
      if (input === "UInput") {
        fields.push(
          { key: "uinput_screen_width", label: "UInput screen width", number: true },
          { key: "uinput_screen_height", label: "UInput screen height", number: true },
        );
      }
      return { config_key: "linux", fields };
    }
    throw new Error(`Unsupported controller type ${controller.type}`);
  }

  async startAgent(exec: string, args: string[], cwd?: string, env: Record<string, string> = {}) {
    const id = randomUUID();
    const name = path.basename(exec, path.extname(exec));
    const daemon = this.options.daemon || this.agentOptions.get(exec) === true;
    this.notify("info", `Starting external ${daemon ? "daemon " : ""}agent ${name}`);
    this.failedAgents.delete(name);

    const agent = await resolveAgent(exec, cwd);

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...env,
      PI_INTERFACE_VERSION: "v2.5.0",
      PI_CLIENT_NAME: "Neovim",
      PI_CLIENT_VERSION: "0.1.0",
      PI_CLIENT_LANGUAGE: this.options.locale,
      PI_CLIENT_MAAFW_VERSION: this.options.resolvedVersion ?? "",
      PI_VERSION: "",
    };

    if (process.platform === "win32" && this.controllerType === "Win32") {
      const pluginRuntimeDirectory = (this.manager as any)?.binaryFolder(
        (this.manager as any)?.versionFolder(this.options.resolvedVersion),
      );
      const existingKey = Object.keys(childEnv).find((k) => k.toLowerCase() === "path");
      const inheritedPath = existingKey ? childEnv[existingKey] : undefined;
      if (existingKey && existingKey !== "Path") {
        delete childEnv[existingKey];
      }
      childEnv.Path = [pluginRuntimeDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
    }

    const child = spawn(agent.executable, args, {
      cwd: agent.cwd,
      env: childEnv as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.agents.set(id, { name, child, daemon });
    child.once("spawn", () => {
      this.notify("info", `External agent ${name} started (${agent.executable})`);
    });
    child.stdout?.on("data", (data) => this.notify("info", data.toString().trim()));
    child.stderr?.on("data", (data) => this.notify("error", data.toString().trim()));
    const stopUpstream = () => {
      if (!this.rpc) return;
      void this.request("agentStopped", id).catch(() => {});
    };
    const stopped = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.agents.delete(id)) return;
      if (daemon) {
        if (code === 0) {
          this.notify(
            "info",
            `External daemon agent launcher ${name} exited; waiting for its service`,
          );
          return;
        }
        this.failedAgents.add(name);
      }
      this.failedAgents.add(name);
      const reason =
        code !== null
          ? `with code ${code}`
          : signal
            ? `with signal ${signal}`
            : "without an exit status";
      this.notify("error", `External agent ${name} failed: exited ${reason}`);
      stopUpstream();
    };
    child.once("error", (error) => {
      if (!this.agents.delete(id)) return;
      this.failedAgents.add(name);
      this.notify("error", `External agent ${name} failed to start: ${error.message}`);
      stopUpstream();
    });
    child.once("exit", stopped);
    return id;
  }

  stopAgent(id: string) {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.agents.delete(id);
    this.notify("info", `Stopping external agent ${agent.name}`);
    agent.child.kill();
  }

  async setup(project: RuntimeProject) {
    const controllerName =
      typeof project.config.controller === "string"
        ? project.config.controller
        : (project.config.controller?.name ?? "");
    const controllerDecl = project.bundle.content.object.controller?.find(
      (c: any) => c.name === controllerName,
    );
    const controllerType = controllerDecl?.type ?? "";

    if (this.options.daemon && this.daemonHandle && this.controllerType === controllerType) {
      return { handle: this.daemonHandle };
    }
    if (this.daemonHandle) await this.destroyDaemon();

    const constants = await this.request("fetchConstants");
    const config = runtimeConfig(project, constants);
    this.controllerType = controllerType;
    this.agentOptions = new Map(config.agent.map((agent) => [agent.child_exec, false]));
    const setup = await this.request<RuntimeSetupResult>(
      "setupInstance",
      config,
      this.options.timeout,
    );
    if (this.options.daemon && setup.handle) this.daemonHandle = setup.handle;

    if (!setup.handle && setup.error === "maa.debug.init-resource-failed") {
      const failedAgents = [...this.failedAgents];
      if (failedAgents.length) {
        this.failedAgents.clear();
        this.notify(
          "error",
          `External agents failed to start; the task will not run: ${failedAgents.join(", ")}`,
        );
      }
    }

    return setup;
  }

  async run(project: RuntimeProject, task: string) {
    if (this.running) throw new Error(`Task ${this.running} is already running`);
    this.running = task;
    this.notify("info", `Starting task ${task}`, task);
    try {
      await this.ensure();
      const setup = await this.setup(project);
      if (!setup?.handle)
        throw new RuntimeSetupError(setup?.error ?? "Failed to create Maa instance");
      this.active = { handle: setup.handle, task };
      try {
        const succeeded = await this.request("postTask", setup.handle, task, []);
        this.notify(
          succeeded ? "info" : "error",
          `Task ${task} ${succeeded ? "finished" : "failed"}`,
          task,
        );
      } finally {
        if (!this.options.daemon) {
          await this.request("destroyInstance", setup.handle).catch(() => {});
        }
        if (this.active?.handle === setup.handle) this.active = null;
      }
    } finally {
      this.running = null;
    }
  }

  async screenshot(project: RuntimeProject) {
    if (this.active) {
      const image = await this.request<string>("getScreencap", this.active.handle);
      if (!image) throw new Error("Failed to take screenshot");
      const size = pngSize(image);
      return { image, roi: [0, 0, size.width, size.height] };
    }
    if (this.running) throw new Error(`Task ${this.running} is still starting`);

    this.running = "screenshot";
    this.notify("info", "Taking screenshot");
    let handle;
    try {
      await this.ensure();
      const setup = await this.setup(project);
      handle = setup?.handle;
      if (!handle) throw new RuntimeSetupError(setup?.error ?? "Failed to create Maa instance");
      const image = await this.request<string>("getScreencap", handle);
      if (!image) throw new Error("Failed to take screenshot");
      const size = pngSize(image);
      return { image, roi: [0, 0, size.width, size.height] };
    } finally {
      if (handle && !this.options.daemon) {
        await this.request("destroyInstance", handle).catch(() => {});
      }
      this.running = null;
    }
  }

  async stop() {
    if (!this.active) {
      this.notify(
        "warn",
        this.running ? `Task ${this.running} is still starting` : "No Maa task is running",
      );
      return;
    }
    this.notify("info", `Stopping task ${this.active.task}`, this.active.task);
    await this.request("postStop", this.active.handle);
  }

  async shutdown() {
    if (this.active) await this.stop().catch(() => {});
    if (this.daemonHandle) await this.destroyDaemon();
    for (const id of this.agents.keys()) this.stopAgent(id);
    this.rpc?.sendNotification(shutdownNoti);
    this.rpc?.dispose();
    this.process?.kill();
    this.server?.close();
    this.rpc = null;
  }

  private async destroyDaemon() {
    if (!this.daemonHandle) return;
    const handle = this.daemonHandle;
    this.daemonHandle = null;
    await this.request("destroyInstance", handle).catch(() => {});
  }
}
