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

import { App } from 'obsidian';
import { useMemo, useRef, useState } from 'react';
import { useVaultFileText } from './hooks';
import { SCRIPT_NOTES_FOLDER } from '../types';
import { findAnnotationSpans, liveAnnotationIds, type AnnotationSpan } from '../fountain';
import type LoomLoomPlugin from '../main';
import { projectPath } from '../naming';
import { AltTextModal, ensureFolder, TextInputModal } from '../project';
import { t } from '../i18n';
import { queueWrite } from '../write-queue';

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

/** Path of a project's Script Notes store — `Entities/Script Notes/<Project> Script Notes.json`. */
export function scriptNotesFilePath(project: ProjectRef): string {
	return projectPath(project, `${SCRIPT_NOTES_FOLDER}/${project.name} Script Notes.json`);
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
// Three editors can mutate this file at once (Script view, a Scene page, an
// Act page), so writes queue per path and each re-reads with `vault.read`
// right before applying its change.

/** Reads the current file (or an empty one), applies `mutate`, writes the
 *  result back. `mutate` should be pure and cheap — it may run against a
 *  freshly re-read copy that's newer than whatever the caller last rendered. */
export async function mutateScriptNotes(
	app: App,
	project: ProjectRef,
	mutate: (file: ScriptNotesFile) => ScriptNotesFile
): Promise<ScriptNotesFile> {
	const path = scriptNotesFilePath(project);
	return queueWrite(path, async () => {
		const existing = app.vault.getFileByPath(path);
		const current = existing ? parseScriptNotesFile(await app.vault.read(existing)) : EMPTY;
		const next = mutate(current);
		if (next === current) return next; // no-op mutate — skip the write entirely
		const text = JSON.stringify(next, null, '\t');
		if (existing) {
			await app.vault.modify(existing, text);
		} else {
			await ensureFolder(app, path.slice(0, path.lastIndexOf('/')));
			await app.vault.create(path, text);
		}
		return next;
	});
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
	const raw = useVaultFileText(plugin.app, project ? scriptNotesFilePath(project) : null);
	return useMemo(() => (raw === null ? EMPTY : parseScriptNotesFile(raw)), [raw]);
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

/** Drops every comment/alt-text entry whose marker id is no longer live in
 *  `text` — deleting a marked span needs no handling of its own; this clears
 *  the orphaned sidecar data afterwards. */
export function pruneScriptNotes(app: App, project: ProjectRef, text: string): void {
	const liveIds = liveAnnotationIds(text);
	const live = <T>(entries: Record<string, T>): Record<string, T> =>
		Object.fromEntries(Object.entries(entries).filter(([id]) => liveIds.has(id)));
	void mutateScriptNotes(app, project, (notes) => {
		const comments = live(notes.comments);
		const altText = live(notes.altText);
		const touched =
			Object.keys(comments).length !== Object.keys(notes.comments).length ||
			Object.keys(altText).length !== Object.keys(notes.altText).length;
		return touched ? { ...notes, comments, altText } : notes;
	});
}

// --- Pure sidecar edits -------------------------------------------------------
// The `mutate` bodies shared by every comment/alt-text handler (Script view,
// Act/Scene pages, Book). Each returns `notes` untouched when there's nothing
// to change, so `mutateScriptNotes` skips the write.

function editCommentEntry(
	notes: ScriptNotesFile,
	id: string,
	index: number,
	patch: (entry: CommentEntry) => CommentEntry
): ScriptNotesFile {
	const list = notes.comments[id];
	if (!list || index < 0 || index >= list.length) return notes;
	const next = list.slice();
	next[index] = patch(list[index]);
	return { ...notes, comments: { ...notes.comments, [id]: next } };
}

/** Edits one reply's text — never touches `resolved`/`resolvedAt`. */
export function setCommentText(notes: ScriptNotesFile, id: string, index: number, text: string): ScriptNotesFile {
	return editCommentEntry(notes, id, index, (e) => ({ ...e, text, updatedAt: Date.now() }));
}

/** Flips one reply's resolved state, stamping/clearing `resolvedAt`. */
export function toggleCommentResolved(notes: ScriptNotesFile, id: string, index: number): ScriptNotesFile {
	return editCommentEntry(notes, id, index, (e) => {
		const resolved = !e.resolved;
		return { ...e, resolved, resolvedAt: resolved ? Date.now() : null };
	});
}

/** Removes one reply; an emptied thread drops its whole `comments[id]` key. */
export function removeCommentEntry(notes: ScriptNotesFile, id: string, index: number): ScriptNotesFile {
	const list = notes.comments[id];
	if (!list || index < 0 || index >= list.length) return notes;
	const next = list.filter((_, i) => i !== index);
	if (next.length === 0) {
		const { [id]: _dropped, ...rest } = notes.comments;
		return { ...notes, comments: rest };
	}
	return { ...notes, comments: { ...notes.comments, [id]: next } };
}

/** Appends a new, unresolved reply to the thread. */
export function addCommentReply(notes: ScriptNotesFile, id: string, text: string): ScriptNotesFile {
	const list = notes.comments[id] ?? [];
	const entry: CommentEntry = {
		id,
		text,
		resolved: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		resolvedAt: null,
	};
	return { ...notes, comments: { ...notes.comments, [id]: [...list, entry] } };
}

/** A freshly wrapped alt-text span: the selection is option 0. */
export function startAltText(notes: ScriptNotesFile, id: string, selectedText: string): ScriptNotesFile {
	return { ...notes, altText: { ...notes.altText, [id]: { id, options: [selectedText], activeIndex: 0, acceptedIndex: null } } };
}

export function dropAltText(notes: ScriptNotesFile, id: string): ScriptNotesFile {
	const { [id]: _dropped, ...rest } = notes.altText;
	return { ...notes, altText: rest };
}

/** Appends an option without activating it. */
export function addAltOption(notes: ScriptNotesFile, id: string, text: string): ScriptNotesFile {
	const cur = notes.altText[id];
	if (!cur) return notes;
	return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options: [...cur.options, text] } } };
}

