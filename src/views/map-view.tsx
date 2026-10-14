import {
	App,
	Menu as ObsidianMenu,
	Modal,
	Notice,
	TFile,
	TFolder,
	ViewStateResult,
	debounce,
	normalizePath,
	setTooltip,
} from 'obsidian';
import {
	CSSProperties,
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	ReactNode,
	useCallback,
	RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { Root, createRoot } from 'react-dom/client';
import { darkenHex } from '../settings';
import {
	EntityRecord,
	MAPS_FOLDER,
	MAPS_ICON,
	MAPS_IMAGES_FOLDER,
	NODE_SIZE_PRESETS,
	NodeSizePreset,
	VIEW_MAP,
	mapsLabel,
} from '../types';
import { linkTargetOf, ProjectDef } from '../indexer';
import { ConfirmModal, TextInputModal, ensureFolder } from '../project';
import type LoomLoomPlugin from '../main';
import { LoomReactView } from './react-view';
import { EntityChip, Icon, SearchableSelect, ViewShell, noProjectMessage } from './common';
import { recordLabel } from '../display';
import { resolveProject, useIndexVersion } from './hooks';
import { focusNeighborhood } from './mini-graph';
import { EdgeRoute, LANE_EPSILON, edgePoints, packLanes, roundedPath } from '../graph/routing';
import { t } from '../i18n';
import { projectPath } from '../naming';

/** One drawn zone: a polygon associated (optionally) with a location, which
 *  pins a node inside it. */
/** A door's size when it has none of its own. */
const DOOR_SIZE: NodeSizePreset = 'small';
/** The three marker kinds a zone carries, and which list holds each. */
type PinKind = 'door' | 'itempin' | 'subpin';
const PIN_LIST = { door: 'doors', itempin: 'itemPins', subpin: 'subPins' } as const;
const PIN_OPEN_LABEL = {
	door: 'view.map.pinMenu.openMap',
	itempin: 'view.map.pinMenu.openItem',
	subpin: 'view.map.pinMenu.openSublocation',
} as const;

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
	/** Portal links to other map pages, drawn as door icons inside the zone.
	 *  `size` defaults to small (`DOOR_SIZE`). */
	doors: { page: string; x: number; y: number; size?: NodeSizePreset }[];
	/** Item markers dropped inside the zone (link target + position). `size`
	 *  overrides the zone-derived size for that one marker. */
	itemPins: { item: string; x: number; y: number; size?: NodeSizePreset }[];
	/** Sublocation nodes shown inside the zone (a sublocation of the zone's
	 *  location, drawn as a smaller node; link target + position). `size` overrides
	 *  the nesting-derived size for that one node. */
	subPins: { loc: string; x: number; y: number; size?: NodeSizePreset }[];
	/** Locked zones can't be moved or reshaped (still selectable). */
	locked: boolean;
	/** Texture: a polygon's terrain (see TERRAINS), a path's surface (see
	 *  PATH_STYLES — 'bricks' for a road, 'water' for a river), or null for plain. */
	terrain: Texture | null;
	/** A name for a zone or path that isn't a location ("the Silverrun"), shown
	 *  on the map and found by the location search while `named` is on. */
	name: string;
	/** Which identity is in use: a linked location (false, the default) or the
	 *  plain `name`. Switching to the name sets the location aside in `savedLoc`,
	 *  so switching back restores it — one is in use at a time, both are kept. */
	named: boolean;
	savedLoc: { location: string; node: Pt | null } | null;
}

/** A free text label on a map page ("The Shattered Sea"), centred on x/y. */
interface MapLabel {
	id: string;
	x: number;
	y: number;
	text: string;
	/** Font size in world units — a label is part of the map, so it scales with
	 *  it (fading out once too small or too big on screen, LABEL_PX). */
	size: number;
}

/**
 * A background image placed on a map page — always the BOTTOM layer, under every
 * zone, road and marker, so you draw over it.
 *
 * `w`/`h` are world units and always keep the file's aspect ratio: an import
 * starts at the image's natural pixel size (1 image pixel = 1 world unit, so a
 * scanned map can be traced 1:1), and every resize handle scales both axes
 * together.
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
	labels: MapLabel[];
	/** The canvas colour (hex), or null for the theme's own. */
	bg: string | null;
}

interface MapsFile {
	version: number;
	activeId: string | null;
	maps: MapPage[];
}

const DEFAULT_ALPHA = 0.35;
/** Wheel-zoom limits for an empty page (a page with content derives its own). */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const CLOSE_SNAP = 12; // screen px to the first vertex that closes a draft
const VERTEX_R = 5; // handle radius (screen px)
const CLICK_SLOP = 4; // px of movement below which a node press counts as a click
const NODE_DBL_MS = 220; // short double-click window on a node (open its page)
const DELETE_SCRUB_MS = 3000; // grace period before a deleted note's map pins are cleared
const DEFAULT_ROAD_WIDTH = 280; // world units — only for a stored road with no valid width
const MIN_VERTEX_DIST = 12; // screen px — clicks nearer than this to the last vertex don't add one
const SUB_NODE_SCALE = 0.72; // each sublocation level renders this fraction of its parent's size
const MIN_SUB_NODE_SIZE = 6; // px floor — deeper sublocations never shrink past this

/** Smallest world width a background image can be resized to. */
const IMAGE_MIN_W = 8;
/** Screen-px band around a locked image's border that still opens its menu. */
const IMAGE_EDGE_PX = 10;
/** Half-size (screen px) of an image resize grip, and the half-width of the
 *  invisible drag band along each side. */
const IMAGE_GRIP_PX = 7;
/** Opacity of a main location node once its zone fills the view (see-through,
 *  so the focus is on the sublocations within). */
const CLOSEUP_NODE_OPACITY = 0.28;
/** Zoom of an empty page with no saved camera (a page with content opens fitted). */
const DEFAULT_K = 0.5;

/**
 * Semantic zoom — every zone decides how it draws from its OWN on-screen size
 * (area-equivalent radius × zoom, in px), never from a page-wide mode: zooming out
 * folds small towns into their nodes while a continent beside them stays drawn.
 * The bands are screen px, so they hold for a map drawn at any size. Each is
 * [from, to] for a smoothstep; tune here.
 */
const COLLAPSE_PX: [number, number] = [28, 56]; // fully folded into its node below, fully drawn above
const PINS_PX: [number, number] = [80, 140]; // doors, items and sublocations fade in
const CLOSEUP_PX: [number, number] = [250, 400]; // the main node turns see-through
/** Markers are sized from their own zone: a zone this many px in radius on
 *  screen draws its node/pins at their preset size, scaling with it, clamped to
 *  MARKER_MIN..MAX × preset so they never vanish or balloon. A folded zone's node
 *  is a constant 1× on screen. No per-map setting — the zones are the scale. */
const MARKER_REF_PX = 85;
const MARKER_MIN = 0.6;
const MARKER_MAX = 1.4;
/** A free label shows across this on-screen font-size band (px): fades in once
 *  readable, fades out once it would dwarf the view. */
const LABEL_IN_PX: [number, number] = [7, 11];
const LABEL_OUT_PX: [number, number] = [140, 220];

/**
 * Terrain presets for a polygon zone: the fill a preset sets, and its texture —
 * a screen-px tile (so its density holds at any zoom) stroked in a darker shade
 * of the zone's colour, masked clear around the zone's markers and labels.
 */
type Terrain = 'water' | 'forest' | 'mountains' | 'fields';
const TERRAINS: Record<Terrain, { icon: string; color: string; alpha: number; tile: [number, number]; d: string }> = {
	water: { icon: 'waves', color: '#7fb2d6', alpha: 0.55, tile: [28, 16], d: 'M2 5q3-3 6 0t6 0M16 13q3-3 6 0t6 0' },
	forest: { icon: 'trees', color: '#8fb47a', alpha: 0.5, tile: [26, 26], d: 'M7 3l4 7H3zM7 10v3M20 15l4 7h-8zM20 22v3' },
	mountains: { icon: 'mountain', color: '#a89a86', alpha: 0.5, tile: [30, 24], d: 'M2 11l5-7 5 7M17 22l5-7 5 7' },
	fields: { icon: 'wheat', color: '#d8c779', alpha: 0.5, tile: [18, 10], d: 'M1 3h7M10 8h6' },
};
/** Every texture a zone or path can carry: the polygon terrains, plus 'bricks',
 *  which only a path draws (dashed blocks along its own direction — a tile
 *  pattern can't turn with a winding road). */
type Texture = Terrain | 'bricks';
const isTexture = (v: unknown): v is Texture => v === 'bricks' || (typeof v === 'string' && v in TERRAINS);
/** Path presets (a path is a road, river, wall… — one tool, styled). `null`
 *  colour = the map's own draw colour. */
const PATH_STYLES: Record<'plain' | 'road' | 'river', { icon: string; color: string | null; alpha: number; texture: Texture | null }> = {
	plain: { icon: 'minus', color: null, alpha: DEFAULT_ALPHA, texture: null },
	road: { icon: 'route', color: '#b9a58a', alpha: 0.75, texture: 'bricks' },
	river: { icon: 'waves', color: '#6fa8d6', alpha: 0.8, texture: 'water' },
};

const smoothstep = ([a, b]: [number, number], x: number): number => {
	const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Node size dropdown labels. Translated at use (not stored — the locale can
 *  change at runtime). */
const SIZE_OPTIONS: [NodeSizePreset, () => string][] = [
	['small', () => t('view.map.size.s')],
	['regular', () => t('view.map.size.m')],
	['big', () => t('view.map.size.l')],
	['very-big', () => t('view.map.size.xl')],
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
/** A zone's stored pins of one kind: entries with a string `key` and finite x/y. */
function pinEntries<K extends string>(
	raw: unknown,
	key: K
): (Record<K, string> & { x: number; y: number; size?: unknown })[] {
	if (!Array.isArray(raw)) return [];
	return (raw as Record<string, unknown>[]).filter(
		(p) => !!p && typeof p[key] === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y)
	) as (Record<K, string> & { x: number; y: number; size?: unknown })[];
}

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
			width: typeof z.width === 'number' && Number.isFinite(z.width) && z.width > 0 ? z.width : DEFAULT_ROAD_WIDTH,
			color: typeof z.color === 'string' ? z.color : '#c9a36b',
			alpha: typeof z.alpha === 'number' ? Math.max(0, Math.min(1, z.alpha)) : DEFAULT_ALPHA,
			location: typeof z.location === 'string' ? z.location : null,
			node:
				z.node && Number.isFinite(z.node.x) && Number.isFinite(z.node.y)
					? { x: z.node.x, y: z.node.y }
					: null,
			nodeSize: parsePreset(z.nodeSize) ?? 'regular',
			doors: pinEntries(z.doors, 'page').map((dr) => ({ page: dr.page, x: dr.x, y: dr.y, size: parsePreset(dr.size) })),
			itemPins: pinEntries(z.itemPins, 'item').map((it) => ({ item: it.item, x: it.x, y: it.y, size: parsePreset(it.size) })),
			subPins: pinEntries(z.subPins, 'loc').map((sp) => ({ loc: sp.loc, x: sp.x, y: sp.y, size: parsePreset(sp.size) })),
			locked: z.locked === true,
			terrain: isTexture(z.terrain) ? z.terrain : null,
			name: typeof z.name === 'string' ? z.name : '',
			named: z.named === true,
			savedLoc:
				z.savedLoc && typeof z.savedLoc.location === 'string'
					? {
							location: z.savedLoc.location,
							node:
								z.savedLoc.node && Number.isFinite(z.savedLoc.node.x) && Number.isFinite(z.savedLoc.node.y)
									? { x: z.savedLoc.node.x, y: z.savedLoc.node.y }
									: null,
						}
					: null,
		});
	}
	return zones;
}

function parseLabels(raw: unknown): MapLabel[] {
	if (!Array.isArray(raw)) return [];
	const out: MapLabel[] = [];
	for (const l of raw as Partial<MapLabel>[]) {
		if (!l || typeof l.text !== 'string' || typeof l.x !== 'number' || typeof l.y !== 'number') continue;
		if (typeof l.size !== 'number' || !(l.size > 0)) continue;
		out.push({ id: typeof l.id === 'string' ? l.id : newId(), x: l.x, y: l.y, text: l.text, size: l.size });
	}
	return out;
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

/** The camera that frames a page's zones and images in a w×h view, or null for
 *  an empty page. */
function fitCamera(zones: MapZone[], images: MapImage[], w: number, h: number): Camera | null {
	const pts = [
		...zones.flatMap((z) => z.points),
		...images.flatMap((im) => [
			{ x: im.x, y: im.y },
			{ x: im.x + im.w, y: im.y + im.h },
		]),
	];
	if (pts.length === 0) return null;
	const x0 = Math.min(...pts.map((p) => p.x));
	const x1 = Math.max(...pts.map((p) => p.x));
	const y0 = Math.min(...pts.map((p) => p.y));
	const y1 = Math.max(...pts.map((p) => p.y));
	const k = 0.9 * Math.min(w / Math.max(1e-6, x1 - x0), h / Math.max(1e-6, y1 - y0));
	return { k, tx: w / 2 - ((x0 + x1) / 2) * k, ty: h / 2 - ((y0 + y1) / 2) * k };
}

/** Wheel-zoom range from the page's own content: out to a quarter of the fit-all
 *  view, in until its smallest zone is about a viewport across. */
function zoomLimits(zones: MapZone[], images: MapImage[], w: number, h: number): [number, number] {
	const fit = fitCamera(zones, images, w, h);
	if (!fit) return [MIN_ZOOM, MAX_ZOOM];
	const radii = zones
		.filter((z) => z.kind === 'zone')
		.map((z) => polygonRadius(z.points))
		.filter((r) => r > 0);
	const inK = radii.length ? Math.min(w, h) / Math.min(...radii) : fit.k * 20;
	return [fit.k / 4, Math.max(fit.k * 4, inK)];
}

type ProjectRef = { root: string; name: string };

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

/** How many map pages a Maps file's text holds — the count on the home
 *  wheel's Maps entry. 0 for no file (null) or an unreadable one. */
export function mapPageCount(text: string | null): number {
	if (text === null) return 0;
	try {
		return parseMapsFile(text)?.maps.length ?? 0;
	} catch {
		return 0;
	}
}

/** A single default page (used for a brand-new project map). */
function defaultPages(): MapPage[] {
	return [{ id: newId(), name: t('view.map.defaultMapName'), parentId: null, order: 0, zones: [], images: [], labels: [], bg: null }];
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
const THUMB_PX = 192;
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

/** One picker tile's thumbnail: blank until it's actually scrolled into view,
 *  then its cached data URL. Nothing off-screen is ever decoded. */
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
			{ root: el.closest('.loom-map-image-grid'), rootMargin: '200px' }
		);
		io.observe(el);
		return () => {
			cancelled = true;
			io.disconnect();
		};
	}, [plugin, file, url]);
	if (!url) return <span className="loom-map-image-thumb" ref={ref} />;
	return <img className="loom-map-image-thumb" src={url} alt="" decoding="async" />;
}

/** Keeps a floating menu — and any popover open inside it — within the map
 *  canvas: after every render it measures them and nudges the menu back in by
 *  however much they overflow an edge (8px margin). Menus anchor at the cursor,
 *  so near the canvas edge they'd otherwise be clipped. */
