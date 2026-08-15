import { EditorState, Facet, Prec } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
	gutter,
	keymap,
	placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	CompletionContext,
	CompletionResult,
	autocompletion,
	completionKeymap,
} from '@codemirror/autocomplete';
import { App, Menu, Notice, Scope } from 'obsidian';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { t } from '../i18n';
import { findAnnotationSpans, newSceneId } from '../fountain';
import { CLICK_TO_OPEN_ATTRS } from '../types';
import type { AltTextEntry, CommentEntry } from './script-notes';
import type { LinkOption } from './link-textarea';
import {
	AnnotationGutterItem,
	AnnotationGutterMarker,
	isUnresolvedComment,
	partiallyOverlaps,
	refreshAnnotations,
	scrollWithinEditor,
} from './annotation-cm6';

/**
 * Obsidian-flavored live-preview field for the Notes/Description boxes: a
 * CodeMirror 6 editor (the packages ship inside Obsidian — they're build
 * externals) with a lightweight regex live preview. Rendered like reading
 * mode until the cursor enters a token, raw markdown where the cursor is:
 *
 * - `[[target|alias]]` shows the alias (or target) as a link, brackets hidden;
 *   clicking a rendered link opens it; `[[` auto-closes and an inline
 *   completion offers entities by display name (inserting `target|display`);
 *   backspacing an empty `[[]]` removes the whole pair.
 * - `**bold**`, `*italic*`/`_italic_`, `~~strike~~`, `==highlight==` render
 *   styled with hidden markers.
 * - `# ` … `###### ` headings, `> ` blockquotes, `-`/`*`/`+` bullets, `1.`
 *   ordered lists, and `---` separators render like Obsidian's live preview.
 *
 * Optionally also renders comments/alternative-text spans — the same hidden
 * `[[loom-comment:<id>]]`/`[[loom-alt:<id>]]` marker convention
 * `fountain-field.tsx` uses, reusing `findAnnotationSpans` (fountain.ts)
 * directly rather than a second implementation (it's a pure regex scan over
 * raw text, no Fountain grammar involved). Deliberately simpler than
 * `fountain-field.tsx`'s version: no gutter (this field has none to begin
 * with, and is often too narrow for one) and no draggable comment-boundary
 * handles — the dashed-underlined CONTENT itself is the click target
 * (left-click a comment opens its popover, left-click an alt-text span
 * cycles it, right-click an alt-text span opens its option picker), and
 * every annotation prop is optional/undefined-safe so ordinary Notes/
 * Description fields (which never contain these markers) are unaffected.
 */

interface InlineToken {
	from: number;
	to: number;
	/** Marker ranges to hide when rendered. */
	hide: { from: number; to: number }[];
	/** Content range + style class. */
	content: { from: number; to: number; cls: string };
	/** Wikilink target for click-to-open. */
	link?: string;
}

const INLINE_RULES: {
	re: RegExp;
	cls: string;
	/** Marker lengths before/after the content. */
	open: number;
	close: number;
}[] = [
	{ re: /\*\*([^*\n]+)\*\*/g, cls: 'loom-md-bold', open: 2, close: 2 },
	{ re: /~~([^~\n]+)~~/g, cls: 'loom-md-strike', open: 2, close: 2 },
	{ re: /==([^=\n]+)==/g, cls: 'loom-md-mark', open: 2, close: 2 },
	{ re: /<u>([^<\n]+)<\/u>/g, cls: 'loom-md-underline', open: 3, close: 4 },
	{ re: /(^|[^*])\*([^*\n]+)\*(?!\*)/g, cls: 'loom-md-italic', open: 1, close: 1 },
	{ re: /(^|[^_])_([^_\n]+)_(?!_)/g, cls: 'loom-md-italic', open: 1, close: 1 },
];

const WIKILINK_RE = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;

/** Opt-in per-instance flag (`MarkdownField`'s `plainLinks` prop) — a
 *  wikilink renders as inert plain text, not a colored/clickable span, the
 *  same "just text" treatment Script's own Pages preview already gives its
 *  `@[...]` entity links (stripped to plain display text, never a click
 *  target there). Used by Book/Act/Chapter's read-only Preview fields only —
 *  every other `readOnly` consumer (the Group page's read-only note rows,
 *  an item's read-only "Original description" spoiler) keeps ordinary
 *  clickable/colored links, so this can't be folded into `readOnly` itself. */
const plainLinksFacet = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** Prose/Book's hidden Act/Chapter identity marker (`prose.ts`/`fountain.ts`'s
 *  `[[loom:<id>]]` convention) — never a real wikilink, so it's excluded from
 *  `lineTokens` below and hidden outright by `buildDecorations`'s own pass,
 *  same non-exporting-note treatment `fountain-field.tsx` gives it. Leading
 *  `\s*` consumes the single space `ensureBookIds` (prose.ts) always inserts
 *  before the marker too — mirrors that file's own `LOOM_ID_RE_G` exactly;
 *  without it, hiding only the bracket pair left a trailing space genuinely
 *  present (and, once heading hover-underline was added, visibly stretching
 *  the underline a character past the title text). */
const LOOM_ID_RE = /\s*\[\[loom:[A-Za-z0-9]+\]\]/g;

/** Matches a `[[loom:<id>]]` identity marker OR a `[[loom-comment:<id>]]`/
 *  `[[loom-alt:<id>]]`/`[[/loom-comment:<id>]]`/`[[/loom-alt:<id>]]`
 *  annotation marker's TARGET (the part between `[[` and `]]`, no alias) —
 *  shared by the WIKILINK_RE skip below (none of these are ever a real
 *  wikilink) and any future check needing the same test. The annotation half
 *  matters here specifically because `buildAnnotationDecorations` (this
 *  field's own per-instance plugin, further down) already hides these
 *  markers and marks their wrapped content — without this exclusion,
 *  WIKILINK_RE independently matched the SAME token as an ordinary link
 *  (hiding only `[[`/`]]`, leaving `loom-comment:<id>` itself rendered as
 *  clickable link text), a second, conflicting decoration over the exact
 *  span the annotation pass was already hiding/styling. */
const LOOM_MARKER_TARGET_RE = /^\/?loom(-comment|-alt)?:[A-Za-z0-9]+$/;

