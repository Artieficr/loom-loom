/**
 * Prose (Book) parsing — Writer/Prose's grammar for a project's single
 * `.loomprose` file.
 *
 * Dependency-free and side-effect-free, mirroring `fountain.ts`'s own
 * separation between grammar and vault-touching code. Deliberately much
 * simpler than Fountain: there is no element-by-element tokenization (no
 * scene headings, character cues, dialogue blocks, transitions) — the whole
 * grammar is two heading levels, `#` for an Act and `##` for a Chapter, each
 * carrying a hidden `[[loom:<id>]]` marker, the exact same non-exporting-note
 * convention Fountain's own `#` sections use (reusing `newSceneId`/
 * `readLoomId`/`stripLoomIds` from fountain.ts directly rather than
 * duplicating them — they're already format-agnostic string utilities).
 * Everything between headings is opaque prose body text: bold/italic/
 * underline/strikethrough/wikilink markup stays literal here and is only
 * decorated (never tokenized) by `markdown-field.tsx` — no dedicated CM6
 * field was ever built for Prose (see `src/views/CLAUDE.md`'s `book-view.tsx`
 * entry). **Page breaks** (`ParsedPageBreak`/`ParsedBook.pageBreaks`) are the
 * one exception recognized structurally, mirroring `fountain.ts`'s own
 * act-boundary-only rule exactly: a `===` line only becomes a page break when
 * the next non-blank line is an Act heading or EOF — anywhere else (mid-
 * chapter, right after an Act heading before its first Chapter) it stays
 * plain, undecorated body text.
 */

import { newSceneId, readLoomId } from './fountain';

const LOOM_ID_RE_G = /\s*\[\[loom:[A-Za-z0-9]+\]\]/g;

export interface ParsedAct {
	title: string;
	loomId: string | null;
	line: number;
}

export interface ParsedChapter {
	title: string;
	loomId: string | null;
	line: number;
	/** The nearest enclosing Act's loom id, or null when this chapter sits
	 *  before any `#` heading in the file. */
	actId: string | null;
}

/** An act-boundary page break — a `===` line, but only when it sits
 *  immediately before the NEXT Act heading (or EOF). Mirrors
 *  `ParsedPageBreak`/`ParsedScript.pageBreaks` (fountain.ts): a `===`
 *  anywhere else (mid-chapter, right after an Act heading before its first
 *  Chapter) is left alone as plain body text, never recognized here. */
export interface ParsedPageBreak {
	line: number;
	loomId: string | null;
}

export interface ParsedBook {
	acts: ParsedAct[];
	chapters: ParsedChapter[];
	/** Act-boundary page breaks — see `ParsedPageBreak`. */
	pageBreaks: ParsedPageBreak[];
}

/** Parses a whole `.loomprose` file. A `##` line is checked before a bare
 *  `#` one, since it also matches `startsWith('#')`. */
export function parseBook(text: string): ParsedBook {
	const lines = text.split(/\r?\n/);
	const acts: ParsedAct[] = [];
	const chapters: ParsedChapter[] = [];
	const pageBreaks: ParsedPageBreak[] = [];
	let currentActId: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('##')) {
			chapters.push({
				title: line.slice(2).replace(LOOM_ID_RE_G, '').trim(),
				loomId: readLoomId(line),
				line: i,
				actId: currentActId,
			});
		} else if (line.startsWith('#')) {
			const id = readLoomId(line);
			acts.push({ title: line.slice(1).replace(LOOM_ID_RE_G, '').trim(), loomId: id, line: i });
			currentActId = id;
		} else if (/^={3,}$/.test(line.replace(LOOM_ID_RE_G, '').trim())) {
			let j = i + 1;
			while (j < lines.length && lines[j].trim() === '') j++;
			const next = j < lines.length ? lines[j].trim() : '';
			const isBoundary = j >= lines.length || (next.startsWith('#') && !next.startsWith('##'));
			if (isBoundary) pageBreaks.push({ line: i, loomId: readLoomId(lines[i]) });
		}
	}
	return { acts, chapters, pageBreaks };
}

/** Every loom id currently in use anywhere in the book — acts, chapters, and
 *  page breaks all share one `[[loom:…]]` namespace, so a fresh id has to
 *  check against all three before it's handed out. */
