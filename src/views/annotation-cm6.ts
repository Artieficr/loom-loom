/**
 * The comment/alt-text CM6 layer shared by `fountain-field.tsx` and
 * `markdown-field.tsx` — the two live-preview editor fields behind Script and
 * Prose. Everything here is format-agnostic; where the two fields differ only
 * by CSS class family, a `prefix` parameter picks it. Each field's own
 * decoration/gutter code for its grammar stays in that field.
 */

import { StateEffect, Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, ViewUpdate, gutter } from '@codemirror/view';
import { Notice, setIcon } from 'obsidian';
import { findAnnotationSpans, newSceneId } from '../fountain';
import { t } from '../i18n';
import { CommentEntry } from './script-notes';

/** True when `[from, to)` partially overlaps `[sFrom, sTo)` — neither
 *  disjoint, nested inside it, nor fully surrounding it. The shared "does
 *  this new/relocated span cross an existing one" guard behind both fields'
 *  comment/alt-text creation menu and comment drag-handle relocation. */
export function partiallyOverlaps(from: number, to: number, sFrom: number, sTo: number): boolean {
	const disjoint = to <= sFrom || from >= sTo;
	const nestedIn = from >= sFrom && to <= sTo;
	const surrounds = from <= sFrom && to >= sTo;
	return !(disjoint || nestedIn || surrounds);
}

/** A comment span is "unresolved" (needs attention, gets the persistent
 *  tint/gutter glyph) when its thread has anything not yet checked off, or
 *  no replies at all — alt-text spans have no resolved concept and are
 *  never unresolved. Shared by each field's own content-mark decoration and
 *  its gutter icon. */
export function isUnresolvedComment(kind: 'comment' | 'alt', entries: CommentEntry[]): boolean {
	return kind === 'comment' && !(entries.length > 0 && entries.every((e) => e.resolved));
}

/** Dispatched (as a no-op transaction's sole effect) whenever a field's own
 *  `comments`/`altText`/`highlightedAnnotationId` props change without a
 *  document edit (e.g. a comment's resolved state toggling in the popover) —
 *  both fields' annotation gutters watch for this via their own
 *  `lineMarkerChange`, since a CM6 gutter otherwise only recomputes on a
 *  real doc/viewport change. A single shared `StateEffect` matters here
 *  specifically because `StateEffect` instances are type-identity-based —
 *  two separately-defined effects of the same name would silently be two
 *  different types, a foot-gun this avoids outright rather than just
 *  documenting it. */
export const refreshAnnotations = StateEffect.define<null>();

/** One gutter row's worth of comment/alt-text icons — a line can carry both
 *  (a comment AND an alt-text span both starting there). */
interface AnnotationGutterItem {
	kind: 'comment' | 'alt';
	id: string;
	unresolved: boolean;
	/** A search match currently points at this id — highlight without
	 *  touching the document (an alt-text option match, or a comment while
	 *  its popover is auto-opening). */
	highlighted: boolean;
}

/** `MarkdownField`'s and `FountainField`'s shared annotation-gutter marker —
 *  same icon choices, same doc-identity comparison, differing only in the
 *  CSS class prefix each field's own gutter uses (`loom-fountain`/`loom-md`),
 *  passed in rather than hardcoded so this one class serves both. */
