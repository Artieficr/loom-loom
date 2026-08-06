import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	GutterMarker,
	ViewPlugin,
	ViewUpdate,
	gutter,
	keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	CompletionContext,
	CompletionResult,
	autocompletion,
	completionKeymap,
	startCompletion,
} from '@codemirror/autocomplete';
import { Menu, Notice, setIcon } from 'obsidian';
import { ForwardedRef, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
	ElementType,
	findAnnotationSpans,
	findEntityLinks,
	findOrphanPairs,
	newSceneId,
	parseFountain,
	readLoomId,
} from '../fountain';
import { AltTextEntry, CommentEntry } from './script-notes';
import { EntityType } from '../types';

/**
 * Live-preview editor for the Fountain script. Deliberately NOT
 * `markdown-field.tsx`'s "raw only at the cursor, rendered everywhere else"
 * model: `.`/`@`/`>` force marks and `**`/`*`/`_` emphasis delimiters stay
 * visible and styled AT THE SAME TIME (see `scanEmphasis`) — the point of a
 * screenwriting editor is seeing which literal characters are producing the
 * formatting without having to park the cursor on them. Element TYPE gets
 * its screenplay styling (scene headings bold+uppercase, character cues
 * indented, dialogue/parenthetical indented, transitions right-aligned, …)
 * computed from `parseFountain` and painted as CM6 line decorations.
 *
 * The one thing genuinely HIDDEN (not just styled) is the `[[loom:<id>]]`
 * scene/chapter identity marker — it's not user content, and showing it
 * would just be noise on every heading.
 */

/** True when `[from, to)` partially overlaps `[sFrom, sTo)` — neither
 *  disjoint, nested inside it, nor fully surrounding it. Nesting/surrounding
 *  is fine (spans stay well-nested either way); only a true partial cross is
 *  a conflict. Shared by the two places that must reject one: creating a new
 *  comment/alt-text span over a selection (`openContextMenu`) and dragging an
 *  existing comment span's edge handle onto a new position
 *  (`startAnnotationHandleDrag`). */
function partiallyOverlaps(from: number, to: number, sFrom: number, sTo: number): boolean {
	const disjoint = to <= sFrom || from >= sTo;
	const nestedIn = from >= sFrom && to <= sTo;
	const surrounds = from <= sFrom && to >= sTo;
	return !(disjoint || nestedIn || surrounds);
}

/** A comment span is "unresolved" (needs attention, gets the persistent tint/
 *  gutter glyph) when its thread has anything not yet checked off, or no
 *  replies at all — alt-text spans have no resolved concept and are never
 *  unresolved. Shared by the content-mark decoration (`buildDecorations`) and
 *  the gutter icon (`annotationGutter`). */
function isUnresolvedComment(kind: 'comment' | 'alt', entries: CommentEntry[]): boolean {
	return kind === 'comment' && !(entries.length > 0 && entries.every((e) => e.resolved));
}

const LOOM_ID_RE = /\s*\[\[loom:[A-Za-z0-9]+\]\]/;
const INTEXT_OPTIONS = ['INT.', 'EXT.', 'INT./EXT.', 'EST.'];
/** Mirrors `SCENE_PREFIXES` in fountain.ts (not exported — this only needs
 *  to recognize a heading-shaped START, not fully replicate scene parsing). */
