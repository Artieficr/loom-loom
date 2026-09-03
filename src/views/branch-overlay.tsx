import {
	ForwardedRef,
	ReactElement,
	RefObject,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Menu } from 'obsidian';
import { EditorView, repositionTooltips } from '@codemirror/view';
import {
	ParsedSection,
	branchBodyText,
	branchComboKey,
	branchGroupBounds,
	decomposeBranchValue,
	nextComboNumber,
	parseFountain,
} from '../fountain';
import { FountainField, FountainFieldHandle } from './fountain-field';
import { Icon } from './common';
import { EntityType } from '../types';
import { t } from '../i18n';

/**
 * The modular branch editor's own overlay: `position: fixed` OPAQUE panels
 * drawn on top of the live Fountain editor's own raw text, sourced from the
 * SAME `EditorView` `FountainField` already owns — never a second copy of
 * the document, never a CM6 decoration/widget replacing the branch's own
 * content (see this feature's plan doc,
 * `~/.claude/plans/mighty-popping-turing.md`, for the full architecture
 * decision). A branch is FULLY operated through its own panel here — Title,
 * decomposed Identifier/Subidentifier/Number on branch 1, and its own prose
 * BODY (dialogue/action, a real nested `FountainField` — see
 * `BranchBodyField`'s own doc comment) — every card is a solid, opaque,
 * self-sufficient data-entry surface (`pointer-events: auto`, `overflow:
 * hidden`); the live CM6 text underneath a branch's own span is completely
 * covered and never directly interacted with. A `new-group`/`new-branch`
 * DRAFT (not yet written to the document) uses the same opaque-card shape.
 *
 * Faithfully mirrors `AnnotationHandlesOverlay`'s (fountain-field.tsx)
 * scheduling: every EXPENSIVE trigger (doc/geometry change, resize,
 * mutation, drafts changing) funnels through one `setTimeout`-coalesced
 * `sync()` (never `requestAnimationFrame` — CM6 schedules its own internal
 * measure work via rAF too, a same-frame collision risk documented on that
 * overlay's own history), and `view.coordsAtPos` is only ever called from
 * inside that deferred `sync()`, wrapped in a `try/catch` backstop, exactly
 * like the annotation handles do — never synchronously from a CM6-invoked
 * callback.
 *
 * **Scrolling is deliberately NOT one of those expensive triggers**: `sync()`
 * computes each card's position as a DOCUMENT-relative `top` (`screen top at
 * sync time` + `the scrollTop at that moment`, i.e. "where this card would
 * sit if `scrollTop` were 0") rather than a viewport-relative one, and every
 * card renders inside one shared `trackRef` div that gets `transform:
 * translateY(-scrollTop)` applied DIRECTLY (bypassing React entirely) by a
 * plain, un-debounced `scroll` listener on `view.scrollDOM`. That single
 * `transform` write is the only thing that has to track a fast scroll
 * gesture in real time, and it's cheap enough (one DOM write, no layout
 * read) to do so with zero perceptible lag; `sync()` itself only runs on
 * genuine content/geometry changes, occasionally re-confirming (and
 * correcting any drift in) the values the transform is built from.
 *
 * **Clipping is a real CSS `overflow: hidden`, not manual clamp math**: every
 * card gets its real, UNCLAMPED height, and a fixed "window" div — sized to
 * `visibleClipRect(view.scrollDOM)`, `overflow: hidden` — does the actual
 * visual trimming, exactly like a normal scrollable region clips its
 * content, so a card scrolls out from under that edge the way ordinary
 * document text does (its header included — the header is just the card's
 * first child, not independently pinned to anything). `topClamped`/
 * `bottomClamped` (`BranchCardRect`) exist purely to decide whether to draw
 * a rounded/bordered edge (a real document-span boundary) vs. a flat one (a
 * mid-span clip line) — they never affect where anything is positioned.
 *
 * **Portalled to `document.body`** (`createPortal`, same reasoning as
 * `CommentPopover`/`timeline-strip.tsx`'s own tooltip): Obsidian's
 * workspace-leaf DOM applies CSS `contain`, which re-bases `position: fixed`
 * to the leaf instead of the true viewport — `coordsAtPos` returns TRUE
 * viewport coordinates, so rendering these cards as ordinary nested React
 * children (inside that contained leaf) put them at the wrong screen
 * position entirely.
 *
 * Unlike `AnnotationHandlesOverlay` (a CM6 `ViewPlugin` imperatively managing
 * plain DOM spans), this is an ordinary React component: it needs real
 * `<input>`/`<textarea>`/button elements with ordinary React event handling,
 * which doesn't fit that imperative-DOM-node style. Rendered DOM is
 * React-owned (cleaned up by React's own unmount, not manual `.remove()`
 * calls), so the specific leak `AnnotationHandlesOverlay`'s own
 * `destroyed`/`isConnected` guards exist for doesn't apply the same way here
 * — the `destroyed` ref below only guards against a stale `setState` call
 * landing after unmount, a much smaller concern.
 *
 * **Every branch group in the document gets a mounted card, unconditionally**
 * — never gated on proximity to the current scroll position. The fixed clip
 * window's `overflow: hidden` keeps every off-screen card invisible without
 * needing to avoid mounting it.
 *
 * **A branch's card can be genuinely TALLER than its real document span**
 * (`branchSpacers`, threaded into the caller's own main `FountainField` —
 * see that file's own doc comment on the prop): the panel's own header UI
 * (`###`/Title, `= branch:`/combo row, the `>**Title**<` preview)
 * and, on a group's last card, its footer (`= gather` + the "+" button)
 * don't correspond to any extra document height by themselves — a real span
 * only reserves what its own heading/`= branch:` synopsis lines take up,
 * which is less than header + footer need. `BranchOverlay` measures each
 * card's own header height, footer height (when present), and its nested
 * body's natural content height, and reports any shortfall upward; the
 * caller's main editor then reserves that many extra pixels as
 * `padding-bottom` on this branch's OWN `= branch: <id>` synopsis line —
 * genuine screen space with zero effect on the actual document text, so the
 * branch's real span grows to match what the panel needs instead of the
 * panel being squeezed into what the span happens to already provide.
 *
 * **A real consequence of going fully opaque/`pointer-events: auto`**: a
 * right-click anywhere inside a branch's own card can no longer pass
 * through to the live CM6 editor beneath it. Two different surfaces answer
 * it, covering the two different kinds of area a card actually has: the
 * card's OWN chrome (header, margins — this file's own `onContextMenu`)
 * offers "Cut branch group"/"Copy branch group" directly; a right-click
 * landing INSIDE the nested body (`BranchBodyField`'s own real `FountainField`
 * instance) reaches `fountain-field.tsx`'s own `openContextMenu` instead,
 * which offers the SAME two actions under its ordinary Cut/Copy items once
 * it's told which group it belongs to (`branchGroupId`, that file's own doc
 * comment) — replacing that field's usual per-selection text semantics
 * entirely, not adding a third option beside them. That field's own handler
 * also calls `event.stopPropagation()`, so a body-level right-click is
 * handled ONCE, never bubbling up to also trigger this card's own handler on
 * top of it. `fountain-field.tsx` only offers "Create new branch"/"Paste
 * branch group" on a genuinely empty line OUTSIDE any existing group's span
 * — which, in ordinary use, this overlay's own opaque cards make
 * unreachable-by-construction anyway (the click never gets past the panel to
 * begin with); `branchGroupAtLine` (fountain.ts) stays there purely as
 * defensive belt-and-suspenders for the brief window before this component's
 * first `sync()` has run.
 */

/** A brand-new decision point not yet written to the document —
 *  `entity-view.tsx`'s Scene section owns the `BranchDraft[]` state
 *  (co-located with `sceneScriptEditorRef`), this component only renders it
 *  and reports field edits back up. Created via the Fountain editor's own
 *  right-click "Create new branch" on an empty line. Its `id` doubles as the
 *  CM6 draft-anchor tracking key (`FountainFieldHandle.createDraftAnchor`/
 *  `getDraftAnchorLine`) — the anchor survives concurrent edits elsewhere in
 *  the document while the draft sits open. No body field — a real insertion
 *  always starts with an empty body, edited afterward through the now-real
 *  card's own body field.
 *
 *  **This is now the ONLY way a branch is ever staged before being real** —
 *  joining an EXISTING decision point (the group's own "+") used to go
 *  through an identical draft shape (`kind: 'new-branch'`), but that path is
 *  gone: `entity-view.tsx`'s `handleAddBranch` now writes the new branch
 *  straight to the document (title `'Untitled'`) the instant "+" is clicked,
 *  with no draft/staging state at all — see that function's own doc comment
 *  for why (committing immediately, then masking the placeholder title as a
 *  blank field until the user actually types something, reads far less
 *  jarring than a draft that silently becomes real mid-keystroke). */
export interface BranchDraft {
	id: string;
	title: string;
	identifier: string;
	subidentifier: string;
	numberOverride: string;
}

/** How much wider than the real text column a card's own outer box is —
 *  see this file's own `sync()` for the full reasoning (breathing room
 *  around the header/gather rows; the text column itself stays pinned to
 *  its own true width, centered within this wider box, entirely unaffected
 *  by this factor). */
const CARD_WIDEN_FACTOR = 1.17;

