import { EntityRecord, EntityType } from '../types';
import { formatLoomDate } from '../calendar';
import { TimelineColumn, buildColumns } from '../columns';
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
/** Sublocation grid width: a parent's sublocations sit SUB_COLS wide under
 *  it, wrapping to further rows (the 5th starts row two, the 9th row three…). */
const SUB_COLS = 4;

/** Default/minimum distance between parallel vertical trunk lanes —
 *  overridable per call via `computeGraphLayout`'s `trunkGap` (settings.graphTrunkGap). */
const LANE_GAP = 10;
/** Default/minimum distance between parallel horizontal lanes in a band —
 *  overridable per call via `computeGraphLayout`'s `lineGap` (settings.graphLineGap). */
const Y_GAP = 10;
/** x padding a corridor keeps around its lane block. */
const CORRIDOR_PAD = 35;
/** Horizontal spread between neighboring diagonal fan entries into one node. */
const FAN_GAP = 14;
/** Half-width of the space one node side offers its fan — wider fans would
 *  reach into row neighbors. */
const FAN_MAX = 55;
/** Connections that fit on one node side without overlapping (spaced FAN_GAP
 *  across the side's 2×FAN_MAX). Beyond this the side is full: the spread
 *  compresses evenly across the available width and overlap is accepted. */
const FAN_CAP = Math.floor((2 * FAN_MAX) / FAN_GAP) + 1;
/** Fan spacing for `n` connections on one side: full FAN_GAP while they fit,
 *  evenly compressed once the side's capacity is exceeded. */
const fanStep = (n: number) => (n <= FAN_CAP ? FAN_GAP : (2 * FAN_MAX) / (n - 1));
/** y drop from a node's center to the top of its outgoing trunks — the exit
 *  diagonals end here (mirror of APPROACH_BOTTOM on the entry side). */
const DEPART_DROP = 36;
/** Average glyph width as a fraction of the label font size — used to
 *  estimate label pixel widths for the checker pass. */
const LABEL_CHAR_W = 0.58;
/** Node labels render truncated to this many characters (see graph-view). */
const LABEL_MAX_CHARS = 24;
/** Horizontal breathing room between two neighboring labels (px). */
const LABEL_PAD = 8;
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
	/** Which endpoint's note declares the relationship (both = mutual). */
	declaredByA: boolean;
	declaredByB: boolean;
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

type EdgeKind = 'direct' | 'fan' | 'rowU';