/** Rewrites one option's wording in place. */
export function setAltOptionText(notes: ScriptNotesFile, id: string, index: number, text: string): ScriptNotesFile {
	const cur = notes.altText[id];
	if (!cur || index < 0 || index >= cur.options.length) return notes;
	const options = cur.options.slice();
	options[index] = text;
	return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options } } };
}

/** Makes `index` the active option — Accept also stamps `acceptedIndex`,
 *  Draft clears it. */
export function pickAltOption(notes: ScriptNotesFile, id: string, index: number, accept: boolean): ScriptNotesFile {
	const cur = notes.altText[id];
	if (!cur || index < 0 || index >= cur.options.length) return notes;
	return {
		...notes,
		altText: { ...notes.altText, [id]: { ...cur, activeIndex: index, acceptedIndex: accept ? index : null } },
	};
}

/** Advances to the next option (Draft semantics: clears `acceptedIndex`). */
export function cycleAltOption(notes: ScriptNotesFile, id: string): ScriptNotesFile {
	const cur = notes.altText[id];
	if (!cur || cur.options.length < 2) return notes;
	return pickAltOption(notes, id, (cur.activeIndex + 1) % cur.options.length, false);
}

/** Copies `live` (the span's current document text) into the active option
 *  when it differs. The active option is normally edited by hand right in
 *  the document, and the sidecar only learns of it here — so every swap
 *  away from the active option runs this first, or the edit is lost. */
export function syncActiveAltOption(notes: ScriptNotesFile, id: string, live: string | null): ScriptNotesFile {
	const cur = notes.altText[id];
	if (!cur || live === null || live === cur.options[cur.activeIndex]) return notes;
	return setAltOptionText(notes, id, cur.activeIndex, live);
}

/** Deletes one option, renumbering `activeIndex`/`acceptedIndex` past it.
 *  Deleting down to one survivor drops the entry and returns that survivor's
 *  text as `strippedTo` — the caller unwraps the span to it. */