/** Inline tokens of one line, non-overlapping (first match wins). */
function lineTokens(text: string, lineFrom: number): InlineToken[] {
	const tokens: InlineToken[] = [];
	const overlaps = (from: number, to: number) =>
		tokens.some((tok) => from < tok.to && to > tok.from);

	WIKILINK_RE.lastIndex = 0;
	for (let m = WIKILINK_RE.exec(text); m; m = WIKILINK_RE.exec(text)) {
		const from = lineFrom + m.index;
		const to = from + m[0].length;
		const target = m[1];
		if (m[2] === undefined && LOOM_MARKER_TARGET_RE.test(target)) continue;
		const hasAlias = m[2] !== undefined;
		// Hide `[[target|` (or just `[[`) and the closing `]]`.
		const contentFrom = hasAlias ? from + 2 + target.length + 1 : from + 2;
		tokens.push({
			from,
			to,
			hide: [
				{ from, to: contentFrom },
				{ from: to - 2, to },
			],
			content: { from: contentFrom, to: to - 2, cls: 'loom-md-link' },
			link: target,
		});
	}

	for (const rule of INLINE_RULES) {
		rule.re.lastIndex = 0;
		for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
			// Rules with a leading guard group ((^|[^*])) offset the real token.
			const lead = m.length > 2 ? m[1].length : 0;
			const from = lineFrom + m.index + lead;
			const to = lineFrom + m.index + m[0].length;
			if (overlaps(from, to)) continue;
			tokens.push({
				from,
				to,
				hide: [
					{ from, to: from + rule.open },
					{ from: to - rule.close, to },
				],
				content: { from: from + rule.open, to: to - rule.close, cls: rule.cls },
			});
		}
	}
	return tokens;
}

class BulletWidget extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const el = view.dom.doc.body.createSpan({ cls: 'loom-md-bullet', text: '•' });
		el.detach();
		return el;
	}
}

class HrWidget extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const el = view.dom.doc.body.createEl('hr', { cls: 'loom-md-hr' });
		el.detach();
		return el;
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	const entries: { from: number; to: number; deco: Decoration }[] = [];
	const sel = view.state.selection;
	// Live preview reveals the raw markdown under the cursor/selection — an
	// editing affordance. Read-only fields keep the rendered form even while
	// text is selected, so selecting/copying never flashes to plain syntax;
	// and an unfocused field renders fully (the parked cursor's line must not
	// stay raw after clicking elsewhere).
	const revealRaw = !view.state.readOnly && view.hasFocus;
	const touches = (from: number, to: number) =>
		revealRaw && sel.ranges.some((r) => r.from <= to && r.to >= from);
	const plainLinks = view.state.facet(plainLinksFacet);

	for (const range of view.visibleRanges) {
		let pos = range.from;
		while (pos <= range.to) {
			const line = view.state.doc.lineAt(pos);
			const text = line.text;
			const lineActive = touches(line.from, line.to);

			// Always hidden, never revealed at the cursor — a Prose Book's Act/
			// Chapter identity marker (see `LOOM_ID_RE` above), not user content.
			LOOM_ID_RE.lastIndex = 0;
			for (let m = LOOM_ID_RE.exec(text); m; m = LOOM_ID_RE.exec(text)) {
				entries.push({
					from: line.from + m.index,
					to: line.from + m.index + m[0].length,
					deco: Decoration.replace({}),
				});
			}

			const hr = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.exec(text);
			if (hr && text.trim() !== '') {
				if (!lineActive && line.length > 0) {
					entries.push({
						from: line.from,
						to: line.to,
						deco: Decoration.replace({ widget: new HrWidget() }),
					});
				}
				pos = line.to + 1;
				continue;
			}

			const quote = /^((?:\s*>\s?)+)/.exec(text);
			if (quote) {
				entries.push({
					from: line.from,
					to: line.from,
					deco: Decoration.line({ class: 'loom-md-quote' }),
				});
				if (!lineActive) {
					entries.push({
						from: line.from,
						to: line.from + quote[1].length,
						deco: Decoration.replace({}),
					});
				}
			}

			const heading = /^(#{1,6})\s/.exec(text);
			if (heading) {
				const level = heading[1].length;
				// A level-1/2 heading carrying Prose's own `[[loom:<id>]]` Act/
				// Chapter identity marker is Ctrl/Cmd-clickable (`onOpenHeading`'s
				// own gate, mirrored here) — an ordinary Notes/Description field's
				// heading never carries this marker, so this doesn't need to know
				// whether the caller actually passed `onOpenHeading` at all.
				const headingClickable = level <= 2 && /\[\[loom:[A-Za-z0-9]+\]\]/.test(text);
				entries.push({
					from: line.from,
					to: line.from,
					deco: Decoration.line({
						class: `loom-md-h${level}`,
						attributes: headingClickable ? CLICK_TO_OPEN_ATTRS : undefined,
					}),
				});
				if (!lineActive) {
					// Hide the "# " markers (the styled text stays; inline tokens
					// below still render).
					entries.push({
						from: line.from,
						to: line.from + heading[0].length,
						deco: Decoration.replace({}),
					});
				}
			}

			const bullet = /^([ \t]*)([-*+])(\s)/.exec(text);
			if (bullet && !hr) {
				const indent = bullet[1];
				// Depth = indent levels (Tab inserts one indentUnit — 2 columns —
				// per press); a tab counts as one column pair too.
				const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
				entries.push({
					from: line.from,
					to: line.from,
					deco: Decoration.line({
						class: 'loom-md-list',
						attributes:
							!lineActive && depth > 0 ? { style: `--loom-list-depth:${depth}` } : undefined,
					}),
				});
				if (!lineActive) {
					// Hide the raw indentation; the line's padding + a nesting rail per
					// ancestor level stand in for it so nested bullets read as an outline.
					if (indent.length > 0) {
						entries.push({
							from: line.from,
							to: line.from + indent.length,
							deco: Decoration.replace({}),
						});
					}
					entries.push({
						from: line.from + indent.length,
						to: line.from + indent.length + 1,
						deco: Decoration.replace({ widget: new BulletWidget() }),
					});
				}
			}

			for (const token of lineTokens(text, line.from).sort((a, b) => a.from - b.from)) {
				// Raw only while the cursor sits strictly inside the token, so a
				// just-completed `**bold**` renders the moment it's closed.
				if (revealRaw && sel.ranges.some((r) => r.from < token.to && r.to > token.from)) continue;
				for (const h of token.hide) {
					entries.push({ from: h.from, to: h.to, deco: Decoration.replace({}) });
				}
				if (token.content.to > token.content.from) {
					const link = token.link;
					entries.push({
						from: token.content.from,
						to: token.content.to,
						deco: Decoration.mark({
							class: link !== undefined && plainLinks ? 'loom-md-link-plain' : token.content.cls,
							// No `data-loom-link` attribute in plain mode — the click
							// handler (`openLinkOnMousedown`) resolves purely off this
							// attribute, so omitting it makes the span genuinely inert,
							// not just uncolored.
							attributes: link !== undefined && !plainLinks ? { 'data-loom-link': link } : undefined,
						}),
					});
				}
			}
			pos = line.to + 1;
		}
	}

	entries.sort((a, b) => a.from - b.from);
	return Decoration.set(
		entries.map((e) => e.deco.range(e.from, e.to)),
		true
	);
}