class AnnotationGutterMarker extends GutterMarker {
	constructor(
		private classPrefix: string,
		private items: AnnotationGutterItem[]
	) {
		super();
	}
	eq(other: GutterMarker): boolean {
		if (!(other instanceof AnnotationGutterMarker)) return false;
		if (other.classPrefix !== this.classPrefix) return false;
		if (other.items.length !== this.items.length) return false;
		return this.items.every((it, i) => {
			const o = other.items[i];
			return o.kind === it.kind && o.id === it.id && o.unresolved === it.unresolved && o.highlighted === it.highlighted;
		});
	}
	toDOM(view: EditorView): Node {
		// `view.dom.doc.body` (not the bare global `document`) — pop-out-window
		// safe; detached before returning since it's never meant to live under
		// `<body>` itself.
		const wrap = view.dom.doc.body.createSpan({ cls: `${this.classPrefix}-gutter-icons` });
		wrap.detach();
		for (const it of this.items) {
			const btn = wrap.createSpan({
				cls: it.highlighted
					? `${this.classPrefix}-gutter-icon ${this.classPrefix}-gutter-icon-highlight`
					: `${this.classPrefix}-gutter-icon`,
			});
			btn.dataset.loomAnnotationId = it.id;
			btn.dataset.loomAnnotationKind = it.kind;
			setIcon(
				btn,
				it.kind === 'comment' ? (it.unresolved ? 'message-square-dot' : 'message-square') : 'arrow-right-left'
			);
		}
		return wrap;
	}
}

/**
 * CM6's default scroll-into-view walks up EVERY scrollable ancestor of
 * `view.scrollDOM` (like native `Element.scrollIntoView`), dragging
 * Obsidian's outer page scroll along on every search jump or nav click
 * (`scrollIntoContainer` in common.tsx handles plain DOM). This handler
 * scrolls `view.scrollDOM` only and returns `true` so CM6 doesn't fall
 * through to its own ancestor walk.
 */
export const scrollWithinEditor = EditorView.scrollHandler.of((view, range, target) => {
	// CM6 calls every registered `scrollHandler` from INSIDE `docView.scrollIntoView`,
	// which itself runs from `EditorView.measure()` at a point where
	// `updateState` has already been set to `Updating` for that measure pass
	// (reset to `Idle` only in `measure()`'s own `finally`, after every
	// handler has already run) — confirmed by reading CM6's own source, not
	// just observed live. `view.coordsAtPos`/`posAtCoords` unconditionally
	// call `readMeasured()` first, which throws whenever `updateState ==
	// Updating` — so calling either of those from THIS handler throws on
	// essentially every scroll-into-view request, not just an early/
	// first-open one, which is what silently ate every attempt at restoring
	// a remembered scroll position. `view.lineBlockAt(pos)` sidesteps this
	// entirely: it's a pure lookup against CM6's already-current internal
	// height map (`viewState.heightMap`, freshly rebuilt earlier in this
	// same `measure()` pass), calls no DOM-measuring API, and — unlike
	// `coordsAtPos` — never calls `readMeasured()` at all, so it's always
	// safe here. Its `top`/`bottom` are DOCUMENT-relative (top of the whole
	// scrollable content == 0), the same coordinate space `scroller.scrollTop`
	// already lives in, so the rest of this works entirely in that space and
	// never needs `getBoundingClientRect()` on the target at all — only on
	// `scroller`/`view.contentDOM` once, to find the constant offset between
	// the two (plain DOM reads, unrelated to CM6's guard, always safe).
	const scroller = view.scrollDOM;
	const headBlock = view.lineBlockAt(range.head);
	let top = headBlock.top;
	let bottom = headBlock.bottom;
	if (!range.empty) {
		const anchorBlock = view.lineBlockAt(range.anchor);
		top = Math.min(top, anchorBlock.top);
		bottom = Math.max(bottom, anchorBlock.bottom);
	}
	const scrollerRect = scroller.getBoundingClientRect();
	const contentRect = view.contentDOM.getBoundingClientRect();
	// Constant regardless of current scroll position — see comment above.
	const docTopOffset = contentRect.top - scrollerRect.top + scroller.scrollTop;
	const visibleDocTop = scroller.scrollTop - docTopOffset;
	const visibleDocBottom = visibleDocTop + scroller.clientHeight;
	const yMargin = target.yMargin;
	let moveY = 0;
	if (target.y === 'nearest') {
		if (top < visibleDocTop + yMargin) {
			moveY = top - (visibleDocTop + yMargin);
		} else if (bottom > visibleDocBottom - yMargin) {
			moveY = bottom - visibleDocBottom + yMargin;
		}
	} else {
		const rectHeight = bottom - top;
		const boundingHeight = scroller.clientHeight;
		const targetTop =
			target.y === 'center' && rectHeight <= boundingHeight
				? top + rectHeight / 2 - boundingHeight / 2
				: target.y === 'start'
					? top - yMargin
					: bottom - boundingHeight + yMargin;
		moveY = targetTop - visibleDocTop;
	}
	if (moveY) scroller.scrollTop += moveY;
	return true;
});

