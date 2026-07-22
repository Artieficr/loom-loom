import { Menu, Notice, ViewStateResult, debounce, setTooltip } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
	ENTITY_META,
	ENTITY_TYPES,
	EntityRecord,
	EntityType,
	FM,
	GraphCamera,
	PC_TAG,
	QUEST_OUTCOMES,
	TimelineDef,
	VIEW_GRAPH,
} from '../types';
import type { LoomTextSize } from '../settings';
import { ConfirmModal, CreateEntityModal, RelationshipPromptModal } from '../project';
import { extractLinkpath, linkTargetOf } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { LayoutNode, computeGraphLayout } from '../graph/layout';
import { Pt, edgeEndDirs, edgePath, edgeXRange } from '../graph/routing';
import { GraphSidePanel, PANEL_MAX, PANEL_MIN } from '../graph/side-panel';
import { LoomReactView } from './react-view';
import { EntityChip, Icon, SearchableSelect, ViewShell, noProjectMessage, recordLabel } from './common';
import { TimelineStrip } from './timeline-strip';
import { resolveProject, useIndexVersion } from './hooks';

type Camera = GraphCamera;

/** Transient UI state carried through view state so Back restores the graph as left. */
interface GraphUiState {
	camera?: Camera;
	drawerOpen?: boolean;
	drawerHeight?: number;
	panelWidth?: number;
}

export class GraphView extends LoomReactView {
	projectRoot: string | null = null;
	/** Snapshot restored on mount (from setState). */
	restored: GraphUiState = {};
	/** Live snapshot the component keeps in sync (serialized by getState). */
	current: GraphUiState = {};

	getViewType(): string {
		return VIEW_GRAPH;
	}

	getDisplayText(): string {
		return 'Loom';
	}

	getIcon(): string {
		return 'spool';
	}

	getState(): Record<string, unknown> {
		return { project: this.projectRoot, ...this.current };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as ({ project?: unknown } & GraphUiState) | null;
		if (typeof s?.project === 'string') this.projectRoot = s.project;
		const cam = s?.camera;
		if (cam && typeof cam.tx === 'number' && typeof cam.ty === 'number' && typeof cam.k === 'number') {
			this.restored.camera = cam;
		}
		if (typeof s?.drawerOpen === 'boolean') this.restored.drawerOpen = s.drawerOpen;
		if (typeof s?.drawerHeight === 'number') this.restored.drawerHeight = s.drawerHeight;
		if (typeof s?.panelWidth === 'number') this.restored.panelWidth = s.panelWidth;
		await super.setState(state, result);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <Graph key={this.projectRoot ?? ''} view={this} projectRoot={this.projectRoot} />;
	}
}

const RADII = { session: 26, event: 20, global: 17 } as const;
/** Pointer movement below this is a click (select/clear), above it a drag/pan. */
const CLICK_SLOP = 4;
/** World-space margin outside the viewport before nodes are culled. */
const CULL_MARGIN = 250;
// Very low floor so large graphs can be zoomed out to fit — effectively
// unlimited for practical project sizes (a hard 0 would let the view collapse).
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 3;
/** Focus-pulse ring (screen px, zoom-independent) and its period. */
const FOCUS_RING_R = 15;
const FOCUS_PULSE_MS = 1700;
/** Screen-space padding the selected node keeps from the viewport edges. */
const REVEAL_MARGIN = 90;
/** World-space margin around a node's circle within which a dragged node snaps to it as a drop target. */
const DROP_SNAP = 12;
/** Trash sector: drop radius (screen px) from the viewport's bottom-right
 *  corner, and the distance at which the sector starts fading in. */
const TRASH_R = 110;
const TRASH_REVEAL = 260;

interface Displacement {
	dx: number;
	dy: number;
	vx: number;
	vy: number;
	dragging: boolean;
}

interface DragState {
	id: string;
	node: LayoutNode;
	pointerId: number;
	startX: number;
	startY: number;
	moved: boolean;
	/** Dragged node's current world position (kept for live-reflow rebasing). */
	worldX: number;
	worldY: number;
	lastClientX: number;
	lastClientY: number;
}

interface PanState {
	pointerId: number;
	startX: number;
	startY: number;
	tx0: number;
	ty0: number;
	moved: boolean;
}

const DRAWER_MIN = 120;
const DRAWER_MAX = 520;

/** Estimated node-label font size (px) per text-size setting: labels render
 *  at 0.8em of the view base (compact 13px, normal 16px, large 19.2px). The
 *  layout's label-overlap checker scales with this. */
const LABEL_FONT_PX: Record<LoomTextSize, number> = {
	compact: 10.4,
	normal: 12.8,
	large: 15.4,
};

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

/** SVG polygon points for an arrowhead whose tip sits at `tip`, pointing along `dir`. */
function arrowPoints(tip: Pt, dir: Pt, size: number): string {
	const bx = tip.x - dir.x * size;
	const by = tip.y - dir.y * size;
	const px = -dir.y * size * 0.45;
	const py = dir.x * size * 0.45;
	return `${tip.x},${tip.y} ${bx + px},${by + py} ${bx - px},${by - py}`;
}

