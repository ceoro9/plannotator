import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createIpcServer } from "./ipc-server";
import { createCookieProxy } from "./cookie-proxy";
import { PanelManager } from "./panel-manager";
import {
  setActiveProxyPort,
  registerEditorAnnotationCommand,
} from "./editor-annotations";

import { getPlannotatorDataDir } from "../../../packages/shared/data-dir";

const IPC_REGISTRY = path.join(getPlannotatorDataDir(), "vscode-ipc.json");

type IpcRegistration = { port: number; token: string };

function readIpcRegistry(): Record<string, IpcRegistration> {
  try {
    return JSON.parse(fs.readFileSync(IPC_REGISTRY, "utf-8")) as Record<
      string,
      IpcRegistration
    >;
  } catch {
    return {};
  }
}

function writeIpcRegistry(registry: Record<string, IpcRegistration>): void {
  const dir = path.dirname(IPC_REGISTRY);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(IPC_REGISTRY, JSON.stringify(registry, null, 2));
}

function registerIpcPort(
  workspacePath: string,
  registration: IpcRegistration,
): void {
  const registry = readIpcRegistry();
  registry[workspacePath] = registration;
  writeIpcRegistry(registry);
}

function unregisterIpcPort(
  workspacePath: string,
  registration: IpcRegistration,
): void {
  const registry = readIpcRegistry();
  if (
    registry[workspacePath]?.port === registration.port &&
    registry[workspacePath]?.token === registration.token
  ) {
    delete registry[workspacePath];
    writeIpcRegistry(registry);
  }
}

const COOKIE_KEY = "plannotator-cookies";

function canonicalWorkspacePaths(): string[] {
  const paths = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      paths.add(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: folder.uri.fsPath,
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      // Non-Git workspace folders cannot match a Git review.
    }
  }
  return [...paths].filter(Boolean);
}

const log = vscode.window.createOutputChannel("Plannotator", { log: true });

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const panelManager = new PanelManager();
  panelManager.setExtensionPath(context.extensionPath);

  const openInPanel = async (url: string) => {
    log.info(`[open] received url: ${url}`);

    // Each panel gets its own cookie proxy so multiple agents
    // can point to different upstream servers without conflicts.
    const proxy = await createCookieProxy({
      loadCookies: () => {
        const cookies = context.globalState.get<string>(COOKIE_KEY) ?? "";
        log.info(`[load] ${cookies.length} chars: ${cookies.slice(0, 120)}…`);
        return cookies;
      },
      onSaveCookies: (cookies) => {
        log.info(`[save] ${cookies.length} chars: ${cookies.slice(0, 120)}…`);
        context.globalState.update(COOKIE_KEY, cookies);
      },
      onClose: () => {
        log.info("[close] received close signal from plannotator");
      },
    });

    const panel = await panelManager.open(proxy.rewriteUrl(url));
    setActiveProxyPort(proxy.port);

    // Auto-close this specific panel when plannotator signals completion
    proxy.events.on("close", () => panel.dispose());

    // Clean up proxy server and editor annotations state when the panel is closed
    panel.onDidDispose(() => {
      proxy.server.close();
      setActiveProxyPort(null);
    });

    vscode.window.showInformationMessage("Plannotator panel opened");
  };

  // Start local IPC server to receive URLs from the router script.
  // Reuse the last port so restored terminals still have a valid PLANNOTATOR_VSCODE_PORT.
  const lastPort = context.workspaceState.get<number>("ipcPort");
  const workspacePaths = canonicalWorkspacePaths();
  const ipcIdentity = {
    workspacePaths,
    token: randomBytes(32).toString("hex"),
  };
  const { server, port } = await createIpcServer(
    (url) => {
      openInPanel(url).catch((err) => {
        log.error(`[open] failed: ${err}`);
        vscode.window.showErrorMessage(`Plannotator: ${err}`);
      });
    },
    ipcIdentity,
    lastPort,
  );
  context.workspaceState.update("ipcPort", port);
  context.subscriptions.push({ dispose: () => server.close() });

  // Write IPC port to file-based registry so non-terminal processes (e.g. hooks)
  // can discover it without relying on environmentVariableCollection.
  for (const workspacePath of workspacePaths) {
    const registration = { port, token: ipcIdentity.token };
    registerIpcPort(workspacePath, registration);
    context.subscriptions.push({
      dispose: () => unregisterIpcPort(workspacePath, registration),
    });
  }

  // Inject env vars into integrated terminals
  const config = vscode.workspace.getConfiguration("plannotatorWebview");
  const injectBrowser = config.get("injectBrowser", true) as boolean;

  if (injectBrowser) {
    const binDir = path.join(context.extensionPath, "bin");
    const routerPath = path.join(binDir, "open-in-vscode");
    context.environmentVariableCollection.replace(
      "PLANNOTATOR_BROWSER",
      routerPath,
    );
    context.environmentVariableCollection.replace(
      "PLANNOTATOR_VSCODE_PORT",
      String(port),
    );
    context.environmentVariableCollection.replace(
      "PLANNOTATOR_VSCODE_TOKEN",
      ipcIdentity.token,
    );
    context.environmentVariableCollection.prepend(
      "PATH",
      binDir + path.delimiter,
    );
  }

  // Register command for manual URL opening
  const openCommand = vscode.commands.registerCommand(
    "plannotator-webview.openUrl",
    async () => {
      const url = await vscode.window.showInputBox({
        prompt: "Enter the Plannotator URL to open",
        placeHolder: "http://localhost:3000",
      });
      if (url) {
        openInPanel(url).catch((err) => {
          log.error(`[open] failed: ${err}`);
          vscode.window.showErrorMessage(`Plannotator: ${err}`);
        });
      }
    },
  );
  context.subscriptions.push(openCommand);

  // Register editor annotation command
  registerEditorAnnotationCommand(context, log);
}

export function deactivate(): void {}
