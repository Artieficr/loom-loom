import { EditorState, Prec } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
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
import { App, Scope } from 'obsidian';
import { useEffect, useRef } from 'react';
import type { LinkOption } from './link-textarea';

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

/** Inline tokens of one line, non-overlapping (first match wins). */
function lineTokens(text: string, lineFrom: number): InlineToken[] {
	const tokens: InlineToken[] = [];
	const overlaps = (from: number, to: number) =>
		tokens.some((t) => from < t.to && to > t.from);

	WIKILINK_RE.lastIndex = 0;
	for (let m = WIKILINK_RE.exec(text); m; m = WIKILINK_RE.exec(text)) {
		const from = lineFrom + m.index;
		const to = from + m[0].length;
		const target = m[1];
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

	for (const range of view.visibleRanges) {
		let pos = range.from;
		while (pos <= range.to) {
			const line = view.state.doc.lineAt(pos);
			const text = line.text;
			const lineActive = touches(line.from, line.to);

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
				entries.push({
					from: line.from,
					to: line.from,
					deco: Decoration.line({ class: `loom-md-h${level}` }),
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
					entries.push({
						from: token.content.from,
						to: token.content.to,
						deco: Decoration.mark({
							class: token.content.cls,
							attributes: token.link !== undefined ? { 'data-loom-link': token.link } : undefined,
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
				.replace(/^(\s*)([-*+])\s/, '$1• ');
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
				label: `+ Create "${typed.trim()}"…`,
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

export function MarkdownField({
	app,
	value,
	onChange,
	names,
	placeholder,
	onOpenLink,
	onCreateEntity,
	readOnly,
}: {
	/** Needed to outrank Obsidian's global Ctrl+B/I hotkeys while focused. */
	app: App;
	value: string;
	onChange: (value: string) => void;
	names: LinkOption[];
	placeholder?: string;
	/** Live-preview but not editable (e.g. an "Original description" spoiler);
	 *  clicking rendered links still works. */
	readOnly?: boolean;
	/** Opens a clicked rendered wikilink (raw target; `newTab` on middle-click). */
	onOpenLink: (target: string, newTab?: boolean) => void;
	/** Offered as "+ Create …" in the [[ completion: create an entity from the
	 *  typed short name, then call back with the link text to insert. */
	onCreateEntity?: (name: string, insert: (linkInsert: string) => void) => void;
}) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const namesRef = useRef(names);
	namesRef.current = names;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onOpenRef = useRef(onOpenLink);
	onOpenRef.current = onOpenLink;
	const onCreateRef = useRef(onCreateEntity);
	onCreateRef.current = onCreateEntity;

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
				if (v && evt instanceof KeyboardEvent) applyFormatting(v, evt);
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
		// Left opens a rendered link in place; middle opens it in a new tab.
		const openLinkOnMousedown = (event: MouseEvent): boolean => {
			if (event.button !== 0 && event.button !== 1) return false;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const link = target?.closest('[data-loom-link]');
			if (link instanceof HTMLElement && link.dataset.loomLink) {
				event.preventDefault();
				onOpenRef.current(link.dataset.loomLink, event.button === 1);
				return true;
			}
			return false;
		};
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				// Read-only fields stay contenteditable (only `readOnly` blocks
				// edits): the browser then owns selection and fires a real `copy`
				// event — rewritten below to the display text — where a
				// non-editable view would leave the native selection empty and
				// Ctrl+C a no-op. All editing extensions are simply absent.
				extensions: readOnly
					? [
							EditorState.readOnly.of(true),
							EditorView.lineWrapping,
							cmPlaceholder(placeholder ?? ''),
							livePreview,
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
							cmPlaceholder(placeholder ?? ''),
							livePreview,
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
									else popScope();
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
							}),
						],
			}),
		});
		viewRef.current = view;
		return () => {
			popScope();
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

	return <div className={readOnly ? 'loom-md-field loom-md-readonly' : 'loom-md-field'} ref={hostRef} />;
}
