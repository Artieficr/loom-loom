import { ReactElement, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { branchComboKey, nextComboNumber, parseFountain } from '../fountain';
import { FountainFieldHandle } from './fountain-field';
import { t } from '../i18n';

/**
 * The modular branch editor's DRAFT overlay: `position: fixed` OPAQUE panels
 * drawn on top of the live Fountain editor for a still-open, not-yet-written
 * `BranchDraft` — a brand-new decision point/branch being staged before it
 * becomes real document text. Sourced from the SAME `EditorView`
 * `FountainField` already owns, never a second copy of the document.
 *
 * **A REAL, already-committed branch group does NOT render here any more.**
 * It used to (the same opaque-card shape, for every group in the document
 * unconditionally) — that path was replaced by embedded CM6 decorations
 * rendered directly over the group's own real text (`fountain-field.tsx`'s
 * "Embedded branch cards" doc comment, `buildBranchGroupDecorations`), which
 * is what let Cut/Copy/paste and text-selection safety work against the
 * actual document instead of an opaque duplicate floating over it. This file
 * keeps exactly what a draft still needs: a way to show and edit a group
 * that has no real span to decorate yet. Once a draft is committed
 * (`onCreateDraft`), it's written straight to the document and immediately
 * renders through the embedded path instead — this overlay never draws it
 * again.
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
 * computes each draft's anchor position as a DOCUMENT-relative `top` (`screen
 * top at sync time` + `the scrollTop at that moment`, i.e. "where this card
 * would sit if `scrollTop` were 0") rather than a viewport-relative one, and
 * every card renders inside one shared `trackRef` div that gets `transform:
 * translateY(-scrollTop)` applied DIRECTLY (bypassing React entirely) by a
 * plain, un-debounced `scroll` listener on `view.scrollDOM`. That single
 * `transform` write is the only thing that has to track a fast scroll
 * gesture in real time, and it's cheap enough (one DOM write, no layout
 * read) to do so with zero perceptible lag; `sync()` itself only runs on
 * genuine content/geometry changes, occasionally re-confirming (and
 * correcting any drift in) the values the transform is built from.
 *
 * **Clipping is a real CSS `overflow: hidden`, not manual clamp math**: the
 * fixed "window" div — sized to `visibleClipRect(view.scrollDOM)`,
 * `overflow: hidden` — does the actual visual trimming, exactly like a
 * normal scrollable region clips its content, so a draft's card scrolls out
 * from under that edge the way ordinary document text does.
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
 * `<input>`/button elements with ordinary React event handling, which
 * doesn't fit that imperative-DOM-node style. Rendered DOM is React-owned
 * (cleaned up by React's own unmount, not manual `.remove()` calls), so the
 * specific leak `AnnotationHandlesOverlay`'s own `destroyed`/`isConnected`
 * guards exist for doesn't apply the same way here — the `destroyed` ref
 * below only guards against a stale `setState` call landing after unmount, a
 * much smaller concern.
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

/** A still-open draft's on-screen anchor — just a `top`/`left`/`width`, no
 *  `bottom`/height: a draft has no real document content to measure a span
 *  from yet, so its card's height is purely whatever its own editable
 *  fields need (`height: auto`). `top` is DOCUMENT-relative (screen top at
 *  last `sync()`, converted to "as if `view.scrollDOM.scrollTop` were 0" by
 *  adding that scrollTop back in) — a value that stays correct across
 *  ordinary CM6-internal scrolling with NO recompute, because the shared
 *  scroll-tracking `<div>` every draft card renders inside (`trackRef`,
 *  below) gets its own `transform: translateY(-scrollTop)` applied directly
 *  on every native `scroll` event, synchronously, bypassing React entirely —
 *  the only thing that has to track a live scroll gesture in real time. */
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
	/** Still-open drafts (state owned by the caller) — the only thing this
	 *  component renders, each at its own tracked/derived anchor position. */
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
}: BranchOverlayProps): ReactElement | null {
	const [draftRects, setDraftRects] = useState<DraftCardRect[]>([]);
	/** A fresh parse of the live document text, memoized purely for the
	 *  draft panel's own Number field PREVIEW below (`nextComboNumber`) —
	 *  only needs to react to genuine document content changes, not
	 *  scroll/resize. `parseFountain` is cheap and dependency-free, already
	 *  re-run per keystroke elsewhere in this codebase (the Outline panel),
	 *  so a second parse here costs nothing worth avoiding. */
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

	useEffect(() => {
		const sync = () => {
			if (destroyedRef.current) return;
			const view = fieldRef.current?.getView();
			const wrap = wrapRef.current;
			if (!view || !wrap || !view.dom.isConnected) {
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
				setDraftRects([]);
				setClipWindow(null);
				setObscureRect(null);
				return;
			}

			// `wrap` (`.loom-scene-script`) is the full-width shell — the nav
			// panel/comments/alt-text asides all share it as siblings — but the
			// actual Fountain text renders in a centered, `max-width: 6in`
			// column (`.loom-fountain-field .cm-content`, styles.css) narrower
			// than that shell. `view.contentDOM` IS that column, so its own rect
			// is what a draft card's own left/width need to match — a card only
			// covers the real text, never the wider shell around it, so the
			// pointer-events-none clip window (below) leaves the margins on
			// either side free for the mouse to keep scrolling the editor
			// normally.
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
			const docLines = view.state.doc.lines;

			/** `coordsAtPos` first, `lineBlockAt` only as a fallback for a
			 *  position `coordsAtPos` can't measure at all (genuinely
			 *  off-screen/virtualized content — see `docCorrection`'s own doc
			 *  comment above for why that fallback exists). */
			const docTop = (pos: number): number => {
				const coords = view.coordsAtPos(pos, 1);
				return coords ? coords.top - clipRect.top + scrollTop : view.lineBlockAt(pos).top + docCorrection;
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
					return docTop(fromPos);
				} catch (e) {
					console.error('Loom Loom: branch overlay could not read layout this frame', e);
					return null;
				}
			};

			// The card's own OUTER box is deliberately WIDER than the real text
			// column (`CARD_WIDEN_FACTOR`) — a card whose border sits flush
			// against the text on both sides reads as cramped, with no
			// breathing room around the draft's own fields. The text column
			// itself (`contentWidth`) is kept at its own true, unwidened value
			// and centered within the wider card.
			const contentWidth = contentRect.width;
			const width = contentWidth * CARD_WIDEN_FACTOR;
			const left = contentRect.left - clipRect.left - (width - contentWidth) / 2;

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

		/** Reads the CURRENT scroll position directly and writes it straight to
		 *  `trackRef`'s own `transform`, bypassing React/state entirely — the
		 *  one thing that has to track a fast scroll gesture with zero
		 *  perceptible lag. Never calls `coordsAtPos`/reads layout, so it's
		 *  safe to run on every native `scroll` event with no debouncing at
		 *  all. */
		const applyTrackTransform = () => {
			const view = fieldRef.current?.getView();
			const track = trackRef.current;
			if (!view || !track) return;
			track.style.transform = `translateY(${-view.scrollDOM.scrollTop}px)`;
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

	if (!clipWindow || draftRects.length === 0) return null;

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
