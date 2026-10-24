import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
const tick = () => sleep(5);
import registerNotify, { PENDING_NOTICE_ENTRY, unreplayedPendingNotices } from "../../src/runs/background/notify.ts";

type Entry = { type: string; customType?: string; content?: unknown; data?: unknown };

// One session file shared by successive Pi processes. `appended` false is a busy parent:
// Pi queues the notice as a steer, which it drops if the process ends before starting it.
// `abandoned` holds entries on another branch of the session tree: in the file, but not on the active branch.
function session() {
	const id = randomUUID();
	const entries: Entry[] = [];
	const abandoned: Entry[] = [];
	return { entries, abandoned, manager: () => ({ getSessionId: () => id, getEntries: () => [...entries, ...abandoned], getBranch: () => entries }) };
}

// A reload keeps Pi's session manager object; a new process creates a new one.
function processOn(file: ReturnType<typeof session>, appended = false, manager = file.manager()) {
	const sent: Array<{ message: any; options: any }> = [];
	const notifier = registerNotify({
		events: { on: () => () => {} }, isHeld: () => false, on: () => () => {},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
			if (appended) file.entries.push({ type: "custom_message", customType: message.customType, content: message.content });
			return appended;
		},
		appendEntry(customType: string, data: unknown) { file.entries.push({ type: "custom", customType, data }); },
	} as never, { currentSessionId: manager.getSessionId(), completionOwnerId: randomUUID() }, { batchConfig: { enabled: false }, ownership: { owns: () => true, claimedSessionIds: () => [] } });
	return {
		notifier, sent, manager,
		bind: () => notifier.bindSession(manager),
		deliver: (runId = randomUUID()) => notifier.deliver({
			id: runId, runId, sessionId: manager.getSessionId(), completionOwnerId: "owner",
			success: true, agent: "worker", summary: "Saved report ready.",
		}),
		quit() { notifier.sessionShutdown("quit"); notifier.dispose(); },
	};
}

it("resends a notice whose wake Pi never started when the next process opens the session", async () => {
	const file = session();
	const runId = randomUUID();
	const first = processOn(file);
	first.bind();
	assert.equal(await first.deliver(runId), true);
	assert.equal(first.sent[0]!.options.triggerTurn, true);
	first.quit();
	assert.equal(unreplayedPendingNotices(file.entries).length, 1, "shutdown records the unstarted notice in the session");

	const second = processOn(file, true);
	second.bind();
	assert.equal(second.sent.length, 0, "the resend waits until session_start has returned");
	await tick();
	try {
		assert.equal(second.sent.length, 1, "the next process resends it");
		assert.equal(second.sent[0]!.options.triggerTurn, true);
		assert.equal(second.sent[0]!.message.content, first.sent[0]!.message.content);
		assert.deepEqual(second.sent[0]!.message.details, first.sent[0]!.message.details);
		assert.equal(second.sent[0]!.message.details.runs[0].runId, runId);
		assert.equal(unreplayedPendingNotices(file.entries).length, 0);
	} finally {
		second.quit();
	}
	const third = processOn(file, true);
	third.bind();
	await tick();
	try {
		assert.equal(third.sent.length, 0, "a notice already in the session is not sent again");
	} finally {
		third.quit();
	}
});

it("resends a pending notice that only another branch of the session carries", async () => {
	const file = session();
	const first = processOn(file);
	first.bind();
	await first.deliver();
	first.quit();
	file.abandoned.push({ type: "custom_message", customType: "subagent-notify", content: first.sent[0]!.message.content });
	const second = processOn(file, true);
	second.bind();
	await tick();
	try {
		assert.equal(second.sent.length, 1, "a resend on an abandoned branch does not cancel the active branch's notice");
	} finally {
		second.quit();
	}
});

it("records nothing for a notice Pi started or an idle parent appended", async () => {
	const started = session();
	const busy = processOn(started);
	busy.bind();
	await busy.deliver();
	busy.notifier.messageStarted({ ...busy.sent[0]!.message, role: "custom" });
	busy.quit();
	assert.equal(started.entries.filter((entry) => entry.customType === PENDING_NOTICE_ENTRY).length, 0);

	const idle = session();
	const host = processOn(idle, true);
	host.bind();
	await host.deliver();
	host.quit();
	assert.equal(idle.entries.filter((entry) => entry.customType === PENDING_NOTICE_ENTRY).length, 0);
});

it("keeps a queued notice through reload and records it when the session later quits", async () => {
	const file = session();
	const first = processOn(file);
	first.bind();
	await first.deliver();
	first.notifier.sessionShutdown("reload");
	first.notifier.dispose();
	assert.equal(unreplayedPendingNotices(file.entries).length, 0, "reload keeps Pi\x27s queue, so nothing is recorded");
	const reloaded = processOn(file, false, first.manager);
	reloaded.bind();
	await tick();
	assert.equal(reloaded.sent.length, 0, "reload does not resend");
	reloaded.quit();
	const [pending] = unreplayedPendingNotices(file.entries);
	assert.equal(pending?.content, first.sent[0]!.message.content);
	assert.deepEqual(pending?.details, first.sent[0]!.message.details);
});
