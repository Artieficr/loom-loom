/**
 * Fountain screenplay parsing.
 *
 * Deliberately dependency-free and side-effect-free: it takes the text of a
 * `.fountain` file and returns its structure. Everything that touches the vault
 * (creating Scene notes, writing ids back) lives in the view, so the grammar
 * stays testable on its own.
 *
 * Two things about the format drive most of the design here:
 *
 * - **Fountain has no page concept.** Pagination is the renderer's job, computed
 *   from fixed screenplay metrics. So a scene's page range is DERIVED on every
 *   parse and never stored — which is exactly what makes it shift by itself when
 *   an earlier scene grows.
 * - **Notes are `[[…]]`**, which is also Obsidian's wikilink syntax. That's why
 *   the script is its own file extension rather than a markdown note, and it's
 *   also the slot we hide the scene id in (`[[loom:<id>]]`): non-exporting by
 *   spec, invisible in our editor, and it survives any rewrite or reorder.
 */

// --- Scene ids -------------------------------------------------------------

/** Marks a hidden loom note: `[[loom:a1b2c3d4]]`. */
const LOOM_ID_RE = /\[\[loom:([A-Za-z0-9]+)\]\]/;
const LOOM_ID_RE_G = /\s*\[\[loom:[A-Za-z0-9]+\]\]/g;

export function newSceneId(): string {
	// Short, url-safe, and collision-resistant enough for one script: 8 chars of
	// base36 randomness plus a time component so two scenes created in the same
	// millisecond in different sessions still differ.
	const rand = Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, '0');
	const time = (Date.now() % 36 ** 4).toString(36).padStart(4, '0');
	return `${time}${rand}`;
}

/** The loom id carried by a line, or null. */
export function readLoomId(line: string): string | null {
	return LOOM_ID_RE.exec(line)?.[1] ?? null;
}

/**
 * Removes every `[[loom:…]]` marker from the text.
 *
 * For EXPORT only — producing a clean copy to hand to another tool or to render.
 * Never run this over the live file: "Open in external app" hands the real file
 * to an editor that writes back in place, and stripping there would destroy
 * every scene's identity on the first external save.
 */
export function stripLoomIds(text: string): string {
	return text.replace(LOOM_ID_RE_G, '');
}

// --- Annotation markers (comments / alternative text) -----------------------
//
// Paired siblings of the `[[loom:<id>]]` marker above — same non-exporting
// Fountain "Note" syntax, but wrapping a RANGE instead of tagging one line's
// end: `[[loom-comment:<id>]]`…`[[/loom-comment:<id>]]` marks a commented
// span, `[[loom-alt:<id>]]`…`[[/loom-alt:<id>]]` marks an alternative-text
// span. The wrapped text is always whatever's currently displayed — for a
// comment that's just the commented text, untouched; for alt-text it's
// whichever option is presently active (cycling REPLACES it with a different
// option's text as an ordinary document edit, see fountain-field.tsx), so
// there's nothing to "resolve" at export time beyond removing the two marker
// tokens (`stripAnnotationMarkers`, below the entity-link section).
//
// Position is never stored anywhere: the marker's location IS wherever the
// user's edits have left it. This also gives garbage collection for free —
// deleting the whole wrapped span (both markers included) removes them in
// the same edit, no special-case code needed; the only extra case is a LONE
// surviving marker (only one half of a pair got deleted), handled by
// `cleanAnnotationMarkers` below.

/** Exact marker token, no surrounding whitespace swallowed — used for span-
 *  boundary math (`findAnnotationSpans`) where `from`/`to` must land exactly
 *  on the bracket characters, and for classification/extraction stripping
 *  (`parseFountain`'s tokenizer, `parseSceneHeading`) where a marker can
 *  legitimately sit mid-sentence — unlike `LOOM_ID_RE_G`, this deliberately
 *  does NOT swallow adjacent whitespace, or removing a mid-sentence marker
 *  would eat a real space between two words. */
const ANNOTATION_MARKER_RE = /\[\[(\/?)loom-(comment|alt):([A-Za-z0-9]+)\]\]/g;

export interface AnnotationSpan {
	kind: 'comment' | 'alt';
	id: string;
	/** Whole marker pair: open marker's start through close marker's end. */
	from: number;
	to: number;
	/** The wrapped (= currently displayed) text's own span. */
	contentFrom: number;
	contentTo: number;
}

/**
 * Every well-formed `[[loom-comment:<id>]]`/`[[loom-alt:<id>]]` pair in
 * `text`, in document order. Character-offset-preserving like
 * `findEntityLinks` below — always call this with the FULL text whose
 * offsets you want to use (the live CM6 document, or a whole script string),
 * never a substring, since a substring's offsets wouldn't line up with
 * anything outside it.
 *
 * A marker with no matching partner (only the open or only the close half
 * survived some edit) is simply left out — see `findStrayAnnotationMarkers`
 * for finding those instead.
 */
export function findAnnotationSpans(text: string): AnnotationSpan[] {
	type Token = { close: boolean; kind: 'comment' | 'alt'; id: string; from: number; to: number };
	const tokens: Token[] = [];
	for (const m of text.matchAll(ANNOTATION_MARKER_RE)) {
		tokens.push({
			close: m[1] === '/',
			kind: m[2] as 'comment' | 'alt',
			id: m[3],
			from: m.index ?? 0,
			to: (m.index ?? 0) + m[0].length,
		});
	}
	const spans: AnnotationSpan[] = [];
	const open = new Map<string, Token>();
	for (const tok of tokens) {
		const key = `${tok.kind}:${tok.id}`;
		if (!tok.close) {
			open.set(key, tok);
			continue;
		}
		const opener = open.get(key);
		if (!opener) continue; // a close with no matching open — stray, not a span
		open.delete(key);
		spans.push({
			kind: tok.kind,
			id: tok.id,
			from: opener.from,
			to: tok.to,
			contentFrom: opener.to,
			contentTo: tok.from,
		});
	}
	return spans.sort((a, b) => a.from - b.from);
}

/** Marker tokens with no matching partner — orphaned by a partial delete
 *  (only one half of a pair got removed, e.g. backspacing across just the
 *  close marker). Dead by definition: there's no content span left for them
 *  to describe, so they're pure clutter once left this way. */
export function findStrayAnnotationMarkers(text: string): { from: number; to: number }[] {
	type Token = { close: boolean; kind: string; id: string; from: number; to: number };
	const tokens: Token[] = [];
	for (const m of text.matchAll(ANNOTATION_MARKER_RE)) {
		tokens.push({ close: m[1] === '/', kind: m[2], id: m[3], from: m.index ?? 0, to: (m.index ?? 0) + m[0].length });
	}
	const open = new Map<string, Token>();
	const strays: { from: number; to: number }[] = [];
	for (const tok of tokens) {
		const key = `${tok.kind}:${tok.id}`;
		if (!tok.close) {
			// A second open of the same id with no close in between shouldn't
			// normally happen (ids are freshly generated per creation), but
			// treat the earlier, now-superseded one as stray defensively.
			const prev = open.get(key);
			if (prev) strays.push({ from: prev.from, to: prev.to });
			open.set(key, tok);
			continue;
		}
		const opener = open.get(key);
		if (opener) {
			open.delete(key);
		} else {
			strays.push({ from: tok.from, to: tok.to });
		}
	}
	for (const opener of open.values()) strays.push({ from: opener.from, to: opener.to });
	// Back-to-front, so removing one in `cleanAnnotationMarkers` doesn't shift
	// the offsets of the ones still to come.
	return strays.sort((a, b) => b.from - a.from);
}

/**
 * Strips every STRAY marker token (leaves every well-formed pair, and the
 * text it wraps, completely untouched). The subtractive counterpart to
 * `ensureSceneIds` — pure, idempotent, safe to run on every commit. Together
 * with `findAnnotationSpans` naturally forgetting an id the moment BOTH its
 * markers are gone (the ordinary "delete the whole commented text" case,
 * which needs no special handling at all), this is what keeps a lone
 * surviving marker from lingering forever as invisible clutter.
 */
export function cleanAnnotationMarkers(text: string): { text: string; changed: boolean } {
	const strays = findStrayAnnotationMarkers(text);
	if (strays.length === 0) return { text, changed: false };
	let next = text;
	for (const s of strays) next = next.slice(0, s.from) + next.slice(s.to);
	return { text: next, changed: true };
}

/** Marker ids currently backed by a COMPLETE pair — the annotation
 *  equivalent of `liveSceneIds`/`liveChapterIds` further down, feeding the
 *  sidecar-pruning GC pass in script-view.tsx's `runCommit`/
 *  `editScriptAndSync`. */
export function liveAnnotationIds(text: string): Set<string> {
	return new Set(findAnnotationSpans(text).map((s) => s.id));
}

// --- Entity links ------------------------------------------------------------

/**
 * An inline entity link: `@[Grandma's necklace|necklace]` (display text after
 * `|` is optional — bare `@[Name]` displays as the full name). Bracket-
 * delimited rather than a bare `@Name` because an entity's name can contain
 * spaces and punctuation with no other safe terminator.
 */
const ENTITY_LINK_RE = /@\[([^\]|]+)(?:\|([^\]]+))?\]/g;

/**
 * `= branch: <group-id>` — a plugin-specific convention marking a section as
 * one branch in a narrative choice point, using Fountain's own non-exporting
 * synopsis line so it reads as a plain nested outline in any compliant tool
 * (unlike the leading-`.`-forced-heading approach tried first, which other
 * Fountain tools misread as a new top-level scene). Sits directly beneath
 * its section's heading line, no blank line between.
 */
const BRANCH_TAG_RE = /^=\s*branch:\s*(.+)$/i;

/**
 * Every `@[...]` span in `text`, with string offsets for decoration.
 *
 * `nameFrom`/`nameTo` and `displayFrom`/`displayTo` are the RAW (untrimmed)
 * offsets of the name and display segments within the source text — what a
 * live editor needs to hide the `@[`/`|`/`]` punctuation while leaving just
 * the display segment visible (`displayFrom`/`displayTo` equal the name span
 * when there's no `|Display`, since the name IS the display then).
 */
export function findEntityLinks(text: string): {
	from: number;
	to: number;
	name: string;
	display: string;
	nameFrom: number;
	nameTo: number;
	displayFrom: number;
	displayTo: number;
}[] {
	const out: ReturnType<typeof findEntityLinks> = [];
	for (const m of text.matchAll(ENTITY_LINK_RE)) {
		const from = m.index;
		const to = from + m[0].length;
		const nameFrom = from + 2;
		const nameTo = nameFrom + m[1].length;
		const hasDisplay = m[2] !== undefined;
		const displayFrom = hasDisplay ? nameTo + 1 : nameFrom;
		const displayTo = hasDisplay ? displayFrom + m[2].length : nameTo;
		out.push({
			from,
			to,
			name: m[1].trim(),
			display: (m[2] ?? m[1]).trim(),
			nameFrom,
			nameTo,
			displayFrom,
			displayTo,
		});
	}
	return out;
}

