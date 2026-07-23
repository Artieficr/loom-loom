import { Menu, Notice, ViewStateResult, debounce, setTooltip } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	memo,
	useCallback,
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
import type { LoomTextSize, SavedGraphView } from '../settings';
import { ConfirmModal, CreateEntityModal, RelationshipPromptModal, TextInputModal } from '../project';
import { extractLinkpath, linkTargetOf } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { GraphLayout, LayoutNode, computeGraphLayout } from '../graph/layout';
import { EdgeRoute, Pt, edgeEndDirs, edgePath, edgeXRange } from '../graph/routing';
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
/** Off-screen pin-halo pulse period; a shared clock-based delay keeps every
 *  indicator's breathing in sync (matches the CSS animation duration). */
const PIN_PULSE_MS = 2400;
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
	/** Press-and-hold (no movement) zoom-focus timer + whether it already fired
	 *  (so the release doesn't also toggle selection). */
	holdTimer: number;
	held: boolean;
}
/** How long a still press-and-hold on a node waits before zoom-focusing it. */
const HOLD_MS = 450;

/** Creation-order graph animation. Duration scales with node count between a
 *  floor and ceiling (small graphs are quick, large ones never drag on), and
 *  reveals batch into at most this many force-layout recomputes so big graphs
 *  don't relayout per node. */
const ANIM_MIN_MS = 1800;
const ANIM_MAX_MS = 15000;
const ANIM_MS_PER_NODE = 120;
const ANIM_MAX_STEPS = 40;
/** Distance an isolated (no revealed neighbor) node hovers outside its nearest
 *  node while the graph is still filling in. */
const ANIM_BIND_GAP = 70;
/** How long a single node takes to grow in (ms) — slow enough that the grow
 *  reads clearly rather than snapping in. */
const ANIM_GROW_MS = 900;
/** How long an edge's line takes to draw in (ms), starting once both its
 *  endpoints have finished growing. */
const ANIM_EDGE_MS = 420;
/** Per-frame fraction a node glides toward its target during the animation —
 *  a momentum-free exponential ease, so motion is floaty (no spring overshoot). */
const ANIM_FLOAT = 0.07;

/** Reveal-rate curve: an ease-in-out (slow→fast→slow) softened with a linear
 *  term so neither end drags — the cubic alone is dead-flat at 0 and 1. */
function animEase(t: number): number {
	const cubic = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
	return 0.7 * cubic + 0.3 * t;
}

/** Per-node grow-in curve: a smooth ease-out (cubic) with no overshoot — the
 *  node scales up along a curve and settles gently at 1, no bounce. */
function animGrow(t: number): number {
	if (t >= 1) return 1;
	return 1 - Math.pow(1 - t, 3);
}

/** Rebinds every node with no revealed neighbor so it hovers just outside its
 *  nearest node (biased toward its own real home) instead of sitting alone at
 *  that far home — keeps unconnected nodes clustered with the visible graph
 *  mid-animation — then separates the bound nodes so they don't overlap each
 *  other or the cluster. Connected nodes keep their force home (used as fixed
 *  anchors here); the final batch skips this so unconnected nodes return to
 *  their last (manual) position. */
function bindIsolated(gl: GraphLayout, homes: Map<string, { x: number; y: number }>): void {
	const orig = new Map([...homes].map(([k, v]) => [k, { ...v }]));
	const isConnected = (id: string) => (gl.neighbors.get(id)?.size ?? 0) > 0;
	const anchors = gl.nodes.filter((n) => isConnected(n.id));
	const pool = anchors.length > 0 ? anchors : gl.nodes;
	const isolated = gl.nodes.filter((n) => !isConnected(n.id));
	if (isolated.length === 0) return;
	for (const n of isolated) {
		const h = orig.get(n.id);
		if (!h) continue;
		let best: { x: number; y: number } | null = null;
		let bestD = Infinity;
		for (const m of pool) {
			if (m.id === n.id) continue;
			const mh = orig.get(m.id);
			if (!mh) continue;
			const d = (mh.x - h.x) ** 2 + (mh.y - h.y) ** 2;
			if (d < bestD) {
				bestD = d;
				best = mh;
			}
		}
		if (!best) continue;
		const dx = h.x - best.x;
		const dy = h.y - best.y;
		const len = Math.hypot(dx, dy) || 1;
		homes.set(n.id, { x: best.x + (dx / len) * ANIM_BIND_GAP, y: best.y + (dy / len) * ANIM_BIND_GAP });
	}
	// Separation relaxation: push the bound (isolated) nodes out of any overlap
	// with each other or with a connected anchor. Connected nodes stay fixed
	// (their force layout already spaced them); isolated↔isolated splits the push.
	const movable = new Set(isolated.map((n) => n.id));
	const radOf = new Map(gl.nodes.map((n) => [n.id, RADII[n.kind]]));
	const radAt = (id: string) => radOf.get(id) ?? RADII.global;
	const PAD = 12;
	for (let pass = 0; pass < 10; pass++) {
		let moved = false;
		for (const a of isolated) {
			const ha = homes.get(a.id);
			if (!ha) continue;
			for (const b of gl.nodes) {
				if (b.id === a.id) continue;
				const hb = homes.get(b.id);
				if (!hb) continue;
				let dx = ha.x - hb.x;
				let dy = ha.y - hb.y;
				let dist = Math.hypot(dx, dy);
				const min = radAt(a.id) + radAt(b.id) + PAD;
				if (dist >= min) continue;
				if (dist < 1e-3) {
					// Coincident: nudge by a deterministic (id-derived) vector.
					dx = ((a.id.charCodeAt(0) || 1) % 7) - 3 || 1;
					dy = ((a.id.charCodeAt(1) || 1) % 7) - 3 || 1;
					dist = Math.hypot(dx, dy);
				}
				const push = min - dist;
				const ux = dx / dist;
				const uy = dy / dist;
				if (movable.has(b.id)) {
					ha.x += ux * push * 0.5;
					ha.y += uy * push * 0.5;
					hb.x -= ux * push * 0.5;
					hb.y -= uy * push * 0.5;
				} else {
					ha.x += ux * push;
					ha.y += uy * push;
				}
				moved = true;
			}
		}
		if (!moved) break;
	}
}