interface BranchCardRect {
	/** The section's own `[[loom:<id>]]` — stable across a group's own
	 *  reorder/renumber, unlike its current `= branch:` value. */
	sectionId: string;
	groupId: string;
	/** This branch's own current heading title — what the Title field
	 *  edits. */
	title: string;
	/** This branch's own current body text (`branchBodyText`, fountain.ts)
	 *  — what the nested body `FountainField` edits. */
	body: string;
	/** DOCUMENT-relative top (screen top at last `sync()`, converted to "as
	 *  if `view.scrollDOM.scrollTop` were 0" by adding that scrollTop back
	 *  in) — a value that stays correct across ordinary CM6-internal
	 *  scrolling with NO recompute, because the shared scroll-tracking
	 *  `<div>` this card renders inside (`trackRef`, below) gets its own
	 *  `transform: translateY(-scrollTop)` applied directly on every native
	 *  `scroll` event, synchronously, bypassing React entirely — the only
	 *  thing that has to track a live scroll gesture in real time. */
	top: number;
	/** The branch's real, UNCLAMPED height (`screenBottom - screenTop` at
	 *  sync time) — never shrunk to "however much is currently visible."
	 *  Clipping is a real CSS `overflow: hidden` on the fixed "window" div
	 *  this card's track renders inside (sized to `clipRect`), not manual
	 *  top/height math, so a card (header included) scrolls out from under
	 *  the window's edge the way ordinary document text does. */
	height: number;
	left: number;
	width: number;
	/** The real text column's own true width (pre-`CARD_WIDEN_FACTOR`,
	 *  matching the real editor's own `.cm-content` exactly) — what
	 *  `BranchBodyField` pins its nested field's rendered width to,
	 *  regardless of the card's own wider outer box. */
	contentWidth: number;
	/** The margin the widened card carries on each side of that text column
	 *  (`(width - contentWidth) / 2`) — applied as the header/gather row's
	 *  own `padding-left`, so the `###`/`= branch:`/`= gather` labels start
	 *  at the SAME x position the real body text does, rather than at
	 *  whatever smaller fixed inset the header's own padding would
	 *  otherwise use. */
	contentMargin: number;
	position: 'only' | 'first' | 'middle' | 'last';
	/** Whether this edge's TRUE position (independent of current scroll) is
	 *  ever going to sit outside the clip window — computed once at sync
	 *  time from the same screen coordinates `top`/`height` are derived
	 *  from. A clamped edge never draws a border/radius (see the render
	 *  function below): a closed rounded corner there would misleadingly
	 *  read as "this is where the branch really ends" when it's only where
	 *  the window happens to cut off. May go one `sync()` pass stale during
	 *  an active scroll gesture (it doesn't update on the cheap per-scroll
	 *  transform tick) — self-corrects the moment scrolling settles and the
	 *  debounced `sync()` runs again, which is an acceptable trade for
	 *  keeping the hot scroll path free of per-card arithmetic. */
	topClamped: boolean;
	bottomClamped: boolean;
	/** True when either edge fell back to `view.lineBlockAt`'s own estimated
	 *  height map instead of a real `coordsAtPos` measurement (see `docTop`/
	 *  `docBottom` below) — CM6 only measures positions it has actually
	 *  rendered, so an off-screen (virtualized) branch card falls back here
	 *  even though every branch gets a rect unconditionally, "visible or
	 *  not" (this file's own `sync()` doc comment). The estimate does NOT
	 *  reflect this branch's own `padding-bottom` spacer (fountain-field.tsx
	 *  never actually renders/lays out a virtualized line, so its height-map
	 *  entry stays at the unpadded guess) — the spacer-shortfall effect below
	 *  MUST skip an estimated rect entirely rather than trust its `height`,
	 *  or it computes a "shortfall" against a height that can never grow no
	 *  matter how much spacer is added, requesting more every pass forever
	 *  (confirmed: this was a real runaway-growth bug, `currentSpacer`
	 *  climbing without bound while `naturalHeight` went arbitrarily
	 *  negative, for every off-screen branch in a longer script). */
	estimated: boolean;
}

/** A still-open draft's on-screen anchor — just a `top`/`left`/`width`, no
 *  `bottom`/height: a draft has no real document content to measure a span
 *  from yet, so its card's height is purely whatever its own editable
 *  fields need (`height: auto`), unlike a real `BranchCardRect`. `top` is
 *  document-relative, same convention as `BranchCardRect.top` above. */
interface DraftCardRect {
	draftId: string;
	top: number;
	left: number;
	width: number;
}

/** The fixed on-screen "window" every card/draft renders inside —
 *  `visibleClipRect(view.scrollDOM)`, i.e. the editor's own visible viewport
 *  intersected with every clipping ancestor. A real `overflow: hidden` div
 *  sized to this rect is what gives cards genuine CSS clipping at its
 *  edges. */
