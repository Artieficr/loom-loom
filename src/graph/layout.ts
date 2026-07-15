import { EntityRecord, EntityType } from '../types';
import { buildColumns } from '../columns';
import { LoomIndexer } from '../indexer';
import { EdgeRoute, LANE_EPSILON, RoutedEdge } from './routing';

export type NodeKind = 'session' | 'event' | 'global';

export interface LayoutNode {
	id: string;
	record: EntityRecord;
	/** Home position the node springs back to. */
	x: number;
	y: number;
	kind: NodeKind;
	/** Vertical zone: 0 = timeline rows, k ≥ 1 = global layer k−1. */
	zone: number;
}

export interface GraphLayout {
	nodes: LayoutNode[];
	edges: RoutedEdge[];
	neighbors: Map<string, Set<string>>;
	width: number;
	height: number;
}

const COL_WIDTH = 170;
const MARGIN_X = 110;
const SESSION_Y = 80;
const EVENT_Y0 = 180;
const EVENT_DY = 90;
const GLOBAL_MIN_SPACING = 130;
/** Min horizontal distance (px) between a multi-session event and other nodes in its row. */
const MULTI_CLEARANCE = 100;

/** Distance between parallel vertical trunk lanes in a corridor. */
const LANE_GAP = 10;
/** Distance between parallel horizontal lanes in a band. */
const Y_GAP = 10;
/** x padding a corridor keeps around its lane block. */
const CORRIDOR_PAD = 35;
/** Horizontal spread between neighboring diagonal fan entries into one node. */
const FAN_GAP = 14;
/** Max |fanOffset| so wide fans don't reach into row neighbors. */
const FAN_MAX = 55;
/** x clearance a trunk keeps from any node center it passes. */
const TRUNK_CLEAR = 26;
/** Minimum height of the band between two rows (the old globals gap). */
const MIN_BAND = 140;
/** Band top inset before the first U lane (clears the upper row's labels). */
const U_TOP = 48;
/** Band bottom inset from the lower row to the base approach line. */
const APPROACH_BOTTOM = 36;
/** Gap between the U-lane block and the approach-lane block of one band. */
const BAND_MID = 24;

interface RawEdge {
	a: string;
	b: string;
	relType: string;
}

interface Placement {
	nodes: Map<string, LayoutNode>;
	/** Final x of each timeline column. */
	colX: number[];
	/** Timeline node id → its column index (multi-session events: nearest). */
	colOf: Map<string, number>;
	/** Baseline below the deepest event stack; global bands start here. */
	eventsBottom: number;
	/** Global rows top→bottom (only non-empty layer types). */
	layers: LayoutNode[][];
}

type EdgeKind = 'direct' | 'orth' | 'toLower' | 'rowU';

interface CEdge {
	upper: LayoutNode;
	lower: LayoutNode;
	relType: string;
	kind: EdgeKind;
	/** Band index a rowU belongs to; -1 = the band above the sessions row. */
	uBand: number;
	corridor: number | null;
	laneX: number;
	approachY: number;
	fanOffset: number;
	uY: number;
	needsRun: boolean;
}

/**
 * Layered layout with orthogonal edge routing:
 * - row 0: sessions, ordered chronologically (same column order as the
 *   timeline strip — both derive from `buildColumns`);
 * - row 1: events, stacked beneath their linked session's column; events
 *   linked to several sessions centered between them; unlinked events
 *   anchoring their own column;
 * - below: one row per global entity type, order configurable in settings;
 *   x is the barycenter of each node's connections with a min-spacing sweep.
 *
 * Edges are routed orthogonally (see routing.ts): trunk lanes live in the
 * corridors between columns, which widen to fit their lane count (`the
 * "spread branching-heavy columns" rule`); horizontal runs and same-row U
 * shapes get per-edge y-lanes in the bands between rows; the lower endpoint
 * of every cross-row edge is entered by a diagonal fan segment.
 */
