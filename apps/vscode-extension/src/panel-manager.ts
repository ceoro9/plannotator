import * as vscode from "vscode";
import * as path from "path";
import { buildWrapperThemeScript } from "./vscode-theme";

export type ReviewFinalizeAction = "feedback" | "approve";
export type ReviewFinalizeResult =
  | { status: "success" }
  | { status: "confirmation-required"; annotationCount: number }
  | { status: "error"; message: string };

// Messages the app iframe sends up to the extension host (see the bridges
// injected in cookie-proxy.ts and rendered below).
type ClipboardWriteMessage = {
  type: "plannotator-clipboard-write";
  text: string;
};
type ClipboardReadMessage = { type: "plannotator-clipboard-read"; id: number };
type ReviewFinalizeResultMessage = {
  type: "plannotator-review-finalize-result";
  token: string;
  id: number;
  result: ReviewFinalizeResult;
};
type WebviewMessage =
  | ClipboardWriteMessage
  | ClipboardReadMessage
  | ReviewFinalizeResultMessage;

function isReviewFinalizeResult(value: unknown): value is ReviewFinalizeResult {
  if (!value || typeof value !== "object") return false;

  const result = value as Record<string, unknown>;
  switch (result.status) {
    case "success":
      return true;
    case "confirmation-required":
      return typeof result.annotationCount === "number";
    case "error":
      return typeof result.message === "string";
    default:
      return false;
  }
}

type PendingFinalization = {
  panel: vscode.WebviewPanel;
  resolve: (result: ReviewFinalizeResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PanelManager {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly pendingFinalizations = new Map<
    number,
    PendingFinalization
  >();
  private readonly panelTokens = new Map<vscode.WebviewPanel, string>();
  private readonly activePanelListeners = new Set<
    (panel: vscode.WebviewPanel | null) => void
  >();
  private activePanel: vscode.WebviewPanel | null = null;
  private extensionPath = "";
  private finalizeId = 0;

  setExtensionPath(extensionPath: string): void {
    this.extensionPath = extensionPath;
  }

  onDidChangeActivePanel(
    listener: (panel: vscode.WebviewPanel | null) => void,
  ): vscode.Disposable {
    this.activePanelListeners.add(listener);
    listener(this.activePanel);
    return {
      dispose: () => {
        this.activePanelListeners.delete(listener);
      },
    };
  }

  getActivePanel(): vscode.WebviewPanel | null {
    return this.activePanel;
  }

  private setActivePanel(panel: vscode.WebviewPanel | null): void {
    if (this.activePanel === panel) return;
    this.activePanel = panel;
    for (const listener of this.activePanelListeners) listener(panel);
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

    const messageSub = panel.webview.onDidReceiveMessage(
      async (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const msg = raw as WebviewMessage;
        if (msg.type === "plannotator-clipboard-write") {
          await vscode.env.clipboard.writeText(msg.text ?? "");
        } else if (msg.type === "plannotator-clipboard-read") {
          const text = await vscode.env.clipboard.readText();
          panel.webview.postMessage({
            type: "plannotator-clipboard-data",
            id: msg.id,
            text,
          });
        } else if (
          msg.type === "plannotator-review-finalize-result" &&
          msg.token === token &&
          typeof msg.id === "number" &&
          isReviewFinalizeResult(msg.result)
        ) {
          const pending = this.pendingFinalizations.get(msg.id);
          if (pending?.panel === panel) {
            clearTimeout(pending.timer);
            this.pendingFinalizations.delete(msg.id);
            pending.resolve(msg.result);
          }
        }
      },
    );

    this.panels.add(panel);
    this.panelTokens.set(panel, token);
    this.setActivePanel(panel);
    const viewStateSub = panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.setActivePanel(panel);
    });
    panel.onDidDispose(() => {
      messageSub.dispose();
      viewStateSub.dispose();
      this.panels.delete(panel);
      this.panelTokens.delete(panel);
      for (const [id, pending] of this.pendingFinalizations) {
        if (pending.panel !== panel) continue;
        clearTimeout(pending.timer);
        this.pendingFinalizations.delete(id);
        pending.resolve({
          status: "error",
          message:
            "The active review panel closed before submission completed.",
        });
      }
      if (this.activePanel === panel) {
        const remaining = [...this.panels];
        this.setActivePanel(remaining.length === 1 ? remaining[0] : null);
      }
    });
    return panel;
  }

  async finalizeActiveReview(
    action: ReviewFinalizeAction,
    force = false,
    timeoutMs = 15_000,
  ): Promise<ReviewFinalizeResult> {
    const panel = this.activePanel;
    if (!panel || !this.panels.has(panel)) {
      return { status: "error", message: "No active review session." };
    }
    if (
      [...this.pendingFinalizations.values()].some(
        (pending) => pending.panel === panel,
      )
    ) {
      return {
        status: "error",
        message: "A review submission is already in progress.",
      };
    }

    const token = this.panelTokens.get(panel);
    if (!token) {
      return {
        status: "error",
        message: "The active review panel is unavailable.",
      };
    }

    const id = ++this.finalizeId;
    const result = new Promise<ReviewFinalizeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFinalizations.delete(id);
        resolve({
          status: "error",
          message: "The review panel did not respond.",
        });
      }, timeoutMs);
      this.pendingFinalizations.set(id, { panel, resolve, timer });
    });

    const delivered = await panel.webview.postMessage({
      type: "plannotator-review-finalize",
      token,
      id,
      action,
      force,
    });
    if (!delivered) {
      const pending = this.pendingFinalizations.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pendingFinalizations.delete(id);
      return {
        status: "error",
        message: "The active review panel is unavailable.",
      };
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
      var reviewToken = ${JSON.stringify(token)};
      window.addEventListener("message", function(e) {
        var d = e.data;
        if (d === "plannotator-ready") { ready = true; return; }
        if (d && d.type === "plannotator-review-finalize" && d.token === reviewToken) {
          var reviewFrame = document.getElementById("pn-frame");
          if (reviewFrame && reviewFrame.contentWindow) reviewFrame.contentWindow.postMessage(d, ${JSON.stringify(origin)});
          return;
        }
        if (d && d.type === "plannotator-review-finalize-result" && d.token === reviewToken) {
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
