import { Menu as ObsidianMenu, Notice, SliderComponent, ViewStateResult, debounce, normalizePath } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	EntityRecord,
	MAPS_FOLDER,
	MAPS_ICON,
	MAPS_LABEL,
	NODE_SIZE_PRESETS,
	NodeSizePreset,
	VIEW_MAP,
} from '../types';
import { linkTargetOf } from '../indexer';
import { ConfirmModal } from '../project';
import type LoomLoomPlugin from '../main';
import { LoomReactView } from './react-view';
import { EntityChip, Icon, SearchableSelect, ViewShell, noProjectMessage, recordLabel } from './common';
import { resolveProject, useIndexVersion } from './hooks';

/** One drawn zone: a polygon associated (optionally) with a location, which
 *  pins a node inside it. */
interface MapZone {
	id: string;
	/** A closed polygon ('zone') or an open, width-rendered centerline ('road'). */
	kind: 'zone' | 'road';
	/** Polygon vertices (zone) or the road's intermediate waypoints (road). A
	 *  road's real endpoints are its start/end locations' nodes, not stored here. */
	points: { x: number; y: number }[];
	/** Road only: link targets of the locations the road connects (its two ends). */
	startLoc?: string | null;
	endLoc?: string | null;
	/** Road stroke width in world units (ignored for zones). */
	width: number;
	/** Fill color (hex) — the outline is a darker shade of it. */
	color: string;
	/** Fill opacity 0..1. */
	alpha: number;
	/** Associated location's link target (file basename), or null. */
	location: string | null;
	/** Node world position (movable within the zone), or null when unassociated. */
	node: { x: number; y: number } | null;
	/** Node size preset (the location node's size). */
	nodeSize: NodeSizePreset;
	/** Portal links to other map pages, drawn as door icons inside the zone. */
	doors: { page: string; x: number; y: number }[];
	/** Item markers dropped inside the zone (link target + position). */
	itemPins: { item: string; x: number; y: number }[];
	/** Sublocation nodes shown inside the zone (a sublocation of the zone's
	 *  location, drawn as a smaller node; link target + position). */
	subPins: { loc: string; x: number; y: number }[];
	/** Locked zones can't be moved or reshaped (still selectable). */
	locked: boolean;
}

/** One named map page inside a project's Maps file. Pages nest via `parentId`
 *  (folder-like) and order among siblings via `order`. */
interface MapPage {
	id: string;
	name: string;
	parentId: string | null;
	order: number;
	zones: MapZone[];
}

interface MapsFile {
	version: number;
	activeId: string | null;
	maps: MapPage[];
}

const DEFAULT_ALPHA = 0.35;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const CLOSE_SNAP = 12; // screen px to the first vertex that closes a draft
const VERTEX_R = 5; // handle radius (screen px)
const CLICK_SLOP = 4; // px of movement below which a node press counts as a click
const DEFAULT_ROAD_WIDTH = 280; // world units — wide enough that location nodes fit inside
const ROAD_WIDTH_MIN = 8;
const ROAD_WIDTH_MAX = 1000;
const MIN_VERTEX_DIST = 12; // screen px — clicks nearer than this to the last vertex don't add one
const SUB_NODE_SCALE = 0.72; // each sublocation level renders this fraction of its parent's size
const MIN_SUB_NODE_SIZE = 6; // px floor — deeper sublocations never shrink past this
/** Opacity of the main location node in "close up" mode (see-through, so the
 *  focus is on the sublocations within). */
const CLOSEUP_NODE_OPACITY = 0.28;

/** The three map view modes, top→bottom on the scale slider. The mode is derived
 *  from the camera zoom (wheel-zoom flips it); a slider stop animates to that
 *  mode's zoom. */
type ViewMode = 'closeup' | 'regular' | 'nodeview';
const VIEW_MODES: [ViewMode, string][] = [
	['closeup', 'Close up'],
	['regular', 'Regular'],
	['nodeview', 'Node view'],
];
/** Zoom thresholds between the modes, and the zoom each slider stop targets. */
const CLOSEUP_K = 0.7;
const NODEVIEW_K = 0.08;
// The Node-view stop zooms to just PAST the threshold (not exactly on it) — so it
// reliably crosses into node view partway through the ease (single click) and the
// squish animation plays, rather than landing on the fragile boundary.
const MODE_K: Record<ViewMode, number> = { closeup: 1, regular: 0.5, nodeview: NODEVIEW_K * 0.85 };

/** Node size dropdown labels. */
const SIZE_OPTIONS: [NodeSizePreset, string][] = [
	['small', 'S'],
	['regular', 'M'],
	['big', 'L'],
	['very-big', 'XL'],
];

function newId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Truncates a too-long node title with an ellipsis (SVG text has no auto-clip). */
function clampLabel(name: string, max = 16): string {
	return name.length > max ? name.slice(0, max - 1).trimEnd() + '…' : name;
}

/** Parses a raw zones array tolerantly. */
function parseZones(raw: unknown): MapZone[] {
	if (!Array.isArray(raw)) return [];
	const zones: MapZone[] = [];
	for (const z of raw as Partial<MapZone>[]) {
		const kind: 'zone' | 'road' = z && z.kind === 'road' ? 'road' : 'zone';
		// Roads need only 2 points (an open line); zones need a closed polygon.
		const minPts = kind === 'road' ? 2 : 3;
		if (!z || !Array.isArray(z.points) || z.points.length < minPts) continue;
		zones.push({
			id: typeof z.id === 'string' ? z.id : newId(),
			kind,
			points: z.points
				.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
				.map((p) => ({ x: p.x, y: p.y })),
			startLoc: typeof z.startLoc === 'string' ? z.startLoc : null,
			endLoc: typeof z.endLoc === 'string' ? z.endLoc : null,
			width:
				typeof z.width === 'number' && Number.isFinite(z.width)
					? Math.max(ROAD_WIDTH_MIN, Math.min(ROAD_WIDTH_MAX, z.width))
					: DEFAULT_ROAD_WIDTH,
			color: typeof z.color === 'string' ? z.color : '#c9a36b',
			alpha: typeof z.alpha === 'number' ? Math.max(0, Math.min(1, z.alpha)) : DEFAULT_ALPHA,
			location: typeof z.location === 'string' ? z.location : null,
			node:
				z.node && Number.isFinite(z.node.x) && Number.isFinite(z.node.y)
					? { x: z.node.x, y: z.node.y }
					: null,
			nodeSize:
				z.nodeSize === 'small' || z.nodeSize === 'regular' || z.nodeSize === 'big' || z.nodeSize === 'very-big'
					? z.nodeSize
					: 'regular',
			doors: Array.isArray(z.doors)
				? z.doors
						.filter(
							(dr): dr is { page: string; x: number; y: number } =>
								!!dr &&
								typeof (dr as { page?: unknown }).page === 'string' &&
								Number.isFinite((dr as { x?: unknown }).x) &&
								Number.isFinite((dr as { y?: unknown }).y)
						)
						.map((dr) => ({ page: dr.page, x: dr.x, y: dr.y }))
				: [],
			itemPins: Array.isArray(z.itemPins)
				? z.itemPins
						.filter(
							(it): it is { item: string; x: number; y: number } =>
								!!it &&
								typeof (it as { item?: unknown }).item === 'string' &&
								Number.isFinite((it as { x?: unknown }).x) &&
								Number.isFinite((it as { y?: unknown }).y)
						)
						.map((it) => ({ item: it.item, x: it.x, y: it.y }))
				: [],
			subPins: Array.isArray(z.subPins)
				? z.subPins
						.filter(
							(sp): sp is { loc: string; x: number; y: number } =>
								!!sp &&
								typeof (sp as { loc?: unknown }).loc === 'string' &&
								Number.isFinite((sp as { x?: unknown }).x) &&
								Number.isFinite((sp as { y?: unknown }).y)
						)
						.map((sp) => ({ loc: sp.loc, x: sp.x, y: sp.y }))
				: [],
			locked: z.locked === true,
		});
	}
	return zones;
}

/** A single default page (used for a brand-new project map). */
function defaultPages(): MapPage[] {
	return [{ id: newId(), name: 'Map', parentId: null, order: 0, zones: [] }];
}

/** Parses the persisted Maps file, tolerating both the multi-map shape and the
 *  legacy single-map shape (`{ version, zones }` → one page). Returns null when
 *  nothing usable is found. */
function parseMapsFile(text: string): MapsFile | null {
	try {
		const d = JSON.parse(text) as { maps?: unknown; zones?: unknown; activeId?: unknown };
		if (Array.isArray(d.maps)) {
			const maps: MapPage[] = (d.maps as Partial<MapPage>[]).map((m, i) => ({
				id: typeof m.id === 'string' ? m.id : newId(),
				name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name : 'Map',
				parentId: typeof m.parentId === 'string' ? m.parentId : null,
				order: typeof m.order === 'number' ? m.order : i,
				zones: parseZones(m.zones),
			}));
			if (maps.length === 0) return { version: 2, activeId: null, maps: defaultPages() };
			return { version: 2, activeId: typeof d.activeId === 'string' ? d.activeId : null, maps };
		}
		// Legacy single-map file → one page.
		if (Array.isArray(d.zones)) {
			return {
				version: 2,
				activeId: null,
				maps: [{ id: newId(), name: 'Map', parentId: null, order: 0, zones: parseZones(d.zones) }],
			};
		}
	} catch {
		/* fall through */
	}
	return null;
}

/** A darker shade of a hex color (for zone outlines + nodes). */
function darker(hex: string, factor = 0.6): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = Math.round(((n >> 16) & 0xff) * factor);
	const g = Math.round(((n >> 8) & 0xff) * factor);
	const b = Math.round((n & 0xff) * factor);
	return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Ink for a glyph drawn over `hex`: a darker shade of the same hue on a light
 *  fill, a lighter shade on a dark fill — so it always contrasts (chosen by
 *  perceived luminance). */
function glyphInk(hex: string): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return '#333333';
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	const L = 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0..255 perceived
	if (L < 110) {
		// Dark fill → lighten toward white (keep the hue).
		const up = (c: number) => Math.round(c + (255 - c) * 0.72);
		return `#${((1 << 24) | (up(r) << 16) | (up(g) << 8) | up(b)).toString(16).slice(1)}`;
	}
	// Light fill → darken.
	return darker(hex, 0.45);
}

function centroid(points: { x: number; y: number }[]): { x: number; y: number } {
	const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
	return { x: s.x / points.length, y: s.y / points.length };
}

/** Area (balance) centroid of a polygon; falls back to the vertex average for a
 *  degenerate (zero-area) shape. */
function polygonCentroid(pts: { x: number; y: number }[]): { x: number; y: number } {
	let a = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const cross = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
		a += cross;
		cx += (pts[j].x + pts[i].x) * cross;
		cy += (pts[j].y + pts[i].y) * cross;
	}
	if (Math.abs(a) < 1e-6) return centroid(pts);
	return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** The point half-way along a polyline's total length (a road's middle). */
function polylineMidpoint(pts: { x: number; y: number }[]): { x: number; y: number } {
	if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
	let half = total / 2;
	for (let i = 1; i < pts.length; i++) {
		const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
		if (half <= seg) {
			const t = seg === 0 ? 0 : half / seg;
			return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
		}
		half -= seg;
	}
	return pts[pts.length - 1];
}

function pointInPolygon(px: number, py: number, pts: { x: number; y: number }[]): boolean {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const xi = pts[i].x;
		const yi = pts[i].y;
		const xj = pts[j].x;
		const yj = pts[j].y;
		const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function nearestOnSegment(
	p: { x: number; y: number },
	a: { x: number; y: number },
	b: { x: number; y: number }
): { x: number; y: number } {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy || 1;
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return { x: a.x + t * dx, y: a.y + t * dy };
}

function distToPolygon(px: number, py: number, pts: { x: number; y: number }[]): number {
	let best = Infinity;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const q = nearestOnSegment({ x: px, y: py }, pts[j], pts[i]);
		best = Math.min(best, Math.hypot(px - q.x, py - q.y));
	}
	return best;
}

/** Segment/segment intersection parameter `t` along p1→p2 (0..1), or null. */
function segIntersectT(
	p1: { x: number; y: number },
	p2: { x: number; y: number },
	p3: { x: number; y: number },
	p4: { x: number; y: number }
): number | null {
	const d1x = p2.x - p1.x;
	const d1y = p2.y - p1.y;
	const d2x = p4.x - p3.x;
	const d2y = p4.y - p3.y;
	const denom = d1x * d2y - d1y * d2x;
	if (Math.abs(denom) < 1e-9) return null;
	const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
	const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Where segment `from`→`to` first crosses a polygon boundary (from inside → the
 *  zone edge). Returns `from` when it never crosses. */
function boundaryExit(
	from: { x: number; y: number },
	to: { x: number; y: number },
	poly: { x: number; y: number }[]
): { x: number; y: number } {
	let bestT = Infinity;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const t = segIntersectT(from, to, poly[j], poly[i]);
		if (t !== null && t > 1e-6 && t < bestT) bestT = t;
	}
	if (bestT === Infinity) return from;
	return { x: from.x + (to.x - from.x) * bestT, y: from.y + (to.y - from.y) * bestT };
}

/** Distance from a point to an open polyline (road centerline). */
function distToPolyline(px: number, py: number, pts: { x: number; y: number }[]): number {
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const q = nearestOnSegment({ x: px, y: py }, pts[i - 1], pts[i]);
		best = Math.min(best, Math.hypot(px - q.x, py - q.y));
	}
	return best;
}

/** Inserts a vertex into `pts` on whichever segment is nearest to (px,py),
 *  returning the new points. `closed` wraps the last→first segment (polygons). */
function insertVertexAt(
	pts: { x: number; y: number }[],
	px: number,
	py: number,
	closed: boolean
): { x: number; y: number }[] {
	let bestI = -1;
	let bestQ = { x: px, y: py };
	let bestD = Infinity;
	const last = closed ? pts.length : pts.length - 1;
	for (let i = 0; i < last; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		const q = nearestOnSegment({ x: px, y: py }, a, b);
		const d = Math.hypot(px - q.x, py - q.y);
		if (d < bestD) {
			bestD = d;
			bestQ = q;
			bestI = i;
		}
	}
	if (bestI < 0) return pts;
	const next = pts.slice();
	next.splice(bestI + 1, 0, { x: bestQ.x, y: bestQ.y });
	return next;
}

/** Constrains a point to the inside of a polygon (nearest boundary point when
 *  outside), so a node can't be dragged out of its zone. */
function clampToPolygon(p: { x: number; y: number }, pts: { x: number; y: number }[]): { x: number; y: number } {
	if (pointInPolygon(p.x, p.y, pts)) return p;
	let best = p;
	let bestD = Infinity;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const q = nearestOnSegment(p, pts[j], pts[i]);
		const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
		if (d < bestD) {
			bestD = d;
			best = q;
		}
	}
	return best;
}

/** Nearest point on an open polyline (road centerline) to p. */
function nearestOnPolyline(
	p: { x: number; y: number },
	pts: { x: number; y: number }[]
): { x: number; y: number } {
	let best = pts[0] ?? p;
	let bestD = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const q = nearestOnSegment(p, pts[i - 1], pts[i]);
		const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
		if (d < bestD) {
			bestD = d;
			best = q;
		}
	}
	return best;
}

/** Constrains a point to within `half` of a road's centerline (its capsule
 *  body), so a road node can't be dragged off the road. */
function clampToCapsule(
	p: { x: number; y: number },
	pts: { x: number; y: number }[],
	half: number
): { x: number; y: number } {
	const q = nearestOnPolyline(p, pts);
	const dist = Math.hypot(p.x - q.x, p.y - q.y);
	if (dist <= half) return p;
	const t = half / (dist || 1);
	return { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t };
}

