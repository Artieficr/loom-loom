import { Menu, ViewStateResult } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { ENTITY_META, ENTITY_TYPES, TimelineDef, VIEW_GRAPH } from '../types';
import { CreateEntityModal } from '../project';
import { TimelineSettingsModal } from '../timeline-settings';
import { LayoutNode, computeGraphLayout } from '../graph/layout';
import { GraphSidePanel } from '../graph/side-panel';
import { LoomReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage, recordLabel } from './common';
import { TimelineStrip } from './timeline-strip';
import { resolveProject, useIndexVersion } from './hooks';

/** Screen = world * k + t. */
interface Camera {
	tx: number;
	ty: number;
	k: number;
}

/** Transient UI state carried through view state so Back restores the graph as left. */
interface GraphUiState {
	camera?: Camera;
	drawerOpen?: boolean;
	drawerHeight?: number;
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
		return 'Loom graph';
	}

	getIcon(): string {
		return 'git-fork';
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
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
/** Screen-space padding the selected node keeps from the viewport edges. */
const REVEAL_MARGIN = 90;

interface Displacement {
	dx: number;
	dy: number;
	vx: number;
	vy: number;
	dragging: boolean;
}

interface DragState {
	id: string;
	pointerId: number;
	startX: number;
	startY: number;
	moved: boolean;
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

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function Graph({ view, projectRoot }: { view: GraphView; projectRoot: string | null }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const project = resolveProject(plugin.indexer, projectRoot);
	const edgeCurve = plugin.settings.graphEdgeCurve;
	const layout = useMemo(
		() => computeGraphLayout(plugin.indexer, project?.root ?? ' none', edgeCurve),
		[plugin.indexer, version, project, edgeCurve]
	);

	const [selected, setSelected] = useState<string | null>(null);
	const [camera, setCamera] = useState<Camera>(view.restored.camera ?? { tx: 0, ty: 0, k: 1 });
	const [size, setSize] = useState({ w: 1200, h: 700 });
	const [, setTick] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(view.restored.drawerOpen ?? false);
	const [drawerHeight, setDrawerHeight] = useState(view.restored.drawerHeight ?? 240);
	const [drawerResizing, setDrawerResizing] = useState(false);
	const [defPath, setDefPath] = useState('');
	const drawerDrag = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);

	const wrapRef = useRef<HTMLDivElement>(null);
	const cameraRef = useRef(camera);
	cameraRef.current = camera;

	// Keep the view's serializable snapshot in sync so navigating away and
	// back (entity page Back button) restores the graph exactly as left.
	useEffect(() => {
		view.current = { camera, drawerOpen, drawerHeight };
	}, [view, camera, drawerOpen, drawerHeight]);
	const dispRef = useRef(new Map<string, Displacement>());
	const dragRef = useRef<DragState | null>(null);
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
		// Never zoom out when focusing — only in, up to the configured level.
		const k = Math.max(plugin.settings.graphFocusZoom, cameraRef.current.k);
		animateCamera({ k, tx: w / 2 - node.x * k, ty: h / 2 - node.y * k });
	};

	const fitAll = () => {
		const el = wrapRef.current;
		if (!el || layout.nodes.length === 0) return;
		const pad = 60;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const n of layout.nodes) {
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
			// Keep right/middle presses on a node away from the pan handler:
			// its pointer capture would retarget the contextmenu event and
			// swallow the right-click focus.
			e.stopPropagation();
			return;
		}
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		dragRef.current = { id: node.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
		const d = dispRef.current.get(node.id) ?? { dx: 0, dy: 0, vx: 0, vy: 0, dragging: true };
		d.dragging = true;
		d.vx = 0;
		d.vy = 0;
		dispRef.current.set(node.id, d);
	};

	const onNodePointerMove = (e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		drag.moved = true;
		const d = dispRef.current.get(drag.id);
		if (d) {
			// Pointer deltas are screen px; node displacement is world space.
			d.dx = dx / cameraRef.current.k;
			d.dy = dy / cameraRef.current.k;
			setTick((t) => t + 1);
		}
	};

	const onNodePointerUp = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		dragRef.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.moved) {
			startSpring();
		} else {
			dispRef.current.delete(drag.id);
			setSelected((cur) => (cur === node.id ? null : node.id));
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
					.onClick(() => new CreateEntityModal(plugin, type, project).open())
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

	const visible = useMemo(() => {
		const min = (0 - camera.tx) / camera.k - CULL_MARGIN;
		const max = (size.w - camera.tx) / camera.k + CULL_MARGIN;
		return new Set(layout.nodes.filter((n) => n.x >= min && n.x <= max).map((n) => n.id));
	}, [layout, camera, size]);

	const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
	const selectedRecord = selected ? plugin.indexer.get(selected) : undefined;

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
		const d = dispRef.current.get(n.id);
		return { x: n.x + (d?.dx ?? 0), y: n.y + (d?.dy ?? 0) };
	};

	// --- Timeline drawer -------------------------------------------------------

	const defs: TimelineDef[] = project ? plugin.indexer.getTimelines(project.root) : [];
	const activeDef: TimelineDef | null = defs.find((d) => d.path === defPath) ?? defs[0] ?? null;

	const onDrawerBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		// Buttons/selects on the bar are clickable, not drag handles.
		if (!drawerOpen || (e.target as HTMLElement).closest('button, select')) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		drawerDrag.current = { pointerId: e.pointerId, startY: e.clientY, startH: drawerHeight };
		// Height must follow the pointer 1:1 — suspend the slide transition.
		setDrawerResizing(true);
	};

	const onDrawerBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = drawerDrag.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		setDrawerHeight(clamp(drag.startH + (drag.startY - e.clientY), DRAWER_MIN, DRAWER_MAX));
	};

	const onDrawerBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (drawerDrag.current?.pointerId === e.pointerId) {
			drawerDrag.current = null;
			setDrawerResizing(false);
		}
	};

	if (!project) {
		return (
			<ViewShell view={view} project={null} title="Loom graph">
				{noProjectMessage()}
			</ViewShell>
		);
	}

	return (
		<ViewShell
			view={view}
			project={project}
			title="Loom graph"
			titleExtra={
				<button className="loom-nav-btn" onClick={fitAll}>
					Fit view
				</button>
			}
		>
			<div className="loom-graph-stack">
				<div className="loom-graph-wrap">
					<div className="loom-graph-viewport" ref={wrapRef}>
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
								if (!a || !b || (!visible.has(a.id) && !visible.has(b.id))) return null;
								const pa = pos(a);
								const pb = pos(b);
								const dim = connectedTo !== null && edge.a !== selected && edge.b !== selected;
								const key = edge.a + '|' + edge.b + '|' + edge.relType;
								const cls = dim ? 'loom-edge loom-dim' : 'loom-edge';
								if (edge.bow === 0) {
									return <line key={key} className={cls} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />;
								}
								// Obstructed edge: bow sideways (perpendicular to the
								// segment) so it stays visible next to the nodes it
								// would otherwise pass through.
								const dx = pb.x - pa.x;
								const dy = pb.y - pa.y;
								const len = Math.hypot(dx, dy) || 1;
								const cx = (pa.x + pb.x) / 2 + (-dy / len) * edge.bow;
								const cy = (pa.y + pb.y) / 2 + (dx / len) * edge.bow;
								return (
									<path
										key={key}
										className={cls}
										d={`M ${pa.x} ${pa.y} Q ${cx} ${cy} ${pb.x} ${pb.y}`}
									/>
								);
							})}
							{layout.nodes.map((node) => {
								if (!visible.has(node.id)) return null;
								const p = pos(node);
								const dim = connectedTo !== null && !connectedTo.has(node.id);
								const classes = ['loom-node', `loom-node-${node.kind}`];
								if (dim) classes.push('loom-dim');
								if (node.id === selected) classes.push('loom-node-selected');
								return (
									<g
										key={node.id}
										className={classes.join(' ')}
										transform={`translate(${p.x},${p.y})`}
										onPointerDown={(e) => onNodePointerDown(node, e)}
										onPointerMove={onNodePointerMove}
										onPointerUp={(e) => onNodePointerUp(node, e)}
										onDoubleClick={() => view.openEntity(node.id)}
										onContextMenu={(e) => {
											e.preventDefault();
											e.stopPropagation();
											focusNode(node);
										}}
									>
										<circle r={RADII[node.kind]} fill={plugin.settings.nodeColors[node.record.type]} />
										<text className="loom-node-label" y={RADII[node.kind] + 16} textAnchor="middle">
											{recordLabel(node.record, project)}
										</text>
									</g>
								);
							})}
						</g>
					</svg>
				</div>
				{selectedRecord ? (
					<GraphSidePanel
						record={selectedRecord}
						label={recordLabel(selectedRecord, project)}
						connections={plugin.indexer.getConnections(selectedRecord.path)}
						connectionLabel={(r) => recordLabel(r, project)}
						threshold={plugin.settings.graphCollapseThreshold}
						onOpen={(path) => view.openEntity(path)}
						onClose={() => setSelected(null)}
					/>
				) : null}
				{layout.nodes.length === 0 ? <div className="loom-empty loom-graph-empty">No entities yet.</div> : null}
				</div>
				<div className="loom-drawer">
					<div
						className={drawerOpen ? 'loom-drawer-bar loom-drawer-bar-open' : 'loom-drawer-bar'}
						onPointerDown={onDrawerBarPointerDown}
						onPointerMove={onDrawerBarPointerMove}
						onPointerUp={onDrawerBarPointerUp}
					>
						<button className="loom-nav-btn loom-drawer-toggle" onClick={() => setDrawerOpen(!drawerOpen)}>
							<Icon name={drawerOpen ? 'chevron-down' : 'chevron-up'} />
							{drawerOpen ? 'Collapse timeline' : 'Open timeline'}
						</button>
						{drawerOpen && defs.length > 1 ? (
							<select className="dropdown" value={activeDef?.path ?? ''} onChange={(e) => setDefPath(e.target.value)}>
								{defs.map((d) => (
									<option key={d.path} value={d.path}>
										{d.name}
									</option>
								))}
							</select>
						) : null}
						<div className="loom-shell-spacer" />
						{drawerOpen ? (
							<button
								className="loom-nav-btn"
								onClick={() => new TimelineSettingsModal(plugin, project).open()}
							>
								Timeline settings
							</button>
						) : null}
					</div>
					<div
						className={drawerResizing ? 'loom-drawer-body' : 'loom-drawer-body loom-drawer-anim'}
						style={{ height: drawerOpen ? drawerHeight : 0 }}
					>
						{/* Inner keeps its full height while the outer collapses, so
						    closing slides the content away instead of squishing it. */}
						<div className="loom-drawer-inner" style={{ height: drawerHeight }}>
							<TimelineStrip navigator={view} project={project} def={activeDef} />
						</div>
					</div>
				</div>
			</div>
		</ViewShell>
	);
}
