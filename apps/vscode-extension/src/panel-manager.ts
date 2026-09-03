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
  id: string;
  ok: boolean;
  error?: string;
};
type SendFeedbackDiagnosticMessage = {
  type: "plannotator-send-feedback-diagnostic";
  token: string;
  id: string;
  stage: "wrapper-received" | "iframe-transport-received" | "iframe-callback-missing" | "iframe-received" | "iframe-replied" | "wrapper-replied";
};
type WebviewMessage = ClipboardWriteMessage | ClipboardReadMessage | SendFeedbackResultMessage | SendFeedbackDiagnosticMessage;

type PendingFeedback = {
  panel: vscode.WebviewPanel;
  id: string;
  resolve: (error?: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isSendFeedbackResultMessage(value: unknown): value is SendFeedbackResultMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "plannotator-send-feedback-result" &&
    typeof message.token === "string" &&
    typeof message.id === "string" &&
    typeof message.ok === "boolean" &&
    (message.ok || typeof message.error === "string");
}

export class PanelManager {
  private panels: Set<vscode.WebviewPanel> = new Set();
  private panelTokens = new Map<vscode.WebviewPanel, string>();
  private activePanel: vscode.WebviewPanel | null = null;
  private pendingFeedback: PendingFeedback | null = null;
  private extensionPath: string = "";

  constructor(private readonly onFeedbackDiagnostic?: (stage: SendFeedbackDiagnosticMessage["stage"]) => void) {}

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
      } else if (isSendFeedbackResultMessage(msg)) {
        const pending = this.pendingFeedback;
        if (msg.token === token && pending?.panel === panel && pending.id === msg.id) {
          this.clearPending(msg.ok ? undefined : msg.error);
        }
      } else if (msg.type === "plannotator-send-feedback-diagnostic") {
        const pending = this.pendingFeedback;
        if (msg.token === token && pending?.panel === panel && pending.id === msg.id) {
          this.onFeedbackDiagnostic?.(msg.stage);
        }
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
      if (this.pendingFeedback?.panel === panel) {
        this.clearPending("The review panel closed before feedback was sent.");
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
    if (!panel || !token || !this.panels.has(panel)) return "No active review session.";
    if (this.pendingFeedback) return "A review submission is already in progress.";

    const id = crypto.randomUUID();
    const result = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.clearPending("Confirmation timed out; feedback may still be sent.");
      }, 15_000);
      this.pendingFeedback = { panel, id, resolve, timer };
    });
    try {
      if (await panel.webview.postMessage({ type: "plannotator-send-feedback", token, id })) {
        return result;
      }
    } catch {
      // Treat a rejected webview post the same as an unavailable panel.
    }
    this.clearPending();
    return "The active review panel is unavailable.";
  }

  private clearPending(error?: string): void {
    const pending = this.pendingFeedback;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingFeedback = null;
    pending.resolve(error);
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
        if (d && d.type === "plannotator-send-feedback" && d.token === feedbackToken && typeof d.id === "string") {
          var feedbackFrame = document.getElementById("pn-frame");
          vscodeApi.postMessage({type:"plannotator-send-feedback-diagnostic",token:d.token,id:d.id,stage:"wrapper-received"});
          if (feedbackFrame && feedbackFrame.contentWindow) feedbackFrame.contentWindow.postMessage(d, "*");
          return;
        }
        if (d && d.type === "plannotator-send-feedback-diagnostic" && d.token === feedbackToken && typeof d.id === "string") {
          var diagnosticFrame = document.getElementById("pn-frame");
          if (diagnosticFrame && e.source === diagnosticFrame.contentWindow) vscodeApi.postMessage(d);
          return;
        }
        if (d && d.type === "plannotator-send-feedback-result" && d.token === feedbackToken && typeof d.id === "string" && typeof d.ok === "boolean") {
          var resultFrame = document.getElementById("pn-frame");
          if (resultFrame && e.source === resultFrame.contentWindow) {
            vscodeApi.postMessage({type:"plannotator-send-feedback-diagnostic",token:d.token,id:d.id,stage:"wrapper-replied"});
            vscodeApi.postMessage(d);
          }
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
