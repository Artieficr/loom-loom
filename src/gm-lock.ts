import { App, TFile } from 'obsidian';
import { setLoomKey } from './fm';
import { LoomIndexer } from './indexer';
import { EntityRecord, EventKind, FM, SpecialCondition, SpecialConditionGroup } from './types';

/**
 * Resolves once `app.metadataCache` has actually re-parsed `file` — NOT just
 * once a `processFrontMatter` write's own promise resolves. A real, reported
 * bug this fixes: `processFrontMatter`'s promise settles once the WRITE
 * lands on disk, but Obsidian's metadataCache re-parses the new frontmatter
 * on its own subsequent tick — reading `LoomIndexer`'s cached records (or
 * calling `rebuildNow`, which itself only re-reads whatever `metadataCache`
 * currently has, stale or not) immediately after a write could still see
 * the PRE-write value. Concretely: deleting a Special Condition that was
 * locking an event recomputed against the just-deleted condition's stale
 * cached copy, found nothing changed, and left the event stuck locked until
 * some LATER, unrelated write finally landed after the cache had caught up.
 * A capped timeout is a safety net only (an edit that produces byte-
 * identical frontmatter never fires `'changed'` at all).
 */
export function waitForMetadataSync(app: App, file: TFile, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = app.metadataCache.on('changed', (f) => {
			if (f.path === file.path) finish();
		});
		const timer = window.setTimeout(finish, timeoutMs);
	});
}

/**
 * GM projects: the Event lock evaluator (`FM.eventKind`'s `locked` value +
 * `FM.eventLockReasons`) — see ROADMAP.md's "Game Master" entry for the full
 * design. Pure evaluation, no vault access; `recomputeEventLocks` below is
 * the only function that writes.
 *
 * Only `planned`/`locked`/`''` events are ever evaluated — a `happened` or
 * `lore` event is frozen and never re-checked. This is also what makes an
 * event's history stay correct without any date/session bookkeeping in the
 * evaluator itself: an event that already happened while a condition's
 * target character was alive keeps its `happened` status forever, even
 * after that character dies later — it simply never gets re-evaluated
 * again. Only a still-`planned` event re-checks against the character's
 * CURRENT `alive` flag, which is exactly "any future event citing that
 * character locks once the death is recorded."
 */

function conditionSatisfied(cond: SpecialCondition, event: EntityRecord, indexer: LoomIndexer, projectRoot: string): boolean {
	const target = cond.target !== '' ? indexer.resolve(cond.target, event.path) : null;
	if (!target) return false;
	switch (cond.type) {
		case 'characterAlive':
			return target.type === 'character' && target.alive;
		case 'groupCarriesItem':
			if (target.type !== 'item') return false;
			return indexer
				.getGroupMembers(projectRoot)
				.some((pc) => pc.items.some((lp) => indexer.resolve(lp, pc.path)?.path === target.path));
		case 'eventHappened':
			return target.type === 'event' && target.eventKind === 'happened';
		case 'decisionPointHappened':
			if (target.type !== 'decisionPoint') return false;
			return indexer
				.getAll('event', projectRoot)
				.some(
					(e) =>
						e.eventKind === 'happened' &&
						e.decisionPoint !== null &&
						indexer.resolve(e.decisionPoint, e.path)?.path === target.path
				);
	}
}

/** A condition row with no target picked yet — e.g. the instant "+ Add a
 *  condition" creates a fresh row, before the user has chosen what it checks
 *  against. Never treated as a real, failing condition (see `groupComplete`'s
 *  own doc comment for why) — `conditionSatisfied` already reads it as
 *  unsatisfied on its own, which is right for "can this group satisfy", but
 *  wrong for "should this group's incompleteness itself lock the event". */
function conditionComplete(cond: SpecialCondition): boolean {
	return cond.target !== '';
}

/** A group only counts toward locking once every condition in it has a
 *  target picked — an incomplete group (still mid-edit) is neither satisfied
 *  NOR a lock reason; it's simply not evaluated yet. Without this, adding a
 *  fresh condition row locked the event the instant its TYPE was picked,
 *  before the user had a chance to choose what it checks against. */
function groupComplete(group: SpecialConditionGroup): boolean {
	return group.conditions.length > 0 && group.conditions.every(conditionComplete);
}

function groupSatisfied(group: SpecialConditionGroup, event: EntityRecord, indexer: LoomIndexer, projectRoot: string): boolean {
	return groupComplete(group) && group.conditions.every((c) => conditionSatisfied(c, event, indexer, projectRoot));
}

