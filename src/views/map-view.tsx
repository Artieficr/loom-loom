import { Notice, ViewStateResult, debounce, normalizePath } from 'obsidian';
import {
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
import type LoomLoomPlugin from '../main';
import { LoomReactView } from './react-view';
import { EntityChip, Icon, SearchableSelect, ViewShell, noProjectMessage, recordLabel } from './common';
import { resolveProject, useIndexVersion } from './hooks';

/** One drawn zone: a polygon associated (optionally) with a location, which
 *  pins a node inside it. */
interface MapZone {
	id: string;
	/** Polygon vertices in world coordinates. */
	points: { x: number; y: number }[];
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
	/** Locked zones can't be moved or reshaped (still selectable). */
	locked: boolean;
}

interface MapData {
	version: number;
	zones: MapZone[];
}

const DEFAULT_ALPHA = 0.35;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const CLOSE_SNAP = 12; // screen px to the first vertex that closes a draft
const VERTEX_R = 5; // handle radius (screen px)
const CLICK_SLOP = 4; // px of movement below which a node press counts as a click
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

function emptyData(): MapData {
	return { version: 1, zones: [] };
}

function newId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Parses persisted map JSON tolerantly. */
function parseMapData(text: string): MapData {
	try {
		const d = JSON.parse(text) as Partial<MapData>;
		if (!d || !Array.isArray(d.zones)) return emptyData();
		const zones: MapZone[] = [];
		for (const z of d.zones) {
			if (!z || !Array.isArray(z.points) || z.points.length < 3) continue;
			zones.push({
				id: typeof z.id === 'string' ? z.id : newId(),
				points: z.points
					.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
					.map((p) => ({ x: p.x, y: p.y })),
				color: typeof z.color === 'string' ? z.color : '#c9a36b',
				alpha: typeof z.alpha === 'number' ? Math.max(0, Math.min(1, z.alpha)) : DEFAULT_ALPHA,
				location: typeof z.location === 'string' ? z.location : null,
				node:
					z.node && Number.isFinite(z.node.x) && Number.isFinite(z.node.y)
						? { x: z.node.x, y: z.node.y }
						: null,
				nodeSize: (['small', 'regular', 'big', 'very-big'] as const).includes(z.nodeSize)
					? z.nodeSize
					: 'regular',
				locked: z.locked === true,
			});
		}
		return { version: 1, zones };
	} catch {
		return emptyData();
	}
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

function centroid(points: { x: number; y: number }[]): { x: number; y: number } {
	const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
	return { x: s.x / points.length, y: s.y / points.length };
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
	useIndexVersion(plugin.indexer);
	const project = resolveProject(plugin.indexer, projectRoot);

	const wrapRef = useRef<HTMLDivElement>(null);
	const [camera, setCamera] = useState<Camera>(
		() =>
			(projectRoot ? plugin.settings.mapCameras[projectRoot] : undefined) ?? {
				tx: 0,
				ty: 0,
				k: MODE_K.regular,
			}
	);
	const cameraRef = useRef(camera);
	cameraRef.current = camera;
	const camRaf = useRef(0);
	// Remember the camera per project (debounced) so returning restores the view.
	const saveCamera = useMemo(
		() =>
			debounce((root: string, cam: Camera) => {
				plugin.settings.mapCameras[root] = cam;
				void plugin.saveSettings();
			}, 400, true),
		[plugin]
	);
	useEffect(() => {
		if (project) saveCamera(project.root, camera);
	}, [camera, project, saveCamera]);
	useEffect(() => () => window.cancelAnimationFrame(camRaf.current), []);

	const [zones, setZones] = useState<MapZone[]>([]);
	const zonesRef = useRef(zones);
	zonesRef.current = zones;
	const [tool, setTool] = useState<'select' | 'draw'>('select');
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
	/** Zone whose vertices are editable (left-click select), independent of the
	 *  context menu (right-click only). */
	const [selectedZone, setSelectedZone] = useState<string | null>(null);
	const [menu, setMenu] = useState<Menu>(null);
	/** Where the last menu was opened in world space (a new node lands here). */
	const menuWorld = useRef<{ x: number; y: number } | null>(null);

	// --- Persistence ---------------------------------------------------------
	const mapPath = useMemo(() => {
		if (!project) return null;
		const base = `${MAPS_FOLDER}/${project.name} Map.json`;
		return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
	}, [project]);

	useEffect(() => {
		if (!mapPath) return;
		let cancelled = false;
		void (async () => {
			const file = plugin.app.vault.getFileByPath(mapPath);
			if (!file) {
				if (!cancelled) setZones([]);
				return;
			}
			try {
				const text = await plugin.app.vault.cachedRead(file);
				if (!cancelled) setZones(parseMapData(text).zones);
			} catch {
				if (!cancelled) setZones([]);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [mapPath, plugin]);

	const saveNow = useCallback(
		async (next: MapZone[]) => {
			if (!mapPath) return;
			const text = JSON.stringify({ version: 1, zones: next } satisfies MapData, null, '\t');
			const existing = plugin.app.vault.getFileByPath(mapPath);
			if (existing) {
				await plugin.app.vault.modify(existing, text);
				return;
			}
			const folder = mapPath.slice(0, mapPath.lastIndexOf('/'));
			if (folder && !plugin.app.vault.getAbstractFileByPath(folder)) {
				try {
					await plugin.app.vault.createFolder(folder);
				} catch {
					/* raced/exists */
				}
			}
			await plugin.app.vault.create(mapPath, text);
		},
		[mapPath, plugin]
	);
	const saveLater = useMemo(() => debounce((next: MapZone[]) => void saveNow(next), 500, true), [saveNow]);

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

	// Wheel zoom around the cursor.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			// Over a menu/dropdown, let the wheel scroll that list instead of zooming.
			if ((e.target as HTMLElement).closest('.loom-map-menu, .loom-combo-menu')) return;
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
		| { kind: 'vertex'; id: string; index: number }
		| { kind: 'grip'; id: string; last: { x: number; y: number } }
		| { kind: 'zone-move'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
		| { kind: 'node'; id: string; startX: number; startY: number; moved: boolean; last: { x: number; y: number } }
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
			if (d.kind === 'vertex') {
				setZones(
					zonesRef.current.map((z) =>
						z.id === d.id
							? { ...z, points: z.points.map((p, i) => (i === d.index ? { x: w.x, y: w.y } : p)) }
							: z
					)
				);
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
									}
								: zz
						)
					);
					setMenu((m) => (m && m.kind === 'zone' && m.id === d.id ? { ...m, wx: m.wx + dx, wy: m.wy + dy } : m));
				} else {
					const clamped = clampToPolygon(w, z.points);
					setZones(zonesRef.current.map((zz) => (zz.id === d.id ? { ...zz, node: clamped } : zz)));
				}
			}
		};
		const onUp = () => {
			const d = drag.current;
			drag.current = null;
			setDragActive(false);
			if (!d) return;
			// Selection was set on press; only persist if something actually moved.
			if (
				d.kind === 'vertex' ||
				d.kind === 'grip' ||
				(d.kind === 'zone-move' && d.moved) ||
				(d.kind === 'node' && d.moved)
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

		if (tool === 'draw') {
			if (e.button !== 0) return;
			if (draft.length >= 3) {
				const first = screenOf(draft[0].x, draft[0].y);
				if (Math.hypot(first.x - sx, first.y - sy) <= CLOSE_SNAP) {
					finishDraft();
					return;
				}
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
		if (e.button === 0 || e.button === 1) {
			drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: camera.tx, ty0: camera.ty };
			setDragActive(true);
		}
	};

	const onCanvasPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (tool !== 'draw') return;
		const { sx, sy } = localXY(e.clientX, e.clientY);
		setCursor(toWorld(sx, sy));
	};

	const onContextMenu = (e: ReactPointerEvent<SVGSVGElement>) => {
		e.preventDefault();
		if (tool === 'draw') {
			cancelDraft();
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

	/** Topmost zone under a screen point (inside or near its outline). */
	const hitZone = (sx: number, sy: number): MapZone | null => {
		const w = toWorld(sx, sy);
		for (let i = zonesRef.current.length - 1; i >= 0; i--) {
			const z = zonesRef.current[i];
			if (
				pointInPolygon(w.x, w.y, z.points) ||
				distToPolygon(w.x, w.y, z.points) * cameraRef.current.k <= 6
			) {
				return z;
			}
		}
		return null;
	};

	const finishDraft = () => {
		if (draft.length < 3) return;
		const zone: MapZone = {
			id: newId(),
			points: draft.map((p) => ({ ...p })),
			color: plugin.settings.mapsColor,
			alpha: DEFAULT_ALPHA,
			location: null,
			node: null,
			nodeSize: 'regular',
			locked: false,
		};
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
	const cancelDraft = () => {
		setDraft([]);
		setCursor(null);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (draft.length > 0) cancelDraft();
			else if (menu) setMenu(null);
			else if (selectedZone) setSelectedZone(null);
			else if (tool === 'draw') setTool('select');
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [draft.length, menu, selectedZone, tool]);

	// --- Zone / node actions -------------------------------------------------
	const deleteZone = (id: string) => {
		commit(zonesRef.current.filter((z) => z.id !== id));
		setMenu(null);
		setSelectedZone(null);
	};
	/** Sets/changes a zone's location, keeping an existing node or dropping a new
	 *  one at the menu-open point. */
	const pickLocation = (zone: MapZone, target: string) => {
		const node = zone.node ?? menuWorld.current ?? centroid(zone.points);
		updateZone(zone.id, { location: target, node });
	};
	const locationOptions = useMemo(
		() =>
			plugin.indexer
				.getAll('location', project?.root)
				.map((r) => ({ value: linkTargetOf(r), label: recordLabel(r, project) }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[plugin, project]
	);
	const openLocation = (target: string | null) => {
		if (!target) return;
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		if (rec) view.openEntity(rec.path);
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

	return (
		<ViewShell view={view} project={project} title={MAPS_LABEL} railActive="map">
			<div className={tool === 'draw' ? 'loom-map-wrap loom-map-drawing' : 'loom-map-wrap'} ref={wrapRef}>
				<svg
					className="loom-map-svg"
					onPointerDown={onCanvasPointerDown}
					onPointerMove={onCanvasPointerMove}
					onContextMenu={onContextMenu}
				>
					<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
						{/* Zones layer — in node view each zone squishes (warps) into
						    its node and disappears, leaving just the nodes. */}
						{squish < 0.995
							? zones.map((z) => {
									const stroke = darker(z.color);
									const d =
										z.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
									const zoneSel = selectedZone === z.id;
									// Collapse the zone toward its node (or centroid) as node
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
											{zoneSel && !z.locked && squish < 0.02
												? z.points.map((p, i) => (
														<circle
															key={i}
															cx={p.x}
															cy={p.y}
															r={VERTEX_R / camera.k}
															className="loom-map-vertex"
															onPointerDown={(e) => {
																e.stopPropagation();
																if (e.button !== 0) return;
																drag.current = { kind: 'vertex', id: z.id, index: i };
																setDragActive(true);
															}}
														/>
													))
												: null}
										</g>
									);
								})
							: null}
						{draft.length > 0 ? (
							<g className="loom-map-draft">
								<path
									d={
										draft.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') +
										(cursor ? ` L${cursor.x},${cursor.y}` : '') +
										(draft.length >= 2 ? ' Z' : '')
									}
									fill={plugin.settings.mapsColor}
									fillOpacity={draft.length >= 2 ? DEFAULT_ALPHA * 0.6 : 0}
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
						{/* Nodes layer — always on top of every zone, screen-space sized
						    (constant apparent size when zooming). Right-click falls
						    through to the zone menu; left-drag moves the node (or, in
						    node view, the whole zone). Unassociated zones show a light-
						    grey placeholder node in node view. */}
						{zones.map((z) => {
							const placeholder = !z.node;
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
										if (e.button !== 0) return; // right-click → zone menu (canvas contextmenu)
										e.stopPropagation();
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
								>
									<circle
										cx={node.x}
										cy={node.y}
										r={r}
										fill={placeholder ? '#bdbdbd' : stroke}
										className={
											selectedZone === z.id ? 'loom-map-node-dot loom-map-node-sel' : 'loom-map-node-dot'
										}
									/>
									{z.location ? (
										<text
											x={node.x}
											y={node.y + (NODE_SIZE_PRESETS[z.nodeSize] + 14) / camera.k}
											textAnchor="middle"
											className="loom-map-node-label"
											style={{ fontSize: `${13 / camera.k}px` }}
										>
											{locationName(z.location)}
										</text>
									) : null}
								</g>
							);
						})}
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
						onOpenLocation={() => openLocation(menuZone.location)}
						onGripDown={(e) => {
							if (menuZone.locked) return;
							const { sx, sy } = localXY(e.clientX, e.clientY);
							drag.current = { kind: 'grip', id: menuZone.id, last: toWorld(sx, sy) };
							setDragActive(true);
						}}
						onPickLocation={(target) => pickLocation(menuZone, target)}
						onClearLocation={() => updateZone(menuZone.id, { location: null, node: null })}
						onNodeSize={(size) => updateZone(menuZone.id, { nodeSize: size })}
						onColor={(color) => updateZone(menuZone.id, { color })}
						onAlpha={(alpha) => updateZone(menuZone.id, { alpha })}
						onResetAlpha={() => updateZone(menuZone.id, { alpha: DEFAULT_ALPHA })}
						onToggleLock={() => updateZone(menuZone.id, { locked: !menuZone.locked })}
						onDelete={() => deleteZone(menuZone.id)}
					/>
				) : null}

				{/* Global (empty-space) menu — icon-only, above cursor. */}
				{menu?.kind === 'empty' && menuPos ? (
					<div className="loom-map-menu" style={{ left: menuPos.x, top: menuPos.y }}>
						<button
							className="loom-map-icon-btn"
							aria-label="Draw a zone"
							onClick={() => {
								setMenu(null);
								setTool('draw');
							}}
						>
							<Icon name="pen-tool" fallback="pencil" />
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
			</div>
		</ViewShell>
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
	onGripDown,
	onPickLocation,
	onOpenLocation,
	onClearLocation,
	onNodeSize,
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
	onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	onPickLocation: (target: string) => void;
	onOpenLocation: () => void;
	onClearLocation: () => void;
	onNodeSize: (size: NodeSizePreset) => void;
	onColor: (color: string) => void;
	onAlpha: (alpha: number) => void;
	onResetAlpha: () => void;
	onToggleLock: () => void;
	onDelete: () => void;
}) {
	const [paletteOpen, setPaletteOpen] = useState(false);
	// Editing the association: unassociated zones show the search directly;
	// associated ones show the location as a clickable chip + a square-pen.
	const [editingLoc, setEditingLoc] = useState(false);
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
			{/* Group: location (chip link) + change pencil. */}
			{showSearch ? (
				<div className="loom-map-loc loom-map-loc-search">
					<SearchableSelect
						// Keyed on the association state so clearing remounts it empty
						// (its query is seeded on mount, not reset in place).
						key={`${zone.location ?? ''}:${editingLoc}`}
						placeholder="Associate a location…"
						options={locationOptions}
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
			{/* Group: node size + style + lock. */}
			{zone.location ? (
				<label className="loom-map-icon-btn loom-map-size-btn" aria-label="Node size">
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
					className={paletteOpen ? 'loom-map-icon-btn loom-filter-active' : 'loom-map-icon-btn'}
					aria-label="Style"
					onClick={() => setPaletteOpen((o) => !o)}
				>
					<Icon name="palette" />
				</button>
				{paletteOpen ? (
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
							<input
								type="range"
								min={0}
								max={1}
								step={0.05}
								value={zone.alpha}
								onChange={(e) => onAlpha(Number(e.target.value))}
							/>
							<button className="loom-reset-btn" aria-label="Reset transparency" onClick={onResetAlpha}>
								<Icon name="rotate-ccw" />
							</button>
						</label>
					</div>
				) : null}
			</div>
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