interface ClipWindow {
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * The true visible rect of `el`, intersected against EVERY scrollable
 * ancestor's own clipping bounds (not just one specific container) plus the
 * real browser viewport. `getBoundingClientRect()` alone never accounts for
 * ancestor `overflow` clipping — it reports an element's raw geometry
 * regardless of whether a parent's own scroll has hidden part of it — which
 * is exactly what made clipping against a single known container (first
 * `.loom-scene-script`, then `view.scrollDOM`) still overlap unrelated page
 * chrome the moment an OUTER container (Obsidian's own workspace-leaf
 * content scroller) was the one doing the scrolling instead. Walking the
 * whole ancestor chain and intersecting every clipping one's rect is the
 * general, established fix for this class of problem.
 */
function visibleClipRect(el: HTMLElement): { top: number; bottom: number; left: number; right: number } {
	let top = 0;
	let left = 0;
	let bottom = window.innerHeight;
	let right = window.innerWidth;
	let node: HTMLElement | null = el;
	while (node && node !== document.body && node !== document.documentElement) {
		const style = window.getComputedStyle(node);
		const clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
		const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
		if (clipsX || clipsY) {
			const r = node.getBoundingClientRect();
			if (clipsY) {
				top = Math.max(top, r.top);
				bottom = Math.min(bottom, r.bottom);
			}
			if (clipsX) {
				left = Math.max(left, r.left);
				right = Math.min(right, r.right);
			}
		}
		node = node.parentElement;
	}
	return { top, bottom, left, right };
}

export interface BranchOverlayProps {
	/** The Scene page's own `FountainFieldHandle` ref — read fresh on every
	 *  sync via `getView()`, never cached, matching every other consumer of
	 *  this handle in this codebase. */
	fieldRef: RefObject<FountainFieldHandle | null>;
	/** The field's wrapping `.loom-scene-script` div — for one safe
	 *  `getBoundingClientRect()` call, same role `AnnotationHandlesOverlay`
	 *  gives the scroller. */
	wrapRef: RefObject<HTMLDivElement | null>;
	/** The CURRENT body text the field is showing (`sceneDraft`, heading
	 *  stripped) — branch line numbers/content are re-derived from this on
	 *  every sync, never stored, same as everything else in this feature. */
	text: string;
	/** Bumped by the caller on every `FountainField.onGeometryChange` firing
	 *  (`update.viewportChanged || update.geometryChanged`) — the one signal
	 *  this component has no other way to see, since it's plain React with
	 *  no access to CM6's own update stream. A real, reported bug (cards a
	 *  few pixels off on first mount, self-correcting only on the next
	 *  scroll) traced to exactly this gap: DOM-level scroll/resize events
	 *  alone don't fire for every moment CM6's OWN internal layout settles
	 *  (most commonly, right after mount, before web fonts fully resolve). */
	geometryVersion?: number;
	/** Still-open drafts (state owned by the caller) — rendered alongside
	 *  the real cards, at their own tracked/derived anchor position. */
	drafts: BranchDraft[];
	/** A draft's field changed — the caller applies the patch to its own
	 *  state, nothing more; committing is a SEPARATE, explicit step
	 *  (`onCreateDraft`, below) — it used to happen automatically the
	 *  instant every required field held something, which meant the branch
	 *  got written mid-keystroke, before the user had finished typing
	 *  whichever field happened to fill in last (a real, reported
	 *  complaint). */
	onDraftField: (id: string, patch: Partial<BranchDraft>) => void;
	/** The draft's own "Create" button — the ONLY thing that turns a draft
	 *  into a real branch (`insertBranch`, fountain.ts) now, removing it
	 *  from `drafts`. Disabled in the JSX below unless title/identifier/
	 *  subidentifier are all filled; the caller re-checks the same
	 *  condition regardless (belt-and-suspenders against a stale click). */
	onCreateDraft: (id: string) => void;
	/** The draft was explicitly dismissed (its own ✕, Esc, or a click
	 *  outside its own card) — the caller drops it from `drafts` and clears
	 *  its CM6 anchor (`new-group` only). */
	onDismissDraft: (id: string) => void;
	/** A branch's own Title field was edited — `renameSectionTitle`
	 *  (fountain.ts) through `editScriptAndSync`. */
	onRenameBranchTitle: (sectionId: string, newTitle: string) => void;
	/** Branch 1's decomposed Identifier/Subidentifier/Number fields were
	 *  edited — every sibling sharing the group's value moves together
	 *  (`setBranchTagValue`, fountain.ts). */
	onSetBranchCombo: (groupId: string, identifier: string, subidentifier: string, numberOrOverride: string) => void;
	/** Branch 1's single plain field (a legacy value that doesn't decompose
	 *  into 3 segments) was edited — rewrites the raw value verbatim. */
	onSetBranchRaw: (groupId: string, newValue: string) => void;
	/** A branch's own body field was edited (`replaceBranchBody`,
	 *  fountain.ts). */
	onSetBranchBody: (sectionId: string, newBody: string) => void;
	/** The group's own "+" (rendered on its last card) — the caller
	 *  (`entity-view.tsx`'s `handleAddBranch`) writes a real new branch to
	 *  the document immediately, no draft/staging step; see that function's
	 *  own doc comment. */
	onAddBranch: (groupId: string) => void;
	/** The section id of a branch just created via `onAddBranch`, still
	 *  waiting for its Title field to claim the one-shot "show blank, not
	 *  the underlying `'Untitled'` placeholder, and steal focus" treatment
	 *  — see `BranchTitleField`'s own `autoFocusEmpty` doc comment. `null`
	 *  the rest of the time (no branch is currently pending this). */
	pendingTitleFocusId?: string | null;
	/** Fired once, the instant the pending id above has actually been
	 *  claimed by its own Title field's first mount — the caller clears its
	 *  own pending-id state so a LATER remount of that same field (e.g.
	 *  switching Script mode away and back) can never wrongly re-blank a
	 *  branch that already has a real title by then. */
	onTitleFocusConsumed?: () => void;
	/** A card's own right-click "Cut branch group" — see this file's own top
	 *  doc comment for why this lives here now instead of
	 *  `fountain-field.tsx`'s `openContextMenu`. Also threaded straight into
	 *  each card's own nested `BranchBodyField`, so a right-click INSIDE the
	 *  body reaches the identical handler. */
	onCutBranchGroup: (groupId: string) => void;
	/** "Copy branch group" — same clipboard as `onCutBranchGroup`, but the
	 *  source stays in the document. Threaded the same two ways. */
	onCopyBranchGroup: (groupId: string) => void;
	/** The trash icon on a card's own `###` row — deletes just THIS branch
	 *  (`removeBranchFromGroup`, fountain.ts), not the whole group the way
	 *  "Cut branch group" does. The caller confirms before calling this (real
	 *  prose is lost, unlike a cut, which survives in the branch clipboard). */
	onDeleteBranch: (sectionId: string) => void;
	/** Existing character names, fed straight through to each card's own
	 *  embedded `FountainField` body — same list the caller's own main
	 *  script editor already passes, so the character-cue autocomplete
	 *  behaves identically inside a branch's body. See `BranchBodyField`'s
	 *  own doc comment for why the body is a real nested `FountainField` at
	 *  all, not a plain textarea. */
	characters: string[];
	/** `@[` inline entity-link autocomplete/resolution — same shape/source
	 *  as the caller's own main editor's `entityOptions` prop. */
	entityOptions?: { name: string; type: EntityType; path: string }[];
	/** Ambient link-suggester dismiss delay — same setting the caller's own
	 *  main editor reads (`plugin.settings.ambientLinkSuggestDismissMs`). */
	ambientSuggestDismissMs?: number;
	/** Reports, after every render, how many extra pixels of `padding-top`
	 *  each branch (keyed by its own `[[loom:<id>]]`) needs reserved right
	 *  after its own span in the caller's REAL document — see this file's
	 *  own top doc comment ("A branch's card can be genuinely TALLER...")
	 *  for the full reasoning. The caller feeds the returned map straight
	 *  into its own main `FountainField`'s `branchSpacers` prop
	 *  (fountain-field.tsx), which is what actually reserves the space; this
	 *  callback only ever fires with a genuinely changed map (a shallow diff
	 *  against what was last reported, tolerant of sub-pixel jitter), so a
	 *  caller storing it in `useState` doesn't need its own extra guard
	 *  against redundant re-renders. */
	onSpacerNeedsChange?: (spacers: Record<string, number>) => void;
	/** Default `true` — set `false` by a caller whose own `FountainField`
	 *  renders every REAL branch group itself (`embeddedBranchCards`,
	 *  fountain-field.tsx), so this component's own opaque cards would just
	 *  double up on top of that. Still-open DRAFTS (`drafts`, above) keep
	 *  rendering regardless — a draft has no backing document content yet,
	 *  so there's nothing for the embedded renderer to show in its place.
	 *  Deliberately only gates the RENDER, not the underlying measurement
	 *  pass (`sync()`'s own `rects` computation) — that logic is delicate
	 *  enough (see this file's own top doc comment on scroll timing) that
	 *  skipping it selectively wasn't worth the risk for what's a small,
	 *  Scene-page-only perf cost. */
	renderRealCards?: boolean;
}

export function BranchOverlay({
	fieldRef,
	wrapRef,
	text,
	geometryVersion,
	drafts,
	onDraftField,
	onCreateDraft,
	onDismissDraft,
	onRenameBranchTitle,
	onSetBranchCombo,
	onSetBranchRaw,
	onSetBranchBody,
	onAddBranch,
	pendingTitleFocusId,
	onTitleFocusConsumed,
	onCutBranchGroup,
	onCopyBranchGroup,
	onDeleteBranch,
	characters,
	entityOptions,
	ambientSuggestDismissMs,
	onSpacerNeedsChange,
	renderRealCards = true,
}: BranchOverlayProps): ReactElement | null {
	const [rects, setRects] = useState<BranchCardRect[]>([]);
	const [draftRects, setDraftRects] = useState<DraftCardRect[]>([]);
	/** A fresh parse of the live document text, memoized purely for the
	 *  draft panel's own Number field PREVIEW below (`nextComboNumber`) —
	 *  independent of `sync()`'s own internal `parsed` (a separate local
	 *  const, recomputed on every scroll/geometry sync pass for layout
	 *  purposes), since this only needs to react to genuine document
	 *  content changes, not scroll/resize. `parseFountain` is cheap and
	 *  dependency-free, already re-run per keystroke elsewhere in this
	 *  codebase (the Outline panel), so a second parse here costs nothing
	 *  worth avoiding. */
	const parsedForPreview = useMemo(() => parseFountain(text), [text]);
	const [clipWindow, setClipWindow] = useState<ClipWindow | null>(null);
	/** The Scene page's own nav/comments/alt-text side panel (`.loom-script-nav-sticky`,
	 *  entity-view.tsx) is a plain sibling in the same `wrap`, never portalled — it sits
	 *  inside Obsidian's own workspace-leaf DOM, which applies a `contain` that forces a
	 *  stacking context on everything inside it (see `CommentPopover`'s own doc comment
	 *  for the same fact), so no z-index on that panel can ever outrank THIS component's
	 *  `document.body` portal. Rather than also portalling that panel (a bigger change
	 *  touching every one of its several call sites), this component excludes whatever
	 *  screen area it currently occupies from its own clip window — a real CSS hole, not
	 *  a lower z-index, so the genuine panel underneath (not a stand-in) shows through. */
	const [obscureRect, setObscureRect] = useState<{ right: number; bottom: number } | null>(null);
	const destroyedRef = useRef(false);
	const syncQueuedRef = useRef(false);
	/** Per-card header/footer/body measurement refs (keyed by section id) —
	 *  read by the `useLayoutEffect` below, right after `rects` commits to the
	 *  DOM, to compute `onSpacerNeedsChange`'s own map. Plain mutable `Map`s,
	 *  not React state — nothing here needs to trigger a re-render on its
	 *  own. `footerElsRef` only ever holds an entry for a group's LAST card
	 *  (the `= gather` row, present there and nowhere else). */
	const headerElsRef = useRef(new Map<string, HTMLDivElement>());
	const footerElsRef = useRef(new Map<string, HTMLDivElement>());
	const bodyHandlesRef = useRef(new Map<string, BranchBodyFieldHandle>());
	const lastReportedSpacersRef = useRef<Record<string, number>>({});
	/** Each currently-open draft's own `.loom-branch-card-draft` DOM node,
	 *  keyed by its own id — used only by the outside-click cancel effect
	 *  right below. Plain callback-ref map, not React state: nothing here
	 *  needs to trigger a re-render on its own. */
	const draftElsRef = useRef(new Map<string, HTMLDivElement>());
	// Clicking anywhere outside a still-open draft panel cancels it, same
	// as its own explicit ✕ (a real, reported request — a draft used to
	// just sit there forever until dismissed by hand). A plain
	// document-level, CAPTURE-phase `pointerdown` listener — same technique
	// `common.tsx`'s `useCloseOnOutsideClick` uses, but not reused directly:
	// that hook is built around ONE boolean open/close flag, not an
	// arbitrary list of simultaneously-open items keyed by id, which is
	// what `drafts: BranchDraft[]` genuinely allows (more than one
	// "Create new branch" can be in flight at once). Never calls
	// `preventDefault`/`stopPropagation` — dismissing a draft here must
	// never swallow whatever the click was ACTUALLY for (e.g. clicking a
	// DIFFERENT group's own "+" both cancels this draft and still opens a
	// new one, in that order, since `pointerdown` fires before `click`).
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			for (const draft of drafts) {
				const el = draftElsRef.current.get(draft.id);
				if (el && !el.contains(e.target as Node)) onDismissDraft(draft.id);
			}
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	}, [drafts, onDismissDraft]);
	/** The shared scroll-tracking div every card/draft renders inside — see
	 *  this file's own top doc comment for why its `transform` is the thing
	 *  that actually tracks a live scroll gesture, not `sync()`/React. */
	const trackRef = useRef<HTMLDivElement | null>(null);
	/** A title still being typed (not yet committed on blur), keyed by
	 *  section id — lets `.loom-branch-title-preview` update on every
	 *  keystroke instead of only once the Title field's own commit lands.
	 *  Never explicitly cleared: once set, it's always either equal to the
	 *  latest keystroke or (after commit) equal to `r.title` anyway, so
	 *  there's nothing to revert to. */
	const [liveTitleOverrides, setLiveTitleOverrides] = useState<Record<string, string>>({});
	/** The window div's own node, tracked purely so `setWindowRef` (below)
	 *  can remove its listener from the PREVIOUS node before attaching to a
	 *  new one. */
	const windowElRef = useRef<HTMLDivElement | null>(null);
	/** Whether wheel input is currently being let PASS THROUGH every card
	 *  (`.loom-branch-passthrough` on `trackRef`, styles.css) straight to the
	 *  real, natively-scrollable editor sitting underneath, instead of being
	 *  caught and manually forwarded — see `enablePassThrough`'s own doc
	 *  comment for the full mechanism/reasoning. Plain ref, not React state:
	 *  toggled from native event listeners outside React's render cycle,
	 *  same convention as every other live-interaction ref in this file. */
	const passThroughActiveRef = useRef(false);
	const passThroughIdleTimerRef = useRef<number | null>(null);
	/** How long wheel input has to stay quiet, anywhere near this branch
	 *  panel, before a card goes back to capturing clicks/typing itself — see
	 *  `enablePassThrough`'s own doc comment. Long enough that consecutive
	 *  trackpad "flicks" (a real gesture almost never fires perfectly
	 *  continuously; there are always small gaps between flicks) don't keep
	 *  flipping a card's `pointer-events` back and forth mid-scroll, short
	 *  enough that a click right after scrolling stops doesn't land on a
	 *  still-pass-through card and silently miss it. */
	const PASSTHROUGH_IDLE_MS = 150;
	/** Lets wheel input over a branch card fall straight through to the
	 *  real, natively-scrollable CM6 editor sitting directly underneath it on
	 *  screen (a card visually covers the exact document span it represents
	 *  — see this file's own top doc comment), instead of this file catching
	 *  the event and manually replaying it via `onWindowWheelRef`'s own
	 *  `scrollTop` write.
	 *
	 *  **Why this exists at all**: a card is a portalled `position: fixed`
	 *  element in a completely separate DOM subtree from the real editor, so
	 *  a wheel event over it has no bubbling path to the real scrollable
	 *  element — `onWindowWheelRef` (below) is what makes scrolling work AT
	 *  ALL while hovering a card, replaying the delta onto `view.scrollDOM`
	 *  every animation frame. But a manually-replayed `scrollTop` write runs
	 *  on the main thread and lands in discrete per-frame steps; it can
	 *  never fully match the browser's own COMPOSITOR-driven native scroll
	 *  (jank-proof, sub-frame-accurate, carries the OS's own momentum/
	 *  inertia curve) — confirmed as a real, reported mismatch: scrolling
	 *  that STARTS over the real editor stays glued and smooth even once a
	 *  card slides under a stationary cursor mid-gesture (browsers lock a
	 *  continuous wheel/scroll sequence to whichever element it began on,
	 *  regardless of what's later found at that same screen point), but a
	 *  gesture that STARTS while hovering a card is stuck on the JS-forwarded
	 *  path for its entire duration, visibly steppier.
	 *
	 *  **The fix**: once wheel input is detected anywhere over this panel
	 *  (the document-level capture listener registered in this file's main
	 *  effect, below), every mounted card gets `pointer-events: none` via a
	 *  modifier class on `trackRef` — cheap, since `pointer-events` cascades
	 *  to every `.loom-branch-card` descendant through ONE class toggle,
	 *  no per-card bookkeeping needed. With cards no longer hit-testable,
	 *  the NEXT wheel tick's target resolution skips straight past this
	 *  whole overlay to whatever's genuinely rendered underneath — the real
	 *  CM6 scroller — giving that tick (and, per the gesture-locking behavior
	 *  above, the rest of whatever gesture it belongs to) fully native,
	 *  compositor-smooth scrolling with zero JS involvement. The very FIRST
	 *  tick of a cold-start gesture (pointer-events still `auto`, nothing has
	 *  scrolled recently) still has to land on the card and go through the
	 *  manual-forward fallback — there's no way to avoid that one tick
	 *  without losing the ability to click/type into a card at all — but
	 *  every gesture after that, as long as the idle window hasn't lapsed,
	 *  starts pass-through from its very first tick.
	 *
	 *  A card left permanently `pointer-events: none` would of course also
	 *  stop capturing clicks/typing — this only STAYS active while wheel
	 *  input keeps arriving (`schedulePassThroughIdle`, re-armed on every
	 *  tick from the document-level listener), reverting to normal
	 *  interactive cards `PASSTHROUGH_IDLE_MS` after the last one. */
	const enablePassThrough = () => {
		if (passThroughActiveRef.current) return;
		passThroughActiveRef.current = true;
		trackRef.current?.classList.add('loom-branch-passthrough');
	};
	const disablePassThrough = () => {
		if (!passThroughActiveRef.current) return;
		passThroughActiveRef.current = false;
		trackRef.current?.classList.remove('loom-branch-passthrough');
	};
	const schedulePassThroughIdle = () => {
		if (passThroughIdleTimerRef.current !== null) window.clearTimeout(passThroughIdleTimerRef.current);
		passThroughIdleTimerRef.current = window.setTimeout(() => {
			passThroughIdleTimerRef.current = null;
			disablePassThrough();
		}, PASSTHROUGH_IDLE_MS);
	};
	/** Accumulates wheel delta between animation frames — see
	 *  `onWindowWheelRef`'s own doc comment for why applying it once per
	 *  frame, not once per raw wheel event, is what actually matters here. */
	const pendingWheelRef = useRef({ x: 0, y: 0, scheduled: false });
	/** Forwards a wheel gesture straight to the real editor's own scroll
	 *  position — see `setWindowRef`'s own doc comment for why this is
	 *  needed AT ALL. Every individual wheel event's delta is accumulated
	 *  into `pendingWheelRef` and applied to `scrollTop`/`scrollLeft` ONCE
	 *  PER ANIMATION FRAME, not once per event: a trackpad can fire wheel
	 *  events far faster than the display refreshes, and a synchronous
	 *  `scrollTop` write on every single one forces a layout recalculation
	 *  that often, producing a visibly stepped/jaggy scroll compared to
	 *  hovering directly over the real (natively, compositor-smoothed)
	 *  editor. Coalescing to one write per frame is the standard fix for
	 *  manually-forwarded wheel input. `requestAnimationFrame` is safe here
	 *  specifically because
	 *  nothing inside it calls `coordsAtPos`/`posAtCoords` (the actual
	 *  CM6-rAF collision risk documented on this file's own top doc comment
	 *  and on `AnnotationHandlesOverlay`, fountain-field.tsx) — a plain
	 *  `scrollTop`/`scrollLeft` write is never a forbidden-during-update
	 *  layout READ. A stable ref (created once, closing only over `fieldRef`,
	 *  itself a stable prop) so `setWindowRef` never needs to re-attach it
	 *  just because THIS component re-rendered. */
	const onWindowWheelRef = useRef((e: WheelEvent) => {
		e.preventDefault();
		const pending = pendingWheelRef.current;
		pending.x += e.deltaX;
		pending.y += e.deltaY;
		if (pending.scheduled) return;
		pending.scheduled = true;
		window.requestAnimationFrame(() => {
			pending.scheduled = false;
			const view = fieldRef.current?.getView();
			if (view) {
				// One atomic `scrollTo` rather than two separate
				// `scrollTop`/`scrollLeft` property writes — each of those can
				// independently trigger its own scroll/reflow pass, so a
				// diagonal gesture (any wheel input carries some `deltaX` even
				// during an intentionally vertical scroll) paid for two passes
				// every frame instead of one. `behavior: 'instant'` pins this
				// to a plain jump regardless of any `scroll-behavior: smooth`
				// CSS an ancestor might carry (none does today, but the CSSOM
				// View spec lets an explicit `behavior` here always win over
				// it, so this stays correct if that ever changes) — a
				// programmatic `scrollTop =`/`scrollBy` write is exactly the
				// kind of "scrolling operation" `scroll-behavior: smooth`
				// applies to, and re-triggering a CSS-eased scroll on every
				// single animation frame is a textbook way to produce a
				// stepped/interrupted glide instead of a continuous one.
				view.scrollDOM.scrollTo({
					top: view.scrollDOM.scrollTop + pending.y,
					left: view.scrollDOM.scrollLeft + pending.x,
					behavior: 'instant',
				});
			}
			pending.x = 0;
			pending.y = 0;
		});
	});
	/** The overlay's window div is `position: fixed` and portalled to
	 *  `document.body` — a completely separate DOM subtree from the real
	 *  editor, so a native wheel event over a card (or its nested body
	 *  field) has no bubbling path to the real scrollable element at all; the
	 *  browser either does nothing (reading as "scroll is blocked" the
	 *  moment the cursor is anywhere over a card) or, worse, scrolls
	 *  whatever accidentally-scrollable ancestor `document.body` itself has.
	 *  A real native listener attached directly to the window div — reached
	 *  via bubbling from any card inside it, `pointer-events: none` on the
	 *  window itself only blocks it from being an event TARGET, not from
	 *  receiving bubbled events from its own auto-pointer-events children —
	 *  manually applies the delta to `view.scrollDOM` instead. A plain
	 *  callback ref rather than a `useEffect`, since the window div mounts
	 *  and unmounts freely (`clipWindow` going null/non-null) and a callback
	 *  ref is exactly React's own tool for "do something the instant this
	 *  specific node exists." */
	const setWindowRef = useCallback((el: HTMLDivElement | null) => {
		if (windowElRef.current) windowElRef.current.removeEventListener('wheel', onWindowWheelRef.current);
		windowElRef.current = el;
		if (el) el.addEventListener('wheel', onWindowWheelRef.current, { passive: false });
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		return () => {
			destroyedRef.current = true;
		};
	}, []);

	// Measures each card's own header height and its nested body's natural
	// content height right after `rects` commits to the DOM, and reports any
	// shortfall (content taller than the space the card's real document span
	// currently allocates for the body) to the caller via
	// `onSpacerNeedsChange` — see this file's own top doc comment ("A
	// branch's card can be genuinely TALLER...") for the full mechanism.
	// `useLayoutEffect`, not `useEffect`: it needs to read real layout
	// (`getBoundingClientRect`/`scrollHeight`, both plain DOM reads, never
	// CM6's own `coordsAtPos`/`posAtCoords` measurement cache) synchronously
	// after the DOM updates, which is exactly what `useLayoutEffect`
	// guarantees and `useEffect` doesn't.
	useLayoutEffect(() => {
		if (!onSpacerNeedsChange) return;
		const prevSpacers = lastReportedSpacersRef.current;
		const next: Record<string, number> = {};
		for (const r of rects) {
			const headerEl = headerElsRef.current.get(r.sectionId);
			const bodyHandle = bodyHandlesRef.current.get(r.sectionId);
			if (!headerEl || !bodyHandle) continue;
			if (r.estimated) {
				// `r.height` came from CM6's own estimated line-height map
				// (`BranchCardRect.estimated`'s own doc comment) — a
				// virtualized/off-screen line's height never grows to
				// reflect this branch's own applied `padding-bottom` spacer,
				// so subtracting a "current spacer" back out of it below
				// would measure an ever-growing shortfall against a height
				// that can never catch up: this was a real, confirmed
				// runaway-growth bug (spacer climbing without bound, once
				// per `sync()`, for every branch scrolled out of view).
				// Leave whatever spacer this branch already has untouched
				// until it's actually rendered/measured again.
				const carried = prevSpacers[r.sectionId];
				if (carried !== undefined) next[r.sectionId] = carried;
				continue;
			}
			const headerHeight = headerEl.getBoundingClientRect().height;
			const footerHeight = footerElsRef.current.get(r.sectionId)?.getBoundingClientRect().height ?? 0;
			// `r.height` already reflects whatever spacer is CURRENTLY applied
			// (the real document already carries that `padding-bottom` on this
			// branch's `= branch:` line) — subtracting it back out gives the
			// NATURAL, unpadded span every time, so `extra` always measures
			// against the same fixed baseline regardless of how much padding
			// is already applied. This is load-bearing, not a nicety: computing
			// against the padded span directly has no fixed point (fixing a
			// shortfall grows `r.height`, which makes the fix measure as
			// unnecessary, which removes it, which recreates the shortfall) —
			// don't simplify this back to `r.height - headerHeight - footerHeight`.
			// Only trustworthy for a REAL (non-`estimated`) measurement — see
			// the `r.estimated` branch above.
			const currentSpacer = prevSpacers[r.sectionId] ?? 0;
			const naturalHeight = r.height - currentSpacer;
			const available = naturalHeight - headerHeight - footerHeight;
			const contentHeight = bodyHandle.getContentHeight();
			const extra = Math.ceil(contentHeight - available);
			if (extra > 1) next[r.sectionId] = extra;
		}
		const prevKeys = Object.keys(prevSpacers);
		const nextKeys = Object.keys(next);
		const changed =
			prevKeys.length !== nextKeys.length ||
			nextKeys.some((k) => Math.abs((prevSpacers[k] ?? 0) - next[k]) > 1);
		if (changed) {
			lastReportedSpacersRef.current = next;
			onSpacerNeedsChange(next);
		}
	}, [rects, onSpacerNeedsChange]);

	useEffect(() => {
		const sync = () => {
			if (destroyedRef.current) return;
			const view = fieldRef.current?.getView();
			const wrap = wrapRef.current;
			if (!view || !wrap || !view.dom.isConnected) {
				setRects([]);
				setDraftRects([]);
				setClipWindow(null);
				setObscureRect(null);
				return;
			}
			// A hidden background tab (`offsetParent` goes `null`) clears the
			// overlay entirely rather than just skipping the recompute:
			// `AnnotationHandlesOverlay` (fountain-field.tsx) can leave its own
			// stale spans in place when its editor is hidden, since those spans
			// scroll away with the (hidden) editor's own DOM — but this overlay
			// is `position: fixed` and portalled to `document.body`, entirely
			// independent of the source tab's own visibility, so stale cards
			// would otherwise keep floating at their last screen coordinates
			// over whatever OTHER file/tab is now active. Switching back
			// re-triggers a real `ResizeObserver` firing (the tab's own DOM goes
			// from a 0-size `display: none` box back to its real size), which
			// schedules a fresh `sync()` that recomputes and shows the cards
			// again.
			if (view.dom.offsetParent === null) {
				setRects([]);
				setDraftRects([]);
				setClipWindow(null);
				setObscureRect(null);
				return;
			}

			const parsed = parseFountain(text);
			const groupIds = new Set<string>();
			for (const sec of parsed.sections) {
				if (sec.branchGroup !== null && sec.loomId !== null) groupIds.add(sec.branchGroup);
			}

			// `wrap` (`.loom-scene-script`) is the full-width shell — the nav
			// panel/comments/alt-text asides all share it as siblings — but the
			// actual Fountain text renders in a centered, `max-width: 6in`
			// column (`.loom-fountain-field .cm-content`, styles.css) narrower
			// than that shell. `view.contentDOM` IS that column, so its own rect
			// is what a card's own left/width need to match — a card only
			// covers the real text, never the wider shell around it, so the
			// pointer-events-none clip window (below) leaves the margins on
			// either side free for the mouse to keep scrolling the editor
			// normally, and a card's own nested `FountainField` gets exactly
			// the same available width the real editor's `.cm-content` does.
			const contentRect = view.contentDOM.getBoundingClientRect();
			// The clip boundary every card is trimmed against, separately from
			// sizing — walks every scrollable ancestor (see `visibleClipRect`'s
			// own doc comment for why a single known container, `wrap` then
			// `view.scrollDOM`, still wasn't enough: `getBoundingClientRect`
			// never accounts for ANCESTOR clipping, so scrolling an outer
			// container Obsidian owns — not `.loom-scene-script`'s own internal
			// scroll — still let cards overlap the Scene page's heading fields,
			// Notes, even its own tab bar).
			const clipRect = visibleClipRect(view.scrollDOM);
			if (clipRect.bottom <= clipRect.top || clipRect.right <= clipRect.left) {
				setRects([]);
				setDraftRects([]);
				setClipWindow(null);
				setObscureRect(null);
				return;
			}
			// `view.lineBlockAt(pos).top` reads CM6's own persistent internal
			// height map — unlike `coordsAtPos`, it never depends on whether
			// `pos` currently falls inside CM6's actually-rendered viewport
			// window (a real, reported bug: a branch group far from the current
			// scroll position sat in CM6's own unrendered "gap," where
			// `coordsAtPos` returns `null` outright, so it had NO card at all
			// until the user scrolled close enough for CM6 to render/measure
			// that stretch — real underlying text visible, uncovered, until a
			// late, misaligned "snap"). Its own coordinate space is
			// document-relative (as if `scrollTop` were 0), which is already
			// the target space `r.top` needs — EXCEPT `clipRect` can be
			// narrower than `view.scrollDOM`'s own true bounding box (ancestor
			// clipping, see `clipRect`'s own doc comment above), so a fixed
			// per-sync correction re-aligns the two coordinate spaces once,
			// rather than re-deriving it per branch.
			const docCorrection = view.scrollDOM.getBoundingClientRect().top - clipRect.top;

			// Whichever of the nav/comments/alt-text side panels is currently
			// open (all three share `.loom-script-nav-sticky`, always a direct
			// child of `wrap` anchored at its own top-left — see this state's
			// own doc comment for why it needs excluding at all) — measured
			// fresh each sync rather than assumed a fixed size, since the panel
			// grows from a bare toggle button to a full list once opened.
			// `.loom-script-nav-sticky` ITSELF is a zero-height sticky wrapper
			// (styles.css) — its real visible content (the toggle button, and
			// the `<aside>` panel once open) are `position: absolute` children
			// escaping that zero-height box, so it's THOSE that need
			// measuring, not the wrapper (whose own rect always reports
			// `bottom === top`).
			const windowWidth = clipRect.right - clipRect.left;
			const windowHeight = clipRect.bottom - clipRect.top;
			let obscureRight = 0;
			let obscureBottom = 0;
			for (const panelEl of wrap.querySelectorAll<HTMLElement>('.loom-script-nav-toggle, .loom-script-nav')) {
				const panelRect = panelEl.getBoundingClientRect();
				obscureRight = Math.max(obscureRight, Math.min(windowWidth, panelRect.right - clipRect.left));
				obscureBottom = Math.max(obscureBottom, Math.min(windowHeight, panelRect.bottom - clipRect.top));
			}
			setClipWindow({ top: clipRect.top, left: clipRect.left, width: windowWidth, height: windowHeight });
			setObscureRect(obscureRight > 0 && obscureBottom > 0 ? { right: obscureRight, bottom: obscureBottom } : null);
			// The scrollTop this whole sync pass's geometry is computed against —
			// every `top` value below bakes this back in (`screenTop + scrollTop`)
			// so it reads as "where this card sits if scrollTop were 0," a value
			// that stays valid regardless of how `scrollTop` changes afterward.
			// `applyTrackTransform` (below) is what converts it back to a real
			// screen position, applied directly to `trackRef` on every scroll
			// tick — see this file's own top doc comment for the full reasoning.
			const scrollTop = view.scrollDOM.scrollTop;
			const docLen = view.state.doc.length;
			const docLines = view.state.doc.lines;

			/** `coordsAtPos` first, `lineBlockAt` only as a fallback for a
			 *  position `coordsAtPos` can't measure at all (genuinely
			 *  off-screen/virtualized content — see `docCorrection`'s own doc
			 *  comment above for why that fallback exists). `coordsAtPos`
			 *  calls `readMeasured()`, forcing CM6 to finish any pending
			 *  layout work before returning — load-bearing for the spacer
			 *  feedback loop (`onSpacerNeedsChange` above), which measures
			 *  `r.height` right after inserting a spacer to see if more room
			 *  is still needed: an estimate that hasn't caught up with that
			 *  very edit yet reads as "still short," requests more, and never
			 *  converges. **The `lineBlockAt` fallback path is NOT confined to
			 *  the currently-visible branch** — every branch gets a rect
			 *  unconditionally (this file's own `sync()` doc comment), so a
			 *  branch scrolled out of view routes through here on every sync,
			 *  and its `padding-bottom` spacer (only ever actually laid out
			 *  for rendered, non-virtualized lines) never moves this estimate
			 *  no matter how large the spacer grows — an earlier version of
			 *  this comment assumed otherwise and was wrong; that wrong
			 *  assumption is what let the spacer effect's runaway-growth bug
			 *  ship (see `BranchCardRect.estimated`'s own doc comment for the
			 *  fix). Both functions report whether they took this path so the
			 *  caller can react. */
			const docTop = (pos: number): { value: number; estimated: boolean } => {
				const coords = view.coordsAtPos(pos, 1);
				return coords
					? { value: coords.top - clipRect.top + scrollTop, estimated: false }
					: { value: view.lineBlockAt(pos).top + docCorrection, estimated: true };
			};
			const docBottom = (pos: number): { value: number; estimated: boolean } => {
				const coords = view.coordsAtPos(pos, -1);
				return coords
					? { value: coords.bottom - clipRect.top + scrollTop, estimated: false }
					: { value: view.lineBlockAt(pos).bottom + docCorrection, estimated: true };
			};

			/** The document-relative top of 0-based line `line0`'s own start —
			 *  the shared primitive behind a draft's own anchor `top`. Goes
			 *  through `docTop` (see its own doc comment just above) for the
			 *  `coordsAtPos`-first/`lineBlockAt`-fallback behavior. `null` on
			 *  any measurement failure (out of range) rather than throwing —
			 *  every caller already treats a `null` result as "skip this one,
			 *  try again next sync." */
			const topOfLine = (line0: number): number | null => {
				try {
					const fromLine = Math.min(Math.max(line0, 0) + 1, docLines);
					const fromPos = view.state.doc.line(fromLine).from;
					return docTop(fromPos).value;
				} catch (e) {
					console.error('Loom Loom: branch overlay could not read layout this frame', e);
					return null;
				}
			};

			// The card's own OUTER box is deliberately WIDER than the real text
			// column (`CARD_WIDEN_FACTOR`) — a card whose border sits flush
			// against the text on both sides reads as cramped, with no
			// breathing room around the panel's own header/gather rows. The
			// text column itself (`contentWidth`) is kept at its own true,
			// unwidened value and centered within the wider card —
			// `BranchBodyField` applies it as an explicit pixel width on its
			// own inner wrapper, an exact number carried straight from this
			// measurement rather than reconstructed via CSS `max-width`
			// matching on the nested field's own side.
			const contentWidth = contentRect.width;
			const width = contentWidth * CARD_WIDEN_FACTOR;
			const left = contentRect.left - clipRect.left - (width - contentWidth) / 2;
			// Every branch group in the document gets a rect, unconditionally —
			// never gated on proximity to the current scroll position, so a
			// branch always shows its panel rather than its own raw underlying
			// text before the user scrolls close to it. The fixed clip window's
			// `overflow: hidden` keeps every off-screen card invisible without
			// needing to skip mounting it.

			const next: BranchCardRect[] = [];
			for (const groupId of groupIds) {
				const bounds = branchGroupBounds(parsed, groupId);
				if (!bounds) continue;
				bounds.branches.forEach((sec: ParsedSection & { loomId: string }, i: number) => {
					const spanEnd = i + 1 < bounds.branches.length ? bounds.branches[i + 1].line : bounds.end;
					const fromLine = Math.min(sec.line + 1, docLines);
					let top: number | null = null;
					let bottom: number | null = null;
					let estimated = false;
					try {
						const fromPos = view.state.doc.line(fromLine).from;
						// `spanEnd` (0-indexed, exclusive) needs the same +1 as
						// `fromLine` to become a CM6 line number — EXCEPT when
						// it points one past the very last line in the text
						// (a real, reported bug: a group's `= gather` landing
						// as the literal last line of the Scene's own excerpt,
						// with no trailing blank line after it, has no "line
						// spanEnd+1" to find the start of — `doc.line()` on an
						// out-of-range number throws, and the fallback used to
						// silently clamp one line SHORT, excluding gather from
						// the box entirely). `doc.length` (the raw end-of-
						// document character offset) is always valid and
						// exactly what's wanted here regardless.
						const toPos = spanEnd >= docLines ? docLen : view.state.doc.line(spanEnd + 1).from;
						const topResult = docTop(fromPos);
						const bottomResult = docBottom(Math.max(toPos - 1, fromPos));
						top = topResult.value;
						bottom = bottomResult.value;
						estimated = topResult.estimated || bottomResult.estimated;
					} catch (e) {
						console.error('Loom Loom: branch overlay could not read layout this frame', e);
					}
					if (top === null || bottom === null || bottom <= top) return;
					// Real (unclamped) boundary-vs-window check, purely for
					// border/radius decisions — see `BranchCardRect.topClamped`'s
					// own doc comment. Positioning itself never clamps any more;
					// the fixed clip window's `overflow: hidden` does that
					// visually, so a card scrolled fully out of the visible clip
					// area still scrolls back into view for free (the shared
					// `trackRef` transform, not a recompute) the moment it's
					// scrolled back to. Both `top`/`bottom` are already in the
					// "as if scrollTop were 0" space `docCorrection` produces, so
					// the window's own visible band in that SAME space is simply
					// `[scrollTop, scrollTop + windowHeight]`.
					const topClamped = top < scrollTop;
					const bottomClamped = bottom > scrollTop + windowHeight;
					next.push({
						sectionId: sec.loomId,
						groupId,
						title: sec.text,
						body: branchBodyText(text, sec.loomId) ?? '',
						top,
						height: bottom - top,
						left,
						width,
						contentWidth,
						contentMargin: (width - contentWidth) / 2,
						topClamped,
						bottomClamped,
						estimated,
						position:
							bounds.branches.length === 1
								? 'only'
								: i === 0
									? 'first'
									: i === bounds.branches.length - 1
										? 'last'
										: 'middle',
					});
				});
			}
			setRects(next);

			const nextDrafts: DraftCardRect[] = [];
			for (const draft of drafts) {
				let line0: number | null = null;
				const anchorLine = fieldRef.current?.getDraftAnchorLine(draft.id) ?? null;
				if (anchorLine !== null) line0 = anchorLine + 1;
				if (line0 === null) continue;
				const top = topOfLine(line0);
				if (top === null) continue;
				nextDrafts.push({ draftId: draft.id, top, left, width });
			}
			setDraftRects(nextDrafts);
			applyTrackTransform();
		};

		/** The cheap half of the split: reads the CURRENT scroll position
		 *  directly and writes it straight to `trackRef`'s own `transform`,
		 *  bypassing React/state entirely — the one thing that has to track a
		 *  fast scroll gesture with zero perceptible lag. Never calls
		 *  `coordsAtPos`/reads layout, so it's safe to run on every native
		 *  `scroll` event with no debouncing at all.
		 *
		 *  Also calls CM6's own `repositionTooltips` on the FOCUSED branch
		 *  body's own `EditorView`, if any — a nested field never scrolls
		 *  NATIVELY (its own `scrollDOM.scrollTop` never changes; the whole
		 *  card moves via this very `transform`, entirely outside that
		 *  field's own knowledge), so CM6 has no other way to learn that its
		 *  own autocomplete popup's anchor position just moved on screen.
		 *  Without this, an open popup freezes at wherever it first appeared
		 *  instead of tracking the branch's own scroll the way the popup in
		 *  an ordinary (natively-scrolling) `FountainField` already does.
		 *  **Scoped to the one focused field, not every mounted card**: only
		 *  a focused `EditorView` can possibly have an open tooltip/
		 *  completion popup to begin with, and this runs on EVERY native
		 *  `scroll` tick (plus, while the cursor sits over a card, on every
		 *  wheel-forwarded scrollTop write too — see `onWindowWheelRef`) —
		 *  looping every mounted body unconditionally added real main-thread
		 *  work to the one path that has to stay cheap enough for zero
		 *  perceptible lag, confirmed as a real contributor to a "scrolling
		 *  feels floaty/steppy on a card vs. buttery over the real editor"
		 *  report: hovering a card runs BOTH this listener (via the scrollTop
		 *  write it triggers) AND the wheel handler's own per-frame work,
		 *  doubling the per-tick cost right where it was already highest.
		 *  `hasFocus` is a plain property read, no layout involved. Wrapped
		 *  in try/catch as a backstop, matching every other CM6-layout-
		 *  touching call in this codebase — `repositionTooltips` reads real
		 *  layout, and this runs from a plain native `scroll` listener,
		 *  outside CM6's own update cycle, which is the safe case, but
		 *  there's no reason not to be defensive here too. */
		const applyTrackTransform = () => {
			const view = fieldRef.current?.getView();
			const track = trackRef.current;
			if (!view || !track) return;
			track.style.transform = `translateY(${-view.scrollDOM.scrollTop}px)`;
			for (const handle of bodyHandlesRef.current.values()) {
				const bodyView = handle.getView();
				if (!bodyView || !bodyView.hasFocus) continue;
				try {
					repositionTooltips(bodyView);
				} catch (e) {
					console.error('Loom Loom: branch body field could not reposition its own tooltip', e);
				}
				break;
			}
		};

		const scheduleSync = () => {
			if (syncQueuedRef.current) return;
			syncQueuedRef.current = true;
			window.setTimeout(() => {
				syncQueuedRef.current = false;
				sync();
			}, 0);
		};

		scheduleSync();
		const wrap = wrapRef.current;
		const ro = new ResizeObserver(scheduleSync);
		// Observing `wrap` alone only catches `wrap`'s OWN border-box size
		// changing — it says nothing about `wrap` MOVING because something
		// ABOVE it in normal document flow (the Scene heading fields, Notes,
		// the Act section, "Entities in the scene") changed height after its
		// own async content settled. Walking every ancestor up to
		// `document.body` (mirroring `visibleClipRect`'s own "don't assume a
		// single known container" pattern just above in this file) was tried
		// first and is KEPT here as cheap defensive coverage, but it cannot
		// be the real fix: `.loom-entity` (styles.css) — the actual
		// scrolling container every one of these fields lives inside — is
		// `flex: 1` in a fixed-height flex row with `overflow-y: auto`. Its
		// own border-box size is fixed by the flex layout regardless of how
		// much content it holds; a field growing taller inside it only grows
		// its `scrollHeight`, which `ResizeObserver` does not report at all —
		// no ancestor's box ever changes size, so no amount of walking
		// higher up the tree was ever going to catch this specific,
		// confirmed cause (a real, reported first-load bug: boxes rendered
		// correctly for an instant, then the Notes field above finished
		// laying out past its first line and silently pushed everything
		// below — Script included — down by exactly that much, with no
		// scroll, no ancestor resize, and no CM6-internal geometry change
		// for `geometryVersion` to catch either).
		if (wrap) {
			let el: HTMLElement | null = wrap;
			while (el && el !== document.body) {
				ro.observe(el);
				el = el.parentElement;
			}
		}
		// The actual fix: a `MutationObserver` on `.loom-entity` itself
		// (found via `closest`, falling back to `document.body` if the
		// class ever changes) reacts to the DOM change directly — Notes
		// gaining a second line means its own field inserts a new line
		// element into that subtree, a `childList` mutation, regardless of
		// whether any element's measured SIZE changed as a result. Scoped to
		// `.loom-entity` rather than `document.body` so this doesn't fire on
		// every unrelated DOM mutation elsewhere in the Obsidian window —
		// still cheap even if it did (`scheduleSync` coalesces to at most
		// one resync per macrotask), but there's no reason to cast wider
		// than the one scrollable region that can actually move `wrap`.
		const mutationRoot = wrap?.closest<HTMLElement>('.loom-entity') ?? document.body;
		const mo = new MutationObserver(scheduleSync);
		mo.observe(mutationRoot, { childList: true, subtree: true });
		// `FountainField` is rendered before this component in the Scene
		// section's JSX, so its own mount effect (which sets `viewRef.current`)
		// has already run by the time this effect runs — React runs sibling
		// mount effects in render order, so `getView()` here is never null on
		// a genuine first mount, only ever transiently null while the field is
		// tearing down/remounting (e.g. a Script/Pages/Outline mode switch).
		const view = fieldRef.current?.getView();
		// A SEPARATE observer on the CM6 content itself — the wrap's own
		// OUTER size can stay perfectly stable while the text reflows
		// internally (e.g. web fonts finishing loading after first paint),
		// which `wrap`'s own ResizeObserver above has no way to see.
		if (view) ro.observe(view.contentDOM);
		// The un-debounced half of the split (see this file's own top doc
		// comment): applies the live scroll position directly to `trackRef` on
		// EVERY tick, no coalescing — cheap enough (one DOM write) that it
		// never needs to be. `scheduleSync` (the expensive, debounced pass)
		// stays registered too, as an occasional correction — it re-confirms
		// the actual line coordinates once scrolling settles, in case anything
		// genuinely shifted (a concurrent edit elsewhere, a reflow) rather than
		// just scrolled.
		view?.scrollDOM.addEventListener('scroll', applyTrackTransform, { passive: true });
		view?.scrollDOM.addEventListener('scroll', scheduleSync);
		// Obsidian's own outer page scroll, same capture-phase listener
		// `AnnotationHandlesOverlay`'s `onAnyScroll` already uses.
		document.addEventListener('scroll', scheduleSync, true);
		// The pass-through activation trigger (`enablePassThrough`'s own doc
		// comment) — CAPTURE phase specifically, so this sees every wheel
		// event within the panel's own screen area regardless of what its
		// actual target ends up being: while a card is still `auto`
		// (pointer-events), the event targets the card and would also reach
		// `onWindowWheelRef` via bubbling, but once pass-through is active
		// the event's real target is the real editor (or whatever else is
		// under it), OUTSIDE this component's whole portalled subtree — a
		// bubble-phase listener anywhere in this file would never see it,
		// only a capture-phase one on a shared ancestor (`document`) does.
		// `{ passive: true }`: this listener only ever reads
		// `clientX`/`clientY` and toggles a class — it must never call
		// `preventDefault`, or it would block the real editor's own native
		// scroll on every tick pass-through exists to let through untouched.
		const onDocumentWheel = (e: WheelEvent) => {
			const windowEl = windowElRef.current;
			if (!windowEl) return;
			const rect = windowEl.getBoundingClientRect();
			if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
				return;
			}
			enablePassThrough();
			schedulePassThroughIdle();
		};
		document.addEventListener('wheel', onDocumentWheel, { capture: true, passive: true });
		// Kept as cheap, harmless defensive redundancy on top of the
		// ancestor-chain ResizeObserver above (each `scheduleSync()` call is
		// idempotent — coalesced, and a no-op re-measure if nothing actually
		// changed) — not the primary fix for the first-load offset any more.
		void document.fonts?.ready?.then(() => {
			if (!destroyedRef.current) scheduleSync();
		});
		const retryTimers = [100, 500].map((ms) => window.setTimeout(scheduleSync, ms));
		return () => {
			ro.disconnect();
			mo.disconnect();
			view?.scrollDOM.removeEventListener('scroll', applyTrackTransform);
			view?.scrollDOM.removeEventListener('scroll', scheduleSync);
			document.removeEventListener('scroll', scheduleSync, true);
			document.removeEventListener('wheel', onDocumentWheel, true);
			if (passThroughIdleTimerRef.current !== null) window.clearTimeout(passThroughIdleTimerRef.current);
			disablePassThrough();
			retryTimers.forEach((id) => window.clearTimeout(id));
		};
	}, [text, fieldRef, wrapRef, geometryVersion, drafts]);

	if (!clipWindow || (rects.length === 0 && draftRects.length === 0)) return null;

	const lastByGroup = new Map<string, BranchCardRect>();
	for (const r of rects) {
		if (r.position === 'last' || r.position === 'only') lastByGroup.set(r.groupId, r);
	}

	return createPortal(
		// The fixed "window": `overflow: hidden` sized to `clipWindow`
		// (`visibleClipRect(view.scrollDOM)`) is what gives every card genuine
		// CSS clipping at its edges — see this file's own top doc comment.
		// `pointer-events: none` here, re-enabled per-card below, so the
		// window itself never intercepts a click landing in the gap between
		// cards (there usually isn't one, but it costs nothing to be correct).
		<div
			className="loom-branch-window"
			style={{
				top: clipWindow.top,
				left: clipWindow.left,
				width: clipWindow.width,
				height: clipWindow.height,
				// Punches a real hole over the Scene page's own nav/comments/
				// alt-text side panel — see `obscureRect`'s own doc comment for
				// why a CSS exclusion, not a z-index change, is what's needed
				// here. An "L" tracing clockwise around the excluded top-left
				// rectangle; omitted entirely (full window, no hole) when no
				// such panel is currently open.
				clipPath: obscureRect
					? `polygon(${obscureRect.right}px 0, 100% 0, 100% 100%, 0 100%, 0 ${obscureRect.bottom}px, ${obscureRect.right}px ${obscureRect.bottom}px)`
					: undefined,
			}}
			ref={setWindowRef}
		>
			{/* The scroll-tracking div: `applyTrackTransform` (in the effect
			    above) writes this element's `transform` directly on every
			    native scroll tick, bypassing React — the only thing that has
			    to move in real time to stay in sync with the editor's own
			    scroll. */}
			<div className="loom-branch-track" ref={trackRef}>
			{renderRealCards && rects.map((r) => {
				// The group's true top/bottom (first/only and last/only,
				// respectively) get the plain panel radius + a real border —
				// but ONLY when that edge isn't itself clamped by the visible
				// clip (see `BranchCardRect.topClamped`/`bottomClamped`'s own
				// doc comment: a clamped edge means the branch's REAL boundary
				// is off-screen, so drawing a closed rounded corner right at
				// the clip line would misleadingly claim that's where the
				// branch actually ends). An internal joint (a 'middle' card's
				// both edges, or 'first'/'last' card's OTHER edge) never gets a
				// border — it's not a real boundary — but still gets the
				// larger joint radius when genuinely unclamped, reading as one
				// continuous connected group.
				const isTopBoundary = r.position === 'only' || r.position === 'first';
				const isBottomBoundary = r.position === 'only' || r.position === 'last';
				const topRadius = r.topClamped ? '0' : isTopBoundary ? 'var(--radius-m)' : 'var(--loom-branch-joint-radius)';
				const bottomRadius = r.bottomClamped
					? '0'
					: isBottomBoundary
						? 'var(--radius-m)'
						: 'var(--loom-branch-joint-radius)';
				// A 'middle'/'last' card's own top edge is a real seam between
				// two branches (a joint radius, never the group's own rounded
				// corner) and gets a divider too, matching every other section
				// transition in this card (the gather row's own `border-top`) —
				// only a clamped edge (the branch's real boundary is off-screen)
				// suppresses it, same as the group's outer edges above.
				const showTopBorder = !r.topClamped;
				const showBottomBorder = isBottomBoundary && !r.bottomClamped;
				const isLastOfGroup = lastByGroup.get(r.groupId)?.sectionId === r.sectionId;
				return (
					<div
						key={r.sectionId}
						className="loom-branch-card"
						style={{
							top: r.top,
							left: r.left,
							width: r.width,
							height: r.height,
							borderTopLeftRadius: topRadius,
							borderTopRightRadius: topRadius,
							borderBottomLeftRadius: bottomRadius,
							borderBottomRightRadius: bottomRadius,
							borderTopStyle: showTopBorder ? 'dashed' : 'none',
							borderBottomStyle: showBottomBorder ? 'dashed' : 'none',
						}}
						data-loom-branch-group={r.groupId}
						onContextMenu={(e) => {
							// Only reached for a right-click on the card's own
							// chrome (header, margins) — a click landing inside
							// the nested body never bubbles this far, stopped at
							// `fountain-field.tsx`'s own `openContextMenu` (see
							// this file's own top doc comment).
							e.preventDefault();
							const menu = new Menu();
							menu.addItem((item) =>
								item
									.setTitle(t('view.script.contextMenu.cutBranchGroup'))
									.setIcon('scissors')
									.onClick(() => onCutBranchGroup(r.groupId))
							);
							menu.addItem((item) =>
								item
									.setTitle(t('view.script.contextMenu.copyBranchGroup'))
									.setIcon('copy')
									.onClick(() => onCopyBranchGroup(r.groupId))
							);
							menu.showAtMouseEvent(e.nativeEvent);
						}}
					>
						<div
							className="loom-branch-card-header"
							style={{ paddingLeft: r.contentMargin }}
							ref={(el) => {
								if (el) headerElsRef.current.set(r.sectionId, el);
								else headerElsRef.current.delete(r.sectionId);
							}}
						>
							<div className="loom-branch-label-row">
								<span className="loom-branch-label loom-branch-label-section">###</span>
								<BranchTitleField
									key={`title-${r.sectionId}`}
									value={r.title}
									onCommit={(v) => onRenameBranchTitle(r.sectionId, v)}
									onDraftChange={(v) => setLiveTitleOverrides((prev) => ({ ...prev, [r.sectionId]: v }))}
									autoFocusEmpty={r.sectionId === pendingTitleFocusId}
									onAutoFocusConsumed={onTitleFocusConsumed}
								/>
								<button
									type="button"
									className="clickable-icon loom-branch-delete-btn"
									aria-label={t('view.script.branch.deleteBranchAria')}
									onClick={() => onDeleteBranch(r.sectionId)}
								>
									<Icon name="trash-2" />
								</button>
							</div>
							<div className="loom-branch-label-row">
								<span className="loom-branch-label loom-branch-label-synopsis">= branch:</span>
								<BranchComboFields
									key={`combo-${r.groupId}`}
									value={r.groupId}
									readOnly={!isTopBoundary}
									onCommitCombo={(identifier, sub, num) => onSetBranchCombo(r.groupId, identifier, sub, num)}
									onCommitRaw={(v) => onSetBranchRaw(r.groupId, v)}
								/>
							</div>
							<div className="loom-branch-title-preview">
								&gt;
								<span className="loom-branch-title-preview-bold">
									**{liveTitleOverrides[r.sectionId] ?? r.title}**
								</span>
								&lt;
							</div>
						</div>
						<BranchBodyField
							key={`body-${r.sectionId}`}
							ref={(h) => {
								if (h) bodyHandlesRef.current.set(r.sectionId, h);
								else bodyHandlesRef.current.delete(r.sectionId);
							}}
							value={r.body}
							onCommit={(v) => onSetBranchBody(r.sectionId, v)}
							contentWidth={r.contentWidth}
							characters={characters}
							entityOptions={entityOptions}
							ambientSuggestDismissMs={ambientSuggestDismissMs}
							groupId={r.groupId}
							onCutBranchGroup={onCutBranchGroup}
							onCopyBranchGroup={onCopyBranchGroup}
						/>
						{isLastOfGroup ? (
							<div
								className="loom-branch-gather-row"
								style={{ paddingLeft: r.contentMargin }}
								ref={(el) => {
									if (el) footerElsRef.current.set(r.sectionId, el);
									else footerElsRef.current.delete(r.sectionId);
								}}
							>
								<span className="loom-branch-gather-label">= gather</span>
								<button
									type="button"
									className="loom-branch-add-btn"
									aria-label={t('view.script.branch.addBranchAria')}
									onClick={() => onAddBranch(r.groupId)}
								>
									+
								</button>
							</div>
						) : null}
					</div>
				);
			})}
			{draftRects.map((dr) => {
				const draft = drafts.find((d) => d.id === dr.draftId);
				if (!draft) return null;
				const identifier = draft.identifier.trim();
				const subidentifier = draft.subidentifier.trim();
				// Live preview of the number `insertBranch` will actually pick
				// if the Number field is left blank — matches
				// `handleCommitBranchDraft`'s (entity-view.tsx) own computation
				// exactly (same `branchComboKey`/`nextComboNumber` call, same
				// "-1" probe suffix — `nextComboNumber` only cares about the
				// identifier/subidentifier prefix, the trailing segment is
				// discarded), just run here too, read-only, for display. Only
				// meaningful once BOTH identifier and subidentifier are
				// filled — `branchComboKey` needs all 3 non-empty segments to
				// return anything, so an incomplete combo falls back to the
				// static "auto" hint below.
				const numberPreview =
					identifier !== '' && subidentifier !== ''
						? nextComboNumber(parsedForPreview, branchComboKey(`${identifier}-${subidentifier}-1`))
						: null;
				const ready = draft.title.trim() !== '' && identifier !== '' && subidentifier !== '';
				return (
					<div
						key={dr.draftId}
						className="loom-branch-card loom-branch-card-draft"
						style={{ top: dr.top, left: dr.left, width: dr.width, height: 'auto' }}
						ref={(el) => {
							if (el) draftElsRef.current.set(draft.id, el);
							else draftElsRef.current.delete(draft.id);
						}}
						onKeyDown={(e) => {
							if (e.key === 'Escape') onDismissDraft(draft.id);
						}}
					>
						<div className="loom-branch-card-header">
							<div className="loom-branch-label-row">
								<input
									type="text"
									className="loom-branch-input loom-branch-title-input"
									placeholder={t('view.script.branch.titlePlaceholder')}
									value={draft.title}
									autoFocus
									onChange={(e) => onDraftField(draft.id, { title: e.target.value })}
								/>
								<button
									type="button"
									className="clickable-icon loom-branch-draft-dismiss"
									aria-label={t('common.remove')}
									onClick={() => onDismissDraft(draft.id)}
								>
									✕
								</button>
							</div>
							<div className="loom-branch-combo-row">
								<input
									type="text"
									className="loom-branch-input"
									placeholder={t('view.script.branch.identifierPlaceholder')}
									value={draft.identifier}
									onChange={(e) => onDraftField(draft.id, { identifier: e.target.value })}
								/>
								<input
									type="text"
									className="loom-branch-input"
									placeholder={t('view.script.branch.subidentifierPlaceholder')}
									value={draft.subidentifier}
									onChange={(e) => onDraftField(draft.id, { subidentifier: e.target.value })}
								/>
								<input
									type="text"
									className="loom-branch-input loom-branch-number-input"
									placeholder={
										numberPreview !== null ? String(numberPreview) : t('view.script.branch.numberPlaceholder')
									}
									value={draft.numberOverride}
									onChange={(e) => onDraftField(draft.id, { numberOverride: e.target.value })}
								/>
							</div>
							<div className="loom-branch-draft-actions">
								<button
									type="button"
									className="mod-cta loom-branch-create-btn"
									disabled={!ready}
									onClick={() => onCreateDraft(draft.id)}
								>
									{t('view.script.branch.createButton')}
								</button>
							</div>
						</div>
					</div>
				);
			})}
			</div>
		</div>,
		document.body
	);
}

