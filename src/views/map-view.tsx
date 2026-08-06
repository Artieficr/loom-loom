import {
	App,
	Menu as ObsidianMenu,
	Notice,
	SliderComponent,
	TFile,
	TFolder,
	ViewStateResult,
	debounce,
	normalizePath,
} from 'obsidian';
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
	MAPS_IMAGES_FOLDER,
	MAPS_LABEL,
	NODE_SIZE_PRESETS,
	NodeSizePreset,
	VIEW_MAP,
} from '../types';
import { linkTargetOf, ProjectDef } from '../indexer';
import { ConfirmModal } from '../project';
import type LoomLoomPlugin from '../main';
import { LoomReactView } from './react-view';
import { EntityChip, Icon, SearchableSelect, ViewShell, noProjectMessage, recordLabel } from './common';
import { resolveProject, useIndexVersion } from './hooks';
import { focusNeighborhood } from './mini-graph';
import { EdgeRoute, LANE_EPSILON, edgePoints, roundedPath } from '../graph/routing';

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
	/** Item markers dropped inside the zone (link target + position). `size`
	 *  overrides the zone-derived size for that one marker. */
	itemPins: { item: string; x: number; y: number; size?: NodeSizePreset }[];
	/** Sublocation nodes shown inside the zone (a sublocation of the zone's
	 *  location, drawn as a smaller node; link target + position). `size` overrides
	 *  the nesting-derived size for that one node. */
	subPins: { loc: string; x: number; y: number; size?: NodeSizePreset }[];
	/** Locked zones can't be moved or reshaped (still selectable). */
	locked: boolean;
}

/**
 * A background image placed on a map page — always the BOTTOM layer, under every
 * zone, road and marker, so you draw over it.
 *
 * `w`/`h` are world units and always keep the file's aspect ratio: an import
 * starts at the image's natural pixel size (1 image pixel = 1 world unit, so a
 * scanned map can be traced 1:1, and the page's element scale says how big a node
 * is against it), and every resize handle scales both axes together.
 */
interface MapImage {
	id: string;
	/** Vault path of the image file (under `Maps/Images`). */
	path: string;
	/** Top-left corner in world coords. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Natural pixel size, kept so "real size" can be restored without loading. */
	nw: number;
	nh: number;
	/** A locked image is backdrop only: its interior counts as empty space (drag
	 *  pans the camera, right-click gives the global menu), and only its EDGE
	 *  answers a right-click with the image's own menu. */
	locked: boolean;
	opacity: number;
}

/** One named map page inside a project's Maps file. Pages nest via `parentId`
 *  (folder-like) and order among siblings via `order`. */
interface MapPage {
	id: string;
	name: string;
	parentId: string | null;
	order: number;
	zones: MapZone[];
	/** Background images, painted in order under everything else. */
	images: MapImage[];
	/** Element scale — world px per size unit (see REF_ZONE_RADIUS). Inferred from
	 *  the page's zones when absent, so pre-scale maps keep sensible markers. */
	scale: number;
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
const NODE_DBL_MS = 220; // short double-click window on a node (open its page)
const DELETE_SCRUB_MS = 3000; // grace period before a deleted note's map pins are cleared
const DEFAULT_ROAD_WIDTH = 280; // world units — wide enough that location nodes fit inside
const ROAD_WIDTH_MIN = 8;
const ROAD_WIDTH_MAX = 1000;
const MIN_VERTEX_DIST = 12; // screen px — clicks nearer than this to the last vertex don't add one
const SUB_NODE_SCALE = 0.72; // each sublocation level renders this fraction of its parent's size
const MIN_SUB_NODE_SIZE = 6; // px floor — deeper sublocations never shrink past this

/**
 * Element scale — the map's own anchor for "how big is a thing here".
 *
 * Everything drawn on a map is relative (world units with no fixed meaning), so a
 * map hand-drawn with 3000-unit-wide continents and one drawn with 200-unit towns
 * would render identically sized nodes, labels and roads — tiny on the first,
 * huge on the second. A page therefore carries a `scale`: world px per size unit,
 * multiplying every world-fixed marker (nodes, pins, labels, new road widths) and
 * dividing the zoom thresholds, so "regular" and "node view" land where the map's
 * own geometry says they should. It is inferred from what's already drawn (a
 * typical zone reads about REF_ZONE_UNITS regular nodes across) and adjustable
 * from the Element-size control, so old maps need no redrawing.
 */
const REF_ZONE_UNITS = 5;
const REF_ZONE_RADIUS = REF_ZONE_UNITS * NODE_SIZE_PRESETS.regular;
/** Smallest world width a background image can be resized to. */
const IMAGE_MIN_W = 8;
/** Screen-px band around a locked image's border that still opens its menu. */
const IMAGE_EDGE_PX = 10;
/** Half-size (screen px) of an image resize grip, and the half-width of the
 *  invisible drag band along each side. */
const IMAGE_GRIP_PX = 7;
/** Footprint of the background-image picker panel (px), used to flip it to
 *  whichever side of the cursor has room. */
const IMAGE_PICKER_W = 280;
const IMAGE_PICKER_H = 400;
const SCALE_MIN = 0.05;
const SCALE_MAX = 60;
/** The scale slider is logarithmic — the useful range spans three orders of
 *  magnitude, so equal slider travel has to mean equal proportional change. */
const sliderToScale = (v: number) => SCALE_MIN * Math.pow(SCALE_MAX / SCALE_MIN, v / 100);
const scaleToSlider = (s: number) =>
	Math.round((Math.log(Math.max(SCALE_MIN, s) / SCALE_MIN) / Math.log(SCALE_MAX / SCALE_MIN)) * 100);
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

/** A node-size preset, or undefined when the value isn't one. */
function parsePreset(v: unknown): NodeSizePreset | undefined {
	return v === 'small' || v === 'regular' || v === 'big' || v === 'very-big' ? v : undefined;
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
			// Stored widths are absolute world units — the ROAD_WIDTH_MIN/MAX range is
			// per-map (scaled), so clamping to it here would shrink a big map's roads.
			width:
				typeof z.width === 'number' && Number.isFinite(z.width) && z.width > 0
					? Math.min(z.width, ROAD_WIDTH_MAX * SCALE_MAX)
					: DEFAULT_ROAD_WIDTH,
			color: typeof z.color === 'string' ? z.color : '#c9a36b',
			alpha: typeof z.alpha === 'number' ? Math.max(0, Math.min(1, z.alpha)) : DEFAULT_ALPHA,
			location: typeof z.location === 'string' ? z.location : null,
			node:
				z.node && Number.isFinite(z.node.x) && Number.isFinite(z.node.y)
					? { x: z.node.x, y: z.node.y }
					: null,
			nodeSize: parsePreset(z.nodeSize) ?? 'regular',
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
						.map((it) => ({ item: it.item, x: it.x, y: it.y, size: parsePreset((it as { size?: unknown }).size) }))
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
						.map((sp) => ({ loc: sp.loc, x: sp.x, y: sp.y, size: parsePreset((sp as { size?: unknown }).size) }))
				: [],
			locked: z.locked === true,
		});
	}
	return zones;
}

/** Parses a raw background-image array tolerantly (drops unusable entries). */
function parseImages(raw: unknown): MapImage[] {
	if (!Array.isArray(raw)) return [];
	const out: MapImage[] = [];
	for (const im of raw as Partial<MapImage>[]) {
		if (!im || typeof im.path !== 'string') continue;
		const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
		const nw = Math.max(1, num(im.nw, 100));
		const nh = Math.max(1, num(im.nh, 100));
		const w = Math.max(IMAGE_MIN_W, num(im.w, nw));
		out.push({
			id: typeof im.id === 'string' ? im.id : newId(),
			path: im.path,
			x: num(im.x, 0),
			y: num(im.y, 0),
			w,
			// Height always follows the natural aspect ratio, whatever was stored.
			h: Math.max(1, (w * nh) / nw),
			nw,
			nh,
			locked: im.locked === true,
			opacity: Math.max(0.05, Math.min(1, num(im.opacity, 1))),
		});
	}
	return out;
}

/** Equivalent-circle radius of a polygon in world units (0 when degenerate). */
function polygonRadius(pts: { x: number; y: number }[]): number {
	let a = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
	const area = Math.abs(a) / 2;
	return area > 0 ? Math.sqrt(area / Math.PI) : 0;
}

/** The element scale implied by what's already drawn: the median polygon zone
 *  should read about REF_ZONE_UNITS regular nodes across. An empty page (nothing
 *  to measure) stays at 1. */
function inferScale(zones: MapZone[]): number {
	const radii = zones
		.filter((z) => z.kind === 'zone')
		.map((z) => polygonRadius(z.points))
		.filter((r) => r > 0)
		.sort((a, b) => a - b);
	if (radii.length === 0) return 1;
	const median = radii[Math.floor(radii.length / 2)];
	return Math.max(SCALE_MIN, Math.min(SCALE_MAX, median / REF_ZONE_RADIUS));
}

type ProjectRef = { root: string; name: string };

/** A path inside a project's folder. */
function projectPath(project: ProjectRef, sub: string): string {
	return normalizePath(project.root === '' ? sub : `${project.root}/${sub}`);
}

/** Path of a project's Maps store — `Entities/Maps/<Project> Maps.json`. */
export function mapsFilePath(project: ProjectRef): string {
	return projectPath(project, `${MAPS_FOLDER}/${project.name} Maps.json`);
}

/** Where a project's background images are copied. */
export function mapsImagesPath(project: ProjectRef): string {
	return projectPath(project, MAPS_IMAGES_FOLDER);
}

/** A project's Maps store, or null when it has none yet (nothing drawn). */
export function findMapsFile(app: App, project: ProjectRef): TFile | null {
	return app.vault.getFileByPath(mapsFilePath(project));
}

/** How many map pages a project has — the count on the home wheel's Maps entry.
 *  0 when the project has no Maps file yet. */
export async function countMapPages(app: App, project: ProjectRef): Promise<number> {
	const file = findMapsFile(app, project);
	if (!file) return 0;
	try {
		return parseMapsFile(await app.vault.cachedRead(file))?.maps.length ?? 0;
	} catch {
		return 0;
	}
}

/** A single default page (used for a brand-new project map). */
function defaultPages(): MapPage[] {
	return [{ id: newId(), name: 'Map', parentId: null, order: 0, zones: [], images: [], scale: 1 }];
}

/**
 * Downscaled thumbnails for the background-image picker, cached per file+mtime
 * for the session.
 *
 * A 28px `<img src={resourcePath}>` still makes the browser decode the WHOLE
 * image: a 4620×7840 map photo is 36 MP, i.e. ~145 MB of bitmap each, so a folder
 * of 32 of them asked for ~4.6 GB of decoding at once and the panel crawled.
 * Instead each file is read once and decoded straight to `THUMB_PX` wide via
 * `createImageBitmap`'s resize (so the full-size bitmap is never retained), then
 * kept as a tiny data URL.
 */
const THUMB_PX = 64;
const thumbCache = new Map<string, string>();
/** Thumbnails are built one at a time — a burst of rows decoding in parallel is
 *  what stalls the UI, and the queue keeps the newest scroll position responsive. */
let thumbQueue: Promise<unknown> = Promise.resolve();

const thumbKey = (file: TFile) => `${file.path}:${file.stat.mtime}`;

async function buildThumb(app: App, file: TFile): Promise<string | null> {
	const key = thumbKey(file);
	const cached = thumbCache.get(key);
	if (cached) return cached;
	try {
		const bmp = await createImageBitmap(new Blob([await app.vault.readBinary(file)]), {
			// Width only — the height follows the aspect ratio, and the CSS crops it.
			resizeWidth: THUMB_PX,
			resizeQuality: 'low',
		});
		const canvas = createEl('canvas');
		canvas.width = bmp.width;
		canvas.height = bmp.height;
		canvas.getContext('2d')?.drawImage(bmp, 0, 0);
		bmp.close();
		const url = canvas.toDataURL('image/png');
		thumbCache.set(key, url);
		return url;
	} catch {
		// Undecodable (or an SVG with no intrinsic size) — the row keeps its blank.
		return null;
	}
}

/** One picker row's thumbnail: blank until the row is actually scrolled into
 *  view, then its cached data URL. Nothing off-screen is ever decoded. */
function ImageThumb({ plugin, file }: { plugin: LoomLoomPlugin; file: TFile }) {
	const [url, setUrl] = useState<string | null>(() => thumbCache.get(thumbKey(file)) ?? null);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (url) return;
		const el = ref.current;
		if (!el) return;
		let cancelled = false;
		const io = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				io.disconnect();
				thumbQueue = thumbQueue.then(async () => {
					if (cancelled) return;
					const next = await buildThumb(plugin.app, file);
					if (!cancelled && next) setUrl(next);
				});
			},
			{ root: el.closest('.loom-map-subs-list'), rootMargin: '120px' }
		);
		io.observe(el);
		return () => {
			cancelled = true;
			io.disconnect();
		};
	}, [plugin, file, url]);
	if (!url) return <span className="loom-map-image-thumb" ref={ref} />;
	return <img className="loom-map-image-thumb" src={url} alt="" width={28} height={28} decoding="async" />;
}

