import {
	PointerEvent as ReactPointerEvent,
	ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { ENTITY_TYPES, EntityRecord, EntityType, entityPlural } from '../types';
import { features, projectTypes, roleOf } from '../project-kind';
import { LayoutNode, computeGraphLayout } from '../graph/layout';
import { edgePath } from '../graph/routing';
import { ProjectDef } from '../indexer';
import { Icon, useCloseOnOutsideClick } from './common';
import { recordLabel } from '../display';
import { t } from '../i18n';
import type LoomLoomPlugin from '../main';

/** Fallback node radius per layout row (anchor / beat / global layers),
 *  used when the type has no configured size. */
export const RADII = { anchor: 26, beat: 20, global: 17 } as const;
/** Pointer movement below this is a click (select/clear), above it a drag/pan. */
export const CLICK_SLOP = 4;

/** A node's offset from its laid-out home while dragged or springing back. */
export interface Displacement {
	dx: number;
	dy: number;
	vx: number;
	vy: number;
	dragging: boolean;
}

/** A background pan gesture in progress. */
export interface PanState {
	pointerId: number;
	startX: number;
	startY: number;
	tx0: number;
	ty0: number;
	moved: boolean;
}

/** Springs every released node back to its home, one frame per `onFrame`. */
export function runSpring(
	dispRef: { current: Map<string, Displacement> },
	rafRef: { current: number },
	onFrame: () => void
): void {
	window.cancelAnimationFrame(rafRef.current);
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
		onFrame();
		if (active) rafRef.current = window.requestAnimationFrame(step);
	};
	rafRef.current = window.requestAnimationFrame(step);
}