/** A single branch's editable Title field — plain local state, seeded from
 *  (and re-seeded whenever, via the `key` the caller passes) the current
 *  committed heading text, committed on blur/Enter — the same shape every
 *  other single-line text field in this codebase uses (`commitDisplayTitle`,
 *  entity-view.tsx). `onDraftChange`, called on every keystroke (unlike
 *  `onCommit`, which only fires on blur/Enter), is what lets the card's own
 *  `>**Title**<` preview track what's being typed in real time instead of
 *  jumping to the new value only once the field is actually committed.
 *
 *  **`autoFocusEmpty`** is the "just created via '+', still carrying the
 *  literal placeholder title `'Untitled'`" case (`entity-view.tsx`'s
 *  `handleAddBranch`/`pendingBranchTitleFocusId`) — the branch is ALREADY
 *  real in the document by the time this ever renders (no draft/staging
 *  step any more), but showing "Untitled" sitting in the field would read
 *  as real content to type AROUND rather than OVER. Seeds `draft` blank
 *  instead of `value` and focuses the field, purely at THIS component's own
 *  first mount (the caller's `key={title-${sectionId}}` guarantees that
 *  mount happens exactly once per branch's whole lifetime, so there's no
 *  risk of this re-triggering later once the branch has a real title) —
 *  every other behavior is completely unchanged: the very first keystroke
 *  lands in an empty field exactly like typing over a native `<input
 *  placeholder>` would, `onCommit` still only fires on blur/Enter with
 *  whatever was actually typed, and blurring with nothing typed reveals the
 *  real stored value (`'Untitled'`) via the existing `else setDraft(value)`
 *  branch below, exactly like leaving any other field untouched. */