export function computeGraphLayout(
	indexer: LoomIndexer,
	projectRoot: string,
	layerOrder: readonly EntityType[]
): GraphLayout {
	const { raw, neighbors } = collectEdges(indexer, projectRoot);

	// Round 1: provisional placement with default corridors, only to learn how
	// many trunk lanes each corridor must fit.
	const prelim = placeNodes(indexer, projectRoot, layerOrder, null, neighbors);
	const demand = corridorDemand(classifyEdges(raw, prelim));

	// Round 2: final placement with widened corridors, then full routing.
	const placed = placeNodes(indexer, projectRoot, layerOrder, demand, neighbors);
	const classified = classifyEdges(raw, placed);
	const bottom = routeEdges(classified, placed);

	const allNodes = [...placed.nodes.values()];
	const width = allNodes.reduce((m, n) => Math.max(m, n.x), 0) + MARGIN_X;
	const edges: RoutedEdge[] = classified.map((e) => ({
		a: e.upper.id,
		b: e.lower.id,
		relType: e.relType,
		route: toRoute(e),
	}));
	return { nodes: allNodes, edges, neighbors, width, height: bottom };
}

function toRoute(e: CEdge): EdgeRoute {
	switch (e.kind) {
		case 'direct':
			return { kind: 'direct' };
		case 'orth':
			return { kind: 'orth', laneX: e.laneX };
		case 'toLower':
			return { kind: 'toLower', laneX: e.laneX, approachY: e.approachY, fanOffset: e.fanOffset };
		case 'rowU':
			return { kind: 'rowU', uY: e.uY };
	}
}

/** Undirected, deduplicated connections between indexed project entities. */
function collectEdges(
	indexer: LoomIndexer,
	projectRoot: string
): { raw: RawEdge[]; neighbors: Map<string, Set<string>> } {
	const records = indexer.getAll(undefined, projectRoot);
	const indexed = new Set(records.map((r) => r.path));
	const raw: RawEdge[] = [];
	const neighbors = new Map<string, Set<string>>();
	const seen = new Set<string>();
	for (const record of records) {
		for (const conn of indexer.getOutgoing(record.path)) {
			const a = record.path;
			const b = conn.record.path;
			if (!indexed.has(a) || !indexed.has(b) || a === b) continue;
			const key = a < b ? `${a}\n${b}\n${conn.relType}` : `${b}\n${a}\n${conn.relType}`;
			if (seen.has(key)) continue;
			seen.add(key);
			raw.push({ a, b, relType: conn.relType });
			if (!neighbors.has(a)) neighbors.set(a, new Set());
			if (!neighbors.has(b)) neighbors.set(b, new Set());
			neighbors.get(a)?.add(b);
			neighbors.get(b)?.add(a);
		}
	}
	return { raw, neighbors };
}

