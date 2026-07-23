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
	MAPS_FOLDER,
	MAPS_ICON,
	MAPS_LABEL,
	NODE_SIZE_PRESETS,
	NodeSizePreset,
	VIEW_MAP,
} from '../types';
import { RecordSuggestModal } from '../project';
import { linkTargetOf } from '../indexer';
import { LoomReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage, recordLabel } from './common';
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
	/** Associated location's file path (link target), or null. */
	location: string | null;
	/** Node world position (pinned inside the zone), or null when unassociated. */
	node: { x: number; y: number } | null;
	/** Node size preset. */
	nodeSize: NodeSizePreset;
	/** Locked zones can't be moved or reshaped (still selectable). */
	locked: boolean;
}

interface MapData {
	version: number;
	zones: MapZone[];
}

const DEFAULT_ALPHA = 0.35;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const CLOSE_SNAP = 12; // screen px to the first vertex that closes a draft
const VERTEX_R = 5; // handle radius (screen px)

function emptyData(): MapData {
	return { version: 1, zones: [] };
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

function newId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A darker shade of a hex color (for zone outlines) — mirrors how the home
 *  wheel derives a readable border from the icon color. */
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

/** Ray-casting point-in-polygon. */
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

/** Distance from a point to the nearest edge of a polygon. */
function distToPolygon(px: number, py: number, pts: { x: number; y: number }[]): number {
	let best = Infinity;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		best = Math.min(best, distToSegment(px, py, pts[j], pts[i]));
	}
	return best;
}