function useKeepInMap(ref: RefObject<HTMLElement | null>) {
	useLayoutEffect(() => {
		const el = ref.current;
		const wrap = el?.closest('.loom-map-wrap');
		if (!el || !wrap) return;
		el.setCssProps({ translate: 'none' });
		const box = wrap.getBoundingClientRect();
		const rects = [el, ...Array.from(el.querySelectorAll<HTMLElement>('.loom-map-palette-pop'))].map((e) =>
			e.getBoundingClientRect()
		);
		const l = Math.min(...rects.map((r) => r.left));
		const r = Math.max(...rects.map((r2) => r2.right));
		const tp = Math.min(...rects.map((r2) => r2.top));
		const b = Math.max(...rects.map((r2) => r2.bottom));
		const m = 8;
		// Pull back from the right/bottom edge, but never past the left/top one.
		const dx = Math.max(box.left + m - l, Math.min(0, box.right - m - r));
		const dy = Math.max(box.top + m - tp, Math.min(0, box.bottom - m - b));
		if (dx || dy) el.setCssProps({ translate: `${dx}px ${dy}px` });
	});
}

/** The background-image browser: every image already in the project's Maps
 *  images folder as a searchable thumbnail grid, plus "Import image…". Picking
 *  one (or importing) closes it; the caller places the image. */
class ImagePickerModal extends Modal {
	private root: Root | null = null;

	constructor(
		private plugin: LoomLoomPlugin,
		private files: TFile[],
		private onPickFile: (file: TFile) => void,
		private onImport: () => void
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass('loom-map-image-modal');
		// Top-anchored: the grid's height changes as the search filters it, and a
		// centred modal would move the search bar with every keystroke.
		this.containerEl.addClass('loom-modal-top');
		this.setTitle(t('view.map.backgroundImage'));
		this.root = createRoot(this.contentEl);
		this.root.render(
			<ImagePicker
				plugin={this.plugin}
				files={this.files}
				onPick={(f) => {
					this.close();
					this.onPickFile(f);
				}}
				onImport={() => {
					this.close();
					this.onImport();
				}}
			/>
		);
	}

	onClose(): void {
		this.root?.unmount();
		this.root = null;
		this.contentEl.empty();
	}
}

