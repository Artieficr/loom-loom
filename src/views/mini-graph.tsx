import {
	PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { ENTITY_META, ENTITY_TYPES, EntityType } from '../types';
import { LayoutNode, computeGraphLayout } from '../graph/layout';
import { edgePath } from '../graph/routing';
import { LoomIndexer, ProjectDef } from '../indexer';
import { Icon, recordLabel } from './common';
import type LoomLoomPlugin from '../main';

const RADII = { session: 26, event: 20, global: 17 } as const;
const CLICK_SLOP = 4;

interface Disp {
	dx: number;
	dy: number;
	vx: number;
	vy: number;
	dragging: boolean;
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
	const data = useMemo(() => {
		// The neighborhood is laid out as if it were the whole project: a thin
		// indexer proxy hides every other record, so columns/rows pack tight
		// instead of inheriting the full graph's sprawl.
		const keep = new Set([focusId]);
		const direct = plugin.indexer.getConnections(focusId).map((c) => c.record);
		for (const r of direct) keep.add(r.path);
		// Reach one hop further through connected events, so a session (or any
		// focus) also shows the entities involved in its events — they connect to
		// the event, not the focus, so they'd otherwise be missing.
		for (const r of direct) {
			if (r.type !== 'event') continue;
			for (const c of plugin.indexer.getConnections(r.path)) keep.add(c.record.path);
		}
		const real = plugin.indexer;
		const sub = {
			getAll: (type?: Parameters<LoomIndexer['getAll']>[0], root?: string) =>
				real.getAll(type, root).filter((r) => keep.has(r.path)),
			getOutgoing: (path: string) =>
				real.getOutgoing(path).filter((c) => keep.has(c.record.path)),
			getConnections: (path: string) =>
				real.getConnections(path).filter((c) => keep.has(c.record.path)),
			resolve: (lp: string, sp: string) => real.resolve(lp, sp),
			get: (p: string) => real.get(p),
			getProjectByRoot: (r: string) => real.getProjectByRoot(r),
		} as unknown as LoomIndexer;
		const full = computeGraphLayout(
			sub,
			project.root,
			plugin.settings.globalLayerOrder,
			plugin.settings.graphLineGap,
			new Map(),
			plugin.settings.graphTrunkGap
		);
		return { nodes: full.nodes, edges: full.edges, byId: new Map(full.nodes.map((n) => [n.id, n])) };
	}, [plugin, project, focusId, version]);

	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [camera, setCamera] = useState({ tx: 0, ty: 0, k: 1 });
	const cameraRef = useRef(camera);
	cameraRef.current = camera;
	const dispRef = useRef(new Map<string, Disp>());
	const springRaf = useRef(0);
	const [, setTick] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [filterOpen, setFilterOpen] = useState(false);
	const [filterTypes, setFilterTypes] = useState<ReadonlySet<EntityType>>(new Set(ENTITY_TYPES));
	const [filterMode, setFilterMode] = useState<'dim' | 'hide'>('dim');
	const dragRef = useRef<{
		id: string;
		node: LayoutNode;
		pointerId: number;
		startX: number;
		startY: number;
		moved: boolean;
	} | null>(null);
	const panRef = useRef<{ pointerId: number; startX: number; startY: number; tx0: number; ty0: number; moved: boolean } | null>(null);

	const filterActive = filterTypes.size < ENTITY_TYPES.length;
	const passes = (n: LayoutNode) => filterTypes.has(n.record.type) || n.id === focusId;

	const fit = () => {
		const el = wrapRef.current;
		if (!el || data.nodes.length === 0) return;
		const pad = 60;
		const minX = Math.min(...data.nodes.map((n) => n.x)) - pad;
		const maxX = Math.max(...data.nodes.map((n) => n.x)) + pad;
		const minY = Math.min(...data.nodes.map((n) => n.y)) - pad;
		const maxY = Math.max(...data.nodes.map((n) => n.y)) + pad;
		const k = Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY), 1.5);
		setCamera({
			tx: el.clientWidth / 2 - ((minX + maxX) / 2) * k,
			ty: el.clientHeight / 2 - ((minY + maxY) / 2) * k,
			k,
		});
	};
	// Fit on mount and whenever the focused neighborhood changes shape (fit
	// reads refs/state, deliberately not in the dep list).
	const fitRef = useRef(fit);
	fitRef.current = fit;
	useEffect(() => fitRef.current(), [data]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setSelected(null);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);

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

	const pos = (n: LayoutNode) => {
		const d = dispRef.current.get(n.id);
		return { x: n.x + (d?.dx ?? 0), y: n.y + (d?.dy ?? 0) };
	};

	const onNodeDown = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		dragRef.current = { id: node.id, node, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
		const d = dispRef.current.get(node.id) ?? { dx: 0, dy: 0, vx: 0, vy: 0, dragging: true };
		d.dragging = true;
		dispRef.current.set(node.id, d);
	};
	const onNodeMove = (e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		if (e.buttons === 0) {
			dragRef.current = null;
			startSpring();
			return;
		}
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
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
		dragRef.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.moved) startSpring();
		else {
			dispRef.current.delete(drag.id);
			setSelected((cur) => (cur === node.id ? null : node.id));
		}
	};

	const onSvgDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (e.button !== 0) return;
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
	const onSvgMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		const pan = panRef.current;
		if (!pan || pan.pointerId !== e.pointerId) return;
		const dx = e.clientX - pan.startX;
		const dy = e.clientY - pan.startY;
		if (!pan.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		pan.moved = true;
		setCamera((c) => ({ ...c, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
	};
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
			setCamera((c) => {
				const k = Math.max(0.2, Math.min(3, c.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
				return { tx: mx - ((mx - c.tx) / c.k) * k, ty: my - ((my - c.ty) / c.k) * k, k };
			});
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
				<div className="loom-graph-filter">
					<button
						className={filterActive ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
						aria-label="Filter graph"
						onClick={() => setFilterOpen(!filterOpen)}
					>
						<Icon name="filter" />
					</button>
					{filterOpen ? (
						<div className="loom-filter-pop">
							<div className="loom-filter-mode">
								<Icon name={filterMode === 'dim' ? 'eye-off' : 'eye-closed'} />
								<span>{filterMode === 'dim' ? 'Dimmed' : 'Hidden'}</span>
								<div
									className={filterMode === 'hide' ? 'checkbox-container is-enabled' : 'checkbox-container'}
									role="switch"
									aria-checked={filterMode === 'hide'}
									onClick={() => setFilterMode(filterMode === 'dim' ? 'hide' : 'dim')}
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
						</div>
					) : null}
				</div>
				<button className="loom-rel-filter" aria-label="Fit view" onClick={fit}>
					<Icon name="scan" />
				</button>
			</div>
		</div>
	);
}
