import { EntityRecord, TimelineDef } from './types';
import { LoomIndexer } from './indexer';

/**
 * One column of the chronological layout: a session (or an event that isn't
 * connected to any session) anchoring the column, with the session's
 * connected events stacked beneath it. Both the timeline view and the graph
 * view derive horizontal ordering from this, so the two stay consistent by
 * construction. Session membership is any connection between the event and
 * the session — a typed relationship (declared on either side) or a plain
 * [[wikilink]]; events respect sessions above all other connections.
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
	const sessions = indexer
		.getAll('session', projectRoot)
		.filter((r) => matchesDef(r, def) && allow(r));
	const events = indexer.getAll('event', projectRoot).filter((r) => matchesDef(r, def) && allow(r));

	const columns = new Map<string, TimelineColumn>();
	for (const session of sessions) {
		columns.set(session.path, { anchor: session, events: [] });
	}

	const anchors: EntityRecord[] = [...sessions];
	for (const event of events) {
		// An event can span several sessions — it stacks in every matching
		// column (the def filter may exclude some of its sessions).
		const seen = new Set<string>();
		const eventColumns = indexer
			.getConnections(event.path)
			.filter((c) => c.record.type === 'session')
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

	anchors.sort(bySortKey);
	const result: TimelineColumn[] = [];
	for (const anchor of anchors) {
		const column = columns.get(anchor.path);
		if (!column) continue;
		column.events.sort(bySortKey);
		result.push(column);
	}
	return result;
}