/** One node's live animation state during the creation-order replay: its
 *  gliding position (x/y, momentum-free), the time it appeared, and its current
 *  grow-in scale (`s`, derived from `appear` via `animGrow`). */
interface AnimNode {
	x: number;
	y: number;
	appear: number;
	s: number;
}
interface AnimState {
	/** Node ids in creation order. */
	order: string[];
	total: number;
	/** Total run length (ms), scaled to the node count. */
	duration: number;
	/** Nodes revealed per batch (≥1) — caps force-layout recomputes at ~steps. */
	batchSize: number;
	start: number;
	revealedCount: number;
	/** Time of the most recent reveal — the run stays active past it long enough
	 *  for the last batch's nodes to grow and their edges to finish drawing. */
	lastRevealAt: number;
	/** Layout of the currently-revealed subset (forces run on just those nodes,
	 *  so positions evolve as more nodes/connections appear). */
	layout: GraphLayout;
	/** Per-node home (spring target) from the current subset layout. */
	homes: Map<string, { x: number; y: number }>;
	/** Per-node live spring state. */
	an: Map<string, AnimNode>;
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

// A single edge, memoized: the parent re-renders on every drag/spring frame, but
// only edges whose endpoint positions actually changed (an incident edge of the
// dragged/springing node) re-run the routing/path math. Props are all primitives
// (positions as numbers) or the stable `route` reference, so React.memo's shallow
// compare skips every unaffected edge — the key to scaling with connection count.
interface GraphEdgeProps {
	route: EdgeRoute;
	/** Layout home of each endpoint (for the bend-following displacement). */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** Current rendered position of each endpoint (home + displacement/drag). */
	pax: number;
	pay: number;
	pbx: number;
	pby: number;
	aRadius: number;
	bRadius: number;
	dim: boolean;
	arrowA: boolean;
	arrowB: boolean;
	arrowSize: number;
	/** Reveal opacity during the creation-order animation (1 = normal). */
	opacity: number;
	/** Line-draw progress during the animation (1 = fully drawn). Below 1 the
	 *  line grows from both endpoints toward the center. */
	draw: number;
}
const GraphEdge = memo(function GraphEdge({
	route,
	ax,
	ay,
	bx,
	by,
	pax,
	pay,
	pbx,
	pby,
	aRadius,
	bRadius,
	dim,
	arrowA,
	arrowB,
	arrowSize,
	opacity,
	draw,
}: GraphEdgeProps) {
	const pa = { x: pax, y: pay };
	const pb = { x: pbx, y: pby };
	const da = { x: pax - ax, y: pay - ay };
	const db = { x: pbx - bx, y: pby - by };
	let arrows: ReactElement | null = null;
	// While the line is still drawing, hold the arrowheads back — they land once
	// the two halves meet.
	if ((arrowA || arrowB) && draw >= 1) {
		const dirs = edgeEndDirs(route, pa, pb, da, db);
		arrows = (
			<g className={dim ? 'loom-edge-arrows loom-dim' : 'loom-edge-arrows'}>
				{arrowA ? (
					<polygon
						points={arrowPoints(
							{ x: pa.x + dirs.start.x * (aRadius + 1), y: pa.y + dirs.start.y * (aRadius + 1) },
							{ x: -dirs.start.x, y: -dirs.start.y },
							arrowSize
						)}
					/>
				) : null}
				{arrowB ? (
					<polygon
						points={arrowPoints(
							{ x: pb.x - dirs.end.x * (bRadius + 1), y: pb.y - dirs.end.y * (bRadius + 1) },
							dirs.end,
							arrowSize
						)}
					/>
				) : null}
			</g>
		);
	}
	// Draw-in: `pathLength=100` normalizes the dash math regardless of the real
	// path length, so a centered dash pattern of [half, gap, half] shows both ends
	// growing toward a shrinking middle gap (gap = 100·(1−draw)) — the line meets
	// in the center at draw=1.
	const drawing = draw < 1;
	const half = 50 * Math.max(0, draw);
	return (
		<g style={opacity < 1 ? { opacity } : undefined}>
			<path
				className={dim ? 'loom-edge loom-dim' : 'loom-edge'}
				d={edgePath(route, pa, pb, da, db)}
				pathLength={drawing ? 100 : undefined}
				strokeDasharray={drawing ? `${half} ${100 - 2 * half} ${half}` : undefined}
			/>
			{arrows}
		</g>
	);
});

// A single node, memoized on the same principle — during a drag only the dragged
// node (and any springing ones, plus the current drop-target) change position or
// state, so every other node's `<g>` is skipped. Handlers are stable (the parent
// passes ref-backed callbacks), and `node` is a stable layout reference.
interface GraphNodeProps {
	node: LayoutNode;
	px: number;
	py: number;
	radius: number;
	color: string;
	dim: boolean;
	selected: boolean;
	focused: boolean;
	pinned: boolean;
	showDropRing: boolean;
	dropRemove: boolean;
	label: string;
	shortLabel: string;
	/** Reveal opacity during the creation-order animation (1 = normal). */
	opacity: number;
	/** Pop-in scale during the creation-order animation (1 = normal). */
	scale: number;
	onPointerDown: (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => void;
	onOpen: (node: LayoutNode) => void;
	onPin: (node: LayoutNode) => void;
}
const GraphNode = memo(function GraphNode({
	node,
	px,
	py,
	radius,
	color,
	dim,
	selected,
	focused,
	pinned,
	showDropRing,
	dropRemove,
	label,
	shortLabel,
	opacity,
	scale,
	onPointerDown,
	onOpen,
	onPin,
}: GraphNodeProps) {
	const classes = ['loom-node', `loom-node-${node.kind}`];
	if (dim) classes.push('loom-dim');
	if (selected) classes.push('loom-node-selected');
	if (focused) classes.push('loom-node-focused');
	if (pinned) classes.push('loom-node-pinned');
	return (
		<g
			className={classes.join(' ')}
			transform={scale !== 1 ? `translate(${px},${py}) scale(${scale})` : `translate(${px},${py})`}
			style={opacity < 1 ? { opacity } : undefined}
			onPointerDown={(e) => onPointerDown(node, e)}
			onDoubleClick={() => onOpen(node)}
			onContextMenu={(e) => {
				// Right-click toggles a pin (zoom-focus moved to press-and-hold).
				e.preventDefault();
				e.stopPropagation();
				onPin(node);
			}}
		>
			{/* Native SVG tooltip carries the full name when truncated. */}
			{shortLabel !== label ? <title>{label}</title> : null}
			{showDropRing ? (
				<circle
					className={dropRemove ? 'loom-drop-ring loom-drop-ring-remove' : 'loom-drop-ring'}
					r={radius + 8}
				/>
			) : null}
			{pinned ? <circle className="loom-node-pin-ring" r={radius + 4} /> : null}
			<circle r={radius} fill={color} />
			<text className="loom-node-label" y={radius + 16} textAnchor="middle">
				{shortLabel}
			</text>
			{pinned ? (
				<text className="loom-node-pin-mark" x={radius - 2} y={-radius + 4} textAnchor="middle">
					📌
				</text>
			) : null}
		</g>
	);
});

function Graph({ view, projectRoot }: { view: GraphView; projectRoot: string | null }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const project = resolveProject(plugin.indexer, projectRoot);
	const layerKey = plugin.settings.globalLayerOrder.join(',');
	/** Bumped when a drag-reorder writes a new manual x, to re-run the layout. */
	const [manualVersion, setManualVersion] = useState(0);
	// Retained but inert: live reflow was removed (dragging no longer re-lays out
	// the graph each frame), so this stays null — kept only so runLayout and the
	// drop handlers read a stable "no live override".
	const liveManual = useRef<{ id: string; x: number; y: number } | null>(null);
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
	// Pinned nodes: id → the WORLD position they're locked at. A pinned node holds
	// that spot on the canvas (scrolling with the camera like any node, so it can
	// go off-screen — an edge indicator then points to it) instead of following
	// the force layout. Because the world position is fixed, its edges route with
	// the normal fan geometry (diagonal tips, no home-anchored arch). Right-click
	// toggles a pin (also mid-drag — see the drag contextmenu handler).
	const [pinned, setPinned] = useState<Map<string, { wx: number; wy: number }>>(() => {
		const stored = project ? plugin.settings.graphPins[project.root] : undefined;
		const m = new Map<string, { wx: number; wy: number }>();
		if (stored) for (const [path, p] of Object.entries(stored)) m.set(path, { wx: p.x, wy: p.y });
		return m;
	});
	const pinnedRef = useRef(pinned);
	pinnedRef.current = pinned;
	// Persist pins per project so they survive restarts (discrete changes only —
	// pin/unpin/reposition — never per-frame, so a plain save is fine).
	useEffect(() => {
		if (!project) return;
		if (pinned.size === 0) delete plugin.settings.graphPins[project.root];
		else
			plugin.settings.graphPins[project.root] = Object.fromEntries(
				[...pinned].map(([id, p]) => [id, { x: p.wx, y: p.wy }])
			);
		void plugin.saveSettings();
	}, [pinned, project, plugin]);
	// Esc clears the selection, then (on a second press) any pins. Right-click
	// focus otherwise needs an empty-space click to dismiss.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (selected) setSelected(null);
			else unpinAllRef.current();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [selected]);
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
	const [filterTypes, setFilterTypes] = useState<ReadonlySet<EntityType>>(() => {
		const stored = project ? plugin.settings.graphFilters[project.root] : undefined;
		return new Set(stored ? stored.types : ENTITY_TYPES);
	});
	const [filterMode, setFilterMode] = useState<'dim' | 'hide'>(
		() => (project ? plugin.settings.graphFilters[project.root]?.mode : undefined) ?? 'dim'
	);
	// Persist the type filter + eye mode per project across restarts.
	useEffect(() => {
		if (!project) return;
		plugin.settings.graphFilters[project.root] = { types: [...filterTypes], mode: filterMode };
		void plugin.saveSettings();
	}, [filterTypes, filterMode, project, plugin]);
	// Custom views: named snapshots of filter + focus + pins the user flips
	// between. The list lives per project in settings; the popover switcher is
	// in the header.
	const [views, setViews] = useState<SavedGraphView[]>(() =>
		project ? plugin.settings.graphViews[project.root] ?? [] : []
	);
	const [viewsOpen, setViewsOpen] = useState(false);
	const viewsRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!viewsOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!viewsRef.current?.contains(e.target as Node)) setViewsOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [viewsOpen]);
	const persistViews = (next: SavedGraphView[]) => {
		setViews(next);
		if (!project) return;
		if (next.length === 0) delete plugin.settings.graphViews[project.root];
		else plugin.settings.graphViews[project.root] = next;
		void plugin.saveSettings();
	};
	/** Applies a saved view: restores its filter, focus and pins in one shot. */
	const applyView = (v: SavedGraphView) => {
		setFilterTypes(new Set(v.filterTypes));
		setFilterMode(v.filterMode);
		setSelected(null);
		setPickedPaths(new Set(v.focus.filter((p) => plugin.indexer.get(p))));
		setPickSeparate(v.focusSeparate);
		const m = new Map<string, { wx: number; wy: number }>();
		for (const [path, p] of Object.entries(v.pins)) m.set(path, { wx: p.x, wy: p.y });
		setPinned(m);
		setViewsOpen(false);
	};
	/** Snapshots the current filter/focus/pins into a new named view. */
	const saveCurrentAsView = () => {
		new TextInputModal(plugin.app, {
			title: 'Save current graph as a view',
			placeholder: 'View name',
			cta: 'Save',
			onSubmit: (name) => {
				const snapshot: SavedGraphView = {
					id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
					name,
					filterTypes: [...filterTypes],
					filterMode,
					focus: [...pickedPaths],
					focusSeparate: pickSeparate,
					pins: Object.fromEntries([...pinned].map(([id, p]) => [id, { x: p.wx, y: p.wy }])),
				};
				persistViews([...views, snapshot]);
			},
		}).open();
	};
	const renameView = (v: SavedGraphView) => {
		new TextInputModal(plugin.app, {
			title: 'Rename view',
			initial: v.name,
			cta: 'Rename',
			onSubmit: (name) => persistViews(views.map((x) => (x.id === v.id ? { ...x, name } : x))),
		}).open();
	};
	const deleteView = (v: SavedGraphView) => {
		new ConfirmModal(
			plugin.app,
			'Delete view',
			`Delete the saved view "${v.name}"?`,
			() => persistViews(views.filter((x) => x.id !== v.id)),
			'Delete'
		).open();
	};
	/** Overwrites an existing view with the current graph state. */
	const updateView = (v: SavedGraphView) => {
		persistViews(
			views.map((x) =>
				x.id === v.id
					? {
							...x,
							filterTypes: [...filterTypes],
							filterMode,
							focus: [...pickedPaths],
							focusSeparate: pickSeparate,
							pins: Object.fromEntries([...pinned].map(([id, p]) => [id, { x: p.wx, y: p.wy }])),
						}
					: x
			)
		);
	};

	// "Animate graph": replay node-creation history — nodes pop in (scale spring)
	// in `loomCreated` order while the force layout re-runs on the growing subset
	// (so connections form live and positions shift as pull forces change) and the
	// camera re-frames every revealed node. `animRef` holds the live run; the
	// functions are defined after the layout/camera helpers below.
	const [animActive, setAnimActive] = useState(false);
	const animRef = useRef<AnimState | null>(null);
	const animRaf = useRef(0);
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
			window.cancelAnimationFrame(animRaf.current);
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

	const fitPoints = (pts: { x: number; y: number }[]) => {
		const el = wrapRef.current;
		if (!el || pts.length === 0) return;
		const pad = 60;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of pts) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
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
	const fitNodes = (nodes: LayoutNode[]) => fitPoints(nodes.map((n) => ({ x: n.x, y: n.y })));
	const fitAll = () => fitNodes(layout.nodes);

	// --- Creation-order animation --------------------------------------------
	const finishAnimation = () => {
		window.cancelAnimationFrame(animRaf.current);
		animRef.current = null;
		setAnimActive(false);
	};
	const animStep = (now: number) => {
		const st = animRef.current;
		if (!st) return;
		// Eased reveal: the fraction of nodes shown follows slow→fast→slow over the
		// run, quantized up to whole batches so recomputes stay ≤ ANIM_MAX_STEPS.
		const eased = animEase(Math.min(1, (now - st.start) / st.duration));
		const wantCount = Math.min(
			st.total,
			Math.ceil((st.total * eased) / st.batchSize) * st.batchSize
		);
		if (wantCount > st.revealedCount) {
			st.revealedCount = wantCount;
			st.lastRevealAt = now;
			const revealed = new Set(st.order.slice(0, wantCount));
			const final = wantCount >= st.total;
			// The final batch settles to the exact layout the normal graph renders
			// (`layout`, stable for the run) so there's no jump when the animation
			// ends — connected nodes land at their force home and unconnected ones
			// return to their last (manual) position, both already honored there.
			// Intermediate batches lay out just the revealed subset, so positions
			// genuinely shift as more nodes and connections appear.
			const rl = final ? layout : runLayout(revealed);
			st.layout = rl;
			st.homes = new Map(rl.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
			// While the graph is still filling in, keep isolated nodes near the
			// visible cluster instead of alone at their far final home.
			if (!final) bindIsolated(rl, st.homes);
			for (const n of rl.nodes) {
				// A newly revealed node grows in AT its current target, from scale 0.
				if (!st.an.has(n.id)) {
					const h = st.homes.get(n.id) ?? { x: n.x, y: n.y };
					st.an.set(n.id, { x: h.x, y: h.y, appear: now, s: 0 });
				}
			}
			// Re-frame every revealed node, like "fit all", each time more appear.
			fitPoints([...st.homes.values()]);
		}
		let active = false;
		for (const n of st.layout.nodes) {
			const a = st.an.get(n.id);
			const home = st.homes.get(n.id);
			if (!a || !home) continue;
			// Momentum-free glide toward the current home: an exponential ease with
			// no velocity, so nodes drift floatily and never overshoot or oscillate.
			a.x += (home.x - a.x) * ANIM_FLOAT;
			a.y += (home.y - a.y) * ANIM_FLOAT;
			// Curved grow-in: scale eases out over ANIM_GROW_MS from when the node
			// appeared, settling gently at 1 (no bounce).
			const growT = (now - a.appear) / ANIM_GROW_MS;
			a.s = animGrow(growT);
			if (growT < 1 || Math.abs(home.x - a.x) > 0.5 || Math.abs(home.y - a.y) > 0.5) {
				active = true;
			}
		}
		setTick((t) => t + 1);
		// Don't finish until the last batch's nodes have grown and their edges have
		// finished drawing, even if the position springs have already settled.
		const edgesDone = now - st.lastRevealAt >= ANIM_GROW_MS + ANIM_EDGE_MS;
		if (st.revealedCount >= st.total && !active && edgesDone) {
			finishAnimation();
			return;
		}
		animRaf.current = window.requestAnimationFrame(animStep);
	};
	const startAnimation = () => {
		const order = [...layout.nodes]
			.map((n) => ({ id: n.id, created: plugin.indexer.get(n.id)?.created ?? 0 }))
			.sort((a, b) => a.created - b.created)
			.map((x) => x.id);
		if (order.length === 0) return;
		const total = order.length;
		const duration = clamp(total * ANIM_MS_PER_NODE, ANIM_MIN_MS, ANIM_MAX_MS);
		const batchSize = Math.max(1, Math.ceil(total / ANIM_MAX_STEPS));
		animRef.current = {
			order,
			total,
			duration,
			batchSize,
			start: performance.now(),
			revealedCount: 0,
			lastRevealAt: performance.now(),
			layout: { nodes: [], edges: [], neighbors: new Map(), width: 0, height: 0 },
			homes: new Map(),
			an: new Map(),
		};
		setAnimActive(true);
		animRaf.current = window.requestAnimationFrame(animStep);
	};

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

	const pos = (n: LayoutNode) => {
		// The dragged node renders exactly at the cursor's world position —
		// never through home+displacement, which is one frame stale while
		// live reflows move its home (it read as flicker/lag on the held node).
		const drag = dragRef.current;
		if (drag && drag.moved && drag.id === n.id) return { x: drag.worldX, y: drag.worldY };
		// A pinned node holds a fixed WORLD position (locked on the canvas).
		const pin = pinned.get(n.id);
		if (pin) return { x: pin.wx, y: pin.wy };
		const d = dispRef.current.get(n.id);
		return { x: n.x + (d?.dx ?? 0), y: n.y + (d?.dy ?? 0) };
	};

	/** Locks a node at a world position. */
	const pinNodeAt = (id: string, wx: number, wy: number) =>
		setPinned((cur) => {
			const next = new Map(cur);
			next.set(id, { wx, wy });
			return next;
		});
	/** Unpins `node` and eases it back to its force-layout home (seed the drag/pin
	 *  spot as a displacement so it springs from there instead of jumping — the
	 *  fix for a dismissed pin that used to stick until the next interaction). */
	const unpinNode = (node: LayoutNode) => {
		const pin = pinnedRef.current.get(node.id);
		if (pin) {
			dispRef.current.set(node.id, {
				dx: pin.wx - node.x,
				dy: pin.wy - node.y,
				vx: 0,
				vy: 0,
				dragging: false,
			});
			startSpring();
		}
		setPinned((cur) => {
			const next = new Map(cur);
			next.delete(node.id);
			return next;
		});
	};
	/** Right-click toggles a node's pin: off if pinned, else locked where it is. */
	const togglePin = (node: LayoutNode) => {
		if (pinnedRef.current.has(node.id)) {
			unpinNode(node);
			return;
		}
		const p = pos(node);
		pinNodeAt(node.id, p.x, p.y);
	};
	/** Clears every pin, easing each node back to its force home (same seed +
	 *  spring as a single unpin, so cleared nodes don't stick at the pinned spot). */
	const unpinAll = () => {
		const pins = pinnedRef.current;
		if (pins.size === 0) return;
		for (const [id, pin] of pins) {
			const node = nodeById.get(id);
			if (node) {
				dispRef.current.set(id, {
					dx: pin.wx - node.x,
					dy: pin.wy - node.y,
					vx: 0,
					vy: 0,
					dragging: false,
				});
			}
		}
		startSpring();
		setPinned(new Map());
	};
	const unpinAllRef = useRef(unpinAll);
	unpinAllRef.current = unpinAll;

	const onNodePointerDown = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		// The creation-order animation owns node positions — no dragging/selecting
		// while it plays.
		if (animRef.current) return;
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
		// Start from the node's CURRENT position (a pinned or mid-spring node isn't
		// at its home): bake the (start − home) offset into startX/startY so the
		// move formula (home + (clientX − startX)/k) begins exactly under the cursor
		// with no jump, and stays compatible with the live-reflow rebase effect.
		const start = pos(node);
		const k = cameraRef.current.k;
		// Press-and-hold with no movement zoom-focuses the node (right-click is now
		// reserved for pinning). The timer is cleared the moment a drag begins.
		const holdTimer = window.setTimeout(() => {
			const drag = dragRef.current;
			if (!drag || drag.id !== node.id || drag.moved) return;
			drag.held = true;
			focusNode(node);
		}, HOLD_MS);
		dragRef.current = {
			id: node.id,
			node,
			pointerId: e.pointerId,
			startX: e.clientX - (start.x - node.x) * k,
			startY: e.clientY - (start.y - node.y) * k,
			moved: false,
			worldX: start.x,
			worldY: start.y,
			lastClientX: e.clientX,
			lastClientY: e.clientY,
			holdTimer,
			held: false,
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
		window.clearTimeout(drag.holdTimer);
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

	/** Only fully-unconnected nodes persist a dropped position (the layout honors
	 *  manual x/y for them alone). Connected nodes are placed purely by the pull
	 *  forces, so dragging one just springs it back — there is no reordering. */
	const isFreePlacement = (node: LayoutNode) =>
		(layout.neighbors.get(node.id)?.size ?? 0) === 0;

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
		if (!drag.moved) window.clearTimeout(drag.holdTimer); // a drag cancels the hold-focus
		drag.moved = true;
		drag.lastClientX = e.clientX;
		drag.lastClientY = e.clientY;
		const d = dispRef.current.get(drag.id);
		if (d) {
			// Pointer deltas are screen px; node displacement is world space. The
			// press-time startX/startY already bake in any start offset (a pinned or
			// mid-spring node), and the live-reflow rebase effect keeps startX in
			// this same frame, so `home + (clientX − startX)/k` follows the cursor.
			d.dx = dx / cameraRef.current.k;
			d.dy = dy / cameraRef.current.k;
			const cx = drag.node.x + d.dx;
			const cy = drag.node.y + d.dy;
			drag.worldX = cx;
			drag.worldY = cy;
			let target: string | null = null;
			for (const n of layout.nodes) {
				if (n.id === drag.id) continue;
				// Use the node's rendered position (pos honors pins) — a pinned target
				// sits at its world pin, not its layout home, so a home-based hit test
				// missed its center and only caught the offset home spot.
				const np = pos(n);
				if (Math.hypot(np.x - cx, np.y - cy) <= RADII[n.kind] + DROP_SNAP) {
					target = n.id;
					break;
				}
			}
			dropRef.current = target;
			// NO live reflow while dragging: re-running the full layout (force
			// relaxation + leftPad) every frame made the whole graph shift under the
			// cursor and pulled other rows toward the held node. The dragged node
			// just follows the cursor; the full layout (all rules) runs once on drop.
			setTick((t) => t + 1);
		}
	};

	const onNodePointerUp = (e: PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) {
			setDragActive(false);
			return;
		}
		window.clearTimeout(drag.holdTimer);
		dragRef.current = null;
		setDragActive(false);
		const dropId = dropRef.current;
		dropRef.current = null;
		const hadLive = liveManual.current !== null;
		liveManual.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.held) {
			// A press-and-hold zoom-focus already happened — don't also toggle
			// selection on release.
			dispRef.current.delete(drag.id);
			return;
		}
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
			} else if (pinnedRef.current.has(drag.id)) {
				// A pinned node just gets re-pinned at its new world spot (no
				// spring-back, no reorder-persist) — dragging repositions the pin.
				pinNodeAt(drag.id, drag.worldX, drag.worldY);
				dispRef.current.delete(drag.id);
			} else if (isFreePlacement(drag.node) && project && d) {
				// Free placement: an unconnected node has no forces, so it holds
				// exactly where it's dropped (both x and y persisted per project).
				(plugin.settings.graphManualX[project.root] ??= {})[drag.id] = drag.worldX;
				(plugin.settings.graphManualY[project.root] ??= {})[drag.id] = drag.worldY;
				void plugin.saveSettings();
				// Clear the drag displacement BEFORE the relayout: the new home IS
				// the drop point, so with no leftover displacement the very next
				// render lands the node exactly there — no one-frame offset ghost.
				// pendingReorder still neutralizes the home-move carry (to disp 0).
				dispRef.current.delete(drag.id);
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
	// Right-click MID-DRAG pins the dragged node where it currently sits (and ends
	// the drag), so you can gather far-apart nodes on screen. Capture phase +
	// stopPropagation so the node's own contextmenu (which would pin whatever is
	// under the cursor) never fires.
	const dragContextMenuRef = useRef<(e: MouseEvent) => void>(() => {});
	dragContextMenuRef.current = (e: MouseEvent) => {
		const drag = dragRef.current;
		if (!drag) return;
		e.preventDefault();
		e.stopPropagation();
		window.clearTimeout(drag.holdTimer);
		pinNodeAt(drag.id, drag.worldX, drag.worldY);
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		dragRef.current = null;
		dropRef.current = null;
		liveManual.current = null;
		setDragActive(false);
	};
	useEffect(() => {
		if (!dragActive) return;
		const move = (e: PointerEvent) => dragHandlers.current.move(e);
		const up = (e: PointerEvent) => dragHandlers.current.up(e);
		const cancel = () => dragHandlers.current.abort();
		const ctx = (e: MouseEvent) => dragContextMenuRef.current(e);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('contextmenu', ctx, true);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('contextmenu', ctx, true);
		};
	}, [dragActive]);

	// Stable node-event callbacks so memoized `GraphNode`s don't re-render just
	// because the parent re-ran (inline arrows would be new refs every frame). The
	// latest closures live in a ref; these wrappers never change identity.
	const nodeCbRef = useRef({
		down: onNodePointerDown,
		open: (n: LayoutNode) => view.openEntity(n.id),
		pin: togglePin,
	});
	nodeCbRef.current = {
		down: onNodePointerDown,
		open: (n: LayoutNode) => view.openEntity(n.id),
		pin: togglePin,
	};
	const stableNodeDown = useMemo(
		() => (n: LayoutNode, e: ReactPointerEvent<SVGGElement>) => nodeCbRef.current.down(n, e),
		[]
	);
	const stableNodeOpen = useMemo(() => (n: LayoutNode) => nodeCbRef.current.open(n), []);
	const stableNodePin = useMemo(() => (n: LayoutNode) => nodeCbRef.current.pin(n), []);

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
	// An edge endpoint counts as "visible" for filter/dim purposes when its type
	// passes the type filter or it matches the search. Used by the edge render.
	const endpointVisible = (n: LayoutNode) => passesFilter(n) || searchMatches?.has(n.id) === true;
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
	const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
	const selectedRecord = selected ? plugin.indexer.get(selected) : undefined;
	// Side-panel props stabilized so the memoized panel skips re-render on drag/
	// spring frames — they only change when the selection or the index changes.
	const panelConnections = useMemo(
		() => (selectedRecord ? plugin.indexer.getConnections(selectedRecord.path) : []),
		[plugin, selectedRecord, version]
	);
	const panelConnectionLabel = useCallback(
		(r: EntityRecord) => recordLabel(r, project),
		[project]
	);
	const panelOnOpenLink = useCallback(
		(target: string, newTab?: boolean) => {
			if (!selectedRecord) return;
			const resolved = plugin.indexer.resolve(target, selectedRecord.path);
			if (resolved) view.openEntity(resolved.path, newTab);
			else void plugin.app.workspace.openLinkText(target, selectedRecord.path, newTab ? 'tab' : false);
		},
		[plugin, selectedRecord, view]
	);
	const panelOnOpen = useCallback((path: string) => view.openEntity(path), [view]);
	const panelOnClose = useCallback(() => setSelected(null), []);
	const panelOnCreate = useCallback(
		(type: EntityType) => {
			if (!selectedRecord || !project) return;
			new CreateEntityModal(plugin, type, project, {
				connectTo: { record: selectedRecord, label: recordLabel(selectedRecord, project) },
			}).open();
		},
		[plugin, project, selectedRecord]
	);
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
				<div className="loom-graph-filter" ref={viewsRef}>
							<button
								className="loom-rel-filter"
								aria-label="Saved views"
								onClick={() => setViewsOpen(!viewsOpen)}
							>
								<Icon name="bookmark" fallback="star" />
							</button>
							{viewsOpen ? (
								<div className="loom-filter-pop loom-views-pop">
									{views.length > 0 ? (
										<div className="loom-views-list">
											{views.map((v) => (
												<div key={v.id} className="loom-views-row">
													<button
														className="loom-views-name"
														onClick={() => applyView(v)}
														title="Apply this view"
													>
														{v.name}
													</button>
													<button
														className="loom-rel-filter loom-views-act"
														aria-label="Update view to current graph"
														title="Update to current"
														onClick={() => updateView(v)}
													>
														<Icon name="save" fallback="check" />
													</button>
													<button
														className="loom-rel-filter loom-views-act"
														aria-label="Rename view"
														title="Rename"
														onClick={() => renameView(v)}
													>
														<Icon name="pencil" fallback="edit" />
													</button>
													<button
														className="loom-rel-filter loom-views-act"
														aria-label="Delete view"
														title="Delete"
														onClick={() => deleteView(v)}
													>
														<Icon name="trash-2" fallback="x" />
													</button>
												</div>
											))}
										</div>
									) : (
										<div className="loom-views-empty">No saved views yet.</div>
									)}
									<button className="loom-filter-clear" onClick={saveCurrentAsView}>
										<Icon name="plus" />
										Save current as view
									</button>
								</div>
							) : null}
						</div>
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
					{pinned.size > 0 ? (
						<button
							className="loom-rel-filter loom-filter-active"
							aria-label={`Clear ${pinned.size} pinned node${pinned.size > 1 ? 's' : ''}`}
							onClick={unpinAll}
						>
							<Icon name="pin-off" fallback="x" />
						</button>
					) : null}
					<button
						className={animActive ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
						aria-label={animActive ? 'Stop time-lapse animation' : 'Start time-lapse animation'}
						onClick={() => (animActive ? finishAnimation() : startAnimation())}
					>
						<Icon name={animActive ? 'square' : 'play'} fallback={animActive ? 'x' : 'chevron-right'} />
					</button>
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
						<defs>
							{/* Soft halo behind an off-screen pin indicator; `currentColor`
							    resolves to each indicator's node color. */}
							<radialGradient id="loom-pin-halo">
								<stop offset="0%" stopColor="currentColor" stopOpacity="0.45" />
								<stop offset="60%" stopColor="currentColor" stopOpacity="0.18" />
								<stop offset="100%" stopColor="currentColor" stopOpacity="0" />
							</radialGradient>
						</defs>
						<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
							{animActive && animRef.current
								? (() => {
										const st = animRef.current;
										const byId = new Map(st.layout.nodes.map((n) => [n.id, n]));
										const nowMs = performance.now();
										return (
											<>
												{st.layout.edges.map((edge) => {
													const na = byId.get(edge.a);
													const nb = byId.get(edge.b);
													const aa = st.an.get(edge.a);
													const ab = st.an.get(edge.b);
													const ha = st.homes.get(edge.a);
													const hb = st.homes.get(edge.b);
													if (!na || !nb || !aa || !ab || !ha || !hb) return null;
													// The line starts drawing once both endpoints have grown
													// in, then grows from both ends to meet in the center.
													const edgeStart = Math.max(aa.appear, ab.appear) + ANIM_GROW_MS;
													const drawT = clamp((nowMs - edgeStart) / ANIM_EDGE_MS, 0, 1);
													if (drawT <= 0) return null;
													return (
														<GraphEdge
															key={edge.a + '|' + edge.b + '|' + edge.relType}
															route={edge.route}
															ax={ha.x}
															ay={ha.y}
															bx={hb.x}
															by={hb.y}
															pax={aa.x}
															pay={aa.y}
															pbx={ab.x}
															pby={ab.y}
															aRadius={RADII[na.kind]}
															bRadius={RADII[nb.kind]}
															dim={false}
															arrowA={edge.arrowA}
															arrowB={edge.arrowB}
															arrowSize={plugin.settings.graphArrowSize}
															opacity={1}
															draw={drawT}
														/>
													);
												})}
												{st.layout.nodes.map((node) => {
													const a = st.an.get(node.id);
													if (!a) return null;
													const label = recordLabel(node.record, project);
													const shortLabel =
														label.length > 24 ? label.slice(0, 23).trimEnd() + '…' : label;
													return (
														<GraphNode
															key={node.id}
															node={node}
															px={a.x}
															py={a.y}
															radius={RADII[node.kind]}
															color={plugin.settings.nodeColors[node.record.type]}
															dim={false}
															selected={false}
															focused={false}
															pinned={false}
															showDropRing={false}
															dropRemove={false}
															label={label}
															shortLabel={shortLabel}
															opacity={1}
															scale={a.s}
															onPointerDown={stableNodeDown}
															onOpen={stableNodeOpen}
															onPin={stableNodePin}
														/>
													);
												})}
											</>
										);
									})()
								: null}
							{!animActive && layout.edges.map((edge) => {
								const a = nodeById.get(edge.a);
								const b = nodeById.get(edge.b);
								if (!a || !b) return null;
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
								// Path/arrow math runs inside the memoized GraphEdge — skipped
								// unless one of these primitive props changes (i.e. an endpoint
								// moved), so a drag only recomputes its incident edges.
								return (
									<GraphEdge
										key={edge.a + '|' + edge.b + '|' + edge.relType}
										route={edge.route}
										ax={a.x}
										ay={a.y}
										bx={b.x}
										by={b.y}
										pax={pa.x}
										pay={pa.y}
										pbx={pb.x}
										pby={pb.y}
										aRadius={RADII[a.kind]}
										bRadius={RADII[b.kind]}
										dim={dim}
										arrowA={edge.arrowA}
										arrowB={edge.arrowB}
										arrowSize={plugin.settings.graphArrowSize}
										opacity={1}
										draw={1}
									/>
								);
							})}
						{/* Pinned nodes render last so they sit on top of the graph. */}
						{!animActive && [...layout.nodes]
								.sort((a, b) => (pinned.has(a.id) ? 1 : 0) - (pinned.has(b.id) ? 1 : 0))
								.map((node) => {
								// The dragged node always renders even if it slides out of the
								// cull range (losing its element mid-drag was the old freeze bug).
								// A pinned node scrolls off-screen like any node — an edge
								// indicator (below) points to it — but stays exempt from filter/
								// pick hiding so pinning keeps it visible when it's on screen.
								const isDragged = dragRef.current?.id === node.id;
								const isPinned = pinned.has(node.id);
								const p = pos(node);
								// Cull on the ACTUAL position, not the layout home: a pinned or
								// dragged node lives away from its home, so a home-based test
								// wrongly hid it (the disappearing far-dragged node).
								if (!isDragged && (p.x < viewRange.min || p.x > viewRange.max)) return null;
								if (!isDragged && !isPinned && pickHidden(node.id)) return null;
								if (
									!isPinned &&
									filterActive &&
									filterMode === 'hide' &&
									!passesFilter(node) &&
									searchMatches?.has(node.id) !== true
								) {
									return null;
								}
								const dim =
									(searchMatches
										? !searchMatches.has(node.id)
										: connectedTo !== null && !connectedTo.has(node.id)) ||
								(filterActive &&
										filterMode === 'dim' &&
										!passesFilter(node) &&
										searchMatches?.has(node.id) !== true);
								const label = recordLabel(node.record, project);
								const shortLabel = label.length > 24 ? label.slice(0, 23).trimEnd() + '…' : label;
								const showDropRing = dropRef.current === node.id && dragRef.current !== null;
								const dropRemove =
									showDropRing && dragRef.current
										? plugin.settings.graphDropEdits === 'dragged'
											? declaresConnection(dragRef.current.node, node.id)
											: declaresConnection(node, dragRef.current.id)
										: false;
								return (
									<GraphNode
										key={node.id}
										node={node}
										px={p.x}
										py={p.y}
										radius={RADII[node.kind]}
										color={plugin.settings.nodeColors[node.record.type]}
										dim={dim}
										selected={node.id === selected}
										focused={pickedPaths.has(node.id)}
										pinned={isPinned}
										showDropRing={showDropRing}
										dropRemove={dropRemove}
										label={label}
										shortLabel={shortLabel}
										opacity={1}
										scale={1}
										onPointerDown={stableNodeDown}
										onOpen={stableNodeOpen}
										onPin={stableNodePin}
									/>
								);
							})}
						</g>
						{/* Focus pulse: screen space (outside the zoom transform) so its
						    size is zoom-independent; one shared animation-delay off a
						    global clock keeps every ring pulsing in unison. */}
						{!animActive && pickedPaths.size > 0
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
						{/* Off-screen pin indicators: only once a pinned node is FULLY off
						    the viewport (so it never overlaps a still-visible node), a
						    node-colored dot with a pulsing halo clamps to the screen edge
						    and its arrow points at the node; clicking pans to center it. */}
						{!animActive && pinned.size > 0
							? (() => {
									// One shared clock-derived delay so every halo pulses in unison.
									const haloDelay = -(Date.now() % PIN_PULSE_MS);
									return [...pinned.entries()].map(([id, pin]) => {
									const node = nodeById.get(id);
									if (!node) return null;
									const sx = camera.tx + pin.wx * camera.k;
									const sy = camera.ty + pin.wy * camera.k;
									const rk = RADII[node.kind] * camera.k;
									const fullyOff =
										sx + rk < 0 || sx - rk > size.w || sy + rk < 0 || sy - rk > size.h;
									if (!fullyOff) return null;
									const m = 18;
									const ex = clamp(sx, m, size.w - m);
									const ey = clamp(sy, m, size.h - m);
									const ang = (Math.atan2(sy - ey, sx - ex) * 180) / Math.PI;
									const color = plugin.settings.nodeColors[node.record.type];
									return (
										<g
											key={'pinedge-' + id}
											className="loom-pin-edge"
											transform={`translate(${ex},${ey}) rotate(${ang})`}
											style={{ color }}
											onPointerDown={(e) => {
												e.stopPropagation();
												// Left-click pans to the node; right-click unpins it
												// (and must not fall through to the empty-space menu).
												if (e.button !== 0) return;
												const el = wrapRef.current;
												const w = el?.clientWidth ?? size.w;
												const h = el?.clientHeight ?? size.h;
												animateCamera({
													k: camera.k,
													tx: w / 2 - pin.wx * camera.k,
													ty: h / 2 - pin.wy * camera.k,
												});
											}}
											onContextMenu={(e) => {
												e.preventDefault();
												e.stopPropagation();
												unpinNode(node);
											}}
										>
											<title>{recordLabel(node.record, project)}</title>
											<circle
												className="loom-pin-halo"
												r={30}
												fill="url(#loom-pin-halo)"
												style={{ animationDelay: `${haloDelay}ms` }}
											/>
											<circle r={11} fill={color} />
											<polygon points="11,0 4,-5 4,5" className="loom-pin-edge-tip" />
										</g>
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
						connections={panelConnections}
						connectionLabel={panelConnectionLabel}
						threshold={plugin.settings.graphCollapseThreshold}
						names={panelLinkNames}
						onOpenLink={panelOnOpenLink}
						width={panelWidth}
						onWidthChange={setPanelWidth}
						onOpen={panelOnOpen}
						onClose={panelOnClose}
						onCreate={panelOnCreate}
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