/**
 * Collapses every `@[Name|Display]` to just its display text (or `Name` with
 * no `|Display`) — for EXPORT/render only, never the live document, same
 * contract as `stripLoomIds`.
 */
export function stripEntityLinksForDisplay(text: string): string {
	return text.replace(ENTITY_LINK_RE, (_full, name: string, display?: string) => (display ?? name).trim());
}

/**
 * Removes every `[[loom-comment:…]]`/`[[/loom-comment:…]]`/`[[loom-alt:…]]`/
 * `[[/loom-alt:…]]` marker token, leaving the text between them untouched.
 *
 * Export/render only, same contract as `stripLoomIds`/
 * `stripEntityLinksForDisplay` above — never run over the live document.
 * Because cycling alt-text is a real document edit that replaces the wrapped
 * text in place (fountain-field.tsx), the text between the markers already
 * IS whatever's currently active — stripping the two tokens is the entire
 * "resolve to the active version" step, nothing further to compute.
 */
export function stripAnnotationMarkers(text: string): string {
	return text.replace(ANNOTATION_MARKER_RE, '');
}

/** Matches a BALANCED marker pair — the backreference (`\1`/`\2`) ties a
 *  close to the open of the SAME kind+id, so nested spans of different ids
 *  each self-pair correctly regardless of what sits between them. */
const ANNOTATION_PAIR_RE = /\[\[loom-(comment|alt):([A-Za-z0-9]+)\]\]([\s\S]*?)\[\[\/loom-\1:\2\]\]/g;

/**
 * Render-only counterpart to `stripAnnotationMarkers`, for the interactive
 * Pages preview only: a BALANCED marker pair (both open and close present in
 * the given text — true whenever a comment/alt-text span doesn't cross an
 * ELEMENT boundary, which covers the overwhelming common case, since a
 * dialogue block's several physical lines already merge into one `element`)
 * becomes a real `<span>` wrapping its content instead of vanishing outright,
 * so the preview can box it with a dashed border the same way the live CM6
 * editor does. A marker with no partner IN THIS STRING (the span crosses
 * into a different element) has nothing to safely pair against here and is
 * just stripped same as `stripAnnotationMarkers` — no box, but no
 * mismatched/dangling tag either. Callers pass one element's own text at a
 * time (never a whole multi-element document), same contract as
 * `stripAnnotationMarkers`'s own call sites.
 */
export function wrapAnnotationMarkersForDisplay(
	text: string,
	highlightedId: string | null,
	/** Comment marker ids that still need attention (no replies yet, or at
	 *  least one unresolved) — mirrors the live CM6 editor's own persistent
	 *  tint for the same state (fountain-field.tsx's `buildDecorations`). A
	 *  plain `Set<string>`, not `Record<string, CommentEntry[]>`, so this
	 *  file never has to import a type from script-notes.ts (which pulls in
	 *  Obsidian) — the caller (`PagesPreviewBody`, script-view.tsx) computes
	 *  it once from its own `comments` prop. */
	unresolvedCommentIds: Set<string>
): string {
	const wrapped = text.replace(ANNOTATION_PAIR_RE, (_match, kind: string, id: string, inner: string) => {
		const cls =
			`loom-sp-annotation-span loom-sp-annotation-span-${kind}` +
			(kind === 'comment' && unresolvedCommentIds.has(id) ? ' loom-sp-annotation-span-unresolved' : '') +
			(id === highlightedId ? ' loom-sp-annotation-span-highlight' : '');
		return `<span class="${cls}" data-loom-annotation-content="${id}">${inner}</span>`;
	});
	return stripAnnotationMarkers(wrapped);
}

// --- Title page ------------------------------------------------------------

/**
 * The title page. Fountain's own keys, so a script round-trips exactly through
 * Better Fountain / Highland / Fade In — there is no sidecar for these.
 * `extra` keeps any key we don't model (and the original key order) so writing
 * the page back never drops what someone else put there.
 */
export interface TitlePage {
	title: string;
	credit: string;
	author: string;
	source: string;
	draftDate: string;
	contact: string;
	copyright: string;
	notes: string;
	/** Unmodelled keys, in the order they appeared. */
	extra: { key: string; value: string }[];
}

/** Whether the script carries a title page worth rendering as page 1. */
export function hasTitlePage(title: TitlePage): boolean {
	return title.title.trim() !== '' || title.author.trim() !== '' || title.credit.trim() !== '';
}

export function emptyTitlePage(): TitlePage {
	return {
		title: '',
		credit: '',
		author: '',
		source: '',
		draftDate: '',
		contact: '',
		copyright: '',
		notes: '',
		extra: [],
	};
}

/** Canonical key spellings, and the aliases Fountain accepts for them. */
const TITLE_KEYS: { field: keyof TitlePage; key: string; aliases: string[] }[] = [
	{ field: 'title', key: 'Title', aliases: [] },
	{ field: 'credit', key: 'Credit', aliases: [] },
	{ field: 'author', key: 'Author', aliases: ['authors'] },
	{ field: 'source', key: 'Source', aliases: [] },
	{ field: 'draftDate', key: 'Draft date', aliases: ['draft'] },
	{ field: 'contact', key: 'Contact', aliases: [] },
	{ field: 'copyright', key: 'Copyright', aliases: [] },
	{ field: 'notes', key: 'Notes', aliases: [] },
];

function titleFieldFor(key: string): keyof TitlePage | null {
	const k = key.trim().toLowerCase();
	for (const entry of TITLE_KEYS) {
		if (entry.key.toLowerCase() === k || entry.aliases.includes(k)) return entry.field;
	}
	return null;
}

const TITLE_KEY_RE = /^([A-Za-z][A-Za-z ]*):(.*)$/;

/**
 * Splits the title page off the body. A title page exists only if the very
 * first non-empty line is a `Key:` line; otherwise the whole text is body
 * (a script can legitimately start straight into a scene).
 *
 * Values may continue on following indented lines, which is how multi-line
 * Contact/Notes blocks are written.
 */
export function splitTitlePage(lines: string[]): { title: TitlePage; bodyStart: number } {
	const title = emptyTitlePage();
	let i = 0;
	while (i < lines.length && lines[i].trim() === '') i++;
	if (i >= lines.length || !TITLE_KEY_RE.test(lines[i])) return { title, bodyStart: 0 };

	const raw: { key: string; value: string }[] = [];
	let current: { key: string; value: string } | null = null;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') {
			// A blank line ends the title page — but only once we've read at
			// least one key, and only if what follows isn't another key.
			let j = i + 1;
			while (j < lines.length && lines[j].trim() === '') j++;
			if (j >= lines.length || !TITLE_KEY_RE.test(lines[j])) {
				i = j;
				break;
			}
			i = j - 1;
			continue;
		}
		const m = TITLE_KEY_RE.exec(line);
		if (m) {
			current = { key: m[1].trim(), value: m[2].trim() };
			raw.push(current);
		} else if (current) {
			// Indented continuation of the previous value.
			current.value = current.value === '' ? line.trim() : `${current.value}\n${line.trim()}`;
		} else {
			break;
		}
	}

	for (const entry of raw) {
		const field = titleFieldFor(entry.key);
		if (field && field !== 'extra') title[field] = entry.value;
		else title.extra.push(entry);
	}
	return { title, bodyStart: i };
}

/** Renders a title page back to Fountain lines (empty fields are omitted). */
export function renderTitlePage(title: TitlePage): string[] {
	const out: string[] = [];
	const push = (key: string, value: string) => {
		if (value.trim() === '') return;
		const parts = value.split('\n');
		out.push(`${key}: ${parts[0]}`);
		// Continuations are indented, which is what marks them as part of the
		// same value rather than a new key.
		for (const extra of parts.slice(1)) out.push(`\t${extra}`);
	};
	for (const entry of TITLE_KEYS) push(entry.key, title[entry.field] as string);
	for (const entry of title.extra) push(entry.key, entry.value);
	return out;
}

// --- Elements --------------------------------------------------------------

export type ElementType =
	| 'scene-heading'
	| 'action'
	| 'character'
	| 'dialogue'
	| 'parenthetical'
	| 'transition'
	| 'section'
	| 'synopsis'
	| 'centered'
	| 'lyrics'
	| 'page-break';

export interface FountainElement {
	type: ElementType;
	/** Display text: forcing marks (`.`/`!`/`@`/`>`), scene numbers and loom ids removed. */
	text: string;
	/** 0-based line index in the file. */
	line: number;
	/** Sections only: 1 for `#`, 2 for `##`, … */
	level?: number;
	/** Characters only: `(V.O.)`-style extension, without the parentheses. */
	extension?: string;
	/** Characters only: `^` — this block plays alongside the previous one. */
	dual?: boolean;
	/** Scene headings only: production number from `#7#`, without the hashes. */
	sceneNumber?: string;
	/** Page breaks only: hidden `[[loom:…]]` marker, like a scene/section
	 *  heading's — see `ParsedScript.pageBreaks`. */
	loomId?: string | null;
	/** 1-based page this element renders on. Derived on every parse, never
	 *  stored — see the pagination note at the top of the file. */
	page?: number;
}

/** A scene heading's parts. `INT. HOUSE - DAY` → `INT.` + `HOUSE` + `DAY`. */
export interface SceneHeadingParts {
	/** `INT.`, `EXT.`, `EST.`, `INT./EXT.`, … as written; '' for a forced heading. */
	intExt: string;
	/** The place, uppercased as written — what resolves to a Location entity. */
	location: string;
	/** Trailing time of day (`DAY`, `NIGHT`, `CONTINUOUS`, …), or ''. */
	timeOfDay: string;
	/** Production scene number from `#7#`, or ''. */
	sceneNumber: string;
	/** Our hidden `[[loom:…]]` id, or null when the heading has none yet. */
	loomId: string | null;
}

/**
 * Scene-heading prefixes. A line starting with one of these (followed by a
 * space or a period) and preceded by a blank line is a scene heading; a leading
 * `.` forces one for anything else (`.BLACK SCREEN`).
 */
const SCENE_PREFIXES = ['INT./EXT.', 'INT/EXT.', 'INT./EXT', 'I/E.', 'I/E', 'INT.', 'EXT.', 'EST.', 'INT', 'EXT', 'EST'];

