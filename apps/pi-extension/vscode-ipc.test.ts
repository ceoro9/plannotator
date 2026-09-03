import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVSCodeEndpoint, openReviewInVSCode } from "./vscode-ipc.ts";

const originalDataDirectory = process.env.PLANNOTATOR_DATA_DIR;
const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	if (originalDataDirectory === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
	else process.env.PLANNOTATOR_DATA_DIR = originalDataDirectory;
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function listeningServer(
	onRequest: (url: URL) => void,
	probeStatus = 200,
): Promise<number> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/__plannotator_vscode_probe__") {
			response.writeHead(probeStatus);
			response.end(probeStatus === 404 ? "not found" : "plannotator-vscode-ipc");
			return;
		}
		onRequest(url);
		response.writeHead(200);
		response.end("ok");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	return address.port;
}

describe("openReviewInVSCode", () => {
	test("rejects an unrelated HTTP server that returns 404", async () => {
		const port = await listeningServer(() => undefined, 404);

		expect(await isVSCodeEndpoint(port)).toBe(false);
	});

	test("rejects a non-200 response even with the expected probe body", async () => {
		const port = await listeningServer(() => undefined, 201);

		expect(await isVSCodeEndpoint(port)).toBe(false);
	});

	test("routes only to the exact canonical current Git worktree and requests focus", async () => {
		const dataDirectory = temporaryDirectory("plannotator-vscode-data-");
		const worktree = temporaryDirectory("plannotator-vscode-worktree-");
		const sibling = temporaryDirectory("plannotator-vscode-worktree-sibling-");
		process.env.PLANNOTATOR_DATA_DIR = dataDirectory;
		execFileSync("git", ["init"], { cwd: worktree });
		execFileSync("git", ["init"], { cwd: sibling });
		const nestedDirectory = join(worktree, "nested");
		mkdirSync(nestedDirectory);

		let request: URL | undefined;
		const matchingPort = await listeningServer((url) => { request = url; });
		const siblingPort = await listeningServer(() => { throw new Error("Sibling worktree must not receive the review"); });
		writeFileSync(join(dataDirectory, "vscode-ipc.json"), JSON.stringify({
			[sibling]: siblingPort,
			[worktree]: matchingPort,
		}));

		await openReviewInVSCode(nestedDirectory, "http://127.0.0.1:3000?review=1");

		expect(request?.pathname).toBe("/open");
		expect(request?.searchParams.get("url")).toBe("http://127.0.0.1:3000?review=1");
	});
});