/**
 * The text as the rendered field shows it: wikilinks become their display
 * text, inline markers and heading/quote markers vanish, bullets read "• ".
 * Read-only fields put THIS on the clipboard (plain `copy` DOM event — no
 * clipboard APIs/permissions), so copying matches what's on screen.
 */
function displayTextOf(text: string): string {
	return text
		.split('\n')
		.map((line) => {
			let out = line
				.replace(/^#{1,6}\s/, '')
				.replace(/^((?:\s*>\s?)+)/, '')
				.replace(/^(\s*)([-*+])\s/, '$1• ')
				.replace(LOOM_ID_RE, '');
			out = out.replace(WIKILINK_RE, (_m, target: string, alias?: string) =>
				alias !== undefined && alias !== '' ? alias : target
			);
			out = out
				.replace(/\*\*([^*\n]+)\*\*/g, '$1')
				.replace(/~~([^~\n]+)~~/g, '$1')
				.replace(/==([^=\n]+)==/g, '$1')
				.replace(/<u>([^<\n]+)<\/u>/g, '$1')
				.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
				.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');
			return out;
		})
		.join('\n');
}

const livePreview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
				this.decorations = buildDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations }
);

/** `[[` auto-closes to `[[]]`; typing `]` skips an existing closing bracket. */
const bracketPairing = EditorView.inputHandler.of((view, from, to, text) => {
	if (text === '[' && from === to) {
		const before = view.state.sliceDoc(from - 1, from);
		const ahead = view.state.sliceDoc(from, from + 2);
		if (before === '[' && ahead !== ']]') {
			view.dispatch({ changes: { from, to, insert: '[]]' }, selection: { anchor: from + 1 } });
			return true;
		}
	}
	if (text === ']' && from === to && view.state.sliceDoc(from, from + 1) === ']') {
		view.dispatch({ selection: { anchor: from + 1 } });
		return true;
	}
	return false;
});

/** Backspacing inside an empty `[[]]` removes the whole pair. */
const pairDeletion = Prec.high(
	keymap.of([
		{
			key: 'Backspace',
			run: (view) => {
				const range = view.state.selection.main;
				if (!range.empty) return false;
				const pos = range.head;
				if (
					view.state.sliceDoc(pos - 2, pos) === '[[' &&
					view.state.sliceDoc(pos, pos + 2) === ']]'
				) {
					view.dispatch({ changes: { from: pos - 2, to: pos + 2 } });
					return true;
				}
				return false;
			},
		},
	])
);

/** Enter continues list/quote formatting; Enter on a marker-only line exits. */
const formatContinuation = Prec.high(
	keymap.of([
		{
			key: 'Enter',
			run: (view) => {
				const range = view.state.selection.main;
				if (!range.empty) return false;
				const line = view.state.doc.lineAt(range.head);
				const quote = /^((?:>\s?)+)/.exec(line.text);
				const bullet = /^(\s*[-*+]\s)/.exec(line.text);
				const ordered = /^(\s*)(\d+)([.)]\s)/.exec(line.text);
				let markerLen: number;
				let continuation: string;
				if (quote) {
					markerLen = quote[1].length;
					continuation = quote[1];
				} else if (bullet) {
					markerLen = bullet[1].length;
					continuation = bullet[1];
				} else if (ordered) {
					markerLen = ordered[0].length;
					continuation = `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}`;
				} else {
					return false;
				}
				if (range.head < line.from + markerLen) return false;
				// A marker with no content: Enter clears it instead of stacking.
				if (line.text.slice(markerLen).trim() === '') {
					view.dispatch({ changes: { from: line.from, to: line.to } });
					return true;
				}
				view.dispatch({
					changes: { from: range.head, insert: '\n' + continuation },
					selection: { anchor: range.head + 1 + continuation.length },
				});
				return true;
			},
		},
	])
);

/** Wraps the selection (or cursor) in inline markers, or unwraps in place. */
function toggleWrap(view: EditorView, open: string, close: string): boolean {
	const range = view.state.selection.main;
	const before = view.state.sliceDoc(Math.max(0, range.from - open.length), range.from);
	const after = view.state.sliceDoc(range.to, range.to + close.length);
	if (before === open && after === close) {
		view.dispatch({
			changes: [
				{ from: range.from - open.length, to: range.from },
				{ from: range.to, to: range.to + close.length },
			],
			selection: { anchor: range.from - open.length, head: range.to - open.length },
		});
		return true;
	}
	const inner = view.state.sliceDoc(range.from, range.to);
	if (
		inner.length >= open.length + close.length &&
		inner.startsWith(open) &&
		inner.endsWith(close)
	) {
		view.dispatch({
			changes: {
				from: range.from,
				to: range.to,
				insert: inner.slice(open.length, inner.length - close.length),
			},
			selection: { anchor: range.from, head: range.to - open.length - close.length },
		});
		return true;
	}
	view.dispatch({
		changes: [
			{ from: range.from, insert: open },
			{ from: range.to, insert: close },
		],
		selection: { anchor: range.from + open.length, head: range.to + open.length },
	});
	return true;
}

/** The inline markers Ctrl/Cmd+B/I/U wrap with. */
function formattingPair(key: string): [string, string] | null {
	switch (key.toLowerCase()) {
		case 'b':
			return ['**', '**'];
		case 'i':
			return ['*', '*'];
		case 'u':
			return ['<u>', '</u>'];
		default:
			return null;
	}
}

// A single Ctrl+B/I/U keypress can reach us twice — once through CodeMirror's
// own keydown (for keys Obsidian doesn't grab, e.g. Ctrl+U) and once through the
// focused-field app Scope that outranks Obsidian's global Ctrl+B/I hotkeys. Both
// call `applyFormatting`; this WeakSet keeps the physical event from toggling
// twice (which would cancel itself out).
const formattedEvents = new WeakSet<KeyboardEvent>();

/** Toggles the marker for `event` once per physical keypress. Returns whether it
 *  was a formatting key at all (so callers know to preventDefault/stopPropagation). */
function applyFormatting(view: EditorView, event: KeyboardEvent): boolean {
	if (event.altKey || !(event.ctrlKey || event.metaKey)) return false;
	const pair = formattingPair(event.key);
	if (!pair) return false;
	if (!formattedEvents.has(event)) {
		formattedEvents.add(event);
		toggleWrap(view, pair[0], pair[1]);
	}
	return true;
}