function Graph({ view, projectRoot }: { view: GraphView; projectRoot: string | null }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const project = resolveProject(plugin.indexer, projectRoot);
	const layerKey = plugin.settings.globalLayerOrder.join(',');
	/** Bumped when a drag-reorder writes a new manual x, to re-run the layout. */
	const [manualVersion, setManualVersion] = useState(0);
	/** Transient manual-x override while a reorder drag is in flight — the
	 *  layout reflows live under the cursor instead of only after the drop. */
	const liveManual = useRef<{ id: string; x: number; y: number } | null>(null);
	const liveLayoutRaf = useRef(0);
	const scheduleLiveLayout = () => {
		if (liveLayoutRaf.current) return;
		liveLayoutRaf.current = window.requestAnimationFrame(() => {
			liveLayoutRaf.current = 0;
			setManualVersion((v) => v + 1);
		});
	};
	// Entity pick filter: hand-picked entities (+ their connections) are the only
	// ones shown. Empty = inactive. `pickTransitive` extends to connections of
	// connections; `pickSeparate` re-lays out just the subgraph instead of hiding
	// the rest in place.
	const [pickedPaths, setPickedPaths] = useState<ReadonlySet<string>>(new Set());
	const [pickSeparate, setPickSeparate] = useState(false);

	const runLayout = (restrictTo?: ReadonlySet<string>) =>
		computeGraphLayout(
			plugin.indexer,
			project?.root ?? ' none',
			plugin.settings.globalLayerOrder,
			plugin.settings.graphLineGap,
			new Map<string, number>([
				...Object.entries(project ? plugin.settings.graphManualX[project.root] ?? {} : {}),
				...(liveManual.current ? [[liveManual.current.id, liveManual.current.x] as const] : []),
			]),
			plugin.settings.graphTrunkGap,
			LABEL_FONT_PX[plugin.settings.textSize],
			liveManual.current?.id,
			new Map<string, number>([
				...Object.entries(project ? plugin.settings.graphManualY[project.root] ?? {} : {}),
				...(liveManual.current ? [[liveManual.current.id, liveManual.current.y] as const] : []),
			]),
			restrictTo
		);

	const fullLayout = useMemo(
		() => runLayout(),
		// layerKey stands in for the order array (mutated in place by settings).
		[
			plugin.indexer,
			version,
			project,
			layerKey,
			plugin.settings.graphLineGap,
			plugin.settings.graphTrunkGap,
			plugin.settings.textSize,
			manualVersion,
		]
	);

	// The visible node set when the entity pick is active: the picks plus their
	// direct neighbors, or the whole reachable closure when transitive.
	const pickedVisible = useMemo<ReadonlySet<string> | null>(() => {
		if (pickedPaths.size === 0) return null;
		// The picks plus their level-1 neighbors (what a left-click focus reveals),
		// unioned across the picks. Deeper hops would pull in nearly the whole
		// interconnected graph, so the focus stays one level out.
		const seen = new Set<string>();
		for (const p of pickedPaths) {
			if (!plugin.indexer.get(p)) continue;
			seen.add(p);
			for (const n of fullLayout.neighbors.get(p) ?? []) seen.add(n);
		}
		return seen;
	}, [pickedPaths, fullLayout, plugin]);

	// In "separate graph" mode the picked subgraph is laid out on its own;
	// otherwise the full layout stays and the rest is hidden in place.
	const subLayout = useMemo(
		() => (pickedVisible && pickSeparate ? runLayout(pickedVisible) : null),
		[pickedVisible, pickSeparate, fullLayout]
	);
	const layout = subLayout ?? fullLayout;

	const [selected, setSelected] = useState<string | null>(null);
	// Esc clears the selection (right-click focus otherwise needs an
	// empty-space click to dismiss).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setSelected(null);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);
	/** Graph search: matching nodes highlight, everything else dims. */
	const [search, setSearch] = useState('');
	/** Graph filter: unticked types are dimmed or hidden per the eye mode. */
	const [filterOpen, setFilterOpen] = useState(false);
	const filterRef = useRef<HTMLDivElement>(null);
	// Close the filter popover on any press outside it (the button lives inside
	// the ref, so its own toggle still works).
	useEffect(() => {
		if (!filterOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [filterOpen]);
	const [filterTypes, setFilterTypes] = useState<ReadonlySet<EntityType>>(new Set(ENTITY_TYPES));
	const [filterMode, setFilterMode] = useState<'dim' | 'hide'>('dim');
	const [camera, setCamera] = useState<Camera>(
		() =>
			view.restored.camera ??
			(project ? plugin.settings.graphCameras[project.root] : undefined) ?? { tx: 0, ty: 0, k: 1 }
	);
	const [size, setSize] = useState({ w: 1200, h: 700 });
	const [, setTick] = useState(0);
	/** True while a node is being dragged. Drives the window-level pointer
	 *  listeners that own the drag (see the effect below) — the node's own
	 *  element can't, because a re-render can unmount it mid-drag and drop the
	 *  pointer capture, freezing the drag. */
	const [dragActive, setDragActive] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(view.restored.drawerOpen ?? false);
	// Restored via Back navigation (view state) or, across restarts, from settings.
	const [drawerHeight, setDrawerHeight] = useState(
		view.restored.drawerHeight ?? plugin.settings.timelineDrawerHeight ?? 240
	);
	const [panelWidth, setPanelWidth] = useState(
		clamp(view.restored.panelWidth ?? PANEL_MIN, PANEL_MIN, PANEL_MAX)
	);
	const [drawerResizing, setDrawerResizing] = useState(false);
	const [defPath, setDefPath] = useState('');
	/** "No confirmation mode": mirror of the inverse of confirmTimelineMove, so
	 *  the drawer-bar toggle re-renders. TimelineStrip reads the setting live. */
	const [noConfirm, setNoConfirm] = useState(!plugin.settings.confirmTimelineMove);
	/** Timeline camera scale (1 = full; lower zooms the strip out). */
	const [timelineZoom, setTimelineZoom] = useState(1);
	/** Instant, bubble-styled tooltip for the no-confirm toggle (Obsidian's
	 *  setTooltip lags on hover; this mirrors the event tooltip). */
	const [confirmTip, setConfirmTip] = useState<{ x: number; y: number; body: HTMLElement } | null>(
		null
	);
	const drawerDrag = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);
	/** True once a bar drag resized the drawer — the click that follows must not toggle. */
	const drawerBarMoved = useRef(false);
	const drawerBarRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (drawerBarRef.current) {
			setTooltip(drawerBarRef.current, drawerOpen ? 'Collapse timeline' : 'Open timeline', {
				placement: 'top',
			});
		}
	}, [drawerOpen]);

	const wrapRef = useRef<HTMLDivElement>(null);
	const cameraRef = useRef(camera);
	cameraRef.current = camera;

	// Keep the view's serializable snapshot in sync so navigating away and
	// back (entity page Back button) restores the graph exactly as left.
	// The camera is also remembered per project across sessions.
	const persistCamera = useMemo(
		() =>
			debounce((root: string, cam: Camera) => {
				plugin.settings.graphCameras[root] = cam;
				void plugin.saveSettings();
			}, 800, true),
		[plugin]
	);
	// Persist the drawer height to settings so it survives an Obsidian restart
	// (view state alone only covers same-session Back navigation).
	const persistDrawerHeight = useMemo(
		() =>
			debounce((h: number) => {
				plugin.settings.timelineDrawerHeight = h;
				void plugin.saveSettings();
			}, 500, true),
		[plugin]
	);
	useEffect(() => {
		view.current = { camera, drawerOpen, drawerHeight, panelWidth };
		if (project) persistCamera(project.root, camera);
		persistDrawerHeight(drawerHeight);
	}, [view, camera, drawerOpen, drawerHeight, panelWidth, project, persistCamera, persistDrawerHeight]);
	const dispRef = useRef(new Map<string, Displacement>());
	const dragRef = useRef<DragState | null>(null);
	/** Node id the currently dragged node hovers over (drop-to-connect target). */
	const dropRef = useRef<string | null>(null);
	/** A reorder drop waiting for the relayout, so the node eases from where it
	 *  was released to its new home instead of jumping. */
	const pendingReorder = useRef<{ id: string; x: number; y: number } | null>(null);
	const panRef = useRef<PanState | null>(null);
	const springRaf = useRef(0);
	const cameraRaf = useRef(0);

	// Track the viewport size (also fires when the side panel mounts/unmounts).
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
		update();
		const resize = new ResizeObserver(update);
		resize.observe(el);
		return () => resize.disconnect();
	}, []);

	// Wheel zoom around the cursor. Native listener: React's synthetic wheel
	// events are passive, so preventDefault would be ignored.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			setCamera((c) => {
				const k = clamp(c.k * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
				const wx = (px - c.tx) / c.k;
				const wy = (py - c.ty) / c.k;
				return { k, tx: px - wx * k, ty: py - wy * k };
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, []);

	useEffect(
		() => () => {
			window.cancelAnimationFrame(springRaf.current);
			window.cancelAnimationFrame(cameraRaf.current);
		},
		[]
	);

	const animateCamera = (target: Camera) => {
		window.cancelAnimationFrame(cameraRaf.current);
		const from = cameraRef.current;
		const start = performance.now();
		const duration = 250;
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / duration);
			const e = 1 - (1 - t) * (1 - t);
			setCamera({
				tx: from.tx + (target.tx - from.tx) * e,
				ty: from.ty + (target.ty - from.ty) * e,
				k: from.k + (target.k - from.k) * e,
			});
			if (t < 1) cameraRaf.current = window.requestAnimationFrame(step);
		};
		cameraRaf.current = window.requestAnimationFrame(step);
	};

	const focusNode = (node: LayoutNode) => {
		const el = wrapRef.current;
		const w = el?.clientWidth ?? size.w;
		const h = el?.clientHeight ?? size.h;
		const k = plugin.settings.graphFocusZoom;
		animateCamera({ k, tx: w / 2 - node.x * k, ty: h / 2 - node.y * k });
	};

	const fitNodes = (nodes: LayoutNode[]) => {
		const el = wrapRef.current;
		if (!el || nodes.length === 0) return;
		const pad = 60;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x);
			maxX = Math.max(maxX, n.x);
			minY = Math.min(minY, n.y);
			maxY = Math.max(maxY, n.y);
		}
		minX -= pad;
		maxX += pad;
		minY -= pad;
		// Extra room below for the bottom row's labels.
		maxY += pad + 24;
		const w = el.clientWidth;
		const h = el.clientHeight;
		const k = clamp(Math.min(w / (maxX - minX), h / (maxY - minY)), MIN_ZOOM, 1.25);
		animateCamera({ k, tx: (w - (minX + maxX) * k) / 2, ty: (h - (minY + maxY) * k) / 2 });
	};
	const fitAll = () => fitNodes(layout.nodes);

	// Re-frame the view when the focus filter changes the rendered coordinate
	// space: entering (or changing) the separate subgraph frames it; leaving it
	// with picks still set frames those picks in the global layout; clearing the
	// focus frames the whole graph again. Without this the camera stays put and
	// can end up over empty space.
	const prevFocusRef = useRef<{ separate: boolean; count: number }>({ separate: false, count: 0 });
	useEffect(() => {
		const prev = prevFocusRef.current;
		const count = pickedPaths.size;
		prevFocusRef.current = { separate: pickSeparate, count };
		if (prev.count > 0 && count === 0) {
			fitNodes(fullLayout.nodes); // focus cleared → whole graph
			return;
		}
		if (count === 0) return;
		const modeChanged = prev.separate !== pickSeparate;
		if (pickSeparate) {
			// Entered separate mode, or its subgraph's picks changed → frame it.
			if (modeChanged || prev.count !== count) fitNodes(layout.nodes);
		} else if (modeChanged && pickedVisible) {
			// Back to in-place with picks set → frame the focused nodes.
			fitNodes(fullLayout.nodes.filter((n) => pickedVisible.has(n.id)));
		}
	}, [pickSeparate, pickedPaths]);

	// Spring loop: released nodes ease back to their home position.
	const startSpring = () => {
		window.cancelAnimationFrame(springRaf.current);
		const step = () => {
			let active = false;
			for (const [id, d] of dispRef.current) {
				if (d.dragging) continue;
				d.vx = (d.vx - d.dx * 0.14) * 0.8;
				d.vy = (d.vy - d.dy * 0.14) * 0.8;
				d.dx += d.vx;
				d.dy += d.vy;
				if (Math.abs(d.dx) < 0.5 && Math.abs(d.dy) < 0.5 && Math.abs(d.vx) < 0.5 && Math.abs(d.vy) < 0.5) {
					dispRef.current.delete(id);
				} else {
					active = true;
				}
			}
			setTick((t) => t + 1);
			if (active) springRaf.current = window.requestAnimationFrame(step);
		};
		springRaf.current = window.requestAnimationFrame(step);
	};

	// --- Node interaction ----------------------------------------------------

	const onNodePointerDown = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		if (e.button !== 0) {
			// Keep right/middle presses on a node away from the pan handler.
			e.stopPropagation();
			// Middle click opens the node in a new tab (right click zoom-focuses).
			if (e.button === 1) {
				e.preventDefault();
				view.openEntity(node.id, true);
			}
			return;
		}
		e.stopPropagation();
		// No setPointerCapture: capturing on the node <g> is exactly what broke —
		// a re-render that unmounts it drops the capture and freezes the drag.
		// The drag is owned by window listeners (gated on dragActive) instead.
		dragRef.current = {
			id: node.id,
			node,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			moved: false,
			worldX: node.x,
			worldY: node.y,
			lastClientX: e.clientX,
			lastClientY: e.clientY,
		};
		const d = dispRef.current.get(node.id) ?? { dx: 0, dy: 0, vx: 0, vy: 0, dragging: true };
		d.dragging = true;
		d.vx = 0;
		d.vy = 0;
		dispRef.current.set(node.id, d);
		setDragActive(true);
	};

	/** Bails out of a drag whose pointerup never arrived (canceled pointer,
	 *  lost capture): clears the state and springs everything home. Without
	 *  this, a later button-less hover re-entered the move handler and the
	 *  node stayed glued to the cursor. */
	const abortDrag = () => {
		const drag = dragRef.current;
		if (!drag) {
			setDragActive(false);
			return;
		}
		dragRef.current = null;
		dropRef.current = null;
		setDragActive(false);
		const hadLive = liveManual.current !== null;
		liveManual.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (hadLive) setManualVersion((v) => v + 1);
		startSpring();
	};

	/** Drags whose drop would persist a manual x (globals + free events) —
	 *  these get the live reflow preview while in flight. */
	const isReorderDrag = (node: LayoutNode) =>
		node.kind === 'global' ||
		(node.kind === 'event' &&
			node.record.date === null &&
			(layout.neighbors.get(node.id)?.size ?? 0) === 0);

	const onNodePointerMove = (e: PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		if (e.buttons === 0) {
			// The release was missed — treat this stray move as it.
			abortDrag();
			return;
		}
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		drag.moved = true;
		drag.lastClientX = e.clientX;
		drag.lastClientY = e.clientY;
		const d = dispRef.current.get(drag.id);
		if (d) {
			// Pointer deltas are screen px; node displacement is world space.
			d.dx = dx / cameraRef.current.k;
			d.dy = dy / cameraRef.current.k;
			// Drop-to-connect: does the dragged node's center sit on another node?
			const cx = drag.node.x + d.dx;
			const cy = drag.node.y + d.dy;
			drag.worldX = cx;
			drag.worldY = cy;
			let target: string | null = null;
			for (const n of layout.nodes) {
				if (n.id === drag.id) continue;
				const nd = dispRef.current.get(n.id);
				const nx = n.x + (nd?.dx ?? 0);
				const ny = n.y + (nd?.dy ?? 0);
				if (Math.hypot(nx - cx, ny - cy) <= RADII[n.kind] + DROP_SNAP) {
					target = n.id;
					break;
				}
			}
			dropRef.current = target;
			// Live reflow: everything the drop would rearrange (row reorder,
			// free-event repel, edge routing) follows the drag in real time.
		if (isReorderDrag(drag.node) && project) {
				liveManual.current = { id: drag.id, x: cx, y: cy };
				scheduleLiveLayout();
			}
			setTick((t) => t + 1);
		}
	};

	const onNodePointerUp = (e: PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) {
			setDragActive(false);
			return;
		}
		dragRef.current = null;
		setDragActive(false);
		const dropId = dropRef.current;
		dropRef.current = null;
		const hadLive = liveManual.current !== null;
		liveManual.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.moved) {
			// Trash sector drop: confirm, then move the note to the trash.
			const cam = cameraRef.current;
			const trashDist = Math.hypot(
				size.w - (drag.worldX * cam.k + cam.tx),
				size.h - (drag.worldY * cam.k + cam.ty)
			);
			if (trashDist < TRASH_R) {
				if (hadLive) setManualVersion((v) => v + 1);
				startSpring();
				new ConfirmModal(
					plugin.app,
					`Delete "${recordLabel(drag.node.record, project ?? null)}"?`,
					'The note is moved to the trash.',
					() => {
						const file = plugin.app.vault.getFileByPath(drag.id);
						if (file) void plugin.app.fileManager.trashFile(file);
					},
					'Delete'
				).open();
				return;
			}
			const target = dropId !== null ? layout.nodes.find((n) => n.id === dropId) : undefined;
			if (target) {
				// Undo the live preview — a connect drop doesn't keep the spot.
				if (hadLive) setManualVersion((v) => v + 1);
				startSpring();
				onNodeDrop(drag.node, target, { x: e.clientX, y: e.clientY });
			} else if (isReorderDrag(drag.node) && project && d) {
				// Reorder drop: persisted for globals and for free events
				// (dateless + unconnected — they float outside the column
				// flow); the layout decides its weight — free-floating
				// components follow the drop (towing their neighbors),
				// timeline-anchored ones ease back home (their forces win).
				// The live preview already reflowed everything; this makes it
				// stick.
			const forProject = (plugin.settings.graphManualX[project.root] ??= {});
				forProject[drag.id] = drag.worldX;
				// Fully-unconnected nodes hold their vertical spot too.
				if ((layout.neighbors.get(drag.id)?.size ?? 0) === 0) {
					(plugin.settings.graphManualY[project.root] ??= {})[drag.id] = drag.worldY;
				}
				void plugin.saveSettings();
				pendingReorder.current = { id: drag.id, x: drag.worldX, y: drag.worldY };
				setManualVersion((v) => v + 1);
			} else {
				if (hadLive) setManualVersion((v) => v + 1);
				startSpring();
			}
		} else {
			dispRef.current.delete(drag.id);
			setSelected((cur) => (cur === drag.id ? null : drag.id));
		}
	};

	// A node drag lives on window listeners, not the node's element + pointer
	// capture: a re-render (index refresh, live reflow) can unmount/replace the
	// captured <g>, which drops the capture and used to freeze the drag (then the
	// node sprang back home). The window can't be unmounted, so the drag survives
	// every re-render. `dragHandlers` keeps the latest closures so the once-per-
	// drag listeners always call fresh state.
	const dragHandlers = useRef<{
		move: (e: PointerEvent) => void;
		up: (e: PointerEvent) => void;
		abort: () => void;
	}>({ move: () => {}, up: () => {}, abort: () => {} });
	dragHandlers.current = { move: onNodePointerMove, up: onNodePointerUp, abort: abortDrag };
	useEffect(() => {
		if (!dragActive) return;
		const move = (e: PointerEvent) => dragHandlers.current.move(e);
		const up = (e: PointerEvent) => dragHandlers.current.up(e);
		const cancel = () => dragHandlers.current.abort();
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
		};
	}, [dragActive]);

	// --- Drop-to-connect -------------------------------------------------------

	/** Does `from`'s own note declare a relationship pointing at `toId`? */
	const declaresConnection = (from: LayoutNode, toId: string): boolean => {
		const hits = (linkpath: string) => plugin.indexer.resolve(linkpath, from.id)?.path === toId;
		return from.record.relationships.some((r) => hits(r.linkpath));
	};

	/** Writes to a node's frontmatter with error reporting. */
	const writeNodeFm = (node: LayoutNode, apply: (fm: Record<string, unknown>) => void) => {
		const file = plugin.app.vault.getFileByPath(node.id);
		if (!file) return;
		plugin.app.fileManager.processFrontMatter(file, apply).catch((err) => {
			console.error('Loom Loom: failed to update frontmatter', err);
			new Notice('Could not save the change.');
		});
	};

	/** Frontmatter value as a link list (accepts a single string too). */
	const linkList = (raw: unknown): unknown[] =>
		Array.isArray(raw) ? raw : typeof raw === 'string' && raw !== '' ? [raw] : [];

	/** Adds a `[[link]]` to the event's first session note's `involved`/`places`
	 *  list, creating a session-less note if the event has none yet (mirrors the
	 *  entity page's "Add an event" behaviour). */
	const addToEventNote = (event: LayoutNode, other: LayoutNode, key: 'involved' | 'places') => {
		const link = `[[${linkTargetOf(other.record)}]]`;
		writeNodeFm(event, (fm) => {
			const cur = fmLoomValue(fm, FM.sessionNotes);
			const arr: unknown[] = Array.isArray(cur) ? [...(cur as unknown[])] : [];
			if (arr.length === 0) {
				arr.push({ session: '', text: '', seq: Date.now(), [key]: [link] });
			} else {
				const first = arr[0];
				const note: Record<string, unknown> =
					typeof first === 'object' && first !== null
						? { ...(first as Record<string, unknown>) }
						: { session: '', text: typeof first === 'string' ? first : '' };
				const list = Array.isArray(note[key]) ? [...(note[key] as unknown[])] : [];
				list.push(link);
				note[key] = list;
				arr[0] = note;
			}
			setLoomKey(fm, FM.sessionNotes, arr);
		});
	};

	/** Node-on-node drop. Pairs with a dedicated field offer to fill it — those
	 *  writes go to the note that OWNS the field (a character dropped on a quest
	 *  edits the quest's giver list), which is the natural direction there. The
	 *  generic relationship stays dragged-note-declares. One option acts
	 *  immediately; several open a menu at the drop point. */
	const onNodeDrop = (from: LayoutNode, to: LayoutNode, at: { x: number; y: number }) => {
		const fromLabel = recordLabel(from.record, project);
		const toLabel = recordLabel(to.record, project);
		const resolvesFrom = (node: LayoutNode) => (linkpath: string) =>
			plugin.indexer.resolve(linkpath, node.id)?.path;
		const options: { title: string; action: () => void }[] = [];

		const pair = (typeA: string, typeB: string): { a: LayoutNode; b: LayoutNode } | null =>
			from.record.type === typeA && to.record.type === typeB
				? { a: from, b: to }
				: from.record.type === typeB && to.record.type === typeA
					? { a: to, b: from }
					: null;

		const questChar = pair('quest', 'character');
		if (questChar) {
			const { a: quest, b: char } = questChar;
			const resolve = resolvesFrom(quest);
			if (!quest.record.questGivers.some((lp) => resolve(lp) === char.id)) {
				options.push({
					title: 'Add as quest giver',
					action: () =>
						writeNodeFm(quest, (fm) => {
							setLoomKey(fm, FM.questGiver, [
								...linkList(fmLoomValue(fm, FM.questGiver)),
								`[[${linkTargetOf(char.record)}]]`,
							]);
						}),
				});
			}
		}

		// Faction ↔ character: add the character to the faction's members list
		// (plain link → default "Member" role, editable on either page).
		const factionChar = pair('faction', 'character');
		if (factionChar) {
			const { a: faction, b: char } = factionChar;
			const resolve = resolvesFrom(faction);
			if (!faction.record.members.some((m) => resolve(m.linkpath) === char.id)) {
				options.push({
					title: 'Add as member',
					action: () =>
						writeNodeFm(faction, (fm) => {
							setLoomKey(fm, FM.members, [
								...linkList(fmLoomValue(fm, FM.members)),
								`[[${linkTargetOf(char.record)}]]`,
							]);
						}),
				});
			}
		}

		// Item ↔ character/location: add the item to the holder's items list.
		for (const holderType of ['character', 'location'] as const) {
			const itemHolder = pair('item', holderType);
			if (!itemHolder) continue;
			const { a: item, b: holder } = itemHolder;
			const resolve = resolvesFrom(holder);
			if (holder.record.items.some((lp) => resolve(lp) === item.id)) continue;
			options.push({
				title: 'Add item',
				action: () =>
					writeNodeFm(holder, (fm) => {
						setLoomKey(fm, FM.items, [
							...linkList(fmLoomValue(fm, FM.items)),
							`[[${linkTargetOf(item.record)}]]`,
						]);
					}),
			});
		}

		const questSession = pair('quest', 'session');
		if (questSession) {
			const { a: quest, b: session } = questSession;
			const resolve = resolvesFrom(quest);
			const link = `[[${linkTargetOf(session.record)}]]`;
			if (
				quest.record.questReceived === null ||
				resolve(quest.record.questReceived) !== session.id
			) {
				options.push({
					title: 'Set as received session',
					action: () =>
						writeNodeFm(quest, (fm) => {
							setLoomKey(fm, FM.questReceived, link);
						}),
				});
			}
			for (const outcome of QUEST_OUTCOMES) {
				const alreadySet =
					quest.record.questOutcome === outcome &&
					quest.record.questOutcomeSession !== null &&
					resolve(quest.record.questOutcomeSession) === session.id;
				if (alreadySet) continue;
				options.push({
					title: `${outcome[0].toUpperCase() + outcome.slice(1)} in this session`,
					action: () =>
						writeNodeFm(quest, (fm) => {
							setLoomKey(fm, FM.questOutcome, outcome);
							setLoomKey(fm, FM.questOutcomeSession, link);
						}),
				});
			}
		}

		// Quest ↔ item: append the item as a reward (the reward is a free-form
		// markdown field, so a `[[item]]` link is added on its own line).
		const questItem = pair('quest', 'item');
		if (questItem) {
			const { a: quest, b: item } = questItem;
			const link = `[[${linkTargetOf(item.record)}]]`;
			if (!quest.record.reward.includes(linkTargetOf(item.record))) {
				options.push({
					title: 'Add as reward',
					action: () =>
						writeNodeFm(quest, (fm) => {
							const cur = fmLoomValue(fm, FM.reward);
							const text = typeof cur === 'string' ? cur : '';
							setLoomKey(fm, FM.reward, text.trim() === '' ? link : `${text}\n${link}`);
						}),
				});
			}
		}

		// Event ↔ any involvable entity: add it to the event's first session note
		// (creating one if the event has none). Locations can be BOTH involved
		// (a place discussed in the event) and a `places` entry (where it
		// happened, surfaced on the location page), so a location offers both.
		const eventOther =
			from.record.type === 'event' && to.record.type !== 'event' && to.record.type !== 'session'
				? { event: from, other: to }
				: to.record.type === 'event' && from.record.type !== 'event' && from.record.type !== 'session'
					? { event: to, other: from }
					: null;
		if (eventOther) {
			const { event, other } = eventOther;
			const onNote = (key: 'involved' | 'places') =>
				event.record.sessionNotes.some((n) =>
					(key === 'places' ? n.places : [...n.involved, ...n.group]).some(
						(lp) => plugin.indexer.resolve(lp, event.id)?.path === other.id
					)
				);
			if (!onNote('involved')) {
				options.push({ title: 'Involve in event', action: () => addToEventNote(event, other, 'involved') });
			}
			if (other.record.type === 'location' && !onNote('places')) {
				options.push({ title: 'Add as place', action: () => addToEventNote(event, other, 'places') });
			}
		}

		// Any node ↔ session: offer a session note on the non-session side
		// (empty text, filled in on its page) alongside the generic relationship;
		// a PC also gets "Mark as attending" (the session's attendance list).
		const sessionPair =
			from.record.type === 'session' && to.record.type !== 'session'
				? { session: from, other: to }
				: to.record.type === 'session' && from.record.type !== 'session'
					? { session: to, other: from }
					: null;
		if (sessionPair) {
			const { session, other } = sessionPair;
			if (
				other.record.type === 'character' &&
				other.record.loomTags.includes(PC_TAG) &&
				!session.record.attendance.some(
					(lp) => plugin.indexer.resolve(lp, session.id)?.path === other.id
				)
			) {
				options.push({
					title: 'Mark as attending',
					action: () =>
						writeNodeFm(session, (fm) => {
							setLoomKey(fm, FM.attendance, [
								...linkList(fmLoomValue(fm, FM.attendance)),
								`[[${linkTargetOf(other.record)}]]`,
							]);
						}),
				});
			}
			const has = other.record.sessionNotes.some(
				(n) => n.session !== null && plugin.indexer.resolve(n.session, other.id)?.path === session.id
			);
			if (!has) {
				options.push({
					title: 'Add session note',
					action: () =>
						writeNodeFm(other, (fm) => {
							const cur = fmLoomValue(fm, FM.sessionNotes);
							const notes = Array.isArray(cur) ? cur : [];
							notes.push({ session: `[[${linkTargetOf(session.record)}]]`, text: '', seq: Date.now() });
							setLoomKey(fm, FM.sessionNotes, notes);
						}),
				});
			}
		}

		// Location on location: offer to make the DRAGGED one a sublocation of
		// the target (its whole child hierarchy moves along), unless that's
		// already its parent or it would create a cycle; the generic
		// relationship below stays the alternative.
		if (from.record.type === 'location' && to.record.type === 'location') {
			const parentPathOf = (r: EntityRecord): string | undefined =>
				r.parentLocation !== null
					? plugin.indexer.resolve(r.parentLocation, r.path)?.path
					: undefined;
			const descendsFrom = (r: EntityRecord, ancestor: string): boolean => {
				let cur: EntityRecord | undefined = r;
				for (let guard = 0; guard < 20 && cur; guard++) {
					const parentPath = parentPathOf(cur);
					if (parentPath === undefined) return false;
					if (parentPath === ancestor) return true;
					cur = plugin.indexer.get(parentPath);
				}
				return false;
			};
			const alreadyChild = parentPathOf(from.record) === to.id;
			const wouldCycle = descendsFrom(to.record, from.id);
			if (!alreadyChild && !wouldCycle) {
				options.push({
					title: `Make sublocation of ${toLabel}`,
					action: () =>
						writeNodeFm(from, (fm) => {
							setLoomKey(fm, FM.parentLocation, `[[${linkTargetOf(to.record)}]]`);
						}),
				});
			}
		}

		// Generic relationship: which note declares it is configurable — by
		// default the drop target (dropping A on B adds A into B), optionally
		// the dragged note (connecting A to B).
		const declarer = plugin.settings.graphDropEdits === 'dragged' ? from : to;
		const other = declarer === from ? to : from;
		const declarerLabel = declarer === from ? fromLabel : toLabel;
		const otherLabel = declarer === from ? toLabel : fromLabel;
		if (declaresConnection(declarer, other.id)) {
			options.push({
				title: 'Remove relationship…',
				action: () =>
					new ConfirmModal(
						plugin.app,
						'Remove relationship',
						`Remove the relationship ${declarerLabel} declares to ${otherLabel}?`,
						() => removeConnection(declarer, other),
						'Remove'
					).open(),
			});
		} else {
			options.push({
				title: 'Add relationship…',
				action: () =>
					new RelationshipPromptModal(plugin.app, declarerLabel, otherLabel, (relType) => {
						writeNodeFm(declarer, (fm) => {
							const cur = fmLoomValue(fm, FM.relationships);
							const rels = Array.isArray(cur) ? cur : [];
							rels.push({ type: relType, target: `[[${linkTargetOf(other.record)}]]` });
							setLoomKey(fm, FM.relationships, rels);
						});
					}).open(),
			});
		}

		if (options.length === 1) {
			options[0].action();
			return;
		}
		const menu = new Menu();
		for (const opt of options) {
			menu.addItem((item) => item.setTitle(opt.title).onClick(opt.action));
		}
		menu.showAtPosition(at);
	};

	/** Removes `node`'s own typed relationship entries pointing at `other`
	 *  (the declaring side per the drop-edits setting). The other side's
	 *  declarations stay. */
	const removeConnection = async (node: LayoutNode, other: LayoutNode) => {
		const resolvesToOther = (linkpath: string) =>
			plugin.indexer.resolve(linkpath, node.id)?.path === other.id;
		const file = plugin.app.vault.getFileByPath(node.id);
		if (!file) return;
		try {
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.relationships);
				if (Array.isArray(cur)) {
					setLoomKey(
						fm,
						FM.relationships,
						cur.filter((rel: unknown) => {
							if (typeof rel !== 'object' || rel === null) return true;
							const target = (rel as { target?: unknown }).target;
							if (typeof target !== 'string') return true;
							const linkpath = extractLinkpath(target);
							return linkpath === null || !resolvesToOther(linkpath);
						})
					);
				}
			});
		} catch (err) {
			console.error('Loom Loom: failed to remove connection', err);
			new Notice('Could not remove the connection.');
		}
	};

	// --- Background pan (any mouse button) ------------------------------------

	const onSvgPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		window.cancelAnimationFrame(cameraRaf.current);
		// Right click opens the create menu (see onSvgContextMenu), not a pan.
		if (e.button === 2) return;
		// Middle click would otherwise start autoscroll.
		if (e.button === 1) e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		panRef.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			tx0: cameraRef.current.tx,
			ty0: cameraRef.current.ty,
			moved: false,
		};
	};

	const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		const pan = panRef.current;
		if (!pan || pan.pointerId !== e.pointerId) return;
		const dx = e.clientX - pan.startX;
		const dy = e.clientY - pan.startY;
		if (!pan.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		pan.moved = true;
		setCamera((c) => ({ ...c, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
	};

	const onSvgPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
		const pan = panRef.current;
		if (!pan || pan.pointerId !== e.pointerId) return;
		panRef.current = null;
		if (!pan.moved && e.button === 0) setSelected(null);
	};

	const onSvgContextMenu = (e: ReactMouseEvent<SVGSVGElement>) => {
		e.preventDefault();
		if (!project) return;
		const menu = new Menu();
		for (const type of ENTITY_TYPES) {
			menu.addItem((item) =>
				item
					.setTitle(`New ${ENTITY_META[type].label.toLowerCase()}`)
					.setIcon(ENTITY_META[type].icon)
					.onClick(() =>
						new CreateEntityModal(plugin, type, project, {
							// Stay on the graph — opening the new page would break
							// the flow; double-clicking the node opens it anytime.
							onCreated: () => {},
						}).open()
					)
			);
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};

	// --- Derived render data ---------------------------------------------------

	const connectedTo = useMemo(() => {
		if (!selected) return null;
		const set = new Set(layout.neighbors.get(selected) ?? []);
		set.add(selected);
		return set;
	}, [selected, layout]);

	const filterActive = filterTypes.size < ENTITY_TYPES.length;
	const passesFilter = (n: LayoutNode) => filterTypes.has(n.record.type);
	// Entity pick, in-place mode: anything outside the picked-visible set is
	// removed outright (separate mode already lays out only that set).
	const pickHidden = (id: string) =>
		pickedVisible !== null && !pickSeparate && !pickedVisible.has(id);

	const searchMatches = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (q === '') return null;
		return new Set(
			layout.nodes
				.filter((n) => recordLabel(n.record, project).toLowerCase().includes(q))
				.map((n) => n.id)
		);
	}, [search, layout, project]);
	// Matches in reading order (left→right) — the virtual list Prev/Next step
	// through and All fits.
	const searchResults = useMemo(
		() =>
			searchMatches
				? layout.nodes
						.filter((n) => searchMatches.has(n.id))
						.sort((a, b) => a.x - b.x || a.y - b.y)
				: [],
		[searchMatches, layout]
	);
	// Cursor into searchResults; null until Prev/Next is first pressed.
	const [searchIdx, setSearchIdx] = useState<number | null>(null);
	useEffect(() => setSearchIdx(null), [search]);
	const focusSearchAt = (idx: number) => {
		const n = searchResults.length;
		if (n === 0) return;
		const i = ((idx % n) + n) % n;
		setSearchIdx(i);
		focusNode(searchResults[i]);
	};
	// First Next → first result; first Prev → last result.
	const searchNext = () => focusSearchAt(searchIdx === null ? 0 : searchIdx + 1);
	const searchPrev = () => focusSearchAt(searchIdx === null ? searchResults.length - 1 : searchIdx - 1);

	const viewRange = useMemo(
		() => ({
			min: (0 - camera.tx) / camera.k - CULL_MARGIN,
			max: (size.w - camera.tx) / camera.k + CULL_MARGIN,
		}),
		[camera, size]
	);
	const visible = useMemo(
		() =>
			new Set(
				layout.nodes.filter((n) => n.x >= viewRange.min && n.x <= viewRange.max).map((n) => n.id)
			),
		[layout, viewRange]
	);

	const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
	const selectedRecord = selected ? plugin.indexer.get(selected) : undefined;
	// Link vocabulary for the side panel's read-only description (rendered links).
	const panelLinkNames = useMemo(
		() =>
			project
				? plugin.indexer
						.getAll(undefined, project.root)
						.map((r) => {
							const target = linkTargetOf(r);
							const label = r.type === 'session' ? recordLabel(r, project) : r.name;
							return { label, insert: target === label ? label : `${target}|${label}` };
						})
						.sort((a, b) => a.label.localeCompare(b.label))
				: [],
		[plugin, project, version]
	);

	// When selecting shrinks the viewport (side panel mounts) or the node sits
	// at the edge, pan so the node stays clear of the panel and the borders.
	useEffect(() => {
		if (!selected) return;
		const node = nodeById.get(selected);
		const el = wrapRef.current;
		if (!node || !el) return;
		// After paint, so clientWidth reflects the mounted panel.
		const raf = window.requestAnimationFrame(() => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			const c = cameraRef.current;
			const sx = node.x * c.k + c.tx;
			const sy = node.y * c.k + c.ty;
			let tx = c.tx;
			let ty = c.ty;
			if (sx > w - REVEAL_MARGIN) tx -= sx - (w - REVEAL_MARGIN);
			if (sx < REVEAL_MARGIN) tx += REVEAL_MARGIN - sx;
			if (sy > h - REVEAL_MARGIN) ty -= sy - (h - REVEAL_MARGIN);
			if (sy < REVEAL_MARGIN) ty += REVEAL_MARGIN - sy;
			if (tx !== c.tx || ty !== c.ty) animateCamera({ ...c, tx, ty });
		});
		return () => window.cancelAnimationFrame(raf);
	}, [selected, nodeById]);

	const pos = (n: LayoutNode) => {
		// The dragged node renders exactly at the cursor's world position —
		// never through home+displacement, which is one frame stale while
		// live reflows move its home (it read as flicker/lag on the held node).
		const drag = dragRef.current;
		if (drag && drag.moved && drag.id === n.id) return { x: drag.worldX, y: drag.worldY };
		const d = dispRef.current.get(n.id);
		return { x: n.x + (d?.dx ?? 0), y: n.y + (d?.dy ?? 0) };
	};

	// Every relayout slides instead of snapping: nodes whose home moved carry
	// the difference as displacement (keeping their rendered position) and
	// the spring eases them to the new home — so live-reflow rearrangements
	// glide around the dragged node rather than teleporting. Layout effects
	// (pre-paint), or the snapped frame would flash before the carry applies.
	const prevHomes = useRef<Map<string, Pt> | null>(null);
	useLayoutEffect(() => {
		const prev = prevHomes.current;
		prevHomes.current = new Map(layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
		if (!prev) return;
		let moved = false;
		for (const n of layout.nodes) {
			const p = prev.get(n.id);
			if (!p) continue;
			const dxHome = p.x - n.x;
			const dyHome = p.y - n.y;
			if (Math.abs(dxHome) < 0.5 && Math.abs(dyHome) < 0.5) continue;
			const d = dispRef.current.get(n.id);
			if (d?.dragging) continue; // the dragged node is rebased separately
			dispRef.current.set(n.id, {
				dx: (d?.dx ?? 0) + dxHome,
				dy: (d?.dy ?? 0) + dyHome,
				vx: d?.vx ?? 0,
				vy: d?.vy ?? 0,
				dragging: false,
			});
			moved = true;
		}
		if (moved) startSpring();
	}, [layout]);

	// After a reorder drop relayouts the row, seed the dropped node's
	// displacement with (release point − new home) so it eases into place.
	useLayoutEffect(() => {
		const pending = pendingReorder.current;
		if (!pending) return;
		pendingReorder.current = null;
		const node = nodeById.get(pending.id);
		if (!node) return;
		dispRef.current.set(pending.id, {
			dx: pending.x - node.x,
			dy: pending.y - node.y,
			vx: 0,
			vy: 0,
			dragging: false,
		});
		startSpring();
	}, [layout, nodeById]);

	// A live reflow moves the dragged node's home mid-drag — rebase its
	// displacement (and the pointer-delta origin) so its rendered position
	// stays glued to the cursor while everything else rearranges around it.
	useLayoutEffect(() => {
		const drag = dragRef.current;
		if (!drag || !drag.moved) return;
		const fresh = nodeById.get(drag.id);
		if (!fresh || fresh === drag.node) return;
		const k = cameraRef.current.k;
		drag.node = fresh;
		drag.startX = drag.lastClientX - (drag.worldX - fresh.x) * k;
		drag.startY = drag.lastClientY - (drag.worldY - fresh.y) * k;
		dispRef.current.set(drag.id, {
			dx: drag.worldX - fresh.x,
			dy: drag.worldY - fresh.y,
			vx: 0,
			vy: 0,
			dragging: true,
		});
	}, [layout, nodeById]);

	// --- Timeline drawer -------------------------------------------------------

	const defs: TimelineDef[] = project ? plugin.indexer.getTimelines(project.root) : [];
	const activeDef: TimelineDef | null = defs.find((d) => d.path === defPath) ?? defs[0] ?? null;

	const onDrawerBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		drawerBarMoved.current = false;
		// Resizes only start from the top-edge strip — the rest of the bar
		// (and the whole closed bar) is the click-to-toggle zone.
		if (!drawerOpen || !(e.target as HTMLElement).closest('.loom-drawer-handle')) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		drawerDrag.current = { pointerId: e.pointerId, startY: e.clientY, startH: drawerHeight };
		// Height must follow the pointer 1:1 — suspend the slide transition.
		setDrawerResizing(true);
	};

	const onDrawerBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = drawerDrag.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		if (!drawerBarMoved.current && Math.abs(e.clientY - drag.startY) < CLICK_SLOP) return;
		drawerBarMoved.current = true;
		setDrawerHeight(clamp(drag.startH + (drag.startY - e.clientY), DRAWER_MIN, DRAWER_MAX));
	};

	const onDrawerBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (drawerDrag.current?.pointerId === e.pointerId) {
			drawerDrag.current = null;
			setDrawerResizing(false);
		}
	};

	const onDrawerBarClick = (e: ReactMouseEvent<HTMLDivElement>) => {
		// The picker and the resize strip are their own affordances, not toggles.
		if ((e.target as HTMLElement).closest('select, .loom-drawer-handle')) return;
		// A resize drag ends with a click on the bar too — swallow it.
		if (drawerBarMoved.current) return;
		setDrawerOpen(!drawerOpen);
	};

	if (!project) {
		return (
			<ViewShell view={view} project={null} title="Loom">
				{noProjectMessage()}
			</ViewShell>
		);
	}

	return (
		<ViewShell
			view={view}
			project={project}
			title="Loom"
			railActive="graph"
		titleExtra={
				<>
			<div className="loom-graph-search">
						
						<input
							type="search"
							className="loom-search"
							placeholder="Search nodes…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
						{search !== '' ? (
							<button
								className="loom-chip-remove loom-search-clear"
								aria-label="Clear search"
								onClick={() => setSearch('')}
							>
								✕
							</button>
						) : null}
					</div>
					{searchResults.length > 0 ? (
						<div className="loom-search-nav">
							<button
								className="loom-rel-filter"
								aria-label="Fit all search results"
								onClick={() => fitNodes(searchResults)}
							>
								<Icon name="scan-search" />
							</button>
							<button
								className="loom-rel-filter"
								aria-label="Previous search result"
								onClick={searchPrev}
							>
								<Icon name="chevron-left" />
							</button>
							<span className="loom-search-count">
								{searchIdx === null ? searchResults.length : `${searchIdx + 1}/${searchResults.length}`}
							</span>
							<button
								className="loom-rel-filter"
								aria-label="Next search result"
								onClick={searchNext}
							>
								<Icon name="chevron-right" />
							</button>
						</div>
					) : null}
				<div className="loom-graph-filter" ref={filterRef}>
							<button
								className={
									filterActive || pickedPaths.size > 0
										? 'loom-rel-filter loom-filter-active'
										: 'loom-rel-filter'
								}
								aria-label="Filter graph"
								onClick={() => setFilterOpen(!filterOpen)}
							>
								<Icon name="filter" />
							</button>
							{filterOpen ? (
								<div className="loom-filter-pop">
									{/* The whole row toggles (not just the small switch), so clicking
									    the label/icon works too. */}
									<div
										className="loom-filter-mode loom-filter-mode-btn"
										role="switch"
										aria-checked={filterMode === 'hide'}
										onClick={() => setFilterMode(filterMode === 'dim' ? 'hide' : 'dim')}
									>
										<Icon name={filterMode === 'dim' ? 'eye-off' : 'eye-closed'} />
										<span>{filterMode === 'dim' ? 'Dimmed' : 'Hidden'}</span>
										<div
											className={
												filterMode === 'hide' ? 'checkbox-container is-enabled' : 'checkbox-container'
											}
										/>
									</div>
									{ENTITY_TYPES.map((t) => (
										<label key={t} className="loom-check">
											<input
												type="checkbox"
												checked={filterTypes.has(t)}
												onChange={() => {
													const next = new Set(filterTypes);
													if (next.has(t)) next.delete(t);
													else next.add(t);
													setFilterTypes(next);
												}}
											/>
											{ENTITY_META[t].plural}
										</label>
									))}
									{project ? (
										<div className="loom-filter-pick">
											<div className="loom-filter-pick-head">Focus on entities</div>
											<div className="loom-filter-pick-search">
												<SearchableSelect
													placeholder="Add an entity…"
													options={plugin.indexer
														.getAll(undefined, project.root)
														.filter((r) => !pickedPaths.has(r.path))
														.sort((a, b) =>
															recordLabel(a, project).localeCompare(recordLabel(b, project))
														)
														.map((r) => ({ value: r.path, label: recordLabel(r, project) }))}
													onPick={(path) => {
														// A left-click selection dims everything not connected to
														// it — clear it so the focus set isn't shown pre-dimmed.
														setSelected(null);
														setPickedPaths(new Set([...pickedPaths, path]));
													}}
												/>
											</div>
											{pickedPaths.size > 0 ? (
												<div className="loom-tag-row loom-filter-pick-chips">
													{[...pickedPaths]
														.map((p) => plugin.indexer.get(p))
														.filter((r): r is NonNullable<typeof r> => r != null)
														.map((r) => (
															<EntityChip
																key={r.path}
																plugin={plugin}
																record={r}
																label={recordLabel(r, project)}
																onOpen={() => view.openEntity(r.path)}
																onRemove={() => {
																	const next = new Set(pickedPaths);
																	next.delete(r.path);
																	setPickedPaths(next);
																}}
																removeLabel="Remove from focus"
															/>
														))}
												</div>
											) : null}
											{pickedPaths.size > 0 ? (
												<>
													<div className="loom-filter-seg-row">
														<span className="loom-filter-seg-label">Render</span>
														<div className="loom-seg">
															<button
																className={
																	!pickSeparate ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
																}
																onClick={() => setPickSeparate(false)}
															>
																In place
															</button>
															<button
																className={
																	pickSeparate ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
																}
																onClick={() => setPickSeparate(true)}
															>
																Separate
															</button>
														</div>
													</div>
													<button
														className="loom-filter-clear"
														onClick={() => setPickedPaths(new Set())}
													>
														<Icon name="eraser" />
														Clear focus
													</button>
												</>
											) : null}
										</div>
									) : null}
								</div>
							) : null}
						</div>
					<button className="loom-rel-filter" aria-label="Fit view" onClick={fitAll}>
						<Icon name="scan" />
					</button>
				</>
			}
		>
			<div className="loom-graph-stack">
				<div className="loom-graph-wrap">
					<div className="loom-graph-viewport" ref={wrapRef}>
					{(() => {
						// Trash sector: fades in as a dragged node nears the corner.
						// Rendered under the svg so nodes pass over it.
						const drag = dragRef.current;
						if (!drag || !drag.moved) return null;
						const c = cameraRef.current;
						const dist = Math.hypot(
							size.w - (drag.worldX * c.k + c.tx),
							size.h - (drag.worldY * c.k + c.ty)
						);
						const opacity = Math.max(0, Math.min(1, (TRASH_REVEAL - dist) / (TRASH_REVEAL - TRASH_R)));
						if (opacity <= 0) return null;
						return (
							<div
								className={dist < TRASH_R ? 'loom-trash-zone loom-trash-active' : 'loom-trash-zone'}
								style={{ opacity }}
							>
								<Icon name="trash-2" />
							</div>
					
						);
					})()}
					<svg
						className="loom-graph-svg"
						onPointerDown={onSvgPointerDown}
						onPointerMove={onSvgPointerMove}
						onPointerUp={onSvgPointerUp}
						onContextMenu={onSvgContextMenu}
					>
						<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
							{layout.edges.map((edge) => {
								const a = nodeById.get(edge.a);
								const b = nodeById.get(edge.b);
								if (!a || !b) return null;
					const endpointVisible = (n: LayoutNode) =>
									passesFilter(n) || searchMatches?.has(n.id) === true;
								if (pickHidden(a.id) || pickHidden(b.id)) return null;
								if (
									filterActive &&
									filterMode === 'hide' &&
									(!endpointVisible(a) || !endpointVisible(b))
								) {
									return null;
								}
								const pa = pos(a);
								const pb = pos(b);
								// Bends follow their endpoint's displacement.
								const da = { x: pa.x - a.x, y: pa.y - a.y };
								const db = { x: pb.x - b.x, y: pb.y - b.y };
								// Cull on the full route extent, so a long trunk
								// stays visible while both endpoints are off-screen.
								const [minX, maxX] = edgeXRange(edge.route, pa, pb);
								if (maxX < viewRange.min || minX > viewRange.max) return null;
								const dim =
									(searchMatches
										? !searchMatches.has(edge.a) && !searchMatches.has(edge.b)
										: connectedTo !== null && edge.a !== selected && edge.b !== selected) ||
								(filterActive &&
										filterMode === 'dim' &&
										(!endpointVisible(a) || !endpointVisible(b)));
								const key = edge.a + '|' + edge.b + '|' + edge.relType;
								// Declaration arrowheads, tips at the node rims.
								const arrowSize = plugin.settings.graphArrowSize;
								let arrows: ReactElement | null = null;
								if (edge.arrowA || edge.arrowB) {
									const dirs = edgeEndDirs(edge.route, pa, pb, da, db);
									arrows = (
										<g className={dim ? 'loom-edge-arrows loom-dim' : 'loom-edge-arrows'}>
											{edge.arrowA ? (
												<polygon
													points={arrowPoints(
														{
															x: pa.x + dirs.start.x * (RADII[a.kind] + 1),
															y: pa.y + dirs.start.y * (RADII[a.kind] + 1),
														},
														{ x: -dirs.start.x, y: -dirs.start.y },
														arrowSize
													)}
												/>
											) : null}
											{edge.arrowB ? (
												<polygon
													points={arrowPoints(
														{
															x: pb.x - dirs.end.x * (RADII[b.kind] + 1),
															y: pb.y - dirs.end.y * (RADII[b.kind] + 1),
														},
														dirs.end,
														arrowSize
													)}
												/>
											) : null}
										</g>
									);
								}
								return (
									<g key={key}>
										<path
											className={dim ? 'loom-edge loom-dim' : 'loom-edge'}
											d={edgePath(edge.route, pa, pb, da, db)}
										/>
										{arrows}
									</g>
								);
							})}
						{layout.nodes.map((node) => {
								// The dragged node always renders, even if it slides out of the
								// cull range — losing its element mid-drag is the old freeze.
								const isDragged = dragRef.current?.id === node.id;
								if (!isDragged && !visible.has(node.id)) return null;
								if (!isDragged && pickHidden(node.id)) return null;
								if (
									filterActive &&
									filterMode === 'hide' &&
									!passesFilter(node) &&
									searchMatches?.has(node.id) !== true
								) {
									return null;
								}
								const p = pos(node);
								const dim =
									(searchMatches
										? !searchMatches.has(node.id)
										: connectedTo !== null && !connectedTo.has(node.id)) ||
								(filterActive &&
										filterMode === 'dim' &&
										!passesFilter(node) &&
										searchMatches?.has(node.id) !== true);
								const classes = ['loom-node', `loom-node-${node.kind}`];
								if (dim) classes.push('loom-dim');
								if (node.id === selected) classes.push('loom-node-selected');
								if (pickedPaths.has(node.id)) classes.push('loom-node-focused');
								const label = recordLabel(node.record, project);
								const shortLabel = label.length > 24 ? label.slice(0, 23).trimEnd() + '…' : label;
								return (
									<g
										key={node.id}
										className={classes.join(' ')}
										transform={`translate(${p.x},${p.y})`}
										onPointerDown={(e) => onNodePointerDown(node, e)}
										onDoubleClick={() => view.openEntity(node.id)}
										onContextMenu={(e) => {
											// Right click zoom-focuses the node (open moved to double-click).
											e.preventDefault();
											e.stopPropagation();
											focusNode(node);
										}}
									>
										{/* Native SVG tooltip carries the full name when truncated. */}
										{shortLabel !== label ? <title>{label}</title> : null}
										{dropRef.current === node.id && dragRef.current ? (
											<circle
												className={
													(plugin.settings.graphDropEdits === 'dragged'
														? declaresConnection(dragRef.current.node, node.id)
														: declaresConnection(node, dragRef.current.id))
														? 'loom-drop-ring loom-drop-ring-remove'
														: 'loom-drop-ring'
												}
												r={RADII[node.kind] + 8}
											/>
										) : null}
										<circle r={RADII[node.kind]} fill={plugin.settings.nodeColors[node.record.type]} />
										<text className="loom-node-label" y={RADII[node.kind] + 16} textAnchor="middle">
											{shortLabel}
										</text>
									</g>
								);
							})}
						</g>
						{/* Focus pulse: screen space (outside the zoom transform) so its
						    size is zoom-independent; one shared animation-delay off a
						    global clock keeps every ring pulsing in unison. */}
						{pickedPaths.size > 0
							? (() => {
									const delay = -(Date.now() % FOCUS_PULSE_MS);
									return layout.nodes
										.filter((n) => pickedPaths.has(n.id))
										.map((n) => {
											const fp = pos(n);
											return (
												<circle
													key={'focus-' + n.id}
													className="loom-node-focus-ring"
													cx={camera.tx + fp.x * camera.k}
													cy={camera.ty + fp.y * camera.k}
													r={FOCUS_RING_R}
													style={{
														stroke: plugin.settings.nodeColors[n.record.type],
														animationDelay: `${delay}ms`,
													}}
												/>
											);
										});
								})()
							: null}
					</svg>
				</div>
				{selectedRecord ? (
					<GraphSidePanel
						app={plugin.app}
						record={selectedRecord}
						label={recordLabel(selectedRecord, project)}
						connections={plugin.indexer.getConnections(selectedRecord.path)}
						connectionLabel={(r) => recordLabel(r, project)}
						threshold={plugin.settings.graphCollapseThreshold}
						names={panelLinkNames}
						onOpenLink={(target, newTab) => {
							const resolved = plugin.indexer.resolve(target, selectedRecord.path);
							if (resolved) view.openEntity(resolved.path, newTab);
							else void plugin.app.workspace.openLinkText(target, selectedRecord.path, newTab ? 'tab' : false);
						}}
						width={panelWidth}
						onWidthChange={setPanelWidth}
						onOpen={(path) => view.openEntity(path)}
						onClose={() => setSelected(null)}
						onCreate={(type) =>
							new CreateEntityModal(plugin, type, project, {
								connectTo: { record: selectedRecord, label: recordLabel(selectedRecord, project) },
							}).open()
						}
					/>
				) : null}
				{layout.nodes.length === 0 ? (
					<div className="loom-empty loom-graph-empty">No entities yet. Right-click to create one.</div>
				) : null}
				</div>
				<div className="loom-drawer">
					<div
						ref={drawerBarRef}
						className={drawerOpen ? 'loom-drawer-bar loom-drawer-bar-open' : 'loom-drawer-bar'}
						onPointerDown={onDrawerBarPointerDown}
						onPointerMove={onDrawerBarPointerMove}
						onPointerUp={onDrawerBarPointerUp}
						onClick={onDrawerBarClick}
					>
						{drawerOpen ? (
							<div
								className="loom-drawer-handle"
								ref={(el) => {
									if (el) setTooltip(el, 'Drag to resize', { placement: 'top' });
								}}
							/>
						) : null}
						{drawerOpen && defs.length > 1 ? (
							<select className="dropdown" value={activeDef?.path ?? ''} onChange={(e) => setDefPath(e.target.value)}>
								{defs.map((d) => (
									<option key={d.path} value={d.path}>
										{d.name}
									</option>
								))}
							</select>
						) : null}
						<div className="loom-drawer-chevron">
							<Icon name={drawerOpen ? 'chevron-down' : 'chevron-up'} />
						</div>
						{drawerOpen ? (
							// Left of the toggle: binoculars + a slider that zooms the strip
							// out (scales every element). Reversed: rests at full (left),
							// zooms out toward the right (value = 1.4 − zoom).
							<div
								className="loom-timeline-zoom-wrap"
								onPointerDown={(e) => e.stopPropagation()}
								onClick={(e) => e.stopPropagation()}
							>
								<span className="loom-timeline-zoom-icon">
									<Icon name="binoculars" fallback="search" />
								</span>
								<input
									type="range"
									className="slider loom-timeline-zoom"
									min={0.4}
									max={1}
									step={0.05}
									value={1.4 - timelineZoom}
									aria-label="Zoom timeline"
									onChange={(e) => setTimelineZoom(1.4 - parseFloat(e.target.value))}
								/>
							</div>
						) : null}
						{drawerOpen ? (
							// Rightmost of the bar: toggles "no confirmation mode" (skip the
							// move-confirm prompt). The state icon sits opposite the knob —
							// pencil (left) when enabled, shield-question (right) when off.
							// Its own click must not toggle the drawer.
							<div
								className="loom-drawer-noconfirm"
								onPointerDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation();
									const next = !noConfirm;
									setNoConfirm(next);
									plugin.settings.confirmTimelineMove = !next;
									void plugin.saveSettings();
								}}
								onMouseEnter={(e) => {
									const rect = e.currentTarget.getBoundingClientRect();
									setConfirmTip({
										x: rect.left + rect.width / 2,
										y: rect.top,
										body: e.currentTarget.doc.body,
									});
								}}
								onMouseLeave={() => setConfirmTip(null)}
							>
								<div className={noConfirm ? 'checkbox-container is-enabled' : 'checkbox-container'}>
									<input type="checkbox" tabIndex={-1} readOnly checked={noConfirm} />
									{noConfirm ? (
										<span className="loom-noconfirm-icon loom-noconfirm-icon-left">
											<Icon name="pencil" />
										</span>
									) : null}
								</div>
							</div>
						) : null}
					</div>
					<div
						className={drawerResizing ? 'loom-drawer-body' : 'loom-drawer-body loom-drawer-anim'}
						style={{ height: drawerOpen ? drawerHeight : 0 }}
					>
						{/* Inner keeps its full height while the outer collapses, so
						    closing slides the content away instead of squishing it.
						    The strip manages its own scrolling + No-date side panel. */}
						<div className="loom-drawer-timeline" style={{ height: drawerHeight }}>
							<TimelineStrip navigator={view} project={project} def={activeDef} zoom={timelineZoom} />
						</div>
					</div>
				</div>
			</div>
			{confirmTip
				? // Bubble-styled instant tooltip, portalled to the body so it isn't
					// clipped by the drawer; sits above the toggle.
					createPortal(
						<div
							className="loom-tooltip loom-tooltip-above"
							style={{ left: confirmTip.x, top: confirmTip.y }}
						>
							<div className="loom-tooltip-name">
								No confirmation mode is {noConfirm ? 'enabled' : 'disabled'}
							</div>
							<div>Make adjustments in the timeline without a confirmation prompt.</div>
						</div>,
						confirmTip.body
					)
				: null}
		</ViewShell>
	);
}
