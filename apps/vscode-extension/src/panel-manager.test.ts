import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as vscode from "vscode";
import { PanelManager } from "./panel-manager";

type TestPanel = vscode.WebviewPanel & {
  sent: unknown[];
  webview: vscode.Webview;
  emitMessage(message: unknown): void;
  setActive(active: boolean): void;
  disposed: boolean;
};

describe("PanelManager", () => {
  let manager: PanelManager;
  const spies: Array<{ mockRestore: () => void }> = [];
  const panels: TestPanel[] = [];

  beforeEach(() => {
    manager = new PanelManager();
    panels.length = 0;
  });

  afterEach(() => {
    manager.closeAll();
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  // Stubs createWebviewPanel and returns handles whose `.html` reflects the
  // HTML the manager assigns to each panel's webview.
  function stubWebviewPanels(): { html: string }[] {
    const captured: { html: string }[] = [];
    const spy = spyOn(vscode.window, "createWebviewPanel");
    spy.mockImplementation((() => {
      const capture = { html: "" };
      captured.push(capture);
      let disposeListener: (() => void) | null = null;
      let messageListener: ((message: unknown) => void) | null = null;
      let viewStateListener:
        | ((event: { webviewPanel: vscode.WebviewPanel }) => void)
        | null = null;
      const panel = {
        webview: {
          get html() {
            return capture.html;
          },
          set html(v: string) {
            capture.html = v;
          },
          onDidReceiveMessage(listener: (message: unknown) => void) {
            messageListener = listener;
            return {
              dispose() {
                messageListener = null;
              },
            };
          },
          postMessage(message: unknown) {
            panel.sent.push(message);
            return Promise.resolve(true);
          },
        } as unknown as vscode.Webview,
        active: true,
        sent: [],
        disposed: false,
        reveal() {},
        dispose() {
          if (panel.disposed) return;
          panel.disposed = true;
          disposeListener?.();
        },
        onDidDispose(listener: () => void) {
          disposeListener = listener;
          return { dispose() {} };
        },
        onDidChangeViewState(
          listener: (event: { webviewPanel: vscode.WebviewPanel }) => void,
        ) {
          viewStateListener = listener;
          return {
            dispose() {
              viewStateListener = null;
            },
          };
        },
        emitMessage(message: unknown) {
          messageListener?.(message);
        },
        setActive(active: boolean) {
          Object.defineProperty(panel, "active", {
            configurable: true,
            value: active,
          });
          viewStateListener?.({ webviewPanel: panel });
        },
      } as unknown as TestPanel;
      panels.push(panel);
      return panel;
    }) as typeof vscode.window.createWebviewPanel);
    spies.push(spy);
    return captured;
  }

  it("sets iframe src in webview html", async () => {
    const captured = stubWebviewPanels();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured[0].html).toContain(
      'src="http://127.0.0.1:9999/review?id=42"',
    );
  });

  it("re-dispatches keystrokes forwarded from the app iframe", async () => {
    const captured = stubWebviewPanels();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured[0].html).toContain('d.type === "plannotator-keydown"');
    expect(captured[0].html).toContain('new KeyboardEvent("keydown", d.event)');
  });

  it("relays clipboard messages between the app iframe and the extension host", async () => {
    const captured = stubWebviewPanels();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured[0].html).toContain("acquireVsCodeApi()");
    expect(captured[0].html).toContain('"plannotator-clipboard-write"');
    expect(captured[0].html).toContain('"plannotator-clipboard-data"');
    expect(captured[0].html).toContain(
      "e.source === resultFrame.contentWindow",
    );
    expect(captured[0].html).toContain('e.origin === "http://127.0.0.1:9999"');
  });

  it("uses asExternalUri resolved URL in iframe and CSP", async () => {
    const envSpy = spyOn(vscode.env, "asExternalUri");
    envSpy.mockImplementation(async (_uri: vscode.Uri) => {
      return vscode.Uri.parse("https://localhost:8443/review?id=42");
    });
    spies.push(envSpy);
    const captured = stubWebviewPanels();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(envSpy).toHaveBeenCalled();
    expect(captured[0].html).toContain(
      'src="https://localhost:8443/review?id=42"',
    );
    expect(captured[0].html).toContain("frame-src https://localhost:8443;");
  });

  it("sends feedback through the active panel and waits for server-confirmed success", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9999/review");

    const resultPromise = manager.finalizeActiveReview("feedback", false, 100);
    const request = panels[0].sent[0] as {
      token: string;
      id: number;
      action: string;
    };
    expect(request.action).toBe("feedback");
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: request.token,
      id: request.id,
      result: { status: "success" },
    });

    expect(await resultPromise).toEqual({ status: "success" });
  });

  it("sends approve through the active panel", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9999/review");

    const resultPromise = manager.finalizeActiveReview("approve", false, 100);
    const request = panels[0].sent[0] as {
      token: string;
      id: number;
      action: string;
    };
    expect(request.action).toBe("approve");
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: request.token,
      id: request.id,
      result: { status: "success" },
    });

    expect(await resultPromise).toEqual({ status: "success" });
  });

  it("reports no active review without sending", async () => {
    expect(await manager.finalizeActiveReview("feedback", false, 10)).toEqual({
      status: "error",
      message: "No active review session.",
    });
  });

  it("keeps the panel alive when submission fails", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9999/review");

    const resultPromise = manager.finalizeActiveReview("feedback", false, 100);
    const request = panels[0].sent[0] as { token: string; id: number };
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: request.token,
      id: request.id,
      result: { status: "error", message: "HTTP 500" },
    });

    expect(await resultPromise).toEqual({
      status: "error",
      message: "HTTP 500",
    });
    expect(panels[0].disposed).toBe(false);
  });

  it("resolves a pending command if its panel closes after successful submission", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9999/review");

    const resultPromise = manager.finalizeActiveReview("feedback", false, 100);
    const request = panels[0].sent[0] as { token: string; id: number };
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: request.token,
      id: request.id,
      result: { status: "success" },
    });
    panels[0].dispose();

    expect(await resultPromise).toEqual({ status: "success" });
    expect(manager.getActivePanel()).toBeNull();
  });

  it("targets the currently active panel when multiple reviews are open", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9991/review");
    await manager.open("http://127.0.0.1:9992/review");
    panels[0].setActive(true);

    const resultPromise = manager.finalizeActiveReview("feedback", false, 100);
    expect(panels[0].sent).toHaveLength(1);
    expect(panels[1].sent).toHaveLength(0);
    const request = panels[0].sent[0] as { token: string; id: number };
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: request.token,
      id: request.id,
      result: { status: "success" },
    });

    expect(await resultPromise).toEqual({ status: "success" });
  });

  it("ignores finalize results with the wrong panel token", async () => {
    stubWebviewPanels();
    await manager.open("http://127.0.0.1:9999/review");

    const resultPromise = manager.finalizeActiveReview("feedback", false, 20);
    const request = panels[0].sent[0] as { id: number };
    panels[0].emitMessage({
      type: "plannotator-review-finalize-result",
      token: "wrong-token",
      id: request.id,
      result: { status: "success" },
    });

    expect(await resultPromise).toEqual({
      status: "error",
      message: "The review panel did not respond.",
    });
  });
});
