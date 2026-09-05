import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVSCodeEndpoint, openReviewInVSCode } from "./vscode-ipc.ts";

const originalDataDirectory = process.env.PLANNOTATOR_DATA_DIR;
const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const token = "a".repeat(64);

afterEach(async () => {
	if (originalDataDirectory === undefined)
		delete process.env.PLANNOTATOR_DATA_DIR;
	else process.env.PLANNOTATOR_DATA_DIR = originalDataDirectory;
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function listeningServer(
	workspacePaths: string[],
	onRequest: (url: URL) => void = () => {},
	serverToken = token,
): Promise<number> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/__plannotator_vscode_probe__") {
			if (url.searchParams.get("token") !== serverToken) {
				response.writeHead(404);
				response.end("not found");
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ protocol: "plannotator-vscode-ipc", workspacePaths }),
			);
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
	test("rejects an endpoint with the wrong identity token", async () => {
		const worktree = temporaryDirectory("plannotator-vscode-worktree-");
		const port = await listeningServer([worktree], () => {}, "b".repeat(64));

		expect(await isVSCodeEndpoint(port, worktree, token)).toBe(false);
	});

	test("routes only to the exact canonical current Git worktree", async () => {
		const dataDirectory = temporaryDirectory("plannotator-vscode-data-");
		const worktree = temporaryDirectory("plannotator-vscode-worktree-");
		const sibling = temporaryDirectory("plannotator-vscode-worktree-sibling-");
		process.env.PLANNOTATOR_DATA_DIR = dataDirectory;
		execFileSync("git", ["init"], { cwd: worktree });
		execFileSync("git", ["init"], { cwd: sibling });
		mkdirSync(join(worktree, "nested"));

		let request: URL | undefined;
		const matchingPort = await listeningServer([worktree], (url) => {
			request = url;
		});
		const siblingPort = await listeningServer([sibling]);
		writeFileSync(
			join(dataDirectory, "vscode-ipc.json"),
			JSON.stringify({
				[sibling]: { port: siblingPort, token },
				[worktree]: { port: matchingPort, token },
			}),
		);

		await openReviewInVSCode(join(worktree, "nested"), "http://127.0.0.1:3000");

		expect(request?.pathname).toBe("/open");
	});

	test("rejects a stale registry port reused by another VS Code window", async () => {
		const dataDirectory = temporaryDirectory("plannotator-vscode-data-");
		const worktree = temporaryDirectory("plannotator-vscode-worktree-");
		const sibling = temporaryDirectory("plannotator-vscode-worktree-sibling-");
		process.env.PLANNOTATOR_DATA_DIR = dataDirectory;
		execFileSync("git", ["init"], { cwd: worktree });

		let opened = false;
		const reusedPort = await listeningServer(
			[sibling],
			() => {
				opened = true;
			},
			"b".repeat(64),
		);
		writeFileSync(
			join(dataDirectory, "vscode-ipc.json"),
			JSON.stringify({ [worktree]: { port: reusedPort, token } }),
		);
		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await expect(
				openReviewInVSCode(worktree, "http://127.0.0.1:3000"),
			).rejects.toThrow("VS Code could not be launched");
		} finally {
			process.env.PATH = originalPath;
		}
		expect(opened).toBe(false);
	});
});
