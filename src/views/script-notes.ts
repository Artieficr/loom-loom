/**
 * Comment and alternative-text bodies for the script, keyed by the hidden
 * `[[loom-comment:<id>]]`/`[[loom-alt:<id>]]` marker ids embedded directly in
 * the `.fountain` file (see fountain.ts's "Annotation markers" section). The
 * markers themselves carry the POSITION (they live in the document, so they
 * can't drift); this file carries everything else — comment text, resolved
 * state, an alt-text's full option list and which one is currently active.
 *
 * Not on Scene/Act note frontmatter: `syncScenes` fully recomputes and
 * overwrites its own frontmatter fields on every sync (not safe for
 * user-authored data), a marked range can span a scene boundary or exist
 * before any scene note is created, and `processFrontMatter` rewrites the
 * whole note file on every touch. Modeled instead on the Maps precedent
 * (`Entities/Maps/<Project> Maps.json`, map-view.tsx) — a project-level JSON
 * sidecar under `Entities/`, addressed by project name/root, not by note.
 */

import { App, normalizePath, TFile } from 'obsidian';
import { useEffect, useState } from 'react';
import { SCRIPT_NOTES_FOLDER } from '../types';
import { findAnnotationSpans, type AnnotationSpan } from '../fountain';
import type LoomLoomPlugin from '../main';

/** One comment. `comments` below is keyed by marker id -> CommentEntry[] — a
 *  single marked range is a THREAD, not a single note: `handleAddCommentReply`
 *  (script-view.tsx/entity-view.tsx) appends further entries under the same
 *  id, `CommentPopover` (annotation-popover.tsx) renders the whole array. */
export interface CommentEntry {
	id: string;
	text: string;
	resolved: boolean;
	createdAt: number;
	updatedAt: number;
	/** When `resolved` last flipped true — `null` while unresolved, or for an
	 *  entry that predates this field. Shown in the popover's tooltip
	 *  ("Resolved on …"); distinct from `updatedAt` since editing an
	 *  already-resolved comment's text shouldn't change when it was resolved. */
	resolvedAt: number | null;
}

/** `options` holds every alternative wording ever added, in add order;
 *  `activeIndex` is whichever one is CURRENTLY the text sitting between the
 *  `[[loom-alt:<id>]]`…`[[/loom-alt:<id>]]` markers. Cycling/picking an
 *  option is a real document edit (fountain-field.tsx) that keeps this in
 *  sync — this field is never the source of truth for what's displayed, just
 *  a record of which one it currently is. `acceptedIndex` is separate from
 *  `activeIndex`: "active" is just whichever text is CURRENTLY showing (a
 *  draft, freely swappable), "accepted" marks one option as the FINALIZED
 *  choice — `null` while the span is still undecided. Picking "Draft" sets
 *  `activeIndex` and clears `acceptedIndex` (back to "still deciding");
 *  picking "Accept" sets both to the same index. Kept distinct rather than
 *  collapsed into one flag so a span can be queried for "still in doubt"
 *  (`acceptedIndex === null`) regardless of which option happens to be
 *  active at the moment. */
export interface AltTextEntry {
	id: string;
	options: string[];
	activeIndex: number;
	acceptedIndex: number | null;
}

export interface ScriptNotesFile {
	version: number;
	comments: Record<string, CommentEntry[]>;
	altText: Record<string, AltTextEntry>;
}

const EMPTY: ScriptNotesFile = { version: 1, comments: {}, altText: {} };

type ProjectRef = { root: string; name: string };

function projectPath(project: ProjectRef, sub: string): string {
	return normalizePath(project.root === '' ? sub : `${project.root}/${sub}`);
}

/** Path of a project's Script Notes store — `Entities/Script Notes/<Project> Script Notes.json`. */
export function scriptNotesFilePath(project: ProjectRef): string {
	return projectPath(project, `${SCRIPT_NOTES_FOLDER}/${project.name} Script Notes.json`);
}

/** A project's Script Notes store, or null when it has none yet (no comment/
 *  alt-text ever added). */
export function findScriptNotesFile(app: App, project: ProjectRef): TFile | null {
	return app.vault.getFileByPath(scriptNotesFilePath(project));
}