export function deleteAltOption(
	notes: ScriptNotesFile,
	id: string,
	index: number
): { notes: ScriptNotesFile; strippedTo: string | null } {
	const cur = notes.altText[id];
	if (!cur || cur.options.length <= 1 || index < 0 || index >= cur.options.length) return { notes, strippedTo: null };
	const options = cur.options.slice();
	options.splice(index, 1);
	if (options.length <= 1) return { notes: dropAltText(notes, id), strippedTo: options[0] ?? '' };
	let activeIndex = cur.activeIndex;
	if (index === activeIndex) activeIndex = Math.min(index, options.length - 1);
	else if (index < activeIndex) activeIndex -= 1;
	let acceptedIndex = cur.acceptedIndex;
	if (acceptedIndex !== null) {
		if (index === acceptedIndex) acceptedIndex = null;
		else if (index < acceptedIndex) acceptedIndex -= 1;
	}
	return { notes: { ...notes, altText: { ...notes.altText, [id]: { ...cur, options, activeIndex, acceptedIndex } } }, strippedTo: null };
}

// --- Comment + alt-text handlers -----------------------------------------------

/** Where an annotation surface reads and writes its document. */
export interface AnnotationIO {
	/** The span's CURRENT document text, or null. */
	liveAltText: (id: string) => string | null | Promise<string | null>;
	/** Replaces an alt-text span's wrapped content. */
	replaceAlt: (id: string, text: string) => void | Promise<void>;
	/** Strips a span's marker pair, leaving its content. */
	stripMarkers: (id: string) => void | Promise<void>;
}

/**
 * The comment-thread and alt-text handlers shared by the Script view, the
 * Scene/Act pages and the Book surfaces; each passes its own `AnnotationIO`.
 *
 * Alt-text actions run one at a time (`runAlt`), each finishing its document
 * write before the next starts. That is what makes reading `liveAltText` at
 * the start of each action safe: it can't see a previous swap still in
 * flight and mistake it for a hand-edit of the newly active option.
 */
