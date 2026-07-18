import { Menu, Notice } from 'obsidian';
import {
	CSSProperties,
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import { EntityRecord, FM, TimelineDef } from '../types';
import { buildColumns } from '../columns';
import { ProjectDef, extractLinkpath, linkTargetOf } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { ConfirmModal, CreateEntityModal } from '../project';
import { LoomNavigator } from './react-view';
import { Icon, recordDate, recordLabel } from './common';
import { useIndexVersion } from './hooks';

/** Longest description shown in the hover tooltip, in words. */
const TOOLTIP_MAX_WORDS = 30;

/** "No date" panel state, remembered across re-mounts within the session. */
let nodateOpen = true;
let nodateWidth = 170;
const NODATE_MIN = 120;
const NODATE_MAX = 400;

/** Cursor travel (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 5;
/** Fallback slide distance when a list has too few bubbles to measure. */
const DEFAULT_SLOT = 34;

function truncateWords(text: string, max: number): string {
	const words = text.split(/\s+/).filter((w) => w !== '');
	return words.length <= max ? text : words.slice(0, max).join(' ') + ' …';
}

interface TooltipState {
	record: EntityRecord;
	/** Full display label — the tooltip header when the strip cut it off. */
	label: string;
	/** Whether the name is ellipsized in the strip (measured on hover). */
	truncated: boolean;
	x: number;
	y: number;
	/** Rendered above the chip when there's no room below it. */
	above: boolean;
	/** Portal target — the chip's own document (supports pop-out windows). */
	body: HTMLElement;
}

/** A pointer drag in progress (state drives the live transforms). */
interface LiveDrag {
	path: string;
	/** List the bubble came from: 'nodate' or a session path; null for
	 *  bubbles outside any reorderable list (dated sessionless anchors). */
	originKey: string | null;
	originIndex: number;
	dx: number;
	dy: number;
	/** Drop zone under the cursor, if any. */
	overKey: string | null;
	/** Insertion slot in the hovered list (dragged bubble excluded). */
	insertIndex: number;
	/** Slide distance of the hovered list. */
	slot: number;
	/** Slide distance of the origin list (gap closing). */
	originSlot: number;
	/** Viewport spot where the bubble would land — the ghost preview. */
	ghost: { x: number; y: number; width: number } | null;
}

function Bubble({
	record,
	kind,
	label,
	navigator,
	setTooltip,
	suppressTooltip,
	className,
	style,
	onDragDown,
	onDragMove,
	onDragUp,
	clickSuppressed,
}: {
	record: EntityRecord;
	kind: 'session' | 'event';
	label: string;
	navigator: LoomNavigator;
	setTooltip: (t: TooltipState | null) => void;
	suppressTooltip: boolean;
	className?: string;
	style?: CSSProperties;
	onDragDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	onDragMove?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	onDragUp?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	/** Reads-and-clears the "that press was a drag" flag. */
	clickSuppressed?: () => boolean;
}) {
	return (
		<button
			className={['loom-bubble', `loom-bubble-${kind}`, className ?? ''].filter(Boolean).join(' ')}
			style={style}
			data-bubble-path={record.path}
			onPointerDown={onDragDown}
			onPointerMove={onDragMove}
			onPointerUp={onDragUp}
			onPointerCancel={onDragUp}
			onClick={() => {
				if (clickSuppressed?.()) return;
				navigator.openEntity(record.path);
			}}
			onMouseEnter={(e) => {
				if (suppressTooltip) return;
				const el = e.currentTarget;
				const nameEl = el.querySelector('.loom-bubble-name');
				const truncated = nameEl instanceof HTMLElement && nameEl.scrollWidth > nameEl.clientWidth + 1;
				const rect = el.getBoundingClientRect();
				// Flip above the chip when a below-tooltip would leave the window
				// (the drawer sits at the bottom of the screen).
				const above = rect.bottom + 200 > el.win.innerHeight;
				setTooltip({
					record,
					label,
					truncated,
					x: rect.left + rect.width / 2,
					y: above ? rect.top : rect.bottom,
					above,
					body: el.doc.body,
				});
			}}
			onMouseLeave={() => setTooltip(null)}
		>
			<span className="loom-bubble-name">{label}</span>
		</button>
	);
}

/**
 * The chronological session/event strip — the timeline drawer's whole body.
 *
 * Layout: [No date panel][vertical toggle bar][scrolling strip], all full
 * height. The panel slides out of the strip's left edge exactly like the
 * timeline drawer slides out of the workspace bottom — the bar is the toggle
 * (chevron), its edge strip resizes the panel.
 *
 * Event bubbles drag with the pointer (no native DnD): inside their own list
 * the bubble rides a vertical rail stuck to the cursor while siblings slide
 * out of the way in real time; leaving the list frees both axes, and
 * dropping on a session column pins the event there, on the panel unpins it
 * and clears its date. Left-button drag on empty space pans within the
 * scroll bounds; plain wheel scrolls vertically, Ctrl+wheel horizontally;
 * right-click opens the create menu.
 */
export function TimelineStrip({
	navigator,
	project,
	def,
}: {
	navigator: LoomNavigator;
	project: ProjectDef;
	def: TimelineDef | null;
}) {
	const plugin = navigator.plugin;
	const indexer = plugin.indexer;
	const version = useIndexVersion(indexer);
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const [open, setOpenState] = useState(nodateOpen);
	const setOpen = (v: boolean) => {
		nodateOpen = v;
		setOpenState(v);
	};
	const [panelWidth, setPanelWidthState] = useState(nodateWidth);
	const setPanelWidth = (w: number) => {
		nodateWidth = w;
		setPanelWidthState(w);
	};
	const [panelResizing, setPanelResizing] = useState(false);
	const resizeRef = useRef<{ id: number; x: number; w: number } | null>(null);
	/** Bumped after a manual reorder (settings changes don't bump the index). */
	const [orderBump, setOrderBump] = useState(0);
	/** Left-button pan over empty strip space; scrollLeft/Top clamp for free. */
	const panRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	// --- Pointer drag state --------------------------------------------------
	const [drag, setDrag] = useState<LiveDrag | null>(null);
	/** Mirror of the latest computed drag, immune to state-update lag. */
	const dragRef = useRef<LiveDrag | null>(null);
	const pressRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		active: boolean;
		path: string;
		originKey: string | null;
		originIndex: number;
		/** Untransformed bubble geometry per list, snapshotted at drag start —
		 *  measuring live rects would chase the sliding bubbles in a loop. */
		snapshot: Map<
			string,
			{ mids: number[]; tops: number[]; left: number; fallbackTop: number; slot: number }
		>;
		/** Dragged bubble's own size + start position (viewport coords) so a
		 *  portalled copy can ride the cursor above every clip/stack context. */
		ghostWidth: number;
		startLeft: number;
		startTop: number;
		body: HTMLElement;
	} | null>(null);
	const dragRafRef = useRef(0);
	const suppressClickRef = useRef(false);

	const rankOf = (r: EntityRecord) =>
		plugin.settings.timelineManualOrder[project.root]?.[r.path] ?? Number.MAX_SAFE_INTEGER;
	const applyOrder = (list: EntityRecord[]) => list.slice().sort((a, b) => rankOf(a) - rankOf(b));

	const { columns, undated } = useMemo(() => {
		const all = buildColumns(indexer, def, project.root);
		// Dateless session-less events dock in the panel instead of anchoring
		// their own columns (dated ones keep their chronological spot).
		const cols = all.filter((c) => !(c.anchor.type === 'event' && c.anchor.date === null));
		for (const c of cols) c.events = applyOrder(c.events);
		return {
			columns: cols,
			undated: applyOrder(
				all.filter((c) => c.anchor.type === 'event' && c.anchor.date === null).map((c) => c.anchor)
			),
		};
		// orderBump re-sorts after manual reorders (rank lookups read settings).
	}, [indexer, version, def, project, orderBump]);

	const listByKey = (key: string): EntityRecord[] =>
		key === 'nodate' ? undated : columns.find((c) => c.anchor.path === key)?.events ?? [];

	/** Distinct sessions an event is connected to (its current columns). */
	const sessionsOf = (event: EntityRecord): EntityRecord[] => {
		const seen = new Set<string>();
		return indexer
			.getConnections(event.path)
			.filter((c) => c.record.type === 'session')
			.filter((c) => (seen.has(c.record.path) ? false : (seen.add(c.record.path), true)))
			.map((c) => c.record);
	};

	const editList = (path: string, key: string, apply: (arr: unknown[]) => unknown[] | void) => {
		const f = plugin.app.vault.getFileByPath(path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, key);
				const arr = Array.isArray(cur) ? cur : [];
				setLoomKey(fm, key, apply(arr) ?? arr);
			})
			.catch((e) => {
				console.error(`Loom Loom: failed to update ${key}`, e);
				new Notice('Could not save the change.');
			});
	};

	const setKey = (path: string, key: string, value: unknown) => {
		const f = plugin.app.vault.getFileByPath(path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				setLoomKey(fm, key, value);
			})
			.catch((e) => {
				console.error(`Loom Loom: failed to update ${key}`, e);
				new Notice('Could not save the change.');
			});
	};

	/**
	 * Rewrites every frontmatter binding between the event and its current
	 * sessions to point at `to` (null = the panel: unpin AND clear the date):
	 * session-note pins retarget in place (their text survives), event-side
	 * relationships retarget or drop, session-side relationships move to the
	 * new session's note. A plain [[link]] in body text can't be moved — it
	 * gets a Notice instead.
	 */
	const performMove = (event: EntityRecord, from: EntityRecord[], to: EntityRecord | null) => {
		const fromPaths = new Set(from.map((s) => s.path));
		const pointsAtFrom = (linkpath: string | null): boolean => {
			if (linkpath === null) return false;
			const hit = indexer.resolve(linkpath, event.path);
			return hit !== null && hit !== undefined && fromPaths.has(hit.path);
		};
		const toLink = to ? `[[${linkTargetOf(to)}]]` : '';

		const noteHits = event.sessionNotes.filter((n) => pointsAtFrom(n.session)).length;
		const relHits = event.relationships.filter((r) => pointsAtFrom(r.linkpath)).length;
		const sessionSide = from
			.map((session) => ({
				session,
				rels: session.relationships.filter(
					(r) => indexer.resolve(r.linkpath, session.path)?.path === event.path
				),
			}))
			.filter((e) => e.rels.length > 0);

		if (noteHits > 0) {
			editList(event.path, FM.sessionNotes, (arr) => {
				for (const item of arr) {
					if (typeof item !== 'object' || item === null) continue;
					const note = item as { session?: unknown };
					if (typeof note.session === 'string' && pointsAtFrom(extractLinkpath(note.session))) {
						note.session = toLink;
					}
				}
			});
		}
		if (relHits > 0) {
			editList(event.path, FM.relationships, (arr) =>
				arr.flatMap((item) => {
					if (typeof item !== 'object' || item === null) return [item];
					const rel = item as { target?: unknown };
					if (typeof rel.target === 'string' && pointsAtFrom(extractLinkpath(rel.target))) {
						if (to === null) return []; // unpinned: the typed edge goes
						return [{ ...item, target: toLink }];
					}
					return [item];
				})
			);
		}
		for (const { session, rels } of sessionSide) {
			editList(session.path, FM.relationships, (arr) =>
				arr.filter((item) => {
					if (typeof item !== 'object' || item === null) return true;
					const target = (item as { target?: unknown }).target;
					if (typeof target !== 'string') return true;
					const lp = extractLinkpath(target);
					return lp === null || indexer.resolve(lp, session.path)?.path !== event.path;
				})
			);
			if (to !== null) {
				editList(to.path, FM.relationships, (arr) => [
					...arr,
					...rels.map((r) => ({ type: r.type, target: `[[${linkTargetOf(event)}]]` })),
				]);
			}
		}
		// Nothing bound it on the event side and no session-side edge moved
		// (e.g. dragged out of the panel): pin it with a fresh session note.
		if (to !== null && noteHits === 0 && relHits === 0 && sessionSide.length === 0) {
			editList(event.path, FM.sessionNotes, (arr) => {
				arr.push({ session: toLink, text: '', seq: Date.now() });
			});
		}
		// The panel means "no session, no date" — clear the date field too.
		if (to === null && event.date !== null) {
			setKey(event.path, FM.date, '');
		}
		// Body [[links]] to an old session still count as connections and keep
		// the event in that column — they can only be edited in the note text.
		const bodyBound = from.length > 0 && noteHits === 0 && relHits === 0 && sessionSide.length === 0;
		if (bodyBound) {
			new Notice(
				`"${event.name}" is linked to its session inside note text — edit the note to detach it.`
			);
		}
	};

	const handleDropPath = (path: string, to: EntityRecord | null) => {
		const event = indexer.get(path);
		if (!event || event.type !== 'event') return;
		const from = sessionsOf(event);
		if (to !== null && from.some((s) => s.path === to.path)) return;
		if (to === null && from.length === 0 && event.date === null) return;
		const apply = () => performMove(event, from, to);
		if (to !== null && from.length > 0 && plugin.settings.confirmTimelineMove) {
			new ConfirmModal(
				plugin.app,
				'Move event?',
				`Moves "${event.name}" from ${from
					.map((s) => recordLabel(s, project))
					.join(', ')} to ${recordLabel(to, project)}.`,
				apply,
				'Move'
			).open();
		} else {
			apply();
		}
	};

	/** Persists a list's order with the dragged bubble at `insertIndex`
	 *  (index within the list excluding the dragged bubble itself). */
	const reorderTo = (key: string, draggedPath: string, insertIndex: number) => {
		const list = listByKey(key);
		const dragged = list.find((r) => r.path === draggedPath);
		if (!dragged) return;
		const next = list.filter((r) => r.path !== draggedPath);
		next.splice(Math.max(0, Math.min(next.length, insertIndex)), 0, dragged);
		const ranks = (plugin.settings.timelineManualOrder[project.root] ??= {});
		next.forEach((r, i) => {
			ranks[r.path] = i;
		});
		void plugin.saveSettings();
		setOrderBump((b) => b + 1);
	};

	// --- Pointer drag ---------------------------------------------------------

	/** Measures the slide distance of a list from its first two bubbles. */
	const slotOf = (listEl: Element | null): number => {
		if (!listEl) return DEFAULT_SLOT;
		const items = listEl.querySelectorAll('.loom-bubble');
		if (items.length < 2) return DEFAULT_SLOT;
		const a = items[0].getBoundingClientRect();
		const b = items[1].getBoundingClientRect();
		return Math.abs(b.top - a.top) || DEFAULT_SLOT;
	};

	const onBubbleDown = (
		e: ReactPointerEvent<HTMLButtonElement>,
		record: EntityRecord,
		originKey: string | null,
		originIndex: number
	) => {
		if (e.button !== 0) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		const rect = e.currentTarget.getBoundingClientRect();
		pressRef.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			active: false,
			path: record.path,
			originKey,
			originIndex,
			snapshot: new Map(),
			ghostWidth: rect.width,
			startLeft: rect.left,
			startTop: rect.top,
			body: e.currentTarget.doc.body,
		};
	};

	const onBubbleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
		const press = pressRef.current;
		if (!press || press.pointerId !== e.pointerId) return;
		const dx = e.clientX - press.startX;
		const dy = e.clientY - press.startY;
		const doc = e.currentTarget.doc;
		if (!press.active) {
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			press.active = true;
			suppressClickRef.current = true;
			setTooltip(null);
			// Snapshot every list's bubble geometry before anything slides.
			for (const zone of doc.querySelectorAll('[data-dropzone]')) {
				if (!zone.instanceOf(HTMLElement)) continue;
				const key = zone.dataset.dropzone;
				if (key === undefined) continue;
				const listEl = zone.querySelector('[data-bubble-list]');
				const rects = listEl
					? [...listEl.querySelectorAll('.loom-bubble')]
							.filter((el) => el.getAttribute('data-bubble-path') !== press.path)
							.map((el) => el.getBoundingClientRect())
					: [];
				const zoneRect = (listEl ?? zone).getBoundingClientRect();
				press.snapshot.set(key, {
					mids: rects.map((r) => r.top + r.height / 2),
					tops: rects.map((r) => r.top),
					left: rects.length > 0 ? rects[0].left : zoneRect.left + 26,
					fallbackTop: zoneRect.top + (listEl ? 0 : 48),
					slot: slotOf(listEl),
				});
			}
		}
		// The dragged bubble is pointer-events:none, so the hit test lands on
		// the column/panel under the cursor — never on the bubble's old home.
		const under = doc.elementFromPoint(e.clientX, e.clientY);
		const zoneEl = under?.closest('[data-dropzone]') ?? null;
		const overKey = zoneEl?.instanceOf(HTMLElement) ? zoneEl.dataset.dropzone ?? null : null;
		const overSnap = overKey !== null ? press.snapshot.get(overKey) : undefined;
		const insertIndex = overSnap ? overSnap.mids.filter((m) => m < e.clientY).length : 0;
		const ghost = overSnap
			? {
					x: overSnap.left,
					y:
						insertIndex < overSnap.tops.length
							? overSnap.tops[insertIndex]
							: overSnap.tops.length > 0
								? overSnap.tops[overSnap.tops.length - 1] + overSnap.slot
								: overSnap.fallbackTop,
					width: press.ghostWidth,
				}
			: null;
		const next: LiveDrag = {
			path: press.path,
			originKey: press.originKey,
			originIndex: press.originIndex,
			// Free on both axes — the bubble can leave its column any direction.
			dx,
			dy,
			overKey: overKey ?? null,
			insertIndex,
			slot: overSnap?.slot ?? DEFAULT_SLOT,
			originSlot: press.originKey !== null ? press.snapshot.get(press.originKey)?.slot ?? DEFAULT_SLOT : DEFAULT_SLOT,
			ghost,
		};
		dragRef.current = next;
		window.cancelAnimationFrame(dragRafRef.current);
		dragRafRef.current = window.requestAnimationFrame(() => setDrag(dragRef.current));
	};

	const onBubbleUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
		const press = pressRef.current;
		if (!press || press.pointerId !== e.pointerId) return;
		const live = dragRef.current;
		pressRef.current = null;
		dragRef.current = null;
		window.cancelAnimationFrame(dragRafRef.current);
		setDrag(null);
		if (!press.active || !live) return;
		if (live.overKey === null) return; // dropped nowhere: cancel
		if (live.overKey === press.originKey) {
			reorderTo(live.overKey, press.path, live.insertIndex);
			return;
		}
		if (live.overKey === 'nodate') handleDropPath(press.path, null);
		else handleDropPath(press.path, indexer.get(live.overKey) ?? null);
	};

	const clickSuppressed = () => {
		const was = suppressClickRef.current;
		suppressClickRef.current = false;
		return was;
	};

	/**
	 * Live slide of a non-dragged bubble in list `key`, DOM position `index`.
	 * One rule for every case: take the bubble's index in the dragged-excluded
	 * list (`j`, which for the origin list already closes the vacated gap),
	 * then push it one slot down if it sits at/after the insertion point of the
	 * hovered list. Its slide is where it ends up minus where it is now.
	 */
	const shiftFor = (key: string, index: number, path: string): number => {
		if (!drag || drag.path === path) return 0;
		const isOrigin = drag.originKey === key;
		const isOver = drag.overKey === key;
		if (!isOrigin && !isOver) return 0;
		const j = isOrigin && index > drag.originIndex ? index - 1 : index;
		const finalPos = isOver && j >= drag.insertIndex ? j + 1 : j;
		return (finalPos - index) * (isOver ? drag.slot : drag.originSlot);
	};

	const bubbleDragProps = (record: EntityRecord, originKey: string | null, originIndex: number) => {
		const isDragged = drag?.path === record.path;
		const shift = originKey !== null ? shiftFor(originKey, originIndex, record.path) : 0;
		// The dragged bubble keeps its layout slot but goes invisible; a portalled
		// copy (below) rides the cursor above every clip/stack context (so it can
		// float over the "No date" panel instead of vanishing behind it).
		const style: CSSProperties | undefined = isDragged
			? { visibility: 'hidden' }
			: shift !== 0
				? { transform: `translateY(${shift}px)` }
				: undefined;
		return {
			suppressTooltip: drag !== null,
			className: isDragged ? 'loom-bubble-dragging' : drag !== null ? 'loom-bubble-slide' : undefined,
			style,
			onDragDown: (e: ReactPointerEvent<HTMLButtonElement>) =>
				onBubbleDown(e, record, originKey, originIndex),
			onDragMove: onBubbleMove,
			onDragUp: onBubbleUp,
			clickSuppressed,
		};
	};

	// --- Panel resize (drag the bar's edge strip, like the drawer handle) ---
	const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		resizeRef.current = { id: e.pointerId, x: e.clientX, w: panelWidth };
		setPanelResizing(true);
	};
	const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const r = resizeRef.current;
		if (!r || r.id !== e.pointerId) return;
		setPanelWidth(Math.max(NODATE_MIN, Math.min(NODATE_MAX, r.w + (e.clientX - r.x))));
	};
	const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (resizeRef.current?.id === e.pointerId) {
			resizeRef.current = null;
			setPanelResizing(false);
		}
	};

	// --- Left-button pan over empty strip space -----------------------------
	const onStripPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target.closest('.loom-bubble')) return; // clicks/drags on bubbles
		e.currentTarget.setPointerCapture(e.pointerId);
		panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
	};
	const onStripPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		const scroller = scrollRef.current;
		if (!pan || pan.id !== e.pointerId || !scroller) return;
		scroller.scrollLeft -= e.clientX - pan.x;
		scroller.scrollTop -= e.clientY - pan.y;
		if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 2) pan.moved = true;
		pan.x = e.clientX;
		pan.y = e.clientY;
	};
	const onStripPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (panRef.current?.id === e.pointerId) panRef.current = null;
	};

	// Plain wheel scrolls vertically (native); Ctrl+wheel pans horizontally.
	// A native non-passive listener — React registers wheel passively, so a
	// JSX handler couldn't preventDefault the browser zoom.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey) return;
			e.preventDefault();
			el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, []);

	/** Right-click: create menu — an event pinned to the clicked session, or a
	 *  free one (the modal offers the session search) on empty space. */
	const onStripContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		const colEl = (e.target as HTMLElement).closest('[data-dropzone]');
		const key = colEl instanceof HTMLElement ? colEl.dataset.dropzone : undefined;
		const session = key && key !== 'nodate' ? indexer.get(key) : undefined;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(session ? `New event in ${recordLabel(session, project)}` : 'New event…')
				.setIcon('calendar-plus')
				.onClick(() =>
					new CreateEntityModal(plugin, 'event', project, {
						...(session ? { noteSession: session } : { sessionPicker: true }),
						onCreated: () => {},
					}).open()
				)
		);
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const bubbleProps = { navigator, setTooltip };

	return (
		<div className={drag !== null ? 'loom-timeline-split loom-timeline-dragging' : 'loom-timeline-split'}>
			{/* Slides out of the strip's left edge; the bar mirrors the timeline
			    drawer's toggle bar, rotated vertical. Always mounted. */}
			<div
				className={panelResizing ? 'loom-nodate-panel' : 'loom-nodate-panel loom-nodate-anim'}
				style={{ width: open ? panelWidth : 0 }}
				data-dropzone="nodate"
			>
				<div className="loom-nodate-inner" style={{ width: panelWidth }}>
					<div className="loom-nodate-label">No date</div>
					<div className="loom-nodate-list" data-bubble-list>
						{undated.map((ev, i) => (
							<Bubble
								key={ev.path}
								record={ev}
								kind="event"
								label={ev.name}
								{...bubbleProps}
								{...bubbleDragProps(ev, 'nodate', i)}
							/>
						))}
					</div>
					{undated.length === 0 ? (
						<div className="loom-nodate-empty">No event with unspecified date or session</div>
					) : null}
				</div>
			</div>
			<div className="loom-nodate-bar" onClick={() => setOpen(!open)}>
				{open ? (
					<div
						className="loom-nodate-handle"
						onPointerDown={onResizeDown}
						onPointerMove={onResizeMove}
						onPointerUp={onResizeUp}
						onPointerCancel={onResizeUp}
						onClick={(e) => e.stopPropagation()}
					/>
				) : null}
				<div className="loom-nodate-chevron">
					<Icon name={open ? 'chevron-left' : 'chevron-right'} />
				</div>
			</div>
			<div
				className="loom-timeline-scroll"
				ref={scrollRef}
				onPointerDown={onStripPointerDown}
				onPointerMove={onStripPointerMove}
				onPointerUp={onStripPointerUp}
				onPointerCancel={onStripPointerUp}
				onContextMenu={onStripContextMenu}
			>
				<div className="loom-timeline">
					<div className="loom-timeline-columns">
						{columns.map((col) => {
							const isSession = col.anchor.type === 'session';
							return (
								<div
									key={col.anchor.path}
									className="loom-col"
									data-dropzone={isSession ? col.anchor.path : undefined}
								>
									{/* Fixed-height header band: session bubbles and the date
									    labels of sessionless events share one line, so the
									    events below all start on the same line too. */}
									<div
										className={isSession ? 'loom-col-header' : 'loom-col-header loom-col-header-date'}
									>
										{isSession ? (
											<Bubble
												record={col.anchor}
												kind="session"
												label={recordLabel(col.anchor, project) || 'No date'}
												suppressTooltip={drag !== null}
												{...bubbleProps}
											/>
										) : (
											<div className="loom-col-date">
												{recordDate(col.anchor, project) || 'No date'}
											</div>
										)}
									</div>
									{isSession ? (
										col.events.length > 0 ? (
											<div className="loom-col-events" data-bubble-list>
												{col.events.map((ev, i) => (
													<Bubble
														key={ev.path}
														record={ev}
														kind="event"
														label={ev.name}
														{...bubbleProps}
														{...bubbleDragProps(ev, col.anchor.path, i)}
													/>
												))}
											</div>
										) : null
									) : (
										<div className="loom-col-events loom-col-events-root">
											<Bubble
												record={col.anchor}
												kind="event"
												label={col.anchor.name}
												{...bubbleProps}
												{...bubbleDragProps(col.anchor, null, 0)}
											/>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			</div>
			{drag !== null && pressRef.current !== null
				? // The carried bubble: a solid copy stuck to the cursor, portalled to
					// the body so it floats above the scroll clip and the "No date"
					// panel (the in-flow original stays hidden in its slot).
					createPortal(
						<div
							className="loom-bubble loom-bubble-event loom-bubble-carried"
							style={{
								left: pressRef.current.startLeft + drag.dx,
								top: pressRef.current.startTop + drag.dy,
								width: pressRef.current.ghostWidth,
							}}
						>
							<span className="loom-bubble-name">{indexer.get(drag.path)?.name ?? ''}</span>
						</div>,
						pressRef.current.body
					)
				: null}
			{drag !== null && drag.ghost !== null && pressRef.current !== null
				? // Landing preview: a translucent copy of the dragged bubble at the
					// exact slot it would occupy on drop (replaces the old drop-zone
					// dashed outline). Portalled to the body so it's never clipped by
					// the scroll container.
					createPortal(
						<div
							className="loom-bubble loom-bubble-event loom-bubble-ghost"
							style={{ left: drag.ghost.x, top: drag.ghost.y, width: drag.ghost.width }}
						>
							<span className="loom-bubble-name">{indexer.get(drag.path)?.name ?? ''}</span>
						</div>,
						pressRef.current.body
					)
				: null}
			{tooltip && (tooltip.truncated || tooltip.record.description !== '')
				? // Portalled to the body: inside the workspace leaf, `contain`
					// re-bases position:fixed and the tooltip lands away from the chip.
					createPortal(
						<div
							className={tooltip.above ? 'loom-tooltip loom-tooltip-above' : 'loom-tooltip'}
							style={{ left: tooltip.x, top: tooltip.y }}
						>
							<div className="loom-tooltip-name">{tooltip.label}</div>
							{tooltip.record.description !== '' ? (
								<div>{truncateWords(tooltip.record.description, TOOLTIP_MAX_WORDS)}</div>
							) : null}
						</div>,
						tooltip.body
					)
				: null}
		</div>
	);
}