function scenePrefixOf(line: string): string | null {
	const upper = line.trim().toUpperCase();
	for (const prefix of SCENE_PREFIXES) {
		if (!upper.startsWith(prefix)) continue;
		const rest = upper.slice(prefix.length);
		// "INTERIOR" must not match "INT" — the prefix has to end the word.
		if (rest === '' || rest.startsWith(' ') || rest.startsWith('.')) return prefix;
	}
	return null;
}

/**
 * Parses a scene-heading line into its parts.
 *
 * The time of day is split on the LAST ` - `, because a location can legitimately
 * contain a hyphen (`INT. SAINT-GERMAIN CAFE - NIGHT`). Note the separator is a
 * hyphen: Fountain has no em-dash form.
 */
export function parseSceneHeading(rawLine: string): SceneHeadingParts {
	let line = rawLine.trim();
	// A comment/alt-text marker can legitimately wrap a whole heading (or sit
	// mid-heading) — stripped FIRST so every caller that hands this function
	// the raw source line (several do, reading straight from `lines[]`) gets
	// correct INT./EXT./location/time parsing regardless, without each of
	// them needing to remember to pre-strip it themselves.
	line = line.replace(ANNOTATION_MARKER_RE, '').trim();
	const loomId = readLoomId(line);
	line = line.replace(LOOM_ID_RE_G, '').trim();

	// Production scene number, at the END of the line: `INT. HOUSE - DAY #7#`.
	let sceneNumber = '';
	const numMatch = /#([^#\s][^#]*)#\s*$/.exec(line);
	if (numMatch) {
		sceneNumber = numMatch[1].trim();
		line = line.slice(0, numMatch.index).trim();
	}

	let intExt = '';
	if (line.startsWith('.') && !line.startsWith('..')) {
		line = line.slice(1).trim(); // forced heading — no INT./EXT. of its own
	} else {
		const prefix = scenePrefixOf(line);
		if (prefix) {
			intExt = line.slice(0, prefix.length).trim().toUpperCase();
			if (!intExt.endsWith('.')) intExt += '.';
			line = line.slice(prefix.length).replace(/^\.?\s*/, '').trim();
		}
	}

	let location = line;
	let timeOfDay = '';
	const dash = line.lastIndexOf(' - ');
	if (dash > 0) {
		location = line.slice(0, dash).trim();
		timeOfDay = line.slice(dash + 3).trim();
	}
	return { intExt, location, timeOfDay, sceneNumber, loomId };
}

/** Rebuilds a heading line from its parts (loom id appended last). */
export function renderSceneHeading(parts: SceneHeadingParts): string {
	const head = parts.intExt === '' ? `.${parts.location}` : `${parts.intExt} ${parts.location}`;
	let line = parts.timeOfDay === '' ? head : `${head} - ${parts.timeOfDay}`;
	if (parts.sceneNumber !== '') line += ` #${parts.sceneNumber}#`;
	if (parts.loomId !== null) line += ` [[loom:${parts.loomId}]]`;
	return line;
}

const CHARACTER_EXT_RE = /\(([^)]*)\)\s*\^?\s*$/;

/** Whether a line reads as a character cue: uppercase, and carrying a letter. */
function looksLikeCharacter(line: string): boolean {
	const text = line.replace(CHARACTER_EXT_RE, '').replace(/\^\s*$/, '').trim();
	if (text === '') return false;
	if (!/[A-Za-z]/.test(text)) return false;
	return text === text.toUpperCase();
}

/** Transitions are uppercase and end in `TO:` (`CUT TO:`, `DISSOLVE TO:`). */
function looksLikeTransition(line: string): boolean {
	const text = line.trim();
	return text === text.toUpperCase() && /[A-Za-z]/.test(text) && /TO:$/.test(text);
}

/** Strips inline notes and boneyard comments from displayed text. */
function stripAnnotations(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\[\[[\s\S]*?\]\]/g, '')
		.trim();
}

// --- Pagination ------------------------------------------------------------

/**
 * US screenplay metrics at 12pt Courier (10 characters per inch). Fountain
 * itself says nothing about pages — these are the standard render widths, and
 * they're what makes a page count mean roughly a minute of screen time.
 */
const LINES_PER_PAGE = 55;
const WIDTH: Record<ElementType, number> = {
	'scene-heading': 61,
	action: 61,
	character: 38,
	dialogue: 35,
	parenthetical: 26,
	transition: 61,
	section: 61,
	synopsis: 61,
	centered: 61,
	lyrics: 35,
	'page-break': 61,
};

/** How many rendered lines an element occupies once wrapped to its width. */
function renderedLines(element: FountainElement): number {
	// Sections and synopses are structural — they never reach the page.
	if (element.type === 'section' || element.type === 'synopsis') return 0;
	const width = WIDTH[element.type] ?? 61;
	const text = element.text;
	if (text.trim() === '') return 1;
	// Wrap on words, the way a renderer would.
	let lines = 0;
	for (const paragraph of text.split('\n')) {
		let used = 0;
		let count = 1;
		for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
			const need = used === 0 ? word.length : used + 1 + word.length;
			if (need > width) {
				count++;
				used = word.length;
			} else {
				used = need;
			}
		}
		lines += count;
	}
	return lines;
}

// --- Scenes ----------------------------------------------------------------

export interface ParsedScene extends SceneHeadingParts {
	/** Heading as displayed (no scene number, no loom id). */
	heading: string;
	/** 0-based line of the heading. */
	line: number;
	/** 0-based line after the scene's last line (exclusive). */
	endLine: number;
	/** Enclosing section titles, outermost first — the chapters a scene sits in. */
	sectionPath: string[];
	/** 1-based page the scene starts on. Derived, never stored. */
	firstPage: number;
	/** 1-based page the scene ends on. */
	lastPage: number;
	/** Character cues speaking in this scene, in first-appearance order. */
	characters: string[];
	/** 1-based position in the script, ignoring sections. */
	index: number;
	/** The nearest enclosing branch-tagged section's own loom id, or `null`
	 *  when this scene isn't inside a branch — the deepest ancestor with a
	 *  `branchGroup`, not just its immediate parent (a branch can nest inside
	 *  ordinary untagged sub-sections). */
	branchLoomId: string | null;
}

export interface ParsedSection {
	level: number;
	text: string;
	line: number;
	/** Hidden `[[loom:…]]` marker, like a scene heading's — what ties a top-level
	 *  section to its Chapter note across a rename or a move. */
	loomId: string | null;
	/** The branch group this section belongs to, from a `= branch: <id>`
	 *  synopsis line directly beneath its heading (no blank line) — an
	 *  ordinary nested `##`/`###` that ISN'T tagged has `branchGroup: null`
	 *  and is just structure, never a branch. Any number of sibling sections
	 *  sharing the same group id form one narrative choice point. */
	branchGroup: string | null;
}

/**
 * A page break (`===`) recognized as sitting BETWEEN two top-level chapters —
 * see the derivation in `parseFountain` for the exact rule. A page break
 * anywhere else (mid-scene, between two scenes in the same chapter, right
 * after a chapter heading before its own first scene) is plain content and
 * never appears here.
 */
export interface ParsedPageBreak {
	line: number;
	/** Hidden `[[loom:…]]` marker, like a scene/section heading's — assigned
	 *  additively by `ensureSceneIds` once recognized, same lifecycle a scene
	 *  or chapter id has. */
	loomId: string | null;
}

export interface ParsedScript {
	titlePage: TitlePage;
	/** 0-based line the body starts on (after any title page). */
	bodyStart: number;
	elements: FountainElement[];
	scenes: ParsedScene[];
	sections: ParsedSection[];
	/** Chapter-boundary page breaks — see `ParsedPageBreak`. */
	pageBreaks: ParsedPageBreak[];
	/** Distinct character cues across the script, alphabetical. */
	characters: string[];
	/** Distinct scene locations across the script, alphabetical. */
	locations: string[];
	/** Total derived page count. */
	pages: number;
}

/**
 * Parses a whole `.fountain` file.
 *
 * The element rules that actually matter, since they're the ones easy to get
 * wrong: a scene heading needs a blank line before it; a CHARACTER cue is an
 * uppercase line with a blank line before **and a non-blank line after** — that
 * trailing condition is the only thing separating `SARAH` from `CUT TO:`.
 */
