import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	CompletionContext,
	CompletionResult,
	autocompletion,
	completionKeymap,
	startCompletion,
} from '@codemirror/autocomplete';
import { ForwardedRef, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { ElementType, findOrphanPairs, parseFountain, readLoomId } from '../fountain';

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

export interface FountainFieldHandle {
	/** Selects `[from, to)` and scrolls it into view — what the Script
	 *  view's search jumps to a match with, instead of a raw textarea's
	 *  `setSelectionRange`/`scrollTop`. */
	selectRange: (from: number, to: number) => void;
	focus: () => void;
	/** The 0-based line nearest the top of the visible viewport — what the
	 *  Script/Pages mode switch reads to figure out "where was I" before
	 *  handing off to the other pane. */
	getTopLine: () => number;
	/** Scrolls (without selecting or focusing) so the given 0-based line
	 *  sits near the top — the other half of the Script/Pages scroll sync. */
	scrollToLine: (line: number) => void;
}

export const FountainField = forwardRef(function FountainField(
	{
		value,
		onChange,
		onBlur,
		characters,
		locations,
		onOpenCharacter,
		onOpenLocation,
		onOpenChapter,
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
		/** A character cue line was clicked. */
		onOpenCharacter?: (name: string) => void;
		/** A scene heading was clicked — passed the scene's `[[loom:…]]` id
		 *  so the caller can resolve it to the Scene note's own location
		 *  (sublocation-aware), rather than the raw heading text. */
		onOpenLocation?: (sceneLoomId: string) => void;
		/** A `#` chapter heading was clicked — passed the section's own
		 *  `[[loom:…]]` id (only ever present on level-1 sections). */
		onOpenChapter?: (chapterLoomId: string) => void;
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
	const onOpenCharacterRef = useRef(onOpenCharacter);
	const onOpenLocationRef = useRef(onOpenLocation);
	const onOpenChapterRef = useRef(onOpenChapter);
	onChangeRef.current = onChange;
	onBlurRef.current = onBlur;
	charactersRef.current = characters;
	locationsRef.current = locations;
	onOpenCharacterRef.current = onOpenCharacter;
	onOpenLocationRef.current = onOpenLocation;
	onOpenChapterRef.current = onOpenChapter;

	useImperativeHandle(ref, () => ({
		selectRange: (from, to) => {
			const view = viewRef.current;
			if (!view) return;
			view.focus();
			view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
		},
		focus: () => viewRef.current?.focus(),
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
	}));

	useEffect(() => {
		if (!hostRef.current) return;

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
					// Unlike markdown-field's raw-at-cursor markup, nothing here
					// reacts to selection — the loom id stays hidden regardless
					// of where the cursor is, so only doc edits need a rebuild.
					if (update.docChanged) this.decorations = buildDecorations(update.view);
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
			return false;
		};

		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					EditorView.lineWrapping,
					fountainDecorations,
					autocompletion({
						override: [intExtCompletion, characterCompletion, locationCompletion],
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
					EditorView.domEventHandlers({ mousedown: openLinkOnMousedown }),
				],
			}),
		});
		viewRef.current = view;
		return () => {
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
			view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
		}
	}, [value]);

	return <div className="loom-fountain-field" ref={hostRef} />;
});