/** Tolerant parse — any malformed/missing field falls back to empty rather
 *  than throwing, same contract as map-view.tsx's `parseMapsFile`. */
function parseScriptNotesFile(text: string): ScriptNotesFile {
	try {
		const raw = JSON.parse(text) as Partial<ScriptNotesFile> | null;
		if (!raw || typeof raw !== 'object') return EMPTY;
		const comments: Record<string, CommentEntry[]> = {};
		if (raw.comments && typeof raw.comments === 'object') {
			for (const [id, entries] of Object.entries(raw.comments)) {
				if (!Array.isArray(entries)) continue;
				const parsed = (entries as Partial<CommentEntry>[])
					.filter((e) => !!e && typeof e === 'object')
					.map((e) => ({
						id: typeof e.id === 'string' ? e.id : id,
						text: typeof e.text === 'string' ? e.text : '',
						resolved: e.resolved === true,
						createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
						updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
						resolvedAt: typeof e.resolvedAt === 'number' ? e.resolvedAt : null,
					}));
				if (parsed.length > 0) comments[id] = parsed;
			}
		}
		const altText: Record<string, AltTextEntry> = {};
		if (raw.altText && typeof raw.altText === 'object') {
			for (const [id, entry] of Object.entries(raw.altText)) {
				if (!entry || typeof entry !== 'object') continue;
				const e = entry as Partial<AltTextEntry>;
				const options = Array.isArray(e.options) ? e.options.filter((o): o is string => typeof o === 'string') : [];
				if (options.length === 0) continue;
				const activeIndex =
					typeof e.activeIndex === 'number' && e.activeIndex >= 0 && e.activeIndex < options.length
						? e.activeIndex
						: 0;
				const acceptedIndex =
					typeof e.acceptedIndex === 'number' && e.acceptedIndex >= 0 && e.acceptedIndex < options.length
						? e.acceptedIndex
						: null;
				altText[id] = { id: typeof e.id === 'string' ? e.id : id, options, activeIndex, acceptedIndex };
			}
		}
		return { version: 1, comments, altText };
	} catch {
		return EMPTY;
	}
}

// --- Safe read-modify-write --------------------------------------------------
//
// Unlike Maps (realistically one open view per project) this file can be
// mutated from three independently-mounted editors at once — the main Script
// view, a Scene page, and an Act page can all be open together. A queue
// keyed by the sidecar's own vault path serializes overlapping calls (so two
// near-simultaneous actions from the SAME view can't interleave their own
// read/write pair), and every call re-reads the file with `vault.read` (never
// `cachedRead`, which can lag behind a sibling view's just-landed write)
// immediately before applying its own change — mirroring the spirit of
// script-view.tsx's own `commitQueue`, one level up, for a file with
// genuinely multiple writers instead of one.
const writeQueues = new Map<string, Promise<unknown>>();

/** Reads the current file (or an empty one), applies `mutate`, writes the
 *  result back. `mutate` should be pure and cheap — it may run against a
 *  freshly re-read copy that's newer than whatever the caller last rendered. */
export async function mutateScriptNotes(
	app: App,
	project: ProjectRef,
	mutate: (file: ScriptNotesFile) => ScriptNotesFile
): Promise<ScriptNotesFile> {
	const path = scriptNotesFilePath(project);
	const run = (writeQueues.get(path) ?? Promise.resolve()).then(async () => {
		const existing = app.vault.getFileByPath(path);
		const current = existing ? parseScriptNotesFile(await app.vault.read(existing)) : EMPTY;
		const next = mutate(current);
		if (next === current) return next; // no-op mutate — skip the write entirely
		const text = JSON.stringify(next, null, '\t');
		if (existing) {
			await app.vault.modify(existing, text);
		} else {
			const folder = path.slice(0, path.lastIndexOf('/'));
			if (folder && !app.vault.getAbstractFileByPath(folder)) {
				try {
					await app.vault.createFolder(folder);
				} catch {
					/* raced/exists */
				}
			}
			await app.vault.create(path, text);
		}
		return next;
	});
	writeQueues.set(
		path,
		run.catch(() => {})
	);
	return run;
}