function allBookLoomIds(parsed: ParsedBook): Set<string> {
	return new Set(
		[...parsed.acts, ...parsed.chapters, ...parsed.pageBreaks]
			.map((s) => s.loomId)
			.filter((id): id is string => id !== null)
	);
}

/** A fresh id guaranteed not to collide with anything already in the book —
 *  mirrors `freshSceneId` (fountain.ts), re-rolling `newSceneId()` against
 *  the book's own current ids rather than trusting its collision-resistance
 *  alone. */
function freshBookId(seen: Set<string>): string {
	let id = newSceneId();
	while (seen.has(id)) id = newSceneId();
	return id;
}

/** Normalizes blank lines sitting immediately around an Act/Chapter heading
 *  — the SOURCE of two related, separately reported gaps: a brand-new
 *  chapter/act, or one just moved/reordered, kept showing a REAL blank line
 *  between its own title and whatever comes right after (its own first
 *  line of prose, or — for an act with no chapters yet — its first
 *  chapter's own heading), never just none at all. Several structural ops
 *  (`replaceBookChapterBody`/`replaceBookActBody`'s own leading `''` before
 *  the body; `moveBookChapterToAct`/`reorderBookChaptersInAct`/
 *  `reorderBookActs`/`reorderBookTopLevelEntries`, all via
 *  `trimTrailingBlankLines` + their own leading/trailing `''` splice) each
 *  wrap the block they're placing in a blank line independently, and doing
 *  that consistently right in each one of those (some conditionally, since a
 *  gap BETWEEN two distinct chapters is still wanted) turned out to be far
 *  more failure-prone than fixing it in exactly one place, after the fact:
 *
 * - Directly AFTER a heading: the blank run collapses to NOTHING, not just
 *   down to one — a heading's own CSS `padding-bottom` (styles.css) already
 *   supplies the visual gap, so an actual blank LINE there is never wanted,
 *   whether it's one or several.
 * - Directly BEFORE a heading: a run of 2+ collapses to exactly one — a
 *   SINGLE blank line here is the normal, still-wanted separator between
 *   two distinct sections (the end of one chapter's prose and the start of
 *   the next); only the STACKED case (two independent ops' own padding
 *   landing back to back — e.g. a chapter freshly appended then immediately
 *   moved under its act at creation time) needs correcting.
 *
 * Regex-based specifically so it never has to reason about a mutating
 * `lines` array's shifting indices while it edits — a heading boundary is
 * unambiguous (`^#{1,2} `) and N raw newlines in a row IS N-1 blank lines by
 * construction (each blank line contributes exactly one extra `\n`).
 * Deliberately scoped to heading-ADJACENT runs only — a deliberate multi-
 * blank-line break the user typed in the middle of their own prose is left
 * completely alone. Run from BOTH of Prose's write paths — `ensureBookIds`
 * below (covers `editBookAndSync`, book-view.tsx) and `editBookFile`
 * (project.ts's own private duplicate, used by the Chapter/Act creation
 * modals) — since a chapter/act can pick up this exact blank-line padding
 * at CREATION time, before any `editBookAndSync` commit ever runs. */