/** Inserts a picked link at the completion range, reusing/adding the `]]`. */
function insertLink(view: EditorView, from: number, to: number, insert: string) {
	const closed = view.state.sliceDoc(to, to + 2) === ']]';
	view.dispatch({
		changes: { from, to, insert: insert + (closed ? '' : ']]') },
		selection: { anchor: from + insert.length + 2 },
	});
}

/** Inline `[[…` completion over the same options the LinkTextarea offered,
 *  plus a "+ Create …" entry that spawns a new entity from the typed short
 *  name and links it once created. */
function linkCompletion(
	names: () => LinkOption[],
	createEntity: () => ((name: string, insert: (linkInsert: string) => void) => void) | undefined
) {
	return (ctx: CompletionContext): CompletionResult | null => {
		const m = ctx.matchBefore(/\[\[[^[\]\n]*/);
		if (!m) return null;
		const typed = ctx.state.sliceDoc(m.from + 2, m.to);
		const query = typed.toLowerCase();
		const all = names();
		const starts = all.filter((n) => n.label.toLowerCase().startsWith(query));
		const contains = all.filter(
			(n) => !n.label.toLowerCase().startsWith(query) && n.label.toLowerCase().includes(query)
		);
		const options = [...starts, ...contains].slice(0, 8).map((n) => ({
			label: n.label,
			apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
				insertLink(view, from, to, n.insert);
			},
		}));
		const create = createEntity();
		if (create && typed.trim() !== '' && !all.some((n) => n.label.toLowerCase() === query)) {
			options.push({
				label: t('view.markdownField.createEntityOption', { name: typed.trim() }),
				apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
					create(typed.trim(), (linkInsert) => {
						if (!view.dom.isConnected) return;
						insertLink(view, from, to, linkInsert);
					});
				},
			});
		}
		if (options.length === 0) return null;
		return { from: m.from + 2, options, filter: false };
	};
}

/** Imperative handle for a caller that needs to move the view without going
 *  through DOM queries — currently just `scrollToPos`, used by Book's own
 *  comment/alt-text search-jump (`gotoMatch`, book-view.tsx) so a match in a
 *  large unified document that's scrolled out of CM6's `visibleRanges`
 *  actually scrolls into view first, rather than the DOM lookup silently
 *  finding nothing. Mirrors `FountainField`'s own handle, minus the several
 *  Fountain-specific methods this field has no equivalent need for. */
export interface MarkdownFieldHandle {
	scrollToPos: (pos: number) => void;
}

