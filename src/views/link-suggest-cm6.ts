/**
 * Ambient link suggester — a genuinely shared, format-agnostic CM6 building
 * block for `markdown-field.tsx` and `fountain-field.tsx` (same precedent as
 * `annotation-cm6.ts`: verified format-agnostic before landing here, not a
 * hasty extraction). As the user types plain text that happens to match an
 * existing entity's name/alias, a small floating pill appears above the
 * matched span offering to convert it into a real link — no need to type
 * `[[`/`@[` first. Click, or press Enter right after the match, to accept.
 *
 * Reimplemented from scratch against this codebase's own entity model,
 * after studying (not copying) the equivalent feature in a different
 * plugin: same overall mechanism — a CM6 `ViewPlugin`, debounced trailing-
 * phrase matching, a plain `position: fixed` DOM pill (not a CM6 `Tooltip`,
 * not an Obsidian `Menu`) positioned via `requestMeasure`+`coordsAtPos` —
 * adapted to loom-loom's own project-scoped corpus (a few dozen to a few
 * hundred entities, not a vault-wide note index) and its own existing `[[`/
 * `@[` autocomplete, which this has to coexist with rather than compete
 * against (see the `completionStatus` guard in `onKeydown` below).
 *
 * Deliberately out of scope for v1: paste-scanning (a separate trigger path
 * in the reference feature) — this only ever reacts to typing.
 */

import { completionStatus } from '@codemirror/autocomplete';
import { ChangeDesc } from '@codemirror/state';
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';

