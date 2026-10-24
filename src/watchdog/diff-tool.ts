import { execFile, spawnSync } from "node:child_process";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

export const WATCHDOG_DIFF_TOOL_NAME = "watchdog_diff";
export const WATCHDOG_DIFF_MAX_CHARS = 24_000;
export const WATCHDOG_DIFF_UNAVAILABLE_BASELINE = "watchdog_diff unavailable: this cwd has no valid Git HEAD baseline. No diff can be shown; inspect files with independent read-only tools instead.";
const MAX_UNTRACKED_FILES = 50;

export interface WatchdogDiffBaseline {
	root: string;
	ref: string;
}

const WatchdogDiffParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Restrict the diff to one file or directory, relative to the repo root." })),
	stat: Type.Optional(Type.Boolean({ description: "Return per-file change counts instead of the full diff." })),
	baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Review committed changes from this ref's merge base with headRef (git diff baseRef...headRef). Omit for working-tree changes." })),
	headRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Committed range endpoint; requires baseRef. Defaults to reviewer-launch HEAD. Refs are pinned on first use; use read to inspect files only when the checkout matches this endpoint." })),
}, { additionalProperties: false });

type WatchdogDiffParams = Static<typeof WatchdogDiffParams>;

function runGit(root: string, args: string[]) {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf-8",
		env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() };
}

const BASELINE_ARGS = ["rev-parse", "--show-toplevel", "HEAD"];

function parseBaseline(stdout: string): WatchdogDiffBaseline | undefined {
	// HEAD is the last line; the repository path itself may contain newlines.
	const lines = stdout.trim().split(/\r?\n/);
	const ref = lines.pop();
	const root = lines.join("\n");
	return root && ref ? { root, ref } : undefined;
}

/** HEAD at reviewer launch, for tools that must be registered synchronously. */
export function captureWatchdogDiffBaseline(cwd: string): WatchdogDiffBaseline | undefined {
	const result = runGit(cwd, BASELINE_ARGS);
	return result.ok ? parseBaseline(result.stdout) : undefined;
}

/** HEAD at session start, so later child commits still show in the diff. Does not block the event loop. */
export function startWatchdogDiffBaselineCapture(cwd: string): Promise<WatchdogDiffBaseline | undefined> {
	return new Promise((resolve) => {
		// Node throws spawn errors such as EPERM synchronously instead of passing them to the callback.
		try {
			execFile("git", ["-C", cwd, ...BASELINE_ARGS], { encoding: "utf-8", windowsHide: true }, (error, stdout) => {
				resolve(error ? undefined : parseBaseline(stdout));
			});
		} catch {
			resolve(undefined);
		}
	});
}

function validatePath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("-")) throw new Error("watchdog_diff path must not start with '-'.");
	if (path.isAbsolute(trimmed)) throw new Error("watchdog_diff path must be relative to the repo root.");
	if (trimmed.split(/[\\/]/).includes("..")) throw new Error("watchdog_diff path must not contain '..'.");
	return trimmed;
}

function resolveRevision(root: string, ref: string, revisions: Map<string, string>): string {
	if (!ref || ref.length > 1024 || ref.startsWith("-") || Array.from(ref).some((character) => character <= " " || character === "\u007f")) {
		throw new Error("watchdog_diff received an invalid Git revision.");
	}
	const pinned = revisions.get(ref);
	if (pinned) return pinned;
	const result = runGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	if (!result.ok) throw new Error(`Cannot resolve Git revision ${JSON.stringify(ref)}: ${result.stderr || "unknown error"}`);
	const commit = result.stdout.trim();
	revisions.set(ref, commit);
	return commit;
}

function bound(text: string): string {
	if (text.length <= WATCHDOG_DIFF_MAX_CHARS) return text;
	const marker = `\n\n[... ${text.length - WATCHDOG_DIFF_MAX_CHARS} characters omitted; call again with a narrower path ...]`;
	return `${text.slice(0, WATCHDOG_DIFF_MAX_CHARS - marker.length)}${marker}`;
}