export function parseFountain(text: string): ParsedScript {
	const lines = text.split(/\r?\n/);
	const { title, bodyStart } = splitTitlePage(lines);

	// Boneyards can span lines, so track whether we're inside one.
	let inBoneyard = false;
	const elements: FountainElement[] = [];
	const sections: ParsedSection[] = [];

	const isBlank = (i: number) => i < 0 || i >= lines.length || lines[i].trim() === '';

	let i = bodyStart;
	while (i < lines.length) {
		const rawLine = lines[i];
		const line = rawLine.trim();
		// Every classification test below (`startsWith`, `scenePrefixOf`,
		// `looksLikeCharacter`/`looksLikeTransition`'s uppercase check) has to
		// see PAST a comment/alt-text marker — one can legitimately open right
		// at a line's start (commenting a whole scene heading or character cue
		// is ordinary), and without this the real content gets pushed out of
		// position and silently misclassified as plain action text. `cls` is
		// `line` with every marker token removed EXACTLY (no whitespace
		// swallowed, since a marker can sit mid-sentence) — used only for
		// classification/extraction here; nothing below needs the original
		// `line` back once `cls` exists, since `stripAnnotations` already
		// strips ANY `[[...]]` from action/character/dialogue text regardless
		// of position, and `parseSceneHeading` now strips markers internally.
		const cls = line.replace(ANNOTATION_MARKER_RE, '');

		if (inBoneyard) {
			if (line.includes('*/')) inBoneyard = false;
			i++;
			continue;
		}
		if (line.includes('/*') && !line.includes('*/')) {
			inBoneyard = true;
			i++;
			continue;
		}
		if (line === '') {
			i++;
			continue;
		}

		// Page break: three or more `=`, optionally carrying a hidden loom id
		// (only ones recognized as sitting BETWEEN chapters ever get one — see
		// the `pageBreaks` derivation below). Checked before synopsis, `=`.
		if (/^={3,}$/.test(cls.replace(LOOM_ID_RE_G, '').trim())) {
			elements.push({ type: 'page-break', text: '', line: i, loomId: readLoomId(rawLine) });
			i++;
			continue;
		}
		// Section — structural only, never exported. This is why a chapter that
		// must appear in the PDF also needs a centered-bold title.
		if (cls.startsWith('#')) {
			const level = /^#+/.exec(cls)?.[0].length ?? 1;
			const loomId = readLoomId(line);
			// A `= branch: <id>` tag directly beneath (no blank line) — consumed
			// here rather than left to fall through to the generic synopsis
			// handling below, so it doesn't also surface as a floating note.
			let branchGroup: string | null = null;
			let consumed = 1;
			if (i + 1 < lines.length) {
				const branchMatch = BRANCH_TAG_RE.exec(lines[i + 1].trim());
				if (branchMatch) {
					branchGroup = branchMatch[1].trim();
					consumed = 2;
				}
			}
			const heading: ParsedSection = {
				level,
				text: cls.slice(level).replace(LOOM_ID_RE_G, '').trim(),
				line: i,
				loomId,
				branchGroup,
			};
			sections.push(heading);
			elements.push({ type: 'section', text: heading.text, line: i, level });
			i += consumed;
			continue;
		}
		if (cls.startsWith('=')) {
			elements.push({ type: 'synopsis', text: cls.slice(1).trim(), line: i });
			i++;
			continue;
		}
		// Centered: `> text <`. Must be checked before forced transitions.
		if (cls.startsWith('>') && cls.endsWith('<')) {
			elements.push({ type: 'centered', text: cls.slice(1, -1).trim(), line: i });
			i++;
			continue;
		}
		if (cls.startsWith('>')) {
			elements.push({ type: 'transition', text: cls.slice(1).trim(), line: i });
			i++;
			continue;
		}
		if (cls.startsWith('!')) {
			elements.push({ type: 'action', text: stripAnnotations(cls.slice(1)), line: i });
			i++;
			continue;
		}
		if (cls.startsWith('~')) {
			elements.push({ type: 'lyrics', text: cls.slice(1).trim(), line: i });
			i++;
			continue;
		}

		// Scene heading: a prefix (or a forcing `.`) with a blank line before it.
		const forced = cls.startsWith('.') && !cls.startsWith('..');
		if ((forced || scenePrefixOf(cls) !== null) && isBlank(i - 1)) {
			// DISPLAY text: the hidden loom id and the forcing `.` are stripped,
			// so nothing that renders this (preview, HTML export) can leak the
			// id. The scene derivation below re-parses the RAW line instead, and
			// that is where the id is read from.
			const parts = parseSceneHeading(line);
			elements.push({
				type: 'scene-heading',
				text: renderSceneHeading({ ...parts, sceneNumber: '', loomId: null }).replace(/^\./, ''),
				line: i,
				sceneNumber: parts.sceneNumber || undefined,
			});
			i++;
			continue;
		}

		// Character cue: uppercase, blank line before, non-blank line after.
		// `@[` is an entity link (see ENTITY_LINK_RE above), not a forced cue.
		const forcedCharacter = cls.startsWith('@') && cls.charAt(1) !== '[';
		const cueLine = forcedCharacter ? cls.slice(1).trim() : cls;
		if (
			(forcedCharacter || (looksLikeCharacter(cueLine) && !looksLikeTransition(cueLine))) &&
			isBlank(i - 1) &&
			!isBlank(i + 1)
		) {
			const dual = /\^\s*$/.test(cueLine);
			const withoutDual = cueLine.replace(/\^\s*$/, '').trim();
			const extension = CHARACTER_EXT_RE.exec(withoutDual)?.[1].trim();
			const name = stripAnnotations(withoutDual.replace(CHARACTER_EXT_RE, '')).trim();
			elements.push({ type: 'character', text: name, line: i, extension, dual });
			i++;
			// Everything up to the next blank line belongs to this cue. Per the
			// Fountain spec, successive dialogue lines are NOT separate
			// paragraphs the way action lines are — they're one continuous
			// speech, so consecutive non-parenthetical lines are joined into a
			// single dialogue element (only a parenthetical breaks the run).
			let dialogue: string[] = [];
			let dialogueLine = i;
			const flushDialogue = () => {
				if (dialogue.length === 0) return;
				elements.push({ type: 'dialogue', text: dialogue.join('\n'), line: dialogueLine });
				dialogue = [];
			};
			while (i < lines.length && lines[i].trim() !== '') {
				const block = lines[i].trim();
				// Same reasoning as the outer `cls` — a fully-commented
				// parenthetical (`[[loom-comment:x]](beat)[[/loom-comment:x]]`)
				// no longer starts/ends with its parens once wrapped, so the
				// classification test needs the marker-stripped view too; the
				// stored text switches to it as well (previously `block` here
				// had NO stripping at all, unlike every other element type).
				const blockCls = block.replace(ANNOTATION_MARKER_RE, '');
				if (blockCls.startsWith('(') && blockCls.endsWith(')')) {
					flushDialogue();
					elements.push({ type: 'parenthetical', text: blockCls, line: i });
					dialogueLine = i + 1;
				} else {
					if (dialogue.length === 0) dialogueLine = i;
					dialogue.push(stripAnnotations(block));
				}
				i++;
			}
			flushDialogue();
			continue;
		}

		// Unforced transition: uppercase, ends in TO:, blank lines both sides.
		if (looksLikeTransition(cls) && isBlank(i - 1) && isBlank(i + 1)) {
			elements.push({ type: 'transition', text: cls, line: i });
			i++;
			continue;
		}

		const action = stripAnnotations(rawLine);
		if (action !== '') elements.push({ type: 'action', text: action, line: i });
		i++;
	}

	// --- Derive scenes, their page ranges and their casts --------------------
	//
	// Page numbers are computed here and thrown away with the parse: nothing is
	// stored, so adding five pages to an earlier scene shifts every later scene
	// automatically, which is the whole point.
	const scenes: ParsedScene[] = [];
	const sectionStack: { level: number; text: string; loomId: string | null; branchGroup: string | null }[] = [];
	let usedLines = 0;
	let current: ParsedScene | null = null;

	const closeScene = (endLine: number) => {
		if (!current) return;
		current.endLine = endLine;
		current.lastPage = Math.max(current.firstPage, Math.floor(usedLines / LINES_PER_PAGE) + 1);
		scenes.push(current);
		current = null;
	};

	for (const element of elements) {
		if (element.type === 'section') {
			while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= (element.level ?? 1)) {
				sectionStack.pop();
			}
			const sec = sections.find((s) => s.line === element.line);
			sectionStack.push({
				level: element.level ?? 1,
				text: element.text,
				loomId: sec?.loomId ?? null,
				branchGroup: sec?.branchGroup ?? null,
			});
			continue;
		}
		if (element.type === 'page-break') {
			usedLines = Math.ceil((usedLines + 1) / LINES_PER_PAGE) * LINES_PER_PAGE;
			element.page = Math.floor(usedLines / LINES_PER_PAGE) + 1;
			continue;
		}
		element.page = Math.floor(usedLines / LINES_PER_PAGE) + 1;
		if (element.type === 'scene-heading') {
			closeScene(element.line);
			// A scene heading always belongs to the nearest REAL (non-branch)
			// section — a branch holds prose, never a further scene heading of
			// its own — so hitting one closes any currently open branch frame
			// first. Without this, a scene written right after a branch (once
			// its choice point has resolved) stayed nested inside that branch.
			while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].branchGroup !== null) {
				sectionStack.pop();
			}
			// From the raw line, so the loom id is seen — the element's own text
			// has already had it stripped for display.
			const parts = parseSceneHeading(lines[element.line]);
			current = {
				...parts,
				heading: renderSceneHeading({ ...parts, sceneNumber: '', loomId: null }).replace(/^\./, ''),
				line: element.line,
				endLine: element.line + 1,
				sectionPath: sectionStack.map((s) => s.text),
				firstPage: Math.floor(usedLines / LINES_PER_PAGE) + 1,
				lastPage: Math.floor(usedLines / LINES_PER_PAGE) + 1,
				characters: [],
				index: scenes.length + 1,
				branchLoomId: [...sectionStack].reverse().find((s) => s.branchGroup !== null)?.loomId ?? null,
			};
		}
		if (current && element.type === 'character' && !current.characters.includes(element.text)) {
			current.characters.push(element.text);
		}
		// Elements are separated by a blank line in the render.
		usedLines += renderedLines(element) + (element.type === 'dialogue' || element.type === 'parenthetical' ? 0 : 1);
	}
	closeScene(lines.length);

	const characters = [
		...new Set(elements.filter((e) => e.type === 'character').map((e) => e.text)),
	].sort((a, b) => a.localeCompare(b));
	const locations = [...new Set(scenes.map((s) => s.location).filter((l) => l !== ''))].sort((a, b) =>
		a.localeCompare(b)
	);

	// A page break counts as sitting BETWEEN chapters — and is promoted to its
	// own Outline entry — only when the next NON-page-break element (blanks
	// are already skipped everywhere in `elements`; several page breaks in a
	// row are skipped too, so a whole run is judged as one unit) is a
	// top-level chapter heading, or there simply isn't one (end of file).
	// Anywhere else — between two scenes, mid-scene, right after a chapter
	// heading before its own first scene — it's plain content and stays
	// exactly where it was typed.
	const pageBreaks: ParsedPageBreak[] = [];
	elements.forEach((el, idx) => {
		if (el.type !== 'page-break') return;
		let j = idx;
		while (j + 1 < elements.length && elements[j + 1].type === 'page-break') j++;
		const next = elements[j + 1];
		const isBoundary = !next || (next.type === 'section' && next.level === 1);
		if (isBoundary) pageBreaks.push({ line: el.line, loomId: el.loomId ?? null });
	});

	return {
		titlePage: title,
		bodyStart,
		elements,
		scenes,
		sections,
		pageBreaks,
		characters,
		locations,
		pages: Math.max(1, Math.floor(usedLines / LINES_PER_PAGE) + 1),
	};
}

/**
 * Gives every scene heading, chapter-tracking section, and chapter-boundary
 * page break a `[[loom:…]]` id, returning the rewritten text.
 *
 * This is the one write that has to happen before scenes can be mirrored into
 * entity notes — an id is what survives a rename-and-move that heuristics would
 * lose. It only ever ADDS: an existing id is never changed or removed, so the
 * operation is idempotent and safe to run on every load.
 */
