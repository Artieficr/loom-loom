import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
	gutter,
	keymap,
	tooltips,
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
import { t } from '../i18n';
import {
	ElementType,
	ParsedScript,
	branchGroupAtLine,
	branchGroupBounds,
	branchLabelEndLine,
	decomposeBranchValue,
	findAnnotationSpans,
	findEntityLinks,
	findOrphanPairs,
	newSceneId,
	parseFountain,
	promoteTypedBranch,
	readLoomId,
} from '../fountain';
import { AltTextEntry, CommentEntry } from './script-notes';
import { CLICK_TO_OPEN_ATTRS, EntityType, entityLabel } from '../types';
import {
	AnnotationGutterItem,
	AnnotationGutterMarker,
	isUnresolvedComment,
	partiallyOverlaps,
	refreshAnnotations,
	scrollWithinEditor,
} from './annotation-cm6';
import { LinkSuggestEntry, buildLinkSuggestExtension } from './link-suggest-cm6';

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
 * scene/act identity marker — it's not user content, and showing it
 * would just be noise on every heading.
 */

/** True when `[from, to)` partially overlaps `[sFrom, sTo)` — neither
 *  disjoint, nested inside it, nor fully surrounding it. Nesting/surrounding
 *  is fine (spans stay well-nested either way); only a true partial cross is
 *  a conflict. Shared by the two places that must reject one: creating a new
 *  comment/alt-text span over a selection (`openContextMenu`) and dragging an
 *  existing comment span's edge handle onto a new position
 *  (`startAnnotationHandleDrag`). Imported from `annotation-cm6.ts` — shared
 *  with `markdown-field.tsx` rather than duplicated. */

const LOOM_ID_RE = /\s*\[\[loom:[A-Za-z0-9]+\]\]/;
/** Mirrors `SCENE_PREFIXES` in fountain.ts (not exported — this only needs
 *  to recognize a heading-shaped START, not fully replicate scene parsing). */
const SCENE_PREFIX_RE = /^(?:INT\.?\/EXT\.?|INT\/EXT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s+/i;

/** The two `LinkSuggestConfig` checks specific to `@[Name|Display]` syntax —
 *  module-level, no per-instance state needed (see link-suggest-cm6.ts's own
 *  doc comment for why that module never assumes any particular syntax). */
function isInsideEntityLinkOpen(line: string, ch: number): boolean {
	const open = line.lastIndexOf('@[', ch);
	if (open === -1) return false;
	const close = line.indexOf(']', open);
	return close === -1 || close >= ch;
}

function overlapsClosedEntityLink(line: string, from: number, to: number): boolean {
	for (const link of findEntityLinks(line)) {
		if (from < link.to && to > link.from) return true;
	}
	return false;
}

/** Cheap heuristic — skip ambient suggestions on scene-heading/character-cue/
 *  transition lines, which already have their own dedicated autocomplete
 *  (`characterCompletion`, below) or aren't prose to hyperlink inline at all.
 *  Deliberately NOT a full `parseFountain` classification — cheap enough to
 *  run on every trigger, and a false positive/negative here is low-stakes
 *  (worst case: a suggestion shows up somewhere slightly redundant, never a
 *  correctness bug). */
function looksLikeNonProseLine(lineText: string): boolean {
	const trimmed = lineText.trim();
	if (trimmed === '') return false;
	if (SCENE_PREFIX_RE.test(trimmed)) return true;
	if (/\bTO:\s*$/.test(trimmed) && trimmed === trimmed.toUpperCase()) return true;
	const letters = trimmed.replace(/[^A-Za-z]/g, '');
	return letters.length > 0 && trimmed === trimmed.toUpperCase();
}

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
		const attributes = path
			? { 'data-loom-fountain-entity': path, ...CLICK_TO_OPEN_ATTRS }
			: undefined;
		// The visible "@" (kept, not hidden) and the visible display text are
		// two separate mark ranges around the hidden `[`/`Name|`/`]` pieces.
		spans.push({ from: link.from, to: link.from + 1, deco: Decoration.mark({ class: 'loom-fountain-entity-link', attributes }) });
		spans.push({ from: link.from + 1, to: link.displayFrom, deco: Decoration.replace({}) });
		spans.push({ from: link.displayFrom, to: link.displayTo, deco: Decoration.mark({ class: 'loom-fountain-entity-link', attributes }) });
		spans.push({ from: link.displayTo, to: link.to, deco: Decoration.replace({}) });
	}
	return spans;
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
	/** Replaces the ENTIRE document with `newValue` and places the cursor at
	 *  `cursorLine` (0-based) — unconditionally, bypassing the normal
	 *  `value`-prop-diffing "sync external value only while unfocused"
	 *  effect entirely (never gated on focus, never tagged
	 *  `loom.externalSync`, so this genuinely counts as a real edit and
	 *  fires `onChange` like any other). The one case that needs this: a
	 *  caller (Scene's own "Paste branch group") that just computed EXACTLY
	 *  what this field's body should show, in memory, from a write it's
	 *  about to make. Going through the normal reactive path instead would
	 *  mean round-tripping through disk first — and the Scene page's own
	 *  `sceneScriptText` unconditionally strips ALL trailing whitespace from
	 *  a scene's excerpt, which erases any trailing blank line meant as a
	 *  landing spot the moment that content becomes the scene's own last
	 *  line, before the user ever gets a chance to type into it and make it
	 *  non-blank. Dispatching the exact in-memory text directly, before any
	 *  such round trip, sidesteps that erasure completely. */
	replaceBody: (newValue: string, cursorLine: number) => void;
	/** The live `EditorView`, or `null` before the field has mounted — the
	 *  narrow escape hatch `BranchOverlay` (branch-overlay.tsx) needs to
	 *  position its own real-DOM cards over this field's content and dispatch
	 *  its own transactions into it. Deliberately a plain getter, not a
	 *  ready/destroyed callback pair: a caller with its own deferred
	 *  scheduling loop (mirroring `AnnotationHandlesOverlay`'s own, below)
	 *  just re-reads this on its next scheduled tick if it's momentarily
	 *  null, the same way every OTHER method here already re-reads
	 *  `viewRef.current` fresh rather than trusting a cached reference. */
	getView: () => EditorView | null;
	/** Registers a new `new-group` branch draft's insertion point at the
	 *  document position `pos` (a character offset, from the right-click that
	 *  opened it) and returns a fresh id for it — `branch-overlay.tsx`'s own
	 *  `BranchDraft.id`. The position is tracked live inside this editor's own
	 *  `draftAnchors` `StateField`, remapped through every subsequent edit
	 *  (`tr.changes.mapPos`) so it survives concurrent typing elsewhere in the
	 *  document while the draft sits open — unlike a plain stored line number,
	 *  which would silently go stale the moment a line above it is added or
	 *  removed. A `new-branch` draft (joining an EXISTING decision point) has
	 *  no need for this: its position is always "wherever that group's own
	 *  `= gather` line (or last branch) currently is," freshly re-derived from
	 *  `branchGroupBounds` on every read. */
	createDraftAnchor: (pos: number) => string;
	/** The draft's CURRENT 0-based line — re-read from the live, remapped
	 *  position on every call, never cached — or `null` if the field hasn't
	 *  mounted or the anchor was already cleared. */
	getDraftAnchorLine: (id: string) => number | null;
	/** Drops a draft's tracked anchor once it transitions to a real branch (no
	 *  longer needed — the branch's own `[[loom:<id>]]` marker takes over) or
	 *  is abandoned (blurred empty, explicitly dismissed) — nothing else was
	 *  ever written to the document for a still-open draft, so there's no
	 *  further cleanup needed beyond forgetting the tracked position itself. */
	clearDraftAnchor: (id: string) => void;
}

/** `new-group` branch-draft anchor tracking (`FountainFieldHandle`'s own
 *  `createDraftAnchor`/`getDraftAnchorLine`/`clearDraftAnchor`) — a small
 *  `Map<draftId, characterOffset>` kept as ordinary CM6 document state so it
 *  rides along `tr.changes.mapPos` on every transaction, CM6's own idiom for
 *  keeping a position valid across concurrent edits (the same mechanism CM6
 *  itself uses internally for cursors/marks) — the one thing a plain React
 *  ref holding a raw line number could never do safely. */
const setDraftAnchor = StateEffect.define<{ id: string; pos: number }>();
const clearDraftAnchorEffect = StateEffect.define<string>();
const draftAnchors = StateField.define<Map<string, number>>({
	create: () => new Map(),
	update(value, tr) {
		let next = value;
		if (tr.docChanged && next.size > 0) {
			next = new Map(Array.from(next, ([id, pos]) => [id, tr.changes.mapPos(pos)]));
		}
		for (const effect of tr.effects) {
			if (effect.is(setDraftAnchor)) {
				next = new Map(next);
				next.set(effect.value.id, effect.value.pos);
			} else if (effect.is(clearDraftAnchorEffect)) {
				if (next.has(effect.value)) {
					next = new Map(next);
					next.delete(effect.value);
				}
			}
		}
		return next;
	},
});

/**
 * Embedded branch cards: every branch group in the document renders its own
 * chrome DIRECTLY over its own real text — no second copy, no
 * `position: fixed` overlay (replacing `branch-overlay.tsx`). Every sibling
 * in a group renders SIMULTANEOUSLY, stacked in document order — no
 * tab-switching, no folding, nothing hidden that isn't ALWAYS meant to stay
 * hidden (the raw `###`/`= branch:`/`>**Title**<`/`= gather` syntax, which
 * becomes display-only chrome per the design; a branch's own PROSE BODY is
 * left completely untouched, real, always-editable document text, so native
 * cut/copy/paste on it just works with no special handling). Only single-
 * line, non-block decorations are used here (`Decoration.replace`/`.widget`
 * with NO `block: true`, same trick `markdown-field.tsx`'s `HrWidget`/
 * `BulletWidget` already use to render a full-width custom element in place
 * of one line's raw text) — a real CM6 constraint hit building the earlier
 * tab-based version of this feature: block decorations may only be supplied
 * through a `StateField`, never a `ViewPlugin`, and since nothing folds away
 * any more there's no reason to need one.
 *
 * Every widget class below is constructed fresh inside `pushBranchGroupDecorations`
 * (defined inside the component body, closing over the SAME refs every other
 * decoration pass here reads), so a widget's own constructor already carries
 * whichever callback it needs — no per-instance ref lookups inside the widget
 * itself. `eq()` on each one compares only the COMMITTED values (never
 * anything from an in-progress, uncommitted keystroke), which is what lets a
 * decoration rebuild triggered by something unrelated (typing elsewhere in
 * the document, an annotation search match) reuse the SAME `<input>` DOM
 * node rather than tearing it down mid-edit — the input's own uncommitted
 * text simply survives, no extra buffering needed on this side.
 */