/** Comment-span drag handles for one CM6 field — `prefix` picks the field's
 *  own CSS class family (`loom-fountain-…` / `loom-md-…`). */
export function makeAnnotationHandlesOverlay(prefix: 'fountain' | 'md') {
	/** Drags a COMMENT span's start or end boundary to wherever the pointer
	 *  ends up — the marker TOKEN itself relocates (delete from its old spot,
	 *  insert at the new one), never the surrounding prose. Alt-text spans get
	 *  no handle: their coverage is fixed to the text that has alternatives.
	 *  Pointer capture is set on the handle itself, so every later pointer
	 *  event arrives here wherever the cursor goes.
	 *
	 *  A thin fixed-position bar (plain DOM) previews the drop point; the
	 *  document changes once, on drop. Dropping back on the starting position,
	 *  or where the span would partially overlap a DIFFERENT one (nesting is
	 *  fine — the creation-time invariant), is a no-op (with a `Notice` for an
	 *  overlap). */
	function startAnnotationHandleDrag(view: EditorView, id: string, edge: 'start' | 'end', handleEl: HTMLElement) {
		const preview = view.dom.doc.body.createDiv({ cls: `loom-${prefix}-annotation-drag-preview` });
		let lastTarget: number | null = null;

		// The span's own position can't change mid-drag — nothing else
		// dispatches a document edit while this gesture is in progress, only
		// `finish` does and only once, on drop — so finding it here ONCE
		// (rather than re-parsing the whole document on every `pointermove`)
		// is exact, not an approximation.
		const span = findAnnotationSpans(view.state.doc.toString()).find((s) => s.kind === 'comment' && s.id === id);
		if (!span) return;

		const clampTarget = (raw: number) =>
			edge === 'start'
				? Math.max(0, Math.min(raw, span.contentTo - 1))
				: Math.max(span.contentFrom + 1, Math.min(raw, view.state.doc.length));

		const onMove = (e: PointerEvent) => {
			const raw = view.posAtCoords({ x: e.clientX, y: e.clientY });
			if (raw == null) return;
			const target = clampTarget(raw);
			lastTarget = target;
			const coords = view.coordsAtPos(target);
			if (!coords) {
				preview.setCssProps({ display: 'none' });
				return;
			}
			preview.setCssProps({ display: 'block' });
			preview.style.left = `${coords.left}px`;
			preview.style.top = `${coords.top}px`;
			preview.style.height = `${coords.bottom - coords.top}px`;
		};

		const finish = (commit: boolean) => {
			handleEl.removeEventListener('pointermove', onMove);
			handleEl.removeEventListener('pointerup', onUp);
			handleEl.removeEventListener('pointercancel', onCancel);
			preview.remove();
			if (!commit || lastTarget == null) return;
			const target = lastTarget;
			const markerFrom = edge === 'start' ? span.from : span.contentTo;
			const markerTo = edge === 'start' ? span.contentFrom : span.to;
			if (target === markerFrom) return; // dropped back where it started
			const text = view.state.doc.toString();
			const markerText = text.slice(markerFrom, markerTo);
			const newContentFrom = edge === 'start' ? target : span.contentFrom;
			const newContentTo = edge === 'end' ? target : span.contentTo;
			const overlaps = findAnnotationSpans(text).some((s) => {
				if (s.kind === 'comment' && s.id === id) return false;
				return partiallyOverlaps(newContentFrom, newContentTo, s.contentFrom, s.contentTo);
			});
			if (overlaps) {
				new Notice(t('view.script.overlapNotice.resize'));
				return;
			}
			view.dispatch({
				changes: [
					{ from: markerFrom, to: markerTo, insert: '' },
					{ from: target, insert: markerText },
				],
			});
		};
		const onUp = () => finish(true);
		const onCancel = () => finish(false);
		handleEl.addEventListener('pointermove', onMove);
		handleEl.addEventListener('pointerup', onUp);
		handleEl.addEventListener('pointercancel', onCancel);
	}

	/**
	 * Comment-span drag handles as a `position: fixed` overlay — plain DOM,
	 * NOT `Decoration.widget`: even a zero-width inline widget takes real
	 * space in CM6's content flow, and one at a span's `contentTo` (often a
	 * wrapped line's end) broke click-to-caret on the paragraph's later wrapped
	 * lines. Positioned from `coordsAtPos`, like the drag-preview bar.
	 */
	class AnnotationHandlesOverlay {
		private els = new Map<string, HTMLElement>();
		private destroyed = false;
		private syncQueued = false;

		constructor(private view: EditorView) {
			this.scheduleSync();
		}

		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.geometryChanged ||
				update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations)))
			) {
				this.scheduleSync();
			}
		}

		/** Every trigger (constructor and `update()` alike) goes through this
		 *  coalesced scheduler — `sync()` reads layout via `coordsAtPos`, which
		 *  CM6 forbids inside an update ("Reading the editor layout isn't
		 *  allowed during an update"), and an early `update()` can land there.
		 *  **`setTimeout`, never `requestAnimationFrame`**: CM6 measures in rAF
		 *  too, so an rAF callback can land in the same forbidden frame. */
		private scheduleSync() {
			if (this.syncQueued) return;
			this.syncQueued = true;
			this.view.dom.win.setTimeout(() => {
				this.syncQueued = false;
				if (!this.destroyed) this.sync();
			}, 0);
		}

		sync() {
			// `syncHandlesOnPageScroll`'s deferred `sync()` can fire after
			// `destroy()` (its document listener outlives the view); without this
			// guard it would recreate handle spans on `document.body` that
			// nothing ever removes.
			if (this.destroyed) return;
			const view = this.view;
			// This view's DOM was permanently removed without `destroy()` ever
			// firing on it — `destroyed` alone can't catch that. Clean up for
			// good rather than positioning handles for a view nobody can ever
			// see again.
			if (!view.dom.isConnected) {
				this.destroy();
				return;
			}
			// A hidden background tab keeps its DOM (`offsetParent === null`),
			// but these fixed handles on `document.body` aren't clipped by it and
			// would float over the active tab. Hide, don't destroy — `sync()`
			// repositions them when the tab is visible again.
			if (view.dom.offsetParent === null) {
				for (const el of this.els.values()) el.setCssProps({ display: 'none' });
				return;
			}
			const text = view.state.doc.toString();
			const spans = findAnnotationSpans(text).filter((s) => s.kind === 'comment' && s.contentFrom < s.contentTo);
			const wanted = new Set<string>();
			for (const span of spans) {
				for (const edge of ['start', 'end'] as const) {
					const key = `${span.id}:${edge}`;
					wanted.add(key);
					let el = this.els.get(key);
					if (!el) {
						el = view.dom.doc.body.createSpan({
							cls: `loom-${prefix}-annotation-handle loom-${prefix}-annotation-handle-${edge}`,
						});
						el.dataset.loomAnnotationHandleId = span.id;
						el.dataset.loomAnnotationHandleEdge = edge;
						const { id } = span;
						const handleEl = el;
						handleEl.addEventListener('pointerdown', (e) => {
							e.preventDefault();
							e.stopPropagation();
							handleEl.setPointerCapture(e.pointerId);
							startAnnotationHandleDrag(view, id, edge, handleEl);
						});
						this.els.set(key, handleEl);
					}
					const pos = edge === 'start' ? span.contentFrom : span.contentTo;
					// Backstop on top of the deferred scheduling: if `coordsAtPos`
					// still throws, this frame's positioning is skipped and the next
					// trigger tries again.
					let coords: { left: number; top: number; bottom: number } | null = null;
					try {
						coords = view.coordsAtPos(pos, edge === 'start' ? 1 : -1);
					} catch (e) {
						console.error('Loom Loom: annotation handle could not read layout this frame', e);
					}
					if (coords) {
						el.setCssProps({ display: 'block' });
						el.style.left = `${coords.left}px`;
						el.style.top = `${coords.top}px`;
						el.style.height = `${coords.bottom - coords.top}px`;
					} else {
						el.setCssProps({ display: 'none' });
					}
				}
			}
			for (const [key, el] of this.els) {
				if (!wanted.has(key)) {
					el.remove();
					this.els.delete(key);
				}
			}
		}

		destroy() {
			this.destroyed = true;
			for (const el of this.els.values()) el.remove();
			this.els.clear();
		}
	}
	return ViewPlugin.fromClass(AnnotationHandlesOverlay);
}

