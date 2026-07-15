/**
 * Orthogonal edge routing: the geometry vocabulary shared by the layout
 * (which allocates lanes) and the graph view (which draws paths).
 *
 * Edge grammar (from Artie's sketch):
 * - edges leave the upper node horizontally, turn down a vertical trunk lane
 *   unique to the edge (parallel trunks run LANE_GAP apart), optionally run
 *   horizontally in the approach band above the target's row, and enter the
 *   lower node with a straight diagonal — several edges into one node fan in
 *   like spokes;
 * - edges between nodes on the same row make a U through the band beside the
 *   row (below for globals/events, above for sessions);
 * - all bends are slightly rounded.
 */

export type EdgeRoute =
	/** Straight line between the endpoints (vertically adjacent same-column nodes). */
	| { kind: 'direct' }
	/** Orthogonal Z between two timeline nodes: horizontal → trunk → horizontal. */
	| { kind: 'orth'; laneX: number }
	/**
	 * Upper node → lower-row node: horizontal → trunk at `laneX` → optional
	 * horizontal run at `approachY` → diagonal into the target. `fanOffset` is
	 * the diagonal's start x relative to the target so the fan follows a
	 * dragged node.
	 */
	| { kind: 'toLower'; laneX: number; approachY: number; fanOffset: number }
	/** Same-row pair: down (or up) to `uY`, across, back into the other node. */
	| { kind: 'rowU'; uY: number };

/** Routed connection; `a` is the upper (or left) endpoint, `b` the other. */
export interface RoutedEdge {
	a: string;
	b: string;
	relType: string;
	route: EdgeRoute;
}

export interface Pt {
	x: number;
	y: number;
}

/** Corner rounding radius of every bend. */
export const CORNER_RADIUS = 6;

/** Fan/lane x differences below this collapse into one vertical (no run). */
export const LANE_EPSILON = 4;

/** Waypoints of a route given the endpoints' live (displaced) positions. */
export function edgePoints(route: EdgeRoute, a: Pt, b: Pt): Pt[] {
	switch (route.kind) {
		case 'direct':
			return [a, b];
		case 'orth':
			return dedupe([a, { x: route.laneX, y: a.y }, { x: route.laneX, y: b.y }, b]);
		case 'toLower': {
			const fanX = b.x + route.fanOffset;
			const pts: Pt[] = [a, { x: route.laneX, y: a.y }, { x: route.laneX, y: route.approachY }];
			if (Math.abs(fanX - route.laneX) > LANE_EPSILON) pts.push({ x: fanX, y: route.approachY });
			pts.push(b);
			return dedupe(pts);
		}
		case 'rowU':
			return dedupe([a, { x: a.x, y: route.uY }, { x: b.x, y: route.uY }, b]);
	}
}

/** Drops consecutive (near-)duplicate points so corners never degenerate. */
function dedupe(pts: Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const prev = out[out.length - 1];
		if (!prev || Math.abs(prev.x - p.x) > 0.5 || Math.abs(prev.y - p.y) > 0.5) out.push(p);
	}
	return out;
}

/**
 * SVG path through `pts` with every interior corner rounded: each bend's
 * adjacent segments are shortened by up to `r` and joined with a quadratic
 * curve through the corner point. Works for any bend angle (including the
 * horizontal-run → diagonal joint).
 */
export function roundedPath(pts: Pt[], r: number): string {
	if (pts.length === 0) return '';
	let d = `M ${pts[0].x} ${pts[0].y}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const p = pts[i];
		const prev = pts[i - 1];
		const next = pts[i + 1];
		const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
		const outLen = Math.hypot(next.x - p.x, next.y - p.y);
		if (inLen === 0 || outLen === 0) continue;
		const rr = Math.min(r, inLen / 2, outLen / 2);
		const ex = p.x - ((p.x - prev.x) / inLen) * rr;
		const ey = p.y - ((p.y - prev.y) / inLen) * rr;
		const sx = p.x + ((next.x - p.x) / outLen) * rr;
		const sy = p.y + ((next.y - p.y) / outLen) * rr;
		d += ` L ${ex} ${ey} Q ${p.x} ${p.y} ${sx} ${sy}`;
	}
	const last = pts[pts.length - 1];
	d += ` L ${last.x} ${last.y}`;
	return d;
}

/** Full path of an edge from its endpoints' live positions. */
export function edgePath(route: EdgeRoute, a: Pt, b: Pt): string {
	return roundedPath(edgePoints(route, a, b), CORNER_RADIUS);
}

/** Horizontal extent of a route (for viewport culling of long trunks/runs). */
export function edgeXRange(route: EdgeRoute, a: Pt, b: Pt): [number, number] {
	let min = Math.min(a.x, b.x);
	let max = Math.max(a.x, b.x);
	if (route.kind === 'orth' || route.kind === 'toLower') {
		min = Math.min(min, route.laneX);
		max = Math.max(max, route.laneX);
	}
	return [min, max];
}