/** Clamps a node position inside its zone — polygon interior or road capsule. */
function clampToZone(p: { x: number; y: number }, zone: MapZone): { x: number; y: number } {
	return zone.kind === 'road' ? clampToCapsule(p, zone.points, zone.width / 2) : clampToPolygon(p, zone.points);
}

/** The balance center of a zone — a polygon's area centroid, or a road's middle. */
function zoneCenter(zone: MapZone): { x: number; y: number } {
	return zone.kind === 'road' ? polylineMidpoint(zone.points) : polygonCentroid(zone.points);
}

type Pt = { x: number; y: number };

/** Convex hull (Andrew's monotone chain), CCW. Returns the input for <3 points. */
function convexHull(pts: Pt[]): Pt[] {
	if (pts.length < 3) return pts.slice();
	const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower: Pt[] = [];
	for (const pt of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
		lower.push(pt);
	}
	const upper: Pt[] = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const pt = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
		upper.push(pt);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

/** Median nearest-neighbour distance among points — the typical spacing, used to
 *  scale the region-cluster merge threshold to the map. */
function medianNearestNeighbor(pts: Pt[]): number {
	if (pts.length < 2) return 0;
	const nn = pts
		.map((_, i) => {
			let best = Infinity;
			for (let j = 0; j < pts.length; j++) {
				if (i === j) continue;
				best = Math.min(best, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
			}
			return best;
		})
		.sort((a, b) => a - b);
	return nn[Math.floor(nn.length / 2)] || 0;
}

function regularPolygon(center: Pt, r: number, n = 16): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i < n; i++) {
		const a = (Math.PI * 2 * i) / n;
		out.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
	}
	return out;
}

/** The padded outline that wraps a cluster of nodes: a convex hull pushed
 *  outward by `pad` (a rounded blob for 1–2 points). */
function regionHull(cluster: Pt[], pad: number): Pt[] {
	if (cluster.length === 0) return [];
	const c = centroid(cluster);
	if (cluster.length === 1) return regularPolygon(cluster[0], pad);
	const hull = convexHull(cluster);
	if (hull.length < 3) {
		const r = Math.max(...cluster.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) + pad;
		return regularPolygon(c, r);
	}
	// Push each hull vertex outward from the cluster centroid.
	return hull.map((v) => {
		const dx = v.x - c.x;
		const dy = v.y - c.y;
		const len = Math.hypot(dx, dy) || 1;
		return { x: v.x + (dx / len) * pad, y: v.y + (dy / len) * pad };
	});
}

interface Camera {
	tx: number;
	ty: number;
	k: number;
}

/** What context panel is open (right-click only). Zone menus anchor to a WORLD
 *  point so they follow the zone when it's moved; the empty-space menu is a
 *  fixed screen point. (A node right-click falls through to its zone menu.) */
type Menu =
	| { kind: 'zone'; id: string; wx: number; wy: number }
	| { kind: 'empty'; sx: number; sy: number }
	| null;

export class MapView extends LoomReactView {
	projectRoot: string | null = null;

	getViewType(): string {
		return VIEW_MAP;
	}

	getDisplayText(): string {
		return MAPS_LABEL;
	}

	getIcon(): string {
		return MAPS_ICON;
	}

	getState(): Record<string, unknown> {
		return { project: this.projectRoot };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as { project?: unknown } | null;
		if (typeof s?.project === 'string') this.projectRoot = s.project;
		await super.setState(state, result);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <MapCanvas key={this.projectRoot ?? ''} view={this} projectRoot={this.projectRoot} />;
	}
}