/** The right-side gutter for comment/alt-text icons — `side: 'after'` puts it
 *  past the content. One marker per LINE a span STARTS on (not every line it
 *  covers). Getters are read at event/recompute time, so callers pass their
 *  refs' `.current` through them. */
export function makeAnnotationGutter(
	prefix: 'loom-fountain' | 'loom-md',
	opts: {
		comments: () => Record<string, CommentEntry[]>;
		highlightedId: () => string | null;
		onOpenComment: (id: string, rect: DOMRect) => void;
		onAltClick: (view: EditorView, id: string) => void;
		onOpenAltMenu: (id: string) => void;
	}
) {
	// `lineMarker` runs once per VISIBLE line every recompute, so the span
	// parse is cached on the (immutable, shared-by-reference) doc `Text`.
	let cache: { doc: Text; spans: ReturnType<typeof findAnnotationSpans> } | null = null;
	const spansFor = (view: EditorView) => {
		if (cache?.doc !== view.state.doc) {
			cache = { doc: view.state.doc, spans: findAnnotationSpans(view.state.doc.toString()) };
		}
		return cache.spans;
	};
	return gutter({
		class: `${prefix}-annotation-gutter`,
		side: 'after',
		lineMarker: (gutterView, line) => {
			const spans = spansFor(gutterView);
			const lineNo = gutterView.state.doc.lineAt(line.from).number;
			const onThisLine = spans.filter((s) => gutterView.state.doc.lineAt(s.from).number === lineNo);
			if (onThisLine.length === 0) return null;
			const comments = opts.comments();
			const highlighted = opts.highlightedId();
			const items: AnnotationGutterItem[] = onThisLine.map((s) => ({
				kind: s.kind,
				id: s.id,
				unresolved: isUnresolvedComment(s.kind, s.kind === 'comment' ? (comments[s.id] ?? []) : []),
				highlighted: s.id === highlighted,
			}));
			return new AnnotationGutterMarker(prefix, items);
		},
		lineMarkerChange: (update) =>
			update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations))),
		initialSpacer: () => new AnnotationGutterMarker(prefix, []),
		domEventHandlers: {
			click: (gutterView, _line, event) => {
				// The icon glyph is an inline `<svg>` (`setIcon`), which isn't an
				// `HTMLElement` — `Element` covers a click landing on it.
				const target = event.target instanceof Element ? event.target : null;
				const el = target?.closest('[data-loom-annotation-id]');
				if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
				const id = el.dataset.loomAnnotationId;
				if (el.dataset.loomAnnotationKind === 'comment') opts.onOpenComment(id, el.getBoundingClientRect());
				else opts.onAltClick(gutterView, id);
				return true;
			},
			contextmenu: (_gutterView, _line, event) => {
				const target = event.target instanceof Element ? event.target : null;
				const el = target?.closest('[data-loom-annotation-id][data-loom-annotation-kind="alt"]');
				if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
				event.preventDefault();
				opts.onOpenAltMenu(el.dataset.loomAnnotationId);
				return true;
			},
		},
	});
}