/** Pans the camera with the pointer once it has moved past `CLICK_SLOP`. */
export function panMove(
	panRef: { current: PanState | null },
	e: { pointerId: number; clientX: number; clientY: number },
	setCamera: (update: (c: { tx: number; ty: number; k: number }) => { tx: number; ty: number; k: number }) => void
): void {
	const pan = panRef.current;
	if (!pan || pan.pointerId !== e.pointerId) return;
	const dx = e.clientX - pan.startX;
	const dy = e.clientY - pan.startY;
	if (!pan.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
	pan.moved = true;
	setCamera((c) => ({ ...c, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
}

type Cam = { tx: number; ty: number; k: number };
/** The mini graph's zoom-out floor (wheel and fit). */
const MINI_MIN_ZOOM = 0.2;

/** The camera framing `pts` in a `w`×`h` viewport — a 60px margin (plus room
 *  under the bottom row's labels), zoom capped at 1.25 and floored at `minK`.
 *  Null when there's nothing to frame. */
export function fitCamera(pts: { x: number; y: number }[], w: number, h: number, minK: number): Cam | null {
	if (pts.length === 0) return null;
	const pad = 60;
	const minX = Math.min(...pts.map((p) => p.x)) - pad;
	const maxX = Math.max(...pts.map((p) => p.x)) + pad;
	const minY = Math.min(...pts.map((p) => p.y)) - pad;
	const maxY = Math.max(...pts.map((p) => p.y)) + pad + 24;
	const k = Math.max(minK, Math.min(w / (maxX - minX), h / (maxY - minY), 1.25));
	return { k, tx: (w - (minX + maxX) * k) / 2, ty: (h - (minY + maxY) * k) / 2 };
}

/** Wheel zoom around screen point (`px`,`py`), clamped to [`minK`, `maxK`] —
 *  one rate for both graphs. */
export function zoomAt(c: Cam, px: number, py: number, deltaY: number, minK: number, maxK: number): Cam {
	const k = Math.max(minK, Math.min(maxK, c.k * Math.exp(-deltaY * 0.0015)));
	return { k, tx: px - ((px - c.tx) / c.k) * k, ty: py - ((py - c.ty) / c.k) * k };
}

/** How long a still press-and-hold on a node waits before zoom-focusing it. */
export const HOLD_MS = 450;

/** The camera centring world point `p` in a `w`×`h` viewport at zoom `k` —
 *  press-and-hold's zoom-focus target (`graphFocusZoom`). */
export function focusCamera(p: { x: number; y: number }, w: number, h: number, k: number): Cam {
	return { k, tx: w / 2 - p.x * k, ty: h / 2 - p.y * k };
}

/** Glides the camera to a target over 250ms (ease-out). A new `animate` or
 *  `cancel` (a pan or wheel zoom starting) stops the one in flight. */
export function useCameraAnimation(cameraRef: { current: Cam }, setCamera: (c: Cam) => void) {
	const raf = useRef(0);
	useEffect(() => () => window.cancelAnimationFrame(raf.current), []);
	const cancel = () => window.cancelAnimationFrame(raf.current);
	const animate = (target: Cam) => {
		cancel();
		const from = cameraRef.current;
		const start = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / 250);
			const e = 1 - (1 - t) * (1 - t);
			setCamera({
				tx: from.tx + (target.tx - from.tx) * e,
				ty: from.ty + (target.ty - from.ty) * e,
				k: from.k + (target.k - from.k) * e,
			});
			if (t < 1) raf.current = window.requestAnimationFrame(step);
		};
		raf.current = window.requestAnimationFrame(step);
	};
	return { animate, cancel };
}

/** The graphs' filter button + popover: dim/hide switch (the whole row
 *  toggles), one checkbox per entity type, then any extra sections the caller
 *  passes as `children`. Closes on an outside click. */
export function GraphFilter({
	types,
	filterTypes,
	setFilterTypes,
	filterMode,
	setFilterMode,
	active,
	children,
}: {
	types: readonly EntityType[];
	filterTypes: ReadonlySet<EntityType>;
	setFilterTypes: (next: ReadonlySet<EntityType>) => void;
	filterMode: 'dim' | 'hide';
	setFilterMode: (mode: 'dim' | 'hide') => void;
	active: boolean;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useCloseOnOutsideClick(ref, open, () => setOpen(false));
	return (
		<div className="loom-graph-filter" ref={ref}>
			<button
				className={active ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
				aria-label={t('view.graph.filterGraph')}
				onClick={() => setOpen(!open)}
			>
				<Icon name="filter" />
			</button>
			{open ? (
				<div className="loom-filter-pop">
					<div
						className="loom-filter-mode loom-filter-mode-btn"
						role="switch"
						aria-checked={filterMode === 'hide'}
						onClick={() => setFilterMode(filterMode === 'dim' ? 'hide' : 'dim')}
					>
						<Icon name={filterMode === 'dim' ? 'eye-off' : 'eye-closed'} />
						<span>{filterMode === 'dim' ? t('view.graph.dimmed') : t('view.graph.hidden')}</span>
						<div className={filterMode === 'hide' ? 'checkbox-container is-enabled' : 'checkbox-container'} />
					</div>
					{types.map((et) => (
						<label key={et} className="loom-check">
							<input
								type="checkbox"
								checked={filterTypes.has(et)}
								onChange={() => {
									const next = new Set(filterTypes);
									if (next.has(et)) next.delete(et);
									else next.add(et);
									setFilterTypes(next);
								}}
							/>
							{entityPlural(et)}
						</label>
					))}
					{children}
				</div>
			) : null}
		</div>
	);
}

/** The focus record, its direct connections, and one hop further through
 *  connected beats (events/scenes). */
function neighborhoodPaths(plugin: LoomLoomPlugin, focusId: string): Set<string> {
	const keep = new Set([focusId]);
	const direct = plugin.indexer.getConnections(focusId).map((c) => c.record);
	for (const r of direct) keep.add(r.path);
	for (const r of direct) {
		if (roleOf(r.type) !== 'beat') continue;
		for (const c of plugin.indexer.getConnections(r.path)) keep.add(c.record.path);
	}
	return keep;
}

/**
 * The focused neighborhood WITHOUT any layout: the focus record, its direct
 * connections, and one hop further through connected events, plus the undirected
 * de-duplicated edges among them. Callers that want their own placement (e.g. the
 * Maps world-space focus graph) use this instead of `buildFocusLayout`.
 */
export function focusNeighborhood(
	plugin: LoomLoomPlugin,
	focusId: string
): { records: EntityRecord[]; edges: { a: string; b: string }[] } {
	const keep = neighborhoodPaths(plugin, focusId);
	const records: EntityRecord[] = [];
	for (const p of keep) {
		const rec = plugin.indexer.get(p);
		if (rec) records.push(rec);
	}
	const seen = new Set<string>();
	const edges: { a: string; b: string }[] = [];
	for (const rec of records) {
		for (const c of plugin.indexer.getOutgoing(rec.path)) {
			const b = c.record.path;
			if (!keep.has(b) || b === rec.path) continue;
			const key = rec.path < b ? rec.path + '|' + b : b + '|' + rec.path;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ a: rec.path, b });
		}
	}
	return { records, edges };
}

/**
 * The focused neighborhood laid out with the main graph's per-type layered
 * layout: the focus node, its direct connections, and one hop further through
 * connected events (so a session/location also shows the entities involved in its
 * events). `restrictTo` drops every other record, so columns/rows pack tight
 * instead of inheriting the full graph's sprawl.
 */
export function buildFocusLayout(
	plugin: LoomLoomPlugin,
	project: { root: string; config?: ProjectDef['config'] },
	focusId: string
) {
	const keep = neighborhoodPaths(plugin, focusId);
	// An anchor's (Session/Act) mini graph also surfaces the faction(s) of every
	// present character, even when the faction has no direct connection of its
	// own to the anchor or its beats — visibility only, via the character's real
	// membership edge, not a fabricated relationship.
	const focusRecord = plugin.indexer.get(focusId);
	if (focusRecord && roleOf(focusRecord.type) === 'anchor') {
		for (const p of [...keep]) {
			if (plugin.indexer.get(p)?.type !== 'character') continue;
			for (const c of plugin.indexer.getConnections(p)) {
				if (c.record.type === 'faction') keep.add(c.record.path);
			}
		}
	}
	const full = computeGraphLayout(
		plugin.indexer,
		project.root,
		plugin.settings.globalLayerOrder,
		plugin.settings.graphLineGap,
		new Map(),
		plugin.settings.graphTrunkGap,
		undefined,
		undefined,
		keep,
		features(project.config).eventPlanning
	);
	return { nodes: full.nodes, edges: full.edges, byId: new Map(full.nodes.map((n) => [n.id, n])) };
}

/**
 * Focused, interactable (but not editable) graph: one focus node, its direct
 * connections, and the edges among them. Pan, wheel-zoom, node drag with
 * spring-back, click-select dimming, double-click to open, Esc to unselect,
 * plus the standard filter popover and a fit icon — no drops, reorders,
 * deletes, or persistence.
 */
export function MiniGraph({
	plugin,
	project,
	focusId,
	version,
	onOpen,
	onCollapse,
}: {
	plugin: LoomLoomPlugin;
	project: ProjectDef;
	focusId: string;
	/** Index version — recompute when the vault changes. */
	version: number;
	onOpen: (path: string) => void;
	/** Double-click on empty space collapses the section. */
	onCollapse?: () => void;
}) {
	const data = useMemo(
		() => buildFocusLayout(plugin, project, focusId),
		[plugin, project, focusId, version]
	);

	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [camera, setCamera] = useState({ tx: 0, ty: 0, k: 1 });
	const cameraRef = useRef(camera);
	cameraRef.current = camera;
	const dispRef = useRef(new Map<string, Displacement>());
	const springRaf = useRef(0);
	const [, setTick] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [filterTypes, setFilterTypes] = useState<ReadonlySet<EntityType>>(new Set(ENTITY_TYPES));
	const [filterMode, setFilterMode] = useState<'dim' | 'hide'>('dim');
	const dragRef = useRef<{
		id: string;
		node: LayoutNode;
		pointerId: number;
		startX: number;
		startY: number;
		moved: boolean;
		/** Press-and-hold zoom-focus timer, and whether it already fired (so
		 *  the release doesn't also toggle selection). */
		holdTimer: number;
		held: boolean;
	} | null>(null);
	const panRef = useRef<PanState | null>(null);

	const filterActive = filterTypes.size < ENTITY_TYPES.length;
	const passes = (n: LayoutNode) => filterTypes.has(n.record.type) || n.id === focusId;

	const cameraAnim = useCameraAnimation(cameraRef, setCamera);
	/** Frames every node — gliding there, except the very first fit on mount. */
	const fit = (glide = true) => {
		const el = wrapRef.current;
		const cam = el ? fitCamera(data.nodes, el.clientWidth, el.clientHeight, MINI_MIN_ZOOM) : null;
		if (!cam) return;
		if (glide) cameraAnim.animate(cam);
		else setCamera(cam);
	};
	// Fit on mount and whenever the focused neighborhood changes shape (fit
	// reads refs/state, deliberately not in the dep list).
	const fitRef = useRef(fit);
	fitRef.current = fit;
	const fittedOnce = useRef(false);
	useEffect(() => {
		fitRef.current(fittedOnce.current);
		fittedOnce.current = true;
	}, [data]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setSelected(null);
		};
		const ownerDoc = wrapRef.current?.doc ?? activeDocument;
		ownerDoc.addEventListener('keydown', onKey);
		return () => ownerDoc.removeEventListener('keydown', onKey);
	}, []);

	const startSpring = () => runSpring(dispRef, springRaf, () => setTick((t) => t + 1));

	const pos = (n: LayoutNode) => {
		const d = dispRef.current.get(n.id);
		return { x: n.x + (d?.dx ?? 0), y: n.y + (d?.dy ?? 0) };
	};

	const onNodeDown = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		// A still press-and-hold zoom-focuses the node, like the main graph.
		const holdTimer = window.setTimeout(() => {
			const drag = dragRef.current;
			const el = wrapRef.current;
			if (!drag || drag.id !== node.id || drag.moved || !el) return;
			drag.held = true;
			cameraAnim.animate(focusCamera(pos(node), el.clientWidth, el.clientHeight, plugin.settings.graphFocusZoom));
		}, HOLD_MS);
		dragRef.current = {
			id: node.id,
			node,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			moved: false,
			holdTimer,
			held: false,
		};
		const d = dispRef.current.get(node.id) ?? { dx: 0, dy: 0, vx: 0, vy: 0, dragging: true };
		d.dragging = true;
		dispRef.current.set(node.id, d);
	};
	const onNodeMove = (e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		if (e.buttons === 0) {
			window.clearTimeout(drag.holdTimer);
			dragRef.current = null;
			startSpring();
			return;
		}
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		if (!drag.moved) window.clearTimeout(drag.holdTimer); // a drag cancels the hold-focus
		drag.moved = true;
		const d = dispRef.current.get(drag.id);
		if (d) {
			d.dx = dx / cameraRef.current.k;
			d.dy = dy / cameraRef.current.k;
			setTick((t) => t + 1);
		}
	};
	const onNodeUp = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		window.clearTimeout(drag.holdTimer);
		dragRef.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.moved) startSpring();
		else if (drag.held) dispRef.current.delete(drag.id);
		else {
			dispRef.current.delete(drag.id);
			setSelected((cur) => (cur === node.id ? null : node.id));
		}
	};

	const onSvgDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button !== 0) return;
		cameraAnim.cancel();
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
	const onSvgMove = (e: ReactPointerEvent<SVGSVGElement>) => panMove(panRef, e, setCamera);
	const onSvgUp = (e: ReactPointerEvent<SVGSVGElement>) => {
		const pan = panRef.current;
		if (!pan || pan.pointerId !== e.pointerId) return;
		panRef.current = null;
		if (!pan.moved) setSelected(null);
	};
	// Native non-passive listener: inside the graph the wheel only zooms —
	// React's onWheel can't reliably preventDefault the page scroll.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = el.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			setCamera((c) => zoomAt(c, mx, my, e.deltaY, MINI_MIN_ZOOM, 3));
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, []);

	const connectedTo = useMemo(() => {
		if (!selected) return null;
		const set = new Set([selected]);
		for (const e of data.edges) {
			if (e.a === selected) set.add(e.b);
			if (e.b === selected) set.add(e.a);
		}
		return set;
	}, [selected, data]);

	return (
		<div className="loom-minigraph-wrap" ref={wrapRef}>
			<svg
				className="loom-minigraph"
				onPointerDown={onSvgDown}
				onPointerMove={onSvgMove}
				onPointerUp={onSvgUp}
				onDoubleClick={() => onCollapse?.()}
			>
				<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
					{data.edges.map((edge) => {
						const a = data.byId.get(edge.a);
						const b = data.byId.get(edge.b);
						if (!a || !b) return null;
						if (filterActive && filterMode === 'hide' && (!passes(a) || !passes(b))) return null;
						const pa = pos(a);
						const pb = pos(b);
						const da = { x: pa.x - a.x, y: pa.y - a.y };
						const db = { x: pb.x - b.x, y: pb.y - b.y };
						const dim =
							(connectedTo !== null && edge.a !== selected && edge.b !== selected) ||
							(filterActive && filterMode === 'dim' && (!passes(a) || !passes(b)));
						return (
							<path
								key={edge.a + edge.b + edge.relType}
								className={dim ? 'loom-edge loom-dim' : 'loom-edge'}
								d={edgePath(edge.route, pa, pb, da, db)}
							/>
						);
					})}
					{data.nodes.map((n) => {
						if (filterActive && filterMode === 'hide' && !passes(n)) return null;
						const p = pos(n);
						const label = recordLabel(n.record, project);
						const short = label.length > 20 ? label.slice(0, 19).trimEnd() + '…' : label;
						const dim =
							(connectedTo !== null && !connectedTo.has(n.id)) ||
							(filterActive && filterMode === 'dim' && !passes(n));
						const classes = ['loom-node', 'loom-mini-node'];
						if (dim) classes.push('loom-dim');
						if (n.id === selected) classes.push('loom-node-selected');
						return (
							<g
								key={n.id}
								className={classes.join(' ')}
								transform={`translate(${p.x},${p.y})`}
								onPointerDown={(e) => onNodeDown(n, e)}
								onPointerMove={onNodeMove}
								onPointerUp={(e) => onNodeUp(n, e)}
								onDoubleClick={(e) => {
									e.stopPropagation();
									onOpen(n.id);
								}}
							>
								{short !== label ? <title>{label}</title> : null}
								<circle
									r={plugin.settings.nodeSizes[n.record.type] ?? RADII[n.kind]}
									fill={plugin.settings.nodeColors[n.record.type]}
								/>
								<text
									className="loom-node-label"
									y={(plugin.settings.nodeSizes[n.record.type] ?? RADII[n.kind]) + 16}
									textAnchor="middle"
								>
									{short}
								</text>
							</g>
						);
					})}
				</g>
			</svg>
			<div className="loom-minigraph-tools">
				<GraphFilter
					types={projectTypes(project.config)}
					filterTypes={filterTypes}
					setFilterTypes={setFilterTypes}
					filterMode={filterMode}
					setFilterMode={setFilterMode}
					active={filterActive}
				/>
				<button className="loom-rel-filter" aria-label={t('view.graph.fitView')} onClick={() => fit()}>
					<Icon name="scan" />
				</button>
			</div>
		</div>
	);
}
