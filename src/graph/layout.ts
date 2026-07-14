import { EntityRecord, GLOBAL_TYPES } from '../types';
import { buildColumns } from '../columns';
import { LoomIndexer } from '../indexer';

export type NodeKind = 'session' | 'event' | 'global';

export interface LayoutNode {
	id: string;
	record: EntityRecord;
	/** Home position the node springs back to. */
	x: number;
	y: number;
	kind: NodeKind;
}

export interface LayoutEdge {
	a: string;
	b: string;
	relType: string;
	/**
	 * Signed perpendicular bow in px. 0 = straight line. Set when other nodes
	 * sit on (or very near) the straight segment between the endpoints, which
	 * the layered layout produces constantly — a session, its stacked events,
	 * and a barycentered global often share the same x, making edges collinear
	 * and invisible under each other.
	 */
	bow: number;
}

export interface GraphLayout {
	nodes: LayoutNode[];
	edges: LayoutEdge[];
	neighbors: Map<string, Set<string>>;
	width: number;
	height: number;
}

const COL_WIDTH = 170;
const MARGIN_X = 110;
const SESSION_Y = 80;
const EVENT_Y0 = 180;
const EVENT_DY = 90;
const GLOBAL_GAP = 140;
const GLOBAL_MIN_SPACING = 130;

/**
 * Layered layout:
 * - row 0: sessions, ordered chronologically (same column order as the
 *   timeline view — both derive from `buildColumns`);
 * - row 1: events, stacked beneath their linked session's column, unlinked
 *   events anchoring their own column;
 * - row 2: global entities (characters, locations, factions, items) on one
 *   fixed horizontal axis, each pulled toward the mean x of its connections.
 */
export function computeGraphLayout(
	indexer: LoomIndexer,
	projectRoot: string,
	edgeCurve: number
): GraphLayout {
	const nodes = new Map<string, LayoutNode>();

	const columns = buildColumns(indexer, null, projectRoot);
	let maxStack = 0;
	columns.forEach((col, i) => {
		const x = MARGIN_X + i * COL_WIDTH;
		const anchorKind = col.anchor.type === 'session' ? 'session' : 'event';
		nodes.set(col.anchor.path, {
			id: col.anchor.path,
			record: col.anchor,
			x,
			y: anchorKind === 'session' ? SESSION_Y : EVENT_Y0,
			kind: anchorKind,
		});
		col.events.forEach((ev, j) => {
			nodes.set(ev.path, { id: ev.path, record: ev, x, y: EVENT_Y0 + j * EVENT_DY, kind: 'event' });
			maxStack = Math.max(maxStack, j + 1);
		});
	});

	const globals = GLOBAL_TYPES.flatMap((t) => indexer.getAll(t, projectRoot)).sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	const globalY = EVENT_Y0 + Math.max(maxStack, 1) * EVENT_DY + GLOBAL_GAP;

	// Edges between all indexed entities, undirected and deduplicated —
	// which side declared the relationship doesn't matter for the graph.
	const edges: LayoutEdge[] = [];
	const neighbors = new Map<string, Set<string>>();
	const seen = new Set<string>();
	const indexed = new Set([...nodes.keys(), ...globals.map((g) => g.path)]);
	const link = (a: string, b: string, relType: string) => {
		if (!indexed.has(a) || !indexed.has(b) || a === b) return;
		const key = a < b ? `${a}\n${b}\n${relType}` : `${b}\n${a}\n${relType}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({ a, b, relType, bow: 0 });
		if (!neighbors.has(a)) neighbors.set(a, new Set());
		if (!neighbors.has(b)) neighbors.set(b, new Set());
		neighbors.get(a)?.add(b);
		neighbors.get(b)?.add(a);
	};
	for (const record of indexer.getAll(undefined, projectRoot)) {
		for (const conn of indexer.getOutgoing(record.path)) {
			link(record.path, conn.record.path, conn.relType);
		}
	}

	// Globals: barycenter of already-positioned neighbors, two passes so
	// global-global links also exert pull once first positions exist.
	const timelineMaxX = MARGIN_X + Math.max(columns.length - 1, 0) * COL_WIDTH;
	const desired = new Map<string, number>();
	const centerX = (MARGIN_X + timelineMaxX) / 2;
	for (let pass = 0; pass < 2; pass++) {
		for (const g of globals) {
			const xs: number[] = [];
			for (const n of neighbors.get(g.path) ?? []) {
				const node = nodes.get(n);
				if (node) xs.push(node.x);
				else if (pass > 0 && desired.has(n)) xs.push(desired.get(n) ?? 0);
			}
			desired.set(g.path, xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : centerX);
		}
	}

	const orderedGlobals = [...globals].sort(
		(a, b) => (desired.get(a.path) ?? 0) - (desired.get(b.path) ?? 0)
	);
	let prevX = -Infinity;
	for (const g of orderedGlobals) {
		const x = Math.max(desired.get(g.path) ?? centerX, prevX + GLOBAL_MIN_SPACING, MARGIN_X);
		nodes.set(g.path, { id: g.path, record: g, x, y: globalY, kind: 'global' });
		prevX = x;
	}

	const allNodes = [...nodes.values()];
	bowObstructedEdges(edges, nodes, allNodes, edgeCurve);
	const width = allNodes.reduce((m, n) => Math.max(m, n.x), 0) + MARGIN_X;
	return { nodes: allNodes, edges, neighbors, width, height: globalY + 100 };
}

/** How close (px) a node center must be to a segment to count as obstructing. */
const OBSTRUCTION_CLEARANCE = 28;

function pointToSegmentDistance(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Marks edges whose straight segment passes through other nodes, giving them
 * a sideways bow. Sides alternate across bowed edges so two curves sharing
 * the same corridor split apart instead of overlapping again.
 *
 * `curve` is the user-configured control-point offset; the rendered curve
 * deviates from the straight chord by half of it at the midpoint. Passing
 * through additional nodes deepens the bow up to +80%.
 */
function bowObstructedEdges(
	edges: LayoutEdge[],
	nodes: Map<string, LayoutNode>,
	allNodes: LayoutNode[],
	curve: number
): void {
	let side = 1;
	for (const edge of edges) {
		const a = nodes.get(edge.a);
		const b = nodes.get(edge.b);
		if (!a || !b) continue;
		let obstructions = 0;
		for (const n of allNodes) {
			if (n.id === edge.a || n.id === edge.b) continue;
			if (pointToSegmentDistance(n.x, n.y, a.x, a.y, b.x, b.y) < OBSTRUCTION_CLEARANCE) {
				obstructions++;
			}
		}
		if (obstructions > 0) {
			edge.bow = side * curve * (1 + Math.min(obstructions - 1, 2) * 0.4);
			side = -side;
		}
	}
}