function MapCanvas({ view, projectRoot }: { view: MapView; projectRoot: string | null }) {
	const plugin = view.plugin;
	const indexVersion = useIndexVersion(plugin.indexer);
	const project = resolveProject(plugin.indexer, projectRoot);

	const wrapRef = useRef<HTMLDivElement>(null);
	const [camera, setCamera] = useState<Camera>(() => ({ tx: 0, ty: 0, k: MODE_K.regular }));
	const cameraRef = useRef(camera);
	cameraRef.current = camera;
	const camRaf = useRef(0);
	const activeIdRef = useRef('');
	// Remember the camera per map PAGE (debounced) so each page keeps its own view.
	const cameraKey = useCallback(
		(pageId: string) => `${projectRoot ?? ''}::${pageId}`,
		[projectRoot]
	);
	const saveCamera = useMemo(
		() =>
			debounce((key: string, cam: Camera) => {
				plugin.settings.mapCameras[key] = cam;
				void plugin.saveSettings();
			}, 400, true),
		[plugin]
	);
	useEffect(() => {
		if (project && activeIdRef.current) saveCamera(cameraKey(activeIdRef.current), camera);
	}, [camera, project, saveCamera, cameraKey]);
	/** Restores (or defaults to regular, centered) the camera for a map page. */
	const restoreCamera = useCallback(
		(pageId: string) => {
			const saved = plugin.settings.mapCameras[cameraKey(pageId)];
			if (saved) {
				setCamera(saved);
				return;
			}
			const el = wrapRef.current;
			const w = el?.clientWidth ?? 900;
			const h = el?.clientHeight ?? 600;
			setCamera({ k: MODE_K.regular, tx: w / 2, ty: h / 2 });
		},
		[plugin, cameraKey]
	);
	useEffect(() => () => window.cancelAnimationFrame(camRaf.current), []);

	const [zones, setZones] = useState<MapZone[]>([]);
	const zonesRef = useRef(zones);
	zonesRef.current = zones;
	const [tool, setTool] = useState<'select' | 'draw' | 'road' | 'rect'>('select');
	/** Live preview rectangle while dragging with the rectangle tool (world). */
	const [rectPreview, setRectPreview] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	/** Marquee selection box (Ctrl+drag on empty space), in world coords. */
	const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	/** Dragging a sublocation or item from the zone menu onto the canvas to place
	 *  its marker (a ghost follows the cursor; drop drops it exactly there). */
	const [pinDrag, setPinDrag] = useState<{ kind: 'sub' | 'item' | 'door'; target: string; zoneId: string } | null>(
		null
	);
	const [pinDragPos, setPinDragPos] = useState<{ x: number; y: number } | null>(null);
	/** Multi-selected vertices: keys `${zoneId}:${index}`. Moved together. */
	const [selectedVerts, setSelectedVerts] = useState<Set<string>>(new Set());
	const selectedVertsRef = useRef(selectedVerts);
	selectedVertsRef.current = selectedVerts;
	// View mode is derived from the camera zoom, so wheel-zoom flips it: close up
	// when zoomed in, node view when zoomed far out, regular between.
	const viewMode: ViewMode =
		camera.k >= CLOSEUP_K ? 'closeup' : camera.k <= NODEVIEW_K ? 'nodeview' : 'regular';
	const viewModeRef = useRef(viewMode);
	viewModeRef.current = viewMode;
	// Squish animation: zones warp into their node as node view turns on (0 = full
	// zones, 1 = collapsed into the node). Eased toward the mode's target.
	const squishRef = useRef(0);
	const [, forceTick] = useState(0);
	useEffect(() => {
		const target = viewMode === 'nodeview' ? 1 : 0;
		const from = squishRef.current;
		if (from === target) return;
		// Time-based ease-in-out over a fixed duration, so the squish is clearly
		// visible even after the camera has finished zooming (an exponential ease
		// front-loads and looks instant against the zoom-out).
		const start = performance.now();
		const dur = 260;
		let raf = 0;
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / dur);
			const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			squishRef.current = from + (target - from) * e;
			forceTick((x) => x + 1);
			if (t < 1) raf = window.requestAnimationFrame(step);
			else squishRef.current = target;
		};
		raf = window.requestAnimationFrame(step);
		return () => window.cancelAnimationFrame(raf);
	}, [viewMode]);
	const [draft, setDraft] = useState<{ x: number; y: number }[]>([]);
	const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
	/** Road drawing: the start location's link target, picked with the first click
	 *  (a road runs location→location; the drawn `draft` points are the waypoints). */
	const [roadDraft, setRoadDraft] = useState<{ startLoc: string } | null>(null);
	/** Zone whose vertices are editable (left-click select), independent of the
	 *  context menu (right-click only). */
	const [selectedZone, setSelectedZone] = useState<string | null>(null);
	/** A main node selected by clicking it (separate from zone selection) — only
	 *  this highlights the node. */
	const [selectedNode, setSelectedNode] = useState<string | null>(null);
	/** Zone id whose sublocation graph overlay is open (a main-node click). */
	const [subGraph, setSubGraph] = useState<string | null>(null);
	const [menu, setMenu] = useState<Menu>(null);
	/** Where the last menu was opened in world space (a new node lands here). */
	const menuWorld = useRef<{ x: number; y: number } | null>(null);

	// --- Persistence (multi-map) ---------------------------------------------
	// All map pages of the project. The ACTIVE page's zones live in `zones` (the
	// editing working copy); other pages keep their zones in this list. The panel
	// reads page metadata (name / parentId / order) from here.
	const [pages, setPages] = useState<MapPage[]>([]);
	const pagesRef = useRef(pages);
	pagesRef.current = pages;
	const [activeId, setActiveId] = useState<string>('');
	activeIdRef.current = activeId;

	const mapsPath = useMemo(() => {
		if (!project) return null;
		const base = `${MAPS_FOLDER}/${project.name} Maps.json`;
		return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
	}, [project]);
	// Legacy single-map file, migrated on first load.
	const legacyMapPath = useMemo(() => {
		if (!project) return null;
		const base = `${MAPS_FOLDER}/${project.name} Map.json`;
		return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
	}, [project]);

	useEffect(() => {
		if (!mapsPath) return;
		let cancelled = false;
		void (async () => {
			let file: MapsFile | null = null;
			const existing = plugin.app.vault.getFileByPath(mapsPath);
			if (existing) {
				try {
					file = parseMapsFile(await plugin.app.vault.cachedRead(existing));
				} catch {
					file = null;
				}
			} else if (legacyMapPath) {
				// Migrate the old single-map file into a one-page Maps file.
				const old = plugin.app.vault.getFileByPath(legacyMapPath);
				if (old) {
					try {
						file = parseMapsFile(await plugin.app.vault.cachedRead(old));
					} catch {
						file = null;
					}
				}
			}
			if (cancelled) return;
			const loaded = file ?? { version: 2, activeId: null, maps: defaultPages() };
			const first = loaded.maps[0];
			const active = loaded.maps.find((m) => m.id === loaded.activeId)?.id ?? first.id;
			activeIdRef.current = active;
			setPages(loaded.maps);
			setActiveId(active);
			setZones(loaded.maps.find((m) => m.id === active)?.zones ?? []);
			restoreCamera(active);
		})();
		return () => {
			cancelled = true;
		};
	}, [mapsPath, legacyMapPath, plugin, restoreCamera]);

	/** Writes the whole Maps file: `pages` with the active page's zones replaced
	 *  by `activeZones` (the live working copy). */
	const writeMaps = useCallback(
		async (activeZones: MapZone[]) => {
			if (!mapsPath) return;
			const data: MapsFile = {
				version: 2,
				activeId: activeIdRef.current || null,
				maps: pagesRef.current.map((p) => ({
					...p,
					zones: p.id === activeIdRef.current ? activeZones : p.zones,
				})),
			};
			const text = JSON.stringify(data, null, '\t');
			const existing = plugin.app.vault.getFileByPath(mapsPath);
			if (existing) {
				await plugin.app.vault.modify(existing, text);
				return;
			}
			const folder = mapsPath.slice(0, mapsPath.lastIndexOf('/'));
			if (folder && !plugin.app.vault.getAbstractFileByPath(folder)) {
				try {
					await plugin.app.vault.createFolder(folder);
				} catch {
					/* raced/exists */
				}
			}
			await plugin.app.vault.create(mapsPath, text);
		},
		[mapsPath, plugin]
	);
	const saveLater = useMemo(() => debounce((next: MapZone[]) => void writeMaps(next), 500, true), [writeMaps]);

	const commit = useCallback(
		(next: MapZone[]) => {
			setZones(next);
			saveLater(next);
		},
		[saveLater]
	);
	const updateZone = useCallback(
		(id: string, patch: Partial<MapZone>) => {
			commit(zonesRef.current.map((z) => (z.id === id ? { ...z, ...patch } : z)));
		},
		[commit]
	);

	// --- Undo / redo (map-local, Ctrl+Z / Ctrl+Shift+Z) ----------------------
	const cloneZones = (zs: MapZone[]): MapZone[] =>
		zs.map((z) => ({ ...z, points: z.points.map((p) => ({ ...p })), node: z.node ? { ...z.node } : null }));
	const history = useRef<{ undo: MapZone[][]; redo: MapZone[][] }>({ undo: [], redo: [] });
	const pendingSnap = useRef<MapZone[] | null>(null);
	const HISTORY_CAP = 200;
	/** Records the current state as an undo step (call BEFORE a discrete change). */
	const snapshot = useCallback(() => {
		history.current.undo.push(cloneZones(zonesRef.current));
		if (history.current.undo.length > HISTORY_CAP) history.current.undo.shift();
		history.current.redo = [];
	}, []);
	/** Begins a coalesced gesture (drag / slider): captures the pre-change state
	 *  once; committed at pointerup only if something actually changed. */
	const beginPending = useCallback(() => {
		if (!pendingSnap.current) pendingSnap.current = cloneZones(zonesRef.current);
	}, []);
	const commitPending = useCallback(() => {
		const prev = pendingSnap.current;
		pendingSnap.current = null;
		if (!prev) return;
		if (JSON.stringify(prev) === JSON.stringify(zonesRef.current)) return;
		history.current.undo.push(prev);
		if (history.current.undo.length > HISTORY_CAP) history.current.undo.shift();
		history.current.redo = [];
	}, []);
	const undo = useCallback(() => {
		const h = history.current;
		if (h.undo.length === 0) return;
		h.redo.push(cloneZones(zonesRef.current));
		const prev = h.undo.pop() as MapZone[];
		setMenu(null);
		setZones(prev);
		saveLater(prev);
	}, [saveLater]);
	const redo = useCallback(() => {
		const h = history.current;
		if (h.redo.length === 0) return;
		h.undo.push(cloneZones(zonesRef.current));
		const next = h.redo.pop() as MapZone[];
		setMenu(null);
		setZones(next);
		saveLater(next);
	}, [saveLater]);
	// End any coalesced gesture (drag / panel slider) on pointerup.
	useEffect(() => {
		const onUp = () => commitPending();
		window.addEventListener('pointerup', onUp);
		return () => window.removeEventListener('pointerup', onUp);
	}, [commitPending]);

	// --- Map pages (create / switch / rename / delete / nest) ----------------
	/** Writes a new pages list (metadata change) keeping the live active zones. */
	const commitPages = useCallback(
		(next: MapPage[]) => {
			pagesRef.current = next;
			setPages(next);
			saveLater(zonesRef.current);
		},
		[saveLater]
	);
	/** Snapshots the live active zones back into their page — used before making
	 *  another page active so the current one's edits aren't lost. */
	const foldActiveZones = useCallback(
		(): MapPage[] =>
			pagesRef.current.map((p) => (p.id === activeIdRef.current ? { ...p, zones: zonesRef.current } : p)),
		[]
	);
	const activatePage = useCallback(
		(next: MapPage[], id: string) => {
			const target = next.find((p) => p.id === id);
			if (!target) return;
			// Snapshot the outgoing page's camera now (a debounced save could still be
			// pending and would otherwise be replaced by the incoming page's save).
			const prevId = activeIdRef.current;
			if (prevId && prevId !== id) plugin.settings.mapCameras[cameraKey(prevId)] = cameraRef.current;
			pagesRef.current = next;
			activeIdRef.current = id;
			setPages(next);
			setActiveId(id);
			setZones(target.zones);
			history.current = { undo: [], redo: [] };
			pendingSnap.current = null;
			setMenu(null);
			setSelectedZone(null);
			setSelectedVerts(new Set());
			setDraft([]);
			setTool('select');
			// Each page restores its own remembered camera (a fresh page → regular).
			restoreCamera(id);
			saveLater(target.zones);
		},
		[saveLater, restoreCamera, plugin, cameraKey]
	);
	const switchMap = useCallback(
		(id: string) => {
			if (id === activeIdRef.current) return;
			activatePage(foldActiveZones(), id);
		},
		[activatePage, foldActiveZones]
	);
	const createMap = useCallback(
		(parentId: string | null = null) => {
			const siblings = pagesRef.current.filter((p) => p.parentId === parentId);
			const order = siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0;
			// Empty name → the panel names it (inline field / auto "New map N").
			const page: MapPage = { id: newId(), name: '', parentId, order, zones: [] };
			// A brand-new page has no saved camera → activatePage restores regular.
			activatePage([...foldActiveZones(), page], page.id);
		},
		[activatePage, foldActiveZones]
	);
	const renameMap = useCallback(
		(id: string, name: string) => {
			commitPages(pagesRef.current.map((p) => (p.id === id ? { ...p, name: name.trim() || 'Map' } : p)));
		},
		[commitPages]
	);
	const deleteMap = useCallback(
		(id: string) => {
			const deleted = pagesRef.current.find((p) => p.id === id);
			// Re-parent the deleted map's children to its parent (don't orphan them).
			const next = pagesRef.current
				.filter((p) => p.id !== id)
				.map((p) => (p.parentId === id ? { ...p, parentId: deleted?.parentId ?? null } : p));
			const pages2 = next.length ? next : defaultPages();
			if (activeIdRef.current === id) {
				activatePage(pages2, pages2[0].id);
			} else {
				commitPages(pages2);
			}
		},
		[activatePage, commitPages]
	);
	/** Nests `dragId` under `targetId` (null = top level), guarding cycles. */
	const nestMap = useCallback(
		(dragId: string, targetId: string | null) => {
			if (dragId === targetId) return;
			const byId = new Map(pagesRef.current.map((p) => [p.id, p]));
			for (let cur = targetId; cur; cur = byId.get(cur)?.parentId ?? null) {
				if (cur === dragId) return; // target is a descendant of the dragged map
			}
			const siblings = pagesRef.current.filter((p) => p.parentId === targetId && p.id !== dragId);
			const order = siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0;
			commitPages(
				pagesRef.current.map((p) => (p.id === dragId ? { ...p, parentId: targetId, order } : p))
			);
		},
		[commitPages]
	);

	// Wheel zoom around the cursor.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			// Over a menu/dropdown/panel, let the wheel scroll that instead of zooming.
			if ((e.target as HTMLElement).closest('.loom-map-menu, .loom-combo-menu, .loom-map-panel')) return;
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			setCamera((c) => {
				const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.k * Math.exp(-e.deltaY * 0.0015)));
				const wx = (px - c.tx) / c.k;
				const wy = (py - c.ty) / c.k;
				return { k, tx: px - wx * k, ty: py - wy * k };
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, []);

	const toWorld = useCallback((sx: number, sy: number) => {
		const c = cameraRef.current;
		return { x: (sx - c.tx) / c.k, y: (sy - c.ty) / c.k };
	}, []);
	const screenOf = useCallback((wx: number, wy: number) => {
		const c = cameraRef.current;
		return { x: wx * c.k + c.tx, y: wy * c.k + c.ty };
	}, []);
	const localXY = useCallback((clientX: number, clientY: number) => {
		const rect = wrapRef.current?.getBoundingClientRect();
		return { sx: clientX - (rect?.left ?? 0), sy: clientY - (rect?.top ?? 0) };
	}, []);

	// --- Drag machinery (pan / vertex / grip / node) -------------------------
	const drag = useRef<
		| null
		| { kind: 'pan'; startX: number; startY: number; tx0: number; ty0: number }
		| {
				kind: 'vertex';
				id: string;
				index: number;
				orig: { x: number; y: number };
				// When multi-selecting, the starting positions of every moved vertex.
				group?: { id: string; index: number; x: number; y: number }[];
				last: { x: number; y: number };
			}
		| { kind: 'grip'; id: string; last: { x: number; y: number } }
		| { kind: 'zone-move'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
		| { kind: 'node'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
		| { kind: 'door'; id: string; index: number; startX: number; startY: number; moved: boolean }
		| { kind: 'itempin'; id: string; index: number; startX: number; startY: number; moved: boolean }
		| { kind: 'subpin'; id: string; index: number; startX: number; startY: number; moved: boolean }
		| { kind: 'rect'; start: { x: number; y: number }; end: { x: number; y: number } }
		| { kind: 'marquee'; start: { x: number; y: number }; end: { x: number; y: number } }
	>(null);
	const [dragActive, setDragActive] = useState(false);

	useEffect(() => {
		if (!dragActive) return;
		const onMove = (e: PointerEvent) => {
			const d = drag.current;
			if (!d) return;
			if (d.kind === 'pan') {
				setCamera({
					tx: d.tx0 + (e.clientX - d.startX),
					ty: d.ty0 + (e.clientY - d.startY),
					k: cameraRef.current.k,
				});
				return;
			}
			const { sx, sy } = localXY(e.clientX, e.clientY);
			const w = toWorld(sx, sy);
			if (d.kind === 'rect' || d.kind === 'marquee') {
				d.end = { x: w.x, y: w.y };
				const box = { x0: d.start.x, y0: d.start.y, x1: w.x, y1: w.y };
				if (d.kind === 'rect') setRectPreview(box);
				else setMarquee(box);
				return;
			}
			if (d.kind === 'vertex') {
				// Ctrl locks movement to the dominant axis (from the vertex's origin),
				// for clean horizontal/vertical alignment.
				let tx = w.x;
				let ty = w.y;
				if (e.ctrlKey || e.metaKey) {
					if (Math.abs(w.x - d.orig.x) >= Math.abs(w.y - d.orig.y)) ty = d.orig.y;
					else tx = d.orig.x;
				}
				const dvx = tx - d.last.x;
				const dvy = ty - d.last.y;
				d.last = { x: tx, y: ty };
				if (d.group && d.group.length > 1) {
					// Move every selected vertex by the same delta.
					const byZone = new Map<string, Set<number>>();
					for (const g of d.group) {
						if (!byZone.has(g.id)) byZone.set(g.id, new Set());
						byZone.get(g.id)!.add(g.index);
					}
					setZones(
						zonesRef.current.map((z) => {
							const idxs = byZone.get(z.id);
							if (!idxs) return z;
							return {
								...z,
								points: z.points.map((p, i) => (idxs.has(i) ? { x: p.x + dvx, y: p.y + dvy } : p)),
							};
						})
					);
				} else {
					setZones(
						zonesRef.current.map((z) =>
							z.id === d.id
								? { ...z, points: z.points.map((p, i) => (i === d.index ? { x: tx, y: ty } : p)) }
								: z
						)
					);
				}
			} else if (d.kind === 'grip' || d.kind === 'zone-move') {
				if (d.kind === 'zone-move' && !d.moved) {
					if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_SLOP) return;
					d.moved = true;
				}
				const dx = w.x - d.last.x;
				const dy = w.y - d.last.y;
				d.last = { x: w.x, y: w.y };
				setZones(
					zonesRef.current.map((z) =>
						z.id === d.id
							? {
									...z,
									points: z.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
									node: z.node ? { x: z.node.x + dx, y: z.node.y + dy } : null,
									doors: z.doors.map((dr) => ({ ...dr, x: dr.x + dx, y: dr.y + dy })),
									itemPins: z.itemPins.map((it) => ({ ...it, x: it.x + dx, y: it.y + dy })),
									subPins: z.subPins.map((sp) => ({ ...sp, x: sp.x + dx, y: sp.y + dy })),
								}
							: z
					)
				);
				// Keep an open zone menu attached to the moving zone.
				setMenu((m) => (m && m.kind === 'zone' && m.id === d.id ? { ...m, wx: m.wx + dx, wy: m.wy + dy } : m));
			} else if (d.kind === 'node') {
				if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_SLOP) return;
				d.moved = true;
				const z = zonesRef.current.find((zz) => zz.id === d.id);
				if (!z) return;
				if (viewModeRef.current === 'nodeview') {
					// In node view the zone is collapsed into its node, so dragging the
					// node moves the whole zone.
					const dx = w.x - d.last.x;
					const dy = w.y - d.last.y;
					d.last = { x: w.x, y: w.y };
					setZones(
						zonesRef.current.map((zz) =>
							zz.id === d.id
								? {
										...zz,
										points: zz.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
										node: zz.node ? { x: zz.node.x + dx, y: zz.node.y + dy } : null,
										doors: zz.doors.map((dr) => ({ ...dr, x: dr.x + dx, y: dr.y + dy })),
										itemPins: zz.itemPins.map((it) => ({ ...it, x: it.x + dx, y: it.y + dy })),
										subPins: zz.subPins.map((sp) => ({ ...sp, x: sp.x + dx, y: sp.y + dy })),
									}
								: zz
						)
					);
					setMenu((m) => (m && m.kind === 'zone' && m.id === d.id ? { ...m, wx: m.wx + dx, wy: m.wy + dy } : m));
				} else {
					const clamped = clampToZone(w, z);
					setZones(zonesRef.current.map((zz) => (zz.id === d.id ? { ...zz, node: clamped } : zz)));
				}
			} else if (d.kind === 'door' || d.kind === 'itempin' || d.kind === 'subpin') {
				if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_SLOP) return;
				d.moved = true;
				const z = zonesRef.current.find((zz) => zz.id === d.id);
				if (!z) return;
				const c = clampToZone(w, z);
				const kind = d.kind;
				const idx = d.index;
				setZones(
					zonesRef.current.map((zz) => {
						if (zz.id !== d.id) return zz;
						if (kind === 'door')
							return { ...zz, doors: zz.doors.map((dr, i) => (i === idx ? { ...dr, x: c.x, y: c.y } : dr)) };
						if (kind === 'itempin')
							return { ...zz, itemPins: zz.itemPins.map((it, i) => (i === idx ? { ...it, x: c.x, y: c.y } : it)) };
						return { ...zz, subPins: zz.subPins.map((sp, i) => (i === idx ? { ...sp, x: c.x, y: c.y } : sp)) };
					})
				);
			}
		};
		const onUp = () => {
			const d = drag.current;
			drag.current = null;
			setDragActive(false);
			if (!d) return;
			if (d.kind === 'rect') {
				setRectPreview(null);
				finishRect(d.start, d.end);
				return;
			}
			if (d.kind === 'marquee') {
				setMarquee(null);
				selectVertsInBox(d.start, d.end);
				return;
			}
			// A node press without movement is a CLICK: select the node (its own
			// highlight) and open its sublocation graph.
			if (d.kind === 'node' && !d.moved) {
				const z = zonesRef.current.find((zz) => zz.id === d.id);
				setSelectedNode((cur) => (cur === d.id ? null : d.id));
				setSubGraph((cur) => (cur === d.id ? null : z && z.location ? d.id : null));
				return;
			}
			// Selection was set on press; only persist if something actually moved.
			if (
				d.kind === 'vertex' ||
				d.kind === 'grip' ||
				(d.kind === 'zone-move' && d.moved) ||
				(d.kind === 'node' && d.moved) ||
				(d.kind === 'door' && d.moved) ||
				(d.kind === 'itempin' && d.moved) ||
				(d.kind === 'subpin' && d.moved)
			) {
				saveLater(zonesRef.current);
			}
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
		};
	}, [dragActive, localXY, toWorld, saveLater]);

	// --- Canvas pointer (draw / select / pan) --------------------------------
	const onCanvasPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button === 2) return; // right-click → contextmenu handler
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const w = toWorld(sx, sy);
		setMenu(null);

		// Rectangle tool: press-drag defines the rect.
		if (tool === 'rect') {
			if (e.button !== 0) return;
			drag.current = { kind: 'rect', start: w, end: w };
			setRectPreview({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
			setDragActive(true);
			return;
		}

		if (tool === 'draw') {
			if (e.button !== 0) return;
			// A zone closes when the click lands back on its first vertex.
			if (draft.length >= 3) {
				const first = screenOf(draft[0].x, draft[0].y);
				if (Math.hypot(first.x - sx, first.y - sy) <= CLOSE_SNAP) {
					finishDraft();
					return;
				}
			}
			// Don't stack a near-duplicate vertex right on top of the last one.
			if (draft.length > 0) {
				const lastV = screenOf(draft[draft.length - 1].x, draft[draft.length - 1].y);
				if (Math.hypot(lastV.x - sx, lastV.y - sy) < MIN_VERTEX_DIST) return;
			}
			setDraft((d) => [...d, { x: w.x, y: w.y }]);
			return;
		}

		// A road runs location → location: the first click picks the start
		// location, the drawn clicks are waypoints, and clicking a second location
		// finishes it.
		if (tool === 'road') {
			if (e.button !== 0) return;
			const hit = hitZone(sx, sy);
			const hitLoc = hit && hit.kind === 'zone' && hit.location ? hit.location : null;
			if (!roadDraft) {
				if (!hitLoc) {
					new Notice('Roads start on a location — click a location to begin.');
					return;
				}
				const sNode = locNode(hitLoc);
				setRoadDraft({ startLoc: hitLoc });
				setDraft(sNode ? [sNode] : []);
				return;
			}
			if (hitLoc && hitLoc !== roadDraft.startLoc) {
				const eNode = locNode(hitLoc);
				finishRoad(roadDraft.startLoc, hitLoc, eNode ? [...draft, eNode] : draft);
				return;
			}
			// Otherwise a waypoint (skip near-duplicates).
			if (draft.length > 0) {
				const lastV = screenOf(draft[draft.length - 1].x, draft[draft.length - 1].y);
				if (Math.hypot(lastV.x - sx, lastV.y - sy) < MIN_VERTEX_DIST) return;
			}
			setDraft((d) => [...d, { x: w.x, y: w.y }]);
			return;
		}

		// A zone: left-drag moves it, a plain click selects it for editing (vertex
		// handles). The context menu is right-click only. Locked zones only select.
		const hit = hitZone(sx, sy);
		if (hit) {
			// Pressing a zone selects it (deselecting any other) whether it becomes
			// a move-drag or a plain click.
			setSelectedZone(hit.id);
			if (e.button === 0 && !hit.locked && viewMode !== 'closeup') {
				beginPending();
				drag.current = {
					kind: 'zone-move',
					id: hit.id,
					startX: e.clientX,
					startY: e.clientY,
					moved: false,
					last: w,
				};
				setDragActive(true);
			} else if (e.button === 0 || e.button === 1) {
				// Locked zones and close-up mode aren't movable — a drag over them
				// pans the camera instead.
				drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: camera.tx, ty0: camera.ty };
				setDragActive(true);
			}
			return;
		}
		setSelectedZone(null);
		setSelectedNode(null);
		// Ctrl+drag on empty space draws a marquee to multi-select vertices;
		// otherwise a plain drag pans. A plain empty click clears any selection.
		if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
			drag.current = { kind: 'marquee', start: w, end: w };
			setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
			setDragActive(true);
			return;
		}
		if (selectedVerts.size > 0) setSelectedVerts(new Set());
		if (e.button === 0 || e.button === 1) {
			drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: camera.tx, ty0: camera.ty };
			setDragActive(true);
		}
	};

	const onCanvasPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const el = wrapRef.current;
		if (tool === 'draw' || tool === 'road') {
			el?.classList.remove('loom-map-edge-hover');
			setCursor(toWorld(sx, sy));
			return;
		}
		// Select mode: over a zone outline / road body, show the same pointer cursor
		// as vertex handles (that's where a double-click adds a vertex). Toggle a
		// class (not an inline style) to avoid a React re-render per mouse move.
		if (!el || drag.current) return;
		const w = toWorld(sx, sy);
		const k = cameraRef.current.k;
		let overEdge = false;
		for (let i = zonesRef.current.length - 1; i >= 0; i--) {
			const z = zonesRef.current[i];
			if (z.kind === 'road') {
				if (distToPolyline(w.x, w.y, z.points) <= z.width / 2 + 6 / k) {
					overEdge = true;
					break;
				}
			} else if (distToPolygon(w.x, w.y, z.points) * k <= 6) {
				overEdge = true;
				break;
			}
		}
		el.classList.toggle('loom-map-edge-hover', overEdge);
	};

	const onContextMenu = (e: ReactPointerEvent<SVGSVGElement>) => {
		e.preventDefault();
		// Right-click cancels an in-progress drawing (road or polygon) and exits
		// the draw tool back to select (so the drawing cursor clears too).
		if (tool === 'road' || tool === 'draw') {
			cancelDraft();
			setTool('select');
			return;
		}
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const w = toWorld(sx, sy);
		menuWorld.current = w;
		const hit = hitZone(sx, sy);
		if (hit) {
			setSelectedZone(hit.id);
			setMenu({ kind: 'zone', id: hit.id, wx: w.x, wy: w.y });
		} else {
			setSelectedZone(null);
			setMenu({ kind: 'empty', sx, sy });
		}
	};

	// Double-click a zone outline / road centerline to insert a vertex there.
	const onCanvasDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
		if (tool !== 'select') return;
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const hit = hitZone(sx, sy);
		if (!hit || hit.locked) return;
		const w = toWorld(sx, sy);
		const closed = hit.kind !== 'road';
		const k = cameraRef.current.k;
		const dist = closed ? distToPolygon(w.x, w.y, hit.points) : distToPolyline(w.x, w.y, hit.points);
		// Only near the outline/centerline — a double-click deep inside a big zone
		// shouldn't drop a stray vertex.
		const near = closed ? 14 / k : hit.width / 2 + 8 / k;
		if (dist > near) return;
		snapshot();
		updateZone(hit.id, { points: insertVertexAt(hit.points, w.x, w.y, closed) });
		setSelectedZone(hit.id);
	};

	/** Topmost zone under a screen point (inside or near its outline). */
	const hitZone = (sx: number, sy: number): MapZone | null => {
		const w = toWorld(sx, sy);
		const k = cameraRef.current.k;
		for (let i = zonesRef.current.length - 1; i >= 0; i--) {
			const z = zonesRef.current[i];
			if (z.kind === 'road') {
				const line = roadCenterline(z, squishRef.current);
				if (!line) continue;
				const d = distToPolyline(w.x, w.y, line);
				if (d <= z.width / 2 || d * k <= 6) return z;
				continue;
			}
			if (pointInPolygon(w.x, w.y, z.points) || distToPolygon(w.x, w.y, z.points) * k <= 6) {
				return z;
			}
		}
		return null;
	};

	const finishDraft = () => {
		if (draft.length < 3) return;
		const zone: MapZone = {
			id: newId(),
			kind: 'zone',
			points: draft.map((p) => ({ ...p })),
			width: DEFAULT_ROAD_WIDTH,
			color: plugin.settings.mapsColor,
			alpha: DEFAULT_ALPHA,
			location: null,
			node: null,
			nodeSize: 'regular',
			doors: [],
			itemPins: [],
			subPins: [],
			locked: false,
		};
		snapshot();
		commit([...zonesRef.current, zone]);
		setDraft([]);
		setCursor(null);
		setTool('select');
		// Open the new zone's menu right away so its location can be set.
		const ctr = centroid(zone.points);
		menuWorld.current = ctr;
		setSelectedZone(zone.id);
		setMenu({ kind: 'zone', id: zone.id, wx: ctr.x, wy: ctr.y });
	};
	/** Creates a road connecting two locations, with the drawn waypoints between. */
	const finishRoad = (startLoc: string, endLoc: string, waypoints: { x: number; y: number }[]) => {
		const road: MapZone = {
			id: newId(),
			kind: 'road',
			points: waypoints.map((p) => ({ ...p })),
			startLoc,
			endLoc,
			width: DEFAULT_ROAD_WIDTH,
			color: plugin.settings.mapsColor,
			alpha: DEFAULT_ALPHA,
			location: null,
			node: null,
			nodeSize: 'regular',
			doors: [],
			itemPins: [],
			subPins: [],
			locked: false,
		};
		snapshot();
		commit([...zonesRef.current, road]);
		setRoadDraft(null);
		setDraft([]);
		setCursor(null);
		setTool('select');
		setSelectedZone(road.id);
	};
	const cancelDraft = () => {
		setRoadDraft(null);
		setDraft([]);
		setCursor(null);
	};
	/** Creates an axis-aligned rectangle zone from two opposite corners. */
	const finishRect = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		setTool('select');
		const x0 = Math.min(a.x, b.x);
		const y0 = Math.min(a.y, b.y);
		const x1 = Math.max(a.x, b.x);
		const y1 = Math.max(a.y, b.y);
		const k = cameraRef.current.k;
		// Ignore a tiny drag (effectively a click).
		if ((x1 - x0) * k < 6 || (y1 - y0) * k < 6) return;
		const zone: MapZone = {
			id: newId(),
			kind: 'zone',
			points: [
				{ x: x0, y: y0 },
				{ x: x1, y: y0 },
				{ x: x1, y: y1 },
				{ x: x0, y: y1 },
			],
			width: DEFAULT_ROAD_WIDTH,
			color: plugin.settings.mapsColor,
			alpha: DEFAULT_ALPHA,
			location: null,
			node: null,
			nodeSize: 'regular',
			doors: [],
			itemPins: [],
			subPins: [],
			locked: false,
		};
		snapshot();
		commit([...zonesRef.current, zone]);
		const ctr = centroid(zone.points);
		menuWorld.current = ctr;
		setSelectedZone(zone.id);
		setMenu({ kind: 'zone', id: zone.id, wx: ctr.x, wy: ctr.y });
	};
	/** Selects every (unlocked) zone vertex inside the marquee box. */
	const selectVertsInBox = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		const x0 = Math.min(a.x, b.x);
		const y0 = Math.min(a.y, b.y);
		const x1 = Math.max(a.x, b.x);
		const y1 = Math.max(a.y, b.y);
		const sel = new Set<string>();
		for (const z of zonesRef.current) {
			if (z.locked) continue;
			z.points.forEach((p, i) => {
				if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) sel.add(`${z.id}:${i}`);
			});
		}
		setSelectedVerts(sel);
		const zoneIds = new Set([...sel].map((key) => key.split(':')[0]));
		if (zoneIds.size === 1) setSelectedZone([...zoneIds][0]);
	};

	// --- Roads connect two locations -----------------------------------------
	/** The polygon zone on this map associated with a location link target. */
	const zoneForLoc = (locLp: string | null | undefined): MapZone | null =>
		locLp ? zonesRef.current.find((z) => z.kind === 'zone' && z.location === locLp) ?? null : null;
	const locNode = (locLp: string | null | undefined): { x: number; y: number } | null => {
		const z = zoneForLoc(locLp);
		return z ? z.node ?? centroid(z.points) : null;
	};
	/** The top (main) location's node — a sublocation collapses into its main
	 *  location in node view, so roads anchor there. Falls back to the location's
	 *  own node when its main isn't placed on this map. */
	const mainLocNode = (locLp: string | null | undefined): { x: number; y: number } | null => {
		if (!locLp || !project) return locNode(locLp);
		let loc = plugin.indexer.resolve(locLp, project.loomPath);
		for (let g = 0; g < 20 && loc?.parentLocation; g++) {
			const p = plugin.indexer.resolve(loc.parentLocation, loc.path);
			if (!p) break;
			loc = p;
		}
		return (loc ? locNode(linkTargetOf(loc)) : null) ?? locNode(locLp);
	};
	/** The road as rendered for a squish level. A road is its own editable zone —
	 *  `points` is the full centerline. Its two ends only drive the VISUAL: in
	 *  regular view the first/last segment is clipped to the start/end zone edge
	 *  (so the road doesn't overlap the zone); in node view the ends anchor to the
	 *  main-location nodes. Null when the road has fewer than 2 points. */
	const roadCenterline = (road: MapZone, squishAmt: number): { x: number; y: number }[] | null => {
		const pts = road.points;
		if (pts.length < 2) return null;
		const last = pts.length - 1;
		const sZone = zoneForLoc(road.startLoc);
		const eZone = zoneForLoc(road.endLoc);
		const sReg = sZone ? boundaryExit(pts[0], pts[1], sZone.points) : pts[0];
		const eReg = eZone ? boundaryExit(pts[last], pts[last - 1], eZone.points) : pts[last];
		const sMain = mainLocNode(road.startLoc) ?? pts[0];
		const eMain = mainLocNode(road.endLoc) ?? pts[last];
		const lerp = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
			x: a.x + (b.x - a.x) * squishAmt,
			y: a.y + (b.y - a.y) * squishAmt,
		});
		return [lerp(sReg, sMain), ...pts.slice(1, -1).map((p) => ({ ...p })), lerp(eReg, eMain)];
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// Ignore keys while typing in a field (search box, inputs, etc.).
			const t = e.target as HTMLElement | null;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			// Undo / redo (map-local).
			if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
				e.preventDefault();
				if (e.shiftKey) redo();
				else undo();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
				e.preventDefault();
				redo();
				return;
			}
			if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZone && draft.length === 0 && !roadDraft) {
				deleteZone(selectedZone);
				return;
			}
			if (e.key !== 'Escape') return;
			if (roadDraft || draft.length > 0) cancelDraft();
			else if (subGraph) setSubGraph(null);
			else if (menu) setMenu(null);
			else if (selectedVertsRef.current.size > 0) setSelectedVerts(new Set());
			else if (selectedNode) setSelectedNode(null);
			else if (selectedZone) setSelectedZone(null);
			else if (tool !== 'select') setTool('select');
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [draft.length, menu, selectedZone, selectedNode, subGraph, tool, roadDraft]);

	// --- Zone / node actions -------------------------------------------------
	const deleteZone = (id: string) => {
		snapshot();
		commit(zonesRef.current.filter((z) => z.id !== id));
		setMenu(null);
		setSelectedZone(null);
	};
	/** Sets/changes a zone's location, keeping an existing node or dropping a new
	 *  one at the menu-open point. */
	const pickLocation = (zone: MapZone, target: string) => {
		// A newly associated location's node lands at the shape's balance center
		// (the middle of a road); an existing node stays put.
		const raw = zone.node ?? zoneCenter(zone);
		updateZone(zone.id, { location: target, node: clampToZone(raw, zone) });
	};
	const locationOptions = useMemo(
		() =>
			plugin.indexer
				.getAll('location', project?.root)
				// Zones associate a MAIN location only — sublocations live inside their
				// parent's zone as nodes, never as their own zone.
				.filter((r) => r.parentLocation === null)
				.map((r) => ({ value: linkTargetOf(r), label: recordLabel(r, project) }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[plugin, project]
	);
	// Locations already placed on this map — the location picker won't re-offer
	// them (a location gets one zone per map).
	const usedLocations = useMemo(
		() => new Set(zones.filter((z) => z.location).map((z) => z.location as string)),
		[zones]
	);
	// Region wraps (node view only): each region's placed locations' ZONES are
	// clustered by proximity, and each cluster gets its own padded convex hull
	// around the actual zone areas (not the collapsed nodes) — so a region wraps
	// the land its locations occupy, and far-apart members wrap separately.
	const regionClusters = useMemo(() => {
		if (!project) return [] as { region: EntityRecord; vertices: Pt[] }[];
		const byRegion = new Map<string, { region: EntityRecord; zones: MapZone[] }>();
		const allNodePts: Pt[] = [];
		for (const z of zones) {
			if (!z.location) continue;
			const loc = plugin.indexer.resolve(z.location, project.loomPath);
			if (loc?.type !== 'location') continue;
			allNodePts.push(z.node ?? centroid(z.points));
			if (!loc.region) continue;
			const region = plugin.indexer.resolve(loc.region, loc.path);
			if (region?.type !== 'region') continue;
			if (!byRegion.has(region.path)) byRegion.set(region.path, { region, zones: [] });
			byRegion.get(region.path)?.zones.push(z);
		}
		const spacing = medianNearestNeighbor(allNodePts);
		// Zones within ~2.5x the typical node spacing share a wrap; beyond it they
		// form a separate cluster (the "far lands" case).
		const threshold = spacing > 0 ? spacing * 2.5 : Infinity;
		const out: { region: EntityRecord; vertices: Pt[] }[] = [];
		for (const { region, zones: rzones } of byRegion.values()) {
			// Cluster the region's zones by their node positions (union-find).
			const nodes = rzones.map((z) => z.node ?? centroid(z.points));
			const parent = nodes.map((_, i) => i);
			const find = (i: number): number => {
				while (parent[i] !== i) {
					parent[i] = parent[parent[i]];
					i = parent[i];
				}
				return i;
			};
			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) <= threshold) {
						parent[find(i)] = find(j);
					}
				}
			}
			const groups = new Map<number, MapZone[]>();
			rzones.forEach((z, i) => {
				const r = find(i);
				if (!groups.has(r)) groups.set(r, []);
				groups.get(r)?.push(z);
			});
			// The hull wraps every vertex of the cluster's zones (their real areas).
			for (const clusterZones of groups.values()) {
				out.push({ region, vertices: clusterZones.flatMap((z) => z.points) });
			}
		}
		return out;
	}, [zones, project, plugin, indexVersion]);
	const openLocation = (target: string | null, newTab = false) => {
		if (!target) return;
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		if (rec) view.openEntity(rec.path, newTab);
	};
	// --- Doors (portal links from a zone to another map page) ----------------
	const mapPageOptions = useMemo(
		() =>
			pages
				.filter((p) => p.id !== activeId)
				.map((p) => ({ value: p.id, label: p.name || 'Untitled map' }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[pages, activeId]
	);
	const pageName = (id: string): string => pages.find((p) => p.id === id)?.name || 'Untitled map';
	const addDoor = (zone: MapZone, pageId: string) => {
		snapshot();
		// Offset each new door a little so several don't fully overlap.
		const base = zoneCenter(zone);
		const off = (18 * zone.doors.length) / cameraRef.current.k;
		const pos = clampToZone({ x: base.x + off, y: base.y + off }, zone);
		updateZone(zone.id, { doors: [...zone.doors, { page: pageId, x: pos.x, y: pos.y }] });
	};
	/** Toggle a door to a page: add one at an offset if absent, remove it if present. */
	const toggleDoor = (zone: MapZone, pageId: string) => {
		if (zone.doors.some((d) => d.page === pageId)) {
			snapshot();
			updateZone(zone.id, { doors: zone.doors.filter((d) => d.page !== pageId) });
			return;
		}
		addDoor(zone, pageId);
	};
	/** Places a door at a precise point in the zone (drag-and-drop drop). */
	const placeDoorPin = (zone: MapZone, pageId: string, pos: { x: number; y: number }) => {
		snapshot();
		const clamped = clampToZone(pos, zone);
		updateZone(zone.id, { doors: [...zone.doors, { page: pageId, x: clamped.x, y: clamped.y }] });
	};
	// --- Item pins (item markers dropped inside a zone) ----------------------
	const itemOptions = useMemo(
		() =>
			plugin.indexer
				.getAll('item', project?.root)
				.filter((r) => r.itemOrigin === null)
				.map((r) => ({ value: linkTargetOf(r), label: r.name }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[plugin, project, indexVersion]
	);
	const itemName = (target: string): string => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		return rec ? rec.name : target;
	};
	const addItemPin = (zone: MapZone, itemTarget: string) => {
		snapshot();
		const base = zoneCenter(zone);
		const off = (18 * zone.itemPins.length) / cameraRef.current.k;
		const pos = clampToZone({ x: base.x + off, y: base.y + off }, zone);
		updateZone(zone.id, { itemPins: [...zone.itemPins, { item: itemTarget, x: pos.x, y: pos.y }] });
	};
	const removeItemPin = (zone: MapZone, index: number) => {
		snapshot();
		updateZone(zone.id, { itemPins: zone.itemPins.filter((_, i) => i !== index) });
	};
	/** Toggle an item's pin: add at an offset if absent, remove if present. */
	const toggleItemPin = (zone: MapZone, itemTarget: string) => {
		const idx = zone.itemPins.findIndex((p) => p.item === itemTarget);
		if (idx >= 0) {
			removeItemPin(zone, idx);
			return;
		}
		addItemPin(zone, itemTarget);
	};
	/** Places (or repositions) an item pin at a precise point in the zone. */
	const placeItemPin = (zone: MapZone, itemTarget: string, pos: { x: number; y: number }) => {
		snapshot();
		const clamped = clampToZone(pos, zone);
		const idx = zone.itemPins.findIndex((p) => p.item === itemTarget);
		if (idx >= 0) {
			updateZone(zone.id, {
				itemPins: zone.itemPins.map((p, i) => (i === idx ? { ...p, x: clamped.x, y: clamped.y } : p)),
			});
		} else {
			updateZone(zone.id, { itemPins: [...zone.itemPins, { item: itemTarget, x: clamped.x, y: clamped.y }] });
		}
	};
	/** Item pin px radius — scales with the zone's node size (like a first-level
	 *  sublocation), so changing the node size resizes item pins too. */
	const itemPinRadius = (zone: MapZone): number =>
		Math.max(MIN_SUB_NODE_SIZE, NODE_SIZE_PRESETS[zone.nodeSize] * SUB_NODE_SCALE);
	const openItem = (target: string) => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		if (rec) view.openEntity(rec.path);
	};
	// --- Sublocation nodes (a zone's location's sublocations, shown inside) ----
	const sublocationsOf = (zone: MapZone): EntityRecord[] => {
		if (!zone.location || !project) return [];
		const loc = plugin.indexer.resolve(zone.location, project.loomPath);
		if (loc?.type !== 'location') return [];
		// All DESCENDANTS (sublocations, and their sublocations, …).
		const isDescendant = (l: EntityRecord): boolean => {
			let cur: EntityRecord | null = l;
			for (let g = 0; g < 25 && cur?.parentLocation; g++) {
				const parent = plugin.indexer.resolve(cur.parentLocation, cur.path);
				if (!parent) return false;
				if (parent.path === loc.path) return true;
				cur = parent;
			}
			return false;
		};
		return plugin.indexer
			.getAll('location', project.root)
			.filter(isDescendant)
			.sort((a, b) => recordLabel(a, project).localeCompare(recordLabel(b, project)));
	};
	const toggleSubPin = (zone: MapZone, locTarget: string) => {
		snapshot();
		if (zone.subPins.some((sp) => sp.loc === locTarget)) {
			updateZone(zone.id, { subPins: zone.subPins.filter((sp) => sp.loc !== locTarget) });
			return;
		}
		const base = zoneCenter(zone);
		const off = (18 * zone.subPins.length) / cameraRef.current.k;
		const pos = clampToZone({ x: base.x + off, y: base.y + off }, zone);
		updateZone(zone.id, { subPins: [...zone.subPins, { loc: locTarget, x: pos.x, y: pos.y }] });
	};
	/** Places (or repositions) a sublocation node at a precise point in the zone. */
	const placeSubPin = (zone: MapZone, loc: string, pos: { x: number; y: number }) => {
		snapshot();
		const clamped = clampToZone(pos, zone);
		const idx = zone.subPins.findIndex((sp) => sp.loc === loc);
		if (idx >= 0) {
			updateZone(zone.id, {
				subPins: zone.subPins.map((sp, i) => (i === idx ? { ...sp, x: clamped.x, y: clamped.y } : sp)),
			});
		} else {
			updateZone(zone.id, { subPins: [...zone.subPins, { loc, x: clamped.x, y: clamped.y }] });
		}
	};
	const openSubloc = (target: string) => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		if (rec) view.openEntity(rec.path);
	};
	/** A sublocation node's px radius: smaller each nesting level below the zone's
	 *  location, floored at `MIN_SUB_NODE_SIZE`. */
	const subPinRadius = (zone: MapZone, locTarget: string): number => {
		const base = NODE_SIZE_PRESETS[zone.nodeSize];
		if (!project) return Math.max(MIN_SUB_NODE_SIZE, base * SUB_NODE_SCALE);
		const zoneLoc = zone.location ? plugin.indexer.resolve(zone.location, project.loomPath) : null;
		let cur = plugin.indexer.resolve(locTarget, project.loomPath);
		let depth = 1;
		for (let g = 0; g < 25; g++) {
			const parent = cur?.parentLocation ? plugin.indexer.resolve(cur.parentLocation, cur.path) : null;
			if (!parent || parent.path === zoneLoc?.path) break;
			depth++;
			cur = parent;
		}
		return Math.max(MIN_SUB_NODE_SIZE, base * Math.pow(SUB_NODE_SCALE, depth));
	};
	const sublocName = (target: string): string => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		return rec ? rec.name : target;
	};
	const locationName = (target: string | null): string => {
		if (!target) return '';
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		return rec ? recordLabel(rec, project) : target;
	};
	/** Centers the camera on a world point (keeps the current zoom). */
	const panTo = (wx: number, wy: number) => {
		const el = wrapRef.current;
		const w = el?.clientWidth ?? 900;
		const h = el?.clientHeight ?? 600;
		setCamera((c) => ({ ...c, tx: w / 2 - wx * c.k, ty: h / 2 - wy * c.k }));
	};
	/** Eases the camera zoom to a target level around the viewport center — used
	 *  by the scale slider (which manipulates the zoom, driving the view mode). */
	const animateCameraK = (targetK: number) => {
		const el = wrapRef.current;
		const w = el?.clientWidth ?? 900;
		const h = el?.clientHeight ?? 600;
		const from = cameraRef.current;
		const wx = (w / 2 - from.tx) / from.k;
		const wy = (h / 2 - from.ty) / from.k;
		const start = performance.now();
		window.cancelAnimationFrame(camRaf.current);
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / 260);
			const e = 1 - (1 - t) * (1 - t);
			const k = from.k + (targetK - from.k) * e;
			setCamera({ k, tx: w / 2 - wx * k, ty: h / 2 - wy * k });
			if (t < 1) camRaf.current = window.requestAnimationFrame(step);
		};
		camRaf.current = window.requestAnimationFrame(step);
	};

	if (!project) {
		return (
			<ViewShell view={view} project={null} title={MAPS_LABEL}>
				{noProjectMessage()}
			</ViewShell>
		);
	}

	const menuZone = menu?.kind === 'zone' ? zones.find((z) => z.id === menu.id) ?? null : null;
	// Screen anchor for the open menu: zone menus track a world point (so they
	// follow the zone when moved), the empty menu is a fixed screen point.
	const menuPos =
		menu?.kind === 'zone'
			? screenOf(menu.wx, menu.wy)
			: menu?.kind === 'empty'
				? { x: menu.sx, y: menu.sy }
				: null;
	const squish = squishRef.current;

	// Vertex handles for a zone/road (when selected or marquee-hit). Rendered in a
	// SEPARATE layer above all zone/road bodies, so a road drawn over a location
	// zone never covers (and blocks clicks on) that zone's handles.
	const renderHandles = (z: MapZone): ReactElement | null => {
		const zoneSel = selectedZone === z.id;
		const hasSelVerts = [...selectedVerts].some((key) => key.startsWith(z.id + ':'));
		if (!(zoneSel || hasSelVerts) || z.locked || squish >= 0.02) return null;
		return (
			<g key={`handles-${z.id}`}>
				{z.points.map((p, i) => {
					const vkey = `${z.id}:${i}`;
					const vSel = selectedVerts.has(vkey);
					return (
						<circle
							key={i}
							cx={p.x}
							cy={p.y}
							r={(vSel ? VERTEX_R + 1.5 : VERTEX_R) / camera.k}
							className={vSel ? 'loom-map-vertex loom-map-vertex-sel' : 'loom-map-vertex'}
							onPointerDown={(e) => {
								if (tool !== 'select') return;
								e.stopPropagation();
								if (e.button !== 0) return;
								beginPending();
								const orig = { x: p.x, y: p.y };
								// If this vertex is part of a multi-selection, move the whole
								// group; otherwise drag it alone (and drop the selection).
								const cur = selectedVertsRef.current;
								let group: { id: string; index: number; x: number; y: number }[] | undefined;
								if (cur.has(vkey) && cur.size > 1) {
									group = [...cur].map((key) => {
										const [zid, si] = [
											key.slice(0, key.lastIndexOf(':')),
											Number(key.slice(key.lastIndexOf(':') + 1)),
										];
										const zz = zonesRef.current.find((q) => q.id === zid);
										const pt = zz?.points[si] ?? orig;
										return { id: zid, index: si, x: pt.x, y: pt.y };
									});
								} else if (cur.size > 0) {
									setSelectedVerts(new Set());
								}
								drag.current = { kind: 'vertex', id: z.id, index: i, orig, group, last: orig };
								setDragActive(true);
							}}
							onContextMenu={(e) => {
								// Right-click a vertex deletes it (roads keep ≥2 points — their
								// two ends; polygons keep ≥3).
								e.preventDefault();
								e.stopPropagation();
								const min = z.kind === 'road' ? 2 : 3;
								if (z.points.length <= min) return;
								snapshot();
								updateZone(z.id, { points: z.points.filter((_, idx) => idx !== i) });
							}}
						/>
					);
				})}
			</g>
		);
	};

	return (
		<ViewShell view={view} project={project} title={MAPS_LABEL} railActive="map">
			<div className={tool !== 'select' ? 'loom-map-wrap loom-map-drawing' : 'loom-map-wrap'} ref={wrapRef}>
				<MapsPanel
					plugin={plugin}
					pages={pages}
					activeId={activeId}
					onSwitch={switchMap}
					onCreate={createMap}
					onRename={renameMap}
					onDelete={deleteMap}
					onNest={nestMap}
				/>
				<svg
					className="loom-map-svg"
					onPointerDown={onCanvasPointerDown}
					onPointerMove={onCanvasPointerMove}
					onContextMenu={onContextMenu}
					onDoubleClick={onCanvasDoubleClick}
					onDragOver={(e) => {
						if (!pinDrag) return;
						e.preventDefault();
						const zone = zonesRef.current.find((z) => z.id === pinDrag.zoneId);
						if (!zone) return;
						const { sx, sy } = localXY(e.clientX, e.clientY);
						setPinDragPos(clampToZone(toWorld(sx, sy), zone));
					}}
					onDrop={(e) => {
						if (!pinDrag) return;
						e.preventDefault();
						const zone = zonesRef.current.find((z) => z.id === pinDrag.zoneId);
						const { sx, sy } = localXY(e.clientX, e.clientY);
						if (zone) {
							if (pinDrag.kind === 'sub') placeSubPin(zone, pinDrag.target, toWorld(sx, sy));
							else if (pinDrag.kind === 'door') placeDoorPin(zone, pinDrag.target, toWorld(sx, sy));
							else placeItemPin(zone, pinDrag.target, toWorld(sx, sy));
						}
						setPinDrag(null);
						setPinDragPos(null);
					}}
					onDragEnd={() => {
						setPinDrag(null);
						setPinDragPos(null);
					}}
				>
					<g
						transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}
						style={subGraph ? { opacity: 0.12 } : undefined}
					>
						{/* Zones layer — in node view each polygon zone squishes (warps)
						    into its node and disappears, leaving just the nodes; a road
						    instead thins into a line so it still shows what it connects. */}
						{zones.map((z) => {
									const isRoad = z.kind === 'road';
									// Polygon zones fully collapse in node view; roads stay as a line.
									if (!isRoad && squish >= 0.995) return null;
									// A road is rendered along its location→location centerline
									// (clipped to the zone edges in regular view, anchored to the
									// main-location nodes in node view); its `points` are only the
									// editable waypoints. Skip when an endpoint isn't on this map.
									const roadLine = isRoad ? roadCenterline(z, squish) : null;
									if (isRoad && (!roadLine || roadLine.length < 2)) return null;
									const stroke = darker(z.color);
									const linePts = isRoad ? (roadLine as Pt[]) : z.points;
									const line = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
									const d = isRoad ? line : line + ' Z';
									const zoneSel = selectedZone === z.id;

									if (isRoad) {
										// A road: an open, width-rendered centerline (a long box that
										// bends) — outline stroke behind, fill stroke on top. In node
										// view it thins toward a constant-screen line (and goes opaque)
										// so it still reads as a connector between the collapsed nodes.
										const rw = z.width * (1 - squish) + (3 / camera.k) * squish;
										const rop = z.alpha + (1 - z.alpha) * squish;
										return (
											<g key={z.id}>
												<path
													d={d}
													fill="none"
													stroke={stroke}
													strokeOpacity={rop}
													// The outline border is a constant screen size in regular
													// view; fade it toward node view so it doesn't dwarf the
													// thinned road line there.
													strokeWidth={rw + ((zoneSel ? 5 : 3) * (1 - 0.85 * squish)) / camera.k}
													strokeLinejoin="round"
													strokeLinecap="round"
												/>
												<path
													d={d}
													fill="none"
													stroke={z.color}
													strokeOpacity={rop}
													strokeWidth={rw}
													strokeLinejoin="round"
													strokeLinecap="round"
												/>
											</g>
										);
									}
									// Collapse the polygon toward its node (or centroid) as node
									// view turns on.
									const t = z.node ?? centroid(z.points);
									const s = 1 - squish;
									const squishTransform =
										squish > 0.001
											? `translate(${t.x},${t.y}) scale(${s}) translate(${-t.x},${-t.y})`
											: undefined;
									return (
										<g key={z.id} transform={squishTransform} opacity={squish > 0.001 ? s : undefined}>
											<path
												d={d}
												fill={z.color}
												fillOpacity={z.alpha}
												stroke={stroke}
												strokeWidth={(zoneSel ? 2.5 : 1.5) / camera.k}
											/>
										</g>
									);
								})}
							{/* Vertex handles on their own layer, above every zone/road body —
							    so a road drawn over a location zone can't cover (or block
							    clicks on) that zone's handles. */}
							{zones.map((z) => renderHandles(z))}
						{/* Road preview: from the start location through the waypoints to
						    the cursor (a thick line at the road width). */}
						{tool === 'road' && roadDraft
							? (() => {
									const pts = [...draft, cursor].filter(Boolean) as Pt[];
									if (pts.length < 1) return null;
									const dp = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
									return (
										<g className="loom-map-draft">
											<path
												d={dp}
												fill="none"
												stroke={plugin.settings.mapsColor}
												strokeOpacity={DEFAULT_ALPHA + 0.2}
												strokeWidth={DEFAULT_ROAD_WIDTH}
												strokeLinejoin="round"
												strokeLinecap="round"
											/>
											<path
												d={dp}
												fill="none"
												stroke={darker(plugin.settings.mapsColor)}
												strokeWidth={1.5 / camera.k}
												strokeDasharray={`${6 / camera.k} ${4 / camera.k}`}
											/>
											{draft.map((p, i) => (
												<circle key={i} cx={p.x} cy={p.y} r={VERTEX_R / camera.k} className="loom-map-vertex" />
											))}
										</g>
									);
								})()
							: null}
						{/* Zone (polygon) draw preview. The dashed outline is drawn OPEN (no
						    closing edge from the last vertex back to the first) so the
						    still-incomplete edge stands out; the fill previews the area. */}
						{tool === 'draw' && draft.length > 0 ? (
							<g className="loom-map-draft">
								{draft.length >= 2 ? (
									// Filled area follows the cursor in real time (closes through
									// it), so the shape-so-far is always visible…
									<path
										d={
											draft.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') +
											(cursor ? ` L${cursor.x},${cursor.y}` : '') +
											' Z'
										}
										fill={plugin.settings.mapsColor}
										fillOpacity={DEFAULT_ALPHA * 0.6}
										stroke="none"
									/>
								) : null}
								{/* …but the dashed outline stays OPEN (no closing edge back to the
								    first vertex) so the incomplete edge stands out. */}
								<path
									d={
										draft.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') +
										(cursor ? ` L${cursor.x},${cursor.y}` : '')
									}
									fill="none"
									stroke={darker(plugin.settings.mapsColor)}
									strokeWidth={1.5 / camera.k}
									strokeDasharray={`${6 / camera.k} ${4 / camera.k}`}
								/>
								{draft.map((p, i) => (
									<circle
										key={i}
										cx={p.x}
										cy={p.y}
										r={(i === 0 ? VERTEX_R + 1 : VERTEX_R) / camera.k}
										className={i === 0 ? 'loom-map-vertex loom-map-vertex-first' : 'loom-map-vertex'}
									/>
								))}
							</g>
						) : null}
						{/* Rectangle-tool preview. */}
						{rectPreview ? (
							<rect
								x={Math.min(rectPreview.x0, rectPreview.x1)}
								y={Math.min(rectPreview.y0, rectPreview.y1)}
								width={Math.abs(rectPreview.x1 - rectPreview.x0)}
								height={Math.abs(rectPreview.y1 - rectPreview.y0)}
								fill={plugin.settings.mapsColor}
								fillOpacity={DEFAULT_ALPHA * 0.6}
								stroke={darker(plugin.settings.mapsColor)}
								strokeWidth={1.5 / camera.k}
								strokeDasharray={`${6 / camera.k} ${4 / camera.k}`}
							/>
						) : null}
						{/* Marquee (vertex multi-select) box. */}
						{marquee ? (
							<rect
								className="loom-map-marquee"
								x={Math.min(marquee.x0, marquee.x1)}
								y={Math.min(marquee.y0, marquee.y1)}
								width={Math.abs(marquee.x1 - marquee.x0)}
								height={Math.abs(marquee.y1 - marquee.y0)}
								strokeWidth={1 / camera.k}
								strokeDasharray={`${4 / camera.k} ${3 / camera.k}`}
							/>
						) : null}
						{/* Region wraps — node view only: a padded convex hull around each
						    cluster of a region's location nodes (far-apart members wrap
						    separately). Behind the nodes; fades in with the squish. */}
						{squish > 0.02
							? regionClusters.map(({ region, vertices }, i) => {
									// A modest constant-screen margin around the zone areas.
									const pad = 40 / camera.k;
									const hull = regionHull(vertices, pad);
									if (hull.length < 3) return null;
									const d = hull.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
									const c = centroid(vertices);
									const minY = Math.min(...hull.map((p) => p.y));
									const fill = plugin.settings.nodeColors.region;
									return (
										<g
											key={`region-${region.path}-${i}`}
											className="loom-map-region"
											opacity={squish}
											onDoubleClick={(e) => {
												e.stopPropagation();
												view.openEntity(region.path);
											}}
										>
											<path
												d={d}
												fill={fill}
												fillOpacity={0.14}
												stroke={darker(fill)}
												strokeWidth={2 / camera.k}
												strokeLinejoin="round"
											/>
											<text
												x={c.x}
												y={minY - 12 / camera.k}
												textAnchor="middle"
												className="loom-map-region-label"
												style={{ fontSize: `${17 / camera.k}px`, fill: darker(fill) }}
											>
												{region.name}
											</text>
										</g>
									);
								})
							: null}
						{/* Nodes layer — always on top of every zone, screen-space sized
						    (constant apparent size when zooming). Right-click falls
						    through to the zone menu; left-drag moves the node (or, in
						    node view, the whole zone). Unassociated zones show a light-
						    grey placeholder node in node view. */}
						{zones.map((z) => {
							const placeholder = !z.node;
							// A road only shows a node if it carries its own location — no
							// grey placeholder for roads.
							if (z.kind === 'road' && placeholder) return null;
							// Placeholder (locationless) nodes only exist in node view — they
							// grow in (curved scale, like the graph time-lapse), never fade.
							if (placeholder && squish < 0.01) return null;
							const node = z.node ?? centroid(z.points);
							const stroke = darker(z.color);
							const grow = placeholder ? 1 - Math.pow(1 - squish, 3) : 1;
							const r = (NODE_SIZE_PRESETS[z.nodeSize] / camera.k) * grow;
							const opacity = !placeholder && viewMode === 'closeup' ? CLOSEUP_NODE_OPACITY : 1;
							return (
								<g
									key={`node-${z.id}`}
									className="loom-map-node"
									style={opacity < 1 ? { opacity } : undefined}
									onPointerDown={(e) => {
										// While a drawing tool is active (e.g. picking road
										// endpoints), let the click fall through to the canvas
										// instead of selecting the node/zone.
										if (tool !== 'select') return;
										// Middle-click opens the location page in a new tab (handled
										// in onAuxClick) — don't let it start a canvas pan.
										if (e.button === 1) {
											e.stopPropagation();
											return;
										}
										if (e.button !== 0) return; // right-click → zone menu (canvas contextmenu)
										e.stopPropagation();
										// A node press is either a DRAG (move the node) or, with no
										// movement, a CLICK — handled in onUp (select node + open its
										// sublocation graph). It does NOT select the zone.
										beginPending();
										const { sx, sy } = localXY(e.clientX, e.clientY);
										drag.current = {
											kind: 'node',
											id: z.id,
											startX: e.clientX,
											startY: e.clientY,
											moved: false,
											last: toWorld(sx, sy),
										};
										setDragActive(true);
									}}
									onDoubleClick={(e) => {
										// Double-click opens the associated location's page.
										e.stopPropagation();
										openLocation(z.location);
									}}
									onAuxClick={(e) => {
										// Middle-click opens the location page in a new tab.
										if (e.button === 1 && z.location) {
											e.preventDefault();
											e.stopPropagation();
											openLocation(z.location, true);
										}
									}}
								>
									<circle
										cx={node.x}
										cy={node.y}
										r={r}
										fill={placeholder ? '#bdbdbd' : stroke}
										className={
											selectedNode === z.id ? 'loom-map-node-dot loom-map-node-sel' : 'loom-map-node-dot'
										}
									/>
									{z.location ? (
										// Sparkle mark inside a main (location) node, so main nodes
										// stand out even without a selection highlight.
										<g
											className="loom-map-node-star"
											transform={`translate(${node.x},${node.y}) scale(${r / 13}) translate(-12,-12)`}
										>
											<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
										</g>
									) : null}
									{z.location ? (
										<text
											x={node.x}
											y={node.y + (NODE_SIZE_PRESETS[z.nodeSize] + 14) / camera.k}
											textAnchor="middle"
											className="loom-map-node-label"
											style={{ fontSize: `${13 / camera.k}px` }}
										>
											{clampLabel(locationName(z.location))}
										</text>
									) : null}
								</g>
							);
						})}
						{/* Doors layer — portal links to other map pages; double-click
						    opens the target page, drag repositions within the zone. Doors
						    squish into the zone's node and vanish in node view. */}
						{squish >= 0.995
							? null
							: zones.flatMap((z) => {
								const dt = z.node ?? centroid(z.points);
								const ds = 1 - squish;
								const doorSquish =
									squish > 0.001
										? `translate(${dt.x},${dt.y}) scale(${ds}) translate(${-dt.x},${-dt.y})`
										: undefined;
								const doorR = itemPinRadius(z);
								return z.doors.map((dr, i) => (
								<g
									key={`door-${z.id}-${i}`}
									className="loom-map-door"
									transform={doorSquish}
									opacity={squish > 0.001 ? ds : undefined}
									onPointerDown={(e) => {
										if (tool !== 'select') return;
										if (e.button !== 0) return;
										e.stopPropagation();
										setSelectedZone(z.id);
										beginPending();
										drag.current = {
											kind: 'door',
											id: z.id,
											index: i,
											startX: e.clientX,
											startY: e.clientY,
											moved: false,
										};
										setDragActive(true);
									}}
									onDoubleClick={(e) => {
										e.stopPropagation();
										switchMap(dr.page);
									}}
								>
									<circle cx={dr.x} cy={dr.y} r={doorR / camera.k} className="loom-map-door-dot" />
									{/* Lucide door-open icon, scaled to a constant screen size and
									    centered on the door (24-unit icon → ~17px). */}
									<g
										className="loom-map-door-glyph"
										transform={`translate(${dr.x},${dr.y}) scale(${(doorR * 1.25) / camera.k / 24}) translate(-12,-12)`}
										fill="none"
										strokeWidth={2}
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M13 4h3a2 2 0 0 1 2 2v14" />
										<path d="M2 20h3" />
										<path d="M13 20h9" />
										<path d="M10 12v.01" />
										<path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.562Z" />
									</g>
									<text
										x={dr.x}
										y={dr.y + (doorR + 12) / camera.k}
										textAnchor="middle"
										className="loom-map-node-label"
										style={{ fontSize: `${13 / camera.k}px` }}
									>
										{clampLabel(pageName(dr.page))}
									</text>
								</g>
								));
							})}
							{/* Item pins — item markers dropped in a zone; double-click opens
							    the item, drag repositions within the zone. Squish like doors. */}
							{squish >= 0.995
								? null
								: zones.flatMap((z) => {
									const dt = z.node ?? centroid(z.points);
									const ds = 1 - squish;
									const pinSquish =
										squish > 0.001
											? `translate(${dt.x},${dt.y}) scale(${ds}) translate(${-dt.x},${-dt.y})`
											: undefined;
									const itemColor = plugin.settings.nodeColors.item;
									const itemR = itemPinRadius(z);
									return z.itemPins.map((it, i) => (
									<g
										key={`itempin-${z.id}-${i}`}
										className="loom-map-door"
										transform={pinSquish}
										opacity={squish > 0.001 ? ds : undefined}
										onPointerDown={(e) => {
											if (tool !== "select") return;
											if (e.button !== 0) return;
											e.stopPropagation();
											setSelectedZone(z.id);
											beginPending();
											drag.current = { kind: "itempin", id: z.id, index: i, startX: e.clientX, startY: e.clientY, moved: false };
											setDragActive(true);
										}}
										onDoubleClick={(e) => {
											e.stopPropagation();
											openItem(it.item);
										}}
									>
										<circle
											cx={it.x}
											cy={it.y}
											r={itemR / camera.k}
											fill={itemColor}
											className="loom-map-node-dot"
										/>
										<g
											className="loom-map-item-glyph"
											transform={`translate(${it.x},${it.y}) scale(${(itemR * 1.1) / camera.k / 24}) translate(-12,-12)`}
											fill="none"
											stroke={glyphInk(itemColor)}
											strokeWidth={2}
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M6 3h12l4 6-10 13L2 9Z" />
											<path d="M11 3 8 9l4 13 4-13-3-6" />
											<path d="M2 9h20" />
										</g>
										<text
											x={it.x}
											y={it.y + (itemR + 12) / camera.k}
											textAnchor="middle"
											className="loom-map-node-label"
											style={{ fontSize: `${11 / camera.k}px` }}
										>
											{clampLabel(itemName(it.item))}
										</text>
									</g>
									));
								})}
							{/* Sublocation nodes — smaller nodes for a location’s sublocations,
							    inside the zone. Double-click opens the sublocation; squish like doors. */}
							{squish >= 0.995
								? null
								: zones.flatMap((z) => {
									const dt = z.node ?? centroid(z.points);
									const ds = 1 - squish;
									const spSquish =
										squish > 0.001
											? `translate(${dt.x},${dt.y}) scale(${ds}) translate(${-dt.x},${-dt.y})`
											: undefined;
									const col = darker(z.color);
									return z.subPins.map((sp, i) => (
									<g
										key={`subpin-${z.id}-${i}`}
										className="loom-map-node"
										transform={spSquish}
										opacity={squish > 0.001 ? ds : undefined}
										onPointerDown={(e) => {
											if (tool !== "select") return;
											if (e.button !== 0) return;
											e.stopPropagation();
											setSelectedZone(z.id);
											beginPending();
											drag.current = { kind: "subpin", id: z.id, index: i, startX: e.clientX, startY: e.clientY, moved: false };
											setDragActive(true);
										}}
										onDoubleClick={(e) => {
											e.stopPropagation();
											openSubloc(sp.loc);
										}}
									>
										<circle
											cx={sp.x}
											cy={sp.y}
											r={subPinRadius(z, sp.loc) / camera.k}
											fill={col}
											className="loom-map-node-dot"
										/>
										<text
											x={sp.x}
											y={sp.y + (subPinRadius(z, sp.loc) + 9) / camera.k}
											textAnchor="middle"
											className="loom-map-node-label"
											style={{ fontSize: `${11 / camera.k}px` }}
										>
											{clampLabel(sublocName(sp.loc))}
										</text>
									</g>
									));
								})}
							{/* Ghost preview while dragging a sublocation/item from the menu. */}
							{pinDrag && pinDragPos
								? (() => {
									const gz = zones.find((z) => z.id === pinDrag.zoneId);
									const gr =
										(gz ? (pinDrag.kind === 'sub' ? subPinRadius(gz, pinDrag.target) : itemPinRadius(gz)) : 9) /
										camera.k;
									return <circle cx={pinDragPos.x} cy={pinDragPos.y} r={gr} className="loom-map-sub-ghost" />;
								})()
								: null}
					</g>
				</svg>

				{/* Top-left controls: find-a-location search + the 3-stop scale slider. */}
				<div className="loom-map-controls">
					<div className="loom-map-search">
						<SearchableSelect
							placeholder="Find a location…"
							options={zones
								.filter((z) => z.location)
								.map((z) => ({ value: z.id, label: locationName(z.location) }))
								.sort((a, b) => a.label.localeCompare(b.label))}
							onPick={(id) => {
								const z = zones.find((zz) => zz.id === id);
								if (!z) return;
								const t = z.node ?? centroid(z.points);
								panTo(t.x, t.y);
								setSelectedZone(z.id);
							}}
						/>
					</div>
					<div className="loom-map-scale" role="group" aria-label="View scale">
						{VIEW_MODES.map(([m, label]) => (
							<button
								key={m}
								className={viewMode === m ? 'loom-map-scale-stop loom-map-scale-on' : 'loom-map-scale-stop'}
								aria-pressed={viewMode === m}
								onClick={() => animateCameraK(MODE_K[m])}
							>
								{label}
							</button>
						))}
					</div>
				</div>

				{/* Zone context menu (right-click, follows the zone). */}
				{menu?.kind === 'zone' && menuZone && menuPos ? (
					<ZonePanel
						key={menuZone.id}
						zone={menuZone}
						left={menuPos.x}
						top={menuPos.y}
						plugin={plugin}
						locationRecord={
							menuZone.location
								? plugin.indexer.resolve(menuZone.location, project.loomPath)
								: null
						}
						locationName={locationName(menuZone.location)}
						locationOptions={locationOptions}
						usedLocations={usedLocations}
						mapPageOptions={mapPageOptions}
						pageName={pageName}
						doorPinned={new Set(menuZone.doors.map((d) => d.page))}
						onToggleDoor={(pageId) => toggleDoor(menuZone, pageId)}
						onOpenPage={(pageId) => switchMap(pageId)}
						onDoorDragStart={(pageId) => setPinDrag({ kind: 'door', target: pageId, zoneId: menuZone.id })}
						itemOptions={itemOptions}
						itemPinned={new Set(menuZone.itemPins.map((p) => p.item))}
						onToggleItem={(t) => toggleItemPin(menuZone, t)}
						onOpenItem={(target) => openItem(target)}
						onItemDragStart={(t) => setPinDrag({ kind: 'item', target: t, zoneId: menuZone.id })}
						sublocations={sublocationsOf(menuZone).map((l) => ({
							value: linkTargetOf(l),
							label: recordLabel(l, project),
						}))}
						subPinned={new Set(menuZone.subPins.map((sp) => sp.loc))}
						onToggleSub={(loc) => toggleSubPin(menuZone, loc)}
						onOpenSub={(target) => openSubloc(target)}
						onSubDragStart={(loc) => setPinDrag({ kind: 'sub', target: loc, zoneId: menuZone.id })}
						onOpenLocation={() => openLocation(menuZone.location)}
						onGripDown={(e) => {
							if (menuZone.locked) return;
							beginPending();
							const { sx, sy } = localXY(e.clientX, e.clientY);
							drag.current = { kind: 'grip', id: menuZone.id, last: toWorld(sx, sy) };
							setDragActive(true);
						}}
						onPickLocation={(target) => {
							snapshot();
							pickLocation(menuZone, target);
						}}
						onClearLocation={() => {
							snapshot();
							updateZone(menuZone.id, { location: null, node: null });
						}}
						onNodeSize={(size) => {
							snapshot();
							updateZone(menuZone.id, { nodeSize: size });
						}}
						onWidth={(width) => {
							beginPending();
							updateZone(menuZone.id, { width });
						}}
						onResetWidth={() => {
							snapshot();
							updateZone(menuZone.id, { width: DEFAULT_ROAD_WIDTH });
						}}
						onColor={(color) => {
							beginPending();
							updateZone(menuZone.id, { color });
						}}
						onAlpha={(alpha) => {
							beginPending();
							updateZone(menuZone.id, { alpha });
						}}
						onResetAlpha={() => {
							snapshot();
							updateZone(menuZone.id, { alpha: DEFAULT_ALPHA });
						}}
						onToggleLock={() => {
							snapshot();
							updateZone(menuZone.id, { locked: !menuZone.locked });
						}}
						onDelete={() => deleteZone(menuZone.id)}
					/>
				) : null}

				{/* Global (empty-space) menu — icon-only, above cursor. */}
				{menu?.kind === 'empty' && menuPos ? (
					<div className="loom-map-menu" style={{ left: menuPos.x, top: menuPos.y }}>
						<button
							className="loom-map-icon-btn"
							aria-label="Draw"
							onClick={(e) => {
								const m = new ObsidianMenu();
								m.addItem((i) =>
									i
										.setTitle('Rectangle')
										.setIcon('square')
										.onClick(() => {
											setMenu(null);
											setTool('rect');
										})
								);
								m.addItem((i) =>
									i
										.setTitle('Polygon')
										.setIcon('pen-tool')
										.onClick(() => {
											setMenu(null);
											setTool('draw');
										})
								);
								m.addItem((i) =>
									i
										.setTitle('Road')
										.setIcon('route')
										.onClick(() => {
											setMenu(null);
											setTool('road');
										})
								);
								m.showAtMouseEvent(e.nativeEvent);
							}}
						>
							<Icon name="square-dashed" fallback="square" />
						</button>
						<button
							className="loom-map-icon-btn"
							aria-label="Import background image"
							onClick={() => {
								setMenu(null);
								new Notice('Background images are coming soon.');
							}}
						>
							<Icon name="image" />
						</button>
						<button
							className="loom-map-icon-btn"
							aria-label="Waypoints"
							onClick={() => {
								setMenu(null);
								new Notice('Waypoints view is coming soon.');
							}}
						>
							<Icon name="waypoints" />
						</button>
					</div>
				) : null}

				{zones.length === 0 && draft.length === 0 ? (
					<div className="loom-map-hint">Right-click for options, then draw a zone.</div>
				) : null}

				{/* Sublocation graph — grows straight from the clicked main node (in
				    the map, screen-anchored so pan/zoom keeps working); the rest of
				    the map is dimmed. Click the root node again (or Esc) to hide. */}
				{(() => {
					const sgZone = subGraph ? zones.find((z) => z.id === subGraph) : null;
					const sgLoc = sgZone?.location ? plugin.indexer.resolve(sgZone.location, project.loomPath) : null;
					if (!sgZone || !sgLoc) return null;
					const nodeWorld = sgZone.node ?? centroid(sgZone.points);
					const origin = screenOf(nodeWorld.x, nodeWorld.y);
					return (
						<SubGraphLayer
							plugin={plugin}
							project={project}
							rootLoc={sgLoc}
							originX={origin.x}
							originY={origin.y}
							baseSize={NODE_SIZE_PRESETS[sgZone.nodeSize]}
							color={darker(sgZone.color)}
							starColor="var(--text-on-accent, #fff)"
							onOpen={(path) => {
								view.openEntity(path);
								setSubGraph(null);
							}}
							onClose={() => setSubGraph(null)}
						/>
					);
				})()}
			</div>
		</ViewShell>
	);
}