export const MarkdownField = forwardRef<MarkdownFieldHandle, {
	/** Needed to outrank Obsidian's global Ctrl+B/I hotkeys while focused. */
	app: App;
	value: string;
	onChange: (value: string) => void;
	/** The field lost focus (blur, or teardown on unmount — CM6 fires the same
	 *  DOM blur either way). Optional: a caller that commits every keystroke
	 *  (every ordinary Notes/Description field) has no use for it; one that
	 *  buffers locally and commits only here (a whole-document editor, e.g.
	 *  Prose's unified Book/Act editor) does. */
	onBlur?: () => void;
	names: LinkOption[];
	placeholder?: string;
	/** Live-preview but not editable (e.g. an "Original description" spoiler);
	 *  clicking rendered links still works, and an existing comment's popover
	 *  can still be opened read-only — only creating/cycling is disabled. */
	readOnly?: boolean;
	/** A wikilink renders as inert plain text — no color, no cursor, no click
	 *  — the same "just text" treatment Script's own Pages preview already
	 *  gives its `@[...]` entity links. Book/Act/Chapter's read-only Preview
	 *  fields opt into this; every other `readOnly` consumer leaves it unset
	 *  and keeps ordinary clickable/colored links. */
	plainLinks?: boolean;
	/** Opens a clicked rendered wikilink (raw target; `newTab` on middle-click). */
	onOpenLink: (target: string, newTab?: boolean) => void;
	/** Offered as "+ Create …" in the [[ completion: create an entity from the
	 *  typed short name, then call back with the link text to insert. */
	onCreateEntity?: (name: string, insert: (linkInsert: string) => void) => void;
	/** Comment bodies keyed by marker id — read here only to know whether a
	 *  span's icon/tint should show as resolved or not; the actual text/
	 *  editing lives in the caller's own `CommentPopover`. Comments/alt-text
	 *  are entirely opt-in: omitting all of these props (as every ordinary
	 *  Notes/Description field does) leaves this field exactly as before. */
	comments?: Record<string, CommentEntry[]>;
	/** Alt-text entries keyed by marker id. */
	altText?: Record<string, AltTextEntry>;
	/** A new comment marker pair was just inserted around the (former)
	 *  selection — the caller persists the sidecar entry. */
	onCreateComment?: (id: string, selectedText: string) => void;
	/** A new alt-text marker pair was just inserted. */
	onCreateAlt?: (id: string, selectedText: string) => void;
	/** A comment span was left-clicked — open its popover anchored to the
	 *  given screen rect. Also called in `readOnly` mode (pure read). */
	onOpenComment?: (id: string, anchorRect: DOMRect) => void;
	/** An alt-text span was left-clicked — cycle to the next option. Not
	 *  called in `readOnly` mode. `outgoingLiveText` is whatever the currently
	 *  active option's span actually contains in the LIVE document at the
	 *  moment of the swap — the active option's wording is ordinarily edited
	 *  by hand directly in the text (see fountain.ts's own architecture note),
	 *  and this field has no imperative handle a caller could otherwise use to
	 *  read it back before the swap discards it; only differs from the
	 *  sidecar's own stored text for that option when such a hand-edit hasn't
	 *  been persisted yet, mirroring `script-view.tsx`'s own
	 *  `syncOutgoingAltOption`/`liveAltSpanText` pair for the same reason. */
	onCycleAlt?: (id: string, outgoingLiveText: string) => void;
	/** An alt-text span was right-clicked — open its option picker
	 *  (`AltTextModal`, project.ts). Not called in `readOnly` mode. */
	onOpenAltMenu?: (id: string) => void;
	/** A marker id a search match currently points at — its span gets a
	 *  highlight class without touching the document. */
	highlightedAnnotationId?: string | null;
	/** Ctrl/Cmd+click on a `#`/`##` heading line carrying a `[[loom:<id>]]`
	 *  marker (Prose's Act/Chapter identity marker — see `LOOM_ID_RE` above)
	 *  — the caller resolves the id to an entity and opens it. Ctrl/Cmd-gated
	 *  rather than a plain click, mirroring `fountain-field.tsx`'s own
	 *  scene/act heading links: the heading LINE is real editable text (its
	 *  own title), so a plain click has to fall through to normal caret
	 *  placement. Optional — every consumer but Book/Act's unified editors
	 *  leaves it unset and is unaffected (no heading in their text carries
	 *  this marker anyway). */
	onOpenHeading?: (loomId: string, level: number) => void;
	/** Renders a right-side CM6 gutter (mirrors `fountain-field.tsx`'s own
	 *  `annotationGutter`) — one icon per comment/alt-text span that STARTS
	 *  on a given line, click opens/cycles it, right-click opens an alt-text
	 *  span's picker, same as the dashed-underlined CONTENT itself already
	 *  does. Opt-in and off by default: most `MarkdownField` consumers are
	 *  narrow Notes/Description boxes with no room for a gutter (the
	 *  original reason this field never had one at all); Book/Act/Chapter's
	 *  Prose editors are wide enough now and are the only callers that pass
	 *  it. Works in `readOnly` mode too (Preview) — same reasoning as the
	 *  content click already being read-only-safe for opening a comment. */
	annotationGutter?: boolean;
}>(function MarkdownField({
	app,
	value,
	onChange,
	onBlur,
	names,
	placeholder,
	onOpenLink,
	onCreateEntity,
	readOnly,
	plainLinks,
	comments,
	altText,
	onCreateComment,
	onCreateAlt,
	onOpenComment,
	onCycleAlt,
	onOpenAltMenu,
	highlightedAnnotationId,
	onOpenHeading,
	annotationGutter: showAnnotationGutter,
}, ref) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const namesRef = useRef(names);
	namesRef.current = names;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onBlurRef = useRef(onBlur);
	onBlurRef.current = onBlur;
	const onOpenRef = useRef(onOpenLink);
	onOpenRef.current = onOpenLink;
	const onCreateRef = useRef(onCreateEntity);
	onCreateRef.current = onCreateEntity;
	const commentsRef = useRef(comments ?? {});
	commentsRef.current = comments ?? {};
	const altTextRef = useRef(altText ?? {});
	altTextRef.current = altText ?? {};
	const onCreateCommentRef = useRef(onCreateComment);
	onCreateCommentRef.current = onCreateComment;
	const onCreateAltRef = useRef(onCreateAlt);
	onCreateAltRef.current = onCreateAlt;
	const onOpenCommentRef = useRef(onOpenComment);
	onOpenCommentRef.current = onOpenComment;
	const onCycleAltRef = useRef(onCycleAlt);
	onCycleAltRef.current = onCycleAlt;
	const onOpenAltMenuRef = useRef(onOpenAltMenu);
	onOpenAltMenuRef.current = onOpenAltMenu;
	const highlightedAnnotationIdRef = useRef(highlightedAnnotationId ?? null);
	highlightedAnnotationIdRef.current = highlightedAnnotationId ?? null;
	const onOpenHeadingRef = useRef(onOpenHeading);
	onOpenHeadingRef.current = onOpenHeading;

	// A doc-less prop change (resolved toggle, search highlight) doesn't touch
	// the CM6 document, but the annotation decorations still need to redraw —
	// mirrors `fountain-field.tsx`'s own `refreshAnnotations` dispatch.
	useEffect(() => {
		viewRef.current?.dispatch({ effects: refreshAnnotations.of(null) });
	}, [comments, altText, highlightedAnnotationId]);

	useEffect(() => {
		if (!hostRef.current) return;
		// While the field is focused, this scope outranks Obsidian's global
		// hotkeys — Ctrl+B/I are bound app-wide (toggle bold/italic) and grabbed
		// before CodeMirror ever sees them, so this is the ONLY layer that can
		// intercept them here. Ctrl+U has no global binding, so it also reaches
		// CodeMirror's keydown handler below; the shared `applyFormatting` guard
		// keeps a keypress that hits both paths from toggling twice.
		const scope = new Scope(app.scope);
		const wrapKey = (key: string) =>
			scope.register(['Mod'], key, (evt) => {
				const v = viewRef.current;
				if (v) applyFormatting(v, evt);
				return false;
			});
		wrapKey('b');
		wrapKey('i');
		wrapKey('u');
		let scopePushed = false;
		const pushScope = () => {
			if (!scopePushed) {
				app.keymap.pushScope(scope);
				scopePushed = true;
			}
		};
		const popScope = () => {
			if (scopePushed) {
				app.keymap.popScope(scope);
				scopePushed = false;
			}
		};
		/** Cycles an alt-text span to its next option IN PLACE — shared by the
		 *  content click (`openLinkOnMousedown`, below) and the gutter icon
		 *  click (`annotationGutterExt`'s own `domEventHandlers.click`), which
		 *  both need to do the exact same "swap the document, then tell the
		 *  caller to persist the new `activeIndex`" work. This field has no
		 *  imperative handle a caller could dispatch through the way
		 *  `fountain-field.tsx`'s `replaceAltContent` lets `script-view.tsx`'s
		 *  own `handleCycleAlt` do it from OUTSIDE the field — so the swap
		 *  happens right here instead, and `onCycleAlt` is called purely so
		 *  the caller persists the sidecar's new `activeIndex`. No-ops (but
		 *  still reports the click as handled) when there's only one option —
		 *  nothing to cycle TO — or in `readOnly` mode. */
		const cycleAltInPlace = (view: EditorView, id: string) => {
			if (readOnly) return;
			const entry = altTextRef.current[id];
			if (entry && entry.options.length > 1) {
				const nextIndex = (entry.activeIndex + 1) % entry.options.length;
				const span = findAnnotationSpans(view.state.doc.toString()).find((s) => s.kind === 'alt' && s.id === id);
				if (span) {
					// Read the CURRENTLY active option's live text before swapping
					// away from it — a hand-edit typed straight into it is real
					// document text the sidecar may not have caught up with, and
					// the swap below is about to overwrite it with the next
					// option's wording. `onCycleAlt`'s caller persists this back
					// into the sidecar's own copy before advancing `activeIndex`.
					const outgoingLiveText = view.state.doc.sliceString(span.contentFrom, span.contentTo);
					view.dispatch({
						changes: { from: span.contentFrom, to: span.contentTo, insert: entry.options[nextIndex] },
					});
					onCycleAltRef.current?.(id, outgoingLiveText);
					return;
				}
			}
			// Nothing to cycle (one option, or no live span found) — the
			// caller's own handler already no-ops on this same condition, so
			// the text passed through here is never actually read.
			onCycleAltRef.current?.(id, '');
		};
		// Rendered wikilink click, then Ctrl/Cmd+click on a heading — middle
		// opens a link in a new tab. **Deliberately NOT a click target for
		// comment/alt-text spans** — this used to open a comment/cycle an
		// alt-text option on a plain content click, which `fountain-field.tsx`
		// has NEVER done: confirmed directly against that file, its own
		// content click handling is Ctrl/Cmd-gated char/scene/act/entity links
		// ONLY, nothing about `[data-loom-annotation-content]` at all —
		// comments/alt-text are GUTTER-ICON-ONLY there, on purpose, so a plain
		// click or the START of a drag-select landing on/inside an already-
		// annotated span (e.g. extending a selection past it, or just
		// clicking to place a cursor to edit the wrapped text) never gets
		// hijacked into opening a popover. The dashed-underline/tint mark on
		// the content stays purely visual now — `annotationGutter`'s own icon
		// is the sole interactive entry point, matching Script exactly.
		const openLinkOnMousedown = (event: MouseEvent, view: EditorView): boolean => {
			if (event.button !== 0 && event.button !== 1) return false;
			// Ctrl/Cmd+click on a `#`/`##` heading line carrying a `[[loom:<id>]]`
			// marker (see `onOpenHeading`'s own doc comment) — checked before
			// anything else, since the heading's own click target is the whole
			// LINE, not a marked span the way a wikilink is.
			if (event.button === 0 && (event.ctrlKey || event.metaKey) && onOpenHeadingRef.current) {
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos !== null) {
					const line = view.state.doc.lineAt(pos);
					const heading = /^(#{1,2})\s(.*)$/.exec(line.text);
					const idMatch = heading ? /\[\[loom:([A-Za-z0-9]+)\]\]/.exec(heading[2]) : null;
					if (heading && idMatch) {
						event.preventDefault();
						onOpenHeadingRef.current(idMatch[1], heading[1].length);
						return true;
					}
				}
			}
			const target = event.target instanceof HTMLElement ? event.target : null;
			const link = target?.closest('[data-loom-link]');
			if (link instanceof HTMLElement && link.dataset.loomLink) {
				event.preventDefault();
				onOpenRef.current(link.dataset.loomLink, event.button === 1);
				return true;
			}
			return false;
		};
		/** Wraps `range` in a fresh comment/alt-text marker pair — mirrors
		 *  `fountain-field.tsx`'s `insertMarkerPair`. A freshly created COMMENT
		 *  immediately opens its own popover so there's somewhere to actually
		 *  type into (mirrors `script-view.tsx`'s own `handleCreateComment`,
		 *  which does the identical "find the just-rendered icon, open its
		 *  popover" on a deferred frame — done HERE rather than left to the
		 *  caller, since this field already has direct `view` access in scope
		 *  and Script's reason for doing it in the caller instead — no single
		 *  imperative handle to dispatch through — doesn't apply to this
		 *  field). Alt-text creation has no equivalent single "open this" step
		 *  here (the CALLER, `useBookAnnotations`'s `handleCreateAlt`, prompts
		 *  for a second wording itself, mirroring Script's own flow). */
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
			if (kind === 'comment') {
				onCreateCommentRef.current?.(id, selectedText);
				window.requestAnimationFrame(() => {
					const el = view.dom.querySelector(`[data-loom-annotation-content="${id}"], [data-loom-annotation-id="${id}"]`);
					if (el instanceof HTMLElement) onOpenCommentRef.current?.(id, el.getBoundingClientRect());
				});
			} else {
				onCreateAltRef.current?.(id, selectedText);
			}
		};
		/** Right-click: offers "Comment"/"Alternative text…" on a non-empty
		 *  selection — mirrors `fountain-field.tsx`'s own `openContextMenu`
		 *  exactly, including showing the menu with both items DISABLED (plus
		 *  a `Notice`) rather than silently not opening at all when the
		 *  selection partially crosses an existing marked span (nesting fully
		 *  inside or sitting fully outside one is fine — only a true partial
		 *  cross is rejected). **No "existing span" branch here** — right-
		 *  clicking an existing alt-text span's OWN picker is gutter-icon-only
		 *  (`annotationGutterExt`'s own `contextmenu` handler), matching
		 *  Script, where the equivalent body-content handler has never had
		 *  one either. Never fires when `readOnly`, or when neither creation
		 *  callback is provided (every ordinary Notes/Description field falls
		 *  straight through to Obsidian's/the browser's own context menu). */
		const onAnnotationContextMenu = (event: MouseEvent, view: EditorView): boolean => {
			if (!onCreateCommentRef.current && !onCreateAltRef.current) return false;
			const range = view.state.selection.main;
			if (range.empty) return false;
			event.preventDefault();
			const text = view.state.doc.toString();
			const overlaps = findAnnotationSpans(text).some((s) => partiallyOverlaps(range.from, range.to, s.from, s.to));
			if (overlaps) new Notice(t('view.script.overlapNotice.create'));
			const menu = new Menu();
			if (onCreateCommentRef.current) {
				menu.addItem((item) =>
					item
						.setTitle(t('view.script.contextMenu.comment'))
						.setIcon('message-square')
						.setDisabled(overlaps)
						.onClick(() => insertMarkerPair(view, 'comment', range.from, range.to))
				);
			}
			if (onCreateAltRef.current) {
				menu.addItem((item) =>
					item
						.setTitle(t('view.script.contextMenu.altText'))
						.setIcon('arrow-right-left')
						.setDisabled(overlaps)
						.onClick(() => insertMarkerPair(view, 'alt', range.from, range.to))
				);
			}
			menu.showAtMouseEvent(event);
			return true;
		};
		/** Hides every `findAnnotationSpans` marker token and marks the wrapped
		 *  content with a persistent dashed-underline (plus an unresolved tint
		 *  for a comment with anything still unchecked, or a highlight when a
		 *  search match currently points here) — mirrors the equivalent pass in
		 *  `fountain-field.tsx`'s own `buildDecorations`, kept separate here so
		 *  it can be its own ViewPlugin closing over this field's own refs
		 *  (the shared, module-level `livePreview` plugin below has no way to
		 *  read per-instance props). */
		function buildAnnotationDecorations(view: EditorView): DecorationSet {
			const text = view.state.doc.toString();
			const entries: { from: number; to: number; deco: Decoration }[] = [];
			for (const span of findAnnotationSpans(text)) {
				entries.push({ from: span.from, to: span.contentFrom, deco: Decoration.replace({}) });
				entries.push({ from: span.contentTo, to: span.to, deco: Decoration.replace({}) });
				if (span.contentFrom < span.contentTo) {
					const commentEntries = span.kind === 'comment' ? (commentsRef.current[span.id] ?? []) : [];
					const unresolved = isUnresolvedComment(span.kind, commentEntries);
					const highlighted = span.id === highlightedAnnotationIdRef.current;
					const cls =
						`loom-md-annotation-span loom-md-annotation-span-${span.kind}` +
						(unresolved ? ' loom-md-annotation-span-unresolved' : '') +
						(highlighted ? ' loom-md-annotation-span-highlight' : '');
					entries.push({
						from: span.contentFrom,
						to: span.contentTo,
						deco: Decoration.mark({
							class: cls,
							attributes: { 'data-loom-annotation-content': span.id, 'data-loom-annotation-kind': span.kind },
						}),
					});
				}
			}
			entries.sort((a, b) => a.from - b.from);
			return Decoration.set(
				entries.map((e) => e.deco.range(e.from, e.to)),
				true
			);
		}
		const annotationDecorations = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = buildAnnotationDecorations(view);
				}
				update(update: ViewUpdate) {
					if (update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations)))) {
						this.decorations = buildAnnotationDecorations(update.view);
					}
				}
			},
			{ decorations: (v) => v.decorations }
		);

		/** The right-side gutter itself — `side: 'after'` puts it past the
		 *  content (no CSS reordering needed), one marker per line a span
		 *  STARTS on. Mirrors `fountain-field.tsx`'s own `annotationGutter`
		 *  build, including the doc-identity cache (`lineMarker` runs once per
		 *  visible line per recompute; re-parsing the whole document inside it
		 *  would redo that parse once per line on screen). `null` when the
		 *  prop is off — spread into the extensions arrays below only then. */
		let annotationSpansCache: { doc: EditorState['doc']; spans: ReturnType<typeof findAnnotationSpans> } | null = null;
		const annotationSpansFor = (v: EditorView) => {
			if (annotationSpansCache?.doc !== v.state.doc) {
				annotationSpansCache = { doc: v.state.doc, spans: findAnnotationSpans(v.state.doc.toString()) };
			}
			return annotationSpansCache.spans;
		};
		const annotationGutterExt = showAnnotationGutter
			? gutter({
					class: 'loom-md-annotation-gutter',
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
						return new AnnotationGutterMarker('loom-md', items);
					},
					lineMarkerChange: (update) =>
						update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAnnotations))),
					initialSpacer: () => new AnnotationGutterMarker('loom-md', []),
					domEventHandlers: {
						click: (gutterView, line, event) => {
							const target = event.target instanceof Element ? event.target : null;
							const el = target?.closest('[data-loom-annotation-id]');
							if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
							const id = el.dataset.loomAnnotationId;
							if (el.dataset.loomAnnotationKind === 'comment') {
								onOpenCommentRef.current?.(id, el.getBoundingClientRect());
							} else if (!readOnly) {
								cycleAltInPlace(gutterView, id);
							}
							return true;
						},
						contextmenu: (gutterView, line, event) => {
							if (readOnly) return false;
							const target = event.target instanceof Element ? event.target : null;
							const el = target?.closest('[data-loom-annotation-id][data-loom-annotation-kind="alt"]');
							if (!(el instanceof HTMLElement) || !el.dataset.loomAnnotationId) return false;
							event.preventDefault();
							onOpenAltMenuRef.current?.(el.dataset.loomAnnotationId);
							return true;
						},
					},
				})
			: null;

		/** Drags one edge of an EXISTING comment span to relocate it — ported
		 *  directly from `fountain-field.tsx`'s own `startAnnotationHandleDrag`
		 *  (see that function's doc comment for the full design rationale: a
		 *  live fixed-position preview bar tracks the pointer, the actual
		 *  document edit happens once on drop, dropping back on the start
		 *  position or somewhere that would partially overlap a DIFFERENT span
		 *  is a no-op with a `Notice` in the overlap case). Alt-text spans
		 *  never get a handle (see `AnnotationHandlesOverlay` below) — this
		 *  only ever runs for `kind === 'comment'`. */
		function startAnnotationHandleDrag(view: EditorView, id: string, edge: 'start' | 'end', handleEl: HTMLElement) {
			const preview = view.dom.doc.body.createDiv({ cls: 'loom-md-annotation-drag-preview' });
			let lastTarget: number | null = null;

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

		/** Comment-span drag handles, ported directly from `fountain-field.tsx`'s
		 *  own `AnnotationHandlesOverlay` (see that class's doc comment for why
		 *  it's a `position: fixed` plain-DOM overlay — positioned via
		 *  `coordsAtPos` — rather than a `Decoration.widget`: even a zero-width
		 *  inline widget occupies real space in CM6's content flow, and one
		 *  sitting exactly at a span's edge corrupted CM6's own line-layout
		 *  measurement badly enough to break click-to-caret on that paragraph's
		 *  later wrapped lines). **`scheduleSync`'s `setTimeout` (never
		 *  `requestAnimationFrame`) and the `try/catch` around `coordsAtPos`
		 *  are load-bearing, not stylistic** — `fountain-field.tsx`'s own doc
		 *  comment on this documents a REAL crash ("Reading the editor layout
		 *  isn't allowed during an update") that `requestAnimationFrame` alone
		 *  did not fix, because CM6 schedules its own internal measure work via
		 *  rAF too; only a genuinely separate macrotask (`setTimeout`) reliably
		 *  lands outside CM6's own forbidden-to-read-layout window. Do not
		 *  "simplify" this back to rAF or a synchronous call. */
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

			private scheduleSync() {
				if (this.syncQueued) return;
				this.syncQueued = true;
				this.view.dom.win.setTimeout(() => {
					this.syncQueued = false;
					if (!this.destroyed) this.sync();
				}, 0);
			}

			sync() {
				// Mirrors the guard `fountain-field.tsx`'s own `sync()` needed for a
				// real, reported leak: `scheduleSync`'s callback already checks
				// `destroyed`, but this is ALSO called directly from the outer
				// `document`-level scroll listener registered alongside view
				// creation below, which could still fire after `destroy()` had
				// already run and re-create handle spans nothing would ever clean
				// up again.
				if (this.destroyed) return;
				const view = this.view;
				// Mirrors `fountain-field.tsx`'s own two extra `sync()` guards (see
				// that file's doc comment on this same spot for the full
				// reasoning): a view whose DOM was permanently removed without
				// `destroy()` firing gets cleaned up now; a view that's merely in a
				// currently-BACKGROUND tab (Obsidian keeps it in the DOM, just
				// hidden — `offsetParent` goes `null`) gets its handles hidden
				// rather than left positioned at stale coordinates, since these
				// `position: fixed` elements sit on `document.body` and aren't
				// clipped by a hidden ancestor at all.
				if (!view.dom.isConnected) {
					this.destroy();
					return;
				}
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
								cls: `loom-md-annotation-handle loom-md-annotation-handle-${edge}`,
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

		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				// A real, reported bug in the ORIGINAL version of this comment's
				// own reasoning: `EditorState.readOnly` (blocks EDITS/transactions)
				// and `EditorView.editable` (controls whether the DOM itself is
				// `contenteditable`) are two SEPARATE CM6 facets — this used to set
				// only the former, leaving the content DOM genuinely
				// `contenteditable="true"`, which is what drew a blinking
				// text-input caret and let one be PLACED by clicking, even though
				// typing into it did nothing (`readOnly` silently ate the
				// transaction). Preview is meant to read like Script's own Pages
				// preview — plain text you can select and copy, never something
				// that visually invites typing. `EditorView.editable.of(false)`
				// closes that gap; CM6 documents this exact split ("not editable,
				// but the content will still be selectable"), so the native
				// selection/`copy`-event handling below is UNAFFECTED — neither
				// depends on `contenteditable`, only on the browser's ordinary
				// text-selection machinery, which works the same on any DOM text.
				extensions: readOnly
					? [
							EditorState.readOnly.of(true),
							EditorView.editable.of(false),
							plainLinksFacet.of(plainLinks ?? false),
							EditorView.lineWrapping,
							scrollWithinEditor,
							cmPlaceholder(placeholder ?? ''),
							livePreview,
							annotationDecorations,
							...(annotationGutterExt ? [annotationGutterExt] : []),
							keymap.of(defaultKeymap),
							EditorView.domEventHandlers({
								mousedown: openLinkOnMousedown,
								copy: (event, v) => {
									const range = v.state.selection.main;
									if (range.empty || !event.clipboardData) return false;
									event.clipboardData.setData(
										'text/plain',
										displayTextOf(v.state.sliceDoc(range.from, range.to))
									);
									event.preventDefault();
									return true;
								},
							}),
						]
					: [
							history(),
							EditorView.lineWrapping,
							scrollWithinEditor,
							cmPlaceholder(placeholder ?? ''),
							livePreview,
							annotationDecorations,
							...(annotationGutterExt ? [annotationGutterExt] : []),
							annotationHandlesOverlay,
							bracketPairing,
							pairDeletion,
							formatContinuation,
							autocompletion({
								override: [
									linkCompletion(
										() => namesRef.current,
										() => onCreateRef.current
									),
								],
								icons: false,
							}),
							// Tab indents (nesting bullets) instead of leaving the field;
							// lowest precedence so an open completion still accepts on Tab.
							keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
							EditorView.updateListener.of((update) => {
								if (update.docChanged) onChangeRef.current(update.state.doc.toString());
								if (update.focusChanged) {
									if (update.view.hasFocus) pushScope();
									else {
										popScope();
										onBlurRef.current?.();
									}
								}
							}),
							EditorView.domEventHandlers({
								mousedown: openLinkOnMousedown,
								// Handles Ctrl/Cmd+B/I/U for keys that reach CodeMirror (e.g.
								// Ctrl+U, which Obsidian doesn't grab). B/I are usually
								// intercepted upstream and toggled by the app Scope instead;
								// the shared guard stops a double toggle when both fire.
								keydown: (event, v) => {
									if (!applyFormatting(v, event)) return false;
									event.preventDefault();
									event.stopPropagation();
									return true;
								},
								contextmenu: onAnnotationContextMenu,
							}),
						],
			}),
		});
		viewRef.current = view;
		// Mirrors `fountain-field.tsx`'s own outer-page-scroll tracking — a real,
		// previously-missing gap: `AnnotationHandlesOverlay`'s own `update()`
		// only re-syncs handle positions on CM6-internal viewport/geometry
		// changes (the editor's OWN scroll), never the OUTER page scrolling the
		// whole editor box around on screen, which CM6 has no reason to know or
		// care about — without this, a comment span's drag handles could sit at
		// stale screen coordinates whenever something outside the editor itself
		// scrolled. Only wired when the field is actually editable —
		// `annotationHandlesOverlay` is only mounted into the extensions array
		// in that branch above, so `view.plugin(...)` would always return
		// `undefined` here otherwise. Same capture-phase "any scroll, anywhere"
		// listener the comment popover's own scroll-tracking uses, and the same
		// `setTimeout`-not-`requestAnimationFrame` deferral `scheduleSync`
		// needs: a native 'scroll' event can fire SYNCHRONOUSLY from inside
		// CM6's own scroll-into-view machinery, and a capture-phase listener
		// runs nested inside that same call stack — squarely inside the same
		// "reading layout isn't allowed during an update" window `scheduleSync`
		// exists to dodge (confirmed by a live crash in `fountain-field.tsx`'s
		// own history); `requestAnimationFrame` doesn't reliably escape it,
		// since CM6 schedules its own internal measure work via rAF too.
		let scrollSyncQueued = false;
		const onAnyScroll = () => {
			if (scrollSyncQueued) return;
			scrollSyncQueued = true;
			view.dom.win.setTimeout(() => {
				scrollSyncQueued = false;
				view.plugin(annotationHandlesOverlay)?.sync();
			}, 0);
		};
		if (!readOnly) document.addEventListener('scroll', onAnyScroll, true);
		return () => {
			if (!readOnly) document.removeEventListener('scroll', onAnyScroll, true);
			popScope();
			// Explicit, not relying solely on `destroy()` triggering CM6's own
			// `focusChanged` update via the native DOM blur a detached
			// contentEditable normally fires — a real, reported bug: a caller
			// that buffers locally and commits only on blur (Book/Act's unified
			// editor, via `onBlur`) could unmount WITHOUT that teardown blur ever
			// reaching `onBlurRef`, silently losing whatever was still buffered
			// (e.g. an in-progress Act/Chapter title edit) the moment the field
			// went away — reopening then showed the pre-edit text again, since
			// nothing had ever actually written it. Guaranteeing the flush here,
			// independent of CM6's own event plumbing, closes that gap; a no-op
			// when nothing is pending (every ordinary Notes/Description field).
			if (view.hasFocus) onBlurRef.current?.();
			view.destroy();
			viewRef.current = null;
		};
		// The view is created once per mount; live inputs flow through refs, so
		// this deliberately has no dependencies.
	}, []);

	// External value changes (index updates, other writers) sync in unless the
	// user is typing right here.
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.hasFocus) return;
		const current = view.state.doc.toString();
		if (current !== value) {
			view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
		}
	}, [value]);

	useImperativeHandle(
		ref,
		() => ({
			scrollToPos: (pos: number) => {
				const view = viewRef.current;
				if (!view) return;
				view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
			},
		}),
		[]
	);

	return <div className={readOnly ? 'loom-md-field loom-md-readonly' : 'loom-md-field'} ref={hostRef} />;
});