export function useAnnotationHandlers(plugin: LoomLoomPlugin, project: ProjectRef | null, io: AnnotationIO) {
	const scriptNotes = useScriptNotes(plugin, project);
	const [openComment, setOpenComment] = useState<{ id: string; rect: DOMRect } | null>(null);
	/** Threads that got a reply this session — `scriptNotes` only catches up
	 *  after the sidecar's write + file-watch round trip, so closing the
	 *  popover right after replying must not read the thread as empty. */
	const commentsWithNewEntryRef = useRef<Set<string>>(new Set());
	const altQueue = useRef<Promise<unknown>>(Promise.resolve());

	const mutate = (fn: (notes: ScriptNotesFile) => ScriptNotesFile) =>
		project ? mutateScriptNotes(plugin.app, project, fn) : Promise.resolve(EMPTY);
	const runAlt = <T,>(fn: () => Promise<T>): Promise<T> => {
		const run = altQueue.current.then(fn);
		altQueue.current = run.catch((e) => console.error('Loom Loom: alt-text action failed', e));
		return run;
	};
	/** Syncs the outgoing option, applies `change`, then writes the newly
	 *  active option into the document — unless `swapped` (the caller's own
	 *  field already did, handing over the pre-swap text as `outgoing`). */
	const swapAlt = (id: string, change: (notes: ScriptNotesFile) => ScriptNotesFile, outgoing?: string) =>
		runAlt(async () => {
			const live = outgoing ?? (await io.liveAltText(id));
			const next = await mutate((notes) => change(syncActiveAltOption(notes, id, live)));
			const cur = next.altText[id];
			if (cur && outgoing === undefined) await io.replaceAlt(id, cur.options[cur.activeIndex]);
		});

	const handleOpenComment = (id: string, rect: DOMRect) => setOpenComment({ id, rect });
	/** Closing a thread nothing was ever added to abandons the comment: its
	 *  freshly inserted markers come back out of the document. */
	const handleCloseComment = () => {
		if (openComment && !commentsWithNewEntryRef.current.has(openComment.id) && !scriptNotes.comments[openComment.id]) {
			void io.stripMarkers(openComment.id);
		}
		setOpenComment(null);
	};
	const handleSaveCommentEntry = (id: string, index: number, text: string) =>
		void mutate((notes) => setCommentText(notes, id, index, text));
	const handleToggleCommentResolved = (id: string, index: number) =>
		void mutate((notes) => toggleCommentResolved(notes, id, index));
	/** Deleting a thread's last reply strips its markers too, and closes the
	 *  popover — there's nothing left in the document to reply to. */
	const handleDeleteCommentEntry = (id: string, index: number) =>
		void mutate((notes) => removeCommentEntry(notes, id, index)).then((next) => {
			if (next.comments[id]) return;
			void io.stripMarkers(id);
			setOpenComment((prev) => (prev && prev.id === id ? null : prev));
		});
	const handleAddCommentReply = (id: string, text: string) => {
		commentsWithNewEntryRef.current.add(id);
		void mutate((notes) => addCommentReply(notes, id, text));
	};

	/** A new alt-text span wraps the selection as option 0 and immediately
	 *  asks for a second wording; cancelling backs the whole span out. */
	const handleCreateAlt = (id: string, selectedText: string) => {
		void mutate((notes) => startAltText(notes, id, selectedText));
		new TextInputModal(plugin.app, {
			title: t('view.entity.altText.addWordingTitle'),
			placeholder: selectedText,
			cta: t('project.common.add'),
			multiline: true,
			onSubmit: (value) => void mutate((notes) => addAltOption(notes, id, value)),
			onCancel: () => void mutate((notes) => dropAltText(notes, id)).then(() => io.stripMarkers(id)),
		}).open();
	};
	/** Left-click cycle. `outgoing` is passed only by a field that already
	 *  swapped its own document (Book's editable `MarkdownField`). */
	const handleCycleAlt = (id: string, outgoing?: string) =>
		void swapAlt(id, (notes) => cycleAltOption(notes, id), outgoing);
	const handleDraftAlt = (id: string, index: number) =>
		void swapAlt(id, (notes) => pickAltOption(notes, id, index, false));
	const handleAcceptAlt = (id: string, index: number) =>
		void swapAlt(id, (notes) => pickAltOption(notes, id, index, true));
	/** An option's wording edited in `AltTextModal` — the document follows
	 *  when it's the active one. */
	const handleEditAltOption = (id: string, index: number, text: string) =>
		void runAlt(async () => {
			const next = await mutate((notes) => setAltOptionText(notes, id, index, text));
			if (next.altText[id]?.activeIndex === index) await io.replaceAlt(id, text);
		});
	const handleAddAltOption = (id: string, text: string) => void mutate((notes) => addAltOption(notes, id, text));
	/** Deleting down to one option unwraps the span to the survivor's wording
	 *  and drops the entry; `undefined` tells `AltTextModal` to close. */
	const handleDeleteAltOption = (id: string, index: number) =>
		runAlt(async () => {
			const live = await io.liveAltText(id);
			let strippedTo: string | null = null;
			const next = await mutate((notes) => {
				const r = deleteAltOption(syncActiveAltOption(notes, id, live), id, index);
				strippedTo = r.strippedTo;
				return r.notes;
			});
			if (strippedTo !== null) {
				// The survivor has to BE the document text before the markers
				// come out, or whichever option was active would stay instead.
				await io.replaceAlt(id, strippedTo);
				await io.stripMarkers(id);
				return undefined;
			}
			const cur = next.altText[id];
			if (cur) await io.replaceAlt(id, cur.options[cur.activeIndex]);
			return cur;
		});
	/** Right-click: `AltTextModal`, showing the active option's live wording. */
	const handleOpenAltMenu = (id: string) =>
		void runAlt(async () => {
			const live = await io.liveAltText(id);
			const entry = syncActiveAltOption(scriptNotes, id, live).altText[id];
			if (!entry) return;
			new AltTextModal(plugin.app, {
				options: entry.options,
				activeIndex: entry.activeIndex,
				acceptedIndex: entry.acceptedIndex,
				onDraft: (index) => handleDraftAlt(id, index),
				onAccept: (index) => handleAcceptAlt(id, index),
				onEditOption: (index, text) => handleEditAltOption(id, index, text),
				onAddOption: (text) => handleAddAltOption(id, text),
				onDeleteOption: (index) => handleDeleteAltOption(id, index),
			}).open();
		});

	return {
		scriptNotes,
		openComment,
		setOpenComment,
		handleOpenComment,
		handleCloseComment,
		handleSaveCommentEntry,
		handleToggleCommentResolved,
		handleDeleteCommentEntry,
		handleAddCommentReply,
		handleCreateAlt,
		handleCycleAlt,
		handleDraftAlt,
		handleAcceptAlt,
		handleEditAltOption,
		handleAddAltOption,
		handleDeleteAltOption,
		handleOpenAltMenu,
	};
}