/** Obsidian's SliderComponent embedded in React — the same slider (and value
 *  tooltip via setDynamicTooltip) as the settings tab. onChange reports the raw
 *  slider value; the parent keeps `value` in sync (e.g. on a reset). */
function ObsidianSlider({
	value,
	min,
	max,
	step,
	onChange,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (v: number) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const slider = useRef<SliderComponent | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		const s = new SliderComponent(host);
		s.setLimits(min, max, step);
		s.setValue(value);
		s.setDynamicTooltip();
		s.onChange((v) => onChangeRef.current(v));
		slider.current = s;
		return () => {
			host.empty();
			slider.current = null;
		};
		// Mount once; value is kept in sync by the effect below.
	}, []);
	useEffect(() => {
		if (slider.current && slider.current.getValue() !== value) slider.current.setValue(value);
	}, [value]);
	return <div className="loom-map-obsidian-slider" ref={ref} />;
}

/** The horizontal per-zone context menu. Style settings (color + transparency)
 *  live behind the palette icon; the rest are icon-only. */
function ZonePanel({
	zone,
	left,
	top,
	plugin,
	locationRecord,
	locationName,
	locationOptions,
	usedLocations,
	mapPageOptions,
	pageName,
	doorPinned,
	onToggleDoor,
	onOpenPage,
	onDoorDragStart,
	itemOptions,
	itemPinned,
	onToggleItem,
	onOpenItem,
	onItemDragStart,
	sublocations,
	subPinned,
	onToggleSub,
	onOpenSub,
	onSubDragStart,
	onGripDown,
	onPickLocation,
	onOpenLocation,
	onClearLocation,
	onNodeSize,
	onWidth,
	onResetWidth,
	onColor,
	onAlpha,
	onResetAlpha,
	onToggleLock,
	onDelete,
}: {
	zone: MapZone;
	left: number;
	top: number;
	plugin: LoomLoomPlugin;
	locationRecord: EntityRecord | null;
	locationName: string;
	locationOptions: { value: string; label: string }[];
	usedLocations: Set<string>;
	mapPageOptions: { value: string; label: string }[];
	pageName: (id: string) => string;
	doorPinned: Set<string>;
	onToggleDoor: (pageId: string) => void;
	onOpenPage: (pageId: string) => void;
	onDoorDragStart: (pageId: string) => void;
	itemOptions: { value: string; label: string }[];
	itemPinned: Set<string>;
	onToggleItem: (itemTarget: string) => void;
	onOpenItem: (target: string) => void;
	onItemDragStart: (itemTarget: string) => void;
	sublocations: { value: string; label: string }[];
	subPinned: Set<string>;
	onToggleSub: (loc: string) => void;
	onOpenSub: (target: string) => void;
	onSubDragStart: (loc: string) => void;
	onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	onPickLocation: (target: string) => void;
	onOpenLocation: () => void;
	onClearLocation: () => void;
	onNodeSize: (size: NodeSizePreset) => void;
	onWidth: (width: number) => void;
	onResetWidth: () => void;
	onColor: (color: string) => void;
	onAlpha: (alpha: number) => void;
	onResetAlpha: () => void;
	onToggleLock: () => void;
	onDelete: () => void;
}) {
	// Only one popover (style / doors / items / sublocations) is open at a time.
	const [openPanel, setOpenPanel] = useState<'style' | 'doors' | 'items' | 'subs' | null>(null);
	const togglePanel = (p: 'style' | 'doors' | 'items' | 'subs') =>
		setOpenPanel((cur) => (cur === p ? null : p));
	const [subQuery, setSubQuery] = useState('');
	const [itemQuery, setItemQuery] = useState('');
	const [doorQuery, setDoorQuery] = useState('');
	// Editing the association: unassociated zones show the search directly;
	// associated ones show the location as a clickable chip + a square-pen.
	const [editingLoc, setEditingLoc] = useState(false);
	const isRoad = zone.kind === 'road';
	const showSearch = !zone.location || editingLoc;
	return (
		<div className="loom-map-menu loom-map-zone-menu" style={{ left, top }}>
			{/* Grip — a drag handle, not a button (no hover box, grab cursor). */}
			<button
				className="loom-map-icon-btn loom-map-grip"
				aria-label={zone.locked ? 'Locked' : 'Move zone'}
				disabled={zone.locked}
				onPointerDown={onGripDown}
			>
				<Icon name="grip" fallback="move" />
			</button>
			{/* Location association — a road is its own zone too, so it can carry
			    its own location just like a polygon zone (its start/end endpoints
			    are separate, drawing-only). */}
			{showSearch ? (
				<div className="loom-map-loc loom-map-loc-search">
					<SearchableSelect
						// Keyed on the association state so clearing remounts it empty
						// (its query is seeded on mount, not reset in place).
						key={`${zone.location ?? ''}:${editingLoc}`}
						placeholder="Associate a location…"
						// Don't offer a location that's already placed on this map
						// (except this zone's own current one).
						options={locationOptions.filter(
							(o) => o.value === zone.location || !usedLocations.has(o.value)
						)}
						initialQuery={editingLoc ? locationName : ''}
						autoFocus
						onPick={(target) => {
							onPickLocation(target);
							setEditingLoc(false);
						}}
					/>
					{editingLoc ? (
						<button
							className="loom-map-icon-btn"
							aria-label="Clear location"
							onClick={() => {
								onClearLocation();
								setEditingLoc(false);
							}}
						>
							<Icon name="eraser" />
						</button>
					) : null}
				</div>
			) : (
				<div className="loom-map-loc">
					<EntityChip plugin={plugin} record={locationRecord} label={locationName} onOpen={onOpenLocation} />
					<button
						className="loom-map-icon-btn"
						aria-label="Change location"
						onClick={() => setEditingLoc(true)}
					>
						<Icon name="square-pen" fallback="pencil" />
					</button>
				</div>
			)}
			<span className="loom-map-sep" />
			{/* Sublocations of the zone’s location, shown as nodes inside it. */}
			{sublocations.length > 0 ? (
				<div className="loom-map-palette">
					<button
						className={openPanel === 'subs' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
						aria-label="Sublocations in this zone"
						onClick={() => togglePanel('subs')}
					>
						<Icon name="list" />
					</button>
					{openPanel === 'subs'
						? (() => {
								const q = subQuery.trim().toLowerCase();
								const filtered = q
									? sublocations.filter((s) => s.label.toLowerCase().includes(q))
									: sublocations;
								const shown = filtered.slice(0, 10);
								return (
									<div className="loom-map-palette-pop loom-map-doors-pop">
										<input
											className="loom-map-subs-search"
											type="text"
											placeholder="Search sublocations…"
											value={subQuery}
											onChange={(e) => setSubQuery(e.target.value)}
										/>
										<div className="loom-map-subs-head">
											<span>Location</span>
											<span>Node</span>
										</div>
										{shown.map((sub) => (
											<div key={sub.value} className="loom-map-doors-row loom-map-subs-row">
												<button
													className="loom-map-doors-open"
													title="Click to open · drag onto the map to place its node"
													draggable
													onDragStart={(e) => {
														e.dataTransfer.effectAllowed = 'copy';
														e.dataTransfer.setData('text/plain', sub.value);
														// Hide the default row drag image — only the node ghost shows.
														e.dataTransfer.setDragImage(new Image(), 0, 0);
														onSubDragStart(sub.value);
													}}
													onClick={() => onOpenSub(sub.value)}
												>
													<Icon name="map-pin" />
													<span>{sub.label}</span>
												</button>
												<input
													type="checkbox"
													checked={subPinned.has(sub.value)}
													onChange={() => onToggleSub(sub.value)}
													aria-label="Show as node in the zone"
												/>
											</div>
										))}
										{filtered.length > shown.length ? <div className="loom-map-subs-more">…</div> : null}
										{filtered.length === 0 ? <div className="loom-map-subs-more">No matches</div> : null}
									</div>
								);
							})()
						: null}
				</div>
			) : null}
			{/* Doors: portal links to other map pages. */}
			<div className="loom-map-palette">
				<button
					className={openPanel === 'doors' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
					aria-label="Doors to other maps"
					onClick={() => togglePanel('doors')}
				>
					<Icon name="door-open" fallback="log-in" />
				</button>
				{openPanel === 'doors'
					? (() => {
							const q = doorQuery.trim().toLowerCase();
							const filtered = q
								? mapPageOptions.filter((o) => o.label.toLowerCase().includes(q))
								: mapPageOptions;
							const shown = filtered.slice(0, 10);
							return (
								<div className="loom-map-palette-pop loom-map-doors-pop">
									<input
										className="loom-map-subs-search"
										type="text"
										placeholder="Search map pages"
										value={doorQuery}
										onChange={(e) => setDoorQuery(e.target.value)}
									/>
									<div className="loom-map-subs-head">
										<span>Map</span>
										<span>Node</span>
									</div>
									{shown.map((pg) => (
										<div key={pg.value} className="loom-map-doors-row loom-map-subs-row">
											<button
												className="loom-map-doors-open"
												title="Click to open · drag onto the map to place its door"
												draggable
												onDragStart={(e) => {
													e.dataTransfer.effectAllowed = 'copy';
													e.dataTransfer.setData('text/plain', pg.value);
													e.dataTransfer.setDragImage(new Image(), 0, 0);
													onDoorDragStart(pg.value);
												}}
												onClick={() => onOpenPage(pg.value)}
											>
												<Icon name="door-open" fallback="log-in" />
												<span>{pg.label}</span>
											</button>
											<input
												type="checkbox"
												checked={doorPinned.has(pg.value)}
												onChange={() => onToggleDoor(pg.value)}
												aria-label="Show a door in the zone"
											/>
										</div>
									))}
									{filtered.length > shown.length ? <div className="loom-map-subs-more">…</div> : null}
									{filtered.length === 0 ? <div className="loom-map-subs-more">No matches</div> : null}
								</div>
							);
						})()
					: null}
			</div>
			{/* Items dropped inside the zone. */}
			<div className="loom-map-palette">
				<button
					className={openPanel === 'items' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
					aria-label="Items in this zone"
					onClick={() => togglePanel('items')}
				>
					<Icon name="gem" />
				</button>
				{openPanel === 'items'
					? (() => {
							const q = itemQuery.trim().toLowerCase();
							const filtered = q
								? itemOptions.filter((o) => o.label.toLowerCase().includes(q))
								: itemOptions;
							const shown = filtered.slice(0, 10);
							return (
								<div className="loom-map-palette-pop loom-map-doors-pop">
									<input
										className="loom-map-subs-search"
										type="text"
										placeholder="Search items"
										value={itemQuery}
										onChange={(e) => setItemQuery(e.target.value)}
									/>
									<div className="loom-map-subs-head">
										<span>Item</span>
										<span>Node</span>
									</div>
									{shown.map((it) => (
										<div key={it.value} className="loom-map-doors-row loom-map-subs-row">
											<button
												className="loom-map-doors-open"
												title="Click to open · drag onto the map to place its node"
												draggable
												onDragStart={(e) => {
													e.dataTransfer.effectAllowed = 'copy';
													e.dataTransfer.setData('text/plain', it.value);
													e.dataTransfer.setDragImage(new Image(), 0, 0);
													onItemDragStart(it.value);
												}}
												onClick={() => onOpenItem(it.value)}
											>
												<Icon name="gem" />
												<span>{it.label}</span>
											</button>
											<input
												type="checkbox"
												checked={itemPinned.has(it.value)}
												onChange={() => onToggleItem(it.value)}
												aria-label="Show as node in the zone"
											/>
										</div>
									))}
									{filtered.length > shown.length ? <div className="loom-map-subs-more">…</div> : null}
									{filtered.length === 0 ? <div className="loom-map-subs-more">No matches</div> : null}
								</div>
							);
						})()
					: null}
			</div>
			<span className="loom-map-sep" />
			{/* Group: node size + style + lock. */}
			{zone.location ? (
				<label className="loom-map-size-btn" aria-label="Node size">
					<select
						className="loom-map-size"
						value={zone.nodeSize}
						onChange={(e) => onNodeSize(e.target.value as NodeSizePreset)}
					>
						{SIZE_OPTIONS.map(([v, l]) => (
							<option key={v} value={v}>
								{l}
							</option>
						))}
					</select>
				</label>
			) : null}
			<div className="loom-map-palette">
				<button
					className={openPanel === 'style' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
					aria-label="Style"
					onClick={() => togglePanel('style')}
				>
					<Icon name="palette" />
				</button>
				{openPanel === 'style' ? (
					<div className="loom-map-palette-pop">
						<label className="loom-map-palette-row">
							<span>Color</span>
							<input
								type="color"
								value={zone.color}
								onChange={(e) => onColor(e.target.value)}
								className="loom-map-color"
							/>
						</label>
						<label className="loom-map-palette-row">
							<span>Opacity</span>
							<ObsidianSlider
								min={0}
								max={100}
								step={5}
								value={Math.round(zone.alpha * 100)}
								onChange={(v) => onAlpha(v / 100)}
							/>
							<button
								className="loom-map-icon-btn loom-map-reset"
								aria-label="Reset transparency"
								onClick={onResetAlpha}
							>
								<Icon name="rotate-ccw" />
							</button>
						</label>
						{isRoad ? (
							<label className="loom-map-palette-row">
								<span>Width</span>
								<ObsidianSlider
									min={ROAD_WIDTH_MIN}
									max={ROAD_WIDTH_MAX}
									step={2}
									value={Math.round(zone.width)}
									onChange={(v) => onWidth(v)}
								/>
								<button
									className="loom-map-icon-btn loom-map-reset"
									aria-label="Reset width"
									onClick={onResetWidth}
								>
									<Icon name="rotate-ccw" />
								</button>
							</label>
						) : null}
					</div>
				) : null}
			</div>
			<span className="loom-map-sep" />
			<button
				className={zone.locked ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
				aria-label={zone.locked ? 'Unlock zone' : 'Lock zone'}
				onClick={onToggleLock}
			>
				<Icon name={zone.locked ? 'lock' : 'lock-open'} fallback="lock" />
			</button>
			<span className="loom-map-sep" />
			<button className="loom-map-icon-btn loom-map-danger" aria-label="Delete zone" onClick={onDelete}>
				<Icon name="trash-2" />
			</button>
		</div>
	);
}

/** Left navigator for a project's map pages: slides out on hover, pins open, has
 *  its own name search, and supports drag-to-nest (folder-like). */
function MapsPanel({
	plugin,
	pages,
	activeId,
	onSwitch,
	onCreate,
	onRename,
	onDelete,
	onNest,
}: {
	plugin: LoomLoomPlugin;
	pages: MapPage[];
	activeId: string;
	onSwitch: (id: string) => void;
	onCreate: (parentId?: string | null) => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
	onNest: (dragId: string, targetId: string | null) => void;
}) {
	const [pinned, setPinned] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameText, setRenameText] = useState('');
	const [dragId, setDragId] = useState<string | null>(null);
	// A page id, the sentinel 'root', or null (nothing hovered).
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const byOrder = (a: MapPage, b: MapPage) => a.order - b.order || a.name.localeCompare(b.name);
	const childrenOf = (id: string | null) => pages.filter((p) => p.parentId === id).sort(byOrder);
	const q = query.trim().toLowerCase();
	const matches = q ? pages.filter((p) => p.name.toLowerCase().includes(q)).sort(byOrder) : null;

	// The lowest free "New map N" (frees up when an N is renamed away).
	const nextAutoName = () => {
		const used = new Set(pages.map((p) => p.name));
		let n = 1;
		while (used.has(`New map ${n}`)) n++;
		return `New map ${n}`;
	};
	const nameExists = (name: string, exceptId: string) =>
		pages.some((p) => p.id !== exceptId && p.name === name);
	const dedupName = (base: string) => {
		let n = 2;
		while (pages.some((p) => p.name === `${base} ${n}`)) n++;
		return `${base} ${n}`;
	};

	// A freshly created page has an empty name — drop straight into renaming it,
	// cursor in the field (auto-named "New map N" if left blank).
	useEffect(() => {
		const pending = pages.find((p) => p.name === '');
		if (pending && renaming !== pending.id) {
			setRenameText('');
			setRenaming(pending.id);
		}
	}, [pages, renaming]);

	const startRename = (p: MapPage) => {
		setRenameText(p.name);
		setRenaming(p.id);
	};
	const commitRename = () => {
		const id = renaming;
		if (!id) return;
		const text = renameText.trim();
		if (text === '') {
			// Blank → auto-name (only a just-created page can be blank).
			onRename(id, nextAutoName());
			setRenaming(null);
			return;
		}
		if (nameExists(text, id)) {
			// Duplicate → offer a de-duplicated name, or keep editing on cancel.
			const suggestion = dedupName(text);
			new ConfirmModal(
				plugin.app,
				'Name already exists',
				`A map named "${text}" already exists.`,
				() => {
					onRename(id, suggestion);
					setRenaming(null);
				},
				`Create "${suggestion}"`
			).open();
			return;
		}
		onRename(id, text);
		setRenaming(null);
	};
	const cancelRename = () => {
		const id = renaming;
		if (!id) return;
		// A never-named page can't be left nameless — auto-name it.
		if (pages.find((p) => p.id === id)?.name === '') onRename(id, nextAutoName());
		setRenaming(null);
	};
	const toggleCollapse = (id: string) =>
		setCollapsed((s) => {
			const n = new Set(s);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	const openMenu = (e: ReactMouseEvent<HTMLElement>, p: MapPage) => {
		e.preventDefault();
		const menu = new ObsidianMenu();
		menu.addItem((i) => i.setTitle('New map inside').setIcon('plus').onClick(() => onCreate(p.id)));
		menu.addItem((i) => i.setTitle('Rename').setIcon('pencil').onClick(() => startRename(p)));
		menu.addItem((i) =>
			i
				.setTitle('Delete')
				.setIcon('trash-2')
				.onClick(() =>
					new ConfirmModal(
						plugin.app,
						'Delete map?',
						`"${p.name}" and all of its zones will be removed.`,
						() => onDelete(p.id),
						'Delete'
					).open()
				)
		);
		// Keep the panel from auto-hiding while the menu is up.
		setMenuOpen(true);
		menu.onHide(() => setMenuOpen(false));
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const row = (p: MapPage, depth: number, flat: boolean): ReactElement => {
		const kids = flat ? [] : childrenOf(p.id);
		const isCollapsed = collapsed.has(p.id);
		return (
			<div key={p.id}>
				<div
					className={
						'loom-map-page-row' +
						(p.id === activeId ? ' loom-map-page-active' : '') +
						(dropTarget === p.id ? ' loom-map-page-drop' : '')
					}
					style={{ paddingLeft: `${6 + depth * 14}px` }}
					draggable={renaming !== p.id}
					onDragStart={(e) => {
						e.dataTransfer.effectAllowed = 'move';
						setDragId(p.id);
					}}
					onDragEnd={() => {
						setDragId(null);
						setDropTarget(null);
					}}
					onDragOver={(e) => {
						if (dragId && dragId !== p.id) {
							e.preventDefault();
							setDropTarget(p.id);
						}
					}}
					onDragLeave={() => setDropTarget((t) => (t === p.id ? null : t))}
					onDrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (dragId) onNest(dragId, p.id);
						setDragId(null);
						setDropTarget(null);
					}}
					onClick={() => {
						if (renaming !== p.id) onSwitch(p.id);
					}}
					onDoubleClick={() => startRename(p)}
					onContextMenu={(e) => openMenu(e, p)}
				>
					{kids.length > 0 ? (
						<button
							className="loom-map-page-caret"
							aria-label={isCollapsed ? 'Expand' : 'Collapse'}
							onClick={(e) => {
								e.stopPropagation();
								toggleCollapse(p.id);
							}}
						>
							<Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
						</button>
					) : (
						<span className="loom-map-page-caret-empty" />
					)}
					<Icon name="map" />
					{renaming === p.id ? (
						<input
							className="loom-map-page-rename"
							type="text"
							placeholder="New map"
							value={renameText}
							autoFocus
							onChange={(e) => setRenameText(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === 'Enter') commitRename();
								if (e.key === 'Escape') cancelRename();
							}}
							onClick={(e) => e.stopPropagation()}
						/>
					) : (
						<span className="loom-map-page-name">{p.name}</span>
					)}
				</div>
				{kids.length > 0 && !isCollapsed ? kids.map((k) => row(k, depth + 1, false)) : null}
			</div>
		);
	};

	// Stay open while pinned, while a context menu is up, or while renaming — so a
	// right-click menu or the rename field doesn't slide the panel shut.
	const forceOpen = pinned || menuOpen || renaming !== null;
	return (
		<div className={forceOpen ? 'loom-map-panel loom-map-panel-pinned' : 'loom-map-panel'}>
			<div className="loom-map-panel-inner">
				<div className="loom-map-panel-head">
					<span className="loom-map-panel-title">Maps</span>
					<div className="loom-shell-spacer" />
					<button className="loom-map-icon-btn" aria-label="New map" onClick={() => onCreate(null)}>
						<Icon name="plus" />
					</button>
					<button
						className={pinned ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
						aria-label={pinned ? 'Unpin panel' : 'Pin panel open'}
						onClick={() => setPinned((v) => !v)}
					>
						<Icon name={pinned ? 'pin' : 'pin-off'} fallback="pin" />
					</button>
				</div>
				<input
					className="loom-map-panel-search"
					type="text"
					placeholder="Search maps…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div
					className="loom-map-panel-list"
					onDragOver={(e) => {
						if (dragId) {
							e.preventDefault();
							setDropTarget('root');
						}
					}}
					onDrop={(e) => {
						e.preventDefault();
						if (dragId) onNest(dragId, null);
						setDragId(null);
						setDropTarget(null);
					}}
				>
					{(matches ?? childrenOf(null)).map((p) => row(p, 0, matches !== null))}
					{pages.length === 0 ? <div className="loom-map-panel-empty">No maps</div> : null}
				</div>
			</div>
			<div className="loom-map-panel-edge" aria-hidden="true">
				<Icon name="chevrons-right" fallback="map" />
			</div>
		</div>
	);
}

/** Sublocation graph — a top-down tree of the clicked main location's
 *  sublocations, drawn IN the map, screen-anchored at the node so pan/zoom keep
 *  working (the rest of the map is dimmed by its own opacity). The container is
 *  click-through (`pointer-events: none`); only the tree nodes react. Root-node
 *  click hides; other nodes double-click to open. */
function SubGraphLayer({
	plugin,
	project,
	rootLoc,
	originX,
	originY,
	baseSize,
	color,
	starColor,
	onOpen,
	onClose,
}: {
	plugin: LoomLoomPlugin;
	project: { root: string; loomPath: string };
	rootLoc: EntityRecord;
	originX: number;
	originY: number;
	baseSize: number;
	color: string;
	starColor: string;
	onOpen: (path: string) => void;
	onClose: () => void;
}) {
	type TNode = { loc: EntityRecord; depth: number; x: number; children: TNode[] };
	const childrenOf = (loc: EntityRecord): EntityRecord[] =>
		plugin.indexer
			.getAll('location', project.root)
			.filter((l) => l.parentLocation && plugin.indexer.resolve(l.parentLocation, l.path)?.path === loc.path)
			.sort((a, b) => a.name.localeCompare(b.name));
	let slot = 0;
	const build = (loc: EntityRecord, depth: number): TNode => {
		const kids = childrenOf(loc).map((c) => build(c, depth + 1));
		const x = kids.length === 0 ? slot++ : (kids[0].x + kids[kids.length - 1].x) / 2;
		return { loc, depth, x, children: kids };
	};
	const root = build(rootLoc, 0);
	const nodes: TNode[] = [];
	const edges: [TNode, TNode][] = [];
	const walk = (n: TNode, parent: TNode | null) => {
		nodes.push(n);
		if (parent) edges.push([parent, n]);
		n.children.forEach((c) => walk(c, n));
	};
	walk(root, null);

	const SLOT_W = 110;
	const LEVEL_H = 100;
	// Screen coords centered on the clicked node (root at the origin).
	const px = (n: TNode) => originX + (n.x - root.x) * SLOT_W;
	const py = (n: TNode) => originY + n.depth * LEVEL_H;
	const radius = (depth: number) =>
		depth === 0 ? baseSize : Math.max(MIN_SUB_NODE_SIZE, baseSize * Math.pow(SUB_NODE_SCALE, depth));

	return (
		<svg className="loom-map-subgraph">
			{edges.map(([a, b], i) => (
				<line key={i} x1={px(a)} y1={py(a)} x2={px(b)} y2={py(b)} className="loom-map-subgraph-edge" />
			))}
			{nodes.map((n) => {
				const r = radius(n.depth);
				const isRoot = n.depth === 0;
				return (
					<g
						key={n.loc.path}
						className="loom-map-node loom-map-subgraph-node"
						onClick={() => (isRoot ? onClose() : undefined)}
						onDoubleClick={() => (isRoot ? undefined : onOpen(n.loc.path))}
					>
						<circle cx={px(n)} cy={py(n)} r={r} fill={color} className="loom-map-node-dot" />
						{isRoot ? (
							<g
								transform={`translate(${px(n)},${py(n)}) scale(${r / 13}) translate(-12,-12)`}
								fill={starColor}
								fillOpacity={0.92}
							>
								<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
							</g>
						) : null}
						<text
							x={px(n)}
							y={py(n) + r + 14}
							textAnchor="middle"
							className="loom-map-node-label"
							style={{ fontSize: '12px' }}
						>
							{clampLabel(n.loc.name)}
						</text>
					</g>
				);
			})}
		</svg>
	);
}
