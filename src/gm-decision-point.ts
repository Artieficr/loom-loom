import { App } from 'obsidian';
import { clearFmKeys, fmLoomValue, setLoomKey } from './fm';
import { LoomIndexer, linkTargetOf } from './indexer';
import { EntityRecord, FM } from './types';

/**
 * GM projects: a Decision Point's own session (`FM.decisionPointSession`) and
 * how it reconciles with its member events' own sessions — see ROADMAP.md's
 * "Game Master" entry ("Decision Point owns its own Session field") for the
 * design. Two directions, deliberately asymmetric:
 *
 * - Setting a Decision Point's session cascades it onto every member event's
 *   own session unconditionally (`cascadeDecisionPointSession`) — a direct,
 *   explicit action, no confirmation needed.
 * - Linking an event that already has a DIFFERENT session to a Decision Point
 *   that already has one is a real conflict (`reconcileSessionBeforeLink`
 *   returns it instead of silently picking a side) — the caller has to ask.
 *   When only ONE side has a session set, the unset side just adopts it, no
 *   asking needed.
 */

/** An event's own current session — its first `sessionNotes` entry's session,
 *  resolved, or null. An event can technically carry more than one session
 *  note; only the first is treated as "the" session for this reconciliation. */
export function eventSessionOf(event: EntityRecord, indexer: LoomIndexer): EntityRecord | null {
	const target = event.sessionNotes[0]?.session ?? null;
	return target ? indexer.resolve(target, event.path) : null;
}

/**
 * Writes `sessionTarget` (a link target string, or null to clear) as an
 * event's own session. Updates the first `sessionNotes` entry in place when
 * one exists (its text/involved/places/seq survive untouched); creates a
 * bare one when the event had none yet. A no-op when clearing an event that
 * had no session note to begin with. Returns whether the write succeeded —
 * errors are logged here (this module has no UI context to show a Notice
 * from — it's called from both the Event page and the Decision Point's own
 * list-view context menu, which want different messaging), leaving the
 * caller free to surface a Notice against its own copy.
 */
export async function setEventSession(app: App, event: EntityRecord, sessionTarget: string | null): Promise<boolean> {
	const f = app.vault.getFileByPath(event.path);
	if (!f) return false;
	try {
		await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			const cur = fmLoomValue(fm, FM.sessionNotes);
			const arr = Array.isArray(cur) ? [...(cur as unknown[])] : [];
			const sessionValue = sessionTarget === null ? '' : `[[${sessionTarget}]]`;
			if (arr.length === 0) {
				if (sessionTarget === null) return;
				arr.push({ session: sessionValue, text: '', seq: Date.now() });
			} else {
				arr[0] = { ...(arr[0] as Record<string, unknown>), session: sessionValue };
			}
			setLoomKey(fm, FM.sessionNotes, arr);
		});
		return true;
	} catch (e) {
		console.error('Loom Loom: failed to update an event session', e);
		return false;
	}
}

/** Every event currently linked to this decision point via their own
 *  `decisionPoint` field. */
export function decisionPointEventsOf(dp: EntityRecord, indexer: LoomIndexer): EntityRecord[] {
	return indexer
		.getAll('event', dp.project)
		.filter((e) => e.decisionPoint !== null && indexer.resolve(e.decisionPoint, e.path)?.path === dp.path);
}

/**
 * Writes a Decision Point's own session and cascades it onto every member
 * event's own session — the one direction that overwrites unconditionally.
 * Clearing the session (`sessionTarget === null`) does NOT clear member
 * events' own sessions in turn; only a forward assignment cascades. Returns
 * whether EVERY write succeeded (the Decision Point's own, plus every member
 * event's) — a mid-loop failure doesn't abort the cascade (later members
 * still get their own attempt), but the caller learns at least one member
 * was left out of sync and can surface a Notice. See `setEventSession`'s own
 * doc comment for why errors are only logged here, not shown to the user.
 */
export async function cascadeDecisionPointSession(
	app: App,
	indexer: LoomIndexer,
	dp: EntityRecord,
	sessionTarget: string | null
): Promise<boolean> {
	const dpFile = app.vault.getFileByPath(dp.path);
	if (!dpFile) return false;
	try {
		await app.fileManager.processFrontMatter(dpFile, (fm: Record<string, unknown>) => {
			if (sessionTarget === null) clearFmKeys(fm, 'loomdecisionpointsession', 'decisionpointsession');
			else setLoomKey(fm, FM.decisionPointSession, `[[${sessionTarget}]]`);
		});
	} catch (e) {
		console.error('Loom Loom: failed to update a decision point session', e);
		return false;
	}
	if (sessionTarget === null) return true;
	let allOk = true;
	for (const ev of decisionPointEventsOf(dp, indexer)) {
		const ok = await setEventSession(app, ev, sessionTarget);
		if (!ok) allOk = false;
	}
	return allOk;
}

/** A real session conflict between a Decision Point and an event about to
 *  join it — both sides already have a session, and they differ. */
export interface SessionConflict {
	dp: EntityRecord;
	event: EntityRecord;
	dpSession: EntityRecord;
	eventSession: EntityRecord;
}

/**
 * Call before actually linking `event` to `dp` (either direction — the DP
 * page's own "Add event" picker, or the event page's own Decision Point
 * field). Auto-resolves the two no-conflict cases in place (one side unset
 * just adopts the other's session) and returns `null` — the caller then
 * proceeds straight to writing the `decisionPoint` link itself. Returns a
 * `SessionConflict` instead when both sides already have a DIFFERENT
 * session, for the caller to show a resolution prompt; nothing is written
 * in that case, including the `decisionPoint` link itself — the whole link
 * action waits on that choice.
 */
export async function reconcileSessionBeforeLink(
	app: App,
	indexer: LoomIndexer,
	dp: EntityRecord,
	event: EntityRecord
): Promise<SessionConflict | null> {
	const dpSession = dp.decisionPointSession !== null ? indexer.resolve(dp.decisionPointSession, dp.path) : null;
	const eventSession = eventSessionOf(event, indexer);
	if (dpSession && eventSession) {
		if (dpSession.path === eventSession.path) return null;
		return { dp, event, dpSession, eventSession };
	}
	if (!dpSession && eventSession) {
		await cascadeDecisionPointSession(app, indexer, dp, linkTargetOf(eventSession));
	} else if (dpSession && !eventSession) {
		await setEventSession(app, event, linkTargetOf(dpSession));
	}
	return null;
}
