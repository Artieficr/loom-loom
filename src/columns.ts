import { EntityRecord, TimelineDef } from './types';
import { LoomIndexer } from './indexer';
import { features, projectRoleType } from './project-kind';

/**
 * One column of the chronological layout: an anchor (a Session in a player/GM
 * project, an Act in a writer one — or a stray beat connected to no anchor)
 * owning the column, with its connected beats (Events / Scenes) stacked
 * beneath. Both the timeline view and the graph view derive horizontal
 * ordering from this, so the two stay consistent by construction. Membership
 * is any connection between the beat and the anchor — a typed relationship
 * (declared on either side) or a plain [[wikilink]]; beats respect their
 * anchor above all other connections.
 *
 * Which types play those roles comes from the project's kind, never from a
 * literal here — see project-kind.ts.
 */
export interface TimelineColumn {
	anchor: EntityRecord;
	events: EntityRecord[];
}

function bySortKey(a: EntityRecord, b: EntityRecord): number {
	const ka = a.date?.sortKey ?? Number.POSITIVE_INFINITY;
	const kb = b.date?.sortKey ?? Number.POSITIVE_INFINITY;
	return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
}

/** Anchors that aren't dated (acts) order by their manual `loomSeq` stamp,
 *  falling back to creation order so an unstamped one still lands sensibly. */
function bySequence(a: EntityRecord, b: EntityRecord): number {
	const ka = a.seq ?? a.created;
	const kb = b.seq ?? b.created;
	return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
}

function matchesDef(record: EntityRecord, def: TimelineDef | null): boolean {
	if (!def) return true;
	if (!def.types.includes(record.type)) return false;
	if (def.tags.length > 0 && !def.tags.some((t) => record.loomTags.includes(t))) return false;
	return true;
}

export function buildColumns(
	indexer: LoomIndexer,
	def: TimelineDef | null,
	projectRoot: string,
	/** When set, only sessions/events whose path is in it are placed — used by
	 *  the graph's "separate graph" filter to lay out a hand-picked subgraph. */
	restrictTo?: ReadonlySet<string>
): TimelineColumn[] {
	const allow = (r: EntityRecord) => restrictTo === undefined || restrictTo.has(r.path);
	const config = indexer.getProjectByRoot(projectRoot)?.config;
	const anchorType = projectRoleType(config, 'anchor');
	// Writer/Prose has no beat type at all (a Chapter has no smaller
	// structural unit beneath it — see project-kind.ts's `TypeRole` doc
	// comment), so there's simply nothing to gather here in that case.
	const beatType = projectRoleType(config, 'beat');
	const sessions = indexer
		.getAll(anchorType, projectRoot)
		.filter((r) => matchesDef(r, def) && allow(r));
	const events =
		beatType === null ? [] : indexer.getAll(beatType, projectRoot).filter((r) => matchesDef(r, def) && allow(r));

	const columns = new Map<string, TimelineColumn>();
	for (const session of sessions) {
		columns.set(session.path, { anchor: session, events: [] });
	}

	const anchors: EntityRecord[] = [...sessions];
	for (const event of events) {
		// A beat can span several anchors — it stacks in every matching column
		// (the def filter may exclude some of them).
		const seen = new Set<string>();
		const eventColumns = indexer
			.getConnections(event.path)
			.filter((c) => c.record.type === anchorType)
			.filter((c) => (seen.has(c.record.path) ? false : (seen.add(c.record.path), true)))
			.map((c) => columns.get(c.record.path))
			.filter((c): c is TimelineColumn => c !== undefined);
		if (eventColumns.length > 0) {
			for (const column of eventColumns) column.events.push(event);
		} else {
			columns.set(event.path, { anchor: event, events: [] });
			anchors.push(event);
		}
	}

	// A stray beat anchoring its own column is sorted the same way as the real
	// anchors — by date where anchors are dated, by sequence where they aren't.
	anchors.sort(features(config).anchorOrder === 'sequence' ? bySequence : bySortKey);
	const result: TimelineColumn[] = [];
	for (const anchor of anchors) {
		const column = columns.get(anchor.path);
		if (!column) continue;
		column.events.sort(bySortKey);
		result.push(column);
	}
	return result;
}