function placeNodes(
	indexer: LoomIndexer,
	projectRoot: string,
	layerOrder: readonly EntityType[],
	corridorWidths: Map<number, number> | null,
	neighbors: Map<string, Set<string>>
): Placement {
	const nodes = new Map<string, LayoutNode>();
	const colOf = new Map<string, number>();
	const columns = buildColumns(indexer, null, projectRoot);

	// Column x positions: corridor i is the gap left of column i; a corridor
	// holding many trunk lanes widens beyond the default so lanes stay
	// LANE_GAP apart (inconsistent date spacing is the accepted price).
	const colX: number[] = [];
	for (let i = 0; i < columns.length; i++) {
		const base = i === 0 ? MARGIN_X : COL_WIDTH;
		const gap = Math.max(base, corridorWidths?.get(i) ?? 0);
		colX.push(i === 0 ? gap : colX[i - 1] + gap);
	}

	let maxStack = 0;
	const occurrences = new Map<string, number>();
	for (const col of columns) {
		for (const ev of col.events) occurrences.set(ev.path, (occurrences.get(ev.path) ?? 0) + 1);
	}
	const multi = new Map<string, { record: EntityRecord; xs: number[] }>();

	/** Occupied x positions per event stack row, for collision-free placement. */
	const rows: number[][] = [];
	const occupy = (row: number, x: number) => {
		(rows[row] ??= []).push(x);
		maxStack = Math.max(maxStack, row + 1);
	};

	columns.forEach((col, i) => {
		const x = colX[i];
		const anchorKind = col.anchor.type === 'session' ? 'session' : 'event';
		nodes.set(col.anchor.path, {
			id: col.anchor.path,
			record: col.anchor,
			x,
			y: anchorKind === 'session' ? SESSION_Y : EVENT_Y0,
			kind: anchorKind,
			zone: 0,
		});
		colOf.set(col.anchor.path, i);
		if (anchorKind === 'event') occupy(0, x);
		let stack = 0;
		for (const ev of col.events) {
			if ((occurrences.get(ev.path) ?? 0) > 1) {
				const entry = multi.get(ev.path) ?? { record: ev, xs: [] };
				entry.xs.push(x);
				multi.set(ev.path, entry);
				continue;
			}
			nodes.set(ev.path, {
				id: ev.path,
				record: ev,
				x,
				y: EVENT_Y0 + stack * EVENT_DY,
				kind: 'event',
				zone: 0,
			});
			colOf.set(ev.path, i);
			occupy(stack, x);
			stack++;
		}
	});

	// Multi-session events: mean x of their session columns, dropped to the
	// first stack row with enough horizontal clearance from what's already there.
	for (const { record, xs } of [...multi.values()].sort((a, b) =>
		a.record.name.localeCompare(b.record.name)
	)) {
		const x = xs.reduce((s, v) => s + v, 0) / xs.length;
		let row = 0;
		while ((rows[row] ?? []).some((ox) => Math.abs(ox - x) < MULTI_CLEARANCE)) row++;
		nodes.set(record.path, {
			id: record.path,
			record,
			x,
			y: EVENT_Y0 + row * EVENT_DY,
			kind: 'event',
			zone: 0,
		});
		colOf.set(record.path, nearestColumn(colX, x));
		occupy(row, x);
	}

	const eventsBottom = EVENT_Y0 + Math.max(maxStack, 1) * EVENT_DY;

	// Global layers: one row per (non-empty) type in the configured order.
	const layerRecords = layerOrder
		.map((t) => indexer.getAll(t, projectRoot).sort((a, b) => a.name.localeCompare(b.name)))
		.filter((rs) => rs.length > 0);

	// Desired x = barycenter of already-positioned neighbors, two passes so
	// global↔global links also exert pull once first estimates exist.
	const timelineMaxX = colX.length > 0 ? colX[colX.length - 1] : MARGIN_X;
	const centerX = (MARGIN_X + timelineMaxX) / 2;
	const allGlobals = layerRecords.flat();
	const desired = new Map<string, number>();
	for (let pass = 0; pass < 2; pass++) {
		for (const g of allGlobals) {
			const xs: number[] = [];
			for (const n of neighbors.get(g.path) ?? []) {
				const node = nodes.get(n);
				if (node) xs.push(node.x);
				else if (pass > 0 && desired.has(n)) xs.push(desired.get(n) ?? 0);
			}
			desired.set(g.path, xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : centerX);
		}
	}

	const layers: LayoutNode[][] = layerRecords.map((rs, layerIdx) => {
		const ordered = [...rs].sort((a, b) => (desired.get(a.path) ?? 0) - (desired.get(b.path) ?? 0));
		let prevX = -Infinity;
		const row: LayoutNode[] = [];
		for (const g of ordered) {
			const x = Math.max(desired.get(g.path) ?? centerX, prevX + GLOBAL_MIN_SPACING, MARGIN_X);
			// y is provisional; routeEdges sizes the bands and sets the real row y.
			const node: LayoutNode = {
				id: g.path,
				record: g,
				x,
				y: eventsBottom + MIN_BAND * (layerIdx + 1),
				kind: 'global',
				zone: layerIdx + 1,
			};
			nodes.set(g.path, node);
			row.push(node);
			prevX = x;
		}
		return row;
	});

	return { nodes, colX, colOf, eventsBottom, layers };
}

function nearestColumn(colX: number[], x: number): number {
	let best = 0;
	for (let i = 1; i < colX.length; i++) {
		if (Math.abs(colX[i] - x) < Math.abs(colX[best] - x)) best = i;
	}
	return best;
}