/** In a shared cwd, changes already pending when the session started also appear. */
export function createWatchdogDiffTool(
	baseline: WatchdogDiffBaseline | undefined,
	options: { workingTreeAtLaunch?: boolean } = {},
): AgentTool<typeof WatchdogDiffParams, { chars: number }> {
	const workingTreeAtLaunch = options.workingTreeAtLaunch === true;
	const revisions = new Map<string, string>(baseline ? [["HEAD", baseline.ref]] : []);
	return {
		name: WATCHDOG_DIFF_TOOL_NAME,
		label: "Watchdog diff",
		description: !baseline
			? "Report that a Git HEAD diff baseline is unavailable in this cwd. No diff is generated."
			: workingTreeAtLaunch
			? "Show staged and unstaged changes against reviewer-launch HEAD, plus untracked paths. Set baseRef to review committed baseRef...headRef changes instead, excluding working-tree changes; headRef defaults to launch HEAD. Refs are pinned on first use and resolved commits are reported. Optional path narrows either diff; stat:true returns per-file counts."
			: "Show changes since the review baseline, plus untracked paths. Set baseRef to review committed baseRef...headRef changes instead; headRef defaults to the captured baseline. Optional path narrows either diff; stat:true returns per-file counts.",
		parameters: WatchdogDiffParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: WatchdogDiffParams) {
			if (!baseline) {
				return { content: [{ type: "text", text: WATCHDOG_DIFF_UNAVAILABLE_BASELINE }], details: { chars: WATCHDOG_DIFF_UNAVAILABLE_BASELINE.length } };
			}
			const pathFilter = validatePath(params.path);
			if (params.headRef !== undefined && params.baseRef === undefined) throw new Error("headRef requires baseRef.");
			let range: { base: string; head: string; mergeBase: string } | undefined;
			if (params.baseRef !== undefined) {
				const base = resolveRevision(baseline.root, params.baseRef, revisions);
				const head = resolveRevision(baseline.root, params.headRef ?? "HEAD", revisions);
				const result = runGit(baseline.root, ["merge-base", "--all", base, head]);
				const bases = result.stdout.trim().split(/\r?\n/).filter(Boolean);
				if (!result.ok || bases.length !== 1) throw new Error("Cannot find a unique merge base for the requested committed range.");
				range = { base, head, mergeBase: bases[0]! };
			}
			const diff = runGit(baseline.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(params.stat === true ? ["--stat"] : []), range?.mergeBase ?? baseline.ref, ...(range ? [range.head] : []), "--", ...(pathFilter ? [pathFilter] : [])]);
			if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr || "unknown error"}`);
			if (range) {
				const text = bound(`Committed range: ${range.base}...${range.head}\nMerge base: ${range.mergeBase}\n\n${diff.stdout.trimEnd() || "No committed changes in this range."}`);
				return { content: [{ type: "text", text }], details: { chars: text.length } };
			}
			const untrackedResult = runGit(baseline.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(pathFilter ? [pathFilter] : [])]);
			if (workingTreeAtLaunch) {
				const currentHead = runGit(baseline.root, ["rev-parse", "HEAD"]);
				if (!currentHead.ok || currentHead.stdout.trim() !== baseline.ref) {
					const text = "Reviewer-launch HEAD changed or is unavailable. Relaunch the reviewer or use baseRef for a committed range.";
					return { content: [{ type: "text", text }], details: { chars: text.length } };
				}
			}
			const untracked = untrackedResult.ok ? untrackedResult.stdout.split("\0").filter(Boolean) : [];
			const sections = [diff.stdout.trimEnd()];
			if (untracked.length) {
				const shown = untracked.slice(0, MAX_UNTRACKED_FILES);
				sections.push(["Untracked files (use read to inspect):", ...shown.map((file) => ` ${file}`)].join("\n"));
				if (untracked.length > shown.length) sections.push(`... ${untracked.length - shown.length} more untracked files`);
			}
			const text = bound(sections.filter(Boolean).join("\n\n")) || (workingTreeAtLaunch
				? `No working-tree changes against reviewer-launch HEAD ${baseline.ref.slice(0, 12)}. Committed changes are not included.`
				: `No changes since baseline ${baseline.ref.slice(0, 12)}.`);
			return { content: [{ type: "text", text }], details: { chars: text.length } };
		},
	};
}