const TRIGGER_DEBOUNCE_MS = 150;
const WORD_BOUNDARY_RE = /[\s.,;:!?()[\]{}"'`]/;

/** `insert` is already the exact, full string to splice in place of the
 *  matched plain text — `[[target|label]]` (markdown, brackets included —
 *  a real, reported bug otherwise: without them the "link" is just plain
 *  text) or `@[Name]` (fountain). This module never constructs link syntax
 *  itself, only accepts pre-built strings from each field, keeping it
 *  genuinely format-agnostic. `displayLabel` is what the PILL actually
 *  shows — never `insert` itself, which for markdown is `target|label` and
 *  would show the entity's raw, ugly managed filename right in the
 *  suggestion pill (another real, reported bug: "married with clean
 *  wikilinks" — the pill has to follow the same clean-display convention
 *  the accepted link itself gets once rendered, not just the document). */
export interface LinkSuggestEntry {
	insert: string;
	displayLabel: string;
}

export interface LinkSuggestConfig {
	/** Lowercased phrase -> entry. Called at most once per debounced
	 *  trigger (~every 150ms while typing at most) — cheap to rebuild
	 *  fresh each call; a field with a stable, memoized source array is
	 *  free to cache internally keyed on that array's identity. */
	getCorpus: () => Map<string, LinkSuggestEntry>;
	/** Auto-dismiss delay in ms; 0 = persist until accepted/dismissed. */
	getDismissMs: () => number;
	/** Max trailing words considered as a candidate phrase. */
	maxPhraseWords: number;
	/** True when `ch` (an offset into `line`) sits inside an unclosed
	 *  link-open marker for this field's own syntax (`[[` / `@[`). */
	isInsideOpenMarker: (line: string, ch: number) => boolean;
	/** True when `[from, to)` on `line` overlaps an already-closed link of
	 *  this field's own syntax — never re-suggest over one. */
	overlapsClosedLink: (line: string, from: number, to: number) => boolean;
	/** Optional: true when this whole line should never trigger a suggestion
	 *  at all (Fountain's own scene-heading/character-cue/transition lines,
	 *  which have their own dedicated autocompletes and different semantics —
	 *  markdown-field.tsx has no equivalent notion and leaves this unset). */
	shouldSkipLine?: (line: string) => boolean;
	/** CSS class on the pill element, e.g. `loom-link-suggest-pill`. */
	pillClass: string;
	/** aria-label for the pill, given the entry it would insert. */
	ariaLabel: (entry: LinkSuggestEntry) => string;
}

interface ActiveSuggestion {
	from: number;
	to: number;
	/** The originally-matched phrase text, lowercased — `remapSuggestions`
	 *  drops the pill if a later edit changes what's actually there, rather
	 *  than silently re-anchoring to different text. */
	phrase: string;
	entry: LinkSuggestEntry;
	el: HTMLElement;
	dismissTimer: number | null;
}

function findPhraseMatch(
	corpus: Map<string, LinkSuggestEntry>,
	maxPhraseWords: number,
	lineText: string,
	ch: number
): { from: number; to: number; entry: LinkSuggestEntry } | null {
	// `ch` is right after the word-boundary character that was just typed
	// (a space/punctuation ending a word) — exclude it from the candidate.
	const end = ch - 1;
	if (end <= 0) return null;
	const before = lineText.slice(0, end);
	const wordStarts: number[] = [];
	let i = before.length;
	while (i > 0 && wordStarts.length < maxPhraseWords) {
		while (i > 0 && WORD_BOUNDARY_RE.test(before[i - 1])) i--;
		if (i === 0) break;
		const wordEnd = i;
		while (i > 0 && !WORD_BOUNDARY_RE.test(before[i - 1])) i--;
		if (i === wordEnd) break;
		wordStarts.push(i);
	}
	// Longest phrase first, so a multi-word entity name wins over a
	// coincidental single-trailing-word match.
	for (let k = wordStarts.length - 1; k >= 0; k--) {
		const start = wordStarts[k];
		const phrase = before.slice(start, end);
		const entry = corpus.get(phrase.toLowerCase());
		if (entry) return { from: start, to: end, entry };
	}
	return null;
}

export function buildLinkSuggestExtension(config: LinkSuggestConfig) {
	return ViewPlugin.fromClass(
		class implements PluginValue {
			private readonly view: EditorView;
			private suggestions: ActiveSuggestion[] = [];
			private triggerTimer: number | null = null;

			private readonly onKeydown = (event: KeyboardEvent) => {
				if (this.suggestions.length === 0) return;
				if (event.key === 'Escape') {
					this.dismissAll();
					return;
				}
				if (event.key !== 'Enter') return;
				// A real `[[`/`@[` completion popup takes priority — Enter there
				// must accept THAT, never an unrelated ambient pill sitting
				// elsewhere in the document.
				if (completionStatus(this.view.state) !== null) return;
				const pos = this.view.state.selection.main.head;
				const match = this.suggestions.find((s) => pos >= s.from && pos <= s.to + 1);
				if (!match) return;
				event.preventDefault();
				event.stopPropagation();
				this.accept(match);
			};

			private readonly onReposition = () => this.scheduleReposition();

			constructor(view: EditorView) {
				this.view = view;
				view.dom.addEventListener('keydown', this.onKeydown, true);
				view.dom.win.addEventListener('resize', this.onReposition);
				view.scrollDOM.addEventListener('scroll', this.onReposition);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged) {
					this.remapSuggestions(update.changes);
					if (this.triggerTimer !== null) window.clearTimeout(this.triggerTimer);
					this.triggerTimer = this.view.dom.win.setTimeout(() => this.tryTrigger(), TRIGGER_DEBOUNCE_MS);
				}
				if (update.docChanged || update.viewportChanged || update.geometryChanged) {
					this.scheduleReposition();
				}
			}

			destroy(): void {
				if (this.triggerTimer !== null) window.clearTimeout(this.triggerTimer);
				this.view.dom.removeEventListener('keydown', this.onKeydown, true);
				this.view.dom.win.removeEventListener('resize', this.onReposition);
				this.view.scrollDOM.removeEventListener('scroll', this.onReposition);
				this.dismissAll();
			}

			private remapSuggestions(changes: ChangeDesc): void {
				const next: ActiveSuggestion[] = [];
				for (const s of this.suggestions) {
					const from = changes.mapPos(s.from, 1);
					const to = changes.mapPos(s.to, -1);
					const live = from < to ? this.view.state.sliceDoc(from, to).toLowerCase() : '';
					if (from >= to || live !== s.phrase) {
						this.removePill(s);
						continue;
					}
					s.from = from;
					s.to = to;
					next.push(s);
				}
				this.suggestions = next;
			}

			private tryTrigger(): void {
				const state = this.view.state;
				const sel = state.selection.main;
				if (!sel.empty) return;
				const line = state.doc.lineAt(sel.head);
				const ch = sel.head - line.from;
				if (ch === 0) return;
				if (!WORD_BOUNDARY_RE.test(line.text[ch - 1])) return;
				if (config.shouldSkipLine?.(line.text)) return;
				if (config.isInsideOpenMarker(line.text, ch)) return;

				const match = findPhraseMatch(config.getCorpus(), config.maxPhraseWords, line.text, ch);
				if (!match) return;
				if (config.overlapsClosedLink(line.text, match.from, match.to)) return;
				const from = line.from + match.from;
				const to = line.from + match.to;
				if (this.suggestions.some((s) => s.from === from && s.to === to)) return;

				this.show(from, to, match.entry);
			}

			private show(from: number, to: number, entry: LinkSuggestEntry): void {
				const el = this.view.dom.doc.body.createDiv({ cls: config.pillClass, text: entry.displayLabel });
				el.setAttribute('aria-label', config.ariaLabel(entry));
				el.detach();
				this.view.dom.doc.body.appendChild(el);
				const s: ActiveSuggestion = {
					from,
					to,
					phrase: this.view.state.sliceDoc(from, to).toLowerCase(),
					entry,
					el,
					dismissTimer: null,
				};
				el.addEventListener('mousedown', (e) => {
					e.preventDefault();
					this.accept(s);
				});
				this.suggestions.push(s);
				this.scheduleReposition();
				const dismissMs = config.getDismissMs();
				if (dismissMs > 0) {
					s.dismissTimer = this.view.dom.win.setTimeout(() => this.removePill(s), dismissMs);
				}
			}

			private accept(s: ActiveSuggestion): void {
				this.removePill(s);
				this.view.dispatch({
					changes: { from: s.from, to: s.to, insert: s.entry.insert },
					selection: { anchor: s.from + s.entry.insert.length },
				});
				this.view.focus();
			}

			private removePill(s: ActiveSuggestion): void {
				if (s.dismissTimer !== null) window.clearTimeout(s.dismissTimer);
				s.el.remove();
				this.suggestions = this.suggestions.filter((x) => x !== s);
			}

			private dismissAll(): void {
				for (const s of [...this.suggestions]) this.removePill(s);
			}

			private scheduleReposition(): void {
				if (this.suggestions.length === 0) return;
				const pending = this.suggestions;
				this.view.requestMeasure({
					read: (view) =>
						pending.map((s) => ({
							s,
							from: view.coordsAtPos(s.from),
							to: view.coordsAtPos(s.to, -1),
						})),
					write: (measured) => {
						const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
						for (const m of measured) {
							if (this.suggestions.indexOf(m.s) === -1) continue;
							if (!m.from || !m.to || m.from.top < scrollerRect.top || m.from.top > scrollerRect.bottom) {
								m.s.el.setCssProps({ display: 'none' });
								continue;
							}
							const left = (m.from.left + m.to.right) / 2;
							const top = Math.min(m.from.top, m.to.top);
							m.s.el.setCssProps({
								display: '',
								left: `${left}px`,
								top: `${top - 6}px`,
							});
						}
					},
				});
			}
		}
	);
}