// --- React read hook ----------------------------------------------------------
//
// Structurally identical to script-buffer.ts's own read hook: re-reads on
// every vault touch to this ONE path. This is also how the three
// simultaneously-mounted views stay in sync with each other's writes — a
// write from any one of them fires `modify`, and every mounted
// `useScriptNotes` re-reads — no cross-component plumbing needed, exactly how
// the `.fountain` file itself already works.

export function useScriptNotes(plugin: LoomLoomPlugin, project: ProjectRef | null): ScriptNotesFile {
	const [notes, setNotes] = useState<ScriptNotesFile>(EMPTY);
	const path = project ? scriptNotesFilePath(project) : null;
	useEffect(() => {
		if (path === null) {
			setNotes(EMPTY);
			return;
		}
		let cancelled = false;
		const read = () => {
			const file = plugin.app.vault.getFileByPath(path);
			if (!file) {
				setNotes(EMPTY);
				return;
			}
			// `vault.read`, never `cachedRead` — same reasoning as
			// `mutateScriptNotes`'s own read: `cachedRead` can lag behind a
			// write this SAME session just made (the 'modify' event that
			// triggers this `read()` can fire before Obsidian's read cache is
			// updated), which made a just-saved comment look empty again the
			// next time its icon was clicked.
			void plugin.app.vault.read(file).then((raw) => {
				if (!cancelled) setNotes(parseScriptNotesFile(raw));
			});
		};
		read();
		const touched = (f: { path: string }) => {
			if (f.path === path) read();
		};
		const refs = [
			plugin.app.vault.on('modify', touched),
			plugin.app.vault.on('create', touched),
			plugin.app.vault.on('delete', touched),
		];
		return () => {
			cancelled = true;
			for (const ref of refs) plugin.app.vault.offref(ref);
		};
	}, [plugin, path]);
	return notes;
}

/** A short single-line preview of a span's CURRENT wrapped text — a browser
 *  panel row only needs enough to recognize the passage, not the whole
 *  thing. Format-agnostic (works over `.fountain` or `.loomprose` text
 *  alike, since `AnnotationSpan` offsets are just character positions). */
function annotationExcerpt(text: string, span: AnnotationSpan): string {
	const raw = text.slice(span.contentFrom, span.contentTo).replace(/\s+/g, ' ').trim();
	return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

export interface UnresolvedCommentRow {
	span: AnnotationSpan;
	excerpt: string;
	unresolvedEntries: CommentEntry[];
}

/** Comment spans with at least one still-unresolved reply — the same "needs
 *  attention" filter driving the persistent span highlight (fountain-field.tsx/
 *  markdown-field.tsx/fountain.ts), surfaced as a browsable list instead of a
 *  passive color. A fully-resolved thread (or an id with no sidecar entry at
 *  all yet) is left out — the whole point of this list is finding what's NOT
 *  done. Shared by the Script view's own Comments browser panel and Book's
 *  (script-view.tsx / book-view.tsx, both via `annotation-popover.tsx`'s
 *  `CommentsBrowserPanel`) — pulled out here once Book needed the identical
 *  logic, rather than a second copy. */
export function unresolvedCommentRows(text: string, comments: Record<string, CommentEntry[]>): UnresolvedCommentRow[] {
	return findAnnotationSpans(text)
		.filter((s) => s.kind === 'comment')
		.map((s) => ({
			span: s,
			excerpt: annotationExcerpt(text, s),
			unresolvedEntries: (comments[s.id] ?? []).filter((e) => !e.resolved),
		}))
		.filter((x) => x.unresolvedEntries.length > 0);
}

export interface UndecidedAltRow {
	span: AnnotationSpan;
	excerpt: string;
}

/** Alt-text spans with no ACCEPTED option yet — "still in doubt," per the
 *  `acceptedIndex`/`activeIndex` split above. A span someone is still
 *  drafting through (or hasn't touched since creation) shows here; one with
 *  a finalized choice drops off the list. Shared the same way as
 *  `unresolvedCommentRows` above. */
export function undecidedAltRows(text: string, altText: Record<string, AltTextEntry>): UndecidedAltRow[] {
	return findAnnotationSpans(text)
		.filter((s) => s.kind === 'alt' && (altText[s.id]?.acceptedIndex ?? null) === null)
		.map((s) => ({ span: s, excerpt: annotationExcerpt(text, s) }));
}