class BranchHeaderRowWidget extends WidgetType {
	constructor(
		readonly sectionId: string,
		readonly title: string,
		readonly autoFocusEmpty: boolean,
		readonly onCommitTitle: ((sectionId: string, title: string) => void) | undefined,
		readonly onDelete: ((sectionId: string) => void) | undefined,
		readonly onFocusConsumed: (() => void) | undefined
	) {
		super();
	}
	eq(other: BranchHeaderRowWidget): boolean {
		return other.sectionId === this.sectionId && other.title === this.title && other.autoFocusEmpty === this.autoFocusEmpty;
	}
	toDOM(view: EditorView): HTMLElement {
		const row = view.dom.doc.body.createDiv({ cls: 'loom-fountain-branch-header-row loom-branch-label-row' });
		row.detach();
		fixWidgetRowDisplay(row, 'inline-flex');
		row.contentEditable = 'false';
		row.createSpan({ cls: 'loom-branch-label loom-branch-label-section', text: '###' });
		const input = row.createEl('input', { cls: 'loom-branch-input loom-branch-title-input' });
		input.type = 'text';
		input.placeholder = t('view.script.branch.titlePlaceholder');
		input.value = this.autoFocusEmpty ? '' : this.title;
		input.addEventListener('input', () => {
			// Live-updates the sibling `>**Title**<` preview widget, if it's
			// currently mounted — a nice-to-have carried over from the overlay's
			// own `liveTitleOverrides`, not load-bearing (the preview still
			// catches up to the real title on the NEXT commit either way).
			for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>('[data-loom-branch-preview-for]'))) {
				if (el.dataset.loomBranchPreviewFor !== this.sectionId) continue;
				const bold = el.querySelector<HTMLElement>('.loom-branch-title-preview-bold');
				if (bold) bold.textContent = `**${input.value}**`;
			}
		});
		input.addEventListener('blur', () => {
			const trimmed = input.value.trim();
			if (trimmed !== '' && trimmed !== this.title) this.onCommitTitle?.(this.sectionId, trimmed);
			else input.value = this.title;
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});
		if (this.autoFocusEmpty) {
			// Deferred a tick — avoids focusing/dispatching React state
			// (`onFocusConsumed`) synchronously from inside CM6's own
			// decoration-building pass.
			window.setTimeout(() => {
				input.focus();
				this.onFocusConsumed?.();
			}, 0);
		}
		const del = row.createEl('button', { cls: 'clickable-icon loom-branch-delete-btn' });
		del.type = 'button';
		del.setAttr('aria-label', t('view.script.branch.deleteBranchAria'));
		setIcon(del, 'trash-2');
		del.addEventListener('click', () => this.onDelete?.(this.sectionId));
		return row;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** Branch 1's own decomposed Identifier/Subidentifier/Number(-or-override)
 *  fields, editable — every OTHER sibling in the group renders the identical
 *  row DISABLED, mirroring branch 1's current value (a real `= branch: <id>`
 *  line sits under every branch in the group, all carrying the identical
 *  text, which is what groups them; showing it there too keeps the chrome a
 *  faithful mirror of the document, while edits are only ever accepted
 *  through branch 1's own live copy). Falls back to ONE plain raw field
 *  (editable only on branch 1 too) for a legacy value that doesn't decompose
 *  into 3 dash-separated segments.
 *
 *  **`autoFocusSelect`** — the group was just born via the typed
 *  `### Title` + `= branch:` auto-detect trigger (`promoteTypedBranch`,
 *  fountain.ts), so its combo carries a placeholder value nobody actually
 *  chose yet. Unlike `BranchHeaderRowWidget`'s `autoFocusEmpty` (which
 *  BLANKS the field, since "Untitled" would otherwise read as real typed
 *  content), the Identifier field here shows its real placeholder text
 *  `.select()`ed instead — a plain, standard "type to replace" affordance:
 *  there's no ambiguity to mask, since a freshly-generated combo like
 *  `ID-SUB-01` already reads unmistakably as a placeholder, not something
 *  the user could mistake for their own input. */
class BranchComboRowWidget extends WidgetType {
	constructor(
		readonly groupId: string,
		readonly isFirst: boolean,
		readonly onCommitCombo:
			| ((groupId: string, identifier: string, subidentifier: string, numberOrOverride: string) => void)
			| undefined,
		readonly onCommitRaw: ((groupId: string, value: string) => void) | undefined,
		readonly autoFocusSelect: boolean = false,
		readonly onFocusConsumed: (() => void) | undefined = undefined
	) {
		super();
	}
	eq(other: BranchComboRowWidget): boolean {
		return (
			other.groupId === this.groupId && other.isFirst === this.isFirst && other.autoFocusSelect === this.autoFocusSelect
		);
	}
	toDOM(view: EditorView): HTMLElement {
		const row = view.dom.doc.body.createDiv({ cls: 'loom-fountain-branch-header-row loom-branch-label-row' });
		row.detach();
		fixWidgetRowDisplay(row, 'inline-flex');
		row.contentEditable = 'false';
		row.createSpan({ cls: 'loom-branch-label loom-branch-label-synopsis', text: '= branch:' });
		const decomposed = decomposeBranchValue(this.groupId);
		if (!decomposed) {
			const input = row.createEl('input', { cls: 'loom-branch-input loom-branch-raw-input' });
			input.type = 'text';
			input.value = this.groupId;
			input.disabled = !this.isFirst;
			if (this.isFirst) {
				input.addEventListener('blur', () => {
					const trimmed = input.value.trim();
					if (trimmed !== '' && trimmed !== this.groupId) this.onCommitRaw?.(this.groupId, trimmed);
					else input.value = this.groupId;
				});
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') input.blur();
				});
			}
			return row;
		}
		const comboRow = row.createDiv({ cls: 'loom-branch-combo-row' });
		const mkField = (value: string, placeholder: string, extraClass?: string) => {
			const inp = comboRow.createEl('input', {
				cls: extraClass ? `loom-branch-input ${extraClass}` : 'loom-branch-input',
			});
			inp.type = 'text';
			inp.placeholder = placeholder;
			inp.value = value;
			inp.disabled = !this.isFirst;
			return inp;
		};
		const idInput = mkField(decomposed.identifier, t('view.script.branch.identifierPlaceholder'));
		comboRow.createSpan({ cls: 'loom-branch-combo-sep', text: '-' });
		const subInput = mkField(decomposed.subidentifier, t('view.script.branch.subidentifierPlaceholder'));
		comboRow.createSpan({ cls: 'loom-branch-combo-sep', text: '-' });
		const numInput = mkField(decomposed.number, t('view.script.branch.numberPlaceholder'), 'loom-branch-number-input');
		if (this.isFirst && this.autoFocusSelect) {
			// Deferred a tick — same reasoning as `BranchHeaderRowWidget`'s own
			// `autoFocusEmpty`: avoids focusing synchronously from inside CM6's
			// own decoration-building pass.
			window.setTimeout(() => {
				idInput.focus();
				idInput.select();
				this.onFocusConsumed?.();
			}, 0);
		}
		if (this.isFirst) {
			const commit = () => {
				const i = idInput.value.trim() || decomposed.identifier;
				const s = subInput.value.trim() || decomposed.subidentifier;
				const n = numInput.value.trim() || decomposed.number;
				if (i !== decomposed.identifier || s !== decomposed.subidentifier || n !== decomposed.number) {
					this.onCommitCombo?.(this.groupId, i, s, n);
				}
			};
			for (const inp of [idInput, subInput, numInput]) {
				inp.addEventListener('blur', commit);
				inp.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') inp.blur();
				});
			}
		}
		return row;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** The printed `>**Title**<` marker `applyBranchLabels` (fountain.ts) writes
 *  into the document right under a branch's own `= branch:` line — display
 *  only, never itself edited (renaming the Title field above updates it,
 *  live via `BranchHeaderRowWidget`'s own `input` listener, and for real on
 *  the next commit). `data-loom-branch-preview-for` is what that listener
 *  targets. */
