import * as http from "http";

export const IPC_PROBE_PATH = "/__plannotator_vscode_probe__";
export const IPC_PROBE_RESPONSE = "plannotator-vscode-ipc";

/**
 * Lightweight HTTP server on localhost for receiving URLs from the router script.
 * Needed because vscode:// URI handlers don't work reliably on Linux.
 */
export function createIpcServer(
  onOpen: (url: string, focus: boolean) => Promise<void>,
  preferredPort?: number,
): Promise<{ server: http.Server; port: number }> {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parsed = new globalThis.URL(req.url!, "http://localhost");
    const targetUrl = parsed.searchParams.get("url");

    if (req.method === "GET" && parsed.pathname === IPC_PROBE_PATH) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(IPC_PROBE_RESPONSE);
      return;
    }
    if (req.method !== "GET" || parsed.pathname !== "/open" || !targetUrl) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    try {
      await onOpen(targetUrl, parsed.searchParams.get("focus") === "1");
      res.writeHead(200);
      res.end("ok");
    } catch {
      res.writeHead(500);
      res.end("failed to open URL");
    }
  };

  function listen(port: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve({ server, port: addr.port });
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
      server.on("error", reject);
    });
  }

  if (preferredPort) {
    return listen(preferredPort).catch(() => listen(0));
  }
  return listen(0);
}