export function ensureSceneIds(text: string): { text: string; changed: boolean } {
	const parsed = parseFountain(text);
	// Top-level sections are chapters, and they need a stable identity for the
	// same reason scenes do: a renamed-and-moved heading must not detach its
	// note. Nested sections are ordinary structure inside a chapter EXCEPT a
	// branch-tagged one (`= branch: <id>` right beneath it) — that's a Scene's
	// own `loomSceneBranch` target, so it needs the same stable identity at
	// whatever depth it sits. A page break only ever gets one once `parseFountain`
	// has already recognized it as sitting BETWEEN chapters (`pageBreaks`) — one
	// typed inside a scene is plain content and is never touched here, which is
	// what keeps it from vanishing out of that scene's own text into the Outline.
	const missing: number[] = [
		...parsed.scenes.filter((s) => s.loomId === null).map((s) => s.line),
		...parsed.sections
			.filter((s) => (s.level === 1 || s.branchGroup !== null) && s.loomId === null)
			.map((s) => s.line),
		...parsed.pageBreaks.filter((pb) => pb.loomId === null).map((pb) => pb.line),
	];
	if (missing.length === 0) return { text, changed: false };

	const lines = text.split(/\r?\n/);
	const seen = new Set(
		[...parsed.scenes, ...parsed.sections, ...parsed.pageBreaks]
			.map((s) => s.loomId)
			.filter((id): id is string => id !== null)
	);
	for (const line of missing) {
		let id = newSceneId();
		while (seen.has(id)) id = newSceneId();
		seen.add(id);
		lines[line] = `${lines[line].trimEnd()} [[loom:${id}]]`;
	}
	return { text: lines.join('\n'), changed: true };
}

/**
 * Writes each chapter's display title into the script as a centered-bold line
 * under its section.
 *
 * Fountain sections never export, so a chapter title that has to appear in the
 * PDF must be emitted separately — `>**ACT ONE**<` is the convention. That
 * makes the note's `loomDisplayTitle` the source of truth for this one line,
 * and this function is what keeps the script matching it. Passing '' removes
 * the line again.
 *
 * Only ever touches the centered line directly beneath a section, so nothing
 * else in the script can be disturbed.
 */
export function applyDisplayTitles(
	text: string,
	/** Display title per top-level section loom id; '' or absent removes it. */
	titles: Map<string, string>
): string {
	const parsed = parseFountain(text);
	const lines = text.split(/\r?\n/);
	// Back to front, so earlier line numbers stay valid as lines are spliced.
	const sections = parsed.sections
		.filter((sec) => sec.level === 1 && sec.loomId !== null)
		.sort((a, b) => b.line - a.line);

	for (const section of sections) {
		const wanted = (titles.get(section.loomId as string) ?? '').trim();
		// The centered line immediately below, skipping one blank.
		let at = section.line + 1;
		while (at < lines.length && lines[at].trim() === '') at++;
		const existing = at < lines.length && /^>.*<$/.test(lines[at].trim()) ? at : -1;

		if (wanted === '') {
			if (existing !== -1) {
				lines.splice(existing, lines[existing + 1]?.trim() === '' ? 2 : 1);
			}
			continue;
		}
		const rendered = `>**${wanted}**<`;
		if (existing !== -1) {
			if (lines[existing].trim() !== rendered) lines[existing] = rendered;
		} else {
			lines.splice(section.line + 1, 0, '', rendered);
		}
	}
	return lines.join('\n');
}

/**
 * Writes a printed marker under every branch-tagged section (`= branch:
 * <id>`) so an exported screenplay shows a visual separator between branches
 * instead of every branch's content running together with no indication a
 * choice point even exists — Fountain sections never export, same reasoning
 * as `applyDisplayTitles` for chapters, but auto-derived from the section's
 * own title text rather than a note field (a branch has no backing note).
 * Kept in sync on every call, so renaming `## Branch A` to `## Branch A:
 * Fight` updates the printed line too.
 */
export function applyBranchLabels(text: string): string {
	const parsed = parseFountain(text);
	const lines = text.split(/\r?\n/);
	// Back to front, so earlier line numbers stay valid as lines are spliced.
	const sections = parsed.sections.filter((sec) => sec.branchGroup !== null).sort((a, b) => b.line - a.line);

	for (const section of sections) {
		let at = section.line + 1;
		// Skip the `= branch: <id>` tag itself — it's real text in the file;
		// the parser only leaves it out of the rendered element stream.
		if (at < lines.length && BRANCH_TAG_RE.test(lines[at].trim())) at++;
		while (at < lines.length && lines[at].trim() === '') at++;
		const existing = at < lines.length && /^>.*<$/.test(lines[at].trim()) ? at : -1;
		const wanted = `>**${section.text}**<`;
		if (existing !== -1) {
			if (lines[existing].trim() !== wanted) lines[existing] = wanted;
		} else {
			lines.splice(at, 0, '', wanted);
		}
	}
	return lines.join('\n');
}

/** The scene a line falls inside, or null. */
export function sceneAtLine(parsed: ParsedScript, line: number): ParsedScene | null {
	return parsed.scenes.find((s) => line >= s.line && line < sceneEndLine(parsed, s)) ?? null;
}

/**
 * Scene loom ids currently backed by a heading in the script — what tells a
 * Scene note apart from an "orphan" (its heading was rewritten or deleted
 * directly in the script text, rather than through the Scene page's own
 * fields, which keep the same id across a rename). Shared by the Script
 * view's own orphan panel and the Scenes list's "Not in the script" filter,
 * so the two never drift.
 */
export function liveSceneIds(parsed: ParsedScript): Set<string> {
	return new Set(parsed.scenes.map((s) => s.loomId).filter((id): id is string => id !== null));
}

/** Chapter (top-level section) loom ids currently backed by a `#` line —
 *  the Chapter equivalent of `liveSceneIds`. */
export function liveChapterIds(parsed: ParsedScript): Set<string> {
	return new Set(
		parsed.sections.filter((s) => s.level === 1 && s.loomId !== null).map((s) => s.loomId as string)
	);
}

/** `"10–23"`, or `"10"` when a scene fits on one page. */
export function pageRangeLabel(scene: ParsedScene): string {
	return scene.firstPage === scene.lastPage
		? String(scene.firstPage)
		: `${scene.firstPage}–${scene.lastPage}`;
}

// --- Rendering -------------------------------------------------------------

/**
 * Elements grouped into pages, for anything that displays the script the way it
 * will print. Sections and synopses are dropped — they're structural and never
 * reach the page, which is exactly why a chapter title that must appear in the
 * output has to be written separately as centered bold.
 */
export function paginate(parsed: ParsedScript): FountainElement[][] {
	const pages: FountainElement[][] = [];
	for (const element of parsed.elements) {
		if (element.type === 'section' || element.type === 'synopsis') continue;
		if (element.type === 'page-break') continue;
		const page = (element.page ?? 1) - 1;
		while (pages.length <= page) pages.push([]);
		pages[page].push(element);
	}
	return pages.length > 0 ? pages : [[]];
}

/**
 * An element's full display text. A character cue keeps its `(V.O.)`-style
 * extension, which the parser splits off into its own field — every renderer
 * has to put it back or the printed cue reads as a different character.
 */