function classifyEdges(raw: RawEdge[], placement: Placement): CEdge[] {
	const { nodes, colOf } = placement;
	const out: CEdge[] = [];
	for (const { a, b, relType } of raw) {
		const na = nodes.get(a);
		const nb = nodes.get(b);
		if (!na || !nb) continue;
		const e: CEdge = {
			upper: na,
			lower: nb,
			relType,
			kind: 'direct',
			uBand: 0,
			corridor: null,
			laneX: 0,
			approachY: 0,
			fanOffset: 0,
			uY: 0,
			needsRun: false,
		};
		if (na.zone === nb.zone) {
			if (na.zone > 0) {
				// Same global layer: U through the band below that row.
				e.kind = 'rowU';
				e.uBand = na.zone;
			} else if (Math.abs(na.y - nb.y) < 1) {
				// Same timeline row: sessions U above their row, events below
				// the event zone (band 0).
				e.kind = 'rowU';
				e.uBand = na.kind === 'session' ? -1 : 0;
			} else {
				if (na.y > nb.y) [e.upper, e.lower] = [nb, na];
				e.kind =
					Math.abs(na.x - nb.x) < 1 && !blockedBetween(placement, e.upper, e.lower)
						? 'direct'
						: 'orth';
			}
		} else {
			if (na.zone > nb.zone) [e.upper, e.lower] = [nb, na];
			e.kind = 'toLower';
		}
		if (e.kind === 'orth' || e.kind === 'toLower') {
			// Trunks from timeline nodes live in the corridor beside the source
			// column, on the side facing the target; trunks from global nodes
			// hug the node instead (assigned in routeEdges).
			if (e.upper.zone === 0) {
				const col = colOf.get(e.upper.id) ?? nearestColumn(placement.colX, e.upper.x);
				e.corridor = e.lower.x >= e.upper.x ? col + 1 : col;
			}
		}
		out.push(e);
	}
	return out;
}

/** A straight vertical would pass through another node between the two. */
function blockedBetween(placement: Placement, upper: LayoutNode, lower: LayoutNode): boolean {
	for (const n of placement.nodes.values()) {
		if (n.id === upper.id || n.id === lower.id) continue;
		if (Math.abs(n.x - upper.x) < 1 && n.y > upper.y + 1 && n.y < lower.y - 1) return true;
	}
	return false;
}

/** Lane demand per corridor → extra width for round 2. */
function corridorDemand(edges: CEdge[]): Map<number, number> {
	const counts = new Map<number, number>();
	for (const e of edges) {
		if (e.corridor !== null) counts.set(e.corridor, (counts.get(e.corridor) ?? 0) + 1);
	}
	const widths = new Map<number, number>();
	for (const [corridor, count] of counts) {
		widths.set(corridor, count * LANE_GAP + 2 * CORRIDOR_PAD);
	}
	return widths;
}

/**
 * Assigns concrete geometry: trunk lane x positions, diagonal fan offsets,
 * approach/U y-lanes, band heights (which fix the global rows' y), and a
 * final pass nudging trunks off any node they'd pass through.
 * Returns the layout's bottom y.
 */