function BranchTitleField({
	value,
	onCommit,
	onDraftChange,
	autoFocusEmpty,
	onAutoFocusConsumed,
}: {
	value: string;
	onCommit: (v: string) => void;
	onDraftChange?: (v: string) => void;
	autoFocusEmpty?: boolean;
	onAutoFocusConsumed?: () => void;
}): ReactElement {
	const [draft, setDraft] = useState(autoFocusEmpty ? '' : value);
	useEffect(() => {
		// Mount-only — `autoFocusEmpty` only ever matters at this field's
		// very first mount, per this component's own doc comment above.
		if (autoFocusEmpty) onAutoFocusConsumed?.();
	}, []);
	return (
		<input
			type="text"
			className="loom-branch-input loom-branch-title-input"
			value={draft}
			autoFocus={autoFocusEmpty}
			onChange={(e) => {
				setDraft(e.target.value);
				onDraftChange?.(e.target.value);
			}}
			onBlur={() => {
				const trimmed = draft.trim();
				if (trimmed !== '' && trimmed !== value) onCommit(trimmed);
				else setDraft(value);
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
			}}
		/>
	);
}

/** A branch's own prose BODY (dialogue/action) — a real nested `FountainField`
 *  (buffered locally, committed on blur, same contract every other field in
 *  this file uses), rendering the same bold/uppercase character cues,
 *  indents, and italics the surrounding script gets, so the card reads as an
 *  editable piece of the script rather than a plain form field dropped into
 *  it.
 *
 *  Deliberately narrower than the main script's own `FountainField`: no
 *  comments/alt-text (`showAnnotationGutter={false}` too — an unused
 *  gutter is still a real column CM6 reserves space for, which would throw
 *  off `contentWidth` below), no click-to-open character/scene/act/entity
 *  navigation, and — critically — no `onCreateBranch`/`onPasteBranchGroup`
 *  (a branch's body must never itself offer to nest ANOTHER decision point
 *  inside it). `characters`/`entityOptions`/`ambientSuggestDismissMs` are
 *  threaded straight through from the caller's own main editor so the cue
 *  autocomplete and ambient link suggester behave identically here.
 *  `escapeOverflowForTooltips` is on — see that prop's own doc comment
 *  (fountain-field.tsx) for why the autocomplete popup needs to escape this
 *  field's own clipped context entirely rather than just repositioning
 *  within it.
 *
 *  `contentWidth` is applied as an explicit pixel `width` on the inner
 *  `.loom-branch-body-inner` wrapper — NOT `max-width`, and not left for
 *  `.loom-fountain-field .cm-content`'s own generic `max-width: 6in` rule to
 *  land on independently: the card's own outer box is wider than the real
 *  text column (`CARD_WIDEN_FACTOR`), so this wrapper is what actually pins
 *  the rendered text to the real editor's own exact width, centered within
 *  the wider card via `margin: 0 auto`. `flex: 1` (styles.css) fills
 *  whatever vertical space the card's own header (Title + `= branch:` combo
 *  row) leaves; `.loom-branch-body-field`'s own `overflow: hidden` is a
 *  backstop for a still-uncorrected height shortfall (see `BranchOverlay`'s
 *  own `onSpacerNeedsChange` and this file's top doc comment — the caller
 *  reserves the real space needed instead), not the primary mechanism.
 *
 *  Exposes `getContentHeight` (its nested field's own `scrollDOM.
 *  scrollHeight`, the natural — unclipped — height its current text needs)
 *  via a forwarded ref, read by `BranchOverlay`'s own measurement pass. */
