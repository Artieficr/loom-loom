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
 * underline/strikethrough/alignment/page-break/wikilink markup stays literal
 * here and is only decorated (never tokenized) by `prose-field.tsx`.
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

export interface ParsedBook {
	acts: ParsedAct[];
	chapters: ParsedChapter[];
}

/** Parses a whole `.loomprose` file. A `##` line is checked before a bare
 *  `#` one, since it also matches `startsWith('#')`. */
export function parseBook(text: string): ParsedBook {
	const lines = text.split(/\r?\n/);
	const acts: ParsedAct[] = [];
	const chapters: ParsedChapter[] = [];
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
		}
	}
	return { acts, chapters };
}

/** Every loom id currently in use anywhere in the book — acts and chapters
 *  share one `[[loom:…]]` namespace, so a fresh id has to check against
 *  both before it's handed out. */
function allBookLoomIds(parsed: ParsedBook): Set<string> {
	return new Set(
		[...parsed.acts, ...parsed.chapters].map((s) => s.loomId).filter((id): id is string => id !== null)
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

/** Additively assigns a `[[loom:<id>]]` marker to every Act/Chapter heading
 *  missing one — idempotent, safe to run on every load, mirrors
 *  `ensureSceneIds`. */
export function ensureBookIds(text: string): { text: string; changed: boolean } {
	const parsed = parseBook(text);
	const missing = [
		...parsed.acts.filter((a) => a.loomId === null).map((a) => a.line),
		...parsed.chapters.filter((c) => c.loomId === null).map((c) => c.line),
	];
	if (missing.length === 0) return { text, changed: false };
	const lines = text.split(/\r?\n/);
	const seen = allBookLoomIds(parsed);
	for (const line of missing) {
		const id = freshBookId(seen);
		seen.add(id);
		lines[line] = `${lines[line].trimEnd()} [[loom:${id}]]`;
	}
	return { text: lines.join('\n'), changed: true };
}

/** The next `#` (Act) line after `afterLine`, or null at EOF — bounds an
 *  act's own span. Mirrors `nextTopSectionLine`, minus the page-break case
 *  (prose has no page-break-as-structural-unit concept). */
function nextActLine(parsed: ParsedBook, afterLine: number): number | null {
	const next = parsed.acts.filter((a) => a.line > afterLine).sort((a, b) => a.line - b.line)[0];
	return next ? next.line : null;
}

/** The next `#` or `##` line after `afterLine`, or null at EOF — bounds a
 *  chapter's own span (a chapter ends at the next chapter OR the next act,
 *  whichever comes first). */
function nextChapterOrActLine(parsed: ParsedBook, afterLine: number): number | null {
	const candidates = [
		...parsed.acts.filter((a) => a.line > afterLine).map((a) => a.line),
		...parsed.chapters.filter((c) => c.line > afterLine).map((c) => c.line),
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

/** Reorders every top-level Act in the book to match `orderedActIds`
 *  exactly, in one pass — each act's ENTIRE block (its `#` line through
 *  every chapter it holds) travels as one unit. Mirrors `reorderTopSections`
 *  minus the page-break attachment logic (prose has no page-break concept).
 *  Only acts already carrying a loom id are touched. */
export function reorderBookActs(text: string, orderedActIds: string[]): string | null {
	const parsed = parseBook(text);
	const withIds = parsed.acts.filter((a): a is ParsedAct & { loomId: string } => a.loomId !== null);
	if (withIds.length === 0) return null;
	const lines = text.split(/\r?\n/);

	const sorted = [...withIds].sort((a, b) => a.line - b.line);
	const insertAt = sorted[0].line;
	const removeEnd = actEndLine(parsed, sorted[sorted.length - 1], lines.length);
	const blocks = new Map<string, string[]>(
		sorted.map((a) => [a.loomId, lines.slice(a.line, actEndLine(parsed, a, lines.length))])
	);

	const actIds = sorted.map((a) => a.loomId);
	const order = [
		...orderedActIds.filter((id) => actIds.includes(id)),
		...actIds.filter((id) => !orderedActIds.includes(id)),
	];
	const rebuilt: string[] = [];
	for (const id of order) {
		const block = blocks.get(id);
		if (!block) continue;
		rebuilt.push(...trimTrailingBlankLines(block), '');
	}
	lines.splice(insertAt, removeEnd - insertAt, ...rebuilt);
	return lines.join('\n');
}

/** Act loom ids currently backed by a `#` line — mirrors `liveActIds`. */
export function liveBookActIds(parsed: ParsedBook): Set<string> {
	return new Set(parsed.acts.map((a) => a.loomId).filter((id): id is string => id !== null));
}

/** Chapter loom ids currently backed by a `##` line — mirrors `liveSceneIds`. */
export function liveBookChapterIds(parsed: ParsedBook): Set<string> {
	return new Set(parsed.chapters.map((c) => c.loomId).filter((id): id is string => id !== null));
}
