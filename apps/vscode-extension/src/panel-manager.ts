import * as vscode from "vscode";
import * as path from "path";
import { buildWrapperThemeScript } from "./vscode-theme";

// Messages the app iframe sends up to the extension host (see the clipboard
// bridge injected in cookie-proxy.ts).
type ClipboardWriteMessage = { type: "plannotator-clipboard-write"; text: string };
type ClipboardReadMessage = { type: "plannotator-clipboard-read"; id: number };
type SendFeedbackResultMessage = {
  type: "plannotator-send-feedback-result";
  token: string;
  result: { error?: string };
};
type WebviewMessage = ClipboardWriteMessage | ClipboardReadMessage | SendFeedbackResultMessage;

export class PanelManager {
  private panels: Set<vscode.WebviewPanel> = new Set();
  private panelTokens = new Map<vscode.WebviewPanel, string>();
  private activePanel: vscode.WebviewPanel | null = null;
  private pendingPanel: vscode.WebviewPanel | null = null;
  private pendingResolve: ((error?: string) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private extensionPath: string = "";

  setExtensionPath(p: string): void {
    this.extensionPath = p;
  }

  async open(url: string): Promise<vscode.WebviewPanel> {
    const resolved = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    const resolvedUrl = resolved.toString();

    const token = crypto.randomUUID();
    const panel = vscode.window.createWebviewPanel(
      "plannotator",
      "Plannotator",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.file(
      path.join(this.extensionPath, "images", "icon.png"),
    );
    const origin = `${resolved.scheme}://${resolved.authority}`;
    panel.webview.html = getHtml(resolvedUrl, origin, token);

    const messageSub = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = raw as WebviewMessage;
      if (msg.type === "plannotator-clipboard-write") {
        await vscode.env.clipboard.writeText(msg.text ?? "");
      } else if (msg.type === "plannotator-clipboard-read") {
        const text = await vscode.env.clipboard.readText();
        panel.webview.postMessage({ type: "plannotator-clipboard-data", id: msg.id, text });
      } else if (
        msg.type === "plannotator-send-feedback-result" &&
        msg.token === token &&
        this.pendingPanel === panel
      ) {
        clearTimeout(this.pendingTimer!);
        this.pendingTimer = null;
        this.pendingPanel = null;
        this.pendingResolve?.(msg.result.error);
        this.pendingResolve = null;
      }
    });

    this.panels.add(panel);
    this.panelTokens.set(panel, token);
    this.activePanel = panel;
    const viewStateSub = panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.activePanel = panel;
    });
    panel.onDidDispose(() => {
      messageSub.dispose();
      viewStateSub.dispose();
      this.panels.delete(panel);
      this.panelTokens.delete(panel);
      if (this.pendingPanel === panel) {
        clearTimeout(this.pendingTimer!);
        this.pendingTimer = null;
        this.pendingPanel = null;
        this.pendingResolve?.("The review panel closed before feedback was sent.");
        this.pendingResolve = null;
      }
      if (this.activePanel === panel) this.activePanel = this.panels.values().next().value ?? null;
    });
    return panel;
  }

  hasPanels(): boolean {
    return this.panels.size > 0;
  }

  async sendFeedback(): Promise<string | undefined> {
    const panel = this.activePanel;
    const token = panel && this.panelTokens.get(panel);
    if (!panel || !token || !this.panels.has(panel)) {
      return "No active review session.";
    }
    if (this.pendingPanel) return "A review submission is already in progress.";

    const result = new Promise<string | undefined>((resolve) => {
      this.pendingPanel = panel;
      this.pendingResolve = resolve;
      this.pendingTimer = setTimeout(() => {
        this.pendingPanel = null;
        this.pendingResolve = null;
        this.pendingTimer = null;
        resolve("The review panel did not respond.");
      }, 15_000);
    });
    if (!(await panel.webview.postMessage({ type: "plannotator-send-feedback", token }))) {
      clearTimeout(this.pendingTimer!);
      this.pendingTimer = null;
      this.pendingPanel = null;
      this.pendingResolve = null;
      return "The active review panel is unavailable.";
    }
    return result;
  }

  closeAll(): void {
    for (const panel of this.panels) {
      panel.dispose();
    }
  }
}

function getHtml(url: string, origin: string, token: string): string {
  const themeScript = buildWrapperThemeScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin};">
  <style>
    body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    iframe { flex: 1; width: 100%; border: none; }
  </style>
</head>
<body>
  <iframe id="pn-frame" src="${url}"></iframe>
  ${themeScript}
  <script>
    (function() {
      var ready = false;
      var reloads = 0;
      var vscodeApi = acquireVsCodeApi();
      var feedbackToken = ${JSON.stringify(token)};
      window.addEventListener("message", function(e) {
        var d = e.data;
        if (d === "plannotator-ready") { ready = true; return; }
        if (d && d.type === "plannotator-send-feedback" && d.token === feedbackToken) {
          var feedbackFrame = document.getElementById("pn-frame");
          if (feedbackFrame && feedbackFrame.contentWindow) feedbackFrame.contentWindow.postMessage(d, ${JSON.stringify(origin)});
          return;
        }
        if (d && d.type === "plannotator-send-feedback-result" && d.token === feedbackToken) {
          var resultFrame = document.getElementById("pn-frame");
          if (resultFrame && e.source === resultFrame.contentWindow && e.origin === ${JSON.stringify(origin)}) vscodeApi.postMessage(d);
          return;
        }
        if (d && d.type === "plannotator-keydown") {
          // Re-dispatch keystrokes forwarded from the nested app iframe so VS
          // Code's keybinding service (which listens on the webview document)
          // can resolve global shortcuts like Cmd+P while the app is focused.
          window.dispatchEvent(new KeyboardEvent("keydown", d.event));
          return;
        }
        // Relay clipboard requests up to the extension host (owns the system
        // clipboard) and responses back down to the app iframe.
        if (d && (d.type === "plannotator-clipboard-write" || d.type === "plannotator-clipboard-read")) {
          vscodeApi.postMessage(d);
          return;
        }
        if (d && d.type === "plannotator-clipboard-data") {
          var f = document.getElementById("pn-frame");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, "*");
        }
      });
      setTimeout(function() {
        if (!ready && reloads < 1) {
          reloads++;
          var f = document.getElementById("pn-frame");
          if (f) { f.src = f.src; }
        }
      }, 3000);
    })();
  </script>
</body>
</html>`;
}