function ImagePicker({
	plugin,
	files,
	onPick,
	onImport,
}: {
	plugin: LoomLoomPlugin;
	files: TFile[];
	onPick: (file: TFile) => void;
	onImport: () => void;
}) {
	const [query, setQuery] = useState('');
	const q = query.trim().toLowerCase();
	const shown = q ? files.filter((f) => f.basename.toLowerCase().includes(q)) : files;
	return (
		<div className="loom-map-image-browser">
			<div className="loom-map-image-bar">
				<input
					type="search"
					placeholder={t('view.map.searchImages', { count: files.length })}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<button className="mod-cta" onClick={onImport}>
					{t('view.map.importImage')}
				</button>
			</div>
			<div className="loom-map-image-grid">
				{shown.map((f) => (
					<button key={f.path} className="loom-map-image-tile" title={f.name} onClick={() => onPick(f)}>
						<ImageThumb plugin={plugin} file={f} />
						<span>{f.basename}</span>
					</button>
				))}
				{files.length === 0 ? (
					<div className="loom-map-image-empty">{t('view.map.nothingImportedYet')}</div>
				) : shown.length === 0 ? (
					<div className="loom-map-image-empty">{t('common.noMatches')}</div>
				) : null}
			</div>
		</div>
	);
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
					name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name : t('view.map.defaultMapName'),
					parentId: typeof m.parentId === 'string' ? m.parentId : null,
					order: typeof m.order === 'number' ? m.order : i,
					zones,
					images: parseImages(m.images),
					labels: parseLabels(m.labels),
					bg: typeof m.bg === 'string' && /^#[0-9a-f]{6}$/i.test(m.bg) ? m.bg : null,
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

/** Any CSS colour as #rrggbb (a canvas context normalises it), for a colour
 *  input's value; mid-grey if it can't be read. */
function cssColorToHex(color: string): string {
	const ctx = createEl('canvas').getContext('2d');
	if (!ctx || !color) return '#808080';
	ctx.fillStyle = color;
	const out = ctx.fillStyle;
	return /^#[0-9a-f]{6}$/i.test(out) ? out : '#808080';
}

/** A darker shade of a hex color (for zone outlines + nodes). */
const darker = (hex: string, factor = 0.6): string => darkenHex(hex, factor);

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

/** Lucide `sparkle` (24-unit), marking main-location nodes. */
const SPARKLE_PATH =
	'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z';

/** The axis-aligned box spanned by two opposite corners. */
function boxOf(a: { x: number; y: number }, b: { x: number; y: number }) {
	return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** An SVG path `d` through `pts` (open; append ' Z' to close). */
function pathD(pts: { x: number; y: number }[]): string {
	return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
}

/** A zone's node: its placed `node`, else the vertex centroid. */
function nodeOf(z: MapZone): { x: number; y: number } {
	return z.node ?? centroid(z.points);
}

/** Mean of the points; (0, 0) for none. */
function centroid(points: Pt[]): Pt {
	const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
	const n = points.length || 1;
	return { x: s.x / n, y: s.y / n };
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

/** Nearest point to `p` on the path through `pts` (`closed` adds the
 *  last→first segment): the point `q`, its distance `d`, and `i`, the index of
 *  that segment's start vertex (-1 when there's no segment). The first segment
 *  wins a tie. */
function nearestOnPath(p: Pt, pts: Pt[], closed: boolean): { q: Pt; d: number; i: number } {
	let best = { q: pts[0] ?? p, d: Infinity, i: -1 };
	const last = closed ? pts.length : pts.length - 1;
	for (let i = 0; i < last; i++) {
		const q = nearestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
		const d = Math.hypot(p.x - q.x, p.y - q.y);
		if (d < best.d) best = { q, d, i };
	}
	return best;
}

function distToPolygon(px: number, py: number, pts: Pt[]): number {
	return nearestOnPath({ x: px, y: py }, pts, true).d;
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
/** Re-shapes a path to `next` (same number of points) and carries what sits on
 *  it along: its own node, doors, items and sublocation pins keep their spot
 *  ALONG the path — same segment, same fraction, same offset — so moving a knot
 *  moves them with that stretch of path instead of leaving them behind. */
function reshapeRoad(road: MapZone, next: Pt[]): MapZone {
	const old = road.points;
	const carry = <T extends Pt>(p: T): T => {
		let best = { d: Infinity, i: 0, t: 0, q: { x: p.x, y: p.y } };
		for (let i = 0; i < old.length - 1; i++) {
			const a = old[i];
			const b = old[i + 1];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
			const q = { x: a.x + t * dx, y: a.y + t * dy };
			const d = Math.hypot(p.x - q.x, p.y - q.y);
			if (d < best.d) best = { d, i, t, q };
		}
		const a = next[best.i] ?? p;
		const b = next[best.i + 1] ?? a;
		const moved = { x: a.x + (b.x - a.x) * best.t + p.x - best.q.x, y: a.y + (b.y - a.y) * best.t + p.y - best.q.y };
		return { ...p, ...clampToCapsule(moved, next, road.width / 2) };
	};
	return {
		...road,
		points: next,
		node: road.node ? carry(road.node) : null,
		doors: road.doors.map(carry),
		itemPins: road.itemPins.map(carry),
		subPins: road.subPins.map(carry),
	};
}

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
		if (z.id === movedId) {
			const shifted = {
				...z,
				points: z.points.map(shiftPt),
				node: z.node ? shiftPt(z.node) : null,
				doors: shiftArr(z.doors),
				itemPins: shiftArr(z.itemPins),
				subPins: shiftArr(z.subPins),
			};
			if (z.kind !== 'road' || z.points.length < 2) return shifted;
			// A moved path keeps its linked ends exactly where they're connected;
			// only the rest of it moves (its node and pins ride along via reshapeRoad).
			const last = z.points.length - 1;
			const pts = z.points.map((p, i) =>
				(i === 0 && z.startLoc) || (i === last && z.endLoc) ? { ...p } : shiftPt(p)
			);
			return reshapeRoad(z, pts);
		}
		if (movedLoc && z.kind === 'road' && z.points.length > 0) {
			const startHit = zoneIdForLoc(z.startLoc) === movedId;
			const endHit = zoneIdForLoc(z.endLoc) === movedId;
			if (startHit || endHit) {
				const pts = z.points.map((p) => ({ ...p }));
				if (startHit) pts[0] = shiftPt(pts[0]);
				if (endHit) pts[pts.length - 1] = shiftPt(pts[pts.length - 1]);
				return reshapeRoad(z, pts);
			}
		}
		return z;
	});
}

/** Distance from a point to an open polyline (road centerline). */
function distToPolyline(px: number, py: number, pts: Pt[]): number {
	return nearestOnPath({ x: px, y: py }, pts, false).d;
}

/** Inserts a vertex into `pts` on whichever segment is nearest to (px,py),
 *  returning the new points. `closed` wraps the last→first segment (polygons). */
function insertVertexAt(
	pts: { x: number; y: number }[],
	px: number,
	py: number,
	closed: boolean
): { x: number; y: number }[] {
	const { q, i } = nearestOnPath({ x: px, y: py }, pts, closed);
	if (i < 0) return pts;
	const next = pts.slice();
	next.splice(i + 1, 0, { x: q.x, y: q.y });
	return next;
}

/** Constrains a point to the inside of a polygon (nearest boundary point when
 *  outside), so a node can't be dragged out of its zone. */
function clampToPolygon(p: { x: number; y: number }, pts: { x: number; y: number }[]): { x: number; y: number } {
	return pointInPolygon(p.x, p.y, pts) ? p : nearestOnPath(p, pts, true).q;
}

/** Nearest point on an open polyline (road centerline) to p. */
function nearestOnPolyline(
	p: { x: number; y: number },
	pts: { x: number; y: number }[]
): { x: number; y: number } {
	return nearestOnPath(p, pts, false).q;
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
type MapState = { zones: MapZone[]; images: MapImage[]; labels: MapLabel[] };

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

/** A freshly drawn zone/road's shared defaults — the map's own draw color, no
 *  location/pins yet. The three ways to create one (freeform polygon, road,
 *  rectangle) differ only in `kind`, `points`, and (a road only) its
 *  `startLoc`/`endLoc` and `width`. */
function newZone(
	kind: 'zone' | 'road',
	points: { x: number; y: number }[],
	color: string,
	extra?: Partial<Pick<MapZone, 'startLoc' | 'endLoc' | 'width'>>
): MapZone {
	return {
		id: newId(),
		kind,
		points,
		width: DEFAULT_ROAD_WIDTH,
		color,
		alpha: DEFAULT_ALPHA,
		location: null,
		node: null,
		nodeSize: 'regular',
		doors: [],
		itemPins: [],
		subPins: [],
		locked: false,
		terrain: null,
		name: '',
		named: false,
		savedLoc: null,
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
	/** A free label's panel — anchored to the label itself, so it follows a drag.
	 *  `focus` puts the caret in its text field (double-click opens it that way). */
	| { kind: 'label'; id: string; focus: boolean }
	| null;

export class MapView extends LoomReactView {
	projectRoot: string | null = null;

	getViewType(): string {
		return VIEW_MAP;
	}

	getDisplayText(): string {
		return mapsLabel();
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
	const [camera, setCamera] = useState<Camera>(() => ({ tx: 0, ty: 0, k: DEFAULT_K }));
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
	/** Restores a map page's remembered camera; a page without one opens framing
	 *  everything on it (an empty page: centered at DEFAULT_K). */
	const restoreCamera = useCallback(
		(pageId: string, page: Pick<MapPage, 'zones' | 'images'> | undefined) => {
			const saved = plugin.settings.mapCameras[cameraKey(pageId)];
			if (saved) {
				setCamera(saved);
				return;
			}
			const el = wrapRef.current;
			const w = el?.clientWidth ?? 900;
			const h = el?.clientHeight ?? 600;
			setCamera(
				(page && fitCamera(page.zones, page.images, w, h)) ?? { k: DEFAULT_K, tx: w / 2, ty: h / 2 }
			);
		},
		[plugin, cameraKey]
	);
	useEffect(() => () => window.cancelAnimationFrame(camRaf.current), []);

	// All map pages of the project. The ACTIVE page's zones live in `zones` (the
	// editing working copy); other pages keep their zones in this list. The panel
	// reads page metadata (name / parentId / order) from here.
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
	/** Dragging a sublocation, item or door from the zone menu onto the canvas to
	 *  place its marker (a ghost follows the cursor; drop drops it exactly there).
	 *  `zoneId` null: a map page dragged from the maps drawer — it lands as a door
	 *  in whichever zone is under the cursor. */
	const [pinDrag, setPinDrag] = useState<{
		kind: 'sub' | 'item' | 'door';
		target: string;
		zoneId: string | null;
	} | null>(null);
	const [pinDragPos, setPinDragPos] = useState<{ x: number; y: number; zoneId: string } | null>(null);
	/** Multi-selected vertices: keys `${zoneId}:${index}`. Moved together. */
	const [selectedVerts, setSelectedVerts] = useState<Set<string>>(new Set());
	const selectedVertsRef = useRef(selectedVerts);
	selectedVertsRef.current = selectedVerts;
	// Semantic zoom (see COLLAPSE_PX): each polygon zone's area-equivalent world
	// radius (a road's: half its width), times the zoom, is its on-screen size.
	// Refs only, so the pointer handlers installed once still read the live values.
	const zoneRadii = useMemo(
		() => new Map(zones.map((z) => [z.id, z.kind === 'zone' ? polygonRadius(z.points) : z.width / 2])),
		[zones]
	);
	const zoneRadiiRef = useRef(zoneRadii);
	zoneRadiiRef.current = zoneRadii;
	const [, forceTick] = useState(0);
	/** A polygon zone's on-screen radius (px). */
	const screenR = (z: MapZone): number => (zoneRadiiRef.current.get(z.id) ?? 0) * cameraRef.current.k;
	/** How far a zone has folded into its node: 0 drawn, 1 collapsed. A road
	 *  follows the two zones it connects. */
	const squishOf = (z: MapZone): number => {
		if (z.kind === 'road') return (endSquish(z.startLoc) + endSquish(z.endLoc)) / 2;
		// A zone with no location is terrain (a lake, a forest) — part of the map
		// itself, never folded away.
		if (!z.location) return 0;
		return 1 - smoothstep(COLLAPSE_PX, screenR(z));
	};
	/** Squish of the zone a road end anchors to (its main location's zone). */
	const endSquish = (locLp: string | null | undefined): number => {
		const z = mainLocZone(locLp);
		return z ? squishOf(z) : 0;
	};
	const [draft, setDraft] = useState<{ x: number; y: number }[]>([]);
	const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
	/** Whether the path-draw cursor is snapped onto a location zone's outline
	 *  (then a dot previews where the end will go). */
	const cursorSnap = useRef(false);
	/** Road drawing: the start location's link target, picked with the first click
	 *  (a road runs location→location; the drawn `draft` points are the waypoints). */
	const [roadDraft, setRoadDraft] = useState<{ startLoc: string | null } | null>(null);
	/** Zone whose vertices are editable (left-click select), independent of the
	 *  context menu (right-click only). */
	const [selectedZone, setSelectedZone] = useState<string | null>(null);
	/** A main node selected by clicking it (separate from zone selection) — only
	 *  this highlights the node. */
	const [selectedNode, setSelectedNode] = useState<string | null>(null);
	/** Background image selected by clicking it — outlines it (and, unless locked,
	 *  shows its resize grips). */
	const [selectedImage, setSelectedImage] = useState<string | null>(null);
	/** Free label selected by clicking it (Delete removes it). */
	const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
	/** What's typed in the map search — it also filters the Elements drawer. */
	const [elementQuery, setElementQuery] = useState('');
	// Drawer opening mode per drawer: on hover (default) or on click (the tab or
	// the gap strip toggles it). A per-device UI preference, so it lives in the
	// vault's local storage, not the synced maps file or settings.
	const [drawerClick, setDrawerClick] = useState<Record<Drawer, boolean>>(() => {
		const v: unknown = plugin.app.loadLocalStorage(DRAWER_MODE_KEY);
		const o = v && typeof v === 'object' ? (v as Partial<Record<Drawer, unknown>>) : {};
		return { maps: o.maps === true, elements: o.elements === true };
	});
	const [drawerOpen, setDrawerOpen] = useState<Record<Drawer, boolean>>({ maps: false, elements: false });
	const toggleDrawerMode = (d: Drawer) => {
		const next = { ...drawerClick, [d]: !drawerClick[d] };
		setDrawerClick(next);
		plugin.app.saveLocalStorage(DRAWER_MODE_KEY, next);
		// The button sits inside the open drawer — switching to click mode keeps it
		// out (it was out on hover), instead of snapping it shut under the cursor.
		setDrawerOpen((o) => ({ ...o, [d]: next[d] }));
	};
	const toggleDrawerOpen = (d: Drawer) => {
		if (drawerClick[d]) setDrawerOpen((o) => ({ ...o, [d]: !o[d] }));
	};
	/** The right-click (empty-space) menu, kept inside the canvas. */
	const emptyMenuRef = useRef<HTMLDivElement>(null);
	useKeepInMap(emptyMenuRef);
	// Background images of the active page, and the selected one. A LOCKED image
	// still outlines when clicked — that outline is the only hint that its edge is
	// where its context menu lives — it just has nothing to grab.
	const images = pages.find((p) => p.id === activeId)?.images ?? [];
	const labels = pages.find((p) => p.id === activeId)?.labels ?? [];
	const pageBg = pages.find((p) => p.id === activeId)?.bg ?? null;
	/** Per-view prefix for svg ids (patterns, masks) — two open Maps tabs share a
	 *  document, and each needs its own zoom-dependent pattern tiles. */
	const uid = useMemo(() => newId(), []);
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
	// A folded zone has no focus graph — it's already just a node among nodes, so a
	// web on top of it is noise. Zooming out until it folds retracts an open one.
	useEffect(() => {
		const z = subGraphRef.current ? zonesRef.current.find((zz) => zz.id === subGraphRef.current) : null;
		if (!z || squishOf(z) <= 0.5) return;
		setFocusClosing(z.id);
		setSubGraph(null);
	}, [camera.k]);
	const [menu, setMenu] = useState<Menu>(null);
	/** Where the last menu was opened in world space (a new node lands here). */
	const menuWorld = useRef<{ x: number; y: number } | null>(null);
	/** Hidden file picker for a background-image import, and the world point the
	 *  imported image should be centred on (the menu's open point). */
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pendingImageAt = useRef<{ x: number; y: number } | null>(null);

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
			await ensureFolder(plugin.app, mapsPath.slice(0, mapsPath.lastIndexOf('/')));
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
			restoreCamera(active, activePage);
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
				if (nz.savedLoc?.location === name) nz = { ...nz, savedLoc: null };
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
		// While the outside-delete window still offers to put the note back,
		// keep waiting — clearing now would lose the zone links it restores.
		const scrubWhenDecided = (name: string, path: string) => {
			if (plugin.isDeletePending(path)) pending.push(window.setTimeout(() => scrubWhenDecided(name, path), DELETE_SCRUB_MS));
			else scrubDeleted(name);
		};
		const ref = plugin.app.vault.on('delete', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			const { basename, path } = file;
			pending.push(window.setTimeout(() => scrubWhenDecided(basename, path), DELETE_SCRUB_MS));
		});
		return () => {
			plugin.app.vault.offref(ref);
			pending.forEach((id) => window.clearTimeout(id));
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
	/** The active page's free labels. */
	const activeLabels = useCallback(
		(): MapLabel[] => pagesRef.current.find((p) => p.id === activeIdRef.current)?.labels ?? [],
		[]
	);
	/** Replaces the active page's images and/or labels. `save` false = a live drag
	 *  frame, which updates the view without queueing a write (the drop saves once). */
	const putActive = useCallback(
		(patch: Partial<Pick<MapPage, 'images' | 'labels' | 'bg'>>, save = true) => {
			const pages2 = pagesRef.current.map((p) => (p.id === activeIdRef.current ? { ...p, ...patch } : p));
			pagesRef.current = pages2;
			setPages(pages2);
			if (save) saveLater(zonesRef.current);
		},
		[saveLater]
	);
	const putImages = useCallback((next: MapImage[], save = true) => putActive({ images: next }, save), [putActive]);
	const putLabels = useCallback((next: MapLabel[], save = true) => putActive({ labels: next }, save), [putActive]);
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
			labels: activeLabels().map((l) => ({ ...l })),
		}),
		[activeImages, activeLabels]
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
			putActive({ images: s.images, labels: s.labels }, false);
			saveLater(s.zones);
		},
		[putActive, saveLater]
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
		const ownerWin = wrapRef.current?.win ?? activeWindow;
		ownerWin.addEventListener('pointerup', onUp);
		return () => ownerWin.removeEventListener('pointerup', onUp);
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
			// Each page restores its own remembered camera (a fresh page → fitted).
			restoreCamera(id, target);
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
			const page: MapPage = { id: newId(), name: '', parentId, order, zones: [], images: [], labels: [], bg: null };
			// A brand-new page has no saved camera → activatePage centers it.
			activatePage([...foldActiveZones(), page], page.id);
		},
		[activatePage, foldActiveZones]
	);
	const renameMap = useCallback(
		(id: string, name: string) => {
			commitPages(
				pagesRef.current.map((p) => (p.id === id ? { ...p, name: name.trim() || t('view.map.defaultMapName') } : p))
			);
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
			if ((e.target as HTMLElement).closest('.loom-map-menu, .loom-combo-menu, .loom-map-panel, .loom-map-elements')) return;
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const [minK, maxK] = zoomLimits(
				zonesRef.current,
				pagesRef.current.find((p) => p.id === activeIdRef.current)?.images ?? [],
				rect.width,
				rect.height
			);
			setCamera((c) => {
				// Never snaps: a camera already outside the range (the content changed
				// since) just can't go further out of it.
				const k = Math.max(
					Math.min(minK, c.k),
					Math.min(Math.max(maxK, c.k), c.k * Math.exp(-e.deltaY * 0.0015))
				);
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
		| { kind: 'label-move'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
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
							const pts = z.points.map((p, i) => (idxs.has(i) ? { x: p.x + dvx, y: p.y + dvy } : p));
							return z.kind === 'road' ? reshapeRoad(z, pts) : { ...z, points: pts };
						})
					);
				} else {
					let at = { x: tx, y: ty };
					const zz = zonesRef.current.find((z) => z.id === d.id);
					if (zz?.kind === 'road') {
						// A path end attaches to the location zone it's dragged onto or
						// along (sliding on its outline), and comes free anywhere else —
						// or anywhere with Alt held, like when drawing.
						const end = d.index === 0 ? 'startLoc' : d.index === zz.points.length - 1 ? 'endLoc' : null;
						const link: Partial<Pick<MapZone, 'startLoc' | 'endLoc'>> = {};
						if (end) {
							const az = e.altKey ? null : attachZoneAt(at);
							if (az) at = nearestOnPath(at, az.points, true).q;
							link[end] = az?.location ?? null;
						}
						const pts = zz.points.map((p, i) => (i === d.index ? at : p));
						setZones(zonesRef.current.map((z) => (z.id === d.id ? { ...reshapeRoad(z, pts), ...link } : z)));
					} else {
						setZones(
							zonesRef.current.map((z) =>
								z.id === d.id ? { ...z, points: z.points.map((p, i) => (i === d.index ? at : p)) } : z
							)
						);
					}
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
				if (squishOf(z) > 0.5) {
					// A folded zone IS its node, so dragging the node moves the whole
					// zone.
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
			} else if (d.kind === 'label-move') {
				if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_SLOP) return;
				d.moved = true;
				const dx = w.x - d.last.x;
				const dy = w.y - d.last.y;
				d.last = { x: w.x, y: w.y };
				putLabels(
					activeLabels().map((l) => (l.id === d.id ? { ...l, x: l.x + dx, y: l.y + dy } : l)),
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
			// A folded zone has no focus graph (it's already just a node), so a click
			// there only selects.
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
				if (z && squishOf(z) > 0.5) return;
				if (subGraphRef.current === d.id) closeFocus();
				else {
					setFocusClosing(null);
					setSubGraph(z && z.location ? d.id : null);
				}
				return;
			}
			// Image gestures live in `pages`, so they save the maps file rather than
			// the zones list (which `saveLater` writes alongside it anyway).
			if (d.kind === 'image-resize' || ((d.kind === 'image-move' || d.kind === 'label-move') && d.moved)) {
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
		const ownerWin = wrapRef.current?.win ?? activeWindow;
		ownerWin.addEventListener('pointermove', onMove);
		ownerWin.addEventListener('pointerup', onUp);
		ownerWin.addEventListener('pointercancel', onUp);
		return () => {
			ownerWin.removeEventListener('pointermove', onMove);
			ownerWin.removeEventListener('pointerup', onUp);
			ownerWin.removeEventListener('pointercancel', onUp);
		};
	}, [dragActive, localXY, toWorld, saveLater, activeImages, putImages, activeLabels, putLabels]);

	// --- Canvas pointer (draw / select / pan) --------------------------------
	const onCanvasPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button === 2) return; // right-click → contextmenu handler
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const w = toWorld(sx, sy);
		setMenu(null);

		// Middle-drag pans in every tool, so a drawing tool never traps the camera.
		if (e.button === 1 && tool !== 'select') {
			drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: camera.tx, ty0: camera.ty };
			setDragActive(true);
			return;
		}

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

		// A path (road, river, wall…): each end either SNAPS to a location — a click
		// inside a location zone attaches it there — or is a free point (anywhere
		// else, or anywhere with Alt held). The clicks between are waypoints; a
		// snapped end finishes it, and so does clicking the last point again (or
		// Enter) for a free end.
		if (tool === 'road') {
			if (e.button !== 0) return;
			// A snapped end goes on the outline point nearest the click, and stays there.
			const sz = e.altKey ? null : snapZone(sx, sy);
			const snap = sz?.location ?? null;
			const at = sz ? nearestOnPath(w, sz.points, true).q : { x: w.x, y: w.y };
			if (!roadDraft) {
				setRoadDraft({ startLoc: snap });
				setDraft([at]);
				return;
			}
			if (snap && snap !== roadDraft.startLoc) {
				finishRoad(roadDraft.startLoc, snap, [...draft, at]);
				return;
			}
			if (draft.length > 0) {
				const lastV = screenOf(draft[draft.length - 1].x, draft[draft.length - 1].y);
				if (Math.hypot(lastV.x - sx, lastV.y - sy) < MIN_VERTEX_DIST) {
					if (draft.length >= 2) finishRoad(roadDraft.startLoc, null, draft);
					return;
				}
			}
			setDraft((d) => [...d, { x: w.x, y: w.y }]);
			return;
		}

		// A zone: left-drag moves it, a plain click selects it for editing (vertex
		// handles). The context menu is right-click only. Locked zones only select.
		setSelectedLabel(null);
		const hit = hitZone(sx, sy);
		if (hit) {
			// Pressing a zone selects it (deselecting any other) whether it becomes
			// a move-drag or a plain click.
			setSelectedZone(hit.id);
			setSelectedImage(null);
			if (e.button === 0 && !hit.locked) {
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
				// Locked zones aren't movable — a drag over them pans the camera
				// instead.
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
			// A path's preview line snaps to the location it would attach to.
			const sz = tool === 'road' && !e.altKey ? snapZone(sx, sy) : null;
			const w = toWorld(sx, sy);
			cursorSnap.current = !!sz;
			setCursor(sz ? nearestOnPath(w, sz.points, true).q : w);
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
		await ensureFolder(plugin.app, imagesFolder);
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
		new Notice(t('view.map.importedAtRealSize', { name: created.name }));
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
				.setTitle(im.locked ? t('view.map.imageMenu.unlock') : t('view.map.imageMenu.lockInPlace'))
				.setIcon(im.locked ? 'lock-open' : 'lock')
				.onClick(() => {
					snapshot();
					if (!im.locked) setSelectedImage(null);
					patchImage(im.id, { locked: !im.locked });
				})
		);
		m.addItem((i) =>
			i
				.setTitle(t('view.map.imageMenu.resetToRealSize'))
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
					.setTitle(t('view.map.imageMenu.opacityPercent', { pct }))
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
				.setTitle(t('view.map.imageMenu.bringToFront'))
				.setIcon('arrow-up')
				.onClick(() => {
					snapshot();
					putImages([...activeImages().filter((o) => o.id !== im.id), im]);
				})
		);
		m.addItem((i) =>
			i
				.setTitle(t('view.map.imageMenu.sendToBack'))
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
				.setTitle(t('view.map.imageMenu.removeFromMap'))
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
				const line = roadCenterline(z);
				if (!line) continue;
				const d = distToPolyline(w.x, w.y, line);
				if (d <= z.width / 2 || d * k <= 6) return z;
				continue;
			}
			// A folded zone is just its node — its invisible area doesn't catch presses.
			if (squishOf(z) >= 0.995) continue;
			if (pointInPolygon(w.x, w.y, z.points) || distToPolygon(w.x, w.y, z.points) * k <= 6) {
				return z;
			}
		}
		return null;
	};

	/** Adds a newly drawn zone and opens its menu right away so its location
	 *  can be set. */
	const addZoneWithMenu = (zone: MapZone) => {
		snapshot();
		commit([...zonesRef.current, zone]);
		const ctr = centroid(zone.points);
		menuWorld.current = ctr;
		setSelectedZone(zone.id);
		setMenu({ kind: 'zone', id: zone.id, wx: ctr.x, wy: ctr.y });
	};
	const finishDraft = () => {
		if (draft.length < 3) return;
		const zone = newZone(
			'zone',
			draft.map((p) => ({ ...p })),
			plugin.settings.mapsColor
		);
		addZoneWithMenu(zone);
		setDraft([]);
		setCursor(null);
		setTool('select');
	};
	/** Creates a road connecting two locations, with the drawn waypoints between. */
	const finishRoad = (startLoc: string | null, endLoc: string | null, waypoints: { x: number; y: number }[]) => {
		const road = newZone(
			'road',
			waypoints.map((p) => ({ ...p })),
			plugin.settings.mapsColor,
			{ startLoc, endLoc, width: defaultRoadWidth(startLoc, endLoc) }
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
		const { x0, y0, x1, y1 } = boxOf(a, b);
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
			plugin.settings.mapsColor
		);
		addZoneWithMenu(zone);
	};
	/** Selects every (unlocked) zone vertex inside the marquee box. */
	const selectVertsInBox = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		const { x0, y0, x1, y1 } = boxOf(a, b);
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
	/** The location zone a dragged path end attaches to at a world point: the
	 *  topmost drawn one it's inside of, or within 12px of the outline of. */
	const attachZoneAt = (p: Pt): MapZone | null => {
		const k = cameraRef.current.k;
		for (let i = zonesRef.current.length - 1; i >= 0; i--) {
			const c = zonesRef.current[i];
			if (c.kind !== 'zone' || !c.location || squishOf(c) >= 0.995) continue;
			if (pointInPolygon(p.x, p.y, c.points) || distToPolygon(p.x, p.y, c.points) * k <= 12) return c;
		}
		return null;
	};
	/** The location zone a path end snaps to at a screen point, if any. */
	const snapZone = (sx: number, sy: number): MapZone | null => attachZoneAt(toWorld(sx, sy));
	/** A new road's width: half the radius of the smaller place it connects, so it
	 *  reads as a road beside them on a map of any size; with neither end placed,
	 *  24 px on screen at the current zoom. */
	const defaultRoadWidth = (startLoc?: string | null, endLoc?: string | null): number => {
		const radii = [zoneForLoc(startLoc), zoneForLoc(endLoc)]
			.map((z) => (z ? polygonRadius(z.points) : 0))
			.filter((r) => r > 0);
		return radii.length ? Math.min(...radii) / 2 : 24 / cameraRef.current.k;
	};
	/** The top (main) location's zone — a sublocation folds into its main
	 *  location, so roads anchor there. Falls back to the location's own zone when
	 *  its main isn't placed on this map. */
	const mainLocZone = (locLp: string | null | undefined): MapZone | null => {
		if (!locLp || !project) return zoneForLoc(locLp);
		const loc = plugin.indexer.resolve(locLp, project.loomPath);
		const top = loc ? ([loc, ...plugin.indexer.locationAncestors(loc)].pop() ?? loc) : null;
		return (top ? zoneForLoc(linkTargetOf(top)) : null) ?? zoneForLoc(locLp);
	};
	/** The road as rendered. A road is its own editable zone — `points` is the
	 *  full centerline. Its two ends only drive the VISUAL: while the end zone is
	 *  drawn the first/last segment is clipped to its edge (so the road doesn't
	 *  overlap the zone); as that zone folds the end slides to the main-location
	 *  node. Null when the road has fewer than 2 points. */
	const roadCenterline = (road: MapZone): { x: number; y: number }[] | null => {
		const pts = road.points;
		if (pts.length < 2) return null;
		const last = pts.length - 1;
		const sZone = zoneForLoc(road.startLoc);
		const eZone = zoneForLoc(road.endLoc);
		// An end still inside its zone is clipped to the outline; one already on it
		// (or outside) stays put.
		// An end strictly inside its zone (a path drawn before ends sat on the
		// outline) is clipped to it; one on the outline or outside stays put.
		const inside = (p: Pt, z: MapZone) => pointInPolygon(p.x, p.y, z.points) && distToPolygon(p.x, p.y, z.points) > 1e-6;
		const sReg = sZone && inside(pts[0], sZone) ? boundaryExit(pts[0], pts[1], sZone.points) : pts[0];
		const eReg = eZone && inside(pts[last], eZone) ? boundaryExit(pts[last], pts[last - 1], eZone.points) : pts[last];
		const sTop = mainLocZone(road.startLoc);
		const eTop = mainLocZone(road.endLoc);
		const sMain = sTop ? nodeOf(sTop) : pts[0];
		const eMain = eTop ? nodeOf(eTop) : pts[last];
		const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
		});
		return [
			lerp(sReg, sMain, endSquish(road.startLoc)),
			...pts.slice(1, -1).map((p) => ({ ...p })),
			lerp(eReg, eMain, endSquish(road.endLoc)),
		];
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// Ignore keys while typing in a field (search box, inputs, etc.).
			const focusEl = e.target as HTMLElement | null;
			if (focusEl && (focusEl.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focusEl.tagName))) return;
			// Undo / redo (map-local).
			// By physical key (`code`), so undo works whatever the keyboard layout —
			// with a Russian layout, Ctrl+Z reports `key` 'я'.
			if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
				e.preventDefault();
				if (e.shiftKey) redo();
				else undo();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
				e.preventDefault();
				redo();
				return;
			}
			if ((e.key === 'Delete' || e.key === 'Backspace') && draft.length === 0 && !roadDraft) {
				if (selectedLabel) {
					snapshot();
					putLabels(activeLabels().filter((l) => l.id !== selectedLabel));
					setSelectedLabel(null);
					setMenu(null);
					return;
				}
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
			if (e.key === 'Enter' && roadDraft && draft.length >= 2) {
				finishRoad(roadDraft.startLoc, null, draft);
				return;
			}
			if (e.key !== 'Escape') return;
			if (roadDraft || draft.length > 0) cancelDraft();
			else if (subGraph) closeFocus();
			else if (menu) setMenu(null);
			else if (selectedVertsRef.current.size > 0) setSelectedVerts(new Set());
			else if (selectedNode) setSelectedNode(null);
			else if (selectedZone) setSelectedZone(null);
			else if (selectedImage) setSelectedImage(null);
			else if (selectedLabel) setSelectedLabel(null);
			else if (tool !== 'select') setTool('select');
		};
		const ownerDoc = wrapRef.current?.doc ?? activeDocument;
		ownerDoc.addEventListener('keydown', onKey);
		return () => ownerDoc.removeEventListener('keydown', onKey);
	}, [
		draft.length,
		menu,
		selectedZone,
		selectedNode,
		selectedImage,
		selectedImageObj,
		selectedLabel,
		subGraph,
		tool,
		roadDraft,
		activeImages,
		putImages,
		activeLabels,
		putLabels,
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
	// Region wraps (shown as their places fold): each region's placed locations' ZONES are
	// clustered by proximity, and each cluster gets its own padded convex hull
	// around the actual zone areas (not the collapsed nodes) — so a region wraps
	// the land its locations occupy, and far-apart members wrap separately.
	const regionClusters = useMemo(() => {
		if (!project) return [] as { region: EntityRecord; zones: MapZone[] }[];
		const byRegion = new Map<string, { region: EntityRecord; zones: MapZone[] }>();
		const allNodePts: Pt[] = [];
		for (const z of zones) {
			if (!z.location) continue;
			const loc = plugin.indexer.resolve(z.location, project.loomPath);
			if (loc?.type !== 'location') continue;
			allNodePts.push(nodeOf(z));
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
		const out: { region: EntityRecord; zones: MapZone[] }[] = [];
		for (const { region, zones: rzones } of byRegion.values()) {
			// Cluster the region's zones by their node positions (union-find).
			const nodes = rzones.map((z) => nodeOf(z));
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
				out.push({ region, zones: clusterZones });
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
		for (const { region, zones: cz } of regionClusters) {
			const vertices = cz.flatMap((z) => z.points);
			const uh = convexHull(vertices);
			const base = uh.length >= 3 ? uh : regionHull(vertices, NODE_SIZE_PRESETS.regular);
			if (base.length < 3) continue;
			const ring = resampleRing(base, HULL_N);
			const list = perRegion.get(region.path) ?? [];
			list.push({ region, centroid: centroid(ring), ring, weight: vertices.length });
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
					const pc = centroid(st.get(pk)!.display);
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
	// A region's wrap fades in as its places fold — the mean squish of its zones.
	const regionSquish = new Map<string, number>();
	{
		const sums = new Map<string, { sum: number; n: number }>();
		for (const c of regionClusters) {
			const acc = sums.get(c.region.path) ?? { sum: 0, n: 0 };
			for (const z of c.zones) {
				acc.sum += squishOf(z);
				acc.n++;
			}
			sums.set(c.region.path, acc);
		}
		for (const [path, { sum, n }] of sums) regionSquish.set(path, n ? sum / n : 0);
	}
	const anyFolded = [...regionSquish.values()].some((v) => v > 0.02);
	// Ease display rings toward their targets each frame while any wrap shows; drop
	// vanished clusters after they shrink into their centroid.
	useEffect(() => {
		if (!anyFolded) return;
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
					const c = centroid(s.display);
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
	}, [anyFolded]);

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
				.map((p) => ({ value: p.id, label: p.name || t('view.map.untitledMap') }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[pages, activeId]
	);
	const pageName = (id: string): string => pages.find((p) => p.id === id)?.name || t('view.map.untitledMap');
	/** Where the `count`-th new pin goes: offset diagonally from the zone's
	 *  centre (a fifth of its radius per pin) so several don't fully overlap. */
	const nextPinPos = (zone: MapZone, count: number) => {
		const base = zoneCenter(zone);
		const off = 0.2 * count * (zoneRadiiRef.current.get(zone.id) ?? 0);
		return clampToZone({ x: base.x + off, y: base.y + off }, zone);
	};
	const addDoor = (zone: MapZone, pageId: string) => {
		snapshot();
		const pos = nextPinPos(zone, zone.doors.length);
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
	/** Places (or repositions) a door at a precise point in the zone
	 *  (drag-and-drop drop) — a zone holds at most one door per page. */
	const placeDoorPin = (zone: MapZone, pageId: string, pos: { x: number; y: number }) => {
		snapshot();
		const clamped = clampToZone(pos, zone);
		const idx = zone.doors.findIndex((d) => d.page === pageId);
		updateZone(zone.id, {
			doors:
				idx >= 0
					? zone.doors.map((d, i) => (i === idx ? { ...d, x: clamped.x, y: clamped.y } : d))
					: [...zone.doors, { page: pageId, x: clamped.x, y: clamped.y }],
		});
	};
	/** The zone a pin drag would drop into: the menu's own zone, or — for a
	 *  page dragged from the maps drawer — whichever zone is under the cursor. */
	const pinDragZone = (sx: number, sy: number): MapZone | null =>
		pinDrag?.zoneId ? (zonesRef.current.find((z) => z.id === pinDrag.zoneId) ?? null) : hitZone(sx, sy);
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
	/** A pin target's display name (item or sublocation), else the raw target. */
	const targetName = (target: string): string => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		return rec ? rec.name : target;
	};
	const addItemPin = (zone: MapZone, itemTarget: string) => {
		snapshot();
		const pos = nextPinPos(zone, zone.itemPins.length);
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
	/** Opens the entity a pin targets (item or sublocation). */
	const openTarget = (target: string) => {
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		if (rec) view.openEntity(rec.path);
	};
	// --- Sublocation nodes (a zone's location's sublocations, shown inside) ----
	const sublocationsOf = (zone: MapZone): EntityRecord[] => {
		if (!zone.location || !project) return [];
		const loc = plugin.indexer.resolve(zone.location, project.loomPath);
		if (loc?.type !== 'location') return [];
		// All DESCENDANTS (sublocations, and their sublocations, …).
		const isDescendant = (l: EntityRecord): boolean =>
			plugin.indexer.locationAncestors(l).some((p) => p.path === loc.path);
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
		const pos = nextPinPos(zone, zone.subPins.length);
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
	/** Right-click menu for ONE marker inside a zone (door, item or
	 *  sublocation) — node size is per marker: an item's or sublocation's own
	 *  `size` overrides the zone-derived default, and "Default size" drops back
	 *  to it; a door is just small unless resized. Also opens or removes that
	 *  marker. */
	const openPinMenu = (e: ReactMouseEvent, zone: MapZone, kind: PinKind, index: number) => {
		const key = PIN_LIST[kind];
		const pins: { x: number; y: number; size?: NodeSizePreset }[] = zone[key];
		const pin = pins[index];
		if (!pin) return;
		const current = kind === 'door' ? (pin.size ?? DOOR_SIZE) : pin.size;
		const setPins = (next: typeof pins) => {
			snapshot();
			updateZone(zone.id, { [key]: next });
		};
		const m = new ObsidianMenu();
		for (const [preset, label] of SIZE_OPTIONS) {
			m.addItem((i) =>
				i
					.setTitle(t('view.map.sizeLabel', { label: label() }))
					.setChecked(current === preset)
					.onClick(() => setPins(pins.map((p, j) => (j === index ? { ...p, size: preset } : p))))
			);
		}
		if (pin.size && kind !== 'door')
			m.addItem((i) =>
				i
					.setTitle(t('view.map.defaultSizeMenuItem'))
					.setIcon('rotate-ccw')
					.onClick(() => setPins(pins.map((p, j) => (j === index ? { ...p, size: undefined } : p))))
			);
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle(t(PIN_OPEN_LABEL[kind]))
				.setIcon('square-arrow-out-up-right')
				.onClick(() => openPin(zone, kind, index))
		);
		m.addItem((i) =>
			i
				.setTitle(t('view.map.imageMenu.removeFromMap'))
				.setIcon('trash-2')
				.onClick(() => setPins(pins.filter((_, j) => j !== index)))
		);
		m.showAtPosition({ x: e.clientX, y: e.clientY });
	};
	/** Double-click / "Open": a door switches map page, an item or sublocation
	 *  opens its note. */
	const openPin = (zone: MapZone, kind: PinKind, index: number) => {
		if (kind === 'door') switchMap(zone.doors[index].page);
		else openTarget(kind === 'subpin' ? zone.subPins[index].loc : zone.itemPins[index].item);
	};
	/** One marker inside a zone: squishes with it, fades in once the zone is big
	 *  enough on screen (PINS_PX), drags within it, right-click menu, double-click
	 *  opens. Each kind draws its own `body` (the look stays per kind); the label
	 *  sits `labelGap` screen px below its radius `r` (labels are a constant
	 *  on-screen size, so neighbouring zones' text matches). */
	const renderPin = (
		z: MapZone,
		kind: PinKind,
		i: number,
		at: { x: number; y: number },
		r: number,
		o: { className: string; labelGap: number; fontSize: number; label: string; body: ReactNode }
	) => (
		<g
			key={`${kind}-${z.id}-${i}`}
			className={o.className}
			transform={squishProps(z).transform}
			opacity={pinAlpha(z)}
			onPointerDown={(e) => startPinDrag(e, z.id, kind, i)}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				openPinMenu(e, z, kind, i);
			}}
			onDoubleClick={(e) => {
				e.stopPropagation();
				openPin(z, kind, i);
			}}
		>
			{o.body}
			<text
				x={at.x}
				y={at.y + r * unitOf(z) + o.labelGap / camera.k}
				textAnchor="middle"
				className="loom-map-node-label"
				style={{ fontSize: `${o.fontSize / camera.k}px` }}
			>
				{clampLabel(o.label)}
			</text>
		</g>
	);
	/** A sublocation node's radius in size units: smaller each nesting level below
	 *  the zone's location, floored at `MIN_SUB_NODE_SIZE` — unless that node
	 *  carries its own `size`, which wins outright (per-node sizing). */
	const subPinRadius = (zone: MapZone, locTarget: string, size?: NodeSizePreset): number => {
		if (size) return NODE_SIZE_PRESETS[size];
		const base = NODE_SIZE_PRESETS[zone.nodeSize];
		if (!project) return Math.max(MIN_SUB_NODE_SIZE, base * SUB_NODE_SCALE);
		const zoneLoc = zone.location ? plugin.indexer.resolve(zone.location, project.loomPath) : null;
		const target = plugin.indexer.resolve(locTarget, project.loomPath);
		const ancestors = target ? plugin.indexer.locationAncestors(target) : [];
		const zoneIdx = ancestors.findIndex((p) => p.path === zoneLoc?.path);
		const depth = 1 + (zoneIdx === -1 ? ancestors.length : zoneIdx);
		return Math.max(MIN_SUB_NODE_SIZE, base * Math.pow(SUB_NODE_SCALE, depth));
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
			const frac = Math.min(1, (now - start) / dur);
			// Ease in-out: leaves and arrives calmly, travels fast in between.
			const e = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
			setCamera({
				k: from.k,
				tx: from.tx + (to.tx - from.tx) * e,
				ty: from.ty + (to.ty - from.ty) * e,
			});
			if (frac < 1) camRaf.current = window.requestAnimationFrame(step);
		};
		camRaf.current = window.requestAnimationFrame(step);
	};
	/** Flies to a zone/path (its node, or its centre if it has none) and selects it. */
	const goToZone = (z: MapZone) => {
		const pt = z.location ? nodeOf(z) : zoneCenter(z);
		flyTo(pt.x, pt.y);
		setSelectedLabel(null);
		setSelectedImage(null);
		setSelectedZone(z.id);
	};
	/** Flies to a free label and selects it. */
	const goToLabel = (lb: MapLabel) => {
		flyTo(lb.x, lb.y);
		setSelectedZone(null);
		setSelectedImage(null);
		setSelectedLabel(lb.id);
	};
	/** Eases the camera to frame everything on the page (zones, roads, images). */
	const fitAll = () => {
		const el = wrapRef.current;
		const w = el?.clientWidth ?? 900;
		const h = el?.clientHeight ?? 600;
		const to = fitCamera(zones, images, w, h);
		if (!to) return;
		const from = cameraRef.current;
		// World points at the view centre, before and after.
		const fc = { x: (w / 2 - from.tx) / from.k, y: (h / 2 - from.ty) / from.k };
		const tc = { x: (w / 2 - to.tx) / to.k, y: (h / 2 - to.ty) / to.k };
		const start = performance.now();
		window.cancelAnimationFrame(camRaf.current);
		const step = (now: number) => {
			const frac = Math.min(1, (now - start) / 420);
			const e = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2;
			// Zoom geometrically, centre linearly.
			const k = from.k * Math.pow(to.k / from.k, e);
			const wx = fc.x + (tc.x - fc.x) * e;
			const wy = fc.y + (tc.y - fc.y) * e;
			setCamera({ k, tx: w / 2 - wx * k, ty: h / 2 - wy * k });
			if (frac < 1) camRaf.current = window.requestAnimationFrame(step);
		};
		camRaf.current = window.requestAnimationFrame(step);
	};

	if (!project) {
		return (
			<ViewShell view={view} project={null} title={mapsLabel()}>
				{noProjectMessage()}
			</ViewShell>
		);
	}

	const menuZone = menu?.kind === 'zone' ? zones.find((z) => z.id === menu.id) ?? null : null;
	// Screen anchor for the open menu: zone menus track a world point (so they
	// follow the zone when moved), the empty menu is a fixed screen point.
	const menuLabel = menu?.kind === 'label' ? labels.find((l) => l.id === menu.id) ?? null : null;
	const menuPos =
		menu?.kind === 'zone'
			? screenOf(menu.wx, menu.wy)
			: menu?.kind === 'empty'
				? { x: menu.sx, y: menu.sy }
				: menuLabel
					? screenOf(menuLabel.x, menuLabel.y - menuLabel.size / 2)
					: null;
	/** Collapses a zone's contents toward its node (or centroid) as it folds. */
	const squishProps = (z: MapZone): { transform?: string; opacity?: number } => {
		const squish = squishOf(z);
		if (squish <= 0.001) return { transform: undefined, opacity: undefined };
		const p = nodeOf(z);
		const s = 1 - squish;
		return { transform: `translate(${p.x},${p.y}) scale(${s}) translate(${-p.x},${-p.y})`, opacity: s };
	};
	/** Pointer-down on a door / item pin / sublocation pin: select its zone and
	 *  start dragging it. */
	const startPinDrag = (e: ReactPointerEvent, zoneId: string, kind: PinKind, index: number) => {
		if (tool !== 'select') return;
		if (e.button !== 0) return;
		e.stopPropagation();
		setSelectedZone(zoneId);
		beginPending();
		drag.current = { kind, id: zoneId, index, startX: e.clientX, startY: e.clientY, moved: false };
		setDragActive(true);
	};
	/** World size of one marker size unit for a zone while drawn: scales with the
	 *  zone's on-screen size (MARKER_REF_PX), clamped to MARKER_MIN..MAX. */
	const drawnUnit = (z: MapZone): number =>
		Math.max(MARKER_MIN, Math.min(MARKER_MAX, screenR(z) / MARKER_REF_PX)) / camera.k;
	/** …crossfading to a constant on-screen size as the zone folds. */
	const unitOf = (z: MapZone): number => {
		const sq = squishOf(z);
		return (1 - sq) * drawnUnit(z) + sq / camera.k;
	};
	/** Doors / items / sublocations inside a zone: shown only once the zone is
	 *  big enough on screen to hold them, gone again as it folds. A road has no
	 *  area to measure, so its markers just follow its fold. */
	const pinAlpha = (z: MapZone): number =>
		z.kind === 'road' ? 1 - squishOf(z) : (1 - squishOf(z)) * smoothstep(PINS_PX, screenR(z));

	/** Clear margins around a zone's visible markers and their labels — black
	 *  shapes in its terrain mask, so the texture never runs through a node or
	 *  under text. Mirrors the node/pin/label geometry rendered below. */
	const markerHoles = (z: MapZone): ReactNode[] => {
		const k = camera.k;
		const u = unitOf(z);
		const out: ReactNode[] = [];
		const hole = (key: string, cx: number, cy: number, r: number, label: string, gap: number, font: number) => {
			out.push(<circle key={key} cx={cx} cy={cy} r={r + 4 / k} fill="black" />);
			const text = clampLabel(label);
			if (!text) return;
			const w = (text.length * font * 0.6 + 8) / k;
			const base = cy + r + gap / k;
			out.push(
				<rect key={`${key}-l`} x={cx - w / 2} y={base - (font + 3) / k} width={w} height={(font + 7) / k} rx={3 / k} fill="black" />
			);
		};
		if (z.location) {
			const n = nodeOf(z);
			hole('n', n.x, n.y, NODE_SIZE_PRESETS[z.nodeSize] * u, locationName(z.location), 14, 13);
		} else if (z.named && z.name) {
			const c = zoneCenter(z);
			const w = (z.name.length * 13 * 0.6 + 12) / k;
			out.push(<rect key="name" x={c.x - w / 2} y={c.y - 12 / k} width={w} height={24 / k} rx={4 / k} fill="black" />);
		}
		if (pinAlpha(z) >= 0.02) {
			z.doors.forEach((dr, i) =>
				hole(`d${i}`, dr.x, dr.y, NODE_SIZE_PRESETS[dr.size ?? DOOR_SIZE] * u, pageName(dr.page), 12, 13)
			);
			z.itemPins.forEach((it, i) => hole(`i${i}`, it.x, it.y, itemPinRadius(z, it.size) * u, targetName(it.item), 12, 11));
			z.subPins.forEach((sp, i) => hole(`s${i}`, sp.x, sp.y, subPinRadius(z, sp.loc, sp.size) * u, targetName(sp.loc), 9, 11));
		}
		return out;
	};
	/** Adds a label at a world point, prompting for its text (empty = nothing). */
	const addLabel = (at: { x: number; y: number }) =>
		new TextInputModal(plugin.app, {
			title: t('view.map.labelPromptTitle'),
			cta: t('view.map.addLabel'),
			onSubmit: (v) => {
				if (!v.trim()) return;
				snapshot();
				// 18px on screen at the zoom it was placed at; it scales with the map from there.
				putLabels([...activeLabels(), { id: newId(), x: at.x, y: at.y, text: v.trim(), size: 18 / cameraRef.current.k }]);
			},
		}).open();
	/** Label sizes that stay visible somewhere in the page's zoom range: big
	 *  enough to fade in at full zoom-in, small enough not to fade out at full
	 *  zoom-out — past either, a label could never be seen again. */
	const labelSizeRange = (): [number, number] => {
		const [minK, maxK] = zoomLimits(
			zones,
			images,
			wrapRef.current?.clientWidth ?? 900,
			wrapRef.current?.clientHeight ?? 600
		);
		return [LABEL_IN_PX[1] / maxK, Math.min(SIZE_MAX, LABEL_OUT_PX[0] / minK)];
	};
	const patchLabel = (id: string, patch: Partial<MapLabel>) =>
		putLabels(activeLabels().map((l) => (l.id === id ? { ...l, ...patch } : l)));

	// Vertex handles for a zone/road (when selected or marquee-hit). Rendered in a
	// SEPARATE layer above all zone/road bodies, so a road drawn over a location
	// zone never covers (and blocks clicks on) that zone's handles.
	const renderHandles = (z: MapZone): ReactElement | null => {
		const zoneSel = selectedZone === z.id;
		const hasSelVerts = [...selectedVerts].some((key) => key.startsWith(z.id + ':'));
		if (!(zoneSel || hasSelVerts) || z.locked || squishOf(z) >= 0.02) return null;
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
							className={vSel ? 'loom-map-vertex loom-map-knot loom-map-vertex-sel' : 'loom-map-vertex loom-map-knot'}
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
		<ViewShell view={view} project={project} title={mapsLabel()} railActive="map">
			<div className="loom-map-frame">
			{/* The padding between the nav rail and the canvas: hovering it opens the
			    Maps drawer too, so overshooting the edge tab still works. */}
			<div
				className={drawerClick.maps ? 'loom-map-gap-hover loom-map-gap-click' : 'loom-map-gap-hover'}
				aria-hidden="true"
				onClick={() => toggleDrawerOpen('maps')}
			/>
			<div
				className={
					drawerClick.elements
						? 'loom-map-gap-hover loom-map-gap-hover-right loom-map-gap-click'
						: 'loom-map-gap-hover loom-map-gap-hover-right'
				}
				aria-hidden="true"
				onClick={() => toggleDrawerOpen('elements')}
			/>
			<div
				className={tool !== 'select' ? 'loom-map-wrap loom-map-drawing' : 'loom-map-wrap'}
				ref={wrapRef}
				style={pageBg ? ({ '--loom-map-bg': pageBg } as CSSProperties) : undefined}
			>
				<MapsPanel
					plugin={plugin}
					pages={pages}
					activeId={activeId}
					onSwitch={switchMap}
					onCreate={createMap}
					onRename={renameMap}
					onDelete={deleteMap}
					onNest={nestMap}
					onPageDragStart={(id) => setPinDrag({ kind: 'door', target: id, zoneId: null })}
					onPageDragEnd={() => {
						setPinDrag(null);
						setPinDragPos(null);
					}}
					clickMode={drawerClick.maps}
					open={drawerOpen.maps}
					onToggleMode={() => toggleDrawerMode('maps')}
					onToggleOpen={() => toggleDrawerOpen('maps')}
				/>
				<svg
					className="loom-map-svg"
					onPointerDown={onCanvasPointerDown}
					onPointerMove={onCanvasPointerMove}
					onContextMenu={onContextMenu}
					onDoubleClick={onCanvasDoubleClick}
					onDragOver={(e) => {
						if (!pinDrag) return;
						const { sx, sy } = localXY(e.clientX, e.clientY);
						const zone = pinDragZone(sx, sy);
						if (!zone) {
							setPinDragPos(null);
							return;
						}
						e.preventDefault();
						setPinDragPos({ ...clampToZone(toWorld(sx, sy), zone), zoneId: zone.id });
					}}
					onDrop={(e) => {
						if (!pinDrag) return;
						e.preventDefault();
						const { sx, sy } = localXY(e.clientX, e.clientY);
						const zone = pinDragZone(sx, sy);
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
						{/* Zones layer — a zone too small on screen squishes (warps) into
						    its node and disappears; a road between folded places instead
						    thins into a line so it still shows what it connects. */}
						{zones.map((z) => {
									const isRoad = z.kind === 'road';
									const squish = squishOf(z);
									// Polygon zones fully collapse; roads stay as a line.
									if (!isRoad && squish >= 0.995) return null;
									// A road is rendered along its location→location centerline
									// (clipped to drawn zone edges, anchored to folded zones'
									// nodes); its `points` are only the editable waypoints. Skip
									// when an endpoint isn't on this map.
									const roadLine = isRoad ? roadCenterline(z) : null;
									if (isRoad && (!roadLine || roadLine.length < 2)) return null;
									const stroke = darker(z.color);
									const linePts = isRoad ? (roadLine as Pt[]) : z.points;
									const line = pathD(linePts);
									const d = isRoad ? line : line + ' Z';
									const zoneSel = selectedZone === z.id;

									if (isRoad) {
										// A road: an open, width-rendered centerline (a long box that
										// bends) — outline stroke behind, fill stroke on top. As its
										// places fold it thins toward a constant-screen line (and goes
										// opaque) so it still reads as a connector between the nodes.
										const rw = z.width * (1 - squish) + (3 / camera.k) * squish;
										const rop = z.alpha + (1 - z.alpha) * squish;
										// The zones its ends attach to are cut out of it, so it stops
										// exactly at their outlines (no round cap poking inside), at
										// any angle; the cut-outs fold along with their zones.
										const cuts = [zoneForLoc(z.startLoc), zoneForLoc(z.endLoc)].filter(
											(c): c is MapZone => !!c && squishOf(c) < 0.995
										);
										const cutId = `${uid}-cut-${z.id}`;
										return (
											<g key={z.id} mask={cuts.length ? `url(#${cutId})` : undefined}>
												{cuts.length ? (
													<defs>
														<mask id={cutId} maskUnits="userSpaceOnUse" x={-1e7} y={-1e7} width={2e7} height={2e7}>
															<rect x={-1e7} y={-1e7} width={2e7} height={2e7} fill="white" />
															{cuts.map((c) => (
																<path key={c.id} d={pathD(c.points) + ' Z'} transform={squishProps(c).transform} fill="black" />
															))}
														</mask>
													</defs>
												) : null}
												<path
													d={d}
													fill="none"
													stroke={stroke}
													strokeOpacity={rop}
													// The outline border is a constant screen size; fade it as
													// the road folds so it doesn't dwarf the thinned line.
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
												{/* Surface texture, fading as the path folds to a line. Bricks
												    are dashes, so the blocks follow the road's own direction;
												    a centre line splits them into two courses. Water is the
												    lake tile, stroked along the river. */}
												{z.terrain === 'bricks' && squish < 0.99 ? (
													<g opacity={1 - squish} fill="none" strokeLinejoin="round">
														<path
															d={d}
															stroke={stroke}
															strokeOpacity={0.35}
															strokeWidth={rw * 0.88}
															strokeDasharray={`${rw * 0.42} ${rw * 0.1}`}
														/>
														<path d={d} stroke={z.color} strokeWidth={rw * 0.08} />
													</g>
												) : null}
												{z.terrain === 'water' && squish < 0.99 ? (
													<>
														<defs>
															<pattern
																id={`${uid}-pat-${z.id}`}
																patternUnits="userSpaceOnUse"
																width={TERRAINS.water.tile[0]}
																height={TERRAINS.water.tile[1]}
																patternTransform={`scale(${1 / camera.k})`}
															>
																<path
																	d={TERRAINS.water.d}
																	fill="none"
																	stroke={stroke}
																	strokeOpacity={0.55}
																	strokeWidth={1.2}
																	strokeLinecap="round"
																/>
															</pattern>
														</defs>
														<path
															d={d}
															fill="none"
															stroke={`url(#${uid}-pat-${z.id})`}
															strokeWidth={rw}
															strokeLinejoin="round"
															strokeLinecap="round"
															opacity={1 - squish}
														/>
													</>
												) : null}
											</g>
										);
									}
									const ter = z.terrain && z.terrain !== 'bricks' ? TERRAINS[z.terrain] : null;
									const patId = `${uid}-pat-${z.id}`;
									const maskId = `${uid}-mask-${z.id}`;
									return (
										<g key={z.id} {...squishProps(z)}>
											{ter ? (
												<defs>
													<pattern
														id={patId}
														patternUnits="userSpaceOnUse"
														width={ter.tile[0]}
														height={ter.tile[1]}
														patternTransform={`scale(${1 / camera.k})`}
													>
														<path
															d={ter.d}
															fill="none"
															stroke={stroke}
															strokeOpacity={0.55}
															strokeWidth={1.2}
															strokeLinecap="round"
															strokeLinejoin="round"
														/>
													</pattern>
													<mask id={maskId} maskUnits="userSpaceOnUse" x={-1e7} y={-1e7} width={2e7} height={2e7}>
														<rect x={-1e7} y={-1e7} width={2e7} height={2e7} fill="white" />
														{markerHoles(z)}
													</mask>
												</defs>
											) : null}
											<path
												d={d}
												fill={z.color}
												fillOpacity={z.alpha}
												stroke={stroke}
												strokeWidth={(zoneSel ? 2.5 : 1.5) / camera.k}
											/>
											{ter ? (
												<path d={d} fill={`url(#${patId})`} mask={`url(#${maskId})`} pointerEvents="none" />
											) : null}
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
									const dp = pathD(pts);
									return (
										<g className="loom-map-draft">
											<path
												d={dp}
												fill="none"
												stroke={plugin.settings.mapsColor}
												strokeOpacity={DEFAULT_ALPHA + 0.2}
												strokeWidth={defaultRoadWidth(roadDraft.startLoc)}
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
						{/* Path tool over a location zone: a dot where the end will go (the
						    outline point nearest the cursor), before and during a draft. */}
						{tool === 'road' && cursor && cursorSnap.current ? (
							<circle
								cx={cursor.x}
								cy={cursor.y}
								r={VERTEX_R / camera.k}
								className="loom-map-vertex loom-map-vertex-first"
							/>
						) : null}
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
											pathD(draft) +
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
										pathD(draft) +
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
						{/* Free labels — part of the map, so world-sized; each fades in once
						    readable and out once it would dwarf the view (LABEL_*_PX).
						    Click selects (Delete removes), left-drag moves, right-click
						    opens its panel, double-click opens it on the text field. */}
						{labels.map((lb) => {
							const px = lb.size * camera.k;
							const op = smoothstep(LABEL_IN_PX, px) * (1 - smoothstep(LABEL_OUT_PX, px));
							if (op < 0.02) return null;
							return (
								<text
									key={lb.id}
									className={selectedLabel === lb.id ? 'loom-map-free-label loom-map-free-label-sel' : 'loom-map-free-label'}
									x={lb.x}
									y={lb.y}
									textAnchor="middle"
									dominantBaseline="middle"
									opacity={op}
									style={{ fontSize: `${lb.size}px` }}
									onPointerDown={(e) => {
										if (tool !== 'select' || e.button !== 0) return;
										e.stopPropagation();
										setMenu(null);
										setSelectedLabel(lb.id);
										setSelectedZone(null);
										setSelectedImage(null);
										beginPending();
										const { sx, sy } = localXY(e.clientX, e.clientY);
										drag.current = {
											kind: 'label-move',
											id: lb.id,
											startX: e.clientX,
											startY: e.clientY,
											moved: false,
											last: toWorld(sx, sy),
										};
										setDragActive(true);
									}}
									onDoubleClick={(e) => {
										e.stopPropagation();
										setMenu({ kind: 'label', id: lb.id, focus: true });
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setSelectedLabel(lb.id);
										setMenu({ kind: 'label', id: lb.id, focus: false });
									}}
								>
									{lb.text}
								</text>
							);
						})}
						{/* Region wraps: a padded hull around each cluster of a region's
						    location nodes (far-apart members wrap separately). Drawn from the
						    eased DISPLAY ring (see the hull-morph loop) so a cluster split
						    retracts/grows smoothly instead of snapping. Behind the nodes;
						    fades in as the region's places fold. */}
						{anyFolded
							? [...hullState.current.entries()].map(([key, s]) => {
									if (s.display.length < 3 || s.alpha < 0.02) return null;
									// A modest constant-screen margin, applied to the eased ring;
									// it shrinks with alpha so a vanishing cluster doesn't leave a
									// fixed circle as it collapses.
									const pad = (40 / camera.k) * s.alpha;
									const c = centroid(s.display);
									const padded = s.display.map((p) => {
										const dx = p.x - c.x;
										const dy = p.y - c.y;
										const len = Math.hypot(dx, dy) || 1;
										return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
									});
									const d = pathD(padded) + ' Z';
									const minY = Math.min(...padded.map((p) => p.y));
									const fill = plugin.settings.nodeColors.region;
									const region = s.region;
									return (
										<g
											key={key}
											className="loom-map-region"
											opacity={(regionSquish.get(region.path) ?? 0) * s.alpha}
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
						{/* Nodes layer — always on top of every zone. Right-click falls
						    through to the zone menu; left-drag moves the node (or, once
						    the zone has folded, the whole zone). Only a zone or path
						    linked to a location has a node. */}
						{zones.map((z) => {
							if (!z.node) return null;
							const node = nodeOf(z);
							const stroke = darker(z.color);
							const nodeUnit = unitOf(z);
							const r = NODE_SIZE_PRESETS[z.nodeSize] * nodeUnit;
							// See-through once the zone fills the view, so the focus is on
							// the sublocations within.
							const opacity = 1 - (1 - CLOSEUP_NODE_OPACITY) * smoothstep(CLOSEUP_PX, screenR(z));
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
										fill={stroke}
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
											<path d={SPARKLE_PATH} />
										</g>
									) : null}
									{z.location ? (
										<text
											x={node.x}
											y={node.y + NODE_SIZE_PRESETS[z.nodeSize] * nodeUnit + 14 / camera.k}
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
						{/* Names of unlinked zones and paths (a lake, a river): at the
						    zone's balance centre or the path's midpoint, a constant
						    on-screen size, fading as the zone folds. */}
						{zones.map((z) => {
							if (!z.named || !z.name) return null;
							const sq = squishOf(z);
							if (sq >= 0.99) return null;
							const c = zoneCenter(z);
							return (
								<text
									key={`name-${z.id}`}
									className="loom-map-zone-name"
									x={c.x}
									y={c.y}
									textAnchor="middle"
									dominantBaseline="middle"
									opacity={1 - sq}
									style={{ fontSize: `${13 / camera.k}px` }}
								>
									{z.name}
								</text>
							);
						})}
						{/* Zone markers — doors (portals to other map pages), item pins and
						    sublocation nodes, in that paint order. Double-click opens,
						    right-click sizes/removes, drag repositions within the zone;
						    they fade in once the zone is big enough on screen and squish
						    into its node as it folds (pinAlpha). */}
						{zones
							.filter((z) => pinAlpha(z) >= 0.02)
							.flatMap((z) => {
									const nodeUnit = unitOf(z);
									return z.doors.map((dr, i) => {
										const r = NODE_SIZE_PRESETS[dr.size ?? DOOR_SIZE];
										return renderPin(z, 'door', i, dr, r, {
											className: 'loom-map-door',
											labelGap: 12,
											fontSize: 13,
											label: pageName(dr.page),
											body: (
												<>
													<circle cx={dr.x} cy={dr.y} r={r * nodeUnit} className="loom-map-door-dot" />
													{/* Lucide door-open icon, scaled with the door (24-unit icon). */}
													<g
														className="loom-map-door-glyph"
														transform={`translate(${dr.x},${dr.y}) scale(${(r * 1.25 * nodeUnit) / 24}) translate(-12,-12)`}
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
												</>
											),
										});
									});
								})}
						{zones
							.filter((z) => pinAlpha(z) >= 0.02)
							.flatMap((z) => {
									const nodeUnit = unitOf(z);
									const itemColor = plugin.settings.nodeColors.item;
									return z.itemPins.map((it, i) => {
										const r = itemPinRadius(z, it.size);
										return renderPin(z, 'itempin', i, it, r, {
											className: 'loom-map-door',
											labelGap: 12,
											fontSize: 11,
											label: targetName(it.item),
											body: (
												<>
													<circle cx={it.x} cy={it.y} r={r * nodeUnit} fill={itemColor} className="loom-map-node-dot" />
													<g
														className="loom-map-item-glyph"
														transform={`translate(${it.x},${it.y}) scale(${(r * 1.1 * nodeUnit) / 24}) translate(-12,-12)`}
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
												</>
											),
										});
									});
								})}
						{zones
							.filter((z) => pinAlpha(z) >= 0.02)
							.flatMap((z) => {
									const nodeUnit = unitOf(z);
									const col = darker(z.color);
									return z.subPins.map((sp, i) => {
										const r = subPinRadius(z, sp.loc, sp.size);
										return renderPin(z, 'subpin', i, sp, r, {
											className: 'loom-map-node',
											labelGap: 9,
											fontSize: 11,
											label: targetName(sp.loc),
											body: <circle cx={sp.x} cy={sp.y} r={r * nodeUnit} fill={col} className="loom-map-node-dot" />,
										});
									});
								})}
							{/* Ghost preview while dragging a sublocation/item from the menu. */}
							{pinDrag && pinDragPos
								? (() => {
									const gz = zones.find((z) => z.id === pinDragPos.zoneId);
									const gr =
										(gz
											? pinDrag.kind === 'sub'
												? subPinRadius(gz, pinDrag.target, gz.subPins.find((s) => s.loc === pinDrag.target)?.size)
												: pinDrag.kind === 'door'
													? NODE_SIZE_PRESETS[gz.doors.find((d) => d.page === pinDrag.target)?.size ?? DOOR_SIZE]
													: itemPinRadius(gz, gz.itemPins.find((p) => p.item === pinDrag.target)?.size)
											: 9) * (gz ? unitOf(gz) : 1 / camera.k);
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
						const nodeWorld = nodeOf(fgZone);
						return (
							<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
								<FocusGraphLayer
									plugin={plugin}
									project={project}
									focusPath={fgLoc.path}
									nodeWorld={nodeWorld}
									// The zone's DRAWN marker unit, not `unitOf`: the graph only
									// shows on a drawn zone, and a retraction as it folds would
									// otherwise balloon as that unit crossfades to screen space.
									unit={drawnUnit(fgZone)}
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

				{/* Top-right controls: fit-all + search, in a row. They step aside
				    (left) while the Elements drawer is out. */}
				<div className="loom-map-controls">
					{/* Fit-all sits left of the search, clear of the right edge (where
					    the Elements drawer's hover strip is). */}
					<button className="loom-map-icon-btn loom-map-fit" aria-label={t('view.map.fitAllAria')} onClick={fitAll}>
						<Icon name="maximize" />
					</button>
					<div className="loom-map-search">
						<SearchableSelect
							placeholder={t('view.map.searchPlaceholder')}
							onQueryChange={setElementQuery}
							// Everything on the page with a name: locations, named zones and
							// paths, and free labels — each with its kind as a faded hint.
							options={[
								...zones
									.filter((z) => z.location || (z.named && z.name))
									.map((z) => ({
										value: `zone:${z.id}`,
										label: z.location ? locationName(z.location) : z.name,
										hint: z.location
											? t('view.map.searchKind.location')
											: z.kind === 'road'
												? t('view.map.searchKind.path')
												: t('view.map.searchKind.zone'),
									})),
								...labels.map((lb) => ({
									value: `label:${lb.id}`,
									label: lb.text,
									hint: t('view.map.searchKind.label'),
								})),
							].sort((a, b) => a.label.localeCompare(b.label))}
							onPick={(value) => {
								const id = value.slice(value.indexOf(':') + 1);
								if (value.startsWith('label:')) {
									const lb = labels.find((l) => l.id === id);
									if (lb) goToLabel(lb);
									return;
								}
								const z = zones.find((zz) => zz.id === id);
								if (z) goToZone(z);
							}}
						/>
					</div>
				</div>

				{/* Elements drawer (right) — every element on the page grouped by kind,
				    so nothing is lost even when it's hard to see (an unnamed path, a
				    label faded out at this zoom). A row flies to it and selects it.
				    Slides out on hover like the Maps drawer, pins open. */}
				<ElementsPanel
					query={elementQuery}
					clickMode={drawerClick.elements}
					open={drawerOpen.elements}
					onToggleMode={() => toggleDrawerMode('elements')}
					onToggleOpen={() => toggleDrawerOpen('elements')}
					groups={[
						{
							key: 'locations',
							title: t('view.map.elementsPanel.locations'),
							items: zones
								.filter((z) => z.location)
								.map((z) => ({
									key: z.id,
									label: locationName(z.location),
									hint: z.kind === 'road' ? t('view.map.searchKind.path') : undefined,
									active: selectedZone === z.id,
									onPick: () => goToZone(z),
								})),
						},
						{
							key: 'zones',
							title: t('view.map.elementsPanel.zones'),
							items: zones
								.filter((z) => z.kind === 'zone' && !z.location)
								.map((z) => ({
									key: z.id,
									label: z.named && z.name ? z.name : t('view.map.elementsPanel.unnamedZone'),
									hint: z.terrain && z.terrain !== 'bricks' ? t(`view.map.terrain.${z.terrain}`) : undefined,
									active: selectedZone === z.id,
									onPick: () => goToZone(z),
								})),
						},
						{
							key: 'paths',
							title: t('view.map.elementsPanel.paths'),
							items: zones
								.filter((z) => z.kind === 'road' && !z.location)
								.map((z) => ({
									key: z.id,
									label: z.named && z.name ? z.name : t('view.map.elementsPanel.unnamedPath'),
									hint:
										z.terrain === 'bricks'
											? t('view.map.pathStyle.road')
											: z.terrain === 'water'
												? t('view.map.pathStyle.river')
												: undefined,
									active: selectedZone === z.id,
									onPick: () => goToZone(z),
								})),
						},
						{
							key: 'labels',
							title: t('view.map.elementsPanel.labels'),
							items: labels.map((lb) => ({
								key: lb.id,
								label: lb.text,
								active: selectedLabel === lb.id,
								onPick: () => goToLabel(lb),
							})),
						},
						{
							key: 'images',
							title: t('view.map.elementsPanel.images'),
							items: images.map((im) => ({
								key: im.id,
								label: im.path.slice(im.path.lastIndexOf('/') + 1),
								active: selectedImage === im.id,
								onPick: () => {
									setSelectedZone(null);
									setSelectedLabel(null);
									setSelectedImage(im.id);
									flyTo(im.x + im.w / 2, im.y + im.h / 2);
								},
							})),
						},
					]}
				/>

				{/* Zone context menu (right-click, follows the zone). */}
				{menu?.kind === 'label' && menuLabel && menuPos ? (
					<LabelPanel
						key={menuLabel.id}
						label={menuLabel}
						left={menuPos.x}
						top={menuPos.y}
						focusText={menu.focus}
						sizeRange={labelSizeRange()}
						onEditStart={beginPending}
						onEditEnd={commitPending}
						onText={(text) => patchLabel(menuLabel.id, { text })}
						onTextDone={() => {
							// A label emptied out is removed (inside the same undo step).
							if (!activeLabels().find((l) => l.id === menuLabel.id)?.text.trim()) {
								putLabels(activeLabels().filter((l) => l.id !== menuLabel.id));
								setMenu(null);
							}
							commitPending();
						}}
						onSize={(size) => patchLabel(menuLabel.id, { size })}
						onDelete={() => {
							snapshot();
							putLabels(activeLabels().filter((l) => l.id !== menuLabel.id));
							setSelectedLabel(null);
							setMenu(null);
						}}
					/>
				) : null}
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
						onToggleItem={(val) => toggleItemPin(menuZone, val)}
						onOpenItem={(target) => openTarget(target)}
						onItemDragStart={(val) => setPinDrag({ kind: 'item', target: val, zoneId: menuZone.id })}
						sublocations={sublocationsOf(menuZone).map((l) => ({
							value: linkTargetOf(l),
							label: recordLabel(l, project),
						}))}
						subPinned={new Set(menuZone.subPins.map((sp) => sp.loc))}
						onToggleSub={(loc) => toggleSubPin(menuZone, loc)}
						onOpenSub={(target) => openTarget(target)}
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
						onName={(name) => {
							beginPending();
							updateZone(menuZone.id, { name });
						}}
						onNameDone={commitPending}
						onToggleNamed={() => {
							snapshot();
							const z = menuZone;
							if (!z.named) {
								updateZone(z.id, {
									named: true,
									savedLoc: z.location ? { location: z.location, node: z.node } : z.savedLoc,
									location: null,
									node: null,
								});
								return;
							}
							// Back to the location — the remembered one, unless it's been
							// placed on another zone of this map since (one zone each).
							const back = z.savedLoc && !usedLocations.has(z.savedLoc.location) ? z.savedLoc : null;
							updateZone(z.id, {
								named: false,
								savedLoc: null,
								location: back?.location ?? null,
								node: back ? clampToZone(back.node ?? zoneCenter(z), z) : null,
							});
						}}
						onNodeSize={(size) => {
							snapshot();
							updateZone(menuZone.id, { nodeSize: size });
						}}
						onWidth={(width) => {
							beginPending();
							// Narrowing a road pulls its own node and pins back inside the
							// thinner body — otherwise they're left stranded off the road.
							updateZone(menuZone.id, { width, ...reclampToWidth(menuZone, width) });
						}}
						onResetWidth={() => {
							snapshot();
							const w = defaultRoadWidth(menuZone.startLoc, menuZone.endLoc);
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
						onPreset={(patch) => {
							snapshot();
							updateZone(menuZone.id, patch);
						}}
						onFront={() => {
							snapshot();
							commit([...zonesRef.current.filter((z) => z.id !== menuZone.id), menuZone]);
						}}
						onBack={() => {
							snapshot();
							commit([menuZone, ...zonesRef.current.filter((z) => z.id !== menuZone.id)]);
						}}
						onToggleLock={() => {
							snapshot();
							updateZone(menuZone.id, { locked: !menuZone.locked });
						}}
						onDelete={() => deleteZone(menuZone.id)}
					/>
				) : null}

				{/* Global (empty-space) menu — a VERTICAL list: each row is an icon plus a
				    short label. The draw tools, then labels, then the background-image
				    browser (its own window), split by separators. */}
				{menu?.kind === 'empty' && menuPos ? (
					<div ref={emptyMenuRef} className="loom-map-menu loom-map-menu-vert" style={{ left: menuPos.x, top: menuPos.y }}>
						{(
							[
								['rect', t('view.map.tool.rectangle'), 'square'],
								['draw', t('view.map.tool.polygon'), 'loom-vector-polygon'],
								['road', t('view.map.tool.road'), 'route'],
							] as const
						).map(([tool, title, icon]) => (
							<button
								key={tool}
								className="loom-map-menu-row"
								onClick={() => {
									setMenu(null);
									setTool(tool);
								}}
							>
								<Icon name={icon} />
								<span>{title}</span>
							</button>
						))}
						<div className="loom-map-menu-divider" />
						<button
							className="loom-map-menu-row"
							onClick={() => {
								const at = menuWorld.current;
								setMenu(null);
								if (at) addLabel(at);
							}}
						>
							<Icon name="type" />
							<span>{t('view.map.addLabel')}</span>
						</button>
						<div className="loom-map-menu-divider" />
						<button
							className="loom-map-menu-row"
							onClick={() => {
								// Where the menu was opened is where the image lands.
								const at = menuWorld.current ?? { x: 0, y: 0 };
								setMenu(null);
								new ImagePickerModal(
									plugin,
									importedImages,
									(f) => void placeImage(f, at),
									() => {
										pendingImageAt.current = at;
										fileInputRef.current?.click();
									}
								).open();
							}}
						>
							<Icon name="image" />
							<span>{t('view.map.backgroundImage')}</span>
						</button>
						{/* Icon + swatch only (named by its tooltip), so this row doesn't
						    widen the menu. */}
						<div className="loom-map-menu-row loom-map-menu-row-static">
							<Icon name="paint-bucket" />
							<input
								type="color"
								className="loom-map-color loom-map-bg-color"
								aria-label={t('view.map.backgroundColor')}
								// A colour input needs a hex, so the theme default is read off
								// the canvas itself when the page has no colour of its own.
								value={pageBg ?? cssColorToHex(wrapRef.current ? getComputedStyle(wrapRef.current).backgroundColor : '')}
								onChange={(e) => putActive({ bg: e.target.value })}
							/>
							<button
								className="loom-map-icon-btn loom-map-reset"
								aria-label={t('view.map.resetBackgroundColor')}
								disabled={!pageBg}
								onClick={() => putActive({ bg: null })}
							>
								<Icon name="rotate-ccw" />
							</button>
						</div>
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
					<div className="loom-map-hint">{t('view.map.rightClickHint')}</div>
				) : null}
			</div>
			</div>
		</ViewShell>
	);
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
	pinAriaLabel = t('view.map.showAsNodeAria'),
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
				<span>{t('view.map.columnNode')}</span>
			</div>
			<div className="loom-map-subs-list">
				{filtered.map((o) => (
					<div key={o.value} className="loom-map-doors-row loom-map-subs-row">
						<button
							className="loom-map-doors-open"
							ref={(el) => {
								if (el) setTooltip(el, dragTitle);
							}}
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
							<Icon name={rowIcon} />
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
				{filtered.length === 0 ? <div className="loom-map-subs-more">{t('common.noMatches')}</div> : null}
			</div>
		</div>
	);
}

/** The horizontal per-zone context menu. Style settings (color + transparency)
 *  live behind the palette icon; the rest are icon-only. */
/** A size as typed/shown: whole numbers from 10 up, two decimals below. */
const fmtSize = (v: number): string => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
/** Widest a path, and biggest a label, can be (map units). */
const SIZE_MAX = 5000;

/** A number box with its icon that also scrubs: press and drag inside it —
 *  up/right grows, down/left shrinks, 1% per px (so it feels the same at 2 and
 *  at 2000) or a fixed `step` per px — or click without moving to type. Clamped to min..max; reports every
 *  value live. Named for screen readers by a hidden label, not an aria-label
 *  (Obsidian would turn that into a tooltip). */
function ScrubNumber({
	icon,
	label,
	value,
	min,
	max,
	step,
	onChange,
	onEditStart,
	onEditEnd,
}: {
	icon: string;
	label: string;
	value: number;
	min: number;
	max: number;
	/** Scrub additively by this much per px (a 0–100 percentage, where a
	 *  multiplicative scrub would stick at 0). Omitted: 1% per px. */
	step?: number;
	onChange: (v: number) => void;
	/** Bracket an edit (a scrub, or typing) as one undo step. */
	onEditStart?: () => void;
	onEditEnd?: () => void;
}) {
	const scrub = useRef<{ x: number; y: number; v: number; moved: boolean } | null>(null);
	// While focused the field shows what's being typed, not the reformatted live
	// value (which would fight the caret).
	const [draft, setDraft] = useState<string | null>(null);
	const clamp = (v: number) => Math.max(min, Math.min(max, v));
	return (
		<label className="loom-map-scrub-wrap">
			<Icon name={icon} />
			<span className="loom-sr-only">{label}</span>
			<input
				className={draft === null ? 'loom-map-scrub loom-map-scrub-idle' : 'loom-map-scrub'}
				type="text"
				inputMode="decimal"
				value={draft ?? fmtSize(value)}
				onPointerDown={(e) => {
					// Not focused yet: a press is a scrub (or, without moving, a click
					// that focuses for typing). Once focused it's a normal text field.
					if (e.button !== 0 || draft !== null) return;
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId);
					scrub.current = { x: e.clientX, y: e.clientY, v: value, moved: false };
				}}
				onPointerMove={(e) => {
					const sc = scrub.current;
					if (!sc) return;
					const d = e.clientX - sc.x - (e.clientY - sc.y);
					if (!sc.moved && Math.abs(d) < 3) return;
					if (!sc.moved) {
						sc.moved = true;
						onEditStart?.();
					}
					onChange(clamp(step ? sc.v + d * step : sc.v * Math.pow(1.01, d)));
				}}
				onPointerUp={(e) => {
					const sc = scrub.current;
					scrub.current = null;
					if (!sc) return;
					if (sc.moved) onEditEnd?.();
					else {
						e.currentTarget.focus();
						e.currentTarget.select();
					}
				}}
				onFocus={() => {
					setDraft(fmtSize(value));
					onEditStart?.();
				}}
				onChange={(e) => {
					setDraft(e.target.value);
					const v = parseFloat(e.target.value.replace(',', '.'));
					if (v > 0) onChange(clamp(v));
				}}
				onBlur={() => {
					setDraft(null);
					onEditEnd?.();
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
		</label>
	);
}

/** Right-click panel for a free label: its text, its size (map units, a
 *  ScrubNumber) and delete. Both fields apply live. */
function LabelPanel({
	label,
	left,
	top,
	focusText,
	sizeRange,
	onEditStart,
	onEditEnd,
	onText,
	onTextDone,
	onSize,
	onDelete,
}: {
	label: MapLabel;
	left: number;
	top: number;
	focusText: boolean;
	/** Sizes the label stays visible at somewhere in the page's zoom range. */
	sizeRange: [number, number];
	/** Bracket a live edit as one undo step. */
	onEditStart: () => void;
	onEditEnd: () => void;
	onText: (text: string) => void;
	onTextDone: () => void;
	onSize: (size: number) => void;
	onDelete: () => void;
}) {
	const textRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (focusText) textRef.current?.select();
	}, [focusText]);
	const rootRef = useRef<HTMLDivElement>(null);
	useKeepInMap(rootRef);
	return (
		<div ref={rootRef} className="loom-map-menu loom-map-zone-menu" style={{ left, top }}>
			<input
				ref={textRef}
				className="loom-map-label-text"
				type="text"
				aria-label={t('view.map.labelMenu.text')}
				value={label.text}
				onFocus={onEditStart}
				onChange={(e) => onText(e.target.value)}
				onBlur={onTextDone}
				onKeyDown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
			<span className="loom-map-sep" />
			<ScrubNumber
				icon="a-large-small"
				label={t('view.map.labelMenu.size')}
				value={label.size}
				min={sizeRange[0]}
				max={sizeRange[1]}
				onChange={onSize}
				onEditStart={onEditStart}
				onEditEnd={onEditEnd}
			/>
			<span className="loom-map-sep" />
			<button className="loom-map-icon-btn loom-map-danger" aria-label={t('view.map.labelMenu.delete')} onClick={onDelete}>
				<Icon name="trash-2" />
			</button>
		</div>
	);
}

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
	onName,
	onNameDone,
	onToggleNamed,
	onNodeSize,
	onWidth,
	onResetWidth,
	onColor,
	onAlpha,
	onResetAlpha,
	onPreset,
	onFront,
	onBack,
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
	/** Sets the zone's name (name mode — a zone with no location). */
	onName: (name: string) => void;
	onNameDone: () => void;
	/** Switches between the linked location and the name. */
	onToggleNamed: () => void;
	onNodeSize: (size: NodeSizePreset) => void;
	onWidth: (width: number) => void;
	onResetWidth: () => void;
	onColor: (color: string) => void;
	onAlpha: (alpha: number) => void;
	onResetAlpha: () => void;
	/** Applies a terrain / path-style preset (colour, opacity, texture). */
	onPreset: (patch: Partial<MapZone>) => void;
	/** Stacking order among this page's zones and paths. */
	onFront: () => void;
	onBack: () => void;
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
	const rootRef = useRef<HTMLDivElement>(null);
	useKeepInMap(rootRef);

	return (
		<div ref={rootRef} className="loom-map-menu loom-map-zone-menu" style={{ left, top }}>
			{/* Grip — a drag handle, not a button (no hover box, grab cursor). */}
			<button
				className="loom-map-icon-btn loom-map-grip"
				aria-label={zone.locked ? t('view.map.zoneAria.locked') : t('view.map.zoneAria.moveZone')}
				disabled={zone.locked}
				onPointerDown={onGripDown}
			>
				<Icon name="grip" />
			</button>
			{/* Location or name — one button cycles which identity the zone uses;
			    the other is kept for when it's switched back. */}
			<button
				className="loom-map-icon-btn"
				aria-label={zone.named ? t('view.map.zoneAria.useLocation') : t('view.map.zoneAria.useName')}
				onClick={() => {
					setEditingLoc(false);
					onToggleNamed();
				}}
			>
				<Icon name={zone.named ? 'tag' : 'map-pin'} />
			</button>
			{/* Location association — a road is its own zone too, so it can carry
			    its own location just like a polygon zone (its start/end endpoints
			    are separate, drawing-only). */}
			{zone.named ? (
				<div className="loom-map-loc loom-map-loc-search">
					<input
						className="loom-map-zone-name-input"
						type="text"
						placeholder={t('view.map.zoneAria.namePlaceholder')}
						value={zone.name}
						onChange={(e) => onName(e.target.value)}
						onBlur={onNameDone}
						onKeyDown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
					/>
				</div>
			) : showSearch ? (
				<div className="loom-map-loc loom-map-loc-search">
					<SearchableSelect
						// Keyed on the association state so clearing remounts it empty
						// (its query is seeded on mount, not reset in place).
						key={`${zone.location ?? ''}:${editingLoc}`}
						placeholder={t('view.map.zoneAria.associateLocationPlaceholder')}
						// Don't offer a location that's already placed on this map
						// (except this zone's own current one).
						options={locationOptions.filter(
							(o) => o.value === zone.location || !usedLocations.has(o.value)
						)}
						initialQuery={editingLoc ? locationName : ''}
						// Only grab the caret when changing a link on purpose (the pen
						// button) — a fresh zone may well be terrain, not a location.
						autoFocus={editingLoc}
						onPick={(target) => {
							onPickLocation(target);
							setEditingLoc(false);
						}}
					/>
					{editingLoc ? (
						<button
							className="loom-map-icon-btn"
							aria-label={t('view.entity.faction.clearLocation')}
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
						aria-label={t('view.map.zoneAria.changeLocation')}
						onClick={() => setEditingLoc(true)}
					>
						<Icon name="square-pen" />
					</button>
				</div>
			)}
			<span className="loom-map-sep" />
			{/* Sublocations of the zone’s location, shown as nodes inside it. */}
			{sublocations.length > 0 ? (
				<div className="loom-map-palette">
					<button
						className={openPanel === 'subs' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
						aria-label={t('view.map.zoneAria.sublocationsInZone')}
						onClick={() => togglePanel('subs')}
					>
						<Icon name="list" />
					</button>
					{openPanel === 'subs' ? (
						<ZonePinList
							columnLabel={t('view.map.columnLocation')}
							searchPlaceholder={t('view.map.searchSublocations')}
							dragTitle={t('view.map.dragTitleNode')}
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
					aria-label={t('view.map.zoneAria.doorsToOtherMaps')}
					onClick={() => togglePanel('doors')}
				>
					<Icon name="door-open" />
				</button>
				{openPanel === 'doors' ? (
					<ZonePinList
						columnLabel={t('view.map.columnMap')}
						searchPlaceholder={t('view.map.searchMapPages')}
						dragTitle={t('view.map.dragTitleDoor')}
						rowIcon="door-open"
						pinAriaLabel={t('view.map.showDoorAria')}
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
					aria-label={t('view.map.zoneAria.itemsInZone')}
					onClick={() => togglePanel('items')}
				>
					<Icon name="gem" />
				</button>
				{openPanel === 'items' ? (
					<ZonePinList
						columnLabel={t('view.map.columnItem')}
						searchPlaceholder={t('view.map.searchItems')}
						dragTitle={t('view.map.dragTitleNode')}
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
				<label className="loom-map-size-btn" aria-label={t('view.map.zoneAria.nodeSize')}>
					<select
						className="loom-map-size"
						value={zone.nodeSize}
						onChange={(e) => onNodeSize(e.target.value as NodeSizePreset)}
					>
						{SIZE_OPTIONS.map(([v, l]) => (
							<option key={v} value={v}>
								{l()}
							</option>
						))}
					</select>
				</label>
			) : null}
			<div className="loom-map-palette">
				<button
					className={openPanel === 'style' ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
					aria-label={t('view.map.zoneAria.style')}
					onClick={() => togglePanel('style')}
				>
					<Icon name="palette" />
				</button>
				{openPanel === 'style' ? (
					<div className="loom-map-palette-pop">
						{/* Presets: a polygon's terrain (colour + texture), a path's kind. */}
						<div className="loom-map-palette-row">
							<span>{isRoad ? t('view.map.zoneAria.pathStyle') : t('view.map.zoneAria.terrain')}</span>
							<div className="loom-map-presets">
								{isRoad
									? (Object.keys(PATH_STYLES) as (keyof typeof PATH_STYLES)[]).map((key) => {
											const ps = PATH_STYLES[key];
											const color = ps.color ?? plugin.settings.mapsColor;
											return (
												<button
													key={key}
													className={zone.terrain === ps.texture ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
													aria-label={t(`view.map.pathStyle.${key}`)}
													onClick={() => onPreset({ color, alpha: ps.alpha, terrain: ps.texture })}
												>
													<Icon name={ps.icon} />
												</button>
											);
										})
									: (
										<>
											<button
												className={zone.terrain === null ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
												aria-label={t('view.map.terrain.plain')}
												// Plain = the map's own default look, not just "no texture".
												onClick={() =>
													onPreset({ terrain: null, color: plugin.settings.mapsColor, alpha: DEFAULT_ALPHA })
												}
											>
												<Icon name="square" />
											</button>
											{(Object.keys(TERRAINS) as Terrain[]).map((key) => (
												<button
													key={key}
													className={zone.terrain === key ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
													aria-label={t(`view.map.terrain.${key}`)}
													onClick={() =>
														onPreset({ terrain: key, color: TERRAINS[key].color, alpha: TERRAINS[key].alpha })
													}
												>
													<Icon name={TERRAINS[key].icon} />
												</button>
											))}
										</>
									)}
							</div>
						</div>
						<label className="loom-map-palette-row">
							<span>{t('view.map.zoneAria.color')}</span>
							<input
								type="color"
								value={zone.color}
								onChange={(e) => onColor(e.target.value)}
								className="loom-map-color"
							/>
						</label>
						<div className="loom-map-palette-row">
							<span>{t('view.map.zoneAria.opacity')}</span>
							<ScrubNumber
								icon="blend"
								label={t('view.map.zoneAria.opacity')}
								value={Math.round(zone.alpha * 100)}
								min={0}
								max={100}
								step={1}
								onChange={(v) => onAlpha(Math.round(v) / 100)}
							/>
							<button
								className="loom-map-icon-btn loom-map-reset"
								aria-label={t('view.map.zoneAria.resetTransparency')}
								onClick={onResetAlpha}
							>
								<Icon name="rotate-ccw" />
							</button>
						</div>
						{isRoad ? (
							<div className="loom-map-palette-row">
								<span>{t('view.map.zoneAria.width')}</span>
								<ScrubNumber
									icon="move-horizontal"
									label={t('view.map.zoneAria.width')}
									value={zone.width}
									min={0.5}
									max={SIZE_MAX}
									onChange={onWidth}
								/>
								<button
									className="loom-map-icon-btn loom-map-reset"
									aria-label={t('view.map.zoneAria.resetWidth')}
									onClick={onResetWidth}
								>
									<Icon name="rotate-ccw" />
								</button>
							</div>
						) : null}
					</div>
				) : null}
			</div>
			<span className="loom-map-sep" />
			<button className="loom-map-icon-btn" aria-label={t('view.map.zoneAria.bringToFront')} onClick={onFront}>
				<Icon name="arrow-up-to-line" />
			</button>
			<button className="loom-map-icon-btn" aria-label={t('view.map.zoneAria.sendToBack')} onClick={onBack}>
				<Icon name="arrow-down-to-line" />
			</button>
			<span className="loom-map-sep" />
			<button
				className={zone.locked ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
				aria-label={zone.locked ? t('view.map.zoneAria.unlockZone') : t('view.map.zoneAria.lockZone')}
				onClick={onToggleLock}
			>
				<Icon name={zone.locked ? 'lock' : 'lock-open'} />
			</button>
			<span className="loom-map-sep" />
			<button
				className="loom-map-icon-btn loom-map-danger"
				aria-label={t('view.map.zoneAria.deleteZone')}
				onClick={onDelete}
			>
				<Icon name="trash-2" />
			</button>
		</div>
	);
}

type Drawer = 'maps' | 'elements';
const DRAWER_MODE_KEY = 'loom-map-drawer-click';

/** A drawer's root classes: pinned stays out; click mode turns hover-opening
 *  off and is out only while `open`. */
const drawerClass = (right: boolean, pinned: boolean, clickMode: boolean, open: boolean): string =>
	[
		'loom-map-panel',
		right ? 'loom-map-panel-right' : '',
		pinned ? 'loom-map-panel-pinned' : '',
		clickMode ? 'loom-map-panel-click' : '',
		clickMode && open ? 'loom-map-panel-open' : '',
	]
		.filter(Boolean)
		.join(' ');

/** In click mode, a click on the drawer's tab or hover margin (not its card)
 *  toggles it. */
const drawerTabClick = (clickMode: boolean, onToggleOpen: () => void) => (e: ReactMouseEvent<HTMLDivElement>) => {
	if (clickMode && !(e.target as HTMLElement).closest('.loom-map-panel-inner')) onToggleOpen();
};

/** A drawer header's opening-mode + pin buttons. */
function DrawerButtons({
	pinned,
	onPin,
	clickMode,
	onToggleMode,
}: {
	pinned: boolean;
	onPin: () => void;
	clickMode: boolean;
	onToggleMode: () => void;
}) {
	return (
		<>
			<button
				className="loom-map-icon-btn"
				aria-label={clickMode ? t('view.map.drawerMode.click') : t('view.map.drawerMode.hover')}
				onClick={onToggleMode}
			>
				<Icon name={clickMode ? 'target' : 'circle-dot'} />
			</button>
			<button
				className={pinned ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
				aria-label={pinned ? t('view.map.unpinPanel') : t('view.map.pinPanelOpen')}
				onClick={onPin}
			>
				<Icon name={pinned ? 'pin' : 'pin-off'} />
			</button>
		</>
	);
}

/** Right-click on a drawer's empty space or its tab toggles its pin (like its
 *  pin button); rows, buttons and fields keep their own right-click. */
function pinOnEmptyRightClick(togglePin: () => void) {
	return (e: ReactMouseEvent<HTMLDivElement>) => {
		if ((e.target as HTMLElement).closest('button, input, .loom-map-page-row')) return;
		e.preventDefault();
		togglePin();
	};
}

/** Right-hand drawer listing every element on the page, grouped by kind, each
 *  group collapsible (empty groups left out) — the Maps drawer mirrored: a tab
 *  on the right edge, slides out on hover, pins open. */
function ElementsPanel({
	query,
	clickMode,
	open,
	onToggleMode,
	onToggleOpen,
	groups,
}: {
	/** The map search's text: only matching elements are listed. */
	query: string;
	clickMode: boolean;
	open: boolean;
	onToggleMode: () => void;
	onToggleOpen: () => void;
	groups: {
		key: string;
		title: string;
		items: { key: string; label: string; hint?: string; active: boolean; onPick: () => void }[];
	}[];
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [pinned, setPinned] = useState(false);
	const q = query.trim().toLowerCase();
	const shown = groups
		.map((g) => (q ? { ...g, items: g.items.filter((it) => it.label.toLowerCase().includes(q)) } : g))
		.filter((g) => g.items.length > 0);
	return (
		<div
			className={drawerClass(true, pinned, clickMode, open)}
			onClick={drawerTabClick(clickMode, onToggleOpen)}
			onContextMenu={pinOnEmptyRightClick(() => setPinned((v) => !v))}
		>
			<div className="loom-map-panel-inner">
			<div className="loom-map-panel-head">
				<span className="loom-map-panel-title">{t('view.map.elementsPanel.title')}</span>
				<div className="loom-shell-spacer" />
				<DrawerButtons
					pinned={pinned}
					onPin={() => setPinned((v) => !v)}
					clickMode={clickMode}
					onToggleMode={onToggleMode}
				/>
			</div>
			<div className="loom-map-panel-list">
				{shown.map((g) => {
					const isCollapsed = collapsed.has(g.key);
					return (
						<div key={g.key} className="loom-map-elements-group">
							<button
								className="loom-map-elements-head"
								onClick={() =>
									setCollapsed((cur) => {
										const next = new Set(cur);
										if (next.has(g.key)) next.delete(g.key);
										else next.add(g.key);
										return next;
									})
								}
							>
								<Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
								<span>{g.title}</span>
								<span className="loom-map-elements-count">{g.items.length}</span>
							</button>
							{isCollapsed
								? null
								: g.items
										.slice()
										.sort((a, b) => a.label.localeCompare(b.label))
										.map((it) => (
											<button
												key={it.key}
												className={it.active ? 'loom-map-elements-row loom-map-elements-row-on' : 'loom-map-elements-row'}
												onClick={it.onPick}
											>
												<span>{it.label}</span>
												{it.hint ? <span className="loom-combo-hint">{it.hint}</span> : null}
											</button>
										))}
						</div>
					);
				})}
				{shown.length === 0 ? (
					<div className="loom-map-panel-empty">{q ? t('common.noMatches') : t('view.map.elementsPanel.empty')}</div>
				) : null}
			</div>
			</div>
			<div className="loom-map-panel-edge" aria-hidden="true">
				<Icon name="file-box" />
			</div>
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
	onPageDragStart,
	onPageDragEnd,
	clickMode,
	open,
	onToggleMode,
	onToggleOpen,
}: {
	plugin: LoomLoomPlugin;
	pages: MapPage[];
	activeId: string;
	onSwitch: (id: string) => void;
	onCreate: (parentId?: string | null) => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
	onNest: (dragId: string, targetId: string | null) => void;
	/** A page row started dragging — dropped on a zone it becomes a door
	 *  (never for the active page: a door to the map you're on goes nowhere). */
	onPageDragStart: (id: string) => void;
	onPageDragEnd: () => void;
	/** Opening mode — on hover, or on click (`open` then says whether it's out). */
	clickMode: boolean;
	open: boolean;
	onToggleMode: () => void;
	onToggleOpen: () => void;
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
		while (used.has(t('view.map.newMapNumbered', { n }))) n++;
		return t('view.map.newMapNumbered', { n });
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
				t('view.map.nameExistsTitle'),
				t('view.map.nameExistsDetail', { name: text }),
				() => {
					onRename(id, suggestion);
					setRenaming(null);
				},
				t('view.map.createNamed', { name: suggestion })
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
		menu.addItem((i) => i.setTitle(t('view.map.newMapInside')).setIcon('plus').onClick(() => onCreate(p.id)));
		menu.addItem((i) => i.setTitle(t('view.list.rename')).setIcon('pencil').onClick(() => startRename(p)));
		menu.addItem((i) =>
			i
				.setTitle(t('project.common.delete'))
				.setIcon('trash-2')
				.onClick(() =>
					new ConfirmModal(
						plugin.app,
						t('view.map.deleteMapTitle'),
						t('view.map.deleteMapDetail', { name: p.name }),
						() => onDelete(p.id),
						t('project.common.delete')
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
						e.dataTransfer.effectAllowed = 'copyMove';
						setDragId(p.id);
						if (p.id !== activeId) onPageDragStart(p.id);
					}}
					onDragEnd={() => {
						setDragId(null);
						setDropTarget(null);
						onPageDragEnd();
					}}
					onDragOver={(e) => {
						if (dragId && dragId !== p.id) {
							e.preventDefault();
							setDropTarget(p.id);
						}
					}}
					onDragLeave={() => setDropTarget((cur) => (cur === p.id ? null : cur))}
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
							aria-label={isCollapsed ? t('view.map.expand') : t('view.map.collapse')}
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
							placeholder={t('view.map.newMap')}
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
		<div
			className={drawerClass(false, forceOpen, clickMode, open)}
			onClick={drawerTabClick(clickMode, onToggleOpen)}
			onContextMenu={pinOnEmptyRightClick(() => setPinned((v) => !v))}
		>
			<div className="loom-map-panel-inner">
				<div className="loom-map-panel-head">
					<span className="loom-map-panel-title">{mapsLabel()}</span>
					<div className="loom-shell-spacer" />
					<button className="loom-map-icon-btn" aria-label={t('view.map.newMap')} onClick={() => onCreate(null)}>
						<Icon name="plus" />
					</button>
					<DrawerButtons
						pinned={pinned}
						onPin={() => setPinned((v) => !v)}
						clickMode={clickMode}
						onToggleMode={onToggleMode}
					/>
				</div>
				<input
					className="loom-map-panel-search"
					type="text"
					placeholder={t('view.map.searchMapsPlaceholder')}
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
					{pages.length === 0 ? <div className="loom-map-panel-empty">{t('view.map.noMaps')}</div> : null}
				</div>
			</div>
			<div className="loom-map-panel-edge" aria-hidden="true">
				<Icon name="map" />
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
		case 'act':
			return 7;
		default:
			return 4;
	}
}
const FG_STAGGER = 0.06; // per-layer delay fraction for the web-growth ripple
const FG_LABEL_PX = 13; // label size in unit space (scaled by the view's node unit)

// --- Focus-graph geometry (all in UNIT space — one unit = the regular node
// radius; the renderer multiplies everything by the focused zone's drawn marker
// unit, so the graph sizes like the markers it grows out of).
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

/** Lanes for spans packed lowest-first in start order — `packLanes`
 *  (graph/routing.ts) with every item floored at `first`. */
function laneIndices<T>(items: T[], span: (t: T) => [number, number], first = 0): Map<T, number> {
	return packLanes(
		items.slice().sort((p, q) => span(p)[0] - span(q)[0]),
		span,
		() => first
	);
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
	/** World px per unit — the focused zone's drawn marker unit, so the graph is
	 *  sized like the markers it grows out of. */
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
			const frac = Math.min(1, (now - start) / DUR);
			setProg(from + (to - from) * frac);
			if (frac < 1) raf = window.requestAnimationFrame(step);
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

	const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
	// Layer distance from the focus (0) drives the ripple; region (−1) and deep
	// layers reveal after the focus.
	const layerProg = (layer: number) => {
		const startAt = Math.abs(layer) * FG_STAGGER;
		return easeOut(Math.max(0, Math.min(1, (prog - startAt) / (1 - startAt))));
	};
	// A node's live (animated) world position + its reveal progress. Unit space →
	// world: offsets and radii scale by `unit` (the zone's marker unit), so the
	// graph is proportional to the zone it grows out of.
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
								<path d={SPARKLE_PATH} />
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