/** Parses the persisted Maps file. Returns null when nothing usable is found. */
function parseMapsFile(text: string): MapsFile | null {
	try {
		const d = JSON.parse(text) as { maps?: unknown; activeId?: unknown };
		if (Array.isArray(d.maps)) {
			const maps: MapPage[] = (d.maps as Partial<MapPage>[]).map((m, i) => {
				const zones = parseZones(m.zones);
				return {
					id: typeof m.id === 'string' ? m.id : newId(),
					name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name : 'Map',
					parentId: typeof m.parentId === 'string' ? m.parentId : null,
					order: typeof m.order === 'number' ? m.order : i,
					zones,
					images: parseImages(m.images),
					// Pages written before element scale existed infer theirs from the
					// geometry they already hold.
					scale:
						typeof m.scale === 'number' && Number.isFinite(m.scale) && m.scale > 0
							? Math.max(SCALE_MIN, Math.min(SCALE_MAX, m.scale))
							: inferScale(zones),
				};
			});
			if (maps.length === 0) return { version: 2, activeId: null, maps: defaultPages() };
			return { version: 2, activeId: typeof d.activeId === 'string' ? d.activeId : null, maps };
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

/** Translate the moved zone by (dx,dy). If it's a location polygon, also drag the
 *  matching endpoint of every road attached to that location, so roads stay
 *  connected when their location is moved (a road stores its own endpoints, which
 *  otherwise stay frozen and detach). Roads are matched by location link target. */
function translateZoneWithRoads(list: MapZone[], movedId: string, dx: number, dy: number): MapZone[] {
	const moved = list.find((z) => z.id === movedId);
	if (!moved) return list;
	const shiftPt = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
	const shiftArr = <T extends { x: number; y: number }>(arr: T[]): T[] =>
		arr.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
	const movedLoc = moved.kind !== 'road' ? moved.location : null;
	const zoneIdForLoc = (lp: string | null | undefined): string | null =>
		lp ? list.find((z) => z.kind === 'zone' && z.location === lp)?.id ?? null : null;
	return list.map((z) => {
		if (z.id === movedId)
			return {
				...z,
				points: z.points.map(shiftPt),
				node: z.node ? shiftPt(z.node) : null,
				doors: shiftArr(z.doors),
				itemPins: shiftArr(z.itemPins),
				subPins: shiftArr(z.subPins),
			};
		if (movedLoc && z.kind === 'road' && z.points.length > 0) {
			const startHit = zoneIdForLoc(z.startLoc) === movedId;
			const endHit = zoneIdForLoc(z.endLoc) === movedId;
			if (startHit || endHit) {
				const pts = z.points.map((p) => ({ ...p }));
				if (startHit) pts[0] = shiftPt(pts[0]);
				if (endHit) pts[pts.length - 1] = shiftPt(pts[pts.length - 1]);
				// Keep the road's OWN location node on the reshaped centerline, so it
				// doesn't get left behind in world space when an end is dragged.
				const node = z.node ? clampToCapsule(z.node, pts, z.width / 2) : null;
				return { ...z, points: pts, node };
			}
		}
		return z;
	});
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

/** Image file extensions offered for a background. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

/** The intrinsic pixel size of an image URL (its "real scale" on the map). */
function naturalSize(url: string): Promise<{ w: number; h: number }> {
	return new Promise((resolve) => {
		const probe = new Image();
		// A backdrop that can't be decoded still gets a usable box to drag.
		probe.onerror = () => resolve({ w: 1000, h: 1000 });
		probe.onload = () => resolve({ w: probe.naturalWidth || 1000, h: probe.naturalHeight || 1000 });
		probe.src = url;
	});
}

/** Separator inside a region-hull cluster key (`<region path><SEP><cx>,<cy>`): a
 *  NUL, the one byte a vault path can never contain, so a path that happens to
 *  prefix another can't be mistaken for it. Written as an escape — a raw control
 *  byte in the source makes grep/rg treat this whole file as binary. */
const SEP = '\0';

/** One undo step: everything drawable on a map page. */
type MapState = { zones: MapZone[]; images: MapImage[] };

/** The eight resize grips of a background image, by compass position. */
type ImageHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const IMAGE_HANDLES: ImageHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Where a grip sits on an image's box. */
function imageHandlePos(im: MapImage, h: ImageHandle): { x: number; y: number } {
	const mx = im.x + im.w / 2;
	const my = im.y + im.h / 2;
	const right = im.x + im.w;
	const bottom = im.y + im.h;
	switch (h) {
		case 'nw':
			return { x: im.x, y: im.y };
		case 'n':
			return { x: mx, y: im.y };
		case 'ne':
			return { x: right, y: im.y };
		case 'e':
			return { x: right, y: my };
		case 'se':
			return { x: right, y: bottom };
		case 's':
			return { x: mx, y: bottom };
		case 'sw':
			return { x: im.x, y: bottom };
		case 'w':
			return { x: im.x, y: my };
	}
}

/** The two endpoints of one side of an image's box — the drag band that resizes
 *  from that edge. */
function imageSidePoints(im: MapImage, h: 'n' | 'e' | 's' | 'w'): [{ x: number; y: number }, { x: number; y: number }] {
	const right = im.x + im.w;
	const bottom = im.y + im.h;
	switch (h) {
		case 'n':
			return [{ x: im.x, y: im.y }, { x: right, y: im.y }];
		case 's':
			return [{ x: im.x, y: bottom }, { x: right, y: bottom }];
		case 'w':
			return [{ x: im.x, y: im.y }, { x: im.x, y: bottom }];
		case 'e':
			return [{ x: right, y: im.y }, { x: right, y: bottom }];
	}
}

/** Resize cursor for a grip, so the direction it pulls is obvious. */
const IMAGE_GRIP_CURSOR: Record<ImageHandle, string> = {
	nw: 'loom-map-grip-nwse',
	se: 'loom-map-grip-nwse',
	ne: 'loom-map-grip-nesw',
	sw: 'loom-map-grip-nesw',
	n: 'loom-map-grip-ns',
	s: 'loom-map-grip-ns',
	e: 'loom-map-grip-ew',
	w: 'loom-map-grip-ew',
};

/**
 * An image resized by dragging one grip to `p`. The aspect ratio is NEVER
 * changed — only the size: the width is derived from whichever axis the pointer
 * pulled furthest and the height follows the natural ratio. A corner grip anchors
 * the opposite corner; an edge grip anchors the opposite edge and grows centred on
 * the perpendicular axis.
 */
function resizeImage(orig: MapImage, handle: ImageHandle, p: { x: number; y: number }): MapImage {
	const ar = orig.w / orig.h || 1;
	const right = orig.x + orig.w;
	const bottom = orig.y + orig.h;
	const cx = orig.x + orig.w / 2;
	const cy = orig.y + orig.h / 2;
	let w: number;
	switch (handle) {
		case 'nw':
			w = Math.max(right - p.x, (bottom - p.y) * ar);
			break;
		case 'ne':
			w = Math.max(p.x - orig.x, (bottom - p.y) * ar);
			break;
		case 'se':
			w = Math.max(p.x - orig.x, (p.y - orig.y) * ar);
			break;
		case 'sw':
			w = Math.max(right - p.x, (p.y - orig.y) * ar);
			break;
		case 'e':
			w = p.x - orig.x;
			break;
		case 'w':
			w = right - p.x;
			break;
		case 'n':
			w = (bottom - p.y) * ar;
			break;
		case 's':
			w = (p.y - orig.y) * ar;
			break;
	}
	w = Math.max(IMAGE_MIN_W, w);
	const h = w / ar;
	switch (handle) {
		case 'nw':
			return { ...orig, x: right - w, y: bottom - h, w, h };
		case 'ne':
			return { ...orig, y: bottom - h, w, h };
		case 'se':
			return { ...orig, w, h };
		case 'sw':
			return { ...orig, x: right - w, w, h };
		case 'e':
			return { ...orig, y: cy - h / 2, w, h };
		case 'w':
			return { ...orig, x: right - w, y: cy - h / 2, w, h };
		case 'n':
			return { ...orig, x: cx - w / 2, y: bottom - h, w, h };
		case 's':
			return { ...orig, x: cx - w / 2, w, h };
	}
}

/** A freshly drawn zone/road's shared defaults — width scaled to the page's
 *  element scale, the map's own draw color, no location/pins yet. The three
 *  ways to create one (freeform polygon, road, rectangle) differ only in
 *  `kind`, `points`, and (a road only) `startLoc`/`endLoc`. */
function newZone(
	kind: 'zone' | 'road',
	points: { x: number; y: number }[],
	scale: number,
	color: string,
	extra?: Partial<Pick<MapZone, 'startLoc' | 'endLoc'>>
): MapZone {
	return {
		id: newId(),
		kind,
		points,
		width: DEFAULT_ROAD_WIDTH * scale,
		color,
		alpha: DEFAULT_ALPHA,
		location: null,
		node: null,
		nodeSize: 'regular',
		doors: [],
		itemPins: [],
		subPins: [],
		locked: false,
		...extra,
	};
}

/** Patch re-fitting everything a road carries — its own location node, doors,
 *  item pins and sublocation nodes — into a body of the given width, so
 *  narrowing the road pulls them along with it instead of leaving them outside. */
function reclampToWidth(zone: MapZone, width: number): Partial<MapZone> {
	if (zone.kind !== 'road') return {};
	const fit = (p: { x: number; y: number }) => clampToCapsule(p, zone.points, width / 2);
	return {
		node: zone.node ? fit(zone.node) : null,
		doors: zone.doors.map((d) => ({ ...d, ...fit(d) })),
		itemPins: zone.itemPins.map((p) => ({ ...p, ...fit(p) })),
		subPins: zone.subPins.map((p) => ({ ...p, ...fit(p) })),
	};
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

/** Mean of a ring's points. */
function ringCentroid(pts: Pt[]): Pt {
	let x = 0;
	let y = 0;
	for (const p of pts) {
		x += p.x;
		y += p.y;
	}
	const n = pts.length || 1;
	return { x: x / n, y: y / n };
}

/** Resample a closed polygon to exactly `n` points evenly spaced by perimeter, so
 *  two rings with different vertex counts can be morphed index-to-index. */
function resampleRing(poly: Pt[], n: number): Pt[] {
	const m = poly.length;
	if (m === 0) return [];
	if (m === 1) return Array.from({ length: n }, () => ({ ...poly[0] }));
	const seg: number[] = [];
	let total = 0;
	for (let i = 0; i < m; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % m];
		const d = Math.hypot(b.x - a.x, b.y - a.y);
		seg.push(d);
		total += d;
	}
	if (total === 0) return Array.from({ length: n }, () => ({ ...poly[0] }));
	const step = total / n;
	const out: Pt[] = [];
	for (let k = 0; k < n; k++) {
		let rem = k * step;
		let si = 0;
		while (si < m && rem > seg[si]) {
			rem -= seg[si];
			si++;
		}
		if (si >= m) si = m - 1;
		const a = poly[si];
		const b = poly[(si + 1) % m];
		const t = seg[si] > 0 ? rem / seg[si] : 0;
		out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
	}
	return out;
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
	/** Restores (or defaults to regular, centered) the camera for a map page. The
	 *  page's element scale sets what "regular" means in zoom terms. */
	const restoreCamera = useCallback(
		(pageId: string, pageScale: number) => {
			const saved = plugin.settings.mapCameras[cameraKey(pageId)];
			if (saved) {
				setCamera(saved);
				return;
			}
			const el = wrapRef.current;
			const w = el?.clientWidth ?? 900;
			const h = el?.clientHeight ?? 600;
			setCamera({ k: MODE_K.regular / pageScale, tx: w / 2, ty: h / 2 });
		},
		[plugin, cameraKey]
	);
	useEffect(() => () => window.cancelAnimationFrame(camRaf.current), []);

	// All map pages of the project. The ACTIVE page's zones live in `zones` (the
	// editing working copy); other pages keep their zones in this list. The panel
	// reads page metadata (name / parentId / order / scale) from here.
	const [pages, setPages] = useState<MapPage[]>([]);
	const pagesRef = useRef(pages);
	pagesRef.current = pages;
	const [activeId, setActiveId] = useState<string>('');
	activeIdRef.current = activeId;

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
	// The active page's element scale (see REF_ZONE_RADIUS): world px per size unit.
	// A ref too, because the wheel handler is installed once and can't close over it.
	const scale = pages.find((p) => p.id === activeId)?.scale ?? 1;
	const scaleRef = useRef(scale);
	scaleRef.current = scale;
	// View mode is derived from the camera zoom, so wheel-zoom flips it: close up
	// when zoomed in, node view when zoomed far out, regular between. The
	// thresholds divide by the element scale — a map drawn 10× bigger needs 10×
	// less zoom to read as the same view.
	const viewMode: ViewMode =
		camera.k >= CLOSEUP_K / scale ? 'closeup' : camera.k <= NODEVIEW_K / scale ? 'nodeview' : 'regular';
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
	/** Background image selected by clicking it — outlines it (and, unless locked,
	 *  shows its resize grips). */
	const [selectedImage, setSelectedImage] = useState<string | null>(null);
	// Background images of the active page, and the selected one. A LOCKED image
	// still outlines when clicked — that outline is the only hint that its edge is
	// where its context menu lives — it just has nothing to grab.
	const images = pages.find((p) => p.id === activeId)?.images ?? [];
	const selImage = images.find((im) => im.id === selectedImage) ?? null;
	/** The selected image when it can actually be edited (unlocked). */
	const selectedImageObj = selImage && !selImage.locked ? selImage : null;
	/** Zone id whose focus graph is open (a main-node click). */
	const [subGraph, setSubGraph] = useState<string | null>(null);
	const subGraphRef = useRef(subGraph);
	subGraphRef.current = subGraph;
	/** Zone id whose focus graph is playing its closing (reverse) animation, kept
	 *  mounted until the animation finishes. */
	const [focusClosing, setFocusClosing] = useState<string | null>(null);
	/** Last node click for a short manual double-click window (open the page) that
	 *  won't swallow a deliberate open-then-close of the focus graph. */
	const lastNodeClick = useRef<{ id: string; t: number }>({ id: '', t: 0 });
	// Start the closing animation, keeping the graph mounted via `focusClosing`.
	const closeFocus = () => {
		if (subGraphRef.current) setFocusClosing(subGraphRef.current);
		setSubGraph(null);
	};
	// The focus graph doesn't exist in node view — the whole map is a node graph
	// there, so a second one on top of it is just noise. Zooming out into node view
	// retracts an open one.
	useEffect(() => {
		if (viewMode !== 'nodeview' || !subGraphRef.current) return;
		setFocusClosing(subGraphRef.current);
		setSubGraph(null);
	}, [viewMode]);
	const [menu, setMenu] = useState<Menu>(null);
	/** Where the last menu was opened in world space (a new node lands here). */
	const menuWorld = useRef<{ x: number; y: number } | null>(null);
	/** Element-size popover (the page's scale anchor) open state. */
	const [sizeOpen, setSizeOpen] = useState(false);
	/** Hidden file picker for a background-image import, and the world point the
	 *  imported image should be centred on (the menu's open point). */
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pendingImageAt = useRef<{ x: number; y: number } | null>(null);
	/** The global menu's second page: the background-image list + its search. */
	const [imagePicker, setImagePicker] = useState(false);
	const [imageQuery, setImageQuery] = useState('');
	// Every fresh menu (a new right-click anywhere, or closing it) lands on the
	// root page with an empty search. Opening the image page only flips
	// `imagePicker` — no menu change — so it survives this.
	useEffect(() => {
		setImagePicker(false);
		setImageQuery('');
	}, [menu]);

	// --- Persistence (multi-map) ---------------------------------------------
	const mapsPath = useMemo(() => (project ? mapsFilePath(project) : null), [project]);

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

	useEffect(() => {
		if (!mapsPath || !project) return;
		let cancelled = false;
		void (async () => {
			let file: MapsFile | null = null;
			const existing = findMapsFile(plugin.app, project);
			if (existing) {
				try {
					file = parseMapsFile(await plugin.app.vault.cachedRead(existing));
				} catch {
					file = null;
				}
			}
			if (cancelled) return;
			const loaded = file ?? { version: 2, activeId: null, maps: defaultPages() };
			// Drop orphaned sublocation/item pins whose entity was deleted while the
			// map was closed (only when the index is populated, so a cold start can't
			// wrongly prune). Whole zones are never auto-removed here.
			const ready = plugin.indexer.getAll('location', project.root).length > 0;
			const pruneOrphans = (zs: MapZone[]): MapZone[] =>
				zs.map((z) => {
					const subPins = z.subPins.filter((sp) => !!plugin.indexer.resolve(sp.loc, project.loomPath));
					const itemPins = z.itemPins.filter((it) => !!plugin.indexer.resolve(it.item, project.loomPath));
					return subPins.length === z.subPins.length && itemPins.length === z.itemPins.length
						? z
						: { ...z, subPins, itemPins };
				});
			const maps = ready ? loaded.maps.map((m) => ({ ...m, zones: pruneOrphans(m.zones) })) : loaded.maps;
			const pruned = ready && maps.some((m, i) => m.zones !== loaded.maps[i].zones);
			const first = maps[0];
			const active = maps.find((m) => m.id === loaded.activeId)?.id ?? first.id;
			activeIdRef.current = active;
			setPages(maps);
			setActiveId(active);
			const activePage = maps.find((m) => m.id === active);
			const activeZones = activePage?.zones ?? [];
			setZones(activeZones);
			restoreCamera(active, activePage?.scale ?? 1);
			if (pruned) {
				pagesRef.current = maps;
				saveLater(activeZones);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [mapsPath, plugin, restoreCamera, project, saveLater]);

	// When an entity note is deleted, scrub its leftovers from every map page:
	// remove its sublocation/item pins and unassociate any zone/road that pointed
	// to it (the drawn shape stays; only the dangling link is cleared). Mirrors the
	// page-deletion cleanup so deleting a location can't leave an undeletable node.
	useEffect(() => {
		const scrub = (zs: MapZone[], name: string): MapZone[] => {
			let changed = false;
			const out = zs.map((z) => {
				let nz = z;
				const subPins = z.subPins.filter((sp) => sp.loc !== name);
				const itemPins = z.itemPins.filter((it) => it.item !== name);
				if (subPins.length !== z.subPins.length || itemPins.length !== z.itemPins.length)
					nz = { ...nz, subPins, itemPins };
				if (nz.location === name) nz = { ...nz, location: null };
				if (nz.kind === 'road') {
					if (nz.startLoc === name) nz = { ...nz, startLoc: null };
					if (nz.endLoc === name) nz = { ...nz, endLoc: null };
				}
				if (nz !== z) changed = true;
				return nz;
			});
			return changed ? out : zs;
		};
		const scrubDeleted = (name: string) => {
			// It came back (or never really left) — leave the maps alone.
			if (plugin.app.metadataCache.getFirstLinkpathDest(name, '') !== null) return;
			const prunedActive = scrub(zonesRef.current, name);
			const prunedPages = pagesRef.current.map((p) =>
				p.id === activeIdRef.current ? p : { ...p, zones: scrub(p.zones, name) }
			);
			const pagesChanged = prunedPages.some((p, i) => p.zones !== pagesRef.current[i].zones);
			if (prunedActive === zonesRef.current && !pagesChanged) return;
			if (pagesChanged) {
				pagesRef.current = prunedPages;
				setPages(prunedPages);
			}
			if (prunedActive !== zonesRef.current) setZones(prunedActive);
			saveLater(prunedActive);
		};
		// A sync client (Dropbox, iCloud, …) delivers a moved or re-created note as
		// a delete followed by a create, and drops files briefly while it settles.
		// Scrubbing on the delete alone would silently strip zone associations from
		// notes that are about to come straight back — and write the maps file to
		// sync that loss out to every machine. Confirm the note is really gone.
		const pending: number[] = [];
		const ref = plugin.app.vault.on('delete', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			const name = file.basename;
			pending.push(window.setTimeout(() => scrubDeleted(name), DELETE_SCRUB_MS));
		});
		return () => {
			plugin.app.vault.offref(ref);
			pending.forEach((t) => window.clearTimeout(t));
		};
	}, [plugin, saveLater]);

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

	// --- Background images (live in `pages`, no separate state) ----------------
	/** The active page's background images. */
	const activeImages = useCallback(
		(): MapImage[] => pagesRef.current.find((p) => p.id === activeIdRef.current)?.images ?? [],
		[]
	);
	/** Replaces the active page's images. `save` false = a live drag frame, which
	 *  updates the view without queueing a write (the drop saves once). */
	const putImages = useCallback(
		(next: MapImage[], save = true) => {
			const pages2 = pagesRef.current.map((p) =>
				p.id === activeIdRef.current ? { ...p, images: next } : p
			);
			pagesRef.current = pages2;
			setPages(pages2);
			if (save) saveLater(zonesRef.current);
		},
		[saveLater]
	);
	const patchImage = useCallback(
		(id: string, patch: Partial<MapImage>, save = true) => {
			putImages(
				activeImages().map((im) => (im.id === id ? { ...im, ...patch } : im)),
				save
			);
		},
		[activeImages, putImages]
	);

	// --- Undo / redo (map-local, Ctrl+Z / Ctrl+Shift+Z) ----------------------
	// One step covers the whole drawable state of the page — zones AND background
	// images — so undoing an image resize doesn't silently roll back a zone edit.
	const cloneState = useCallback(
		(): MapState => ({
			zones: zonesRef.current.map((z) => ({
				...z,
				points: z.points.map((p) => ({ ...p })),
				node: z.node ? { ...z.node } : null,
			})),
			images: activeImages().map((im) => ({ ...im })),
		}),
		[activeImages]
	);
	const history = useRef<{ undo: MapState[]; redo: MapState[] }>({ undo: [], redo: [] });
	const pendingSnap = useRef<MapState | null>(null);
	const HISTORY_CAP = 200;
	/** Records the current state as an undo step (call BEFORE a discrete change). */
	const snapshot = useCallback(() => {
		history.current.undo.push(cloneState());
		if (history.current.undo.length > HISTORY_CAP) history.current.undo.shift();
		history.current.redo = [];
	}, [cloneState]);
	/** Begins a coalesced gesture (drag / slider): captures the pre-change state
	 *  once; committed at pointerup only if something actually changed. */
	const beginPending = useCallback(() => {
		if (!pendingSnap.current) pendingSnap.current = cloneState();
	}, [cloneState]);
	const commitPending = useCallback(() => {
		const prev = pendingSnap.current;
		pendingSnap.current = null;
		if (!prev) return;
		if (JSON.stringify(prev) === JSON.stringify(cloneState())) return;
		history.current.undo.push(prev);
		if (history.current.undo.length > HISTORY_CAP) history.current.undo.shift();
		history.current.redo = [];
	}, [cloneState]);
	const restoreState = useCallback(
		(s: MapState) => {
			setMenu(null);
			setZones(s.zones);
			putImages(s.images, false);
			saveLater(s.zones);
		},
		[putImages, saveLater]
	);
	const undo = useCallback(() => {
		const h = history.current;
		if (h.undo.length === 0) return;
		h.redo.push(cloneState());
		restoreState(h.undo.pop() as MapState);
	}, [cloneState, restoreState]);
	const redo = useCallback(() => {
		const h = history.current;
		if (h.redo.length === 0) return;
		h.undo.push(cloneState());
		restoreState(h.redo.pop() as MapState);
	}, [cloneState, restoreState]);
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
			restoreCamera(id, target.scale);
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
			// A new page inherits the current one's element scale, so drawing across
			// pages of one world stays consistent.
			const page: MapPage = {
				id: newId(),
				name: '',
				parentId,
				order,
				zones: [],
				images: [],
				scale: pagesRef.current.find((p) => p.id === activeIdRef.current)?.scale ?? 1,
			};
			// A brand-new page has no saved camera → activatePage restores regular.
			activatePage([...foldActiveZones(), page], page.id);
		},
		[activatePage, foldActiveZones]
	);
	/** Sets the active page's element scale (world px per size unit). Markers and
	 *  the view-mode thresholds follow it immediately — no zone geometry changes. */
	const setPageScale = useCallback(
		(next: number) => {
			const s = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
			commitPages(pagesRef.current.map((p) => (p.id === activeIdRef.current ? { ...p, scale: s } : p)));
		},
		[commitPages]
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
				// Zoom limits are per-map too: a big-scale map needs to zoom further out.
				const s = scaleRef.current;
				const k = Math.max(MIN_ZOOM / s, Math.min(MAX_ZOOM / s, c.k * Math.exp(-e.deltaY * 0.0015)));
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
		| { kind: 'image-move'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
		/** Resizing a background image: `orig` is its box at gesture start, so the
		 *  aspect-preserving maths always works off a clean baseline. */
		| { kind: 'image-resize'; handle: ImageHandle; orig: MapImage }
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
				setZones(translateZoneWithRoads(zonesRef.current, d.id, dx, dy));
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
					setZones(translateZoneWithRoads(zonesRef.current, d.id, dx, dy));
					setMenu((m) => (m && m.kind === 'zone' && m.id === d.id ? { ...m, wx: m.wx + dx, wy: m.wy + dy } : m));
				} else {
					const clamped = clampToZone(w, z);
					setZones(zonesRef.current.map((zz) => (zz.id === d.id ? { ...zz, node: clamped } : zz)));
				}
			} else if (d.kind === 'image-move') {
				if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_SLOP) return;
				d.moved = true;
				const dx = w.x - d.last.x;
				const dy = w.y - d.last.y;
				d.last = { x: w.x, y: w.y };
				putImages(
					activeImages().map((im) => (im.id === d.id ? { ...im, x: im.x + dx, y: im.y + dy } : im)),
					false
				);
			} else if (d.kind === 'image-resize') {
				const next = resizeImage(d.orig, d.handle, w);
				putImages(
					activeImages().map((im) => (im.id === d.orig.id ? next : im)),
					false
				);
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
			// A node press without movement is a CLICK. A fast second click on the
			// same node (short window) opens its page; otherwise it toggles the focus
			// graph — so a normal open-then-close pair isn't swallowed as a dblclick.
			// Node view has no focus graph at all (the map is already a node graph
			// there), so a click there only selects.
			if (d.kind === 'node' && !d.moved) {
				const z = zonesRef.current.find((zz) => zz.id === d.id);
				const now = performance.now();
				const isDbl = lastNodeClick.current.id === d.id && now - lastNodeClick.current.t < NODE_DBL_MS;
				lastNodeClick.current = { id: d.id, t: now };
				if (isDbl) {
					setSubGraph(null);
					setFocusClosing(null);
					if (z?.location) openLocation(z.location);
					return;
				}
				setSelectedNode((cur) => (cur === d.id ? null : d.id));
				if (viewModeRef.current === 'nodeview') return;
				if (subGraphRef.current === d.id) closeFocus();
				else {
					setFocusClosing(null);
					setSubGraph(z && z.location ? d.id : null);
				}
				return;
			}
			// Image gestures live in `pages`, so they save the maps file rather than
			// the zones list (which `saveLater` writes alongside it anyway).
			if (d.kind === 'image-resize' || (d.kind === 'image-move' && d.moved)) {
				saveLater(zonesRef.current);
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
	}, [dragActive, localXY, toWorld, saveLater, activeImages, putImages]);

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
			setSelectedImage(null);
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
		// A background image, checked only after the zones above it: an unlocked one
		// selects (showing its grips) and left-drags to move. A LOCKED one is pure
		// backdrop — it doesn't even select, and the press falls through to the pan
		// below, exactly like a locked zone.
		const img = hitImage(sx, sy);
		// Clicking ANY image outlines it (a locked one included — that outline is
		// what tells you its edge is where the menu lives); only an unlocked one
		// starts a move, a locked one falls through to the camera pan below.
		setSelectedImage(img ? img.id : null);
		if (img && !img.locked && e.button === 0) {
			beginPending();
			drag.current = {
				kind: 'image-move',
				id: img.id,
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
				last: w,
			};
			setDragActive(true);
			return;
		}
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
		// A locked background image only answers on its border, so mark that band
		// too — otherwise there's nothing telling you where to right-click.
		if (!overEdge) overEdge = hitImage(sx, sy, 'menu') !== null;
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
			return;
		}
		setSelectedZone(null);
		// A background image under the cursor gets its own menu — but a LOCKED one
		// only from its edge, so its interior stays usable as empty canvas.
		const img = hitImage(sx, sy, 'menu');
		if (img) {
			setSelectedImage(img.id);
			openImageMenu(e, img);
			return;
		}
		setMenu({ kind: 'empty', sx, sy });
	};

	// --- Background image import ---------------------------------------------
	/** `<root>/Entities/Maps/Images` — where imported backdrops are copied. */
	const imagesFolder = useMemo(() => (project ? mapsImagesPath(project) : null), [project]);
	/** Image files already in that folder (placeable without re-importing). */
	const importedImages = useMemo(() => {
		if (!imagesFolder) return [] as TFile[];
		const folder = plugin.app.vault.getAbstractFileByPath(imagesFolder);
		if (!(folder instanceof TFolder)) return [] as TFile[];
		return folder.children
			.filter((f): f is TFile => f instanceof TFile && IMAGE_EXTS.has(f.extension.toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name));
		// `pages` isn't a real dependency, but re-reading the folder after an import
		// (which re-renders through it) is exactly when the list needs refreshing.
	}, [plugin, imagesFolder, pages]);
	/** Places an image file on the map, centred on `at`, at its real pixel size. */
	const placeImage = async (file: TFile, at: { x: number; y: number }) => {
		const natural = await naturalSize(plugin.app.vault.getResourcePath(file));
		snapshot();
		const w = natural.w;
		const h = natural.h;
		putImages([
			...activeImages(),
			{
				id: newId(),
				path: file.path,
				x: at.x - w / 2,
				y: at.y - h / 2,
				w,
				h,
				nw: w,
				nh: h,
				locked: false,
				opacity: 1,
			},
		]);
		setSelectedImage(null);
	};
	/** Copies a picked file into `Maps/Images` (de-duplicating the name) and places it. */
	const importImageFile = async (file: File, at: { x: number; y: number }) => {
		if (!imagesFolder) return;
		try {
			if (!plugin.app.vault.getAbstractFileByPath(imagesFolder)) {
				await plugin.app.vault.createFolder(imagesFolder);
			}
		} catch {
			/* raced / already exists */
		}
		const dot = file.name.lastIndexOf('.');
		const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
		const ext = dot > 0 ? file.name.slice(dot) : '';
		// Never overwrite an existing file — a same-named different image would
		// silently swap out every map already using it.
		let path = normalizePath(`${imagesFolder}/${stem}${ext}`);
		for (let n = 2; plugin.app.vault.getAbstractFileByPath(path); n++) {
			path = normalizePath(`${imagesFolder}/${stem} ${n}${ext}`);
		}
		const created = await plugin.app.vault.createBinary(path, await file.arrayBuffer());
		await placeImage(created, at);
		new Notice(`Imported ${created.name} at its real pixel size.`);
	};

	/** Begins an aspect-locked resize from one grip (or edge band) of an image. */
	const startImageResize = (e: ReactPointerEvent<SVGElement>, handle: ImageHandle, im: MapImage) => {
		if (tool !== 'select' || e.button !== 0) return;
		e.stopPropagation();
		beginPending();
		drag.current = { kind: 'image-resize', handle, orig: im };
		setDragActive(true);
	};

	/** Right-click menu of a background image. */
	const openImageMenu = (e: ReactMouseEvent, im: MapImage) => {
		const m = new ObsidianMenu();
		m.addItem((i) =>
			i
				.setTitle(im.locked ? 'Unlock' : 'Lock in place')
				.setIcon(im.locked ? 'lock-open' : 'lock')
				.onClick(() => {
					snapshot();
					if (!im.locked) setSelectedImage(null);
					patchImage(im.id, { locked: !im.locked });
				})
		);
		m.addItem((i) =>
			i
				.setTitle('Reset to real size')
				.setIcon('scan')
				.onClick(() => {
					snapshot();
					patchImage(im.id, { w: im.nw, h: im.nh });
				})
		);
		m.addSeparator();
		for (const pct of [100, 75, 50, 25]) {
			m.addItem((i) =>
				i
					.setTitle(`Opacity ${pct}%`)
					.setChecked(Math.round(im.opacity * 100) === pct)
					.onClick(() => {
						snapshot();
						patchImage(im.id, { opacity: pct / 100 });
					})
			);
		}
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle('Bring to front')
				.setIcon('arrow-up')
				.onClick(() => {
					snapshot();
					putImages([...activeImages().filter((o) => o.id !== im.id), im]);
				})
		);
		m.addItem((i) =>
			i
				.setTitle('Send to back')
				.setIcon('arrow-down')
				.onClick(() => {
					snapshot();
					putImages([im, ...activeImages().filter((o) => o.id !== im.id)]);
				})
		);
		m.addSeparator();
		// Only the placement goes — the file stays in Maps/Images (other pages, and
		// a re-place, may still want it).
		m.addItem((i) =>
			i
				.setTitle('Remove from map')
				.setIcon('trash-2')
				.onClick(() => {
					snapshot();
					setSelectedImage(null);
					putImages(activeImages().filter((o) => o.id !== im.id));
				})
		);
		m.showAtPosition({ x: e.clientX, y: e.clientY });
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

	/**
	 * Topmost background image under a screen point, or null.
	 *
	 * `mode: 'menu'` applies the locked rule: a locked image is a backdrop, so only
	 * its EDGE answers (its interior counts as empty space — right-click there gives
	 * the global menu and a drag pans the camera). Unlocked images answer anywhere.
	 */
	const hitImage = (sx: number, sy: number, mode: 'any' | 'menu' = 'any'): MapImage | null => {
		const w = toWorld(sx, sy);
		const band = IMAGE_EDGE_PX / cameraRef.current.k;
		const list = activeImages();
		for (let i = list.length - 1; i >= 0; i--) {
			const im = list[i];
			if (w.x < im.x || w.x > im.x + im.w || w.y < im.y || w.y > im.y + im.h) continue;
			if (mode === 'menu' && im.locked) {
				const onEdge =
					w.x - im.x <= band ||
					im.x + im.w - w.x <= band ||
					w.y - im.y <= band ||
					im.y + im.h - w.y <= band;
				if (!onEdge) continue;
			}
			return im;
		}
		return null;
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
		const zone = newZone(
			'zone',
			draft.map((p) => ({ ...p })),
			scale,
			plugin.settings.mapsColor
		);
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
		const road = newZone(
			'road',
			waypoints.map((p) => ({ ...p })),
			scale,
			plugin.settings.mapsColor,
			{ startLoc, endLoc }
		);
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
		const zone = newZone(
			'zone',
			[
				{ x: x0, y: y0 },
				{ x: x1, y: y0 },
				{ x: x1, y: y1 },
				{ x: x0, y: y1 },
			],
			scale,
			plugin.settings.mapsColor
		);
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
			if ((e.key === 'Delete' || e.key === 'Backspace') && draft.length === 0 && !roadDraft) {
				if (selectedZone) {
					deleteZone(selectedZone);
					return;
				}
				if (selectedImageObj) {
					snapshot();
					setSelectedImage(null);
					putImages(activeImages().filter((im) => im.id !== selectedImageObj.id));
					return;
				}
			}
			if (e.key !== 'Escape') return;
			if (roadDraft || draft.length > 0) cancelDraft();
			else if (subGraph) closeFocus();
			else if (menu) setMenu(null);
			else if (selectedVertsRef.current.size > 0) setSelectedVerts(new Set());
			else if (selectedNode) setSelectedNode(null);
			else if (selectedZone) setSelectedZone(null);
			else if (selectedImage) setSelectedImage(null);
			else if (tool !== 'select') setTool('select');
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [
		draft.length,
		menu,
		selectedZone,
		selectedNode,
		selectedImage,
		selectedImageObj,
		subGraph,
		tool,
		roadDraft,
		activeImages,
		putImages,
		snapshot,
	]);

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

	// --- Region hull morph ---------------------------------------------------
	// The raw hull recomputes from live positions every frame, so a cluster split
	// (a location dragged far enough to break off) makes the border snap. We keep a
	// per-cluster DISPLAY ring that eases toward the freshly computed target ring;
	// on a split the surviving cluster's border retracts smoothly while a new border
	// grows out of the split-off location's centroid ("rip out + hug back").
	const HULL_N = 48;
	const hullState = useRef<Map<string, { display: Pt[]; region: EntityRecord; alpha: number }>>(new Map());
	const hullTargets = useRef<Map<string, { ring: Pt[]; centroid: Pt; region: EntityRecord }>>(new Map());
	// Recompute targets + match this frame's clusters to existing display rings by
	// nearest centroid (so a moving cluster keeps its key and morphs rather than
	// snapping). New clusters grow from their centroid when the region already had
	// clusters (a split); a region seen for the first time appears at final shape.
	useMemo(() => {
		const perRegion = new Map<string, { region: EntityRecord; centroid: Pt; ring: Pt[]; weight: number }[]>();
		for (const { region, vertices } of regionClusters) {
			const uh = convexHull(vertices);
			const base = uh.length >= 3 ? uh : regionHull(vertices, NODE_SIZE_PRESETS.regular);
			if (base.length < 3) continue;
			const ring = resampleRing(base, HULL_N);
			const list = perRegion.get(region.path) ?? [];
			list.push({ region, centroid: ringCentroid(ring), ring, weight: vertices.length });
			perRegion.set(region.path, list);
		}
		const targets = new Map<string, { ring: Pt[]; centroid: Pt; region: EntityRecord }>();
		const st = hullState.current;
		for (const [regionPath, clustersRaw] of perRegion) {
			const prevKeys = [...st.keys()].filter((k) => k.startsWith(regionPath + SEP));
			const hadPrev = prevKeys.length > 0;
			const used = new Set<string>();
			// Biggest cluster claims its nearest prior key first, so on a split the
			// surviving cluster keeps the border and the split-off piece grows a new one.
			const clusters = clustersRaw.slice().sort((a, b) => b.weight - a.weight);
			for (const cl of clusters) {
				let best: string | null = null;
				let bestD = Infinity;
				for (const pk of prevKeys) {
					if (used.has(pk)) continue;
					const pc = ringCentroid(st.get(pk)!.display);
					const d = Math.hypot(pc.x - cl.centroid.x, pc.y - cl.centroid.y);
					if (d < bestD) {
						bestD = d;
						best = pk;
					}
				}
				let key: string;
				if (best) {
					key = best;
					used.add(best);
					st.get(key)!.region = cl.region;
				} else {
					key = `${regionPath}${SEP}${Math.round(cl.centroid.x)},${Math.round(cl.centroid.y)}`;
					if (!st.has(key))
						st.set(key, {
							display: hadPrev ? cl.ring.map(() => ({ ...cl.centroid })) : cl.ring.map((p) => ({ ...p })),
							region: cl.region,
							alpha: hadPrev ? 0 : 1,
						});
				}
				targets.set(key, cl);
			}
		}
		hullTargets.current = targets;
		return targets;
	}, [regionClusters]);
	// Ease display rings toward their targets each frame while in node view; drop
	// vanished clusters after they shrink into their centroid.
	useEffect(() => {
		if (viewMode !== 'nodeview') return;
		let raf = 0;
		const step = () => {
			const st = hullState.current;
			const targets = hullTargets.current;
			let changed = false;
			for (const [key, s] of st) {
				const tgt = targets.get(key);
				if (tgt) {
					if (s.alpha < 0.999) {
						s.alpha += (1 - s.alpha) * 0.3;
						changed = true;
					}
					for (let i = 0; i < s.display.length && i < tgt.ring.length; i++) {
						const dx = tgt.ring[i].x - s.display[i].x;
						const dy = tgt.ring[i].y - s.display[i].y;
						if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
							s.display[i] = { x: s.display[i].x + dx * 0.22, y: s.display[i].y + dy * 0.22 };
							changed = true;
						}
					}
				} else {
					// Vanished cluster (merged/removed): fade out while collapsing toward
					// its centroid, then drop — so it shrinks away behind the node instead
					// of leaving a padded circle.
					const c = ringCentroid(s.display);
					s.alpha += (0 - s.alpha) * 0.2;
					for (let i = 0; i < s.display.length; i++) {
						const dx = c.x - s.display[i].x;
						const dy = c.y - s.display[i].y;
						s.display[i] = { x: s.display[i].x + dx * 0.3, y: s.display[i].y + dy * 0.3 };
					}
					changed = true;
					if (s.alpha < 0.03) st.delete(key);
				}
			}
			if (changed) forceTick((x) => x + 1);
			raf = window.requestAnimationFrame(step);
		};
		raf = window.requestAnimationFrame(step);
		return () => window.cancelAnimationFrame(raf);
	}, [viewMode]);

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
		const off = 18 * zone.doors.length * scale;
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
		const off = 18 * zone.itemPins.length * scale;
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
	/** Item pin radius in size units — the zone's node size one level down (like a
	 *  first-level sublocation), unless that pin carries its own `size`. */
	const itemPinRadius = (zone: MapZone, size?: NodeSizePreset): number =>
		size
			? NODE_SIZE_PRESETS[size]
			: Math.max(MIN_SUB_NODE_SIZE, NODE_SIZE_PRESETS[zone.nodeSize] * SUB_NODE_SCALE);
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
		const off = 18 * zone.subPins.length * scale;
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
	/** Right-click menu for ONE marker inside a zone — node size is per node here,
	 *  not per zone: a pin's own `size` overrides the zone-derived default, and
	 *  "Default size" drops back to it. Also opens or removes that marker. */
	const openPinMenu = (
		e: ReactMouseEvent,
		zone: MapZone,
		kind: 'sub' | 'item',
		index: number
	) => {
		const pin = kind === 'sub' ? zone.subPins[index] : zone.itemPins[index];
		if (!pin) return;
		const target = kind === 'sub' ? zone.subPins[index].loc : zone.itemPins[index].item;
		const patch = (size: NodeSizePreset | undefined) => {
			snapshot();
			if (kind === 'sub') {
				updateZone(zone.id, {
					subPins: zone.subPins.map((sp, i) => (i === index ? { ...sp, size } : sp)),
				});
			} else {
				updateZone(zone.id, {
					itemPins: zone.itemPins.map((it, i) => (i === index ? { ...it, size } : it)),
				});
			}
		};
		const m = new ObsidianMenu();
		for (const [preset, label] of SIZE_OPTIONS) {
			m.addItem((i) =>
				i
					.setTitle(`Size ${label}`)
					.setChecked(pin.size === preset)
					.onClick(() => patch(preset))
			);
		}
		if (pin.size) m.addItem((i) => i.setTitle('Default size').setIcon('rotate-ccw').onClick(() => patch(undefined)));
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle(kind === 'sub' ? 'Open sublocation' : 'Open item')
				.setIcon('square-arrow-out-up-right')
				.onClick(() => (kind === 'sub' ? openSubloc(target) : openItem(target)))
		);
		m.addItem((i) =>
			i
				.setTitle('Remove from map')
				.setIcon('trash-2')
				.onClick(() => {
					snapshot();
					if (kind === 'sub') updateZone(zone.id, { subPins: zone.subPins.filter((_, j) => j !== index) });
					else updateZone(zone.id, { itemPins: zone.itemPins.filter((_, j) => j !== index) });
				})
		);
		m.showAtPosition({ x: e.clientX, y: e.clientY });
	};
	/** A sublocation node's radius in size units: smaller each nesting level below
	 *  the zone's location, floored at `MIN_SUB_NODE_SIZE` — unless that node
	 *  carries its own `size`, which wins outright (per-node sizing). */
	const subPinRadius = (zone: MapZone, locTarget: string, size?: NodeSizePreset): number => {
		if (size) return NODE_SIZE_PRESETS[size];
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
	/** Eases the camera from wherever it is to a target world point, keeping the
	 *  zoom — the search result glides into view instead of snapping, so the move
	 *  keeps the map's geography readable. */
	const flyTo = (wx: number, wy: number, dur = 420) => {
		const el = wrapRef.current;
		const w = el?.clientWidth ?? 900;
		const h = el?.clientHeight ?? 600;
		const from = cameraRef.current;
		const to = { k: from.k, tx: w / 2 - wx * from.k, ty: h / 2 - wy * from.k };
		if (Math.hypot(to.tx - from.tx, to.ty - from.ty) < 2) return;
		const start = performance.now();
		window.cancelAnimationFrame(camRaf.current);
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / dur);
			// Ease in-out: leaves and arrives calmly, travels fast in between.
			const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			setCamera({
				k: from.k,
				tx: from.tx + (to.tx - from.tx) * e,
				ty: from.ty + (to.ty - from.ty) * e,
			});
			if (t < 1) camRaf.current = window.requestAnimationFrame(step);
		};
		camRaf.current = window.requestAnimationFrame(step);
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
	// Node/pin/label sizing blends world-fixed (regular/close-up) → screen-space
	// (node view). At squish 0 a marker takes a fixed WORLD size — the page's
	// element scale, so it stays proportional to the drawn zones and scales with the
	// map; at squish 1 it is preset / camera.k, the constant on-screen size node
	// view has always used. In between it crossfades, which is what makes markers
	// shrink back to the map's own scale as you zoom in.
	const nodeUnit = (1 - squish) * scale + squish / camera.k;

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
						{/* Background images — the bottom layer, under every zone, road and
						    marker, so everything is drawn ON them. Click-through: presses are
						    resolved by the svg's own handlers (zones first, then images), so a
						    backdrop never steals a zone's click. */}
						{images.map((im) => {
							const file = plugin.app.vault.getFileByPath(im.path);
							if (!file) return null;
							return (
								<image
									key={im.id}
									className="loom-map-image"
									href={plugin.app.vault.getResourcePath(file)}
									x={im.x}
									y={im.y}
									width={im.w}
									height={im.h}
									opacity={im.opacity}
									// w/h always hold the natural ratio, so the box is exact.
									preserveAspectRatio="none"
								/>
							);
						})}
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
							{/* Selected image's outline + resize grips — same top layer as the
							    vertex handles, because a backdrop's grips would otherwise sit
							    under the zones drawn on top of it. */}
							{selImage ? (
								<g
									className={
										selImage.locked ? 'loom-map-image-sel loom-map-image-sel-locked' : 'loom-map-image-sel'
									}
								>
									{/* Screen-sized dash: BOTH the width and the dash pattern are divided
									    by the zoom, so the outline reads identically at any scale (and the
									    CSS must not also apply a non-scaling stroke). */}
									<rect
										className="loom-map-image-box"
										x={selImage.x}
										y={selImage.y}
										width={selImage.w}
										height={selImage.h}
										strokeWidth={1.5 / camera.k}
										strokeDasharray={`${8 / camera.k} ${5 / camera.k}`}
									/>
									{/* A locked image is backdrop only: outline (so its edge — the one place
									    its menu answers — is visible), but nothing to grab. */}
									{selImage.locked
										? null
										: (['n', 'e', 's', 'w'] as const).map((h) => {
												const [p1, p2] = imageSidePoints(selImage, h);
												// A wide invisible band along the whole side, so resizing works
												// by grabbing the EDGE — not only the square at its midpoint.
												return (
													<line
														key={`band-${h}`}
														className={`loom-map-image-band ${IMAGE_GRIP_CURSOR[h]}`}
														x1={p1.x}
														y1={p1.y}
														x2={p2.x}
														y2={p2.y}
														strokeWidth={(2 * IMAGE_GRIP_PX) / camera.k}
														onPointerDown={(e) => startImageResize(e, h, selImage)}
													/>
												);
											})}
									{selImage.locked
										? null
										: IMAGE_HANDLES.map((h) => {
												const p = imageHandlePos(selImage, h);
												const s = IMAGE_GRIP_PX / camera.k;
												return (
													<rect
														key={h}
														className={`loom-map-vertex ${IMAGE_GRIP_CURSOR[h]}`}
														x={p.x - s}
														y={p.y - s}
														width={s * 2}
														height={s * 2}
														onPointerDown={(e) => startImageResize(e, h, selImage)}
													/>
												);
											})}
								</g>
							) : null}
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
												strokeWidth={DEFAULT_ROAD_WIDTH * scale}
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
						{/* Region wraps — node view only: a padded hull around each cluster of
						    a region's location nodes (far-apart members wrap separately).
						    Drawn from the eased DISPLAY ring (see the hull-morph loop) so a
						    cluster split retracts/grows smoothly instead of snapping. Behind
						    the nodes; fades in with the squish. */}
						{squish > 0.02
							? [...hullState.current.entries()].map(([key, s]) => {
									if (s.display.length < 3 || s.alpha < 0.02) return null;
									// A modest constant-screen margin, applied to the eased ring;
									// it shrinks with alpha so a vanishing cluster doesn't leave a
									// fixed circle as it collapses.
									const pad = (40 / camera.k) * s.alpha;
									const c = ringCentroid(s.display);
									const padded = s.display.map((p) => {
										const dx = p.x - c.x;
										const dy = p.y - c.y;
										const len = Math.hypot(dx, dy) || 1;
										return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
									});
									const d = padded.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
									const minY = Math.min(...padded.map((p) => p.y));
									const fill = plugin.settings.nodeColors.region;
									const region = s.region;
									return (
										<g
											key={key}
											className="loom-map-region"
											opacity={squish * s.alpha}
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
							const r = NODE_SIZE_PRESETS[z.nodeSize] * nodeUnit * grow;
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
										// Opening is handled by a short manual double-click in onUp;
										// just keep the dblclick off the canvas (no vertex insert).
										e.stopPropagation();
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
											y={node.y + (NODE_SIZE_PRESETS[z.nodeSize] + 14) * nodeUnit}
											textAnchor="middle"
											className="loom-map-node-label"
											style={{ fontSize: `${13 * nodeUnit}px` }}
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
									<circle cx={dr.x} cy={dr.y} r={doorR * nodeUnit} className="loom-map-door-dot" />
									{/* Lucide door-open icon, scaled with the door (24-unit icon). */}
									<g
										className="loom-map-door-glyph"
										transform={`translate(${dr.x},${dr.y}) scale(${(doorR * 1.25) * nodeUnit / 24}) translate(-12,-12)`}
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
										y={dr.y + (doorR + 12) * nodeUnit}
										textAnchor="middle"
										className="loom-map-node-label"
										style={{ fontSize: `${13 * nodeUnit}px` }}
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
										return z.itemPins.map((it, i) => {
											const itemR = itemPinRadius(z, it.size);
											return (
												<g
													key={`itempin-${z.id}-${i}`}
													className="loom-map-door"
													transform={pinSquish}
													opacity={squish > 0.001 ? ds : undefined}
													onPointerDown={(e) => {
														if (tool !== 'select') return;
														if (e.button !== 0) return;
														e.stopPropagation();
														setSelectedZone(z.id);
														beginPending();
														drag.current = {
															kind: 'itempin',
															id: z.id,
															index: i,
															startX: e.clientX,
															startY: e.clientY,
															moved: false,
														};
														setDragActive(true);
													}}
													onContextMenu={(e) => {
														e.preventDefault();
														e.stopPropagation();
														openPinMenu(e, z, 'item', i);
													}}
													onDoubleClick={(e) => {
														e.stopPropagation();
														openItem(it.item);
													}}
												>
													<circle
														cx={it.x}
														cy={it.y}
														r={itemR * nodeUnit}
														fill={itemColor}
														className="loom-map-node-dot"
													/>
													<g
														className="loom-map-item-glyph"
														transform={`translate(${it.x},${it.y}) scale(${(itemR * 1.1 * nodeUnit) / 24}) translate(-12,-12)`}
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
														y={it.y + (itemR + 12) * nodeUnit}
														textAnchor="middle"
														className="loom-map-node-label"
														style={{ fontSize: `${11 * nodeUnit}px` }}
													>
														{clampLabel(itemName(it.item))}
													</text>
												</g>
											);
										});
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
										return z.subPins.map((sp, i) => {
											const spR = subPinRadius(z, sp.loc, sp.size);
											return (
												<g
													key={`subpin-${z.id}-${i}`}
													className="loom-map-node"
													transform={spSquish}
													opacity={squish > 0.001 ? ds : undefined}
													onPointerDown={(e) => {
														if (tool !== 'select') return;
														if (e.button !== 0) return;
														e.stopPropagation();
														setSelectedZone(z.id);
														beginPending();
														drag.current = {
															kind: 'subpin',
															id: z.id,
															index: i,
															startX: e.clientX,
															startY: e.clientY,
															moved: false,
														};
														setDragActive(true);
													}}
													onContextMenu={(e) => {
														e.preventDefault();
														e.stopPropagation();
														openPinMenu(e, z, 'sub', i);
													}}
													onDoubleClick={(e) => {
														e.stopPropagation();
														openSubloc(sp.loc);
													}}
												>
													<circle
														cx={sp.x}
														cy={sp.y}
														r={spR * nodeUnit}
														fill={col}
														className="loom-map-node-dot"
													/>
													<text
														x={sp.x}
														y={sp.y + (spR + 9) * nodeUnit}
														textAnchor="middle"
														className="loom-map-node-label"
														style={{ fontSize: `${11 * nodeUnit}px` }}
													>
														{clampLabel(sublocName(sp.loc))}
													</text>
												</g>
											);
										});
									})}
							{/* Ghost preview while dragging a sublocation/item from the menu. */}
							{pinDrag && pinDragPos
								? (() => {
									const gz = zones.find((z) => z.id === pinDrag.zoneId);
									const gr =
										(gz
											? pinDrag.kind === 'sub'
												? subPinRadius(gz, pinDrag.target, gz.subPins.find((s) => s.loc === pinDrag.target)?.size)
												: itemPinRadius(gz, gz.itemPins.find((p) => p.item === pinDrag.target)?.size)
											: 9) * nodeUnit;
									return <circle cx={pinDragPos.x} cy={pinDragPos.y} r={gr} className="loom-map-sub-ghost" />;
								})()
								: null}
					</g>
					{/* Focus graph — the clicked location's connected entities in a
					    maps-specific per-type hierarchy, growing out of the node like a
					    web. In WORLD space (its own <g> under the same camera transform,
					    full opacity) so it pans/zooms with the map while the map camera
					    <g> above stays dimmed. Click the focus node again (or Esc) to
					    hide; double-click a connected node to open it. */}
					{(() => {
						// Stay mounted through the closing animation via `focusClosing`.
						const activeId = subGraph ?? focusClosing;
						const fgZone = activeId ? zones.find((z) => z.id === activeId) : null;
						const fgLoc = fgZone?.location
							? plugin.indexer.resolve(fgZone.location, project.loomPath)
							: null;
						if (!fgZone || !fgLoc) return null;
						const nodeWorld = fgZone.node ?? centroid(fgZone.points);
						return (
							<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
								<FocusGraphLayer
									plugin={plugin}
									project={project}
									focusPath={fgLoc.path}
									nodeWorld={nodeWorld}
									// The map's element scale, NOT `nodeUnit`: the graph only ever
									// shows in regular/close-up (where they're equal), and a
									// retraction into node view would otherwise balloon as
									// `nodeUnit` crossfades to screen space.
									unit={scale}
									version={indexVersion}
									closing={!subGraph}
									onOpen={(path) => {
										view.openEntity(path);
										setSubGraph(null);
										setFocusClosing(null);
									}}
									onClose={closeFocus}
									onClosed={() => setFocusClosing(null)}
								/>
							</g>
						);
					})()}
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
								flyTo(t.x, t.y);
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
								onClick={() => animateCameraK(MODE_K[m] / scale)}
							>
								{label}
							</button>
						))}
					</div>
					{/* Element size — the page's own "how big is a thing here" anchor. It
					    sizes every world-fixed marker and shifts the view-mode zoom
					    thresholds, so a map drawn at any scale reads correctly. */}
					<div className="loom-map-elemsize">
						<button
							className={sizeOpen ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
							aria-label="Element size"
							onClick={() => setSizeOpen(!sizeOpen)}
						>
							<Icon name="ruler" fallback="move-diagonal" />
						</button>
						{sizeOpen ? (
							<div className="loom-map-palette-pop">
								<label className="loom-map-palette-row">
									<span>Elements</span>
									<ObsidianSlider
										min={0}
										max={100}
										step={1}
										value={scaleToSlider(scale)}
										onChange={(v) => setPageScale(sliderToScale(v))}
									/>
									<button
										className="loom-map-icon-btn loom-map-reset"
										aria-label="Fit to the zones already drawn"
										onClick={() => setPageScale(inferScale(zonesRef.current))}
									>
										<Icon name="wand-2" fallback="rotate-ccw" />
									</button>
								</label>
								<div className="loom-map-elemsize-readout">
									{`${scale >= 10 ? scale.toFixed(0) : scale.toFixed(2)}× · node ≈ ${Math.round(
										NODE_SIZE_PRESETS.regular * scale
									)} units`}
								</div>
							</div>
						) : null}
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
						scale={scale}
						onWidth={(width) => {
							beginPending();
							// Narrowing a road pulls its own node and pins back inside the
							// thinner body — otherwise they're left stranded off the road.
							updateZone(menuZone.id, { width, ...reclampToWidth(menuZone, width) });
						}}
						onResetWidth={() => {
							snapshot();
							const w = DEFAULT_ROAD_WIDTH * scale;
							updateZone(menuZone.id, { width: w, ...reclampToWidth(menuZone, w) });
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

				{/* Global (empty-space) menu — a VERTICAL list: each row is an icon plus a
				    short label, so what an entry does is readable instead of guessed from
				    a bare glyph. The two draw entries and the image entries still open
				    their own sub-menus at the cursor. */}
				{menu?.kind === 'empty' && menuPos && !imagePicker ? (
					<div className="loom-map-menu loom-map-menu-vert" style={{ left: menuPos.x, top: menuPos.y }}>
						<button
							className="loom-map-menu-row"
							onClick={(e) => {
								const m = new ObsidianMenu();
								for (const [tool, title, icon] of [
									['rect', 'Rectangle', 'square'],
									['draw', 'Polygon', 'pen-tool'],
									['road', 'Road', 'route'],
								] as const) {
									m.addItem((i) =>
										i
											.setTitle(title)
											.setIcon(icon)
											.onClick(() => {
												setMenu(null);
												setTool(tool);
											})
									);
								}
								m.showAtMouseEvent(e.nativeEvent);
							}}
						>
							<Icon name="square-dashed" fallback="square" />
							<span>Draw a zone</span>
							<Icon name="chevron-right" fallback="plus" />
						</button>
						<button className="loom-map-menu-row" onClick={() => setImagePicker(true)}>
							<Icon name="image" />
							<span>Background image</span>
							<Icon name="chevron-right" fallback="plus" />
						</button>
					</div>
				) : null}

				{/* Background-image panel — the global menu's second page. Every image in
				    `Entities/Maps/Images` is listed (a project can hold plenty), so it has
				    its own search and the rows scroll inside a fixed height instead of the
				    old silent 20-item cap that could also run off the bottom of the view. */}
				{menu?.kind === 'empty' && menuPos && imagePicker ? (
					<div
						className="loom-map-menu loom-map-menu-vert loom-map-image-picker"
						// This page is tall and wide, so it flips to whichever side of the
						// cursor has room instead of being clipped by the view edge (an inline
						// transform, which beats the class's default up-and-right anchor).
						style={{
							left: menuPos.x,
							top: menuPos.y,
							transform: `translate(${
								menuPos.x + IMAGE_PICKER_W > (wrapRef.current?.clientWidth ?? 900) ? '-100%' : '0'
							}, ${menuPos.y < IMAGE_PICKER_H ? '12px' : 'calc(-100% - 12px)'})`,
						}}
					>
						<button className="loom-map-menu-row" onClick={() => setImagePicker(false)}>
							<Icon name="chevron-left" fallback="arrow-left" />
							<span>Background image</span>
						</button>
						<button
							className="loom-map-menu-row"
							onClick={() => {
								// Where the menu was opened is where the image lands.
								pendingImageAt.current = menuWorld.current ?? { x: 0, y: 0 };
								setMenu(null);
								fileInputRef.current?.click();
							}}
						>
							<Icon name="image-plus" fallback="image" />
							<span>Import image…</span>
						</button>
						{(() => {
							if (importedImages.length === 0) {
								return <div className="loom-map-subs-more">Nothing imported yet</div>;
							}
							const q = imageQuery.trim().toLowerCase();
							const filtered = q
								? importedImages.filter((f) => f.name.toLowerCase().includes(q))
								: importedImages;
							const at = menuWorld.current ?? { x: 0, y: 0 };
							return (
								<>
									{/* Search only earns its space once the list is long enough to
									    need it. */}
									{importedImages.length > 6 ? (
										<input
											className="loom-map-subs-search"
											type="text"
											placeholder={`Search ${importedImages.length} images…`}
											value={imageQuery}
											onChange={(e) => setImageQuery(e.target.value)}
										/>
									) : null}
									<div className="loom-map-subs-list">
										{filtered.map((f) => (
											<button
												key={f.path}
												className="loom-map-menu-row loom-map-image-row"
												title={f.name}
												onClick={() => {
													setMenu(null);
													void placeImage(f, at);
												}}
											>
												{/* A thumbnail makes the list actually pickable — file
												    names rarely say which map an image is. Downscaled and
												    cached, never the raw file (see buildThumb). */}
												<ImageThumb plugin={plugin} file={f} />
												<span>{f.name}</span>
											</button>
										))}
										{filtered.length === 0 ? <div className="loom-map-subs-more">No matches</div> : null}
									</div>
								</>
							);
						})()}
					</div>
				) : null}

				{/* Background-image picker, opened from the global menu. */}
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					className="loom-map-file-input"
					onChange={(e) => {
						const file = e.target.files?.[0];
						const at = pendingImageAt.current ?? { x: 0, y: 0 };
						pendingImageAt.current = null;
						// Clear the value so re-picking the same file fires onChange again.
						e.target.value = '';
						if (file) void importImageFile(file, at);
					}}
				/>

				{zones.length === 0 && images.length === 0 && draft.length === 0 ? (
					<div className="loom-map-hint">Right-click for options, then draw a zone.</div>
				) : null}
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

/**
 * One zone-panel "pin list" popover — search + a scrollable list of draggable
 * rows, each with an open button and a pin-in-zone checkbox. `ZonePanel`'s
 * sublocations/doors/items palettes are this exact shape three times over,
 * differing only in labels/icons/callbacks; this is the shared body each of
 * their `openPanel === '…'` branches renders.
 */
function ZonePinList({
	columnLabel,
	searchPlaceholder,
	dragTitle,
	rowIcon,
	rowIconFallback,
	pinAriaLabel = 'Show as node in the zone',
	options,
	pinned,
	query,
	onQueryChange,
	onToggle,
	onOpen,
	onDragStart,
}: {
	columnLabel: string;
	searchPlaceholder: string;
	dragTitle: string;
	rowIcon: string;
	rowIconFallback?: string;
	pinAriaLabel?: string;
	options: { value: string; label: string }[];
	pinned: Set<string>;
	query: string;
	onQueryChange: (v: string) => void;
	onToggle: (value: string) => void;
	onOpen: (value: string) => void;
	onDragStart: (value: string) => void;
}): ReactElement {
	const q = query.trim().toLowerCase();
	const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
	return (
		<div className="loom-map-palette-pop loom-map-doors-pop">
			<input
				className="loom-map-subs-search"
				type="text"
				placeholder={searchPlaceholder}
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
			/>
			<div className="loom-map-subs-head">
				<span>{columnLabel}</span>
				<span>Node</span>
			</div>
			<div className="loom-map-subs-list">
				{filtered.map((o) => (
					<div key={o.value} className="loom-map-doors-row loom-map-subs-row">
						<button
							className="loom-map-doors-open"
							title={dragTitle}
							draggable
							onDragStart={(e) => {
								e.dataTransfer.effectAllowed = 'copy';
								e.dataTransfer.setData('text/plain', o.value);
								// Hide the default row drag image — only the node ghost shows.
								e.dataTransfer.setDragImage(new Image(), 0, 0);
								onDragStart(o.value);
							}}
							onClick={() => onOpen(o.value)}
						>
							<Icon name={rowIcon} fallback={rowIconFallback} />
							<span>{o.label}</span>
						</button>
						<input
							type="checkbox"
							checked={pinned.has(o.value)}
							onChange={() => onToggle(o.value)}
							aria-label={pinAriaLabel}
						/>
					</div>
				))}
				{filtered.length === 0 ? <div className="loom-map-subs-more">No matches</div> : null}
			</div>
		</div>
	);
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
	scale,
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
	/** The active page's element scale — sets the road-width slider's range. */
	scale: number;
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
					{openPanel === 'subs' ? (
						<ZonePinList
							columnLabel="Location"
							searchPlaceholder="Search sublocations…"
							dragTitle="Click to open · drag onto the map to place its node"
							rowIcon="map-pin"
							options={sublocations}
							pinned={subPinned}
							query={subQuery}
							onQueryChange={setSubQuery}
							onToggle={onToggleSub}
							onOpen={onOpenSub}
							onDragStart={onSubDragStart}
						/>
					) : null}
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
				{openPanel === 'doors' ? (
					<ZonePinList
						columnLabel="Map"
						searchPlaceholder="Search map pages"
						dragTitle="Click to open · drag onto the map to place its door"
						rowIcon="door-open"
						rowIconFallback="log-in"
						pinAriaLabel="Show a door in the zone"
						options={mapPageOptions}
						pinned={doorPinned}
						query={doorQuery}
						onQueryChange={setDoorQuery}
						onToggle={onToggleDoor}
						onOpen={onOpenPage}
						onDragStart={onDoorDragStart}
					/>
				) : null}
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
				{openPanel === 'items' ? (
					<ZonePinList
						columnLabel="Item"
						searchPlaceholder="Search items"
						dragTitle="Click to open · drag onto the map to place its node"
						rowIcon="gem"
						options={itemOptions}
						pinned={itemPinned}
						query={itemQuery}
						onQueryChange={setItemQuery}
						onToggle={onToggleItem}
						onOpen={onOpenItem}
						onDragStart={onItemDragStart}
					/>
				) : null}
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
								{/* Widths are world units, so the usable range scales with the
								    map's element scale — the same feel on a 200-unit town map and
								    on a 3000-unit continent. */}
								<ObsidianSlider
									min={Math.round(ROAD_WIDTH_MIN * scale)}
									max={Math.round(ROAD_WIDTH_MAX * scale)}
									step={Math.max(1, Math.round(2 * scale))}
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

/** Maps-specific hierarchy for the focus graph (top → bottom): the region sits
 *  straight above, then the focus and any other main locations (maps are about
 *  places), then sublocations, items, quests, characters, factions, events,
 *  sessions. */
function focusLayerOf(rec: EntityRecord): number {
	switch (rec.type) {
		case 'region':
			return -1;
		case 'location':
			return rec.parentLocation ? 1 : 0;
		case 'item':
			return 2;
		case 'quest':
			return 3;
		case 'character':
			return 4;
		case 'faction':
			return 5;
		case 'event':
		case 'scene':
			return 6;
		case 'session':
		case 'chapter':
			return 7;
		default:
			return 4;
	}
}
const FG_STAGGER = 0.06; // per-layer delay fraction for the web-growth ripple
const FG_LABEL_PX = 13; // label size in unit space (scaled by the view's node unit)

// --- Focus-graph geometry (all in UNIT space — one unit = the regular node
// radius in world px at scale 1; the renderer multiplies everything by the map's
// node unit, so the whole graph switches between regular and node-view scale).
// The numbers mirror the main graph's routing constants (see graph/layout.ts), so
// a focus graph reads exactly like the main one: diagonal exits into a vertical
// trunk lane, an optional horizontal run in the band above the target row, and a
// diagonal entry that fans across the target's side.
const FG_U = NODE_SIZE_PRESETS.regular;
const FG_V_GAP = 6 * FG_U; // minimum row spacing (bands grow past it on demand)
const FG_H_GAP = 4.4 * FG_U; // horizontal spacing within a row
const FG_STAGGER_Y = 2.1 * FG_U; // checker offset so labels on a row don't collide
const FG_LANE_GAP = 0.62 * FG_U; // min distance between parallel vertical trunks
const FG_LINE_GAP = 0.62 * FG_U; // min distance between parallel horizontal runs
const FG_DEPART = 2.1 * FG_U; // exit diagonal's drop to the trunk top
const FG_APPROACH = 2.1 * FG_U; // base approach line above the target row
const FG_FAN_GAP = 0.82 * FG_U; // spread between neighboring entry diagonals
const FG_FAN_MAX = 3.2 * FG_U; // half-width one node side offers its fan
const FG_U_TOP = 1.7 * FG_U; // first same-row U lane below its row
const FG_BAND_MID = 1.4 * FG_U; // gap between a band's U block and its run block
const FG_TRUNK_CLEAR = 1.6 * FG_U; // x clearance a trunk keeps from nodes it passes
const FG_CORNER = 6; // bend rounding radius
/** Entry-fan spacing for `n` connections on one node side: full FG_FAN_GAP while
 *  they fit, evenly compressed once the side's capacity is exceeded. */
const fgFanStep = (n: number) =>
	n <= Math.floor((2 * FG_FAN_MAX) / FG_FAN_GAP) + 1 ? FG_FAN_GAP : (2 * FG_FAN_MAX) / (n - 1);

/**
 * Greedy lane assignment: every item gets the lowest lane index (from `first`)
 * not already taken by an item whose `[lo, hi]` extent overlaps its own — so two
 * parallel lines that share any extent can never end up on the same lane, while
 * lines that don't overlap reuse one. Used for the horizontal run lanes of a
 * band and for the same-row U lanes.
 */
function laneIndices<T>(items: T[], span: (t: T) => [number, number], first = 0): Map<T, number> {
	const out = new Map<T, number>();
	const placed: { lane: number; lo: number; hi: number }[] = [];
	for (const it of items.slice().sort((p, q) => span(p)[0] - span(q)[0])) {
		const [lo, hi] = span(it);
		let lane = first;
		for (let guard = 0; guard < items.length + 1; guard++) {
			const clash = placed.some((p) => p.lane === lane && p.lo < hi && p.hi > lo);
			if (!clash) break;
			lane++;
		}
		out.set(it, lane);
		placed.push({ lane, lo, hi });
	}
	return out;
}

/** One routed focus-graph connection, in unit space relative to the focus node.
 *  Mirrors the main graph's edge grammar (`EdgeRoute` in graph/routing.ts): a
 *  cross-row `fan` (diagonal out → vertical trunk → optional horizontal run →
 *  diagonal in) or a same-row `rowU`. */
type FGRoute = { a: string; b: string } &
	(
		| { kind: 'fan'; laneOX: number; departOY: number; approachOY: number; fanOff: number }
		| { kind: 'rowU'; uOY: number; offA: number; offB: number }
	);

/** Focus graph — the clicked location's connected entities laid out in a
 *  maps-specific per-type hierarchy (locations highest). Rendered in WORLD space
 *  (the parent wraps it in the camera transform), so it pans and zooms with the
 *  map while the map behind it stays dimmed. Edges follow the main graph's
 *  orthogonal grammar with diagonal ends (see FGRoute); parallel trunks and runs
 *  are held apart by FG_LANE_GAP / FG_LINE_GAP so lines never overlap. On open the
 *  nodes grow out of the focus location like a web (`focusNeighborhood` gives the
 *  records + edges; we do our own layered placement + routing). The group is
 *  click-through except the nodes: double-click a connected node to open it, click
 *  the focus node (or Esc) to hide. */
function FocusGraphLayer({
	plugin,
	project,
	focusPath,
	nodeWorld,
	unit,
	version,
	closing,
	onOpen,
	onClose,
	onClosed,
}: {
	plugin: LoomLoomPlugin;
	project: ProjectDef;
	focusPath: string;
	nodeWorld: { x: number; y: number };
	/** World px per unit — the map page's element scale, so the graph is sized
	 *  against the map's own geometry. */
	unit: number;
	/** Index version — recompute the neighborhood when the vault changes. */
	version: number;
	/** True while the graph should play its reverse (retract) animation. */
	closing: boolean;
	onOpen: (path: string) => void;
	onClose: () => void;
	/** Called once the closing animation has finished (unmount time). */
	onClosed: () => void;
}) {
	// Web progress: 0→1 on open (nodes grow out), current→0 on close (retract).
	const [prog, setProg] = useState(0);
	const progRef = useRef(0);
	progRef.current = prog;
	const onClosedRef = useRef(onClosed);
	onClosedRef.current = onClosed;
	useEffect(() => {
		const from = closing ? progRef.current : 0;
		const to = closing ? 0 : 1;
		const DUR = closing ? 260 : 420;
		if (!closing) setProg(0);
		const start = performance.now();
		let raf = 0;
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / DUR);
			setProg(from + (to - from) * t);
			if (t < 1) raf = window.requestAnimationFrame(step);
			else if (closing) onClosedRef.current();
		};
		raf = window.requestAnimationFrame(step);
		return () => window.cancelAnimationFrame(raf);
	}, [closing, focusPath, version]);

	// Layout is a set of layer-relative OFFSETS from the focus in unit space
	// (independent of both the clicked world point and the current scale — the
	// renderer applies `nodeWorld` and `unit`), plus the routed edges.
	const layout = useMemo(() => {
		const { records, edges } = focusNeighborhood(plugin, focusPath);
		const focus = records.find((r) => r.path === focusPath);
		if (!focus) return null;
		const rOf = (rec: EntityRecord) => plugin.settings.nodeSizes[rec.type] ?? FG_U;
		const shortLen = (rec: EntityRecord) => Math.min(22, recordLabel(rec, project).length);
		const byLayer = new Map<number, EntityRecord[]>();
		for (const rec of records) {
			const L = rec.path === focusPath ? 0 : focusLayerOf(rec);
			(byLayer.get(L) ?? byLayer.set(L, []).get(L)!).push(rec);
		}
		type Slot = { ox: number; oy: number; layer: number; r: number; rec: EntityRecord; isFocus: boolean };
		const slots = new Map<string, Slot>();
		/** Layers whose row is checkered — their U lanes sit below the deeper half. */
		const staggeredLayers = new Set<number>();
		for (const [L, recs] of byLayer) {
			// Ordered left→right: layer 0 fans the focus at center; others are a row.
			let ordered: EntityRecord[];
			const xOf = new Map<string, number>();
			if (L === 0) {
				const others = recs.filter((r) => r.path !== focusPath).sort((a, b) => a.name.localeCompare(b.name));
				xOf.set(focusPath, 0);
				others.forEach((rec, j) => {
					const side = j % 2 === 0 ? 1 : -1;
					xOf.set(rec.path, side * (Math.floor(j / 2) + 1) * FG_H_GAP);
				});
				ordered = [focus, ...others].sort((a, b) => (xOf.get(a.path) ?? 0) - (xOf.get(b.path) ?? 0));
			} else {
				ordered = recs.slice().sort((a, b) => a.name.localeCompare(b.name));
				const m = ordered.length;
				ordered.forEach((rec, i) => xOf.set(rec.path, (i - (m - 1) / 2) * FG_H_GAP));
			}
			// Checker the row only when labels would overlap at this spacing. Both the
			// labels and the spacing scale with `unit`, so the test is scale-invariant.
			const maxLabelW = Math.max(0, ...ordered.map((r) => shortLen(r) * FG_LABEL_PX * 0.6));
			const stagger = ordered.length > 1 && maxLabelW > FG_H_GAP;
			if (stagger) staggeredLayers.add(L);
			ordered.forEach((rec, rank) => {
				const isFocus = rec.path === focusPath;
				slots.set(rec.path, {
					ox: xOf.get(rec.path) ?? 0,
					// Real y is assigned once the band heights are known (below).
					oy: stagger && !isFocus && rank % 2 === 1 ? FG_STAGGER_Y : 0,
					layer: L,
					r: rOf(rec),
					rec,
					isFocus,
				});
			});
		}

		// --- Edge classification -------------------------------------------------
		// Cross-row edges become fans (upper = the shallower layer); same-row pairs
		// become a U through the band below their row.
		type Fan = { a: string; b: string; laneOX: number; fanOff: number; needsRun: boolean; runLane: number };
		type Row = { a: string; b: string; uLane: number; offA: number; offB: number };
		const fans: Fan[] = [];
		const rows: Row[] = [];
		for (const e of edges) {
			const sa = slots.get(e.a);
			const sb = slots.get(e.b);
			if (!sa || !sb) continue;
			if (sa.layer === sb.layer) {
				rows.push({ a: e.a, b: e.b, uLane: 0, offA: 0, offB: 0 });
				continue;
			}
			const upFirst = sa.layer < sb.layer;
			fans.push({
				a: upFirst ? e.a : e.b,
				b: upFirst ? e.b : e.a,
				laneOX: 0,
				fanOff: 0,
				needsRun: false,
				runLane: 0,
			});
		}
		const slotOf = (id: string) => slots.get(id) as Slot;

		// --- Trunk lanes ---------------------------------------------------------
		// A trunk wants to sit midway between its endpoints (symmetric diagonals at
		// both ends). A trunk that spans several rows first steps clear of the nodes
		// it would pass through; then every trunk whose row span overlaps another's
		// is pushed to keep at least FG_LANE_GAP, so parallel verticals never merge.
		const desiredX = new Map<Fan, number>();
		for (const f of fans) {
			const sa = slotOf(f.a);
			const sb = slotOf(f.b);
			let x = (sa.ox + sb.ox) / 2;
			if (sb.layer - sa.layer > 1) {
				for (let guard = 0; guard < 8; guard++) {
					const hit = [...slots.values()].find(
						(s) => s.layer > sa.layer && s.layer < sb.layer && Math.abs(x - s.ox) < s.r + FG_TRUNK_CLEAR
					);
					if (!hit) break;
					x = x >= hit.ox ? hit.ox + hit.r + FG_TRUNK_CLEAR : hit.ox - hit.r - FG_TRUNK_CLEAR;
				}
			}
			desiredX.set(f, x);
		}
		const laid: { x: number; lo: number; hi: number }[] = [];
		for (const f of fans.slice().sort((p, q) => (desiredX.get(p) ?? 0) - (desiredX.get(q) ?? 0))) {
			const lo = slotOf(f.a).layer;
			const hi = slotOf(f.b).layer;
			let x = desiredX.get(f) ?? 0;
			for (let pass = 0; pass <= laid.length; pass++) {
				let moved = false;
				for (const p of laid) {
					if (p.hi <= lo || p.lo >= hi) continue; // spans don't share a band
					if (Math.abs(x - p.x) < FG_LANE_GAP - 0.01) {
						x = p.x + FG_LANE_GAP;
						moved = true;
					}
				}
				if (!moved) break;
			}
			f.laneOX = x;
			laid.push({ x, lo, hi });
		}

		// --- Entry diagonals -----------------------------------------------------
		// Everything arriving at one node fans across its side, ordered by trunk x.
		const byTarget = new Map<string, Fan[]>();
		for (const f of fans) (byTarget.get(f.b) ?? byTarget.set(f.b, []).get(f.b)!).push(f);
		for (const group of byTarget.values()) {
			group.sort((p, q) => p.laneOX - q.laneOX);
			const step = fgFanStep(group.length);
			group.forEach((f, j) => {
				f.fanOff = (j - (group.length - 1) / 2) * step;
				f.needsRun = Math.abs(slotOf(f.b).ox + f.fanOff - f.laneOX) > LANE_EPSILON;
				// A near-aligned fan collapses to a TRUE vertical (entry snapped onto the
				// trunk). The renderer's own epsilon works in world px, so without this a
				// hairline run would reappear at large element scales.
				if (!f.needsRun) f.fanOff = f.laneOX - slotOf(f.b).ox;
			});
		}

		// --- Horizontal run lanes + same-row U lanes -----------------------------
		// Overlapping runs (or Us) get separate lanes; the band heights below then
		// make room for however many lanes each row ended up needing.
		const maxRun = new Map<number, number>();
		const runsByLayer = new Map<number, Fan[]>();
		for (const f of fans) {
			if (!f.needsRun) continue;
			const L = slotOf(f.b).layer;
			(runsByLayer.get(L) ?? runsByLayer.set(L, []).get(L)!).push(f);
		}
		for (const [L, group] of runsByLayer) {
			const lanes = laneIndices(
				group,
				(f) => {
					const bx = slotOf(f.b).ox + f.fanOff;
					return [Math.min(bx, f.laneOX), Math.max(bx, f.laneOX)];
				},
				1
			);
			for (const [f, lane] of lanes) {
				f.runLane = lane;
				maxRun.set(L, Math.max(maxRun.get(L) ?? 0, lane));
			}
		}
		const maxU = new Map<number, number>();
		const usByLayer = new Map<number, Row[]>();
		for (const r of rows) {
			const L = slotOf(r.a).layer;
			(usByLayer.get(L) ?? usByLayer.set(L, []).get(L)!).push(r);
		}
		for (const [L, group] of usByLayer) {
			const lanes = laneIndices(group, (r) => {
				const ax = slotOf(r.a).ox;
				const bx = slotOf(r.b).ox;
				return [Math.min(ax, bx), Math.max(ax, bx)];
			});
			for (const [r, lane] of lanes) {
				r.uLane = lane;
				maxU.set(L, Math.max(maxU.get(L) ?? 0, lane));
			}
		}
		// U turn points fan across each node's side, exactly like entry diagonals.
		const uEnds = new Map<string, { row: Row; atA: boolean; otherX: number }[]>();
		for (const r of rows) {
			for (const atA of [true, false]) {
				const id = atA ? r.a : r.b;
				const otherX = slotOf(atA ? r.b : r.a).ox;
				(uEnds.get(id) ?? uEnds.set(id, []).get(id)!).push({ row: r, atA, otherX });
			}
		}
		for (const ends of uEnds.values()) {
			ends.sort((p, q) => p.otherX - q.otherX);
			const step = fgFanStep(ends.length);
			ends.forEach((end, j) => {
				const off = (j - (ends.length - 1) / 2) * step;
				if (end.atA) end.row.offA = off;
				else end.row.offB = off;
			});
		}

		// --- Row y ---------------------------------------------------------------
		// Rows grow outward from the focus (which stays at the map node, y = 0). A
		// band is at least FG_V_GAP tall and taller when it has to hold the upper
		// row's U lanes plus the lower row's approach/run lanes.
		const bandHeight = (upperL: number, lowerL: number): number => {
			const nU = usByLayer.has(upperL) ? (maxU.get(upperL) ?? 0) + 1 : 0;
			const nRun = maxRun.get(lowerL) ?? 0;
			const stag = staggeredLayers.has(upperL) ? FG_STAGGER_Y : 0;
			const need =
				stag +
				FG_U_TOP +
				nU * FG_LINE_GAP +
				(nU > 0 ? FG_BAND_MID : 0) +
				(nRun + 1) * FG_LINE_GAP +
				FG_APPROACH;
			return Math.max(FG_V_GAP, need);
		};
		const Ls = [...byLayer.keys()].sort((a, b) => a - b);
		const rowY = new Map<number, number>([[0, 0]]);
		let prev = 0;
		for (const L of Ls) {
			if (L <= 0) continue;
			rowY.set(L, (rowY.get(prev) ?? 0) + bandHeight(prev, L));
			prev = L;
		}
		prev = 0;
		for (const L of [...Ls].reverse()) {
			if (L >= 0) continue;
			rowY.set(L, (rowY.get(prev) ?? 0) - bandHeight(L, prev));
			prev = L;
		}
		for (const s of slots.values()) s.oy += rowY.get(s.layer) ?? 0;

		// --- Concrete routes ------------------------------------------------------
		const routes: FGRoute[] = [];
		for (const f of fans) {
			const sa = slotOf(f.a);
			const sb = slotOf(f.b);
			// Approach lines hang off the flat row line (not the staggered node), so a
			// checkered row can't push two runs onto the same y.
			const approachOY = (rowY.get(sb.layer) ?? 0) - FG_APPROACH - f.runLane * FG_LINE_GAP;
			// The exit diagonal never overshoots its own approach line (a node
			// staggered down sits closer to it than a full FG_DEPART drop).
			const drop = Math.min(FG_DEPART, Math.max(2, (approachOY - sa.oy) * 0.45));
			routes.push({
				kind: 'fan',
				a: f.a,
				b: f.b,
				laneOX: f.laneOX,
				departOY: sa.oy + drop,
				approachOY,
				fanOff: f.fanOff,
			});
		}
		for (const r of rows) {
			const L = slotOf(r.a).layer;
			const base = (rowY.get(L) ?? 0) + (staggeredLayers.has(L) ? FG_STAGGER_Y : 0);
			routes.push({
				kind: 'rowU',
				a: r.a,
				b: r.b,
				uOY: base + FG_U_TOP + r.uLane * FG_LINE_GAP,
				offA: r.offA,
				offB: r.offB,
			});
		}
		return { slots, routes };
	}, [plugin, project, focusPath, version]);

	if (!layout) return null;
	const { slots, routes } = layout;

	const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
	// Layer distance from the focus (0) drives the ripple; region (−1) and deep
	// layers reveal after the focus.
	const layerProg = (layer: number) => {
		const startAt = Math.abs(layer) * FG_STAGGER;
		return easeOut(Math.max(0, Math.min(1, (prog - startAt) / (1 - startAt))));
	};
	// A node's live (animated) world position + its reveal progress. Unit space →
	// world: offsets and radii scale by `unit` (the page's element scale), so the
	// graph is proportional to the map it grows out of.
	const posOf = (id: string) => {
		const s = slots.get(id);
		if (!s) return null;
		const np = s.isFocus ? Math.max(prog, layerProg(0)) : layerProg(s.layer);
		return {
			x: nodeWorld.x + s.ox * unit * np,
			y: nodeWorld.y + s.oy * unit * np,
			np,
			r: s.r * unit,
			rec: s.rec,
			isFocus: s.isFocus,
		};
	};
	const labelPx = FG_LABEL_PX * unit;

	return (
		<g className="loom-map-focusgraph">
			{routes.map((rt) => {
				const a = posOf(rt.a);
				const b = posOf(rt.b);
				if (!a || !b) return null;
				// One progress for the whole edge, so the route's lanes and its
				// endpoints grow out of the focus together.
				const op = Math.min(a.np, b.np);
				if (op <= 0.001) return null;
				const sx = unit * op;
				const route: EdgeRoute =
					rt.kind === 'fan'
						? {
								kind: 'fan',
								laneX: nodeWorld.x + rt.laneOX * sx,
								departY: nodeWorld.y + rt.departOY * sx,
								approachY: nodeWorld.y + rt.approachOY * sx,
								fanOffset: rt.fanOff * sx,
							}
						: {
								kind: 'rowU',
								uY: nodeWorld.y + rt.uOY * sx,
								offA: rt.offA * sx,
								offB: rt.offB * sx,
							};
				return (
					<path
						key={rt.kind + rt.a + '|' + rt.b}
						className="loom-map-focusgraph-edge"
						d={roundedPath(
							edgePoints(route, { x: a.x, y: a.y }, { x: b.x, y: b.y }),
							FG_CORNER * unit
						)}
						strokeWidth={2 * unit}
						opacity={op}
					/>
				);
			})}
			{[...slots.keys()].map((id) => {
				const p = posOf(id);
				if (!p || p.np <= 0.001) return null;
				const r = p.r * p.np;
				const label = recordLabel(p.rec, project);
				const short = label.length > 22 ? label.slice(0, 21).trimEnd() + '…' : label;
				return (
					<g
						key={id}
						className="loom-map-node loom-map-focusgraph-node"
						opacity={p.np}
						onClick={() => (p.isFocus ? onClose() : undefined)}
						onDoubleClick={() => (p.isFocus ? undefined : onOpen(id))}
					>
						{short !== label ? <title>{label}</title> : null}
						<circle cx={p.x} cy={p.y} r={r} fill={plugin.settings.nodeColors[p.rec.type]} className="loom-map-node-dot" />
						{p.isFocus ? (
							<g
								transform={`translate(${p.x},${p.y}) scale(${r / 13}) translate(-12,-12)`}
								fill="var(--text-on-accent, #fff)"
								fillOpacity={0.92}
							>
								<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
							</g>
						) : null}
						{p.np > 0.6 ? (
							<text
								x={p.x}
								y={p.y + r + labelPx + 2}
								textAnchor="middle"
								className="loom-map-node-label"
								style={{ fontSize: `${labelPx}px` }}
							>
								{short}
							</text>
						) : null}
					</g>
				);
			})}
		</g>
	);
}
