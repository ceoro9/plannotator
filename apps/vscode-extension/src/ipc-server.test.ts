import { afterEach, describe, expect, it, mock } from "bun:test";
import type * as http from "http";
import {
  IPC_PROBE_PATH,
  IPC_PROBE_RESPONSE,
  createIpcServer,
} from "./ipc-server";

const identity = { workspacePaths: ["/workspace"], token: "token" };

describe("createIpcServer", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("starts on a random port", async () => {
    const result = await createIpcServer(
      mock(() => {}),
      identity,
    );
    server = result.server;
    expect(result.port).toBeGreaterThan(0);
  });

  it("identifies itself through the authenticated probe endpoint", async () => {
    const onUrl = mock(() => {});
    const result = await createIpcServer(onUrl, identity);
    server = result.server;

    const response = await fetch(
      `http://127.0.0.1:${result.port}${IPC_PROBE_PATH}?token=${identity.token}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol: IPC_PROBE_RESPONSE,
      workspacePaths: identity.workspacePaths,
    });
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated probe and open request", async () => {
    const onUrl = mock(() => {});
    const result = await createIpcServer(onUrl, identity);
    server = result.server;
    const target = encodeURIComponent("http://localhost:3000");

    expect(
      (await fetch(`http://127.0.0.1:${result.port}${IPC_PROBE_PATH}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${result.port}/open?url=${target}`))
        .status,
    ).toBe(404);
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("calls onUrl for an authenticated open request", async () => {
    const onUrl = mock(() => {});
    const result = await createIpcServer(onUrl, identity);
    server = result.server;
    const target = "http://localhost:3000?tab=review&id=123";

    const response = await fetch(
      `http://127.0.0.1:${result.port}/open?url=${encodeURIComponent(target)}&token=${identity.token}`,
    );

    expect(response.status).toBe(200);
    expect(onUrl).toHaveBeenCalledWith(target);
  });

  it("returns 404 for unknown paths", async () => {
    const result = await createIpcServer(
      mock(() => {}),
      identity,
    );
    server = result.server;
    expect((await fetch(`http://127.0.0.1:${result.port}/other`)).status).toBe(
      404,
    );
  });
});