const SCENE_PREFIX_RE = /^(?:INT\.?\/EXT\.?|INT\/EXT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s+/i;

const ELEMENT_CLASS: Partial<Record<ElementType, string>> = {
	'scene-heading': 'loom-fountain-scene-heading',
	character: 'loom-fountain-character',
	dialogue: 'loom-fountain-dialogue',
	parenthetical: 'loom-fountain-parenthetical',
	transition: 'loom-fountain-transition',
	section: 'loom-fountain-section',
	synopsis: 'loom-fountain-synopsis',
	centered: 'loom-fountain-centered',
	lyrics: 'loom-fountain-lyrics',
	'page-break': 'loom-fountain-page-break',
};

/**
 * Finds `**bold**`/`*italic*`/`***bold+italic***`/`_underline_` spans and
 * returns mark decorations covering the WHOLE span, delimiters included —
 * unlike `renderInline` (fountain.ts), which strips them for the exported
 * page preview, this editor deliberately leaves the raw asterisks/
 * underscores visible (so what applies the formatting is never hidden), it
 * just paints the styling over them too.
 *
 * Escaped delimiters (`\*`, `\_`, `\\`) are masked to same-length
 * placeholders first — same technique as `renderInline` — so a real
 * backslash-escaped character can't be mistaken for a real delimiter while
 * every match index still lines up with the original, unmasked text.
 */
function scanEmphasis(text: string): { from: number; to: number; deco: Decoration }[] {
	const masked = text.replace(/\\[*_\\]/g, () => '');
	const claimed = new Uint8Array(masked.length);
	const claim = (from: number, to: number) => claimed.fill(1, from, to);
	const overlaps = (from: number, to: number) => claimed.subarray(from, to).includes(1);
	const spans: { from: number; to: number; deco: Decoration }[] = [];

	const passes: [RegExp, string][] = [
		[/\*\*\*([^*\n]+?)\*\*\*/g, 'loom-fountain-bold-italic'],
		[/\*\*([^*\n]+?)\*\*/g, 'loom-fountain-bold'],
		[/\*([^*\n]+?)\*/g, 'loom-fountain-italic'],
		[/_([^_\n]+?)_/g, 'loom-fountain-underline'],
	];
	for (const [re, cls] of passes) {
		for (const m of masked.matchAll(re)) {
			const from = m.index;
			const to = from + m[0].length;
			if (overlaps(from, to)) continue;
			claim(from, to);
			spans.push({ from, to, deco: Decoration.mark({ class: cls }) });
		}
	}
	return spans;
}

/**
 * Finds `@[Name|Display]` inline entity links and returns their decorations —
 * deliberately the OPPOSITE of `scanEmphasis` above: raw-at-cursor, like
 * `markdown-field.tsx`'s wikilinks, not always-visible. When the selection
 * doesn't touch a link, the `@[`/`|Name`/`]` punctuation is hidden (kept as
 * `Decoration.replace({})`) and only `@Display` (or `@Name` with no
 * `|Display`) renders, marked as a click target; when the cursor IS on it,
 * every hide decoration is skipped and the raw `@[Name|Display]` shows
 * unstyled, exactly as typed.
 */
function scanEntityLinks(
	text: string,
	selection: EditorSelection,
	hasFocus: boolean,
	entityOptions: { name: string; type: EntityType; path: string }[]
): { from: number; to: number; deco: Decoration }[] {
	const revealRaw = hasFocus;
	const touches = (from: number, to: number) => revealRaw && selection.ranges.some((r) => r.from <= to && r.to >= from);
	const byName = new Map<string, string>();
	for (const e of entityOptions) {
		const key = e.name.trim().toLowerCase();
		if (!byName.has(key)) byName.set(key, e.path);
	}
	const spans: { from: number; to: number; deco: Decoration }[] = [];
	for (const link of findEntityLinks(text)) {
		if (touches(link.from, link.to)) continue;
		const path = byName.get(link.name.toLowerCase());
		const attributes = path ? { 'data-loom-fountain-entity': path } : undefined;
		// The visible "@" (kept, not hidden) and the visible display text are
		// two separate mark ranges around the hidden `[`/`Name|`/`]` pieces.
		spans.push({ from: link.from, to: link.from + 1, deco: Decoration.mark({ class: 'loom-fountain-entity-link', attributes }) });
		spans.push({ from: link.from + 1, to: link.displayFrom, deco: Decoration.replace({}) });
		spans.push({ from: link.displayFrom, to: link.displayTo, deco: Decoration.mark({ class: 'loom-fountain-entity-link', attributes }) });
		spans.push({ from: link.displayTo, to: link.to, deco: Decoration.replace({}) });
	}
	return spans;
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
 */
const scrollWithinEditor = EditorView.scrollHandler.of((view, range, target) => {
	const scroller = view.scrollDOM;
	const headCoords = view.coordsAtPos(range.head, range.assoc || (range.head > range.anchor ? -1 : 1));
	if (!headCoords) return true;
	let rect = headCoords;
	if (!range.empty) {
		const otherCoords = view.coordsAtPos(range.anchor, range.anchor > range.head ? -1 : 1);
		if (otherCoords) {
			rect = {
				left: Math.min(headCoords.left, otherCoords.left),
				top: Math.min(headCoords.top, otherCoords.top),
				right: Math.max(headCoords.right, otherCoords.right),
				bottom: Math.max(headCoords.bottom, otherCoords.bottom),
			};
		}
	}
	const boundingRect = scroller.getBoundingClientRect();
	const boundingTop = boundingRect.top;
	const boundingBottom = boundingRect.top + scroller.clientHeight;
	const yMargin = target.yMargin;
	let moveY = 0;
	if (target.y === 'nearest') {
		if (rect.top < boundingTop + yMargin) {
			moveY = rect.top - (boundingTop + yMargin);
		} else if (rect.bottom > boundingBottom - yMargin) {
			moveY = rect.bottom - boundingBottom + yMargin;
		}
	} else {
		const rectHeight = rect.bottom - rect.top;
		const boundingHeight = boundingBottom - boundingTop;
		const targetTop =
			target.y === 'center' && rectHeight <= boundingHeight
				? rect.top + rectHeight / 2 - boundingHeight / 2
				: target.y === 'start'
					? rect.top - yMargin
					: rect.bottom - boundingHeight + yMargin;
		moveY = targetTop - boundingTop;
	}
	if (moveY) scroller.scrollTop += moveY;
	return true;
});

/** Dispatched (as a no-op transaction's sole effect) whenever the `comments`/
 *  `altText` PROPS change without a document edit — a comment's resolved
 *  state toggling in the popover doesn't touch the document, but the
 *  gutter's icon glyph still needs to redraw. CM6 gutters otherwise only
 *  recompute on a real doc/viewport change, so this is what the gutter's own
 *  `lineMarkerChange` below watches for. */
const refreshAnnotations = StateEffect.define<null>();

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

class AnnotationGutterMarker extends GutterMarker {
	constructor(private items: AnnotationGutterItem[]) {
		super();
	}
	eq(other: GutterMarker): boolean {
		if (!(other instanceof AnnotationGutterMarker)) return false;
		if (other.items.length !== this.items.length) return false;
		return this.items.every((it, i) => {
			const o = other.items[i];
			return o.kind === it.kind && o.id === it.id && o.unresolved === it.unresolved && o.highlighted === it.highlighted;
		});
	}
	toDOM(view: EditorView): Node {
		// `view.dom.doc.body` (not the bare global `document`) — same
		// pop-out-window-safe construction `markdown-field.tsx`'s own widgets
		// use, then detached before returning since it's never meant to live
		// under `<body>` itself.
		const wrap = view.dom.doc.body.createSpan({ cls: 'loom-fountain-gutter-icons' });
		wrap.detach();
		for (const it of this.items) {
			const btn = wrap.createSpan({
				cls: it.highlighted ? 'loom-fountain-gutter-icon loom-fountain-gutter-icon-highlight' : 'loom-fountain-gutter-icon',
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

export interface FountainFieldHandle {
	/** Selects `[from, to)` and scrolls it into view — what the Script
	 *  view's search jumps to a match with, instead of a raw textarea's
	 *  `setSelectionRange`/`scrollTop`. */
	selectRange: (from: number, to: number) => void;
	focus: () => void;
	/** The CURRENT live document text, read straight from the `EditorView`
	 *  rather than through React's own `text`/`value` state — for a caller
	 *  that just dispatched a document change THROUGH this handle (alt-text
	 *  cycling/drafting/accepting/deleting, all triggered from `AltTextModal`,
	 *  which never focuses this editor) and needs to `commit()` the result
	 *  immediately: `onChange` fires synchronously as part of that same
	 *  `dispatch`, but whether the CALLER's own React `text` state has
	 *  actually re-rendered by the time execution returns to it is not
	 *  something to rely on, and the write-on-blur path this editor normally
	 *  uses to persist typing never fires at all here, since nothing ever put
	 *  focus on it in the first place — a change applied this way that never
	 *  gets an explicit `commit()` sits in the live CM6 document only, lost
	 *  the moment the file is reloaded from disk. */
	getValue: () => string;
	/** The 0-based line nearest the top of the visible viewport — what the
	 *  Script/Pages mode switch reads to figure out "where was I" before
	 *  handing off to the other pane. */
	getTopLine: () => number;
	/** Scrolls (without selecting or focusing) so the given 0-based line
	 *  sits near the top — the other half of the Script/Pages scroll sync. */
	scrollToLine: (line: number) => void;
	/** Replaces the text currently between an alt-text span's markers (found
	 *  fresh from the live document by id) with `text` — the one thing a
	 *  caller building its own UI around alt-text (a right-click "jump to
	 *  this option" menu, "Add + activate") needs done, since only this
	 *  component holds the live `EditorView`. A no-op if the id no longer
	 *  resolves to a live span (the marker was deleted from under the caller). */
	replaceAltContent: (id: string, text: string) => void;
	/** Strips just the marker TOKENS of one comment/alt-text span (found fresh
	 *  from the live document by id), leaving the wrapped content untouched —
	 *  the document-side half of deleting a comment thread down to zero
	 *  replies: removing the sidecar entry alone left an ORPHANED marker pair
	 *  with no data behind it, which kept rendering as a live (and, with no
	 *  entries to check "all resolved" against, PERMANENTLY unresolved-tinted)
	 *  span even though the popover now showed nothing. A no-op if the id no
	 *  longer resolves to a live span. */
	removeAnnotationMarkers: (id: string) => void;
}

export const FountainField = forwardRef(function FountainField(
	{
		value,
		onChange,
		onBlur,
		characters,
		locations,
		entityOptions,
		onOpenCharacter,
		onOpenLocation,
		onOpenChapter,
		onOpenEntity,
		comments,
		altText,
		onCreateComment,
		onCreateAlt,
		onOpenComment,
		onCycleAlt,
		onOpenAltMenu,
		highlightedAnnotationId,
	}: {
		value: string;
		onChange: (value: string) => void;
		/** Fires once, on losing focus — mirrors the old textarea's onBlur,
		 *  which is where `ensureSceneIds`/`syncScenes` actually run. */
		onBlur?: () => void;
		/** Existing character names — the character-cue autocomplete only
		 *  offers names that already exist (creating a brand new one is
		 *  still just typing it; the parser doesn't need it pre-declared). */
		characters: string[];
		/** Existing top-level location names, for the scene-heading
		 *  location autocomplete (offered once an INT./EXT. prefix is typed). */
		locations: string[];
		/** Characters/factions/locations/items offered by the `@[` inline
		 *  entity-link autocomplete and resolved for click-to-navigate — unlike
		 *  `characters`/`locations` above, an `@[...]` link never auto-creates,
		 *  so only entities that already exist are ever offered. */
		entityOptions?: { name: string; type: EntityType; path: string }[];
		/** A character cue line was clicked. */
		onOpenCharacter?: (name: string) => void;
		/** A scene heading was clicked — passed the scene's `[[loom:…]]` id
		 *  so the caller can resolve it to the Scene note's own location
		 *  (sublocation-aware), rather than the raw heading text. */
		onOpenLocation?: (sceneLoomId: string) => void;
		/** A `#` chapter heading was clicked — passed the section's own
		 *  `[[loom:…]]` id (only ever present on level-1 sections). */
		onOpenChapter?: (chapterLoomId: string) => void;
		/** An `@[...]` inline entity link was clicked — passed the resolved
		 *  entity's file path. */
		onOpenEntity?: (path: string) => void;
		/** Comment bodies keyed by marker id, from `useScriptNotes` — read
		 *  here only to know whether a comment's icon should show as resolved
		 *  or not; the actual text/editing lives in the caller's popover. */
		comments?: Record<string, CommentEntry[]>;
		/** Alt-text entries keyed by marker id — read here only to render the
		 *  gutter/margin icon and to look up an id's live span when cycling. */
		altText?: Record<string, AltTextEntry>;
		/** A new comment marker pair was just inserted around the (former)
		 *  selection — the caller persists the sidecar entry and, typically,
		 *  opens the popover to let the user type it immediately. */
		onCreateComment?: (id: string, selectedText: string) => void;
		/** A new alt-text marker pair was just inserted — the caller persists
		 *  a fresh `AltTextEntry` with the selected text as option 0. */
		onCreateAlt?: (id: string, selectedText: string) => void;
		/** A comment's gutter/margin icon was clicked — open its popover
		 *  anchored to the given screen rect. */
		onOpenComment?: (id: string, anchorRect: DOMRect) => void;
		/** An alt-text icon was LEFT-clicked (cycle) — the caller computes the
		 *  next option, persists the new `activeIndex`, and calls this
		 *  component's own `replaceAltContent` (via its ref) to apply it. */
		onCycleAlt?: (id: string) => void;
		/** An alt-text icon was RIGHT-clicked — the caller opens its own
		 *  option-picker window (`AltTextModal`, project.ts — a real Modal,
		 *  centered, no anchor point needed). */
		onOpenAltMenu?: (id: string) => void;
		/** A marker id a search match currently points at — its gutter icon
		 *  gets a highlight class without touching the document. */
		highlightedAnnotationId?: string | null;
	},
	ref: ForwardedRef<FountainFieldHandle>
) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	// Live inputs flow through refs: the extensions/closures below are built
	// once at mount (see the empty-deps effect), same reasoning as
	// markdown-field.tsx.
	const onChangeRef = useRef(onChange);
	const onBlurRef = useRef(onBlur);
	const charactersRef = useRef(characters);
	const locationsRef = useRef(locations);
	const entityOptionsRef = useRef(entityOptions ?? []);
	const onOpenCharacterRef = useRef(onOpenCharacter);
	const onOpenLocationRef = useRef(onOpenLocation);
	const onOpenChapterRef = useRef(onOpenChapter);
	const onOpenEntityRef = useRef(onOpenEntity);
	const commentsRef = useRef(comments ?? {});
	const altTextRef = useRef(altText ?? {});
	const onCreateCommentRef = useRef(onCreateComment);
	const onCreateAltRef = useRef(onCreateAlt);
	const onOpenCommentRef = useRef(onOpenComment);
	const onCycleAltRef = useRef(onCycleAlt);
	const onOpenAltMenuRef = useRef(onOpenAltMenu);
	const highlightedAnnotationIdRef = useRef(highlightedAnnotationId ?? null);
	onChangeRef.current = onChange;
	onBlurRef.current = onBlur;
	charactersRef.current = characters;
	locationsRef.current = locations;
	entityOptionsRef.current = entityOptions ?? [];
	onOpenCharacterRef.current = onOpenCharacter;
	onOpenLocationRef.current = onOpenLocation;
	onOpenChapterRef.current = onOpenChapter;
	onOpenEntityRef.current = onOpenEntity;
	commentsRef.current = comments ?? {};
	altTextRef.current = altText ?? {};
	onCreateCommentRef.current = onCreateComment;
	onCreateAltRef.current = onCreateAlt;
	onOpenCommentRef.current = onOpenComment;
	onCycleAltRef.current = onCycleAlt;
	onOpenAltMenuRef.current = onOpenAltMenu;
	highlightedAnnotationIdRef.current = highlightedAnnotationId ?? null;

	useImperativeHandle(ref, () => ({
		selectRange: (from, to) => {
			const view = viewRef.current;
			if (!view) return;
			view.focus();
			// `scrollIntoView: true` uses CM6's "nearest" strategy, which lands a
			// target below the viewport at the BOTTOM edge — every caller here
			// (nav-panel jump, search jump) wants the target visible near the
			// TOP instead, same as `scrollToLine` below.
			view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'start' }) });
		},
		focus: () => viewRef.current?.focus(),
		getValue: () => viewRef.current?.state.doc.toString() ?? '',
		getTopLine: () => {
			const view = viewRef.current;
			if (!view) return 0;
			const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
			return view.state.doc.lineAt(block.from).number - 1;
		},
		scrollToLine: (line) => {
			const view = viewRef.current;
			if (!view) return;
			const clamped = Math.min(Math.max(line + 1, 1), view.state.doc.lines);
			const pos = view.state.doc.line(clamped).from;
			view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
		},
		replaceAltContent: (id, text) => {
			const view = viewRef.current;
			if (!view) return;
			const span = findAnnotationSpans(view.state.doc.toString()).find((s) => s.kind === 'alt' && s.id === id);
			if (!span) return;
			view.dispatch({ changes: { from: span.contentFrom, to: span.contentTo, insert: text } });
		},
		removeAnnotationMarkers: (id) => {
			const view = viewRef.current;
			if (!view) return;
			const span = findAnnotationSpans(view.state.doc.toString()).find((s) => s.id === id);
			if (!span) return;
			view.dispatch({
				changes: [
					{ from: span.contentTo, to: span.to, insert: '' },
					{ from: span.from, to: span.contentFrom, insert: '' },
				],
			});
		},
	}));

	useEffect(() => {
		if (!hostRef.current) return;

		/** Drags a COMMENT span's start or end boundary to wherever the pointer
		 *  ends up — the marker TOKEN itself relocates (a real document edit:
		 *  delete it from its old spot, insert it at the new one), never the
		 *  surrounding prose. Alt-text spans never get a handle at all (see
		 *  `buildDecorations` below) — an alt-text span's coverage is fixed to
		 *  whatever was selected when it was created, since its whole point is
		 *  "this exact stretch of text has alternatives," not a movable range.
		 *  Pointer capture is set on the handle element itself (same idiom as
		 *  `entity-view.tsx`'s own `seqGrip`), so every subsequent pointer
		 *  event keeps arriving here regardless of where the cursor physically
		 *  is.
		 *
		 *  A live preview (a thin fixed-position bar, plain DOM — no React, no
		 *  CM6 dispatch) tracks the pointer during the drag; the actual
		 *  document change only happens once, on drop. Dropping back on the
		 *  boundary's own starting position, or somewhere that would make this
		 *  span partially overlap a DIFFERENT one (nesting fully inside or
		 *  surrounding one is fine — the same invariant `openContextMenu`
		 *  enforces at creation time), is a no-op with a `Notice` in the
		 *  overlap case. */
		function startAnnotationHandleDrag(view: EditorView, id: string, edge: 'start' | 'end', handleEl: HTMLElement) {
			const preview = view.dom.doc.body.createDiv({ cls: 'loom-fountain-annotation-drag-preview' });
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
					new Notice("Can't resize a comment span to partially overlap another one.");
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
		 * NOT `Decoration.widget`. A widget was tried first and reverted: even a
		 * zero-DOCUMENT-width inline widget still occupies real rendered space
		 * inside CM6's own content flow, and having one sitting exactly at a
		 * span's `contentTo` (frequently right at a wrapped line's own end)
		 * corrupted CM6's line-layout measurement badly enough that clicking
		 * anywhere on that paragraph's SECOND wrapped visual line stopped
		 * placing a cursor at all — only the first line was still clickable.
		 * Keeping the handles entirely OUTSIDE CM6's content (positioned by
		 * reading `coordsAtPos`, the same technique the drag-preview bar
		 * already uses) sidesteps that class of bug outright, regardless of
		 * its exact internal mechanism.
		 */
		class AnnotationHandlesOverlay {
			private els = new Map<string, HTMLElement>();

			constructor(private view: EditorView) {
				this.sync();
			}

			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.geometryChanged ||
					update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations)))
				) {
					this.sync();
				}
			}

			sync() {
				const view = this.view;
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
								cls: `loom-fountain-annotation-handle loom-fountain-annotation-handle-${edge}`,
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
						const coords = view.coordsAtPos(pos, edge === 'start' ? 1 : -1);
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
				for (const el of this.els.values()) el.remove();
				this.els.clear();
			}
		}
		const annotationHandlesOverlay = ViewPlugin.fromClass(AnnotationHandlesOverlay);

		/** A scene/section's own raw line, decorated once per physical line a
		 *  merged multi-line element (dialogue can span several) actually
		 *  occupies — `element.line` is only the block's FIRST line. */
		function buildDecorations(view: EditorView): DecorationSet {
			const text = view.state.doc.toString();
			const parsed = parseFountain(text);
			const docLines = view.state.doc.lines;
			const entries: { from: number; to: number; deco: Decoration }[] = [];

			for (const element of parsed.elements) {
				const cls = ELEMENT_CLASS[element.type];
				const span = element.type === 'dialogue' ? element.text.split('\n').length : 1;
				for (let i = 0; i < span; i++) {
					const lineNo = element.line + i + 1; // CM6 lines are 1-based
					if (lineNo > docLines) break;
					const docLine = view.state.doc.line(lineNo);
					if (cls) entries.push({ from: docLine.from, to: docLine.from, deco: Decoration.line({ class: cls }) });
				}

				// The hidden identity marker — never shown, on scene headings
				// (level-1 sections' loom id sits on their own `#` line, which
				// is a section element here too).
				let loomId: string | null = null;
				if (element.type === 'scene-heading' || element.type === 'section') {
					const docLine = view.state.doc.line(element.line + 1);
					loomId = readLoomId(docLine.text);
					const m = LOOM_ID_RE.exec(docLine.text);
					if (m) {
						const from = docLine.from + m.index;
						entries.push({ from, to: from + m[0].length, deco: Decoration.replace({}) });
					}
				}

				// Character cues are clickable — the whole line, not just the
				// name substring (extensions like `(V.O.)` and the `^` dual
				// marker make carving out just the name fragile for no real
				// benefit; the line IS the cue).
				if (element.type === 'character' && onOpenCharacterRef.current) {
					const docLine = view.state.doc.line(element.line + 1);
					if (docLine.text.trim() !== '') {
						entries.push({
							from: docLine.from,
							to: docLine.to,
							deco: Decoration.mark({
								class: 'loom-fountain-char-link',
								attributes: { 'data-loom-fountain-char': element.text },
							}),
						});
					}
				}

				// Scene headings resolve to the SCENE note's own location
				// field (sublocation-aware), not the raw heading text — a
				// heading's location segment doesn't map 1:1 to one entity.
				if (element.type === 'scene-heading' && loomId && onOpenLocationRef.current) {
					const docLine = view.state.doc.line(element.line + 1);
					entries.push({
						from: docLine.from,
						to: docLine.to,
						deco: Decoration.mark({
							class: 'loom-fountain-scene-link',
							attributes: { 'data-loom-fountain-scene': loomId },
						}),
					});
				}

				// Only level-1 sections are Chapters — a nested `##`/`###`
				// carries no chapter identity to open.
				if (element.type === 'section' && (element.level ?? 1) === 1 && loomId && onOpenChapterRef.current) {
					const docLine = view.state.doc.line(element.line + 1);
					entries.push({
						from: docLine.from,
						to: docLine.to,
						deco: Decoration.mark({
							class: 'loom-fountain-chapter-link',
							attributes: { 'data-loom-fountain-chapter': loomId },
						}),
					});
				}
			}

			for (const span of scanEmphasis(text)) entries.push(span);
			for (const span of scanEntityLinks(text, view.state.selection, view.hasFocus, entityOptionsRef.current)) {
				entries.push(span);
			}

			// Comment/alt-text markers — hidden UNCONDITIONALLY, unlike
			// `scanEntityLinks`'s raw-at-cursor toggle: there's no reason to
			// ever want to see the literal `[[loom-comment:…]]` text, so this
			// doesn't need to react to selection. The wrapped (= currently
			// displayed) text is left completely alone here — only the two
			// marker tokens themselves are replaced away. The CONTENT itself
			// gets a dashed-border mark instead — a persistent visual "this is
			// what's commented/alt-texted" boundary, like a selection that
			// never clears, mirroring the same box the Pages preview draws via
			// `wrapAnnotationMarkersForDisplay` (fountain.ts).
			for (const span of findAnnotationSpans(text)) {
				entries.push({ from: span.from, to: span.contentFrom, deco: Decoration.replace({}) });
				entries.push({ from: span.contentTo, to: span.to, deco: Decoration.replace({}) });
				if (span.contentFrom < span.contentTo) {
					const highlighted = span.id === highlightedAnnotationIdRef.current;
					// A comment span with anything still unresolved (no entries yet,
					// or at least one entry not resolved) gets the SAME tinted-
					// background treatment `-highlight` uses, but PERSISTENTLY —
					// it's the "this needs attention" state, distinct from
					// `-highlight`'s transient "a search match currently points
					// here." A fully-resolved thread drops back to a plain dashed
					// underline, no tint. Alt-text spans have no resolved concept —
					// unaffected.
					const commentEntries = span.kind === 'comment' ? (commentsRef.current[span.id] ?? []) : [];
					const unresolved = isUnresolvedComment(span.kind, commentEntries);
					const cls =
						`loom-fountain-annotation-span loom-fountain-annotation-span-${span.kind}` +
						(unresolved ? ' loom-fountain-annotation-span-unresolved' : '') +
						(highlighted ? ' loom-fountain-annotation-span-highlight' : '');
					entries.push({
						from: span.contentFrom,
						to: span.contentTo,
						deco: Decoration.mark({ class: cls, attributes: { 'data-loom-annotation-content': span.id } }),
					});
					// Draggable start/end handles — COMMENTS only (see
					// `startAnnotationHandleDrag`'s own doc comment for why
					// alt-text spans never get one) — are handled by the
					// `annotationHandlesOverlay` ViewPlugin below, NOT a decoration
					// here; see `AnnotationHandlesOverlay`'s own doc comment for why.
				}
			}

			// Orphan prevention (fountain.ts `ORPHAN_WORDS`/`findOrphanPairs`,
			// shared with the Pages-preview renderer): glues a short word to
			// whatever follows it via `white-space: nowrap` on the pair, since
			// this editor can't insert a real non-breaking space into the
			// document the way the throwaway preview HTML can.
			for (const { from, to } of findOrphanPairs(text)) {
				entries.push({ from, to, deco: Decoration.mark({ class: 'loom-fountain-nowrap' }) });
			}

			entries.sort((a, b) => a.from - b.from || a.to - b.to);
			return Decoration.set(
				entries.map((e) => e.deco.range(e.from, e.to)),
				true
			);
		}

		const fountainDecorations = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = buildDecorations(view);
				}
				update(update: ViewUpdate) {
					// The loom id and the bold/italic/element-class passes stay
					// selection-independent (they never read `view.state.selection`),
					// but `scanEntityLinks` is deliberately raw-at-cursor, so a
					// selection/focus change can change what it hides — same
					// rebuild triggers as markdown-field.tsx. The annotation-span
					// mark also reads `highlightedAnnotationIdRef`, which a search
					// match can change with no document edit at all — same
					// `refreshAnnotations` effect the gutter's own `lineMarkerChange`
					// already watches for.
					if (
						update.docChanged ||
						update.selectionSet ||
						update.focusChanged ||
						update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations)))
					) {
						this.decorations = buildDecorations(update.view);
					}
				}
			},
			{ decorations: (v) => v.decorations }
		);

		/** `INT.`/`EXT.`/`INT./EXT.`/`EST.` at the start of a blank-preceded
		 *  line — offers the full list the moment the cursor LANDS there (an
		 *  empty `before`), same as Better Fountain, not only once the user
		 *  has started typing; the explicit `startCompletion` call in the
		 *  update listener below is what actually pops the tooltip open for
		 *  that empty case, since CM6 only activates completion on typing
		 *  by default. */
		const intExtCompletion = (ctx: CompletionContext): CompletionResult | null => {
			const line = ctx.state.doc.lineAt(ctx.pos);
			const before = ctx.state.sliceDoc(line.from, ctx.pos);
			if (!/^[A-Za-z./]*$/.test(before)) return null;
			const prevBlank = line.number <= 1 || ctx.state.doc.line(line.number - 1).text.trim() === '';
			if (!prevBlank) return null;
			const query = before.toUpperCase();
			const options = INTEXT_OPTIONS.filter((o) => o.startsWith(query)).map((label) => ({
				label,
				apply: (v: EditorView, _c: unknown, from: number, to: number) => {
					v.dispatch({
						changes: { from: line.from, to, insert: `${label} ` },
						selection: { anchor: line.from + label.length + 1 },
					});
				},
			}));
			if (options.length === 0) return null;
			return { from: line.from, options, filter: false };
		};

		/** An existing character's name, offered while starting a line right
		 *  after a blank one (a real character-cue position) — the full known
		 *  list shows immediately on landing there (empty `trimmed`), same as
		 *  the INT./EXT. list above. Still gated on the line actually being a
		 *  cue position rather than "looks all-caps", so it doesn't pop up
		 *  over every new paragraph of ordinary action text (which also
		 *  always starts after a blank line). */
		const characterCompletion = (ctx: CompletionContext): CompletionResult | null => {
			const line = ctx.state.doc.lineAt(ctx.pos);
			const before = ctx.state.sliceDoc(line.from, ctx.pos);
			const trimmed = before.trim();
			if (trimmed.length > 24 || /^[.@>#=~!]/.test(before)) return null;
			const prevBlank = line.number <= 1 || ctx.state.doc.line(line.number - 1).text.trim() === '';
			if (!prevBlank) return null;
			const query = trimmed.toLowerCase();
			const options = charactersRef.current
				.filter((n) => n.toLowerCase().startsWith(query))
				.slice(0, 8)
				.map((name) => ({
					label: name.toUpperCase(),
					apply: (v: EditorView, _c: unknown, from: number, to: number) => {
						const label = name.toUpperCase();
						// Without an explicit `selection`, CM6 maps the OLD cursor
						// (sitting exactly at the insertion point) through the
						// change using its default assoc, which sticks it BEFORE
						// the inserted text rather than after — landing back at
						// the start of the line instead of where typing dialogue
						// should begin. A cue is followed immediately by its
						// dialogue, so the cursor goes to the START OF THE NEXT
						// LINE, not just past the name — adding one if this cue
						// is the last line in the document.
						const hasNextLine = line.number < v.state.doc.lines;
						const insert = hasNextLine ? label : `${label}\n`;
						v.dispatch({
							changes: { from: line.from, to, insert },
							selection: { anchor: line.from + insert.length + (hasNextLine ? 1 : 0) },
						});
					},
				}));
			if (options.length === 0) return null;
			return { from: line.from, options, filter: false };
		};

		/** An existing top-level location, offered once a recognized
		 *  INT./EXT. prefix has been typed — stops offering once past a time
		 *  separator or the hidden id, i.e. only while still IN the location
		 *  segment of the heading. */
		const locationCompletion = (ctx: CompletionContext): CompletionResult | null => {
			const line = ctx.state.doc.lineAt(ctx.pos);
			const before = ctx.state.sliceDoc(line.from, ctx.pos);
			const m = SCENE_PREFIX_RE.exec(before);
			if (!m) return null;
			const rest = before.slice(m[0].length);
			if (rest.includes(' - ') || rest.includes('[[')) return null;
			const query = rest.toLowerCase();
			const from = line.from + m[0].length;
			const options = locationsRef.current
				.filter((n) => n.toLowerCase().startsWith(query))
				.slice(0, 8)
				.map((name) => ({
					label: name.toUpperCase(),
					apply: (v: EditorView, _c: unknown, applyFrom: number, applyTo: number) => {
						const label = name.toUpperCase();
						// Same default-assoc quirk as the character cue above: an
						// explicit `selection` is needed or the cursor sticks
						// before the inserted name instead of landing after it,
						// ready to keep typing the rest of the heading (a
						// sublocation, or " - NIGHT").
						v.dispatch({
							changes: { from: applyFrom, to: applyTo, insert: label },
							selection: { anchor: applyFrom + label.length },
						});
					},
				}));
			if (options.length === 0) return null;
			return { from, options, filter: false };
		};

		/** An existing character/faction/location/item, offered while typing
		 *  inside an `@[` just opened by `entityBracketPairing` below. Never
		 *  offers to create — an unresolved name is just left as inert text,
		 *  same as an unrecognized wikilink target elsewhere in the app. */
		const entityLinkCompletion = (ctx: CompletionContext): CompletionResult | null => {
			const m = ctx.matchBefore(/@\[[^\]|]*/);
			if (!m) return null;
			const from = m.from + 2;
			const query = ctx.state.sliceDoc(from, ctx.pos).toLowerCase();
			const options = entityOptionsRef.current
				.filter((e) => e.name.toLowerCase().includes(query))
				.slice(0, 8)
				.map((e) => ({
					label: e.name,
					detail: e.type,
					apply: (v: EditorView, _c: unknown, _from: number, applyTo: number) => {
						v.dispatch({
							changes: { from, to: applyTo, insert: e.name },
							// Past the closing `]` (already auto-inserted by
							// `entityBracketPairing`), not just past the name — Enter
							// (or Tab) accepting a suggestion means "done with this
							// link", ready to keep typing ordinary prose right after it.
							selection: { anchor: from + e.name.length + 1 },
						});
					},
				}));
			if (options.length === 0) return null;
			return { from, options, filter: false };
		};

		/** A landing spot for `intExtCompletion`/`characterCompletion` to
		 *  offer their FULL list on, before anything's typed: an empty line
		 *  right after a blank one (or the document's first line). Doc
		 *  changes only need checking on the cursor's own line, but a
		 *  same-line selection move (arrow keys, a click) needs it too —
		 *  CM6's built-in "activate on typing" never fires for either, since
		 *  neither types a character. */
		const emptyCueLine = (state: EditorState): boolean => {
			const pos = state.selection.main.head;
			const line = state.doc.lineAt(pos);
			if (line.text.trim() !== '') return false;
			return line.number <= 1 || state.doc.line(line.number - 1).text.trim() === '';
		};

		const openLinkOnMousedown = (event: MouseEvent): boolean => {
			if (event.button !== 0) return false;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const char = target?.closest('[data-loom-fountain-char]');
			if (char instanceof HTMLElement && char.dataset.loomFountainChar && onOpenCharacterRef.current) {
				event.preventDefault();
				onOpenCharacterRef.current(char.dataset.loomFountainChar);
				return true;
			}
			const scene = target?.closest('[data-loom-fountain-scene]');
			if (scene instanceof HTMLElement && scene.dataset.loomFountainScene && onOpenLocationRef.current) {
				event.preventDefault();
				onOpenLocationRef.current(scene.dataset.loomFountainScene);
				return true;
			}
			const chapter = target?.closest('[data-loom-fountain-chapter]');
			if (chapter instanceof HTMLElement && chapter.dataset.loomFountainChapter && onOpenChapterRef.current) {
				event.preventDefault();
				onOpenChapterRef.current(chapter.dataset.loomFountainChapter);
				return true;
			}
			const entity = target?.closest('[data-loom-fountain-entity]');
			if (entity instanceof HTMLElement && entity.dataset.loomFountainEntity && onOpenEntityRef.current) {
				event.preventDefault();
				onOpenEntityRef.current(entity.dataset.loomFountainEntity);
				return true;
			}
			return false;
		};

		/** Wraps `range` in a fresh comment/alt-text marker pair — the same
		 *  two-part `changes` shape `toggleWrap` uses in markdown-field.tsx,
		 *  just parameterized on a freshly-generated id instead of a fixed
		 *  `**`/`_` pair. Fires `onCreateComment`/`onCreateAlt` afterward so
		 *  the caller persists the new sidecar entry — this component never
		 *  touches the sidecar itself, only the document. */
		const insertMarkerPair = (view: EditorView, kind: 'comment' | 'alt', from: number, to: number) => {
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
			if (kind === 'comment') onCreateCommentRef.current?.(id, selectedText);
			else onCreateAltRef.current?.(id, selectedText);
		};

		/** The first `contextmenu` handler in this editor — every other
		 *  interaction here is left-click only (`openLinkOnMousedown` above
		 *  explicitly bails on anything but button 0). Offers "Comment"/
		 *  "Alternative text…" on a non-empty selection; a selection that
		 *  partially crosses an existing marked span (nesting fully inside
		 *  or sitting fully outside one is fine) is rejected with a Notice
		 *  rather than attempted, keeping every span well-nested. */
		const openContextMenu = (view: EditorView, event: MouseEvent): boolean => {
			const sel = view.state.selection.main;
			if (sel.empty) return false;
			event.preventDefault();
			const spans = findAnnotationSpans(view.state.doc.toString());
			const overlaps = spans.some((s) => partiallyOverlaps(sel.from, sel.to, s.from, s.to));
			if (overlaps) {
				new Notice("Comments and alternative text can't partially overlap an existing one.");
			}
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('Comment')
					.setIcon('message-square')
					.setDisabled(overlaps)
					.onClick(() => insertMarkerPair(view, 'comment', sel.from, sel.to))
			);
			menu.addItem((item) =>
				item
					.setTitle('Alternative text…')
					.setIcon('arrow-right-left')
					.setDisabled(overlaps)
					.onClick(() => insertMarkerPair(view, 'alt', sel.from, sel.to))
			);
			menu.showAtMouseEvent(event);
			return true;
		};

		/** The right-side gutter for comment/alt-text icons — `side: 'after'`
		 *  puts it past the content instead of CM6's default before-content
		 *  placement (no CSS reordering trick needed). One marker per LINE
		 *  that a span STARTS on (not every line it covers) — a multi-line
		 *  comment shows its icon beside its first line only. */
		// `lineMarker` is called once per VISIBLE line every time the gutter
		// recomputes, so re-parsing the whole document's annotation spans
		// inside it would redo that parse once per line on screen. CM6's `Text`
		// is immutable and shared by reference when the document hasn't
		// changed, so caching on that reference (not the stringified text)
		// also skips the `.toString()` itself across calls within one pass.
		let annotationSpansCache: { doc: EditorState['doc']; spans: ReturnType<typeof findAnnotationSpans> } | null = null;
		const annotationSpansFor = (view: EditorView) => {
			if (annotationSpansCache?.doc !== view.state.doc) {
				annotationSpansCache = { doc: view.state.doc, spans: findAnnotationSpans(view.state.doc.toString()) };
			}
			return annotationSpansCache.spans;
		};

		const annotationGutter = gutter({
			class: 'loom-fountain-annotation-gutter',
			side: 'after',
			lineMarker: (gutterView, line) => {
				const spans = annotationSpansFor(gutterView);
				const lineNo = gutterView.state.doc.lineAt(line.from).number;
				const onThisLine = spans.filter((s) => gutterView.state.doc.lineAt(s.from).number === lineNo);
				if (onThisLine.length === 0) return null;
				const items: AnnotationGutterItem[] = onThisLine.map((s) => {
					const commentEntries = s.kind === 'comment' ? (commentsRef.current[s.id] ?? []) : [];
					return {
						kind: s.kind,
						id: s.id,
						unresolved: isUnresolvedComment(s.kind, commentEntries),
						highlighted: s.id === highlightedAnnotationIdRef.current,
					};
				});
				return new AnnotationGutterMarker(items);
			},
			lineMarkerChange: (update) =>
				update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations))),
			initialSpacer: () => new AnnotationGutterMarker([]),
			domEventHandlers: {
				click: (gutterView, line, event) => {
					// The icon glyph itself is an inline `<svg>` (Obsidian's
					// `setIcon`), and `SVGElement` doesn't extend `HTMLElement` —
					// gating the initial target on `HTMLElement` meant a click
					// landing on the glyph (most of the icon's clickable area)
					// silently missed `.closest()` entirely. `Element` covers both.
					const target = event.target instanceof Element ? event.target : null;
					const el = target?.closest('[data-loom-annotation-id]');
					if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
					const id = el.dataset.loomAnnotationId;
					if (el.dataset.loomAnnotationKind === 'comment') {
						onOpenCommentRef.current?.(id, el.getBoundingClientRect());
					} else {
						onCycleAltRef.current?.(id);
					}
					return true;
				},
				contextmenu: (gutterView, line, event) => {
					const target = event.target instanceof Element ? event.target : null;
					const el = target?.closest('[data-loom-annotation-id][data-loom-annotation-kind="alt"]');
					if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
					event.preventDefault();
					onOpenAltMenuRef.current?.(el.dataset.loomAnnotationId);
					return true;
				},
			},
		});

		// Typing `@` opens the pair immediately (like `[[` does for wikilinks
		// in markdown-field.tsx), inserting `@[]` with the cursor between the
		// brackets — EXCEPT at a forced-character-cue-eligible position
		// (start of a blank-gated line, e.g. `@JOHN`), where a bare `@` must
		// stay exactly what's typed so Fountain's own convention still works.
		const entityBracketPairing = EditorView.inputHandler.of((v, from, to, text) => {
			if (text === '@' && from === to) {
				const line = v.state.doc.lineAt(from);
				const before = v.state.sliceDoc(line.from, from).trim();
				const prevBlank = line.number <= 1 || v.state.doc.line(line.number - 1).text.trim() === '';
				const isForcedCuePosition = before === '' && prevBlank;
				if (!isForcedCuePosition && v.state.sliceDoc(from, from + 1) !== '[') {
					v.dispatch({ changes: { from, to, insert: '@[]' }, selection: { anchor: from + 2 } });
					return true;
				}
			}
			if (text === ']' && from === to && v.state.sliceDoc(from, from + 1) === ']') {
				v.dispatch({ selection: { anchor: from + 1 } });
				return true;
			}
			return false;
		});

		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					EditorView.lineWrapping,
					scrollWithinEditor,
					fountainDecorations,
					annotationGutter,
					annotationHandlesOverlay,
					entityBracketPairing,
					autocompletion({
						override: [intExtCompletion, characterCompletion, locationCompletion, entityLinkCompletion],
						icons: false,
					}),
					keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) onChangeRef.current(update.state.doc.toString());
						if (update.focusChanged && !update.view.hasFocus) onBlurRef.current?.();
						if (
							update.view.hasFocus &&
							(update.docChanged || update.selectionSet) &&
							emptyCueLine(update.state)
						) {
							startCompletion(update.view);
						}
					}),
					EditorView.domEventHandlers({
						mousedown: openLinkOnMousedown,
						contextmenu: (event, cmView) => openContextMenu(cmView, event),
					}),
				],
			}),
		});
		viewRef.current = view;
		// The overlay's own `update()` re-syncs handle positions on every CM6
		// update, which covers the editor's OWN internal scroll (CM6 fires an
		// update to re-render its viewport as you scroll) — but not the OUTER
		// page scrolling the whole editor box around on screen, which CM6 has
		// no reason to know or care about. Same capture-phase "any scroll,
		// anywhere" listener the comment popover's own scroll-tracking uses.
		const onAnyScroll = () => view.plugin(annotationHandlesOverlay)?.sync();
		document.addEventListener('scroll', onAnyScroll, true);
		return () => {
			document.removeEventListener('scroll', onAnyScroll, true);
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	// External value changes (loaded from disk, or `ensureSceneIds`/
	// `syncScenes` rewriting the text after a blur) — pushed in only while
	// unfocused, same as markdown-field.tsx, so a live edit's cursor is never
	// disturbed by our own echo of what it just produced.
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.hasFocus) return;
		const current = view.state.doc.toString();
		if (current !== value) {
			// A wholesale `[0, length)` replace gives CM6 no positional
			// continuity to map the OLD scroll anchor through — every existing
			// line just got deleted, so it collapses to the very top of the
			// document instead of staying where the user actually was. An
			// external resync like this is near-always a small, localized
			// change (`ensureSceneIds` stamping one id, `syncScenes`, an
			// alt-text swap elsewhere in the document via `AltTextModal`) —
			// alt-text actions in particular now trigger this path on every
			// single cycle/draft/accept/delete (see script-view.tsx's/
			// entity-view.tsx's `commitFieldEdit`), so without this the view
			// visibly jumped to line 1 on nearly every one of those. Reading
			// the SAME line number back in the new document is a good enough
			// anchor for that kind of change.
			const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
			// Computed straight from the NEW `value` string (plain JS, not
			// `view.state`) so the scroll target can ride in the SAME
			// transaction as the replace itself — `EditorView.scrollIntoView`'s
			// position is read in the transaction's RESULTING document, which
			// is exactly this string once the change applies.
			const valueLines = value.split('\n');
			const clampedIdx = Math.min(Math.max(topLine - 1, 0), valueLines.length - 1);
			const targetPos = valueLines.slice(0, clampedIdx).join('\n').length + (clampedIdx > 0 ? 1 : 0);
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
				effects: EditorView.scrollIntoView(targetPos, { y: 'start' }),
			});
		}
	}, [value]);

	// A comment's resolved state (or an alt-text's option list, or which id a
	// search match currently highlights) can change from the caller's own
	// popover/search UI without any document edit — the gutter's icon still
	// needs to redraw, so a no-op transaction carrying `refreshAnnotations`
	// nudges it (see the gutter's own `lineMarkerChange`, inside the mount
	// effect).
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({ effects: refreshAnnotations.of(null) });
	}, [comments, altText, highlightedAnnotationId]);

	return <div className="loom-fountain-field" ref={hostRef} />;
});