function routeEdges(edges: CEdge[], placement: Placement): number {
	const { colX, layers, eventsBottom } = placement;

	// --- Trunk lanes -----------------------------------------------------------
	const byCorridor = new Map<number, CEdge[]>();
	for (const e of edges) {
		if (e.corridor === null) continue;
		if (!byCorridor.has(e.corridor)) byCorridor.set(e.corridor, []);
		byCorridor.get(e.corridor)?.push(e);
	}
	const corridorCenter = (i: number): number => {
		if (colX.length === 0) return MARGIN_X;
		if (i <= 0) return colX[0] / 2;
		if (i >= colX.length) return colX[colX.length - 1] + COL_WIDTH / 2;
		return (colX[i - 1] + colX[i]) / 2;
	};
	for (const [corridor, group] of byCorridor) {
		// Ordered by target x so lanes fan out in travel direction (fewer crossings).
		group.sort((p, q) => p.lower.x - q.lower.x);
		const center = corridorCenter(corridor);
		group.forEach((e, j) => {
			e.laneX = center + (j - (group.length - 1) / 2) * LANE_GAP;
		});
	}
	// Trunks leaving a global node (cross-layer edges): hug the node's side
	// facing the target.
	for (const e of edges) {
		if (e.kind === 'toLower' && e.upper.zone > 0) {
			e.laneX = e.upper.x + (e.lower.x >= e.upper.x ? 1 : -1) * (TRUNK_CLEAR + 3);
		}
	}

	// --- Diagonal fans ---------------------------------------------------------
	const byTarget = new Map<string, CEdge[]>();
	for (const e of edges) {
		if (e.kind !== 'toLower') continue;
		if (!byTarget.has(e.lower.id)) byTarget.set(e.lower.id, []);
		byTarget.get(e.lower.id)?.push(e);
	}
	for (const group of byTarget.values()) {
		group.sort((p, q) => p.laneX - q.laneX);
		group.forEach((e, j) => {
			const off = (j - (group.length - 1) / 2) * FAN_GAP;
			e.fanOffset = Math.max(-FAN_MAX, Math.min(FAN_MAX, off));
			e.needsRun = Math.abs(e.lower.x + e.fanOffset - e.laneX) > LANE_EPSILON;
		});
	}

	// --- Bands & row y ---------------------------------------------------------
	// Band b sits above global layer b (b < layers.length) and holds the U
	// lanes of the row above it plus the approach lanes of the row below it;
	// the last band (below the bottom row) holds only U lanes.
	const uOf = (band: number) => edges.filter((e) => e.kind === 'rowU' && e.uBand === band);
	const approachesOf = (layer: number) =>
		edges.filter((e) => e.kind === 'toLower' && e.lower.zone === layer + 1);

	// Sessions-row U lanes live above the top row and don't affect band sizing.
	uOf(-1)
		.sort((p, q) => Math.min(p.upper.x, p.lower.x) - Math.min(q.upper.x, q.lower.x))
		.forEach((e, i) => {
			e.uY = SESSION_Y - 44 - i * Y_GAP;
		});

	let bandTop = eventsBottom;
	let bottom = eventsBottom + 60;
	for (let b = 0; b <= layers.length; b++) {
		const us = uOf(b).sort(
			(p, q) => Math.min(p.upper.x, p.lower.x) - Math.min(q.upper.x, q.lower.x)
		);
		us.forEach((e, i) => {
			e.uY = bandTop + U_TOP + i * Y_GAP;
		});
		if (b === layers.length) {
			bottom = bandTop + (us.length > 0 ? U_TOP + us.length * Y_GAP : 0) + 60;
			break;
		}
		const approaches = approachesOf(b);
		const runs = approaches.filter((e) => e.needsRun).sort((p, q) => p.lower.x - q.lower.x);
		const height = Math.max(
			MIN_BAND,
			U_TOP + us.length * Y_GAP + BAND_MID + (runs.length + 1) * Y_GAP + APPROACH_BOTTOM
		);
		const rowY = bandTop + height;
		for (const node of layers[b]) node.y = rowY;
		// Base approach line closest to the row for run-less edges; each
		// horizontal run gets its own lane above it.
		for (const e of approaches) e.approachY = rowY - APPROACH_BOTTOM;
		runs.forEach((e, j) => {
			e.approachY = rowY - APPROACH_BOTTOM - (j + 1) * Y_GAP;
		});
		bandTop = rowY;
	}

	// --- Trunk collision pass ----------------------------------------------------
	// A trunk spanning several rows must not run through nodes it passes;
	// nudge sideways until clear (labels excluded — only circle bodies count).
	const allNodes = [...placement.nodes.values()];
	for (const e of edges) {
		if (e.kind !== 'orth' && e.kind !== 'toLower') continue;
		const spanTop = e.upper.y + 1;
		const spanBottom = (e.kind === 'toLower' ? e.approachY : e.lower.y) - 1;
		const blockers = allNodes.filter(
			(n) => n.id !== e.upper.id && n.id !== e.lower.id && n.y > spanTop && n.y < spanBottom
		);
		for (let guard = 0; guard < 24; guard++) {
			const hit = blockers.find((n) => Math.abs(e.laneX - n.x) < TRUNK_CLEAR);
			if (!hit) break;
			e.laneX = hit.x + (e.laneX >= hit.x ? TRUNK_CLEAR : -TRUNK_CLEAR);
		}
	}

	return bottom;
}
