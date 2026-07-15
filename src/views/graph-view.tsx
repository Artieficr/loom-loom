import { Menu, Notice, ViewStateResult, debounce, setTooltip } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	ReactElement,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { ENTITY_META, ENTITY_TYPES, GraphCamera, TimelineDef, VIEW_GRAPH } from '../types';
import { ConfirmModal, CreateEntityModal, RelationshipPromptModal } from '../project';
import { extractLinkpath } from '../indexer';
import { LayoutNode, computeGraphLayout } from '../graph/layout';
import { Pt, edgeEndDirs, edgePath, edgeXRange } from '../graph/routing';
import { GraphSidePanel } from '../graph/side-panel';
import { LoomReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage, recordLabel } from './common';
import { TimelineStrip } from './timeline-strip';
import { resolveProject, useIndexVersion } from './hooks';

type Camera = GraphCamera;

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
/** World-space margin around a node's circle within which a dragged node snaps to it as a drop target. */
const DROP_SNAP = 12;

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
	const layout = useMemo(
		() =>
			computeGraphLayout(
				plugin.indexer,
				project?.root ?? ' none',
				plugin.settings.globalLayerOrder,
				plugin.settings.graphLineGap,
				new Map(Object.entries(project ? plugin.settings.graphManualX[project.root] ?? {} : {}))
			),
		// layerKey stands in for the order array (mutated in place by settings).
		[plugin.indexer, version, project, layerKey, plugin.settings.graphLineGap, manualVersion]
	);

	const [selected, setSelected] = useState<string | null>(null);
	const [camera, setCamera] = useState<Camera>(
		() =>
			view.restored.camera ??
			(project ? plugin.settings.graphCameras[project.root] : undefined) ?? { tx: 0, ty: 0, k: 1 }
	);
	const [size, setSize] = useState({ w: 1200, h: 700 });
	const [, setTick] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(view.restored.drawerOpen ?? false);
	const [drawerHeight, setDrawerHeight] = useState(view.restored.drawerHeight ?? 240);
	const [drawerResizing, setDrawerResizing] = useState(false);
	const [defPath, setDefPath] = useState('');
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
	useEffect(() => {
		view.current = { camera, drawerOpen, drawerHeight };
		if (project) persistCamera(project.root, camera);
	}, [view, camera, drawerOpen, drawerHeight, project, persistCamera]);
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
		dragRef.current = { id: node.id, node, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
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
			// Drop-to-connect: does the dragged node's center sit on another node?
			const cx = drag.node.x + d.dx;
			const cy = drag.node.y + d.dy;
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
			setTick((t) => t + 1);
		}
	};

	const onNodePointerUp = (node: LayoutNode, e: ReactPointerEvent<SVGGElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		dragRef.current = null;
		const dropId = dropRef.current;
		dropRef.current = null;
		const d = dispRef.current.get(drag.id);
		if (d) d.dragging = false;
		if (drag.moved) {
			const target = dropId !== null ? layout.nodes.find((n) => n.id === dropId) : undefined;
			if (target) {
				startSpring();
				onNodeDrop(drag.node, target);
			} else if (
				(drag.node.kind === 'global' ||
					(drag.node.kind === 'event' &&
						drag.node.record.date === null &&
						(layout.neighbors.get(drag.id)?.size ?? 0) === 0)) &&
				project &&
				d
			) {
				// Reorder drop: persisted for globals and for free events
				// (dateless + unconnected — they float outside the column
				// flow); the layout decides its weight — free-floating
				// components follow the drop (towing their neighbors),
				// timeline-anchored ones ease back home (their forces win).
				const wx = drag.node.x + d.dx;
				const wy = drag.node.y + d.dy;
				const forProject = (plugin.settings.graphManualX[project.root] ??= {});
				forProject[drag.id] = wx;
				void plugin.saveSettings();
				pendingReorder.current = { id: drag.id, x: wx, y: wy };
				setManualVersion((v) => v + 1);
			} else {
				startSpring();
			}
		} else {
			dispRef.current.delete(drag.id);
			setSelected((cur) => (cur === node.id ? null : node.id));
		}
	};

	// --- Drop-to-connect -------------------------------------------------------

	/** Does `from`'s own note declare a relationship (or linkedSession) pointing at `toId`? */
	const declaresConnection = (from: LayoutNode, toId: string): boolean => {
		const hits = (linkpath: string) => plugin.indexer.resolve(linkpath, from.id)?.path === toId;
		return (
			from.record.relationships.some((r) => hits(r.linkpath)) ||
			(from.record.type === 'event' && from.record.linkedSessions.some(hits))
		);
	};

	/** The dragged node is always the declaring side: dropping it on a node it
	 *  doesn't yet declare adds a relationship to ITS note (even if the other
	 *  side declares one back — that's how mutual pairs are built); dropping it
	 *  on one it already declares offers to remove its own declaration. */
	const onNodeDrop = (from: LayoutNode, to: LayoutNode) => {
		const fromLabel = recordLabel(from.record, project);
		const toLabel = recordLabel(to.record, project);
		if (declaresConnection(from, to.id)) {
			new ConfirmModal(
				plugin.app,
				'Remove relationship',
				`Remove the relationship ${fromLabel} declares to ${toLabel}?`,
				() => removeConnection(from, to),
				'Remove'
			).open();
			return;
		}
		new RelationshipPromptModal(plugin.app, fromLabel, toLabel, (relType) => {
			const file = plugin.app.vault.getFileByPath(from.id);
			if (!file) return;
			plugin.app.fileManager
				.processFrontMatter(file, (fm: Record<string, unknown>) => {
					const rels = Array.isArray(fm.relationships) ? fm.relationships : [];
					rels.push({ type: relType, target: `[[${to.record.name}]]` });
					fm.relationships = rels;
				})
				.catch((err) => {
					console.error('Loom Loom: failed to connect entities', err);
					new Notice('Could not create the connection.');
				});
		}).open();
	};

	/** Removes the dragged node's own declarations pointing at `other`: typed
	 *  relationship entries and (for events) linkedSession links. The other
	 *  side's declarations are untouched — drag it to remove those. */
	const removeConnection = async (node: LayoutNode, other: LayoutNode) => {
		const resolvesToOther = (linkpath: string) =>
			plugin.indexer.resolve(linkpath, node.id)?.path === other.id;
		const file = plugin.app.vault.getFileByPath(node.id);
		if (!file) return;
		try {
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (Array.isArray(fm.relationships)) {
					fm.relationships = fm.relationships.filter((rel: unknown) => {
						if (typeof rel !== 'object' || rel === null) return true;
						const target = (rel as { target?: unknown }).target;
						if (typeof target !== 'string') return true;
						const linkpath = extractLinkpath(target);
						return linkpath === null || !resolvesToOther(linkpath);
					});
				}
				if (node.record.type === 'event') {
					const raw = fm.linkedSession;
					const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
					fm.linkedSession = list.filter((entry: unknown) => {
						if (typeof entry !== 'string') return true;
						const linkpath = extractLinkpath(entry);
						return linkpath === null || !resolvesToOther(linkpath);
					});
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
							// Open through the view so the graph is recorded as the
							// origin — the entity page's Back returns here, not to
							// the type's list.
							onCreated: (file) => view.openEntity(file.path),
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

	// After a reorder drop relayouts the row, seed the dropped node's
	// displacement with (release point − new home) so it eases into place.
	useEffect(() => {
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
								if (!a || !b) return null;
								const pa = pos(a);
								const pb = pos(b);
								// Cull on the full route extent, so a long trunk
								// stays visible while both endpoints are off-screen.
								const [minX, maxX] = edgeXRange(edge.route, pa, pb);
								if (maxX < viewRange.min || minX > viewRange.max) return null;
								const dim = connectedTo !== null && edge.a !== selected && edge.b !== selected;
								const key = edge.a + '|' + edge.b + '|' + edge.relType;
								// Declaration arrowheads, tips at the node rims.
								const arrowSize = plugin.settings.graphArrowSize;
								let arrows: ReactElement | null = null;
								if (edge.arrowA || edge.arrowB) {
									const dirs = edgeEndDirs(edge.route, pa, pb);
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
											d={edgePath(edge.route, pa, pb)}
										/>
										{arrows}
									</g>
								);
							})}
							{layout.nodes.map((node) => {
								if (!visible.has(node.id)) return null;
								const p = pos(node);
								const dim = connectedTo !== null && !connectedTo.has(node.id);
								const classes = ['loom-node', `loom-node-${node.kind}`];
								if (dim) classes.push('loom-dim');
								if (node.id === selected) classes.push('loom-node-selected');
								const label = recordLabel(node.record, project);
								const shortLabel = label.length > 24 ? label.slice(0, 23).trimEnd() + '…' : label;
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
										{/* Native SVG tooltip carries the full name when truncated. */}
										{shortLabel !== label ? <title>{label}</title> : null}
										{dropRef.current === node.id && dragRef.current ? (
											<circle
												className={
													declaresConnection(dragRef.current.node, node.id)
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