class BranchTitlePreviewWidget extends WidgetType {
	constructor(
		readonly sectionId: string,
		readonly title: string
	) {
		super();
	}
	eq(other: BranchTitlePreviewWidget): boolean {
		return other.sectionId === this.sectionId && other.title === this.title;
	}
	toDOM(view: EditorView): HTMLElement {
		const row = view.dom.doc.body.createDiv({ cls: 'loom-branch-title-preview' });
		row.detach();
		fixWidgetRowDisplay(row, 'inline-block');
		row.contentEditable = 'false';
		row.setAttr('data-loom-branch-preview-for', this.sectionId);
		row.createSpan({ text: '>' });
		row.createSpan({ cls: 'loom-branch-title-preview-bold', text: `**${this.title}**` });
		row.createSpan({ text: '<' });
		return row;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** `= gather` — display only, always present once a group has one (every
 *  group created through the app gets one from the moment it's born,
 *  `insertBranch`'s own doc comment) — carries the group's own "+" (add
 *  another branch) button, sitting right after it, still inside the outer
 *  box. */
class BranchGatherRowWidget extends WidgetType {
	constructor(
		readonly groupId: string,
		readonly onAdd: ((groupId: string) => void) | undefined
	) {
		super();
	}
	eq(other: BranchGatherRowWidget): boolean {
		return other.groupId === this.groupId;
	}
	toDOM(view: EditorView): HTMLElement {
		const row = view.dom.doc.body.createDiv({ cls: 'loom-fountain-branch-gather-row' });
		row.detach();
		fixWidgetRowDisplay(row, 'inline-block');
		row.contentEditable = 'false';
		row.createSpan({ cls: 'loom-branch-gather-label', text: '= gather' });
		const btn = row.createEl('button', { cls: 'loom-fountain-branch-add-btn', text: '+' });
		btn.type = 'button';
		btn.setAttr('aria-label', t('view.script.branch.addBranchAria'));
		btn.addEventListener('click', () => this.onAdd?.(this.groupId));
		return row;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** The group's own "+" for the rare case it has NO `= gather` line to attach
 *  to (a hand-typed/imported script — every group created through the app
 *  always has one) — a plain, non-replacing widget appended right after the
 *  last branch's own last line, `display: block` so it still lands on its
 *  own visual row within that line (same technique `HrWidget`/`BulletWidget`
 *  use in markdown-field.tsx). */
class BranchAddRowWidget extends WidgetType {
	constructor(
		readonly groupId: string,
		readonly onAdd: ((groupId: string) => void) | undefined
	) {
		super();
	}
	eq(other: BranchAddRowWidget): boolean {
		return other.groupId === this.groupId;
	}
	toDOM(view: EditorView): HTMLElement {
		const row = view.dom.doc.body.createDiv({ cls: 'loom-fountain-branch-add-row' });
		row.detach();
		fixWidgetRowDisplay(row, 'inline-block');
		row.contentEditable = 'false';
		const btn = row.createEl('button', { cls: 'loom-fountain-branch-add-btn', text: '+' });
		btn.type = 'button';
		btn.setAttr('aria-label', t('view.script.branch.addBranchAria'));
		btn.addEventListener('click', () => this.onAdd?.(this.groupId));
		return row;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** Applies `baseClass` (plus `-first`/`-last` boundary modifiers) as a line
 *  decoration across `[fromLine, toLine)` (0-based, exclusive) — the shared
 *  box-chrome primitive behind both the outer (whole group) and inner (one
 *  branch's own body) boxes. A no-op if the range is empty (a branch with no
 *  body typed yet). */
function pushBoxLines(
	state: EditorState,
	entries: { from: number; to: number; deco: Decoration }[],
	fromLine: number,
	toLine: number,
	baseClass: string
): void {
	const docLines = state.doc.lines;
	for (let ln = fromLine; ln < toLine && ln < docLines; ln++) {
		const docLine = state.doc.line(ln + 1);
		let cls = baseClass;
		if (ln === fromLine) cls += ` ${baseClass}-first`;
		if (ln === toLine - 1 || ln === docLines - 1) cls += ` ${baseClass}-last`;
		entries.push({ from: docLine.from, to: docLine.from, deco: Decoration.line({ class: cls }) });
	}
}

/**
 * Every branch-card widget's own ROOT element needs this — a real,
 * confirmed bug (not a guess: reproduced live in a headless browser
 * mounting the actual component, per this feature's own investigation)
 * found in every one of the widget classes above: CM6 inserts an invisible
 * `cm-widgetBuffer` placeholder element on each side of a non-block
 * `Decoration.replace` widget (for cursor-positioning purposes), which puts
 * the widget's own root element inside what the BROWSER treats as an
 * inline formatting context. A `display: block`/`flex` root there (the
 * default for a plain `<div>`, and what `.loom-branch-label-row`'s own
 * `display: flex` gives these rows) is a BLOCK-level box sitting inside
 * that inline context — the browser's own anonymous-block-box generation
 * rules then split the line's content around it, and the resulting phantom
 * spacing was measured, live, at MORE than double the widget's own real
 * rendered height (a 29px-tall row inside a 67px-tall `.cm-line`) — this
 * was the actual cause of the reported "big gap between rows," not
 * anything in the surrounding document TEXT. `inline-flex`/`inline-block`
 * (inline-outside, same internal layout otherwise) fixes it outright, no
 * phantom spacing at all; `width: 100%` is required alongside it since an
 * inline-level box shrink-wraps its own content by default, unlike the
 * block-level default this replaces. Applied as a CSS class carrying
 * `!important` on each property (styles.css `.loom-fountain-branch-row-
 * inline-flex`/`-inline-block`) rather than an inline style — these values
 * are static, never computed at runtime, and this codebase's own ESLint
 * rule (`obsidianmd/no-static-styles-assignment`) reserves `setCssProps`
 * for genuinely dynamic ones; `!important` is what guarantees this wins
 * regardless of which REUSED class (`.loom-branch-label-row`, `.loom-
 * branch-title-preview`, …) a given row also carries, or which order they
 * happen to appear in the stylesheet.
 */
function fixWidgetRowDisplay(row: HTMLElement, display: 'inline-flex' | 'inline-block'): void {
	row.addClass(display === 'inline-flex' ? 'loom-fountain-branch-row-inline-flex' : 'loom-fountain-branch-row-inline-block');
}

export const FountainField = forwardRef(function FountainField(
	{
		value,
		onChange,
		onBlur,
		characters,
		entityOptions,
		onOpenCharacter,
		onOpenLocation,
		onOpenAct,
		onOpenEntity,
		comments,
		altText,
		onCreateComment,
		onCreateAlt,
		onOpenComment,
		onCycleAlt,
		onOpenAltMenu,
		highlightedAnnotationId,
		ambientSuggestDismissMs,
		ambientExcludeEntityName,
		onGeometryChange,
		onCreateBranch,
		onPasteBranchGroup,
		branchClipboardAvailable,
		onCutBranchGroup,
		onCopyBranchGroup,
		embeddedBranchCards = false,
		onRenameBranchTitle,
		onSetBranchCombo,
		onSetBranchRaw,
		onDeleteBranch,
		onAddBranch,
		pendingTitleFocusId,
		onTitleFocusConsumed,
		showAnnotationGutter = true,
		escapeOverflowForTooltips = false,
	}: {
		value: string;
		/** `urgent` is `true` only for a transaction CM6's own `history()`
		 *  tags `userEvent: 'undo'`/`'redo'` (confirmed against the real
		 *  `@codemirror/commands` source, not guessed) — a real, reported
		 *  bug: a caller that only debounces its own disk write (the Scene
		 *  page's own idle-autosave, entity-view.tsx) could lose an undo/redo
		 *  entirely if the user acted again (e.g. pasted a SECOND time)
		 *  before that debounce fired — the second paste reads fresh from
		 *  DISK, which still held the pre-undo state, silently reviving what
		 *  had just been undone in the visible editor. `urgent` tells the
		 *  caller to flush THIS change to disk immediately instead of
		 *  waiting out its own debounce, closing that race. Every other
		 *  change (plain typing) still gets `urgent: false`. */
		onChange: (value: string, urgent: boolean) => void;
		/** Fires once, on losing focus — mirrors the old textarea's onBlur,
		 *  which is where `ensureSceneIds`/`syncScenes` actually run. */
		onBlur?: () => void;
		/** Existing character names — the character-cue autocomplete only
		 *  offers names that already exist (creating a brand new one is
		 *  still just typing it; the parser doesn't need it pre-declared). */
		characters: string[];
		/** Characters/factions/locations/items offered by the `@[` inline
		 *  entity-link autocomplete and resolved for click-to-navigate — unlike
		 *  `characters` above, an `@[...]` link never auto-creates, so only
		 *  entities that already exist are ever offered. */
		entityOptions?: { name: string; type: EntityType; path: string }[];
		/** A character cue line was clicked. */
		onOpenCharacter?: (name: string) => void;
		/** A scene heading was clicked — passed the scene's `[[loom:…]]` id
		 *  so the caller can resolve it to the Scene note's own location
		 *  (sublocation-aware), rather than the raw heading text. */
		onOpenLocation?: (sceneLoomId: string) => void;
		/** A `#` act heading was clicked — passed the section's own
		 *  `[[loom:…]]` id (only ever present on level-1 sections). */
		onOpenAct?: (actLoomId: string) => void;
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
		/** Ambient link suggester (link-suggest-cm6.ts) — always on. */
		ambientSuggestDismissMs?: number;
		/** This project's own current entity's name — suppresses ambient
		 *  suggestions offering to link it to itself. Only meaningful on a
		 *  Character/Faction/Location/Item's own embedded Script section;
		 *  the main Script view (no single "current entity") leaves it unset. */
		ambientExcludeEntityName?: string;
		/** Fires on every CM6 update where `viewportChanged || geometryChanged`
		 *  — i.e. exactly the signal `AnnotationHandlesOverlay`'s own
		 *  `update()` (below) already uses to know it needs to resync.
		 *  `BranchOverlay` (branch-overlay.tsx) is the one consumer: as a
		 *  plain React component with no access to CM6's update stream, DOM
		 *  events alone (scroll/resize) weren't enough to catch every moment
		 *  CM6's own internal layout genuinely changes — a real, reported bug
		 *  where cards rendered a few pixels off on first mount and only
		 *  self-corrected on the next scroll (which happens to force CM6 to
		 *  reprocess its own viewport) is exactly this gap. */
		onGeometryChange?: () => void;
		/** A right-click landed on an EMPTY line, not inside any existing
		 *  branch group — offers "Create new branch" (the modular branch
		 *  editor's `new-group` draft). Passed the clicked document position
		 *  (a character offset) so the caller can hand it straight to
		 *  `createDraftAnchor`. */
		onCreateBranch?: (pos: number) => void;
		/** A right-click landed on an EMPTY line and the caller's own
		 *  in-memory branch clipboard (`branchClipboardAvailable`) has
		 *  something in it — offers "Paste branch group", passed the 0-based
		 *  line clicked. The caller re-validates the line is STILL empty at
		 *  paste time (`pasteBranchGroup`, fountain.ts) rather than trusting
		 *  this snapshot, in case a concurrent edit landed in between. */
		onPasteBranchGroup?: (line: number) => void;
		/** Whether the caller's own branch clipboard currently holds a cut
		 *  decision point — gates whether "Paste branch group" is offered at
		 *  all. A plain boolean, not the clipboard's own content: this field
		 *  never needs to read what's IN it, only whether the menu item
		 *  should appear. */
		branchClipboardAvailable?: boolean;
		/** Fires when "Cut branch group" is chosen from the right-click menu on
		 *  a line inside an existing decision point (`embeddedBranchCards` on —
		 *  the group is resolved via `branchGroupAtLine`, below) — removes the
		 *  WHOLE decision point from the document and stashes it in the
		 *  caller's own in-memory branch clipboard. */
		onCutBranchGroup?: (groupId: string) => void;
		/** Fires when "Copy branch group" is chosen — same in-memory branch
		 *  clipboard as `onCutBranchGroup`, but the source stays in the
		 *  document untouched. A later "Paste branch group" of a copy that's
		 *  still present renumbers/re-ids the incoming block automatically
		 *  (`pasteBranchGroup`, fountain.ts) — pasting a cut (whose source is
		 *  already gone) always travels verbatim instead. */
		onCopyBranchGroup?: (groupId: string) => void;
		/** **Embedded branch cards.** When `true`, every branch group in the
		 *  document renders its own chrome (`###`/`= branch:`/`>**Title**<`/
		 *  `= gather` — all display-only, per the design: the real syntax is
		 *  replaced by input widgets/labels, never left as raw text to edit
		 *  directly) laid DIRECTLY over its own real document range — no
		 *  second copy of the text, unlike `branch-overlay.tsx`'s old
		 *  `position: fixed` real cards (replaced entirely by this). Every
		 *  sibling branch in a group renders simultaneously, stacked in
		 *  document order (no tab-switching, no folding) — a branch's own
		 *  PROSE BODY is left completely untouched, real, always-visible
		 *  document text, which is what makes native cut/copy/paste on it
		 *  just work. Only the metadata lines around each body (heading/tag/
		 *  preview/gather) become widgets; see `buildDecorations`'s own
		 *  "Embedded branch cards" section for the full mechanism, and each
		 *  widget class's own doc comment for its write path. Default
		 *  `false` — the Scene page's own Script section is the only caller
		 *  that turns this on today. */
		embeddedBranchCards?: boolean;
		/** A branch's own Title field committed a new value (blur, non-empty,
		 *  changed) — `renameSectionTitle` (fountain.ts) through
		 *  `mutateScriptBufferAndFlush`, mirroring `BranchOverlay`'s identical
		 *  prop of the same name. */
		onRenameBranchTitle?: (sectionId: string, newTitle: string) => void;
		/** The group's FIRST branch's decomposed Identifier/Subidentifier/
		 *  Number fields committed — every sibling sharing the group's value
		 *  moves together (`setBranchTagValue`, fountain.ts). Every OTHER
		 *  sibling's own copy of this row renders disabled, mirroring the
		 *  first branch's current value — real text really does repeat
		 *  identically on every branch's own `= branch:` line (that's what
		 *  groups them), so showing it there too keeps the chrome a faithful
		 *  mirror of the document, while edits are only ever accepted through
		 *  this one (first branch's) path. */
		onSetBranchCombo?: (groupId: string, identifier: string, subidentifier: string, numberOrOverride: string) => void;
		/** The group's first branch's single plain field committed — a legacy
		 *  value that doesn't decompose into 3 dash-separated segments,
		 *  rewritten verbatim. */
		onSetBranchRaw?: (groupId: string, newValue: string) => void;
		/** A branch's own delete (trash) button — `removeBranchFromGroup`
		 *  (fountain.ts) through the caller's own confirm dialog; mirrors
		 *  `BranchOverlay`'s identical prop. */
		onDeleteBranch?: (sectionId: string) => void;
		/** The group's own "+" (rendered after its `= gather` label, or after
		 *  the last branch's own body when the group has none) — writes a
		 *  real new branch to the document immediately; mirrors
		 *  `BranchOverlay`'s identical prop. */
		onAddBranch?: (groupId: string) => void;
		/** The section id of a branch just created via `onAddBranch`, still
		 *  waiting for its own Title field to claim the one-shot "show blank,
		 *  not the underlying `'Untitled'` placeholder, and steal focus"
		 *  treatment — mirrors `BranchOverlay`'s identical prop pair (see its
		 *  own doc comment for the full reasoning). */
		pendingTitleFocusId?: string | null;
		/** Fired once, the instant the pending id above has actually been
		 *  claimed by its own Title widget's first mount. */
		onTitleFocusConsumed?: () => void;
		/** Whether to mount the right-side comment/alt-text gutter at all —
		 *  default `true` (every existing caller: the main Script view, the
		 *  Scene/Act pages). Meant for a caller that never wires up
		 *  `comments`/`altText`: the gutter would otherwise render as a
		 *  permanently empty column, and being CM6's own `gutter()`
		 *  extension, it still reserves real horizontal space for that
		 *  column regardless of whether any line ever has a marker,
		 *  narrowing `.cm-content`'s own available width on the side it
		 *  sits on (`side: 'after'`, i.e. the right) relative to a field
		 *  with no gutter at all. */
		showAnnotationGutter?: boolean;
		/** Mounts CM6's own `tooltips({ parent: document.body })` extension —
		 *  default `false`. Originally assumed CM6's own default tooltip
		 *  container was fine for any field not nested inside a clipped
		 *  ancestor (Obsidian's own workspace-leaf DOM applies CSS `contain`,
		 *  the same thing that re-bases a bare `position: fixed` to the leaf
		 *  instead of the true viewport) — WRONG, a real, reported bug: even
		 *  the Scene page's own main (non-nested) field showed the
		 *  character-cue autocomplete popup extending the SCROLLABLE
		 *  CONTAINER's own layout downward near the bottom of a long scene,
		 *  rather than floating over existing content as a true overlay,
		 *  since CM6's default tooltip host isn't positioned independently of
		 *  that container's own normal document flow. `document.body` fixes
		 *  both this and the originally-documented clipped-ancestor case: CM6
		 *  measures real viewport space once tooltips live there, which is
		 *  also what lets it auto-flip a popup upward on its own when there's
		 *  no room below, no separate flip logic needed here. */
		escapeOverflowForTooltips?: boolean;
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
	const entityOptionsRef = useRef(entityOptions ?? []);
	const onOpenCharacterRef = useRef(onOpenCharacter);
	const onOpenLocationRef = useRef(onOpenLocation);
	const onOpenActRef = useRef(onOpenAct);
	const onOpenEntityRef = useRef(onOpenEntity);
	const commentsRef = useRef(comments ?? {});
	const altTextRef = useRef(altText ?? {});
	const onCreateCommentRef = useRef(onCreateComment);
	const onCreateAltRef = useRef(onCreateAlt);
	const onOpenCommentRef = useRef(onOpenComment);
	const onCycleAltRef = useRef(onCycleAlt);
	const onOpenAltMenuRef = useRef(onOpenAltMenu);
	const highlightedAnnotationIdRef = useRef(highlightedAnnotationId ?? null);
	const ambientDismissMsRef = useRef(ambientSuggestDismissMs ?? 0);
	const ambientExcludeNameRef = useRef(ambientExcludeEntityName);
	const onGeometryChangeRef = useRef(onGeometryChange);
	const onCreateBranchRef = useRef(onCreateBranch);
	const onPasteBranchGroupRef = useRef(onPasteBranchGroup);
	const branchClipboardAvailableRef = useRef(branchClipboardAvailable ?? false);
	const onCutBranchGroupRef = useRef(onCutBranchGroup);
	const onCopyBranchGroupRef = useRef(onCopyBranchGroup);
	const onRenameBranchTitleRef = useRef(onRenameBranchTitle);
	const onSetBranchComboRef = useRef(onSetBranchCombo);
	const onSetBranchRawRef = useRef(onSetBranchRaw);
	const onDeleteBranchRef = useRef(onDeleteBranch);
	const onAddBranchRef = useRef(onAddBranch);
	const pendingTitleFocusIdRef = useRef(pendingTitleFocusId ?? null);
	const onTitleFocusConsumedRef = useRef(onTitleFocusConsumed);
	/** A branch group's own section id, set the instant `promoteTypedBranch`
	 *  (fountain.ts) fires from the typed `### Title` + `= branch:` trigger
	 *  below — purely internal, never backed by a React prop like
	 *  `pendingTitleFocusIdRef` above: the whole flow (detect the typed
	 *  colon, transform the text, focus the new combo) has to complete
	 *  within ONE synchronous CM6 transaction (the field stays FOCUSED
	 *  throughout, so a change routed through React state/
	 *  `mutateScriptBufferAndFlush` instead would only reach this field via
	 *  the external-value-sync effect below — which even with its own
	 *  `pendingExternalValueRef` stash, below, wouldn't apply until the
	 *  user's NEXT blur, far too late to focus a combo that needs to exist
	 *  right now), so there's no React round-trip to plumb a prop through in
	 *  the first place. */
	const pendingComboFocusIdRef = useRef<string | null>(null);
	/** An external `value` change that arrived while this field was FOCUSED —
	 *  stashed here instead of silently dropped (a real, confirmed gap: the
	 *  value-sync effect below only ever applies while unfocused, and only
	 *  re-checks when `value` itself changes again, so a blur alone never
	 *  revisited a change it had skipped). Applied once focus is actually
	 *  lost, from the update listener's own blur branch below. `null` = no
	 *  pending change. */
	const pendingExternalValueRef = useRef<string | null>(null);
	onGeometryChangeRef.current = onGeometryChange;
	onCreateBranchRef.current = onCreateBranch;
	onPasteBranchGroupRef.current = onPasteBranchGroup;
	branchClipboardAvailableRef.current = branchClipboardAvailable ?? false;
	onCutBranchGroupRef.current = onCutBranchGroup;
	onCopyBranchGroupRef.current = onCopyBranchGroup;
	onRenameBranchTitleRef.current = onRenameBranchTitle;
	onSetBranchComboRef.current = onSetBranchCombo;
	onSetBranchRawRef.current = onSetBranchRaw;
	onDeleteBranchRef.current = onDeleteBranch;
	onAddBranchRef.current = onAddBranch;
	pendingTitleFocusIdRef.current = pendingTitleFocusId ?? null;
	onTitleFocusConsumedRef.current = onTitleFocusConsumed;
	onChangeRef.current = onChange;
	onBlurRef.current = onBlur;
	charactersRef.current = characters;
	entityOptionsRef.current = entityOptions ?? [];
	onOpenCharacterRef.current = onOpenCharacter;
	onOpenLocationRef.current = onOpenLocation;
	onOpenActRef.current = onOpenAct;
	onOpenEntityRef.current = onOpenEntity;
	commentsRef.current = comments ?? {};
	altTextRef.current = altText ?? {};
	onCreateCommentRef.current = onCreateComment;
	onCreateAltRef.current = onCreateAlt;
	onOpenCommentRef.current = onOpenComment;
	onCycleAltRef.current = onCycleAlt;
	onOpenAltMenuRef.current = onOpenAltMenu;
	ambientDismissMsRef.current = ambientSuggestDismissMs ?? 0;
	ambientExcludeNameRef.current = ambientExcludeEntityName;
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
		replaceBody: (newValue, cursorLine) => {
			const view = viewRef.current;
			if (!view) return;
			const lines = newValue.split('\n');
			const target = Math.min(Math.max(cursorLine, 0), lines.length - 1);
			let offset = 0;
			for (let i = 0; i < target; i++) offset += lines[i].length + 1;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: newValue },
				selection: { anchor: offset },
			});
			view.focus();
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
		getView: () => viewRef.current,
		createDraftAnchor: (pos: number) => {
			const id = `branch-draft-${Math.random().toString(36).slice(2)}`;
			viewRef.current?.dispatch({ effects: setDraftAnchor.of({ id, pos }) });
			return id;
		},
		getDraftAnchorLine: (id: string) => {
			const view = viewRef.current;
			if (!view) return null;
			const pos = view.state.field(draftAnchors, false)?.get(id);
			if (pos === undefined) return null;
			return view.state.doc.lineAt(pos).number - 1;
		},
		clearDraftAnchor: (id: string) => {
			viewRef.current?.dispatch({ effects: clearDraftAnchorEffect.of(id) });
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

			/** `sync()` reads layout via `coordsAtPos`, and CM6 forbids that
			 *  synchronously in more places than just "the constructor" — a
			 *  regular `update()` call CAN also land inside a forbidden window
			 *  (confirmed live: this exact `update()` → `sync()` path crashed
			 *  with "Reading the editor layout isn't allowed during an update"
			 *  when a transaction dispatched very early, e.g. during a
			 *  scroll/selection restore right on file open, before CM6's view
			 *  had finished its own bootstrap). Routing EVERY trigger
			 *  (constructor and update() alike) through one coalesced scheduler
			 *  — never calling `sync()` synchronously from ANY CM6-invoked
			 *  callback — is what closes off the whole class of bug, rather
			 *  than chasing individual call sites one at a time. **`setTimeout`,
			 *  not `requestAnimationFrame`**: a first attempt at this used rAF
			 *  and STILL crashed live — CM6 schedules its own internal measure
			 *  work via `requestAnimationFrame` too (confirmed in its own stack
			 *  trace), so our rAF callback and CM6's can land in the exact same
			 *  animation frame, still inside the same forbidden window; a
			 *  `setTimeout` runs in a genuinely separate macrotask, after the
			 *  browser has fully drained the current frame's rAF queue. */
			private scheduleSync() {
				if (this.syncQueued) return;
				this.syncQueued = true;
				this.view.dom.win.setTimeout(() => {
					this.syncQueued = false;
					if (!this.destroyed) this.sync();
				}, 0);
			}

			sync() {
				// Guards `onAnyScroll`'s own deferred `view.plugin(...)?.sync()` call
				// below (a `document`-level capture listener outliving THIS specific
				// view, unlike every other trigger which already funnels through
				// `scheduleSync`'s own `destroyed` check): a real, reported leak — a
				// scroll event queued right as the field tears down still fired its
				// `setTimeout` callback AFTER `destroy()` had already run, and this
				// method had no guard of its own, so it went ahead and re-created
				// fresh handle spans on `document.body` that nothing was left to ever
				// remove (`destroy()` doesn't run twice) — two small accent bars stuck
				// at a fixed screen position for the rest of the session, visible on
				// every subsequent page regardless of which view was open.
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
				// A DIFFERENT, real leak vector with the SAME symptom: Obsidian
				// keeps a background tab's DOM around, just hidden (`offsetParent`
				// goes `null` — the standard "is this actually rendered right now"
				// check) — not detached, so the check above doesn't catch it. These
				// handles are `position: fixed` on `document.body`, which a hidden
				// ANCESTOR doesn't clip at all, so leaving them at their last-
				// computed screen coordinates showed them floating over WHATEVER
				// tab the user actually switched to. Hide rather than destroy —
				// this tab isn't gone, just not the active one right now, and
				// `sync()` repositions them normally the next time it runs while
				// visible again.
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
						// Belt-and-suspenders on top of `scheduleSync()` deferring
						// every CALLER of `sync()` — if `coordsAtPos` still somehow
						// throws (confirmed live to be reachable from more than one
						// call site; see `scheduleSync`'s own doc comment), catching
						// it here keeps this ONE frame's positioning a no-op instead
						// of crashing the whole plugin, and the very next trigger
						// (the next real update, or the editor's own viewport/
						// geometry change) gets another chance to position correctly.
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
		const annotationHandlesOverlay = ViewPlugin.fromClass(AnnotationHandlesOverlay);

		/** Builds every branch group's chrome for the CURRENT parse — see this
		 *  file's own "Embedded branch cards" doc comment (above
		 *  `BranchHeaderRowWidget`) for the design. Returns the widget/box-line
		 *  decorations to add AND the raw `[from, to)` ranges they fully
		 *  replace (the `###`/`= branch:`/`>**Title**<` lines) — the caller
		 *  filters every OTHER pass's own decorations against `replaced`
		 *  before merging these in, since a non-block `Decoration.replace`
		 *  isn't allowed to CONTAIN another one (this line's `[[loom:<id>]]`
		 *  hider, and — for the title-preview line specifically — `**bold**`
		 *  emphasis marks, would otherwise land nested inside these). */
		function buildBranchGroupDecorations(
			view: EditorView,
			parsed: ParsedScript
		): { decos: { from: number; to: number; deco: Decoration }[]; replaced: { from: number; to: number }[] } {
			const docLines = view.state.doc.lines;
			const lines = view.state.doc.toString().split(/\r?\n/);
			const decos: { from: number; to: number; deco: Decoration }[] = [];
			const replaced: { from: number; to: number }[] = [];
			const replaceLine = (line0: number, widget: WidgetType) => {
				if (line0 >= docLines) return;
				const docLine = view.state.doc.line(line0 + 1);
				decos.push({ from: docLine.from, to: docLine.to, deco: Decoration.replace({ widget }) });
				if (docLine.to > docLine.from) replaced.push({ from: docLine.from, to: docLine.to });
			};

			const seenGroups = new Set<string>();
			for (const sec of parsed.sections) {
				if (sec.branchGroup === null || seenGroups.has(sec.branchGroup)) continue;
				seenGroups.add(sec.branchGroup);
				const bounds = branchGroupBounds(parsed, sec.branchGroup);
				if (!bounds || bounds.branches.length === 0) continue;
				const groupId = sec.branchGroup;

				// Each sibling's own [startLine, endLine) — 0-based, exclusive —
				// up to its next sibling, or the group's own gather line/overall
				// end for the last one.
				const spans = bounds.branches.map((branchSection, i) => ({
					section: branchSection,
					startLine: branchSection.line,
					endLine:
						i + 1 < bounds.branches.length ? bounds.branches[i + 1].line : (bounds.gatherLine ?? bounds.end),
				}));

				// Outer box across the WHOLE group — every branch, the gather
				// line, all of it.
				pushBoxLines(view.state, decos, bounds.start, bounds.end, 'loom-fountain-branch-group-line');

				for (const { section: branchSection, startLine, endLine } of spans) {
					const isFirst = branchSection.loomId === bounds.branches[0].loomId;
					const tagLine = startLine + 1;

					replaceLine(
						startLine,
						new BranchHeaderRowWidget(
							branchSection.loomId,
							branchSection.text,
							branchSection.loomId === pendingTitleFocusIdRef.current,
							onRenameBranchTitleRef.current,
							onDeleteBranchRef.current,
							onTitleFocusConsumedRef.current
						)
					);
					replaceLine(
						tagLine,
						new BranchComboRowWidget(
							groupId,
							isFirst,
							onSetBranchComboRef.current,
							onSetBranchRawRef.current,
							isFirst && branchSection.loomId === pendingComboFocusIdRef.current,
							() => {
								pendingComboFocusIdRef.current = null;
							}
						)
					);

					// `branchLabelEndLine` (fountain.ts) is the SAME scan
					// `branchBodyText`/`replaceBranchBody` already use to find
					// where a branch's body starts — reused rather than a
					// second ad-hoc search, and correctly tolerant of however
					// many (zero or more) blank lines currently sit between the
					// tag and the label. Its return value IS the body-start
					// line; the label itself, if found, is the line right
					// before it. Absent right after a hand-typed branch that
					// hasn't gone through a commit yet — the raw line just
					// stays visible in that brief window rather than forcing a
					// guess at where it WOULD go.
					const bodyStart = Math.min(branchLabelEndLine(lines, startLine), endLine);
					const labelLine = bodyStart - 1;
					const labelFound = labelLine > tagLine && /^>.*<$/.test(lines[labelLine]?.trim() ?? '');
					if (labelFound) {
						replaceLine(labelLine, new BranchTitlePreviewWidget(branchSection.loomId, branchSection.text));
					}
					// Any blank line(s) still sitting between the tag and the
					// label render as a full line-height gap regardless of
					// their CONTENT being hidden — a blank `.cm-line` still
					// occupies its own line-height, the same reason hiding it
					// via a decoration alone (rather than editing it out of the
					// document) can't close the gap. `collapseBranchBlankLines`
					// (fountain.ts, runs on every commit) is the real, permanent
					// fix for the TEXT — this is the immediate, render-only
					// compensation for whatever's on disk RIGHT NOW, so a
					// pre-existing branch that hasn't been through a fresh
					// commit yet (or one hand-typed with extra blank padding)
					// doesn't show a stale gap in the meantime. Compacted via
					// `font-size`/`line-height` only, never a block-level
					// decoration spanning the newline (the earlier, crash-prone
					// attempt at truly REMOVING a blank line's own height from
					// rendering) — the line stays a completely ordinary,
					// real, clickable/editable blank line, just visually thin.
					if (labelFound) {
						for (let ln = tagLine + 1; ln < labelLine; ln++) {
							if (ln >= docLines) break;
							const spacerLine = view.state.doc.line(ln + 1);
							decos.push({
								from: spacerLine.from,
								to: spacerLine.from,
								deco: Decoration.line({ class: 'loom-fountain-branch-spacer-line' }),
							});
						}
					}

					// The branch's own real prose body — box chrome only, the
					// text itself untouched, so native cut/copy/paste on it is
					// just ordinary CM6 editing.
					pushBoxLines(view.state, decos, bodyStart, endLine, 'loom-fountain-branch-body-line');
				}

				if (bounds.gatherLine !== null) {
					replaceLine(bounds.gatherLine, new BranchGatherRowWidget(groupId, onAddBranchRef.current));
				} else {
					// No gather to attach to (a hand-typed/imported script only —
					// every group created through the app has one from birth) —
					// append the "+" as its own row right after the last
					// branch's own last line instead.
					const lastSpan = spans[spans.length - 1];
					const lastLine = Math.max(lastSpan.endLine - 1, lastSpan.startLine);
					if (lastLine < docLines) {
						const lastDocLine = view.state.doc.line(lastLine + 1);
						decos.push({
							from: lastDocLine.to,
							to: lastDocLine.to,
							deco: Decoration.widget({ widget: new BranchAddRowWidget(groupId, onAddBranchRef.current), side: 1 }),
						});
					}
				}
			}
			return { decos, replaced };
		}

		/** A scene/section's own raw line, decorated once per physical line a
		 *  merged multi-line element (dialogue can span several) actually
		 *  occupies — `element.line` is only the block's FIRST line. */
		function buildDecorations(view: EditorView): DecorationSet {
			const text = view.state.doc.toString();
			const parsed = parseFountain(text);
			const docLines = view.state.doc.lines;
			const entries: { from: number; to: number; deco: Decoration }[] = [];

			for (const element of parsed.elements) {
				// Sections get a level modifier class too (`-level-1/2/3`) so
				// "Follow theme text coloring" can map each depth to the
				// matching `--h1-color`/`--h2-color`/`--h3-color` the active
				// theme defines, instead of one flat color for every depth.
				const cls =
					element.type === 'section'
						? `${ELEMENT_CLASS[element.type]} loom-fountain-section-level-${element.level ?? 1}`
						: ELEMENT_CLASS[element.type];
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

				// Character cues are Ctrl/Cmd-clickable — the whole line, not
				// just the name substring (extensions like `(V.O.)` and the `^`
				// dual marker make carving out just the name fragile for no
				// real benefit; the line IS the cue). Modifier-gated in
				// `openLinkOnMousedown`, since a plain click has to stay free
				// to place the caret on the ONLY line that is this cue.
				if (element.type === 'character' && onOpenCharacterRef.current) {
					const docLine = view.state.doc.line(element.line + 1);
					if (docLine.text.trim() !== '') {
						entries.push({
							from: docLine.from,
							to: docLine.to,
							deco: Decoration.mark({
								class: 'loom-fountain-char-link',
								attributes: { 'data-loom-fountain-char': element.text, ...CLICK_TO_OPEN_ATTRS },
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
							attributes: { 'data-loom-fountain-scene': loomId, ...CLICK_TO_OPEN_ATTRS },
						}),
					});
				}

				// Only level-1 sections are Acts — a nested `##`/`###`
				// carries no act identity to open.
				if (element.type === 'section' && (element.level ?? 1) === 1 && loomId && onOpenActRef.current) {
					const docLine = view.state.doc.line(element.line + 1);
					entries.push({
						from: docLine.from,
						to: docLine.to,
						deco: Decoration.mark({
							class: 'loom-fountain-act-link',
							attributes: { 'data-loom-fountain-act': loomId, ...CLICK_TO_OPEN_ATTRS },
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

			// Embedded branch cards — see `buildBranchGroupDecorations`'s own
			// doc comment. Every OTHER pass's own content-spanning decoration
			// (a mark/replace/widget with `to > from` — zero-width `Decoration
			// .line` entries are a different, always-compatible category, never
			// filtered) is dropped if it overlaps a line this pass fully
			// replaces with its own widget — a non-block `Decoration.replace`
			// can't legally CONTAIN another one (this line's own `[[loom:<id>]]`
			// hider, and — on the title-preview line specifically — its
			// `**bold**` emphasis mark, would otherwise land nested inside it).
			let finalEntries = entries;
			if (embeddedBranchCards) {
				const { decos: branchDecos, replaced } = buildBranchGroupDecorations(view, parsed);
				// A REAL bug this used to have: a zero-width `Decoration.line`
				// entry (the ordinary per-element `ELEMENT_CLASS` line-class
				// pass, above — e.g. `loom-fountain-synopsis` on a `=`-prefixed
				// line) sits at `from === to === docLine.from`, exactly the
				// STARTING edge of a replaced range `[r.from, r.to)` — the old
				// overlap test (`e.from < r.to && e.to > r.from`) fails for
				// that exact case (`e.to > r.from` is false when `e.to ===
				// r.from`), so this used to wave every line-class entry through
				// UNCONDITIONALLY, on the theory that a line CLASS can't
				// "contain" a content replace the way a mark/replace decoration
				// can (true — nothing crashes) but wrong about styling: that
				// original element class kept fighting my own widget's classes
				// for CSS specificity on the exact same `.cm-line`, and
				// sometimes won (`.loom-fountain-field .cm-line.loom-fountain-
				// synopsis`'s 3-class selector beating my own 2-class scoped
				// override — confirmed live via DevTools). Fixed with a proper
				// half-open-interval containment check that treats a
				// zero-width point as "inside" `[r.from, r.to)` when
				// `r.from <= e.from < r.to`, and drops EVERY entry (line-class
				// included) on a line this pass fully replaces — nothing from
				// the original per-element pass belongs there any more, the
				// widget is now that line's entire visual representation.
				const overlapsReplaced = (e: { from: number; to: number }) =>
					replaced.some((r) => (e.to === e.from ? e.from >= r.from && e.from < r.to : e.from < r.to && e.to > r.from));
				finalEntries = entries.filter((e) => !overlapsReplaced(e));
				finalEntries.push(...branchDecos);
			}

			finalEntries.sort((a, b) => a.from - b.from || a.to - b.to);
			return Decoration.set(
				finalEntries.map((e) => e.deco.range(e.from, e.to)),
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
					detail: entityLabel(e.type),
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

		/** A landing spot for `characterCompletion` to offer its FULL list on,
		 *  before anything's typed: an empty line right after a blank one (or
		 *  the document's first line). Doc changes only need checking on the
		 *  cursor's own line, but a same-line selection move (arrow keys, a
		 *  click) needs it too — CM6's built-in "activate on typing" never
		 *  fires for either, since neither types a character. */
		const emptyCueLine = (state: EditorState): boolean => {
			const pos = state.selection.main.head;
			const line = state.doc.lineAt(pos);
			if (line.text.trim() !== '') return false;
			return line.number <= 1 || state.doc.line(line.number - 1).text.trim() === '';
		};

		const openLinkOnMousedown = (event: MouseEvent): boolean => {
			if (event.button !== 0) return false;
			// Ctrl/Cmd-gated, unlike markdown-field.tsx's plain-click wikilinks —
			// there, the rendered link is only ever a SHORT span with ordinary
			// editable text around it on the same line, so clicking just past it
			// still places a cursor normally. A character cue or an act's `#`
			// line is marked end-to-end (see the comment below on why it can't be
			// carved down to just the name), so a plain click ANYWHERE on that
			// line's actual text had no way to fall through to the default
			// caret-placement behavior — every click meant to edit the name
			// instead navigated away (and, since `preventDefault` also blocks the
			// browser from moving native selection, a follow-up arrow-key press
			// then moved relative to wherever the caret silently still was,
			// reading as "arrow keys skip this line").
			if (!(event.ctrlKey || event.metaKey)) return false;
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
			const act = target?.closest('[data-loom-fountain-act]');
			if (act instanceof HTMLElement && act.dataset.loomFountainAct && onOpenActRef.current) {
				event.preventDefault();
				onOpenActRef.current(act.dataset.loomFountainAct);
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

		/** Reads the real OS clipboard — the one thing genuinely new here:
		 *  nothing else in this codebase touches `navigator.clipboard` (the
		 *  "branch clipboard", branch-clipboard.ts, is a separate in-memory,
		 *  plugin-only mechanism for moving a whole decision point, kept
		 *  deliberately off the OS clipboard). Returns `null` on an empty
		 *  clipboard (silently — an empty native paste is a no-op, not an
		 *  error) or a genuine read failure (permission denied — surfaced
		 *  with a Notice, since that's not something the user can fix by
		 *  just trying again). */
		const readClipboardText = async (): Promise<string | null> => {
			try {
				const text = await navigator.clipboard.readText();
				return text.length > 0 ? text : null;
			} catch {
				new Notice(t('view.script.contextMenu.clipboardReadFailed'));
				return null;
			}
		};

		/** Writes to the real OS clipboard, surfacing a Notice on failure
		 *  (mirrors `readClipboardText` above) rather than a silent no-op —
		 *  a failed Cut/Copy with no feedback would look like it worked. */
		const writeClipboardText = async (text: string): Promise<void> => {
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				new Notice(t('view.script.contextMenu.clipboardWriteFailed'));
			}
		};

		/** The ONE contextmenu handler for this editor, replacing Electron's
		 *  own native menu entirely — Cut/Copy/Paste, Comment/Alternative
		 *  text, Create branch/Paste branch group, always in that section
		 *  order. Every item is always PRESENT, enabled or disabled by
		 *  context (never conditionally shown), so the menu never changes
		 *  shape depending on where the click landed — a disabled item just
		 *  explains why in its own title.
		 *
		 *  Resolving the clicked position with `precise: false` is what
		 *  actually fixes a real, previously unexplained bug: right-clicking
		 *  the first/last VISIBLE line fell through to the native menu.
		 *  CM6's `posAtCoords` returns `null` when the clicked point maps to
		 *  a line outside its OWN currently-rendered viewport window (CM6
		 *  virtualizes — only a margin around the visible area is real DOM
		 *  at any moment), and the previous version of this handler treated
		 *  a `null` as "nothing to do here" and returned `false` — which,
		 *  for a CM6 `domEventHandlers` callback, means CM6 never calls
		 *  `preventDefault()`, so the native menu shows through underneath.
		 *  `precise: false` (the same flag CM6's own internal mouse/drag
		 *  handling always passes for this exact reason) falls back to a
		 *  best-effort estimate instead of `null`, so this handler always
		 *  has a position to reason from and always ends up calling
		 *  `preventDefault()` itself. */
		/** Shared eligibility check behind "Create branch"/"Paste branch
		 *  group" — a bare caret on a blank line not already inside a
		 *  decision point. Used by both `openContextMenu` (below) and the
		 *  `paste` DOM event interception further down, so a cut-or-copied
		 *  branch group can be pasted either through the right-click menu OR
		 *  a plain Ctrl/Cmd+V, with the identical rule for where it's
		 *  allowed to land. */
		const branchSlotEligibleAt = (view: EditorView, line0: number): boolean => {
			const doc = view.state.doc;
			const isEmptyLine = doc.line(line0 + 1).text.trim() === '';
			if (!isEmptyLine) return false;
			const parsed = parseFountain(doc.toString());
			return branchGroupAtLine(parsed, line0) === null;
		};

		const openContextMenu = (view: EditorView, event: MouseEvent): boolean => {
			event.preventDefault();
			event.stopPropagation();
			const sel = view.state.selection.main;
			const hasSelection = !sel.empty;
			const doc = view.state.doc;
			const pos = hasSelection
				? sel.head
				: (view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? doc.length);
			const line0 = doc.lineAt(pos).number - 1;
			// A branch's own PROSE BODY is real, unreplaced document text
			// (`embeddedBranchCards`'s own doc comment) — a right-click landing
			// there reaches this handler exactly like any other line, so
			// "Cut/Copy branch group" has to be derived from WHERE the click
			// landed rather than an explicit prop: whichever group (if any)
			// the click/selection's own line currently sits inside.
			const branchGroupId = embeddedBranchCards ? branchGroupAtLine(parseFountain(doc.toString()), line0) : null;

			// A selection that partially crosses an existing marked span
			// (nesting fully inside or sitting fully outside one is fine)
			// can't host a NEW comment/alt-text span — surfaced once, right
			// when the menu opens, same as before this menu was unified.
			const spans = hasSelection ? findAnnotationSpans(doc.toString()) : [];
			const overlapsSpan = hasSelection && spans.some((s) => partiallyOverlaps(sel.from, sel.to, s.from, s.to));
			if (overlapsSpan) new Notice(t('view.script.overlapNotice.create'));

			// Create branch / Paste branch group share the identical
			// eligibility (a bare caret on a blank line not already inside
			// a decision point). A right-click on a branch's own metadata
			// lines (heading/tag/preview/gather) never reaches this handler
			// at all — those are widget-replaced content, intercepted by the
			// widget's own DOM — but a right-click inside its real, unreplaced
			// PROSE BODY does, which is exactly what `branchGroupAtLine`
			// guards against here (that's a Cut/Copy-branch-group click, per
			// `branchGroupId` above, not a Create/Paste one). A disabled item
			// explains why with the one shared reason rather than each
			// re-deriving its own text.
			const branchSlotEligible = !hasSelection && branchSlotEligibleAt(view, line0);
			const branchSlotSuffix = branchSlotEligible ? '' : ` ${t('view.script.contextMenu.branchSlotDisabledReason')}`;

			// Obsidian's own `.menu-item.is-disabled` colors both text and
			// icon with `--text-faint` (confirmed against the extracted
			// app.css) — legible on Obsidian's own chrome, but reads as
			// barely dimmed against some themes' menu background, reported
			// directly against this menu. `MenuItem.dom` is a stable
			// (undocumented) internal — every `MenuItem` is built with
			// `this.dom = createDiv('menu-item tappable')` — used here only
			// to add one scoped class (styles.css) so a disabled item in
			// THIS menu specifically reads clearly paler, without touching
			// Obsidian's own menu styling everywhere else.
			const addMenuItem = (
				m: Menu,
				opts: { title: string; icon: string; disabled: boolean; onClick: () => void | Promise<void> }
			) => {
				m.addItem((item) => {
					item.setTitle(opts.title).setIcon(opts.icon).setDisabled(opts.disabled).onClick(opts.onClick);
					if (opts.disabled) {
						(item as unknown as { dom?: HTMLElement }).dom?.addClass('loom-fountain-menu-item-dim');
					}
				});
			};

			const menu = new Menu();

			addMenuItem(menu, {
				title: branchGroupId ? t('view.script.contextMenu.cutBranchGroup') : t('view.script.contextMenu.cut'),
				icon: 'scissors',
				disabled: branchGroupId ? !onCutBranchGroupRef.current : !hasSelection,
				onClick: branchGroupId
					? () => onCutBranchGroupRef.current?.(branchGroupId)
					: async () => {
							await writeClipboardText(view.state.sliceDoc(sel.from, sel.to));
							view.dispatch({ changes: { from: sel.from, to: sel.to } });
							view.focus();
						},
			});
			addMenuItem(menu, {
				title: branchGroupId ? t('view.script.contextMenu.copyBranchGroup') : t('view.script.contextMenu.copy'),
				icon: 'copy',
				disabled: branchGroupId ? !onCopyBranchGroupRef.current : !hasSelection,
				onClick: branchGroupId
					? () => onCopyBranchGroupRef.current?.(branchGroupId)
					: async () => {
							await writeClipboardText(view.state.sliceDoc(sel.from, sel.to));
						},
			});
			addMenuItem(menu, {
				title: t('view.script.contextMenu.paste'),
				icon: 'clipboard-paste',
				disabled: false,
				onClick: async () => {
					const text = await readClipboardText();
					if (text === null) return;
					const target = view.state.selection.main;
					view.dispatch({
						changes: { from: target.from, to: target.to, insert: text },
						selection: { anchor: target.from + text.length },
					});
					view.focus();
				},
			});
			addMenuItem(menu, {
				title: t('view.script.contextMenu.pasteBranchGroup') + branchSlotSuffix,
				icon: 'clipboard-paste',
				disabled: !branchSlotEligible || !branchClipboardAvailableRef.current || !onPasteBranchGroupRef.current,
				// Obsidian's `Menu` items are plain non-focusable divs, so
				// clicking one never blurs whatever had focus before the
				// right-click — but that's no longer this field's problem to
				// solve: the caller (`handlePasteBranchGroupInScene`,
				// entity-view.tsx) resyncs this field directly via
				// `replaceBody` once its own write lands, bypassing the
				// normal focus-gated sync entirely. See that method's own
				// doc comment for the fuller history (a real, reported
				// geometry-overlap bug that a blur-before-write fix here
				// used to paper over, and why that approach still wasn't
				// enough on its own).
				onClick: () => onPasteBranchGroupRef.current?.(line0),
			});

			menu.addSeparator();

			addMenuItem(menu, {
				title: t('view.script.contextMenu.comment'),
				icon: 'message-square',
				disabled: !hasSelection || overlapsSpan,
				onClick: () => insertMarkerPair(view, 'comment', sel.from, sel.to),
			});
			addMenuItem(menu, {
				title: t('view.script.contextMenu.altText'),
				icon: 'arrow-right-left',
				disabled: !hasSelection || overlapsSpan,
				onClick: () => insertMarkerPair(view, 'alt', sel.from, sel.to),
			});

			menu.addSeparator();

			addMenuItem(menu, {
				title: t('view.script.contextMenu.createBranch') + branchSlotSuffix,
				icon: 'git-branch-plus',
				disabled: !branchSlotEligible || !onCreateBranchRef.current,
				onClick: () => onCreateBranchRef.current?.(pos),
			});

			menu.showAtMouseEvent(event);
			return true;
		};

		/** A plain Ctrl/Cmd+V (native `paste` event) redirects to "Paste
		 *  branch group" when there's one to paste AND the caret sits
		 *  somewhere it could actually land (`branchSlotEligibleAt`, shared
		 *  with the right-click menu item above) — so a cut-or-copied
		 *  decision point can be pasted the ordinary keyboard way, not just
		 *  through the menu. Deliberately takes over the WHOLE paste in that
		 *  case, never falling through to also insert the OS clipboard's own
		 *  text: the two clipboards are separate (branch-clipboard.ts's own
		 *  doc comment), and there's no sane way to do both against the same
		 *  single caret position. Every other case (no branch clipboard, a
		 *  real selection, an ineligible line) returns `false` and lets CM6's
		 *  own default paste handling run exactly as before. */
		const handleBranchPasteShortcut = (view: EditorView, event: ClipboardEvent): boolean => {
			if (!onPasteBranchGroupRef.current || !branchClipboardAvailableRef.current) return false;
			const sel = view.state.selection.main;
			if (!sel.empty) return false;
			const line0 = view.state.doc.lineAt(sel.head).number - 1;
			if (!branchSlotEligibleAt(view, line0)) return false;
			event.preventDefault();
			onPasteBranchGroupRef.current(line0);
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
				return new AnnotationGutterMarker('loom-fountain', items);
			},
			lineMarkerChange: (update) =>
				update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations))),
			initialSpacer: () => new AnnotationGutterMarker('loom-fountain', []),
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

		/** Typing `:` completing a bare `= branch:` line directly beneath an
		 *  untagged section heading — the "last evidence" that the user just
		 *  hand-typed a branch into existence, an alternative to the
		 *  right-click "Create new branch" menu item that needs no menu at
		 *  all. `promoteTypedBranch` (fountain.ts) does the actual text
		 *  transform, in memory, no disk write — this has to land as ONE
		 *  synchronous CM6 transaction, not a round-trip through React state/
		 *  `mutateScriptBufferAndFlush` the way every OTHER branch mutation in
		 *  this codebase works: this fires while the field is still focused
		 *  (the user is mid-keystroke), and the external-value-sync effect
		 *  further down only ever applies a changed `value` prop while
		 *  UNFOCUSED (its own `pendingExternalValueRef` stash notwithstanding
		 *  — that only closes the gap until the NEXT blur, not "instantly") —
		 *  a change routed through React would sit invisible in the live
		 *  buffer until then, defeating "the instant `:` is typed."
		 *  Everything here reads/simulates against `v.state`, the state
		 *  BEFORE this pending keystroke lands (same convention
		 *  `entityBracketPairing` above already uses), never the actual
		 *  post-insertion document — there isn't one yet at this point. */
		const branchAutoCreate = EditorView.inputHandler.of((v, from, to, text) => {
			if (text !== ':' || from !== to) return false;
			const line = v.state.doc.lineAt(from);
			const resultingLine = `${v.state.sliceDoc(line.from, from)}:${v.state.sliceDoc(from, line.to)}`;
			// Same shape/tolerance as `BRANCH_TAG_RE` above (whitespace around
			// `=`, case-insensitive "branch"), just requiring an EMPTY tail
			// instead of `BRANCH_TAG_RE`'s own required non-empty one — this
			// bare shape is exactly what a real, already-tagged `= branch:`
			// line looks like BEFORE it has a value yet.
			if (!/^=\s*branch:\s*$/i.test(resultingLine.trim()) || line.number <= 1) return false;
			const headingLine0 = line.number - 2; // 0-based — the line directly above this one
			const headingLine = v.state.doc.line(headingLine0 + 1);
			const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(headingLine.text);
			if (!headingMatch) return false;
			// Confirm the heading is a genuine, untagged Fountain section —
			// `parseFountain` is what actually knows the grammar (a raw regex
			// match alone can't tell a real section from incidental text that
			// happens to start with `#`s), and confirms it isn't ALREADY part
			// of some other group (defensive; shouldn't be reachable in
			// ordinary typing, since a tagged section's `= branch:` line
			// already holds a real value, not this bare trigger shape).
			const parsed = parseFountain(v.state.doc.toString());
			const sec = parsed.sections.find((s) => s.line === headingLine0);
			if (!sec || sec.loomId !== null || sec.branchGroup !== null) return false;
			const fullTextAfter = `${v.state.sliceDoc(0, from)}:${v.state.sliceDoc(to)}`;
			const result = promoteTypedBranch(fullTextAfter, headingLine0, headingMatch[1].length, headingMatch[2]);
			if (!result) return false;
			pendingComboFocusIdRef.current = result.id;
			v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: result.text } });
			return true;
		});

		// Ambient link suggester (link-suggest-cm6.ts) — no caching here (unlike
		// markdown-field.tsx): `entityOptions` isn't memoized by its one real
		// caller (script-view.tsx builds it fresh every render), so a cache
		// keyed on reference identity would falsely invalidate constantly.
		// Rebuilding a plain Map from a project's own cast/location/item list
		// (realistically dozens to low hundreds of entries) on each ~150ms
		// debounced trigger is cheap enough to not need caching at all.
		const linkSuggestExt = buildLinkSuggestExtension({
			getCorpus: () => {
				const map = new Map<string, LinkSuggestEntry>();
				const exclude = ambientExcludeNameRef.current;
				for (const opt of entityOptionsRef.current) {
					if (exclude !== undefined && opt.name === exclude) continue;
					const key = opt.name.toLowerCase();
					if (!map.has(key)) map.set(key, { insert: `@[${opt.name}]`, displayLabel: opt.name });
				}
				return map;
			},
			getDismissMs: () => ambientDismissMsRef.current,
			maxPhraseWords: 5,
			isInsideOpenMarker: isInsideEntityLinkOpen,
			overlapsClosedLink: overlapsClosedEntityLink,
			shouldSkipLine: looksLikeNonProseLine,
			pillClass: 'loom-link-suggest-pill',
			ariaLabel: (entry) => t('common.linkSuggestAccept', { insert: entry.displayLabel }),
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
					...(showAnnotationGutter ? [annotationGutter] : []),
					...(escapeOverflowForTooltips ? [tooltips({ parent: document.body })] : []),
					annotationHandlesOverlay,
					linkSuggestExt,
					entityBracketPairing,
					...(embeddedBranchCards ? [branchAutoCreate] : []),
					draftAnchors,
					autocompletion({
						override: [characterCompletion, entityLinkCompletion],
						icons: false,
						// A real, reported bug: the FIRST option was pre-selected the
						// instant the popup opened (CM6's own default), so pressing
						// Enter on an empty cue-eligible line — meant to just start a
						// new blank line — silently pasted that option instead
						// (`acceptCompletion`, bound to Enter by `completionKeymap`
						// below, confirms whatever's currently selected). With nothing
						// selected on open, `acceptCompletion` has nothing to confirm
						// and returns `false`, falling through to `defaultKeymap`'s own
						// Enter handling — a plain newline — exactly as if no popup
						// were open at all; Enter only pastes an option once the user
						// has explicitly moved to one (click, or Down/Up-arrow).
						selectOnOpen: false,
					}),
					keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
					EditorView.updateListener.of((update) => {
						// Excludes the external-value-sync effect's own dispatch
						// (`userEvent: 'loom.externalSync'`, this file's own
						// value-sync `useEffect`) — see that dispatch's own doc
						// comment for the real, severe bug this guard fixes.
						if (update.docChanged && !update.transactions.some((tr) => tr.isUserEvent('loom.externalSync'))) {
							const urgent = update.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'));
							onChangeRef.current(update.state.doc.toString(), urgent);
						}
						if (update.focusChanged && !update.view.hasFocus) {
							onBlurRef.current?.();
							// Apply a stashed external change now that it's actually
							// safe to — a real content change, so it can't be done
							// synchronously from inside this same update listener
							// (CM6 throws "Calls to EditorView.update are not allowed
							// while an update is in progress" for a nested dispatch);
							// deferred a genuine macrotask out, same reasoning as
							// `onAnyScroll`'s own `setTimeout` further down this
							// file. `viewRef.current !== view` guards against the
							// field having unmounted by the time this fires.
							if (pendingExternalValueRef.current !== null) {
								const blurredView = update.view;
								blurredView.dom.win.setTimeout(() => {
									if (viewRef.current !== blurredView) return;
									const pending = pendingExternalValueRef.current;
									if (pending === null) return;
									pendingExternalValueRef.current = null;
									const current = blurredView.state.doc.toString();
									if (current !== pending) {
										blurredView.dispatch({
											changes: { from: 0, to: current.length, insert: pending },
											userEvent: 'loom.externalSync',
										});
									}
								}, 0);
							}
						}
						if (update.viewportChanged || update.geometryChanged) onGeometryChangeRef.current?.();
						// A bare `selectionSet` also fires for plain Up/Down-arrow
						// cursor motion (CM6 annotates keyboard cursor movement as
						// user event "select", vs. a real click's "select.pointer") —
						// popping the completion list open on every arrow-key landing
						// on an empty cue-eligible line meant the NEXT arrow press got
						// eaten navigating the popup instead of moving the cursor,
						// which read as arrow keys randomly skipping lines near
						// act/scene boundaries (where a doubled blank line is
						// common). Only an actual click should pop it open
						// unprompted; typing (`docChanged`) still does too.
						if (
							update.view.hasFocus &&
							emptyCueLine(update.state) &&
							(update.docChanged || update.transactions.some((tr) => tr.isUserEvent('select.pointer')))
						) {
							startCompletion(update.view);
						}
					}),
					EditorView.domEventHandlers({
						mousedown: openLinkOnMousedown,
						contextmenu: (event, cmView) => openContextMenu(cmView, event),
					paste: (event, cmView) => handleBranchPasteShortcut(cmView, event),
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
		// NOT a direct `sync()` call — a native 'scroll' event can fire
		// SYNCHRONOUSLY from inside CM6's own internal scroll-into-view
		// machinery (`scrollToLine`/`selectRange`/a search jump all trigger
		// one), and this is a CAPTURE-phase listener, so it runs nested
		// inside that same call stack — squarely inside the same "reading
		// layout isn't allowed during an update" window `scheduleSync`
		// (`AnnotationHandlesOverlay`, above) exists to dodge, confirmed by
		// a live crash. `setTimeout`, not `requestAnimationFrame` — CM6
		// schedules its own internal measure work via rAF too, so an rAF
		// callback here can still land in the SAME animation frame as CM6's,
		// still inside the forbidden window (also confirmed live, see
		// `scheduleSync`'s own doc comment); `setTimeout` is a genuinely
		// separate macrotask. The `queued` guard coalesces a scroll
		// GESTURE's many rapid events into one sync rather than one per
		// event.
		let scrollSyncQueued = false;
		const onAnyScroll = () => {
			if (scrollSyncQueued) return;
			scrollSyncQueued = true;
			view.dom.win.setTimeout(() => {
				scrollSyncQueued = false;
				view.plugin(annotationHandlesOverlay)?.sync();
			}, 0);
		};
		document.addEventListener('scroll', onAnyScroll, true);
		return () => {
			document.removeEventListener('scroll', onAnyScroll, true);
			// Explicit, not relying solely on `destroy()` triggering CM6's own
			// `focusChanged` update via the native DOM blur a detached
			// contentEditable normally fires — mirrors the identical fix in
			// `markdown-field.tsx` (see that file's own doc comment on this same
			// spot for the reported bug it closes): a caller that commits only on
			// blur could otherwise unmount without ever flushing what's pending.
			if (view.hasFocus) onBlurRef.current?.();
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	// External value changes (loaded from disk, or `ensureSceneIds`/
	// `syncScenes` rewriting the text after a blur, or now — with the shared
	// script buffer — a DIFFERENT open pane's own edit to this exact scene)
	// — applied only while unfocused, same as markdown-field.tsx, so a live
	// edit's cursor is never disturbed by our own echo of what it just
	// produced. While focused, a genuinely different `value` is stashed in
	// `pendingExternalValueRef` instead of silently dropped — a real,
	// confirmed gap this closes: this effect only re-checks when `value`
	// itself changes AGAIN, so without the stash, an external change that
	// arrived mid-edit was gone for good the instant this ran once and saw
	// `hasFocus`; blur alone never revisited it. The update listener's own
	// blur branch (above) is what applies a stashed value once it's actually
	// safe to.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.hasFocus) {
			if (view.state.doc.toString() !== value) pendingExternalValueRef.current = value;
			return;
		}
		pendingExternalValueRef.current = null;
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
			// Tagged so the update listener's `onChange` firing below can tell
			// this dispatch apart from a real keystroke — a REAL, severe bug
			// found chasing an "intermittent, only-works-after-several-tries"
			// report: without this, `onChangeRef.current(...)` fired for this
			// programmatic resync exactly like it does for real typing, which
			// for the Scene page's own caller means writing this exact same
			// text straight back into the shared script buffer as if the user
			// had just typed it — a harmless no-op most of the time (the text
			// already matches what the buffer holds), but not guaranteed to
			// stay one forever, and not the honest story of what happened
			// either. This one external-sync path is the only dispatch in
			// this file that should ever carry this tag — every other
			// `view.dispatch` here (Cut/Copy/Paste, alt-text swaps, …)
			// represents a real content change the caller's own `onChange`
			// SHOULD pick up.
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
				effects: EditorView.scrollIntoView(targetPos, { y: 'start' }),
				userEvent: 'loom.externalSync',
			});
		}
	}, [value]);

	// A comment's resolved state (or an alt-text's option list, or which id a
	// search match currently highlights) can change from the caller's own
	// popover/search pass without any document edit — the gutter's icon
	// still needs to redraw, so a no-op transaction carrying
	// `refreshAnnotations` nudges it (see the gutter's own `lineMarkerChange`,
	// inside the mount effect).
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({ effects: refreshAnnotations.of(null) });
	}, [comments, altText, highlightedAnnotationId]);

	return <div className="loom-fountain-field" ref={hostRef} />;
});
