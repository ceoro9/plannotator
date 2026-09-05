import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getPlannotatorDataDir } from "./generated/data-dir.ts";
import { openFileInApp } from "./server/open-in-apps.ts";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 150;
const REGISTRATION_TIMEOUT_MS = 6_000;
const PROBE_PATH = "/__plannotator_vscode_probe__";
const PROBE_RESPONSE = "plannotator-vscode-ipc";
const IPC_TOKEN_BYTES = 32;

type VSCodeIpcRegistry = Record<string, { port: number; token: string }>;

async function repositoryRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--show-toplevel"],
			{ cwd },
		);
		return await realpath(stdout.trim());
	} catch {
		throw new Error("This directory is not inside a Git repository or worktree.");
	}
}

type RegisteredEndpoint = { port: number; token: string };

async function registeredPort(
	worktree: string,
): Promise<RegisteredEndpoint | undefined> {
	let registry: VSCodeIpcRegistry;
	try {
		registry = JSON.parse(
			await readFile(join(getPlannotatorDataDir(), "vscode-ipc.json"), "utf8"),
		) as VSCodeIpcRegistry;
	} catch {
		return undefined;
	}
	for (const [workspace, port] of Object.entries(registry)) {
		if (
			typeof port !== "object" ||
			!Number.isInteger(port.port) ||
			port.port <= 0 ||
			port.port > 65_535 ||
			typeof port.token !== "string" ||
			port.token.length < IPC_TOKEN_BYTES * 2
		)
			continue;
		try {
			if ((await realpath(workspace)) === worktree) return port;
		} catch {
			// Closed or moved VS Code workspaces leave stale keys behind.
		}
	}
	return undefined;
}

export async function isVSCodeEndpoint(
	port: number,
	worktree: string,
	token: string,
): Promise<boolean> {
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}${PROBE_PATH}?token=${encodeURIComponent(token)}`,
			{
				signal: AbortSignal.timeout(500),
			},
		);
		if (response.status !== 200) return false;
		const probe = (await response.json()) as {
			protocol?: unknown;
			workspacePaths?: unknown;
		};
		if (probe.protocol !== PROBE_RESPONSE || !Array.isArray(probe.workspacePaths))
			return false;
		const matches = await Promise.all(
			probe.workspacePaths.map((path) =>
				typeof path === "string"
					? realpath(path)
							.then((resolved) => resolved === worktree)
							.catch(() => false)
					: false,
			),
		);
		return matches.some(Boolean);
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndpoint(worktree: string): Promise<RegisteredEndpoint> {
	const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
	do {
		const port = await registeredPort(worktree);
		if (
			port !== undefined &&
			(await isVSCodeEndpoint(port.port, worktree, port.token))
		)
			return port;
		await delay(POLL_INTERVAL_MS);
	} while (Date.now() < deadline);
	throw new Error(
		"The Plannotator VS Code extension did not register this worktree. Install or enable the extension, then retry /plannotator-review vscode.",
	);
}

async function resolveEndpoint(worktree: string): Promise<RegisteredEndpoint> {
	const port = await registeredPort(worktree);
	if (
		port !== undefined &&
		(await isVSCodeEndpoint(port.port, worktree, port.token))
	)
		return port;
	const launch = await openFileInApp(worktree, "vscode");
	if (!launch.ok)
		throw new Error(`VS Code could not be launched: ${launch.error}`);
	return waitForEndpoint(worktree);
}

/** Opens a review in the VS Code window registered for exactly this Git worktree. */
export async function openReviewInVSCode(
	cwd: string,
	reviewUrl: string,
): Promise<void> {
	const worktree = await repositoryRoot(cwd);
	const port = await resolveEndpoint(worktree);
	const request = new URL("/open", `http://127.0.0.1:${port.port}`);
	request.searchParams.set("url", reviewUrl);
	request.searchParams.set("token", port.token);
	try {
		const response = await fetch(request, { signal: AbortSignal.timeout(3_000) });
		if (!response.ok)
			throw new Error(`VS Code returned HTTP ${response.status}.`);
	} catch (error) {
		throw new Error(
			`Could not open the review in the VS Code window for this worktree: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