/** Wraps `[from, to)` in a fresh comment/alt-text marker pair, keeping the
 *  wrapped text selected. The caller persists the sidecar entry — this only
 *  touches the document. */
export function insertMarkerPair(
	view: EditorView,
	kind: 'comment' | 'alt',
	from: number,
	to: number
): { id: string; selectedText: string } {
	const id = newSceneId();
	const open = `[[loom-${kind}:${id}]]`;
	const close = `[[/loom-${kind}:${id}]]`;
	const selectedText = view.state.sliceDoc(from, to);
	view.dispatch({
		changes: [
			{ from, insert: open },
			{ from: to, insert: close },
		],
		selection: { anchor: from + open.length, head: to + open.length },
	});
	return { id, selectedText };
}

/** Comment/alt-text markers are hidden UNCONDITIONALLY (nobody ever wants the
 *  literal `[[loom-comment:…]]` text); the wrapped content gets a persistent
 *  dashed-underline mark — plus the `-unresolved` tint while a comment thread
 *  has anything unchecked, and `-highlight` while a search match points here.
 *  `kindAttr` also stamps `data-loom-annotation-kind` on the content mark. */
export function annotationSpanDecorations(
	text: string,
	prefix: 'loom-fountain' | 'loom-md',
	comments: Record<string, CommentEntry[]>,
	highlightedId: string | null,
	kindAttr: boolean
): { from: number; to: number; deco: Decoration }[] {
	const entries: { from: number; to: number; deco: Decoration }[] = [];
	for (const span of findAnnotationSpans(text)) {
		entries.push({ from: span.from, to: span.contentFrom, deco: Decoration.replace({}) });
		entries.push({ from: span.contentTo, to: span.to, deco: Decoration.replace({}) });
		if (span.contentFrom < span.contentTo) {
			const unresolved = isUnresolvedComment(span.kind, span.kind === 'comment' ? (comments[span.id] ?? []) : []);
			const cls =
				`${prefix}-annotation-span ${prefix}-annotation-span-${span.kind}` +
				(unresolved ? ` ${prefix}-annotation-span-unresolved` : '') +
				(span.id === highlightedId ? ` ${prefix}-annotation-span-highlight` : '');
			const attributes: Record<string, string> = { 'data-loom-annotation-content': span.id };
			if (kindAttr) attributes['data-loom-annotation-kind'] = span.kind;
			entries.push({ from: span.contentFrom, to: span.contentTo, deco: Decoration.mark({ class: cls, attributes }) });
		}
	}
	return entries;
}

/** Re-syncs the handle overlay when the OUTER page scrolls the editor around
 *  (its own `update()` only sees CM6-internal scroll). Capture-phase "any
 *  scroll" listener, deferred via `setTimeout` — never a direct `sync()` or
 *  rAF — since a native scroll can fire synchronously inside CM6's own
 *  scroll-into-view. `queued` coalesces one gesture. Returns the unsubscribe. */
export function syncHandlesOnPageScroll(
	view: EditorView,
	overlay: ReturnType<typeof makeAnnotationHandlesOverlay>
): () => void {
	let queued = false;
	const onAnyScroll = () => {
		if (queued) return;
		queued = true;
		view.dom.win.setTimeout(() => {
			queued = false;
			view.plugin(overlay)?.sync();
		}, 0);
	};
	const ownerDoc = view.dom.doc;
	ownerDoc.addEventListener('scroll', onAnyScroll, true);
	return () => ownerDoc.removeEventListener('scroll', onAnyScroll, true);
}