function collapseHeadingBlankRuns(text: string): { text: string; changed: boolean } {
	const next = text.replace(/^(#{1,2} .*)\n+/gm, '$1\n').replace(/\n{3,}(#{1,2} .*)/gm, '\n\n$1');
	return { text: next, changed: next !== text };
}

/** Additively assigns a `[[loom:<id>]]` marker to every Act/Chapter heading
 *  missing one — idempotent, safe to run on every load, mirrors
 *  `ensureSceneIds`. Also runs `collapseHeadingBlankRuns` on every call (see
 *  that function's own doc comment) — same "cleanup that rides along on
 *  every commit" spot `ensureSceneIds` itself is for Fountain, just two
 *  unrelated cleanups sharing the one pass instead of one. */
export function ensureBookIds(text: string): { text: string; changed: boolean } {
	const collapsed = collapseHeadingBlankRuns(text);
	const parsed = parseBook(collapsed.text);
	const missing = [
		...parsed.acts.filter((a) => a.loomId === null).map((a) => a.line),
		...parsed.chapters.filter((c) => c.loomId === null).map((c) => c.line),
		...parsed.pageBreaks.filter((pb) => pb.loomId === null).map((pb) => pb.line),
	];
	if (missing.length === 0) return collapsed;
	const lines = collapsed.text.split(/\r?\n/);
	const seen = allBookLoomIds(parsed);
	for (const line of missing) {
		const id = freshBookId(seen);
		seen.add(id);
		lines[line] = `${lines[line].trimEnd()} [[loom:${id}]]`;
	}
	return { text: lines.join('\n'), changed: true };
}

/** The next Act heading OR a qualifying page break after `afterLine`,
 *  whichever comes first, or null at EOF — bounds an act's own span so a
 *  TRAILING page break (meant to start the NEXT act on a fresh page) isn't
 *  swept into the act BEFORE it. Mirrors `nextTopSectionLine`. */
function nextActLine(parsed: ParsedBook, afterLine: number): number | null {
	const candidates = [
		...parsed.acts.filter((a) => a.line > afterLine).map((a) => a.line),
		...parsed.pageBreaks.filter((pb) => pb.line > afterLine).map((pb) => pb.line),
	];
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** The next `#`/`##`/page-break line after `afterLine`, or null at EOF —
 *  bounds a chapter's own span (a chapter ends at the next chapter, the next
 *  act, or a trailing page break before either, whichever comes first). */
function nextChapterOrActLine(parsed: ParsedBook, afterLine: number): number | null {
	const candidates = [
		...parsed.acts.filter((a) => a.line > afterLine).map((a) => a.line),
		...parsed.chapters.filter((c) => c.line > afterLine).map((c) => c.line),
		...parsed.pageBreaks.filter((pb) => pb.line > afterLine).map((pb) => pb.line),
	];
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

function actEndLine(parsed: ParsedBook, act: ParsedAct, totalLines: number): number {
	return nextActLine(parsed, act.line) ?? totalLines;
}

function chapterEndLine(parsed: ParsedBook, chapter: ParsedChapter, totalLines: number): number {
	return nextChapterOrActLine(parsed, chapter.line) ?? totalLines;
}

/** Drops trailing blank lines off a captured block — shared by every op
 *  below that lifts a chunk of the book out and re-splices it elsewhere,
 *  mirrors fountain.ts's own helper of the same name/purpose. */
function trimTrailingBlankLines(block: string[]): string[] {
	const clean = [...block];
	while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
	return clean;
}

/** A chapter's own body text — everything after its `##` heading up to the
 *  next chapter/act heading (or EOF), heading-stripped. Mirrors
 *  `sceneScriptText`. */
export function chapterBookText(text: string, chapterId: string): string | null {
	const parsed = parseBook(text);
	const chapter = parsed.chapters.find((c) => c.loomId === chapterId);
	if (!chapter) return null;
	const lines = text.split(/\r?\n/);
	const end = chapterEndLine(parsed, chapter, lines.length);
	return lines
		.slice(chapter.line + 1, end)
		.join('\n')
		.trim();
}

/** An act's own body text — every chapter beneath it, `##` headings
 *  included so the editor still shows chapter breaks, up to the next act
 *  heading (or EOF). Mirrors `actScriptText`. */
export function actBookText(text: string, actId: string): string | null {
	const parsed = parseBook(text);
	const act = parsed.acts.find((a) => a.loomId === actId);
	if (!act) return null;
	const lines = text.split(/\r?\n/);
	const end = actEndLine(parsed, act, lines.length);
	return lines
		.slice(act.line + 1, end)
		.join('\n')
		.trim();
}

/** Replaces a chapter's own body, leaving its `##` heading (and hidden id)
 *  untouched. Mirrors `replaceSceneBody`. */
export function replaceBookChapterBody(text: string, chapterId: string, body: string): string | null {
	const parsed = parseBook(text);
	const chapter = parsed.chapters.find((c) => c.loomId === chapterId);
	if (!chapter) return null;
	const lines = text.split(/\r?\n/);
	const end = chapterEndLine(parsed, chapter, lines.length);
	const next = body.replace(/\s+$/, '').split('\n');
	lines.splice(chapter.line + 1, end - chapter.line - 1, '', ...next, '');
	return lines.join('\n');
}

/** Replaces an act's own body — every chapter it holds, headings included —
 *  leaving the act's own `#` heading (and hidden id) untouched. What the
 *  Act page's concatenated Editor section writes through: an edit there can
 *  retitle/add/remove/reorder chapters as an ordinary consequence of
 *  rewriting the text, same as Fountain's own `replaceActBody` lets an
 *  Act-page edit move scenes — `syncActsChapters` reconciles chapter notes
 *  from whatever heading structure results on the next commit. */
export function replaceBookActBody(text: string, actId: string, body: string): string | null {
	const parsed = parseBook(text);
	const act = parsed.acts.find((a) => a.loomId === actId);
	if (!act) return null;
	const lines = text.split(/\r?\n/);
	const end = actEndLine(parsed, act, lines.length);
	const next = body.replace(/\s+$/, '').split('\n');
	lines.splice(act.line + 1, end - act.line - 1, '', ...next, '');
	return lines.join('\n');
}

/** Removes a chapter — heading and body — from the book entirely. Mirrors
 *  `removeScene`. */
export function removeBookChapter(text: string, chapterId: string): string | null {
	const parsed = parseBook(text);
	const chapter = parsed.chapters.find((c) => c.loomId === chapterId);
	if (!chapter) return null;
	const lines = text.split(/\r?\n/);
	const end = chapterEndLine(parsed, chapter, lines.length);
	lines.splice(chapter.line, end - chapter.line);
	return lines.join('\n');
}

/** Removes an act — its `#` heading and everything beneath it, every
 *  chapter it holds included — from the book entirely. Mirrors `removeAct`. */
export function removeBookAct(text: string, actId: string): string | null {
	const parsed = parseBook(text);
	const act = parsed.acts.find((a) => a.loomId === actId);
	if (!act) return null;
	const lines = text.split(/\r?\n/);
	const end = actEndLine(parsed, act, lines.length);
	lines.splice(act.line, end - act.line);
	return lines.join('\n');
}

export function renameBookActTitle(text: string, actId: string, newTitle: string): string | null {
	const parsed = parseBook(text);
	const act = parsed.acts.find((a) => a.loomId === actId);
	if (!act) return null;
	const lines = text.split(/\r?\n/);
	lines[act.line] = `# ${newTitle.trim()} [[loom:${actId}]]`;
	return lines.join('\n');
}

export function renameBookChapterTitle(text: string, chapterId: string, newTitle: string): string | null {
	const parsed = parseBook(text);
	const chapter = parsed.chapters.find((c) => c.loomId === chapterId);
	if (!chapter) return null;
	const lines = text.split(/\r?\n/);
	lines[chapter.line] = `## ${newTitle.trim()} [[loom:${chapterId}]]`;
	return lines.join('\n');
}

/** Appends a new, empty Act to the very end of the book, id already
 *  attached — mirrors `appendAct`. What the Chapter/Act creation modals'
 *  "+ New act" affordance writes through, giving the book the section first
 *  so `syncActsChapters` creates the note FROM it on the next commit rather
 *  than the note starting orphaned. */
export function appendBookAct(text: string, title: string): string {
	const parsed = parseBook(text);
	const id = freshBookId(allBookLoomIds(parsed));
	const trimmed = text.replace(/\s+$/, '');
	return `${trimmed}\n\n# ${title.trim()} [[loom:${id}]]\n`;
}

/** Appends a new, empty Chapter to the very end of the book, id already
 *  attached — mirrors `appendScene`. Lands inside whichever act is LAST (an
 *  act's content is simply "everything up to the next `#` line or EOF"),
 *  actless if there's no act yet, same as typing one in by hand. */
export function appendBookChapter(text: string, title: string): string {
	const parsed = parseBook(text);
	const id = freshBookId(allBookLoomIds(parsed));
	const trimmed = text.replace(/\s+$/, '');
	const heading = title.trim() === '' ? 'Untitled chapter' : title.trim();
	return `${trimmed}\n\n## ${heading} [[loom:${id}]]\n`;
}

/** Appends a new act-boundary page break to the very end of the book, id
 *  already attached — mirrors `appendPageBreak`. Lands after the last act
 *  where it's immediately recognized as a boundary break (nothing follows
 *  it, so the "next non-blank line is an Act heading or EOF" rule is
 *  satisfied by EOF); a page break typed by hand elsewhere already works the
 *  same way once the next commit re-parses. */
export function appendBookPageBreak(text: string): string {
	const parsed = parseBook(text);
	const id = freshBookId(allBookLoomIds(parsed));
	const trimmed = text.replace(/\s+$/, '');
	return `${trimmed}\n\n=== [[loom:${id}]]\n`;
}

/** Removes an act-boundary page break — its one line, plus a following
 *  blank line if there is one. Mirrors `removePageBreak`. */
export function removeBookPageBreak(text: string, id: string): string | null {
	const parsed = parseBook(text);
	const pb = parsed.pageBreaks.find((p) => p.loomId === id);
	if (!pb) return null;
	const lines = text.split(/\r?\n/);
	lines.splice(pb.line, lines[pb.line + 1]?.trim() === '' ? 2 : 1);
	return lines.join('\n');
}

/** Moves a chapter under a different act: its whole block lifts out and
 *  re-inserts at the end of the target act's own span. Mirrors
 *  `moveSceneToSection`. */
export function moveBookChapterToAct(text: string, chapterId: string, actId: string): string | null {
	const parsed = parseBook(text);
	const chapter = parsed.chapters.find((c) => c.loomId === chapterId);
	const target = parsed.acts.find((a) => a.loomId === actId);
	if (!chapter || !target) return null;
	const lines = text.split(/\r?\n/);
	const end = chapterEndLine(parsed, chapter, lines.length);
	const block = lines.slice(chapter.line, end);
	let insertAt = actEndLine(parsed, target, lines.length);
	lines.splice(chapter.line, end - chapter.line);
	// Removing the block shifts everything after it up.
	if (insertAt > chapter.line) insertAt -= end - chapter.line;
	while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt--;
	const clean = trimTrailingBlankLines(block);
	lines.splice(insertAt, 0, '', ...clean, '');
	return lines.join('\n');
}

/** Reorders every chapter within ONE act to match `orderedChapterIds`
 *  exactly, in one bounded splice — the Act page's own Outline uses this.
 *  Mirrors `reorderScenesInSection`. Entries this parse found but the order
 *  omits keep their original relative position, appended after the ones
 *  that were placed. */
export function reorderBookChaptersInAct(
	text: string,
	actId: string,
	orderedChapterIds: string[]
): string | null {
	const parsed = parseBook(text);
	const act = parsed.acts.find((a) => a.loomId === actId);
	if (!act) return null;
	const lines = text.split(/\r?\n/);
	const actEnd = actEndLine(parsed, act, lines.length);

	const inAct = parsed.chapters
		.filter((c) => c.line > act.line && c.line < actEnd)
		.sort((a, b) => a.line - b.line);
	if (inAct.length === 0) return null;
	const trueEnd = (c: ParsedChapter) => Math.min(chapterEndLine(parsed, c, lines.length), actEnd);

	const insertAt = inAct[0].line;
	const removeEnd = trueEnd(inAct[inAct.length - 1]);
	const blocks = new Map<string, string[]>(
		inAct.map((c) => [c.loomId as string, lines.slice(c.line, trueEnd(c))])
	);

	const order = [
		...orderedChapterIds.filter((id) => blocks.has(id)),
		...inAct.map((c) => c.loomId as string).filter((id) => !orderedChapterIds.includes(id)),
	];
	const rebuilt: string[] = [];
	for (const id of order) {
		const block = blocks.get(id);
		if (!block) continue;
		rebuilt.push('', ...trimTrailingBlankLines(block), '');
	}
	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/** One entry in the book's top-level sequence — an Act (its whole block,
 *  chapters included) or a page break sitting between them, in document
 *  order. What `reorderBookTopLevelEntries`/`reorderBookActs` reorder.
 *  Mirrors `TopLevelEntry` (fountain.ts). */
export interface BookTopLevelEntry {
	kind: 'act' | 'page-break';
	id: string;
}

/** The current top-level sequence — acts and act-boundary page breaks — in
 *  document order. Mirrors `topLevelEntries` (fountain.ts). */
export function bookTopLevelEntries(parsed: ParsedBook): BookTopLevelEntry[] {
	const acts = parsed.acts
		.filter((a): a is ParsedAct & { loomId: string } => a.loomId !== null)
		.map((a) => ({ kind: 'act' as const, id: a.loomId, line: a.line }));
	const breaks = parsed.pageBreaks
		.filter((pb): pb is ParsedPageBreak & { loomId: string } => pb.loomId !== null)
		.map((pb) => ({ kind: 'page-break' as const, id: pb.loomId, line: pb.line }));
	return [...acts, ...breaks].sort((a, b) => a.line - b.line).map(({ kind, id }) => ({ kind, id }));
}

/** Shared splice-rebuild behind `reorderBookActs`/`reorderBookTopLevelEntries`
 *  — captures every top-level entry's block up front (an act through
 *  `actEndLine` — chapters included — a page break just its own single
 *  line), removes the WHOLE span from the first entry through the last in
 *  ONE bounded splice, then reinserts every block in `order`. Entries this
 *  parse found but `order` omits keep their original relative position,
 *  appended after the ones that were placed. Mirrors `rebuildTopLevel`
 *  (fountain.ts). */
function rebuildBookTopLevel(text: string, parsed: ParsedBook, order: string[]): string | null {
	const entries = bookTopLevelEntries(parsed);
	if (entries.length === 0) return null;
	const lines = text.split(/\r?\n/);
	const lineOf = new Map<string, number>();
	for (const a of parsed.acts) if (a.loomId) lineOf.set(a.loomId, a.line);
	for (const pb of parsed.pageBreaks) if (pb.loomId) lineOf.set(pb.loomId, pb.line);
	const kindOf = new Map(entries.map((e) => [e.id, e.kind]));

	const blockEnd = (id: string): number => {
		const line = lineOf.get(id) as number;
		if (kindOf.get(id) !== 'act') return line + 1;
		const act = parsed.acts.find((a) => a.loomId === id) as ParsedAct;
		return actEndLine(parsed, act, lines.length);
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
		rebuilt.push(...trimTrailingBlankLines(block), '');
	}
	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/**
 * Reorders the ENTIRE top-level sequence — acts (their whole block, chapters
 * included) and the page breaks sitting between them — to `order` exactly,
 * in one pass. The Book Outline's own drag uses this: dragging there always
 * works over the FULL mixed list, so `order` already says exactly where
 * every entry, act or page break, lands. Mirrors `reorderTopLevelEntries`.
 */
export function reorderBookTopLevelEntries(text: string, order: string[]): string | null {
	return rebuildBookTopLevel(text, parseBook(text), order);
}

/**
 * Reorders every top-level Act in the book to match `orderedActIds` exactly,
 * in one pass — each act's ENTIRE block (its `#` line through every chapter
 * it holds) travels as one unit. What the Act creation modal's own acts-only
 * position picker uses (project.ts), mirroring `reorderScenesInSection` one
 * level up.
 *
 * Unlike `reorderBookTopLevelEntries`, this NEVER drops or strands an
 * existing page break, which is what makes it safe for a caller that only
 * has an opinion about acts: every page break stays attached to whichever
 * act immediately follows it in the CURRENT document (a page break's whole
 * point is "start the NEXT act on a fresh page", so that's what it keeps
 * doing as acts move around it); one with nothing after it (trailing) stays
 * at the very end. Mirrors `reorderTopSections`.
 *
 * Only acts already carrying a loom id are touched.
 */
export function reorderBookActs(text: string, orderedActIds: string[]): string | null {
	const parsed = parseBook(text);
	const entries = bookTopLevelEntries(parsed);
	const actIds = entries.filter((e) => e.kind === 'act').map((e) => e.id);
	if (actIds.length === 0) return null;

	// Which page breaks immediately precede which act, in the CURRENT
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

	const actOrder = [
		...orderedActIds.filter((id) => actIds.includes(id)),
		...actIds.filter((id) => !orderedActIds.includes(id)),
	];
	const fullOrder = [...actOrder.flatMap((id) => [...(attachedBefore.get(id) ?? []), id]), ...trailing];

	return rebuildBookTopLevel(text, parsed, fullOrder);
}

/** Act loom ids currently backed by a `#` line — mirrors `liveActIds`. */
export function liveBookActIds(parsed: ParsedBook): Set<string> {
	return new Set(parsed.acts.map((a) => a.loomId).filter((id): id is string => id !== null));
}

/** Chapter loom ids currently backed by a `##` line — mirrors `liveSceneIds`. */
export function liveBookChapterIds(parsed: ParsedBook): Set<string> {
	return new Set(parsed.chapters.map((c) => c.loomId).filter((id): id is string => id !== null));
}