export function elementText(element: FountainElement): string {
	if (element.type === 'character' && element.extension !== undefined && element.extension !== '') {
		return `${element.text} (${element.extension})`;
	}
	return element.text;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Fountain's inline emphasis: `**bold**`, `*italic*`, `_underline_`. Applied
 * after escaping, so script text can contain `<` and `&` safely.
 *
 * A backslash-escaped `\*`, `\_` or `\\` (the standard Markdown convention for
 * "this literal character, not a delimiter" — e.g. `Colour\_DP-01` so the
 * underscore doesn't start an underline) is swapped for a placeholder BEFORE
 * the emphasis regexes run, so it can never be mistaken for a real delimiter,
 * then restored as the literal (HTML-escaped) character afterward. Without
 * this the backslash itself leaked into the rendered output instead of being
 * consumed by the escape.
 */
export function renderInline(text: string): string {
	const escapedChars: string[] = [];
	const withPlaceholders = text.replace(/\\([*_\\])/g, (_, ch: string) => {
		escapedChars.push(ch);
		return `\uE000${escapedChars.length - 1}\uE000`;
	});
	const html = escapeHtml(withPlaceholders)
		.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<em>$1</em>')
		.replace(/_(.+?)_/g, '<u>$1</u>');
	return html.replace(/\uE000(\d+)\uE000/g, (_, i: string) => escapeHtml(escapedChars[Number(i)]));
}

// --- Orphan prevention -------------------------------------------------

/**
 * English articles, one-letter words, and short prepositions/conjunctions \u2014
 * the class of "glue" word a compositor never wants left alone at the end of
 * a wrapped line (`...what does a` / `swear mean...` instead of `...what
 * does` / `a swear mean...`). Shared by every rendering surface that wraps
 * prose: the Pages-preview renderer (`preventOrphans`, below \u2014 glues with a
 * non-breaking space, safe since it's throwaway generated HTML/PDF text) and
 * the live-preview editor (`findOrphanPairs` \u2014 glues visually via a
 * `nowrap` decoration in `fountain-field.tsx` instead, since it must never
 * alter the actual document text).
 */
export const ORPHAN_WORDS = new Set([
	'a',
	'an',
	'the',
	'i',
	'of',
	'in',
	'on',
	'at',
	'by',
	'to',
	'up',
	'as',
	'is',
	'it',
	'or',
	'if',
	'so',
	'no',
	'and',
	'but',
	'nor',
	'yet',
	'for',
]);

const ORPHAN_PAIR_RE = /\b([A-Za-z]+)( )([A-Za-z]+)/g;

/**
 * Finds every `<glue word> <next word>` run and returns the whole pair's
 * span (word, the space, and the following word) \u2014 for a caller that wants
 * to mark it non-breaking without touching the underlying text.
 */
export function findOrphanPairs(text: string): { from: number; to: number }[] {
	const spans: { from: number; to: number }[] = [];
	for (const m of text.matchAll(ORPHAN_PAIR_RE)) {
		if (!ORPHAN_WORDS.has(m[1].toLowerCase())) continue;
		spans.push({ from: m.index, to: m.index + m[0].length });
	}
	return spans;
}

/**
 * Replaces the space after a short "glue" word with a non-breaking space, so
 * wrapping can never strand it alone at the end of a line. For generated
 * preview text ONLY (call before `renderInline`/`plainText`) \u2014 never written
 * back into the script itself.
 */
export function preventOrphans(text: string): string {
	return text.replace(ORPHAN_PAIR_RE, (match, word: string) =>
		ORPHAN_WORDS.has(word.toLowerCase()) ? match.replace(' ', '\u00A0') : match
	);
}

/** Screenplay CSS: US Letter margins, 12pt Courier, standard element indents. */
const SCREENPLAY_CSS = `
@page { size: Letter; margin: 1in 1in 1in 1.5in; }
body { background: #525659; margin: 0; padding: 24px 0; font-family: "Courier New", Courier, monospace; font-size: 12pt; line-height: 1; }
.page { background: #fff; color: #000; width: 8.5in; min-height: 11in; box-sizing: border-box; padding: 1in 1in 1in 1.5in; margin: 0 auto 24px; position: relative; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
.page-number { position: absolute; top: .5in; right: 1in; font-size: 12pt; }
.title-page { text-align: center; }
.title-page .title { margin-top: 3.5in; text-transform: uppercase; font-weight: bold; }
.title-page .byline { margin-top: .5in; }
.title-page .lower-left { position: absolute; left: 1.5in; bottom: 1in; text-align: left; }
p { margin: 0 0 1em; white-space: pre-wrap; }
.scene-heading { font-weight: bold; text-transform: uppercase; }
.action { }
.character { margin-left: 2.2in; margin-bottom: 0; text-transform: uppercase; }
.parenthetical { margin-left: 1.6in; margin-bottom: 0; }
.dialogue { margin-left: 1in; margin-right: 1.5in; margin-bottom: 1em; }
.transition { text-align: right; text-transform: uppercase; }
.centered { text-align: center; }
.lyrics { margin-left: 1in; font-style: italic; }
@media print {
  body { background: #fff; padding: 0; }
  .page { box-shadow: none; margin: 0; width: auto; min-height: 0; padding: 0; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
}
`;

/**
 * Renders the script as standalone, print-ready HTML — the export path to PDF.
 *
 * Deliberately not a PDF generator: a browser's own "Print → Save as PDF"
 * produces a correct screenplay from this with no bundled PDF library, and the
 * file is readable and re-styleable on its own. Loom ids never reach it, since
 * everything rendered comes from the parse rather than the raw text.
 */
export function renderScreenplayHtml(parsed: ParsedScript): string {
	const t = parsed.titlePage;
	const pages = paginate(parsed);

	const titleBlock =
		t.title.trim() === '' && t.author.trim() === ''
			? ''
			: `<div class="page title-page">
	<div class="title">${renderInline(t.title)}</div>
	${t.credit.trim() !== '' ? `<div class="byline">${renderInline(t.credit)}</div>` : ''}
	${t.author.trim() !== '' ? `<div class="byline">${renderInline(t.author)}</div>` : ''}
	${t.source.trim() !== '' ? `<div class="byline">${renderInline(t.source)}</div>` : ''}
	<div class="lower-left">
		${t.draftDate.trim() !== '' ? `<div>${renderInline(t.draftDate)}</div>` : ''}
		${t.contact.trim() !== '' ? `<div>${renderInline(t.contact)}</div>` : ''}
		${t.copyright.trim() !== '' ? `<div>${renderInline(t.copyright)}</div>` : ''}
	</div>
</div>`;

	const body = pages
		.map(
			(elements, i) => `<div class="page">
	${i > 0 ? `<div class="page-number">${i + 1}.</div>` : ''}
	${elements.map((e) => `<p class="${e.type}">${renderInline(stripAnnotationMarkers(stripEntityLinksForDisplay(elementText(e))))}</p>`).join('\n\t')}
</div>`
		)
		.join('\n');

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(t.title.trim() === '' ? 'Screenplay' : t.title.replace(/\n/g, ' '))}</title>
<style>${SCREENPLAY_CSS}</style>
</head>
<body>
${titleBlock}
${body}
</body>
</html>
`;
}

// --- Import ----------------------------------------------------------------

/**
 * Re-attaches an incoming script's scenes to the ids they had before.
 *
 * This is the ONE place heuristic matching belongs (see ROADMAP, "Scene
 * identity"): a script that went out through export, got edited elsewhere and
 * came back has had its `[[loom:…]]` markers stripped, so there is nothing else
 * left to match on. Everywhere else, identity is the marker and only the marker.
 *
 * Matching is conservative — an incoming scene claims an old id only when its
 * heading text is an exact (case-insensitive) match and that id hasn't already
 * been claimed, walking in script order so repeated headings ("INT. HOUSE -
 * DAY" three times) pair up in sequence rather than all grabbing the first.
 * Anything unmatched is left alone and simply becomes a new scene.
 */
export function reattachSceneIds(
	incoming: string,
	/** Existing scenes' ids keyed in script order: `{ id, heading }`. */
	known: { id: string; heading: string }[]
): { text: string; matched: number; added: number; orphaned: number } {
	const parsed = parseFountain(incoming);
	const lines = incoming.split(/\r?\n/);
	const taken = new Set(parsed.scenes.map((s) => s.loomId).filter((id): id is string => id !== null));
	const pool = known.filter((k) => !taken.has(k.id));
	const used = new Set<string>();

	let matched = 0;
	for (const scene of parsed.scenes) {
		if (scene.loomId !== null) continue;
		const heading = scene.heading.trim().toLowerCase();
		const hit = pool.find((k) => !used.has(k.id) && k.heading.trim().toLowerCase() === heading);
		if (!hit) continue;
		used.add(hit.id);
		matched++;
		lines[scene.line] = `${lines[scene.line].trimEnd()} [[loom:${hit.id}]]`;
	}
	return {
		text: lines.join('\n'),
		matched,
		added: parsed.scenes.length - matched - parsed.scenes.filter((s) => s.loomId !== null).length,
		orphaned: known.length - matched - [...taken].filter((id) => known.some((k) => k.id === id)).length,
	};
}

/**
 * Re-attaches an incoming script's top-level sections (chapters) to the ids
 * they had before — the same recovery heuristic as `reattachSceneIds`, and for
 * the same reason: an export → edit elsewhere → import round trip strips every
 * `[[loom:…]]` marker, sections included. Without this, every reimport created
 * brand-new Chapter notes and orphaned the old ones, which is what silently
 * dropped their display titles.
 *
 * Matching is conservative, same as scenes: an incoming section claims an old
 * id only on an exact case-insensitive title match, walking in script order.
 */
export function reattachSectionIds(
	incoming: string,
	/** Existing chapters' ids keyed in script order: `{ id, title }`. */
	known: { id: string; title: string }[]
): { text: string; matched: number } {
	const parsed = parseFountain(incoming);
	const lines = incoming.split(/\r?\n/);
	const taken = new Set(
		parsed.sections.map((s) => s.loomId).filter((id): id is string => id !== null)
	);
	const pool = known.filter((k) => !taken.has(k.id));
	const used = new Set<string>();

	let matched = 0;
	for (const section of parsed.sections) {
		if (section.level !== 1 || section.loomId !== null) continue;
		const title = section.text.trim().toLowerCase();
		const hit = pool.find((k) => !used.has(k.id) && k.title.trim().toLowerCase() === title);
		if (!hit) continue;
		used.add(hit.id);
		matched++;
		lines[section.line] = `${lines[section.line].trimEnd()} [[loom:${hit.id}]]`;
	}
	return { text: lines.join('\n'), matched };
}

/**
 * Replaces a scene's body — everything after its heading line — leaving the
 * heading (and the hidden id on it) untouched.
 *
 * This is what lets a Scene page edit its own stretch of the script: the page
 * is a focused window onto the file, not a copy, so the heading stays owned by
 * the script and only the writing beneath it is editable from the note.
 */
export function replaceSceneBody(text: string, sceneId: string, body: string): string | null {
	const parsed = parseFountain(text);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	if (!scene) return null;
	const lines = text.split(/\r?\n/);
	const next = body.replace(/\s+$/, '').split('\n');
	// Keep one blank line between the heading and the body, and one after it,
	// so the surrounding elements still parse as their own blocks.
	lines.splice(scene.line + 1, sceneEndLine(parsed, scene) - scene.line - 1, '', ...next, '');
	return lines.join('\n');
}

/**
 * Replaces a chapter's body — everything after its `#` section line, scene
 * headings included — leaving the section line (and its hidden id) untouched.
 *
 * Mirrors `replaceSceneBody`, but for the Chapter page's own Script section:
 * a chapter's excerpt spans every scene under it, not one heading's worth, so
 * the whole span between this section and the next top-level one is the
 * editable body.
 */
export function replaceChapterBody(text: string, chapterId: string, body: string): string | null {
	const parsed = parseFountain(text);
	const section = parsed.sections.find((sec) => sec.level === 1 && sec.loomId === chapterId);
	if (!section) return null;
	const lines = text.split(/\r?\n/);
	const endLine = nextTopSectionLine(parsed, section.line) ?? lines.length;
	const next = body.replace(/\s+$/, '').split('\n');
	lines.splice(section.line + 1, endLine - section.line - 1, '', ...next, '');
	return lines.join('\n');
}

/** Removes a scene — heading and body — from the script entirely. */
export function removeScene(text: string, sceneId: string): string | null {
	const parsed = parseFountain(text);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	if (!scene) return null;
	const lines = text.split(/\r?\n/);
	lines.splice(scene.line, sceneEndLine(parsed, scene) - scene.line);
	return lines.join('\n');
}

/** Removes a chapter — its `#` section line and everything beneath it (every
 *  scene it holds included) — from the script entirely. Mirrors `removeScene`
 *  one level up, bounded the same way `replaceChapterBody`/`nextTopSectionLine`
 *  are so it can never reach into the next chapter. */
export function removeChapter(text: string, chapterId: string): string | null {
	const parsed = parseFountain(text);
	const section = parsed.sections.find((sec) => sec.level === 1 && sec.loomId === chapterId);
	if (!section) return null;
	const lines = text.split(/\r?\n/);
	const endLine = nextTopSectionLine(parsed, section.line) ?? lines.length;
	lines.splice(section.line, endLine - section.line);
	return lines.join('\n');
}

/** Removes a chapter-boundary page break — its one line, plus a following
 *  blank line if there is one (mirrors the same tidy-up `applyDisplayTitles`
 *  does removing its own centered-title line) — from the script entirely. */
export function removePageBreak(text: string, id: string): string | null {
	const parsed = parseFountain(text);
	const pb = parsed.pageBreaks.find((p) => p.loomId === id);
	if (!pb) return null;
	const lines = text.split(/\r?\n/);
	lines.splice(pb.line, lines[pb.line + 1]?.trim() === '' ? 2 : 1);
	return lines.join('\n');
}

/**
 * The line where a top-level section's content ends: the next top-level
 * section's own line, OR a qualifying chapter-boundary page break's line —
 * whichever comes first — or `null` when neither follows (the caller
 * substitutes the file's line count). A structural edit bounded to ONE
 * chapter must cap here rather than trusting a scene's `endLine` (the parser
 * extends the LAST scene's `endLine` to whatever scene heading comes next in
 * the WHOLE file, chapter boundary or not) — shared by every op that needs
 * "don't reach into the next chapter". Stopping at a page break too is what
 * keeps one from being swept into the PRECEDING chapter's own content (its
 * own scenes, the Chapter page's Script section, …) the moment it's typed —
 * see `ParsedPageBreak`.
 */
export function nextTopSectionLine(parsed: ParsedScript, afterLine: number): number | null {
	const candidates = [
		...parsed.sections.filter((sec) => sec.level === 1 && sec.line > afterLine).map((sec) => sec.line),
		...parsed.pageBreaks.filter((pb) => pb.line > afterLine).map((pb) => pb.line),
	];
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Where a section's own content ends, at ANY level: the next section whose
 * level is <= this one's (a sibling, or a shallower ancestor-level section),
 * or `null` when nothing like that follows (the caller substitutes EOF).
 * `nextTopSectionLine` is this same question hardcoded to level 1 (plus a
 * chapter-boundary page break, which only ever applies there); this is the
 * general form, for bounding a branch section's own block regardless of how
 * deep it's nested.
 */
export function nextSectionAtLevel(parsed: ParsedScript, afterLine: number, level: number): number | null {
	const next = parsed.sections
		.filter((sec) => sec.level <= level && sec.line > afterLine)
		.sort((a, b) => a.line - b.line)[0];
	return next ? next.line : null;
}

/**
 * Where a scene's own content actually ends — its raw `endLine`, capped at
 * the next top-level boundary (`nextTopSectionLine`). `ParsedScene.endLine`
 * extends to whatever scene heading comes next in the WHOLE file, chapter
 * boundary or not, so trusting it directly for the LAST scene in a chapter
 * sweeps in everything up to the next chapter's own first scene — its
 * heading, display title, any page break sitting between them, all of it.
 * Every op that reads, removes, or moves a scene's own span goes through
 * this instead.
 */
export function sceneEndLine(parsed: ParsedScript, scene: ParsedScene): number {
	const cap = nextTopSectionLine(parsed, scene.line);
	return cap === null ? scene.endLine : Math.min(scene.endLine, cap);
}

/**
 * Moves a scene under a different chapter: its whole block is lifted out and
 * re-inserted at the end of the target section, so re-assigning a chapter on
 * the Scene page actually moves the writing in the script.
 */
export function moveSceneToSection(text: string, sceneId: string, sectionId: string): string | null {
	const parsed = parseFountain(text);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	const target = parsed.sections.find((sec) => sec.loomId === sectionId);
	if (!scene || !target) return null;

	const lines = text.split(/\r?\n/);
	const end = sceneEndLine(parsed, scene);
	const block = lines.slice(scene.line, end);
	let insertAt = nextTopSectionLine(parsed, target.line) ?? lines.length;

	lines.splice(scene.line, end - scene.line);
	// Removing the block shifts everything after it up.
	if (insertAt > scene.line) insertAt -= end - scene.line;
	while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt--;
	const clean = [...block];
	while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
	lines.splice(insertAt, 0, '', ...clean, '');
	return lines.join('\n');
}

/**
 * Splits a scene heading's location text into a main location and an
 * optional sublocation — `"CAFE - COUNTER"` → `{ main: "CAFE", sub:
 * "COUNTER" }`. Splits on the FIRST ` - `, mirroring the time-of-day split
 * (which uses the LAST): a location name that itself contains ` - ` is an
 * accepted, documented limitation, the same class of tradeoff already made
 * there.
 */
export function splitLocationSub(location: string): { main: string; sub: string } {
	const dash = location.indexOf(' - ');
	if (dash < 0) return { main: location.trim(), sub: '' };
	return { main: location.slice(0, dash).trim(), sub: location.slice(dash + 3).trim() };
}

/** Composes a scene heading's location text from a main location and an
 *  optional sublocation — the inverse of `splitLocationSub`. */
export function joinLocationSub(main: string, sub: string): string {
	return sub.trim() === '' ? main.trim() : `${main.trim()} - ${sub.trim()}`;
}

/**
 * Rewrites a scene heading's editable parts (INT./EXT., location, time of
 * day) — what the Scene page's modular heading editor writes through. The
 * production number and hidden loom id are read straight off the RAW line and
 * carried over untouched, so nothing here can lose or duplicate either.
 */
export function setSceneHeadingParts(
	text: string,
	sceneId: string,
	updates: Partial<Pick<SceneHeadingParts, 'intExt' | 'location' | 'timeOfDay'>>
): string | null {
	const parsed = parseFountain(text);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	if (!scene) return null;
	const lines = text.split(/\r?\n/);
	const current = parseSceneHeading(lines[scene.line]);
	lines[scene.line] = renderSceneHeading({ ...current, ...updates });
	return lines.join('\n');
}

/**
 * Moves a scene's block to sit immediately before another scene, wherever
 * that scene is.
 *
 * Reordering within one chapter (drag-and-drop on the Chapter page) and
 * moving to a specific spot in a DIFFERENT chapter (the Scene page's two-step
 * "pick a chapter, then place it" move) are the same operation: relocate the
 * text, and the scene inherits whichever section it now physically sits
 * under — there is no separate "which chapter" field to also update.
 */
export function moveSceneBefore(text: string, sceneId: string, beforeSceneId: string): string | null {
	const parsed = parseFountain(text);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	const target = parsed.scenes.find((sc) => sc.loomId === beforeSceneId);
	if (!scene || !target || scene.loomId === target.loomId) return null;

	const lines = text.split(/\r?\n/);
	const end = sceneEndLine(parsed, scene);
	const block = lines.slice(scene.line, end);
	let insertAt = target.line;

	lines.splice(scene.line, end - scene.line);
	if (insertAt > scene.line) insertAt -= end - scene.line;
	while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt--;
	const clean = [...block];
	while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
	lines.splice(insertAt, 0, '', ...clean, '');
	return lines.join('\n');
}

/**
 * Reorders every scene within one chapter (top-level section) to match
 * `orderedSceneIds` exactly, in one pass — the Chapter page's drag-to-reorder
 * uses this (rather than one `moveSceneBefore` call) because a big jump (the
 * last scene dragged to the front) is one atomic rewrite instead of an
 * "insert before this computed sibling" reasoned from a single moved scene,
 * which is more failure-prone as the distance grows.
 *
 * Only scenes already in this section are touched. A scene's own block
 * (heading + everything up to the next scene) is captured BEFORE the removal,
 * so nested content between scenes travels with the scene it follows — the
 * removal/reinsertion is bounded to the section (the next top-level `#`, or
 * the file end), never reaching into a following chapter, since the LAST
 * scene in a section has its raw `endLine` extended by the parser to
 * whatever scene-heading comes next in the whole file, chapter boundary or
 * not.
 */
export function reorderScenesInSection(
	text: string,
	sectionId: string,
	orderedSceneIds: string[]
): string | null {
	const parsed = parseFountain(text);
	const section = parsed.sections.find((sec) => sec.loomId === sectionId);
	if (!section) return null;
	const lines = text.split(/\r?\n/);
	const sectionEnd = nextTopSectionLine(parsed, section.line) ?? lines.length;

	const inSection = parsed.scenes
		.filter((sc) => sc.line > section.line && sc.line < sectionEnd)
		.sort((a, b) => a.line - b.line);
	if (inSection.length === 0) return null;
	const trueEnd = (sc: ParsedScene) => Math.min(sc.endLine, sectionEnd);

	const insertAt = inSection[0].line;
	const removeEnd = trueEnd(inSection[inSection.length - 1]);
	const blocks = new Map<string, string[]>(
		inSection.map((sc) => [sc.loomId as string, lines.slice(sc.line, trueEnd(sc))])
	);

	const order = [
		...orderedSceneIds.filter((id) => blocks.has(id)),
		...inSection.map((sc) => sc.loomId as string).filter((id) => !orderedSceneIds.includes(id)),
	];
	const rebuilt: string[] = [];
	for (const id of order) {
		const block = blocks.get(id);
		if (!block) continue;
		const clean = [...block];
		while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
		rebuilt.push('', ...clean, '');
	}

	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/**
 * Reorders every sibling section sharing ONE branch-point identifier
 * (`= branch: <id>`) to match `orderedSectionIds` exactly — the Scene page's
 * own Outline uses this, scoped to a single decision point: a branch from a
 * DIFFERENT identifier is never touched, mirroring the nav panel's own
 * `branchPoint` grouping (script-view.tsx's `buildNavTree`) — dragging a
 * branch into a different choice point wouldn't have a coherent meaning, so
 * it's simply not offered.
 *
 * Mirrors `reorderScenesInSection` one level further in: each branch's
 * ENTIRE block (its heading through everything nested beneath it, bounded by
 * `nextSectionAtLevel` rather than a fixed level so it works regardless of
 * how deep the branch sits) travels as one unit, captured up front and
 * spliced back in the requested order.
 */
export function reorderBranchGroup(text: string, groupId: string, orderedSectionIds: string[]): string | null {
	const parsed = parseFountain(text);
	const branches = parsed.sections
		.filter((sec): sec is ParsedSection & { loomId: string } => sec.branchGroup === groupId && sec.loomId !== null)
		.sort((a, b) => a.line - b.line);
	if (branches.length === 0) return null;
	const lines = text.split(/\r?\n/);
	const trueEnd = (sec: ParsedSection) => nextSectionAtLevel(parsed, sec.line, sec.level) ?? lines.length;

	const insertAt = branches[0].line;
	const removeEnd = trueEnd(branches[branches.length - 1]);
	const blocks = new Map<string, string[]>(branches.map((sec) => [sec.loomId, lines.slice(sec.line, trueEnd(sec))]));

	const order = [
		...orderedSectionIds.filter((id) => blocks.has(id)),
		...branches.map((sec) => sec.loomId).filter((id) => !orderedSectionIds.includes(id)),
	];
	const rebuilt: string[] = [];
	for (const id of order) {
		const block = blocks.get(id);
		if (!block) continue;
		const clean = [...block];
		while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
		rebuilt.push(...clean, '');
	}

	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/** One entry in the top-level document sequence — a chapter (its whole
 *  block, scenes included) or a page break sitting between two chapters —
 *  in document order. What `reorderTopLevelEntries`/`reorderTopSections`
 *  reorder. */
export interface TopLevelEntry {
	kind: 'chapter' | 'page-break';
	id: string;
}

/** The current top-level sequence — chapters and chapter-boundary page
 *  breaks — in document order. */
export function topLevelEntries(parsed: ParsedScript): TopLevelEntry[] {
	const chapters = parsed.sections
		.filter((sec): sec is ParsedSection & { loomId: string } => sec.level === 1 && sec.loomId !== null)
		.map((sec) => ({ kind: 'chapter' as const, id: sec.loomId, line: sec.line }));
	const breaks = parsed.pageBreaks
		.filter((pb): pb is ParsedPageBreak & { loomId: string } => pb.loomId !== null)
		.map((pb) => ({ kind: 'page-break' as const, id: pb.loomId, line: pb.line }));
	return [...chapters, ...breaks].sort((a, b) => a.line - b.line).map(({ kind, id }) => ({ kind, id }));
}

/**
 * Shared splice-rebuild behind `reorderTopSections`/`reorderTopLevelEntries`:
 * captures every top-level entry's block UP FRONT (a chapter through
 * `nextTopSectionLine` — scenes and nested structure included — a page break
 * just its own single line), removes the WHOLE span from the first entry
 * through the last in ONE bounded splice, then reinserts every block in
 * `order`. Entries this parse found but `order` omits keep their original
 * relative position, appended after the ones that were placed.
 */
function rebuildTopLevel(text: string, parsed: ParsedScript, order: string[]): string | null {
	const entries = topLevelEntries(parsed);
	if (entries.length === 0) return null;
	const lines = text.split(/\r?\n/);
	const lineOf = new Map<string, number>();
	for (const sec of parsed.sections) if (sec.level === 1 && sec.loomId) lineOf.set(sec.loomId, sec.line);
	for (const pb of parsed.pageBreaks) if (pb.loomId) lineOf.set(pb.loomId, pb.line);
	const kindOf = new Map(entries.map((e) => [e.id, e.kind]));

	const blockEnd = (id: string): number => {
		const line = lineOf.get(id) as number;
		return kindOf.get(id) === 'chapter' ? (nextTopSectionLine(parsed, line) ?? lines.length) : line + 1;
	};

	const sorted = entries.slice().sort((a, b) => (lineOf.get(a.id) as number) - (lineOf.get(b.id) as number));
	const insertAt = lineOf.get(sorted[0].id) as number;
	const removeEnd = blockEnd(sorted[sorted.length - 1].id);
	const blocks = new Map<string, string[]>(
		sorted.map((e) => [e.id, lines.slice(lineOf.get(e.id) as number, blockEnd(e.id))])
	);

	const finalOrder = [
		...order.filter((id) => blocks.has(id)),
		...sorted.map((e) => e.id).filter((id) => !order.includes(id)),
	];
	const rebuilt: string[] = [];
	for (const id of finalOrder) {
		const block = blocks.get(id);
		if (!block) continue;
		const clean = [...block];
		while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
		rebuilt.push(...clean, '');
	}

	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/**
 * Reorders the ENTIRE top-level sequence — chapters (their whole block,
 * scenes included) and the page breaks sitting between them — to `order`
 * exactly, in one pass. The Script view's own Outline uses this: dragging
 * there always works over the FULL mixed list, so `order` already says
 * exactly where every entry, chapter or page break, lands.
 */
export function reorderTopLevelEntries(text: string, order: string[]): string | null {
	return rebuildTopLevel(text, parseFountain(text), order);
}

/**
 * Reorders every top-level section (chapter) in the whole script to match
 * `orderedSectionIds` exactly, in one pass — the Chapter creation modal's own
 * position picker uses this, mirroring `reorderScenesInSection` one level up:
 * a chapter's ENTIRE block (its `#` line through everything up to the next
 * top-level entry, scenes and nested structure included) travels as one unit
 * rather than being reasoned about scene by scene.
 *
 * Unlike `reorderTopLevelEntries`, this NEVER drops or strands an existing
 * page break, which is what makes it safe for a caller that only has an
 * opinion about chapters: every page break stays attached to whichever
 * chapter immediately follows it in the CURRENT document (a page break's
 * whole point is "start the NEXT chapter on a fresh page", so that's what it
 * keeps doing as chapters move around it); one with nothing after it
 * (trailing) stays at the very end.
 *
 * Only sections already carrying a loom id are touched — `ensureSceneIds`
 * guarantees every level-1 section has one before this can run. Anything
 * before the first top-level entry (a stray scene with no `#`/`===` above
 * it) is left exactly where it is.
 */
export function reorderTopSections(text: string, orderedSectionIds: string[]): string | null {
	const parsed = parseFountain(text);
	const entries = topLevelEntries(parsed);
	const chapterIds = entries.filter((e) => e.kind === 'chapter').map((e) => e.id);
	if (chapterIds.length === 0) return null;

	// Which page breaks immediately precede which chapter, in the CURRENT
	// (pre-reorder) document — one with nothing after it attaches to `null`,
	// the very end.
	const attachedBefore = new Map<string, string[]>();
	let pending: string[] = [];
	for (const e of entries) {
		if (e.kind === 'page-break') {
			pending.push(e.id);
			continue;
		}
		if (pending.length > 0) {
			attachedBefore.set(e.id, [...(attachedBefore.get(e.id) ?? []), ...pending]);
			pending = [];
		}
	}
	const trailing = pending;

	const chapterOrder = [
		...orderedSectionIds.filter((id) => chapterIds.includes(id)),
		...chapterIds.filter((id) => !orderedSectionIds.includes(id)),
	];
	const fullOrder = [...chapterOrder.flatMap((id) => [...(attachedBefore.get(id) ?? []), id]), ...trailing];

	return rebuildTopLevel(text, parsed, fullOrder);
}

/**
 * Renumbers scenes to keep an existing production-numbering scheme (`#N#`)
 * sequential and gapless.
 *
 * Production numbers are traditionally LOCKED in screenwriting (hence 12A,
 * 12B on a real set) precisely so they don't move — but this app's reorder
 * actions (chapter drag reorder, move to another chapter, or simply typing a
 * new scene above an already-numbered one) physically relocate a scene's
 * whole block, number included, which would otherwise leave a stale number
 * sitting on the wrong scene. If NO scene is numbered at all, this is a
 * no-op — it never starts a numbering scheme from nothing. But once at least
 * one scene carries a number, every scene from the very start of the script
 * through the last currently-numbered scene is treated as part of that
 * scheme (including scenes that had no number yet, e.g. one just inserted
 * before today's `#1#`) and renumbered 1..N in document order. A scene AFTER
 * the last numbered one is left alone — the numbered zone never grows past
 * where the writer has actually placed a number.
 */
export function renumberScenes(text: string): string {
	const parsed = parseFountain(text);
	const lastNumberedIdx = parsed.scenes.reduce((last, sc, i) => (sc.sceneNumber !== '' ? i : last), -1);
	if (lastNumberedIdx === -1) return text;
	const inScheme = parsed.scenes.slice(0, lastNumberedIdx + 1);
	const lines = text.split(/\r?\n/);
	inScheme.forEach((sc, i) => {
		const parts = parseSceneHeading(lines[sc.line]);
		const wanted = String(i + 1);
		if (parts.sceneNumber === wanted) return;
		lines[sc.line] = renderSceneHeading({ ...parts, sceneNumber: wanted });
	});
	return lines.join('\n');
}

/**
 * Renames a top-level section's (chapter's) title — the text of its `#` line
 * — leaving its level, nesting and hidden loom id untouched.
 *
 * The Chapter page's Title field writes through this: chapters are otherwise
 * "named by the script" (the note reads the section, never the other way),
 * but that direction of truth is about not authoring a RIVAL copy of the
 * text, not about the field being read-only — same relationship the Scene
 * page's modular heading fields have with the scene heading.
 */
export function renameSectionTitle(text: string, sectionId: string, newTitle: string): string | null {
	const parsed = parseFountain(text);
	const section = parsed.sections.find((sec) => sec.loomId === sectionId);
	if (!section) return null;
	const lines = text.split(/\r?\n/);
	const level = /^#+/.exec(lines[section.line].trim())?.[0].length ?? section.level;
	lines[section.line] = `${'#'.repeat(level)} ${newTitle.trim()} [[loom:${sectionId}]]`;
	return lines.join('\n');
}

/**
 * Appends a new, empty top-level chapter to the end of the script, with its
 * `[[loom:…]]` id already attached.
 *
 * The Script view's Chapters panel "+ New chapter" button uses this rather
 * than creating a bare Chapter note the way the generic entity-creation
 * modal would — a Chapter note with nothing backing it in the script is an
 * orphan the moment it's made (see `liveChapterIds`), so this gives the
 * script itself the new section first; `syncScenes` then creates the note
 * FROM that section on the next commit, the same path a `# Chapter` line
 * typed by hand takes.
 */
export function appendChapter(text: string, title: string): string {
	const parsed = parseFountain(text);
	const seen = new Set(
		[...parsed.scenes, ...parsed.sections].map((s) => s.loomId).filter((id): id is string => id !== null)
	);
	let id = newSceneId();
	while (seen.has(id)) id = newSceneId();
	const trimmed = text.replace(/\s+$/, '');
	return `${trimmed}\n\n# ${title.trim()} [[loom:${id}]]\n`;
}

/**
 * Appends a new, empty chapter-boundary page break to the very end of the
 * script, with its `[[loom:…]]` id already attached — the Outline panel's
 * "+ New page breaker" button uses this (mirrors `appendChapter`). Landing
 * after the last chapter means nothing follows it yet, which is exactly what
 * makes it immediately qualify as a chapter-boundary break (see the
 * `pageBreaks` derivation in `parseFountain`) and show up in the Outline
 * right away, draggable to wherever it's actually meant to sit.
 */
export function appendPageBreak(text: string): string {
	const parsed = parseFountain(text);
	const seen = new Set(
		[...parsed.scenes, ...parsed.sections, ...parsed.pageBreaks]
			.map((s) => s.loomId)
			.filter((id): id is string => id !== null)
	);
	let id = newSceneId();
	while (seen.has(id)) id = newSceneId();
	const trimmed = text.replace(/\s+$/, '');
	return `${trimmed}\n\n=== [[loom:${id}]]\n`;
}

/**
 * Appends a new, empty scene to the very end of the script, with its
 * `[[loom:…]]` id already attached — the Outline panel's "+ New scene"
 * button uses this. Appending at the true end (rather than needing a target
 * chapter) lands it in whichever chapter is LAST, the same way typing a new
 * heading at the bottom of the file would — a chapter's own content is
 * simply "everything up to the next `#` line or EOF" (see
 * `nextTopSectionLine`), so there's nothing extra to wire up. With no
 * chapter at all yet, it lands as a chapterless scene, same as typing one in
 * by hand.
 */
export function appendScene(text: string, location: string): string {
	const parsed = parseFountain(text);
	const seen = new Set(
		[...parsed.scenes, ...parsed.sections].map((s) => s.loomId).filter((id): id is string => id !== null)
	);
	let id = newSceneId();
	while (seen.has(id)) id = newSceneId();
	const trimmed = text.replace(/\s+$/, '');
	const heading = location.trim() === '' ? 'NEW LOCATION' : location.trim().toUpperCase();
	return `${trimmed}\n\nINT. ${heading} - DAY [[loom:${id}]]\n`;
}
