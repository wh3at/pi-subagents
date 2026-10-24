import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureWatchdogDiffBaseline, createWatchdogDiffTool, startWatchdogDiffBaselineCapture, WATCHDOG_DIFF_MAX_CHARS } from "../../src/watchdog/diff-tool.ts";

let repo = "";

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

async function run(tool: ReturnType<typeof createWatchdogDiffTool>, params: { path?: string; stat?: boolean; baseRef?: string; headRef?: string } = {}): Promise<string> {
	const result = await tool.execute("call", params, undefined as never, undefined as never, undefined as never);
	return result.content.map((part) => (part as { text?: string }).text ?? "").join("\n");
}

describe("watchdog diff tool", () => {
	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-"));
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test User");
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
		fs.writeFileSync(path.join(repo, "README.md"), "readme\n", "utf-8");
		git("add", ".");
		git("commit", "-q", "-m", "base");
	});

	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("captures the session baseline and reports no changes when clean", async () => {
		const baseline = await startWatchdogDiffBaselineCapture(path.join(repo, "src"));
		assert.ok(baseline);
		assert.equal(fs.realpathSync.native(baseline.root), fs.realpathSync.native(repo), "git expands Windows 8.3 short names; compare native real paths");
		assert.equal(baseline.ref, git("rev-parse", "HEAD").trim());
		assert.match(await run(createWatchdogDiffTool(baseline)), /^No changes since baseline/);
		assert.equal(await startWatchdogDiffBaselineCapture(os.tmpdir()), undefined);
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-empty-"));
		execFileSync("git", ["init", "-q"], { cwd: empty });
		assert.equal(await startWatchdogDiffBaselineCapture(empty), undefined, "a repo without commits has no baseline");
		fs.rmSync(empty, { recursive: true, force: true });
	});

	it("has no baseline when git cannot be spawned at all", async () => {
		// A NUL byte makes execFile throw synchronously, the same path as Windows spawn EPERM.
		assert.equal(await startWatchdogDiffBaselineCapture(`${repo}\0`), undefined);
	});

	it("shows tracked changes since the baseline, including later commits, and lists untracked paths", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf-8");
		git("commit", "-q", "-am", "child commit");
		fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf-8");
		const tool = createWatchdogDiffTool(baseline);

		const full = await run(tool);
		assert.match(full, /-export const a = 1;/);
		assert.match(full, /\+export const a = 2;/);
		assert.match(full, /Untracked files \(use read to inspect\):\n src\/b\.ts/);
		assert.doesNotMatch(full, /export const b = 1;/);

		const stat = await run(tool, { stat: true });
		assert.match(stat, /src\/a\.ts \|/);
		assert.match(stat, /Untracked files \(use read to inspect\):\n src\/b\.ts/);

		const narrowed = await run(tool, { path: "README.md" });
		assert.doesNotMatch(narrowed, /a\.ts|b\.ts/);
	});

	it("shows staged and unstaged launch-HEAD changes while honestly excluding earlier commits", async () => {
		fs.writeFileSync(path.join(repo, "README.md"), "committed before reviewer launch\n", "utf-8");
		git("commit", "-q", "-am", "review target already committed");
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline, { workingTreeAtLaunch: true });

		const clean = await run(tool);
		assert.match(clean, /^No working-tree changes against reviewer-launch HEAD/);
		assert.match(clean, /Committed changes are not included\./);
		assert.doesNotMatch(clean, /committed before reviewer launch/);
		assert.match(tool.description, /Set baseRef to review committed/);

		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf-8");
		git("add", "src/a.ts");
		fs.writeFileSync(path.join(repo, "README.md"), "unstaged after reviewer launch\n", "utf-8");
		fs.writeFileSync(path.join(repo, "untracked.txt"), "inspect with read\n", "utf-8");
		const changed = await run(tool);
		assert.match(changed, /\+export const a = 2;/, "staged changes are included");
		assert.match(changed, /\+unstaged after reviewer launch/, "unstaged changes are included");
		assert.match(changed, /Untracked files \(use read to inspect\):\n untracked\.txt/);
		assert.equal(git("rev-parse", "HEAD").trim(), baseline.ref, "inspection does not move HEAD");
		assert.equal(git("status", "--short"), " M README.md\nM  src/a.ts\n?? untracked.txt\n", "inspection preserves staged, unstaged, and untracked state");
	});

	it("fails closed when HEAD advances after reviewer launch", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline, { workingTreeAtLaunch: true });
		fs.writeFileSync(path.join(repo, "README.md"), "committed after reviewer launch\n", "utf-8");
		git("commit", "-q", "-am", "advance HEAD");

		const result = await run(tool);
		assert.match(result, /^Reviewer-launch HEAD changed or is unavailable\./);
		assert.match(result, /Relaunch the reviewer or use baseRef for a committed range\./);
		assert.doesNotMatch(result, /committed after reviewer launch/);
	});

	it("reviews committed merge-base ranges without including base-only or working-tree changes", async () => {
		const common = git("rev-parse", "HEAD").trim();
		git("branch", "review-base");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		git("commit", "-q", "-am", "feature");
		const head = git("rev-parse", "HEAD").trim();
		git("checkout", "-q", "review-base");
		fs.writeFileSync(path.join(repo, "README.md"), "base-only change\n");
		git("commit", "-q", "-am", "base advanced");
		git("checkout", "-q", "--detach", head);
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 3;\n");
		git("add", "src/a.ts");
		fs.writeFileSync(path.join(repo, "README.md"), "unstaged change\n");
		fs.writeFileSync(path.join(repo, "untracked.txt"), "not committed\n");
		const status = git("status", "--porcelain");
		const result = await run(tool, { baseRef: "review-base" });
		assert.match(result, /\+export const a = 2;/);
		assert.doesNotMatch(result, /base-only change|unstaged change|untracked.txt|export const a = 3/);
		assert.ok(result.includes(`Merge base: ${common}`));
		assert.ok(result.includes(`...${head}`));
		assert.equal(git("status", "--porcelain"), status);
		assert.equal(git("rev-parse", "HEAD").trim(), head);
		const narrowed = await run(tool, { baseRef: "review-base", path: "README.md" });
		assert.match(narrowed, /No committed changes/);
		const stat = await run(tool, { baseRef: "review-base", stat: true });
		assert.match(stat, /src\/a\.ts \|/);
	});

	it("pins branch names and launch HEAD across narrowed calls and later commits", async () => {
		git("branch", "review-base");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		git("commit", "-q", "-am", "reviewed feature");
		git("branch", "review-head");
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		const initial = await run(tool, { baseRef: "review-base", headRef: "review-head" });
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 3;\n");
		git("commit", "-q", "-am", "later feature");
		git("branch", "-f", "review-base", "HEAD");
		git("branch", "-f", "review-head", "HEAD");
		assert.equal(await run(tool, { baseRef: "review-base", headRef: "review-head", path: "src/a.ts" }), initial);
		const launchHead = await run(tool, { baseRef: "HEAD~2" });
		assert.match(launchHead, /\+export const a = 2;/);
		assert.doesNotMatch(launchHead, /export const a = 3/);
	});

	it("accepts commit IDs, annotated tags, and explicit historical heads", async () => {
		const base = git("rev-parse", "HEAD").trim();
		git("tag", "-a", "review-base", "-m", "base tag");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		git("commit", "-q", "-am", "reviewed feature");
		git("tag", "review-head");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 3;\n");
		git("commit", "-q", "-am", "later feature");
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		const result = await run(tool, { baseRef: "review-base", headRef: "review-head" });
		assert.equal(await run(tool, { baseRef: base, headRef: "HEAD~1" }), result);
		assert.match(result, /\+export const a = 2;/);
		assert.doesNotMatch(result, /export const a = 3/);
	});

	it("rejects invalid revisions and unrelated histories rather than falling back to a working-tree diff", async () => {
		git("branch", "review-base");
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		for (const ref of ["", "-R", "HEAD\n", "HEAD\0", "x".repeat(1025)]) {
			await assert.rejects(() => run(tool, { baseRef: ref }), /invalid Git revision/);
			await assert.rejects(() => run(tool, { baseRef: "HEAD", headRef: ref }), /invalid Git revision/);
		}
		await assert.rejects(() => run(tool, { headRef: "HEAD" }), /headRef requires baseRef/);
		await assert.rejects(() => run(tool, { baseRef: "missing-ref" }), /Cannot resolve Git revision/);
		await assert.rejects(() => run(tool, { baseRef: "HEAD", headRef: "missing-ref" }), /Cannot resolve Git revision/);
		await assert.rejects(() => run(tool, { baseRef: "HEAD:README.md" }), /Cannot resolve Git revision/);
		await assert.rejects(() => run(tool, { baseRef: "HEAD", path: "../etc" }), /must not contain/);
		git("checkout", "-q", "--orphan", "unrelated");
		git("commit", "-q", "--allow-empty", "-m", "unrelated root");
		await assert.rejects(() => run(tool, { baseRef: "review-base", headRef: "unrelated" }), /Cannot find a unique merge base/);
	});

	it("rejects ambiguous criss-cross merge bases instead of choosing one silently", async () => {
		const root = git("rev-parse", "HEAD").trim();
		const tree = git("rev-parse", "HEAD^{tree}").trim();
		const left = git("commit-tree", tree, "-p", root, "-m", "left").trim();
		const right = git("commit-tree", tree, "-p", root, "-m", "right").trim();
		const baseRef = git("commit-tree", tree, "-p", left, "-p", right, "-m", "left merge").trim();
		const headRef = git("commit-tree", tree, "-p", right, "-p", left, "-m", "right merge").trim();
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		await assert.rejects(() => run(tool, { baseRef, headRef }), /Cannot find a unique merge base/);
	});

	it("bounds committed diffs and disables external diff and textconv programs", async () => {
		const base = git("rev-parse", "HEAD").trim();
		fs.writeFileSync(path.join(repo, ".gitattributes"), "*.ts diff=probe\n");
		fs.writeFileSync(path.join(repo, "probe.cjs"), "require('node:fs').writeFileSync('program-ran', 'unexpected'); process.stdout.write('converted');\n");
		git("config", "diff.probe.textconv", "node ./probe.cjs");
		git("config", "diff.external", "node ./probe.cjs");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const line = 1;\n".repeat(3000));
		git("add", ".");
		git("commit", "-q", "-m", "large change");
		const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(repo)!, { workingTreeAtLaunch: true });
		const result = await run(tool, { baseRef: base });
		assert.ok(result.length <= WATCHDOG_DIFF_MAX_CHARS);
		assert.match(result, /characters omitted; call again with a narrower path/);
		assert.equal(fs.existsSync(path.join(repo, "program-ran")), false);
	});

	it("does not fetch missing objects from a partial clone", async () => {
		const base = git("rev-parse", "HEAD").trim();
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		git("commit", "-q", "-am", "feature");
		git("config", "uploadpack.allowFilter", "true");
		const clone = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-partial-clone-"));
		try {
			execFileSync("git", ["clone", "--quiet", "--no-checkout", "--filter=blob:none", "--no-local", repo, clone], { stdio: "pipe" });
			const packs = path.join(clone, ".git", "objects", "pack");
			const before = fs.readdirSync(packs).sort();
			const tool = createWatchdogDiffTool(captureWatchdogDiffBaseline(clone)!, { workingTreeAtLaunch: true });
			await assert.rejects(() => run(tool, { baseRef: base }), /git diff failed/);
			assert.deepEqual(fs.readdirSync(packs).sort(), before);
		} finally {
			fs.rmSync(clone, { recursive: true, force: true });
		}
	});

	it("rejects traversal and option-like paths and bounds large diffs", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline);
		await assert.rejects(() => run(tool, { path: "../etc" }), /must not contain '\.\.'/);
		await assert.rejects(() => run(tool, { path: "-R" }), /must not start with '-'/);
		await assert.rejects(() => run(tool, { path: "/etc/hosts" }), /relative/);

		fs.writeFileSync(path.join(repo, "src", "a.ts"), `${"export const line = 1;\n".repeat(3_000)}`, "utf-8");
		const bounded = await run(tool);
		assert.ok(bounded.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${bounded.length}`);
		assert.match(bounded, /characters omitted; call again with a narrower path/);

		for (let index = 0; index < 52; index++) fs.writeFileSync(path.join(repo, `untracked-${String(index).padStart(2, "0")}.txt`), "x", "utf-8");
		const inventory = await run(tool, { stat: true });
		assert.match(inventory, /\.\.\. 2 more untracked files/);
		assert.equal((inventory.match(/^ untracked-/gm) ?? []).length, 50);
	});
});