/** Every currently-failing condition across every COMPLETE group, as
 *  `condition:<groupIndex>:<conditionIndex>` codes (indices into the FULL
 *  `groups` array, incomplete ones included, so a reason code always still
 *  addresses the right row) — only ever consulted once every complete group
 *  has failed (an event locks on Special Conditions only when NONE of its
 *  OR'd, fully-specified groups are satisfied; a still-incomplete group is
 *  skipped entirely rather than treated as failing — see `groupComplete`). */
function failingConditionReasons(
	groups: SpecialConditionGroup[],
	event: EntityRecord,
	indexer: LoomIndexer,
	projectRoot: string
): string[] {
	const reasons: string[] = [];
	groups.forEach((g, gi) => {
		if (!groupComplete(g)) return;
		g.conditions.forEach((c, ci) => {
			if (!conditionSatisfied(c, event, indexer, projectRoot)) reasons.push(`condition:${gi}:${ci}`);
		});
	});
	return reasons;
}

export interface LockResult {
	eventKind: EventKind;
	reasons: string[];
}

/** What one event's `eventKind`/lock reasons should be right now. Only
 *  meaningful for an event whose CURRENT `eventKind` is `planned`/`locked`/
 *  `''` — see this file's own doc comment. Exported so a caller editing an
 *  event's OWN `specialConditions`/`decisionPoint` (entity-view.tsx's
 *  `commitSpecialConditions`) can compute the new lock state synchronously,
 *  in memory, and write it in the SAME `processFrontMatter` transaction as
 *  the edit itself — sidestepping `recomputeEventLocks`'s own async
 *  metadataCache round trip entirely for a self-edit, rather than waiting on
 *  it (bounded by `waitForMetadataSync`, but not instant) to reflect back.
 *  Only valid for THIS one event's own fields; anything cascading onto OTHER
 *  events (a decision point's sibling "happened", a character's alive flag)
 *  still needs the real project-wide `recomputeEventLocks` pass, since this
 *  function never writes anywhere else. */
export function evaluateEvent(event: EntityRecord, indexer: LoomIndexer, projectRoot: string): LockResult {
	const reasons: string[] = [];
	if (event.decisionPoint !== null) {
		const dp = indexer.resolve(event.decisionPoint, event.path);
		if (dp) {
			const siblingHappened = indexer
				.getAll('event', projectRoot)
				.some(
					(e) =>
						e.path !== event.path &&
						e.eventKind === 'happened' &&
						e.decisionPoint !== null &&
						indexer.resolve(e.decisionPoint, e.path)?.path === dp.path
				);
			if (siblingHappened) reasons.push('cascade');
		}
	}
	if (event.specialConditions.length > 0) {
		const anySatisfied = event.specialConditions.some((g) => groupSatisfied(g, event, indexer, projectRoot));
		if (!anySatisfied) reasons.push(...failingConditionReasons(event.specialConditions, event, indexer, projectRoot));
	}
	return { eventKind: reasons.length > 0 ? 'locked' : 'planned', reasons };
}

function reasonsEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((r, i) => r === b[i]);
}

/**
 * Recomputes every event's lock state in one project-wide pass and writes
 * back only the ones that actually changed. Called explicitly from the
 * handful of edit points that can affect locking (an event's own status/
 * decision point/special conditions, a character's Alive tick or death
 * session, an item's holder list) — never from graph/timeline rendering,
 * which only ever read the stored result. A full pass rather than a
 * fine-grained reactive dependency graph: a campaign's event count is small
 * enough this is cheap, and it sidesteps chasing dependency chains through
 * the `eventHappened`/`decisionPointHappened` condition types.
 */
export async function recomputeEventLocks(app: App, indexer: LoomIndexer, projectRoot: string): Promise<void> {
	const events = indexer.getAll('event', projectRoot);
	for (const event of events) {
		if (event.eventKind === 'happened' || event.eventKind === 'lore') continue;
		const result = evaluateEvent(event, indexer, projectRoot);
		if (result.eventKind === (event.eventKind || 'planned') && reasonsEqual(result.reasons, event.eventLockReasons)) {
			continue;
		}
		const f = app.vault.getFileByPath(event.path);
		if (!f) continue;
		try {
			await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.eventKind, result.eventKind);
				setLoomKey(fm, FM.eventLockReasons, result.reasons);
			});
		} catch (e) {
			console.error('Loom Loom: failed to update an event lock state', e);
		}
	}
}