interface CEdge {
	upper: LayoutNode;
	lower: LayoutNode;
	relType: string;
	/** Arrowhead at the upper/lower endpoint (declared by the other one). */
	arrowUpper: boolean;
	arrowLower: boolean;
	kind: EdgeKind;
	/** Band index a rowU belongs to; -1 = the band above the sessions row. */
	uBand: number;
	corridor: number | null;
	laneX: number;
	departY: number;
	approachY: number;
	fanOffset: number;
	uY: number;
	/** rowU turn-point x offsets relative to each endpoint. */
	uOffUpper: number;
	uOffLower: number;
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
 * shapes get per-edge y-lanes in the bands between rows; both endpoints of
 * every cross-row edge attach with a diagonal fan segment (unified angled
 * style), spread across the node side up to its capacity (FAN_CAP) and
 * compressed into overlap beyond it.
 */
export function computeGraphLayout(
	indexer: LoomIndexer,
	projectRoot: string,
	layerOrder: readonly EntityType[],
	/** Distance (px) between parallel horizontal connection lines — keeps them
	 *  from overlapping. Defaults to the layout's own baseline spacing. */
	lineGap: number = Y_GAP,
	/** Drag-reordered x positions of unconnected global nodes (note path → world
	 *  x). Connected nodes ignore it — their connection forces win. */
	manualX?: ReadonlyMap<string, number>,
	/** Min distance (px) between parallel vertical trunk lines. */
	trunkGap: number = LANE_GAP,
	/** Node-label font size (px) under the current text-size setting — label
	 *  overlap estimates (the checker pass) scale with it. */
	labelFontPx: number = 12.8,
	/** Node being live-dragged, if any: excluded from the checker pass so its
	 *  transient label position can't toggle neighbors' stagger every frame. */
	liveDragId?: string
): GraphLayout {
	const { raw, neighbors } = collectEdges(indexer, projectRoot);

	// Round 1: provisional placement with default corridors, only to learn how
	// many trunk lanes each corridor must fit.
	const prelim = placeNodes(indexer, projectRoot, layerOrder, null, neighbors, manualX, liveDragId);
	const demand = corridorDemand(classifyEdges(raw, prelim), trunkGap);

	// Round 2: final placement with widened corridors, then full routing.
	const placed = placeNodes(indexer, projectRoot, layerOrder, demand, neighbors, manualX, liveDragId);
	const classified = classifyEdges(raw, placed);
	const bottom = routeEdges(classified, placed, lineGap, trunkGap);

	// Checker pass (after routing, so row membership and bands were computed
	// from the flat rows): row neighbors whose labels would overlap alternate
	// slightly above/below their row; nodes with enough room stay put.
	const projectDef = indexer.getProjectByRoot(projectRoot);
	const labelOf = (r: EntityRecord) =>
		r.type === 'session' && r.date && projectDef ? formatLoomDate(r.date, projectDef.config) : r.name;
	applyLabelChecker(
		[...placed.nodes.values()].filter((n) => n.id !== liveDragId),
		labelOf,
		labelFontPx
	);
	// Exit diagonals follow their node onto its staggered y.
	for (const e of classified) {
		if (e.kind === 'fan') e.departY = e.upper.y + DEPART_DROP;
	}

	const allNodes = [...placed.nodes.values()];
	const width = allNodes.reduce((m, n) => Math.max(m, n.x), 0) + MARGIN_X;
	const edges: RoutedEdge[] = classified.map((e) => ({
		a: e.upper.id,
		b: e.lower.id,
		relType: e.relType,
		arrowA: e.arrowUpper,
		arrowB: e.arrowLower,
		route: toRoute(e),
	}));
	return { nodes: allNodes, edges, neighbors, width, height: bottom };
}

function toRoute(e: CEdge): EdgeRoute {
	switch (e.kind) {
		case 'direct':
			return { kind: 'direct' };
		case 'fan':
			return {
				kind: 'fan',
				laneX: e.laneX,
				departY: e.departY,
				approachY: e.approachY,
				fanOffset: e.fanOffset,
			};
		case 'rowU':
			return { kind: 'rowU', uY: e.uY, offA: e.uOffUpper, offB: e.uOffLower };
	}
}

/** Undirected, deduplicated connections between indexed project entities. */
function collectEdges(
	indexer: LoomIndexer,
	projectRoot: string
): { raw: RawEdge[]; neighbors: Map<string, Set<string>> } {
	const records = indexer.getAll(undefined, projectRoot);
	const indexed = new Set(records.map((r) => r.path));
	const neighbors = new Map<string, Set<string>>();
	// One edge per PAIR: any mutual declarations (even different relTypes)
	// merge into a single edge with arrowheads on both ends; a typed relType
	// wins over a plain 'link' for the merged edge's label.
	const byKey = new Map<string, RawEdge>();
	for (const record of records) {
		for (const conn of indexer.getOutgoing(record.path)) {
			const a = record.path;
			const b = conn.record.path;
			if (!indexed.has(a) || !indexed.has(b) || a === b) continue;
			const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
			const existing = byKey.get(key);
			if (existing) {
				if (existing.a === a) existing.declaredByA = true;
				else existing.declaredByB = true;
				if (existing.relType === 'link' && conn.relType !== 'link') existing.relType = conn.relType;
				continue;
			}
			byKey.set(key, { a, b, relType: conn.relType, declaredByA: true, declaredByB: false });
			if (!neighbors.has(a)) neighbors.set(a, new Set());
			if (!neighbors.has(b)) neighbors.set(b, new Set());
			neighbors.get(a)?.add(b);
			neighbors.get(b)?.add(a);
		}
	}
	return { raw: [...byKey.values()], neighbors };
}

function placeNodes(
	indexer: LoomIndexer,
	projectRoot: string,
	layerOrder: readonly EntityType[],
	corridorWidths: Map<number, number> | null,
	neighbors: Map<string, Set<string>>,
	manualX?: ReadonlyMap<string, number>,
	liveDragId?: string
): Placement {
	const nodes = new Map<string, LayoutNode>();
	const colOf = new Map<string, number>();
	const allColumns = buildColumns(indexer, null, projectRoot);

	// Dateless, unconnected events don't need a chronological slot or edge
	// corridors — pull them out of the column flow and let them float freely
	// in the events row (drag-reorderable via manualX, like loose globals).
	const isFreeEvent = (c: TimelineColumn) =>
		c.anchor.type === 'event' &&
		c.anchor.date === null &&
		c.events.length === 0 &&
		(neighbors.get(c.anchor.path)?.size ?? 0) === 0;
	const freeEvents = allColumns.filter(isFreeEvent).map((c) => c.anchor);
	const columns = allColumns.filter((c) => !isFreeEvent(c));

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

	// Multi-session events: centered between their earliest and latest session
	// columns, dropped to the first stack row with enough horizontal clearance
	// from what's already there.
	for (const { record, xs } of [...multi.values()].sort((a, b) =>
		a.record.name.localeCompare(b.record.name)
	)) {
		const x = (Math.min(...xs) + Math.max(...xs)) / 2;
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

	// Free events: manual spot if dragged there, otherwise packed after the
	// last column so they group at the row's right edge. Either way they are
	// repelled out of overlaps — a dragged spot can land on a column anchor,
	// a stacked event, or another free event.
	const lastColX = colX.length > 0 ? colX[colX.length - 1] : MARGIN_X - COL_WIDTH;
	const placedFree = freeEvents
		.map((record, i) => ({
			record,
			x: manualX?.get(record.path) ?? lastColX + COL_WIDTH * (i + 1),
		}))
		.sort((a, b) => a.x - b.x);
	for (const { record, x: desired } of placedFree) {
		let x = desired;
		let dir = 0;
		const taken = rows[0] ?? [];
		for (let guard = 0; guard < 40; guard++) {
			const hit = taken.find((ox) => Math.abs(ox - x) < MULTI_CLEARANCE);
			if (hit === undefined) break;
			// The push side comes from the node's ORIGINAL spot and stays
			// locked: comparing against the already-pushed position made the
			// direction flip between rounds, so a repelled node chased away
			// from an approaching drag endlessly (or oscillated between two
			// obstacles). Now it settles just beside the intruder and swaps
			// sides only once the intruder actually crosses its center.
			if (dir === 0) dir = desired >= hit ? 1 : -1;
			x = hit + dir * MULTI_CLEARANCE;
		}
		nodes.set(record.path, {
			id: record.path,
			record,
			x,
			y: EVENT_Y0,
			kind: 'event',
			zone: 0,
		});
		colOf.set(record.path, nearestColumn(colX, x));
		occupy(0, x);
	}

	const eventsBottom = EVENT_Y0 + Math.max(maxStack, 1) * EVENT_DY;

	// Global layers: one row per (non-empty) type in the configured order.
	// Sublocations — locations carrying a `parentLocation` link to another
	// location — leave the locations row: they form a grid of rows right
	// under it, built after the relaxation once parents have an x.
	const parentOf = new Map<string, string>();
	for (const loc of indexer.getAll('location', projectRoot)) {
		if (loc.parentLocation === null) continue;
		const target = indexer.resolve(loc.parentLocation, loc.path);
		if (target?.type === 'location' && target.path !== loc.path && target.project === projectRoot) {
			parentOf.set(loc.path, target.path);
		}
	}
	// Each sublocation clusters under its nearest ancestor that sits in the
	// locations row itself (nested sublocations flatten into one grid); parent
	// cycles fall back to the ordinary row.
	const subRoot = new Map<string, string>();
	for (const path of parentOf.keys()) {
		let cur = path;
		for (let guard = 0; guard < 20 && parentOf.has(cur); guard++) {
			cur = parentOf.get(cur) ?? cur;
		}
		if (!parentOf.has(cur)) subRoot.set(path, cur);
	}
	const layerRows = layerOrder
		.map((type) => ({
			type,
			records: indexer
				.getAll(type, projectRoot)
				.filter((r) => !subRoot.has(r.path))
				.sort((a, b) => a.name.localeCompare(b.name)),
		}))
		.filter((row) => row.records.length > 0);
	const layerRecords = layerRows.map((row) => row.records);

	// Per-row 1D force relaxation. Connected globals are pulled to the mean x
	// of their neighbors (timeline nodes are fixed anchors, other globals use
	// the current estimate); unconnected globals hold their drag-reordered
	// manual x, or their initial alphabetical slot. Each pass ends with a
	// collision resolve so the next pass pulls from separated positions —
	// without it, a globals-only project collapses every estimate onto one
	// point and the tie-break degenerates to alphabetical order.
	const timelineMaxX = colX.length > 0 ? colX[colX.length - 1] : MARGIN_X;
	const centerX = (MARGIN_X + timelineMaxX) / 2;
	const allGlobals = layerRecords.flat();
	const est = new Map<string, number>();
	const isConnected = (path: string) => (neighbors.get(path)?.size ?? 0) > 0;

	// Quests respect their session fields above all other connections: a quest
	// sits under the session it was received in; once an outcome session is
	// set, it centers between the received and outcome sessions. Anchored
	// quests are re-pinned every pass, so other connections and manual drags
	// never pull them away (the row's min-spacing sweep still applies).
	const questAnchor = new Map<string, number>();
	for (const g of allGlobals) {
		if (g.type !== 'quest') continue;
		const sessionX = (lp: string | null): number | undefined => {
			const target = lp !== null ? indexer.resolve(lp, g.path) : null;
			return target?.type === 'session' ? nodes.get(target.path)?.x : undefined;
		};
		const received = sessionX(g.questReceived);
		const outcome = sessionX(g.questOutcomeSession);
		const anchor =
			received !== undefined && outcome !== undefined
				? (received + outcome) / 2
				: received ?? outcome;
		if (anchor !== undefined) questAnchor.set(g.path, anchor);
	}

	// Connected components over globals. A component is "anchored" when any
	// member links to a placed timeline node. Manual (drag-reorder) positions
	// act as pseudo-edges for FREE components only: dragging one node of an
	// isolated pair/cluster tows the whole group, while anchored components
	// keep following their timeline pull (forces win).
	const globalSet = new Set(allGlobals.map((g) => g.path));
	const compOf = new Map<string, number>();
	const anchoredComps = new Set<number>();
	let compCount = 0;
	for (const g of allGlobals) {
		if (compOf.has(g.path)) continue;
		const id = compCount++;
		const queue = [g.path];
		compOf.set(g.path, id);
		let anchored = false;
		while (queue.length > 0) {
			const cur = queue.pop();
			if (cur === undefined) break;
			for (const n of neighbors.get(cur) ?? []) {
				if (nodes.has(n)) anchored = true;
				else if (globalSet.has(n) && !compOf.has(n)) {
					compOf.set(n, id);
					queue.push(n);
				}
			}
		}
		if (anchored) anchoredComps.add(id);
	}
	const manualPull = (path: string): number | undefined =>
		manualX !== undefined && !anchoredComps.has(compOf.get(path) ?? -1)
			? manualX.get(path)
			: undefined;

	for (const rs of layerRecords) {
		const spread = (rs.length - 1) * GLOBAL_MIN_SPACING;
		rs.forEach((g, i) => {
			est.set(
				g.path,
				questAnchor.get(g.path) ??
					manualX?.get(g.path) ??
					centerX - spread / 2 + i * GLOBAL_MIN_SPACING
			);
		});
	}
	for (let pass = 0; pass < 40; pass++) {
		for (const g of allGlobals) {
			// The live-dragged node's home is the cursor, absolutely — averaging
			// it with connection forces made its estimate lag behind, so the row
			// order never flipped and a connected neighbor could never be passed.
			if (g.path === liveDragId) {
				const manual = manualX?.get(g.path);
				if (manual !== undefined) {
					est.set(g.path, manual);
					continue;
				}
			}
			const anchor = questAnchor.get(g.path);
			if (anchor !== undefined) {
				est.set(g.path, anchor);
				continue;
			}
			if (!isConnected(g.path)) continue;
			const xs: number[] = [];
			for (const n of neighbors.get(g.path) ?? []) {
				const fixed = nodes.get(n);
				if (fixed) xs.push(fixed.x);
				else if (est.has(n)) xs.push(est.get(n) ?? 0);
			}
			const manual = manualPull(g.path);
			if (manual !== undefined) xs.push(manual);
			if (xs.length > 0) est.set(g.path, xs.reduce((s, v) => s + v, 0) / xs.length);
		}
		// Loose nodes (no connections, no manual spot) pack alphabetically to
		// the right of their row's cluster instead of holding their initial
		// slots — rows stay grouped rather than sprawling across the canvas.
		for (const rs of layerRecords) {
			const held = rs.filter((g) => isConnected(g.path) || manualX?.has(g.path));
			const loose = rs.filter((g) => !isConnected(g.path) && !manualX?.has(g.path));
			if (held.length === 0 || loose.length === 0) continue;
			const right = Math.max(...held.map((g) => est.get(g.path) ?? centerX));
			loose.forEach((g, i) => est.set(g.path, right + GLOBAL_MIN_SPACING * (i + 1)));
		}
		for (const rs of layerRecords) resolveRowOverlaps(rs, est);
	}

	// Sublocation grid: hierarchical — each location's direct children sit
	// one grid row below it, clustered under it SUB_COLS wide (wrapping
	// pushes deeper levels further down), so a sublocation's own sublocations
	// always land beneath it. Each child list follows the parent's
	// drag-reordered `sublocationOrder` (then name); rows sweep right so
	// entries sharing a grid row never overlap.
	const subRowEntries: { record: EntityRecord; x: number }[][] = [];
	if (subRoot.size > 0) {
		const childrenOf = new Map<string, EntityRecord[]>();
		for (const path of subRoot.keys()) {
			const rec = indexer.get(path);
			const parent = parentOf.get(path);
			if (!rec || parent === undefined) continue;
			if (!childrenOf.has(parent)) childrenOf.set(parent, []);
			childrenOf.get(parent)?.push(rec);
		}
		for (const [parentPath, kids] of childrenOf) {
			const orderIdx = new Map<string, number>();
			indexer.get(parentPath)?.sublocationOrder.forEach((lp, i) => {
				const target = indexer.resolve(lp, parentPath);
				if (target) orderIdx.set(target.path, i);
			});
			kids.sort(
				(a, b) =>
					(orderIdx.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
						(orderIdx.get(b.path) ?? Number.MAX_SAFE_INTEGER) ||
					a.name.localeCompare(b.name)
			);
		}
		const place = (parentPath: string, parentX: number, row: number) => {
			const kids = childrenOf.get(parentPath) ?? [];
			const w = Math.min(kids.length, SUB_COLS);
			kids.forEach((kid, i) => {
				const col = i % SUB_COLS;
				const wrap = Math.floor(i / SUB_COLS);
				const x = parentX + (col - (w - 1) / 2) * GLOBAL_MIN_SPACING;
				(subRowEntries[row + wrap] ??= []).push({ record: kid, x });
				place(kid.path, x, row + wrap + 1);
			});
		};
		for (const rootPath of new Set(subRoot.values())) {
			place(rootPath, est.get(rootPath) ?? centerX, 0);
		}
		for (const row of subRowEntries) {
			row.sort((a, b) => a.x - b.x);
			let cursor = MARGIN_X;
			for (const entry of row) {
				entry.x = Math.max(entry.x, cursor);
				cursor = entry.x + GLOBAL_MIN_SPACING;
			}
		}
	}

	const finalRows: { record: EntityRecord; x: number }[][] = [];
	for (const { type, records: rs } of layerRows) {
		finalRows.push(
			[...rs]
				.sort((a, b) => (est.get(a.path) ?? 0) - (est.get(b.path) ?? 0))
				.map((g) => ({ record: g, x: est.get(g.path) ?? centerX }))
		);
		if (type === 'location') finalRows.push(...subRowEntries);
	}
	// Safety net: grid rows still need a home if the locations row vanished.
	if (subRowEntries.length > 0 && !layerRows.some((r) => r.type === 'location')) {
		finalRows.push(...subRowEntries);
	}

	const layers: LayoutNode[][] = finalRows.map((entries, layerIdx) =>
		entries.map(({ record, x }) => {
			// y is provisional; routeEdges sizes the bands and sets the real row y.
			const node: LayoutNode = {
				id: record.path,
				record,
				x,
				y: eventsBottom + MIN_BAND * (layerIdx + 1),
				kind: 'global',
				zone: layerIdx + 1,
			};
			nodes.set(record.path, node);
			return node;
		})
	);

	return { nodes, colX, colOf, eventsBottom, layers };
}

/**
 * Staggers row neighbors whose labels would overlap into a checkers pattern:
 * within each run of consecutive overlapping labels, nodes alternate slightly
 * above and below the row line, so neighboring names land on different lines.
 * Nodes whose labels fit stay exactly on their row. Label widths are
 * estimated from `labelFontPx`, so the pattern follows the text-size setting;
 * the stagger amplitude scales with it too (two staggered labels must clear
 * one line height between them).
 */
function applyLabelChecker(
	nodes: LayoutNode[],
	labelOf: (record: EntityRecord) => string,
	labelFontPx: number
): void {
	const rows = new Map<number, LayoutNode[]>();
	for (const n of nodes) {
		const key = Math.round(n.y);
		if (!rows.has(key)) rows.set(key, []);
		rows.get(key)?.push(n);
	}
	const halfWidth = (n: LayoutNode) =>
		(Math.min(labelOf(n.record).length, LABEL_MAX_CHARS) * LABEL_CHAR_W * labelFontPx + LABEL_PAD) / 2;
	const delta = Math.round(labelFontPx * 0.75);
	for (const row of rows.values()) {
		if (row.length < 2) continue;
		row.sort((a, b) => a.x - b.x);
		let runStart = 0;
		for (let i = 1; i <= row.length; i++) {
			const overlapsPrev =
				i < row.length && row[i].x - row[i - 1].x < halfWidth(row[i]) + halfWidth(row[i - 1]);
			if (overlapsPrev) continue;
			// [runStart, i) is a maximal overlap run; stagger it (runs of one stay flat).
			if (i - runStart > 1) {
				for (let j = runStart; j < i; j++) {
					row[j].y += (j - runStart) % 2 === 0 ? -delta : delta;
				}
			}
			runStart = i;
		}
	}
}

/**
 * Enforces GLOBAL_MIN_SPACING within one row while moving estimates as little
 * as possible: nodes are sorted by estimate, overlapping neighbors merge into
 * pools, and each pool is laid out consecutively around the mean of its
 * members' estimates (then clamped to the left margin).
 */
function resolveRowOverlaps(rs: EntityRecord[], est: Map<string, number>): void {
	const order = [...rs].sort((a, b) => (est.get(a.path) ?? 0) - (est.get(b.path) ?? 0));
	interface Pool {
		sum: number;
		paths: string[];
	}
	const half = (p: Pool) => ((p.paths.length - 1) / 2) * GLOBAL_MIN_SPACING;
	const center = (p: Pool) => p.sum / p.paths.length;
	const pools: Pool[] = [];
	for (const g of order) {
		pools.push({ sum: est.get(g.path) ?? 0, paths: [g.path] });
		while (pools.length > 1) {
			const cur = pools[pools.length - 1];
			const prev = pools[pools.length - 2];
			if (center(cur) - half(cur) >= center(prev) + half(prev) + GLOBAL_MIN_SPACING) break;
			prev.sum += cur.sum;
			prev.paths.push(...cur.paths);
			pools.pop();
		}
	}
	// The left-margin clamp can push a pool right into its successor — keep a
	// running cursor so pools never re-overlap.
	let cursor = -Infinity;
	for (const pool of pools) {
		const start = Math.max(center(pool) - half(pool), MARGIN_X, cursor);
		pool.paths.forEach((path, i) => est.set(path, start + i * GLOBAL_MIN_SPACING));
		cursor = start + pool.paths.length * GLOBAL_MIN_SPACING;
	}
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
	for (const { a, b, relType, declaredByA, declaredByB } of raw) {
		const na = nodes.get(a);
		const nb = nodes.get(b);
		if (!na || !nb) continue;
		const e: CEdge = {
			upper: na,
			lower: nb,
			relType,
			// The arrow sits at the endpoint the declaration points AT.
			arrowUpper: declaredByB,
			arrowLower: declaredByA,
			kind: 'direct',
			uBand: 0,
			corridor: null,
			laneX: 0,
			departY: 0,
			approachY: 0,
			fanOffset: 0,
			uY: 0,
			uOffUpper: 0,
			uOffLower: 0,
			needsRun: false,
		};
		const swapEnds = () => {
			[e.upper, e.lower] = [e.lower, e.upper];
			[e.arrowUpper, e.arrowLower] = [e.arrowLower, e.arrowUpper];
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
				if (na.y > nb.y) swapEnds();
				e.kind =
					Math.abs(na.x - nb.x) < 1 && !blockedBetween(placement, e.upper, e.lower)
						? 'direct'
						: 'fan';
			}
		} else {
			if (na.zone > nb.zone) swapEnds();
			e.kind = 'fan';
		}
		if (e.kind === 'fan') {
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
function corridorDemand(edges: CEdge[], trunkGap: number): Map<number, number> {
	const counts = new Map<number, number>();
	for (const e of edges) {
		if (e.corridor !== null) counts.set(e.corridor, (counts.get(e.corridor) ?? 0) + 1);
	}
	const widths = new Map<number, number>();
	for (const [corridor, count] of counts) {
		widths.set(corridor, count * trunkGap + 2 * CORRIDOR_PAD);
	}
	return widths;
}

/**
 * Assigns concrete geometry: trunk lane x positions, diagonal fan offsets,
 * approach/U y-lanes, band heights (which fix the global rows' y), and a
 * final pass nudging trunks off any node they'd pass through.
 * Returns the layout's bottom y.
 */
function routeEdges(edges: CEdge[], placement: Placement, yGap: number, trunkGap: number): number {
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
			e.laneX = center + (j - (group.length - 1) / 2) * trunkGap;
		});
	}
	// Trunks leaving a global node (cross-layer edges): hug the node's side
	// facing the target.
	for (const e of edges) {
		if (e.kind === 'fan' && e.upper.zone > 0) {
			e.laneX = e.upper.x + (e.lower.x >= e.upper.x ? 1 : -1) * (TRUNK_CLEAR + 3);
		}
	}

	// --- Exit diagonals ----------------------------------------------------------
	// Every fan edge leaves its upper node with a diagonal to the trunk top;
	// trunks always sit beside the source column (or hug a global's side), so
	// one node's exits spread naturally across its trunk lanes — no run needed.
	for (const e of edges) {
		if (e.kind === 'fan') e.departY = e.upper.y + DEPART_DROP;
	}

	// --- Entry diagonals (fans) --------------------------------------------------
	const byTarget = new Map<string, CEdge[]>();
	for (const e of edges) {
		if (e.kind !== 'fan') continue;
		if (!byTarget.has(e.lower.id)) byTarget.set(e.lower.id, []);
		byTarget.get(e.lower.id)?.push(e);
	}
	for (const group of byTarget.values()) {
		group.sort((p, q) => p.laneX - q.laneX);
		// The node side's space first, overlap only once it's full: FAN_GAP
		// spacing while the fan fits, evenly compressed across ±FAN_MAX beyond.
		const step = fanStep(group.length);
		group.forEach((e, j) => {
			e.fanOffset = (j - (group.length - 1) / 2) * step;
			e.needsRun = Math.abs(e.lower.x + e.fanOffset - e.laneX) > LANE_EPSILON;
		});
	}

	// Approaches into timeline nodes (cross-column session/event edges — the
	// old orthogonal Z, now fanned like everything else): base line just above
	// the target, each run in its own lane; farther trunks first (= lower
	// lane) for the same reason as the band runs below.
	for (const group of byTarget.values()) {
		const target = group[0].lower;
		if (target.zone !== 0) continue;
		for (const e of group) e.approachY = target.y - APPROACH_BOTTOM;
		group
			.filter((e) => e.needsRun)
			.sort((p, q) => Math.abs(q.laneX - q.lower.x) - Math.abs(p.laneX - p.lower.x))
			.forEach((e, j) => {
				e.approachY = target.y - APPROACH_BOTTOM - (j + 1) * yGap;
			});
	}

	// --- Bands & row y ---------------------------------------------------------
	// Band b sits above global layer b (b < layers.length) and holds the U
	// lanes of the row above it plus the approach lanes of the row below it;
	// the last band (below the bottom row) holds only U lanes.
	const uOf = (band: number) => edges.filter((e) => e.kind === 'rowU' && e.uBand === band);
	const approachesOf = (layer: number) =>
		edges.filter((e) => e.kind === 'fan' && e.lower.zone === layer + 1);

	// Sessions-row U lanes live above the top row and don't affect band sizing.
	uOf(-1)
		.sort((p, q) => Math.min(p.upper.x, p.lower.x) - Math.min(q.upper.x, q.lower.x))
		.forEach((e, i) => {
			e.uY = SESSION_Y - 44 - i * yGap;
		});

	let bandTop = eventsBottom;
	let bottom = eventsBottom + 60;
	for (let b = 0; b <= layers.length; b++) {
		const us = uOf(b).sort(
			(p, q) => Math.min(p.upper.x, p.lower.x) - Math.min(q.upper.x, q.lower.x)
		);
		us.forEach((e, i) => {
			e.uY = bandTop + U_TOP + i * yGap;
		});
		if (b === layers.length) {
			bottom = bandTop + (us.length > 0 ? U_TOP + us.length * yGap : 0) + 60;
			break;
		}
		const approaches = approachesOf(b);
		// Runs into the SAME node tie on lower.x — break the tie by trunk
		// distance, farther first (= lower lane): a near trunk's vertical then
		// ends at its high lane before it could cross a far run's low lane,
		// so same-target runs can't loop over each other.
		const runs = approaches
			.filter((e) => e.needsRun)
			.sort(
				(p, q) =>
					p.lower.x - q.lower.x ||
					Math.abs(q.laneX - q.lower.x) - Math.abs(p.laneX - p.lower.x)
			);
		const height = Math.max(
			MIN_BAND,
			U_TOP + us.length * yGap + BAND_MID + (runs.length + 1) * yGap + APPROACH_BOTTOM
		);
		const rowY = bandTop + height;
		for (const node of layers[b]) node.y = rowY;
		// Base approach line closest to the row for run-less edges; each
		// horizontal run gets its own lane above it.
		for (const e of approaches) e.approachY = rowY - APPROACH_BOTTOM;
		runs.forEach((e, j) => {
			e.approachY = rowY - APPROACH_BOTTOM - (j + 1) * yGap;
		});
		bandTop = rowY;
	}

	// --- Angled U ends -----------------------------------------------------------
	// rowU turn points fan across each node's side exactly like entry fans:
	// FAN_GAP apart while the side has room, evenly compressed beyond its
	// capacity. Sorted by the far endpoint so left-bound Us lean left.
	const uEnds = new Map<string, { e: CEdge; upperEnd: boolean; otherX: number }[]>();
	for (const e of edges) {
		if (e.kind !== 'rowU') continue;
		for (const upperEnd of [true, false]) {
			const node = upperEnd ? e.upper : e.lower;
			const other = upperEnd ? e.lower : e.upper;
			if (!uEnds.has(node.id)) uEnds.set(node.id, []);
			uEnds.get(node.id)?.push({ e, upperEnd, otherX: other.x });
		}
	}
	for (const ends of uEnds.values()) {
		ends.sort((p, q) => p.otherX - q.otherX);
		const step = fanStep(ends.length);
		ends.forEach((end, j) => {
			const off = (j - (ends.length - 1) / 2) * step;
			if (end.upperEnd) end.e.uOffUpper = off;
			else end.e.uOffLower = off;
		});
	}

	// --- Trunk collision pass ----------------------------------------------------
	// A trunk spanning several rows must not run through nodes it passes;
	// nudge sideways until clear (labels excluded — only circle bodies count).
	const allNodes = [...placement.nodes.values()];
	const verts = edges.filter((e) => e.kind === 'fan');
	const spanTopOf = (e: CEdge) => e.upper.y + 1;
	const spanBottomOf = (e: CEdge) => e.approachY - 1;
	const spansOverlap = (p: CEdge, q: CEdge) =>
		Math.min(spanBottomOf(p), spanBottomOf(q)) - Math.max(spanTopOf(p), spanTopOf(q)) >= 8;
	const clearNodes = () => {
		for (const e of verts) {
			const spanTop = spanTopOf(e);
			const spanBottom = spanBottomOf(e);
			const blockers = allNodes.filter(
				(n) => n.id !== e.upper.id && n.id !== e.lower.id && n.y > spanTop && n.y < spanBottom
			);
			for (let guard = 0; guard < 24; guard++) {
				const hit = blockers.find((n) => Math.abs(e.laneX - n.x) < TRUNK_CLEAR);
				if (!hit) break;
				const dir = e.laneX >= hit.x ? 1 : -1;
				let x = hit.x + dir * TRUNK_CLEAR;
				// Step past lanes already taken by trunks sharing this y-span —
				// clamping every passer-by to exactly node.x ± TRUNK_CLEAR used
				// to stack them on one lane, and the separation pass below then
				// pushed one back into the node's clearance, clamping it onto
				// the shared lane again (an oscillation that always ended with
				// two coincident verticals).
				for (let step = 0; step < 24; step++) {
					const taken = verts.some(
						(o) => o !== e && Math.abs(o.laneX - x) < trunkGap && spansOverlap(o, e)
					);
					if (!taken) break;
					x += dir * trunkGap;
				}
				e.laneX = x;
			}
		}
	};
	clearNodes();

	// --- Trunk separation pass -----------------------------------------------
	// Corridor groups already fan `trunkGap` apart, but global-origin trunks
	// hug their node's side and can land on top of an unrelated vertical.
	// Push apart any two trunks whose y-spans overlap, re-clearing nodes after
	// each round so the nudges never trade a line overlap for a node overlap.
	for (let round = 0; round < 4; round++) {
		let moved = false;
		for (let i = 0; i < verts.length; i++) {
			for (let j = i + 1; j < verts.length; j++) {
				const p = verts[i];
				const q = verts[j];
				const overlap =
					Math.min(spanBottomOf(p), spanBottomOf(q)) - Math.max(spanTopOf(p), spanTopOf(q));
				if (overlap < 8) continue;
				const dx = q.laneX - p.laneX;
				if (Math.abs(dx) >= trunkGap) continue;
				const push = (trunkGap - Math.abs(dx)) / 2;
				const dir = dx !== 0 ? Math.sign(dx) : p.upper.x <= q.upper.x ? 1 : -1;
				p.laneX -= dir * push;
				q.laneX += dir * push;
				moved = true;
			}
		}
		if (!moved) break;
		clearNodes();
	}

	return bottom;
}