interface BranchBodyFieldHandle {
	/** The nested field's own natural (unclipped) content height in pixels —
	 *  `0` before the field has mounted. */
	getContentHeight: () => number;
	/** The nested field's own live `EditorView`, or `null` before it's
	 *  mounted — `BranchOverlay`'s `applyTrackTransform` (its own doc
	 *  comment explains why) uses this to call CM6's `repositionTooltips` on
	 *  every scroll tick, the one thing that makes this field's own
	 *  autocomplete popup track the card's externally-driven `transform`
	 *  instead of freezing at whatever screen position it first opened at. */
	getView: () => EditorView | null;
}

const BranchBodyField = forwardRef(function BranchBodyField(
	{
		value,
		onCommit,
		contentWidth,
		characters,
		entityOptions,
		ambientSuggestDismissMs,
		groupId,
		onCutBranchGroup,
		onCopyBranchGroup,
	}: {
		value: string;
		onCommit: (v: string) => void;
		contentWidth: number;
		characters: string[];
		entityOptions?: { name: string; type: EntityType; path: string }[];
		ambientSuggestDismissMs?: number;
		/** This card's own decision-point group id — passed straight through
		 *  as the nested `FountainField`'s `branchGroupId`, which is what
		 *  repurposes ITS OWN Cut/Copy menu items into whole-group operations.
		 *  See that prop's own doc comment (fountain-field.tsx). */
		groupId: string;
		onCutBranchGroup: (groupId: string) => void;
		onCopyBranchGroup: (groupId: string) => void;
	},
	ref: ForwardedRef<BranchBodyFieldHandle>
): ReactElement {
	const [draft, setDraft] = useState(value);
	const fieldRef = useRef<FountainFieldHandle | null>(null);
	useImperativeHandle(ref, () => ({
		getContentHeight: () => fieldRef.current?.getView()?.scrollDOM.scrollHeight ?? 0,
		getView: () => fieldRef.current?.getView() ?? null,
	}));
	return (
		<div className="loom-branch-body-field">
			<div className="loom-branch-body-inner" style={{ width: contentWidth }}>
				<FountainField
					ref={fieldRef}
					value={draft}
					onChange={setDraft}
					onBlur={() => {
						if (draft !== value) onCommit(draft);
					}}
					characters={characters}
					entityOptions={entityOptions}
					ambientSuggestDismissMs={ambientSuggestDismissMs}
					showAnnotationGutter={false}
					escapeOverflowForTooltips
					branchGroupId={groupId}
					onCutBranchGroup={onCutBranchGroup}
					onCopyBranchGroup={onCopyBranchGroup}
				/>
			</div>
		</div>
	);
});

