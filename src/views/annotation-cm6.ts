/**
 * CM6 building blocks shared by `fountain-field.tsx` and `markdown-field.tsx`
 * — the two independent live-preview editor fields behind Script and Prose.
 * Everything here is genuinely format-agnostic (no Fountain/markdown-specific
 * assumption anywhere), which is what distinguishes it from the bulk of each
 * field's own decoration/gutter code that stayed duplicated: those differ in
 * real, load-bearing ways (Fountain's raw-always-visible vs. markdown's
 * raw-at-cursor model, element-class vs. line-token decoration), while this
 * handful of helpers were byte-identical (or identical but for a CSS class
 * prefix) copies with no such reason to diverge. One of them already had —
 * see `scrollWithinEditor`'s own history below — which is the concrete
 * reason this module exists instead of leaving a fourth near-copy to write.
 */

import { StateEffect } from '@codemirror/state';
import { EditorView, GutterMarker } from '@codemirror/view';
import { setIcon } from 'obsidian';
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
export interface AnnotationGutterItem {
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
export class AnnotationGutterMarker extends GutterMarker {
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
 * CM6's own default scroll-into-view behavior walks up EVERY scrollable
 * ancestor of `view.scrollDOM` — the same "cascades past its own container"
 * behavior native `Element.scrollIntoView` has — which drags Obsidian's
 * outer view/page scroll along on every search jump or nav click, not just
 * the editor's own internal scroll (`scrollIntoContainer` in common.tsx
 * fixes the identical class of bug for plain DOM `scrollIntoView` calls
 * elsewhere in this codebase). Registering this `EditorView.scrollHandler`
 * short-circuits that walk: the scroll is performed here, bounded to
 * `view.scrollDOM` only, and returning `true` tells CM6 not to fall through
 * to its own ancestor-walking implementation.
 *
 * Originally `fountain-field.tsx`-only; `markdown-field.tsx` (and so Book's
 * unified editor, which uses it for comment/alt-text search-jumps via
 * `scrollToPos`) went without it for a while — a real, live gap, not a
 * hypothetical one, since nothing about this fix is Fountain-specific. Moved
 * here once found so the two fields can't silently diverge on it again.
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