function distToSegment(
	px: number,
	py: number,
	a: { x: number; y: number },
	b: { x: number; y: number }
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy || 1;
	let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

interface Camera {
	tx: number;
	ty: number;
	k: number;
}

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
	const [camera, setCamera] = useState<Camera>({ tx: 0, ty: 0, k: 1 });
	const cameraRef = useRef(camera);
	cameraRef.current = camera;

	const [zones, setZones] = useState<MapZone[]>([]);
	const zonesRef = useRef(zones);
	zonesRef.current = zones;
	const [tool, setTool] = useState<'select' | 'draw'>('select');
	const [draft, setDraft] = useState<{ x: number; y: number }[]>([]);
	const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	/** Right-click menu on empty space. */
	const [globalMenu, setGlobalMenu] = useState<{ sx: number; sy: number; wx: number; wy: number } | null>(
		null
	);
	/** Where the zone context menu was opened in world space (node lands here). */
	const menuWorld = useRef<{ x: number; y: number } | null>(null);

	// --- Persistence ---------------------------------------------------------
	const mapPath = useMemo(() => {
		if (!project) return null;
		const base = `${MAPS_FOLDER}/${project.name} Map.json`;
		return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
	}, [project]);

	// Load once per project.
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
			// Create the Maps folder then the file.
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

	/** Commit a new zones array to state + disk. */
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

	// Wheel zoom around the cursor (native, non-passive so preventDefault works).
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
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

	// --- Drag machinery (pan / vertex / grip) --------------------------------
	const drag = useRef<
		| null
		| { kind: 'pan'; startX: number; startY: number; tx0: number; ty0: number }
		| { kind: 'vertex'; id: string; index: number }
		| { kind: 'grip'; id: string; last: { x: number; y: number } }
	>(null);
	const [dragActive, setDragActive] = useState(false);

	useEffect(() => {
		if (!dragActive) return;
		const onMove = (e: PointerEvent) => {
			const d = drag.current;
			if (!d) return;
			if (d.kind === 'pan') {
				setCamera({ tx: d.tx0 + (e.clientX - d.startX), ty: d.ty0 + (e.clientY - d.startY), k: cameraRef.current.k });
				return;
			}
			const { sx, sy } = localXY(e.clientX, e.clientY);
			const w = toWorld(sx, sy);
			if (d.kind === 'vertex') {
				const cur = zonesRef.current;
				setZones(
					cur.map((z) =>
						z.id === d.id
							? { ...z, points: z.points.map((p, i) => (i === d.index ? { x: w.x, y: w.y } : p)) }
							: z
					)
				);
			} else if (d.kind === 'grip') {
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
			}
		};
		const onUp = () => {
			const d = drag.current;
			drag.current = null;
			setDragActive(false);
			if (d && (d.kind === 'vertex' || d.kind === 'grip')) saveLater(zonesRef.current);
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
		if (e.button === 2) return; // right-click handled by contextmenu
		const { sx, sy } = localXY(e.clientX, e.clientY);
		const w = toWorld(sx, sy);
		setGlobalMenu(null);

		if (tool === 'draw') {
			if (e.button !== 0) return;
			// Close the shape if clicking near the first point (min 3 points).
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

		// Select mode: hit-test zones (topmost first).
		const hit = hitZone(sx, sy);
		if (hit) {
			setSelected(hit.id);
			menuWorld.current = w;
			return;
		}
		// Empty space → start pan.
		setSelected(null);
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
		const hit = hitZone(sx, sy);
		if (hit) {
			setSelected(hit.id);
			menuWorld.current = w;
		} else {
			setSelected(null);
			setGlobalMenu({ sx, sy, wx: w.x, wy: w.y });
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
		setSelected(zone.id);
	};
	const cancelDraft = () => {
		setDraft([]);
		setCursor(null);
	};

	// Esc cancels a draft / clears selection.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (draft.length > 0) cancelDraft();
			else if (selected) setSelected(null);
			else if (tool === 'draw') setTool('select');
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [draft.length, selected, tool]);

	// --- Zone actions --------------------------------------------------------
	const associate = (zone: MapZone) => {
		const locations = plugin.indexer.getAll('location', project?.root).slice();
		if (locations.length === 0) {
			new Notice('No locations to associate yet.');
			return;
		}
		new RecordSuggestModal(
			plugin.app,
			locations,
			(rec) => {
				const at = menuWorld.current ?? centroid(zone.points);
				updateZone(zone.id, { location: linkTargetOf(rec), node: { x: at.x, y: at.y } });
			},
			'Associate with a location…',
			(r) => recordLabel(r, project)
		).open();
	};
	const deleteZone = (id: string) => {
		commit(zonesRef.current.filter((z) => z.id !== id));
		setSelected(null);
	};

	if (!project) {
		return (
			<ViewShell view={view} project={null} title={MAPS_LABEL}>
				{noProjectMessage()}
			</ViewShell>
		);
	}

	const selectedZone = zones.find((z) => z.id === selected) ?? null;

	return (
		<ViewShell
			view={view}
			project={project}
			title={MAPS_LABEL}
			titleExtra={
				<button
					className={tool === 'draw' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
					aria-label={tool === 'draw' ? 'Stop drawing' : 'Draw a zone'}
					onClick={() => {
						cancelDraft();
						setTool(tool === 'draw' ? 'select' : 'draw');
						setSelected(null);
					}}
				>
					<Icon name="pen-tool" fallback="pencil" />
				</button>
			}
		>
			<div className={tool === 'draw' ? 'loom-map-wrap loom-map-drawing' : 'loom-map-wrap'} ref={wrapRef}>
				<svg
					className="loom-map-svg"
					onPointerDown={onCanvasPointerDown}
					onPointerMove={onCanvasPointerMove}
					onContextMenu={onContextMenu}
				>
					<g transform={`translate(${camera.tx},${camera.ty}) scale(${camera.k})`}>
						{zones.map((z) => {
							const stroke = darker(z.color);
							const d = z.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
							const isSel = z.id === selected;
							return (
								<g key={z.id}>
									<path
										d={d}
										fill={z.color}
										fillOpacity={z.alpha}
										stroke={stroke}
										strokeWidth={(isSel ? 2.5 : 1.5) / camera.k}
									/>
									{isSel &&
										!z.locked &&
										z.points.map((p, i) => (
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
										))}
									{z.node ? (
										<g
											className="loom-map-node"
											onPointerDown={(e) => {
												e.stopPropagation();
												setSelected(z.id);
											}}
										>
											<circle
												cx={z.node.x}
												cy={z.node.y}
												r={NODE_SIZE_PRESETS[z.nodeSize] / camera.k}
												fill={stroke}
											/>
											<text
												x={z.node.x}
												y={z.node.y + (NODE_SIZE_PRESETS[z.nodeSize] + 14) / camera.k}
												textAnchor="middle"
												className="loom-map-node-label"
												style={{ fontSize: `${13 / camera.k}px` }}
											>
												{locationName(z.location)}
											</text>
										</g>
									) : null}
								</g>
							);
						})}
						{/* Draft polygon while drawing. */}
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
					</g>
				</svg>

				{/* Zone context menu (horizontal panel). */}
				{selectedZone
					? (() => {
							const c = centroid(selectedZone.points);
							const top = selectedZone.points.reduce((m, p) => Math.min(m, p.y), Infinity);
							const s = screenOf(c.x, top);
							return (
								<ZonePanel
									key={selectedZone.id}
									zone={selectedZone}
									left={s.x}
									top={s.y}
									onGripDown={(e) => {
										if (selectedZone.locked) return;
										const { sx, sy } = localXY(e.clientX, e.clientY);
										drag.current = { kind: 'grip', id: selectedZone.id, last: toWorld(sx, sy) };
										setDragActive(true);
									}}
									onAssociate={() => associate(selectedZone)}
									onColor={(color) => updateZone(selectedZone.id, { color })}
									onAlpha={(alpha) => updateZone(selectedZone.id, { alpha })}
									onResetAlpha={() => updateZone(selectedZone.id, { alpha: DEFAULT_ALPHA })}
									onNodeSize={(nodeSize) => updateZone(selectedZone.id, { nodeSize })}
									onToggleLock={() => updateZone(selectedZone.id, { locked: !selectedZone.locked })}
									onDelete={() => deleteZone(selectedZone.id)}
									onClose={() => setSelected(null)}
								/>
							);
						})()
					: null}

				{/* Global (empty-space) context menu. */}
				{globalMenu ? (
					<div
						className="loom-map-menu loom-map-global-menu"
						style={{ left: globalMenu.sx, top: globalMenu.sy }}
					>
						<button
							className="loom-map-menu-btn"
							onClick={() => {
								setGlobalMenu(null);
								setTool('draw');
							}}
						>
							<Icon name="pen-tool" fallback="pencil" />
							<span>Draw zone</span>
						</button>
						<button
							className="loom-map-menu-btn"
							onClick={() => {
								setGlobalMenu(null);
								new Notice('Background images are coming soon.');
							}}
						>
							<Icon name="image" />
							<span>Import image</span>
						</button>
						<button
							className="loom-map-menu-btn"
							onClick={() => {
								setGlobalMenu(null);
								new Notice('Waypoints view is coming soon.');
							}}
						>
							<Icon name="waypoints" />
							<span>Waypoints</span>
						</button>
					</div>
				) : null}

				{zones.length === 0 && draft.length === 0 ? (
					<div className="loom-map-hint">
						Right-click for options, or use the pen to draw a zone.
					</div>
				) : null}
			</div>
		</ViewShell>
	);

	function locationName(target: string | null): string {
		if (!target) return '';
		const rec = plugin.indexer.resolve(target, project?.loomPath ?? '');
		return rec ? recordLabel(rec, project) : target;
	}
}

/** The horizontal per-zone context menu. */
function ZonePanel({
	zone,
	left,
	top,
	onGripDown,
	onAssociate,
	onColor,
	onAlpha,
	onResetAlpha,
	onNodeSize,
	onToggleLock,
	onDelete,
	onClose,
}: {
	zone: MapZone;
	left: number;
	top: number;
	onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	onAssociate: () => void;
	onColor: (color: string) => void;
	onAlpha: (alpha: number) => void;
	onResetAlpha: () => void;
	onNodeSize: (size: NodeSizePreset) => void;
	onToggleLock: () => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	return (
		<div className="loom-map-menu loom-map-zone-menu" style={{ left, top }}>
			<button
				className="loom-map-menu-btn"
				aria-label="Move zone"
				title={zone.locked ? 'Locked' : 'Move zone'}
				disabled={zone.locked}
				onPointerDown={onGripDown}
			>
				<Icon name="grip" fallback="move" />
			</button>
			<button className="loom-map-menu-btn" aria-label="Associate with a location" onClick={onAssociate}>
				<Icon name="map-pin" />
				<span>{zone.location ? 'Change location' : 'Associate with…'}</span>
			</button>
			<label className="loom-map-menu-btn" title="Zone color">
				<Icon name="palette" />
				<input
					type="color"
					value={zone.color}
					onChange={(e) => onColor(e.target.value)}
					className="loom-map-color"
				/>
			</label>
			<div className="loom-map-menu-alpha" title="Transparency">
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
			</div>
			{zone.location ? (
				<select
					className="loom-map-size"
					value={zone.nodeSize}
					title="Node size"
					onChange={(e) => onNodeSize(e.target.value as NodeSizePreset)}
				>
					<option value="small">Small</option>
					<option value="regular">Regular</option>
					<option value="big">Big</option>
					<option value="very-big">Very big</option>
				</select>
			) : null}
			<button
				className={zone.locked ? 'loom-map-menu-btn loom-filter-active' : 'loom-map-menu-btn'}
				aria-label={zone.locked ? 'Unlock zone' : 'Lock zone'}
				onClick={onToggleLock}
			>
				<Icon name={zone.locked ? 'lock' : 'lock-open'} fallback="lock" />
			</button>
			<button className="loom-map-menu-btn loom-map-danger" aria-label="Delete zone" onClick={onDelete}>
				<Icon name="trash-2" />
			</button>
			<button className="loom-map-menu-btn" aria-label="Close" onClick={onClose}>
				<Icon name="x" />
			</button>
		</div>
	);
}