/** Branch 1's own Identifier/Subidentifier/Number-or-override fields — shown
 *  decomposed (three separate inputs, joined by a literal "-" matching the
 *  real `IDENTIFIER-SUBIDENTIFIER-NUMBER` text) when the group's current
 *  value parses as the composer's own 3-segment shape, or as ONE plain field
 *  for a legacy hand-typed value that doesn't. Each of the three decomposed
 *  fields commits independently on blur, always composing from the CURRENT
 *  values of all three (an untouched field falls back to its own
 *  already-committed segment, never blanks it) — `setBranchTagValue`
 *  rewrites every sibling in the group together.
 *
 *  `readOnly` renders EVERY non-first branch's own copy of this same row —
 *  a real `= branch: <id>` line sits under every branch section in the
 *  group, not just the first, all carrying the identical value (that's what
 *  groups them); showing it disabled/greyed on every branch keeps the panel
 *  a faithful mirror of what the real script text actually looks like there,
 *  while still only accepting edits through the one (first branch's) live
 *  copy — editing any other branch's own line directly would just be
 *  overwritten the moment it cascades from branch 1's real edit anyway. */
function BranchComboFields({
	value,
	readOnly,
	onCommitCombo,
	onCommitRaw,
}: {
	value: string;
	readOnly?: boolean;
	onCommitCombo: (identifier: string, subidentifier: string, numberOrOverride: string) => void;
	onCommitRaw: (v: string) => void;
}): ReactElement {
	const decomposed = decomposeBranchValue(value);
	const [identifier, setIdentifier] = useState(decomposed?.identifier ?? '');
	const [subidentifier, setSubidentifier] = useState(decomposed?.subidentifier ?? '');
	const [numberOverride, setNumberOverride] = useState(decomposed?.number ?? '');
	const [raw, setRaw] = useState(value);

	if (!decomposed) {
		return (
			<input
				type="text"
				className="loom-branch-input loom-branch-raw-input"
				value={raw}
				disabled={readOnly}
				onChange={(e) => setRaw(e.target.value)}
				onBlur={() => {
					const trimmed = raw.trim();
					if (trimmed !== '' && trimmed !== value) onCommitRaw(trimmed);
					else setRaw(value);
				}}
			/>
		);
	}

	const commit = (nextIdentifier: string, nextSub: string, nextNum: string) => {
		const i = nextIdentifier.trim() || decomposed.identifier;
		const s = nextSub.trim() || decomposed.subidentifier;
		const n = nextNum.trim() || decomposed.number;
		if (i !== decomposed.identifier || s !== decomposed.subidentifier || n !== decomposed.number) {
			onCommitCombo(i, s, n);
		}
	};

	return (
		<div className="loom-branch-combo-row">
			<input
				type="text"
				className="loom-branch-input"
				placeholder={t('view.script.branch.identifierPlaceholder')}
				value={identifier}
				disabled={readOnly}
				onChange={(e) => setIdentifier(e.target.value)}
				onBlur={() => commit(identifier, subidentifier, numberOverride)}
			/>
			<span className="loom-branch-combo-sep">-</span>
			<input
				type="text"
				className="loom-branch-input"
				placeholder={t('view.script.branch.subidentifierPlaceholder')}
				value={subidentifier}
				disabled={readOnly}
				onChange={(e) => setSubidentifier(e.target.value)}
				onBlur={() => commit(identifier, subidentifier, numberOverride)}
			/>
			<span className="loom-branch-combo-sep">-</span>
			<input
				type="text"
				className="loom-branch-input loom-branch-number-input"
				placeholder={t('view.script.branch.numberPlaceholder')}
				value={numberOverride}
				disabled={readOnly}
				onChange={(e) => setNumberOverride(e.target.value)}
				onBlur={() => commit(identifier, subidentifier, numberOverride)}
			/>
		</div>
	);
}
