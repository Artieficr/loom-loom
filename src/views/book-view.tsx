import { Menu, normalizePath, TFile } from 'obsidian';
import { ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
	BOOK_EXTENSION,
	BOOK_ICON,
	EntityRecord,
	FM,
	VIEW_PROSE,
	bookLabel,
	pcGroupStub,
	bySeq,
} from '../types';
import {
	ParsedBook,
	appendBookPageBreak,
	chapterBookText,
	ensureBookIds,
	findChapterMentions,
	liveBookActIds,
	liveBookChapterIds,
	parseBook,
	removeBookAct,
	removeBookChapter,
	removeBookPageBreak,
	reorderBookChaptersInAct,
	reorderBookTopLevelEntries,
} from '../prose';
import { ProjectDef, linkTargetOf } from '../indexer';
import { setLoomKey } from '../fm';
import { editVaultFile } from '../write-queue';
import {
	CreateEntityModal,
	createEntity,
	deleteEntityNote,
} from '../project';
import { managedEntityFileName, projectPath } from '../naming';
import { LoomFileReactView, LoomNavigator } from './react-view';
import { MarkdownField } from './markdown-field';
import {
	EmptyActMessage,
	Icon,
	ViewShell,
	buildEntityLinkNames,
	buildLinkTargetLabels,
	moveItem,
	openEntityLink,
	useSeqDrag,
	SearchNav,
	MatchStat,
	AnnotationPanelToggles,
	scrollIntoContainer,
	StartCue,
	useCloseOnOutsideClick,
} from './common';
import { useIndexVersion, usePersistedChoice, useRememberedScroll, useVaultFileText } from './hooks';
import { t } from '../i18n';
import { advanceTutorial, currentTutorialStep } from '../tutorial';
import { AnnotationSpan, cleanAnnotationMarkers, findAnnotationSpans } from '../fountain';
import {
	type UndecidedAltRow,
	type UnresolvedCommentRow,
	undecidedAltRows,
	unresolvedCommentRows,
	useAnnotationHandlers,
	pruneScriptNotes,
} from './script-notes';
import { AlternativesBrowserPanel, CommentPopover, CommentsBrowserPanel } from './annotation-popover';
import type { LinkOption } from './markdown-field';
import type LoomLoomPlugin from '../main';

/**
 * The project's Book: `<root>/<Project>.loomprose`, registered like the
 * .loom home file rather than stored as markdown — same reason Fountain
 * can't be: the hidden `[[loom:<id>]]` section markers would otherwise
 * pollute Obsidian's wikilink index. Mirrors `scriptFilePath`.
 */
export function bookFilePath(project: ProjectDef): string {
	return projectPath(project, `${project.name}.${BOOK_EXTENSION}`);
}

/** The project's Book file, or null when it hasn't been created yet. */
export function findBookFile(plugin: LoomLoomPlugin, project: ProjectDef): TFile | null {
	return plugin.app.vault.getFileByPath(bookFilePath(project));
}

/** Creates an empty Book, seeded with nothing but a blank line — unlike
 *  Fountain's title page, prose has no per-project front matter of its own
 *  to seed. */
export async function createBookFile(plugin: LoomLoomPlugin, project: ProjectDef): Promise<TFile> {
	const existing = findBookFile(plugin, project);
	if (existing) return existing;
	return plugin.app.vault.create(bookFilePath(project), '');
}

/** Preview's right-click "Open this chapter" (`ActChapterBlocks`'s
 *  `onOpenChapter`, via `MarkdownField`'s own contextmenu handler) —
 *  resolves the chapter id to its backing note and hands off the clicked
 *  position through the exact `localStorage` key the Chapter page's own
 *  mount-time restore reads (`pendingChapterScrollLineRef`, entity-view.tsx
 *  — a character offset, not a line, since Chapter's field has no
 *  line-based `scrollToLine`), mirroring `PagesPreviewBody`'s own "Open
 *  this scene" (script-view.tsx). `offset` is already in the same space
 *  Chapter's own page's field uses — both render
 *  `chapterBookText(bookText, chapterId)` verbatim, with no further offset
 *  translation the way Fountain's heading-stripped excerpts need. Shared
 *  by `Book`'s own Preview here and Act's Prose section (entity-view.tsx)
 *  — byte-identical logic, extracted once found duplicated rather than
 *  left as two copies. */
export function openThisChapter(
	plugin: LoomLoomPlugin,
	project: ProjectDef | null | undefined,
	view: LoomNavigator,
	chapterId: string,
	offset: number
): void {
	if (!project) return;
	const record = plugin.indexer.getAll('chapter', project.root).find((r) => r.chapterId === chapterId);
	if (!record) return;
	window.localStorage.setItem(`loom-chapter-script-line:${record.path}`, String(offset));
	view.openEntity(record.path);
}

/**
 * Applies a change to the project's Book file. Mirrors `editScript`.
 *
 * Serialized per path (`queueWrite`): `replaceAltContentInBook`/
 * `stripAnnotationMarkerInBook` call this straight from an icon click, so
 * overlapping calls would otherwise each read before the other's write and
 * lose one (rapid alt-text clicks turned two options into the same text).
 * project.ts's `editBookFile` (the Act/Chapter creation modals) shares the
 * same queue.
 */
export async function editBook(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	return editVaultFile(plugin.app, bookFilePath(project), apply, 'book');
}

/**
 * Mirrors the Book's Acts/Chapters into Act/Chapter entity notes.
 *
 * Matching is by each heading's `[[loom:<id>]]` marker, never by title —
 * exactly `syncScenes`'s own reasoning. Deliberately additive: creates
 * missing notes and updates existing ones, but never deletes — a heading
 * removed from the Book leaves its note behind as an orphan rather than
 * silently destroying whatever was written on it.
 */
export async function syncActsChapters(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	parsed: ParsedBook,
	text: string
): Promise<void> {
	// The book file itself is the resolve() source path for every chapter's
	// own `[[...]]` mentions below — any real file in the vault works as
	// context for `getFirstLinkpathDest`, and every chapter's mentions live
	// in this one file regardless of which chapter holds them.
	const bookPath = findBookFile(plugin, project)?.path ?? '';
	const dedupeRecords = (records: EntityRecord[]) => [...new Map(records.map((r) => [r.path, r])).values()];
	const sameLinks = (existingLinks: string[], records: EntityRecord[]) =>
		existingLinks.length === records.length && records.every((r, i) => existingLinks[i] === linkTargetOf(r));
	const existingActs = new Map<string, EntityRecord>();
	for (const record of plugin.indexer.getAll('act', project.root)) {
		if (record.actId !== '') existingActs.set(record.actId, record);
	}

	// Acts are structural — the Book owns them, created automatically exactly
	// like Fountain's own Act sync. The Book owns the title: the note is
	// renamed to follow its `#` line, mirroring `syncScenes`'s Act loop.
	const actById = new Map<string, EntityRecord>();
	const actsWithIds = parsed.acts.filter((a): a is typeof a & { loomId: string } => a.loomId !== null);
	for (let i = 0; i < actsWithIds.length; i++) {
		const act = actsWithIds[i];
		const seq = i + 1;
		const found = existingActs.get(act.loomId);
		if (found) {
			// A chapter matched below (`actById`) links via `linkTargetOf`, which
			// reads the record's own `.path` — so a rename here has to be
			// reflected into what gets stored for THIS pass, not just written to
			// disk, or a chapter renamed in the SAME sync as its act would link
			// to the act's now-stale (already-renamed-away) file name. `found`
			// itself is the indexer's own cached record; mutating it directly
			// isn't this codebase's pattern (the "create a new act" branch below
			// already builds a fresh object instead), so `synced` is a shallow
			// copy carrying whatever actually landed.
			let synced = found;
			if (found.seq !== seq || found.name !== act.title) {
				const file = plugin.app.vault.getFileByPath(found.path);
				if (file) {
					const renamed = found.name !== act.title;
					await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
						setLoomKey(fm, FM.seq, seq);
						if (renamed) {
							setLoomKey(fm, FM.name, act.title);
							fm.aliases = [act.title];
						}
					});
					if (renamed) {
						const base = managedEntityFileName(project.name, 'act', act.title);
						const dir = file.parent?.path ?? '';
						let newPath = normalizePath(dir === '' ? `${base}.md` : `${dir}/${base}.md`);
						for (let n = 2; plugin.app.vault.getAbstractFileByPath(newPath) !== null; n++) {
							newPath = normalizePath(dir === '' ? `${base} ${n}.md` : `${dir}/${base} ${n}.md`);
						}
						if (newPath !== file.path) {
							try {
								await plugin.app.fileManager.renameFile(file, newPath);
							} catch (e) {
								console.error('Loom Loom: act rename failed', e);
							}
						}
						synced = { ...found, path: file.path, name: act.title };
					}
				}
			}
			actById.set(act.loomId, synced);
			continue;
		}
		if (plugin.holdsNoteRecreate(project.root, act.loomId)) continue;
		const created = await createEntity(plugin, project, 'act', {
			name: act.title,
			tag: '',
			date: '',
			notes: '',
		});
		await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.actId, act.loomId);
			setLoomKey(fm, FM.seq, seq);
		});
		actById.set(act.loomId, { ...pcGroupStub(project.root), path: created.path, name: act.title, type: 'act' });
	}

	const existingChapters = new Map<string, EntityRecord>();
	for (const record of plugin.indexer.getAll('chapter', project.root)) {
		if (record.chapterId !== '') existingChapters.set(record.chapterId, record);
	}

	const chaptersWithIds = parsed.chapters.filter((c): c is typeof c & { loomId: string } => c.loomId !== null);
	for (let i = 0; i < chaptersWithIds.length; i++) {
		const chapter = chaptersWithIds[i];
		const seq = i + 1;
		const act = chapter.actId !== null ? actById.get(chapter.actId) : undefined;

		// Entities named via a plain `[[...]]` wikilink anywhere in the
		// chapter's own body text — resolution-only, same as Fountain's
		// `@[...]` scene mentions (an unresolved name is just inert text,
		// never auto-created).
		const body = chapterBookText(text, chapter.loomId) ?? '';
		const resolved = findChapterMentions(body)
			.map((target) => plugin.indexer.resolve(target, bookPath))
			.filter((r): r is EntityRecord => r !== null);
		const cast = dedupeRecords(resolved.filter((r) => r.type === 'character'));
		const factionsHere = dedupeRecords(resolved.filter((r) => r.type === 'faction'));
		const itemsHere = dedupeRecords(resolved.filter((r) => r.type === 'item'));
		const mentionedLocations = dedupeRecords(resolved.filter((r) => r.type === 'location'));

		const found = existingChapters.get(chapter.loomId);
		if (found) {
			const sameAct = found.chapterAct === (act ? linkTargetOf(act) : '');
			const clean =
				found.name === chapter.title &&
				sameAct &&
				found.seq === seq &&
				sameLinks(found.chapterCast, cast) &&
				sameLinks(found.chapterFactions, factionsHere) &&
				sameLinks(found.chapterItems, itemsHere) &&
				sameLinks(found.chapterMentionedLocations, mentionedLocations);
			if (clean) continue;
			const file = plugin.app.vault.getFileByPath(found.path);
			if (!file) continue;
			const renamed = found.name !== chapter.title;
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.chapterAct, act ? `[[${linkTargetOf(act)}]]` : '');
				setLoomKey(fm, FM.seq, seq);
				setLoomKey(
					fm,
					FM.chapterCast,
					cast.map((c) => `[[${linkTargetOf(c)}]]`)
				);
				setLoomKey(
					fm,
					FM.chapterFactions,
					factionsHere.map((f) => `[[${linkTargetOf(f)}]]`)
				);
				setLoomKey(
					fm,
					FM.chapterItems,
					itemsHere.map((it) => `[[${linkTargetOf(it)}]]`)
				);
				setLoomKey(
					fm,
					FM.chapterMentionedLocations,
					mentionedLocations.map((l) => `[[${linkTargetOf(l)}]]`)
				);
				if (renamed) {
					setLoomKey(fm, FM.name, chapter.title);
					fm.aliases = [chapter.title];
				}
			});
			if (renamed) {
				const base = managedEntityFileName(project.name, 'chapter', chapter.title);
				const dir = file.parent?.path ?? '';
				let newPath = normalizePath(dir === '' ? `${base}.md` : `${dir}/${base}.md`);
				for (let n = 2; plugin.app.vault.getAbstractFileByPath(newPath) !== null; n++) {
					newPath = normalizePath(dir === '' ? `${base} ${n}.md` : `${dir}/${base} ${n}.md`);
				}
				if (newPath !== file.path) {
					try {
						await plugin.app.fileManager.renameFile(file, newPath);
					} catch (e) {
						console.error('Loom Loom: chapter rename failed', e);
					}
				}
			}
			continue;
		}
		if (plugin.holdsNoteRecreate(project.root, chapter.loomId)) continue;
		const created = await createEntity(plugin, project, 'chapter', {
			name: chapter.title,
			tag: '',
			date: '',
			notes: '',
		});
		await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.chapterId, chapter.loomId);
			setLoomKey(fm, FM.chapterAct, act ? `[[${linkTargetOf(act)}]]` : '');
			setLoomKey(fm, FM.seq, seq);
			setLoomKey(
				fm,
				FM.chapterCast,
				cast.map((c) => `[[${linkTargetOf(c)}]]`)
			);
			setLoomKey(
				fm,
				FM.chapterFactions,
				factionsHere.map((f) => `[[${linkTargetOf(f)}]]`)
			);
			setLoomKey(
				fm,
				FM.chapterItems,
				itemsHere.map((it) => `[[${linkTargetOf(it)}]]`)
			);
			setLoomKey(
				fm,
				FM.chapterMentionedLocations,
				mentionedLocations.map((l) => `[[${linkTargetOf(l)}]]`)
			);
		});
	}
}

/**
 * Like `editBook`, but also re-syncs Act/Chapter notes from the result.
 * Mirrors `editScriptAndSync` — a structural edit made from the Chapter/Act
 * pages (move, reorder, retitle) needs the sync to happen immediately, or
 * the note silently disagrees with the Book until it's next opened.
 */
export async function editBookAndSync(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	const changed = await editBook(plugin, project, (raw) => {
		const applied = apply(raw);
		if (applied === null) return null;
		// Strips any LONE surviving comment/alt-text marker (a partial delete
		// took out only one half of a pair) — mirrors `runCommit`'s identical
		// step in script-view.tsx (fountain.ts's own `cleanAnnotationMarkers` is
		// format-agnostic, so it applies here unchanged), run before the write
		// so this write and the sidecar prune below both see the same text.
		return cleanAnnotationMarkers(ensureBookIds(applied).text).text;
	});
	if (changed) {
		const file = findBookFile(plugin, project);
		if (file) {
			const raw = await plugin.app.vault.read(file);
			await syncActsChapters(plugin, project, parseBook(raw), raw);
			pruneScriptNotes(plugin.app, project, raw);
		}
	}
	return changed;
}

/**
 * Trashes an Act or Chapter note AND removes its backing block from the
 * Book — mirrors `deleteScriptEntity` (script-view.tsx) exactly, one level
 * over for Prose: an Act/Chapter note IS its stretch of the `.loomprose`
 * file, so a note deleted without also removing that stretch left the raw
 * text behind (still shown in Editor mode, still absent from Preview/
 * Ctrl+click-to-open — those key off the now-gone indexed record, not the
 * text) instead of resurrecting cleanly as an orphan. Deleting an Act
 * cascades onto every Chapter note that pointed at it (`chapterAct`): the
 * act's own book block held their headings too, so once it's gone those
 * notes have nothing left to reflect and are trashed rather than left as
 * permanent orphans.
 */
export async function deleteBookEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	record: EntityRecord
): Promise<void> {
	if (record.type === 'chapter' && record.chapterId !== '') {
		const chapterId = record.chapterId;
		await editBook(plugin, project, (raw) => removeBookChapter(raw, chapterId));
	} else if (record.type === 'act' && record.actId !== '') {
		const actId = record.actId;
		const chapters = plugin.indexer.membersOfAct(record, 'chapter');
		await editBook(plugin, project, (raw) => removeBookAct(raw, actId));
		for (const ch of chapters) await deleteEntityNote(plugin, ch);
	}
	await deleteEntityNote(plugin, record);
}

/** Act/Chapter loom ids currently orphaned — backed by a note but no
 *  matching heading in the Book any more. Never auto-deleted, surfaced to
 *  the caller only. Mirrors the orphan surfacing `script-view.tsx` does for
 *  Scene/Act. */
export function orphanedBookEntities(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	parsed: ParsedBook
): { acts: EntityRecord[]; chapters: EntityRecord[] } {
	const liveActs = liveBookActIds(parsed);
	const liveChapters = liveBookChapterIds(parsed);
	return {
		acts: plugin.indexer.getAll('act', project.root).filter((r) => r.actId !== '' && !liveActs.has(r.actId)),
		chapters: plugin.indexer
			.getAll('chapter', project.root)
			.filter((r) => r.chapterId !== '' && !liveChapters.has(r.chapterId)),
	};
}

/** Live-reads the project's Book file, re-reading on any vault touch to its
 *  path — the Prose equivalent of `script-buffer.ts`'s `useScriptBuffer`,
 *  just without a shared in-memory buffer of its own yet (see that file's
 *  own doc comment / ROADMAP for the deferred Book/Chapter follow-up).
 *  Shared by the Chapter/Act pages' own Editor sections and `BookView`
 *  itself. */
export function useBookText(plugin: LoomLoomPlugin, project: ProjectDef | null): string | null {
	return useVaultFileText(plugin.app, project ? bookFilePath(project) : null);
}

/** Replaces an alt-text span's wrapped content, wherever in the Book it
 *  lives — used by `useBookAnnotations`' `AltTextModal` callbacks
 *  (Draft/Accept/edit an option), which have no specific chapter's live CM6
 *  view to dispatch through (unlike `fountain-field.tsx`'s
 *  `replaceAltContent`, called through one known field's own ref): finding
 *  the span across the whole Book text and writing it back via
 *  `editBookAndSync` works regardless of which chapter holds it, and is
 *  exactly as current as any chapter's own `MarkdownField`, since every
 *  keystroke there already commits straight to the Book file (no separate
 *  live buffer to fall behind — see `Book`'s own doc comment). */
async function replaceAltContentInBook(plugin: LoomLoomPlugin, project: ProjectDef, id: string, text: string): Promise<void> {
	await editBookAndSync(plugin, project, (raw) => {
		const span = findAnnotationSpans(raw).find((s) => s.kind === 'alt' && s.id === id);
		if (!span) return null;
		return raw.slice(0, span.contentFrom) + text + raw.slice(span.contentTo);
	});
}

/** Strips ONE marker pair by id, leaving its wrapped content untouched —
 *  the whole-Book-text counterpart of `fountain-field.tsx`'s imperative
 *  `removeAnnotationMarkers` (a CM6 transaction dispatched through one known
 *  live view). `useBookAnnotations` has no such single view to dispatch
 *  through — same reasoning `replaceAltContentInBook` above already
 *  documents — so this works the same way that one does: find the span
 *  across the WHOLE Book text via `editBookAndSync`, regardless of which
 *  chapter holds it. Safe to call from a caller whose relevant field has
 *  ALREADY lost focus by the time this runs (every call site here is
 *  triggered from `CommentPopover`/`AltTextModal`/a menu action — none of
 *  which can be clicked without first moving focus OFF the CM6 field, so its
 *  own "sync external value only while unfocused" effect picks the change up
 *  normally); calling it while the field is still actively focused and
 *  mid-edit is not something any current call site does. */
async function stripAnnotationMarkerInBook(plugin: LoomLoomPlugin, project: ProjectDef, id: string): Promise<void> {
	await editBookAndSync(plugin, project, (raw) => {
		const span = findAnnotationSpans(raw).find((s) => s.id === id);
		if (!span) return null;
		return raw.slice(0, span.from) + raw.slice(span.contentFrom, span.contentTo) + raw.slice(span.to);
	});
}

/** Reads an alt-text span's CURRENT text straight off disk — the Book's
 *  `AnnotationIO.liveAltText` (Book has no in-memory buffer). */
async function liveBookAltSpanText(plugin: LoomLoomPlugin, project: ProjectDef, id: string): Promise<string | null> {
	const file = findBookFile(plugin, project);
	if (!file) return null;
	// `handleOpenAltMenu` awaits this before opening `AltTextModal`, so a
	// transient read failure (the file vanishing mid-sync) returns `null`
	// and the modal shows the sidecar's last-known text instead.
	try {
		// `vault.read`, not `cachedRead` — cheap insurance against the same
		// staleness class as `useBookText`'s own fix, even though this
		// particular read already had a documented "essentially never
		// happens in practice" tolerance for it.
		const raw = await plugin.app.vault.read(file);
		const span = findAnnotationSpans(raw).find((s) => s.kind === 'alt' && s.id === id);
		return span ? raw.slice(span.contentFrom, span.contentTo) : null;
	} catch (e) {
		console.error('Loom Loom: could not read the book to sync an alt-text span', e);
		return null;
	}
}

/**
 * Comments/alternative-text data + handlers for the Book, shared by the
 * Chapter/Act entity page sections and `BookView` itself: `useAnnotationHandlers`
 * over the Book file, plus popover scroll-tracking.
 *
 * Reuses `script-notes.ts`'s sidecar AS-IS, same file
 * (`Entities/Script Notes/<Project> Script Notes.json`) a Script project
 * would use — keyed only by project + marker-id strings, and Script/Prose are
 * mutually exclusive per project, so there's no collision risk.
 */
export function useBookAnnotations(plugin: LoomLoomPlugin, project: ProjectDef | null) {
	const handlers = useAnnotationHandlers(plugin, project, {
		liveAltText: (id) => (project ? liveBookAltSpanText(plugin, project, id) : null),
		replaceAlt: (id, text) => (project ? replaceAltContentInBook(plugin, project, id, text) : undefined),
		stripMarkers: (id) => (project ? stripAnnotationMarkerInBook(plugin, project, id) : undefined),
	});
	const { openComment, setOpenComment } = handlers;

	/** `openComment.rect` is a one-time snapshot — without this, scrolling
	 *  whichever Book/Act/Chapter surface is open left the popover floating
	 *  in the same screen spot while the commented text scrolled out from
	 *  under it. This hook is shared by Book and the Act/Chapter sections,
	 *  each with their own wrapper DOM, so it queries `document` for the icon
	 *  and checks plain viewport visibility instead of one container's bounds. */
	useEffect(() => {
		if (!openComment) return;
		const id = openComment.id;
		// The popover was just opened by a click, so the active window is its own.
		const ownerDoc = activeDocument;
		const track = () => {
			const icon = ownerDoc.querySelector(`[data-loom-annotation-id="${id}"]`);
			if (!(icon instanceof HTMLElement)) {
				setOpenComment(null);
				return;
			}
			const rect = icon.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > ownerDoc.win.innerHeight) {
				setOpenComment(null);
				return;
			}
			setOpenComment((prev) => (prev && prev.id === id ? { id, rect } : prev));
		};
		ownerDoc.addEventListener('scroll', track, true);
		return () => ownerDoc.removeEventListener('scroll', track, true);
	}, [openComment?.id]);

	return {
		...handlers,
		comments: handlers.scriptNotes.comments,
		altText: handlers.scriptNotes.altText,
		/** `MarkdownField`'s `insertMarkerPair` opens the popover itself, and the
		 *  first `CommentEntry` is created by the first reply — nothing to do. */
		handleCreateComment: (_id: string) => {},
		/** `ActChapterBlocks`' read-only fields never swap the document
		 *  themselves, so the outgoing text they report is dropped and the
		 *  hook writes the swap (`handleCycleAlt` with no `outgoing`). */
		handleCycleAltReadOnly: (id: string) => handlers.handleCycleAlt(id),
	};
}

/**
 * Renders every chapter under one act as a stacked sequence of read-only
 * blocks — heading + a `chapterBookText`-scoped `MarkdownField` in `readOnly`
 * mode, instead of a separate paginated view (no pagination for prose — see
 * this feature's plan). Preview-only: the Editor side (whole-Book and Act
 * pages alike) is a single unified `MarkdownField` over the raw text instead
 * (see `Book`'s own doc comment) — chopping it into one field per chapter is
 * exactly the "reads like separate boxes, not one document" look that
 * approach was replaced for. Shared by the Act entity page's own Preview
 * section (`entity-view.tsx`) and `BookView` below (which calls this once
 * per act in the whole book) — the two differ only in how MANY acts' worth
 * of chapters they show.
 */
export function ActChapterBlocks({
	plugin,
	bookText,
	chapters,
	names,
	linkLabels,
	onOpenLink,
	emptyMessage,
	annotations,
	highlightedAnnotationId,
	onOpenChapter,
}: {
	plugin: LoomLoomPlugin;
	bookText: string | null;
	chapters: EntityRecord[];
	names: LinkOption[];
	linkLabels?: Map<string, string>;
	onOpenLink: (target: string, newTab?: boolean) => void;
	emptyMessage: ReactElement | null;
	/** Comments/alternative-text — optional, same as `MarkdownField`'s own
	 *  props (omitting it leaves every chapter's field exactly as before).
	 *  Alt-text cycling/picking uses `handleCycleAltReadOnly` (not
	 *  `handleCycleAlt`, which assumes the caller's own field already
	 *  committed the swap to disk — never true for these read-only
	 *  fields). */
	annotations?: ReturnType<typeof useBookAnnotations>;
	highlightedAnnotationId?: string | null;
	/** Right-click "Open this chapter" on a position within a chapter's own
	 *  block — passed straight through to that chapter's `MarkdownField`
	 *  (`onOpenChapter`'s own doc comment there). Optional: the Chapter
	 *  page's own standalone Preview has nothing further to open FROM. */
	onOpenChapter?: (chapterId: string, offset: number) => void;
}): ReactElement {
	if (chapters.length === 0) return emptyMessage ?? <></>;
	return (
		<>
			{chapters.map((ch) => {
				const excerpt = bookText !== null && ch.chapterId !== '' ? chapterBookText(bookText, ch.chapterId) : null;
				if (excerpt === null) return null;
				return (
					<div key={ch.path} className="loom-field loom-field-sep" data-chapter-id={ch.chapterId}>
						{/* Plain, non-interactive text — Preview reads like Script's own
						    Pages preview (a wikilink in the body is already inert via
						    `plainLinks`; a click-to-open button here was the one thing
						    still behaving like a link, a real reported inconsistency). */}
						<span className="loom-subloc-link">{ch.name}</span>
						<MarkdownField
							app={plugin.app}
							value={excerpt}
							names={names}
							linkLabels={linkLabels}
							onOpenLink={onOpenLink}
							readOnly
							plainLinks
							onChange={() => {}}
							comments={annotations?.comments}
							altText={annotations?.altText}
							onOpenComment={annotations?.handleOpenComment}
							onCycleAlt={annotations?.handleCycleAltReadOnly}
							onOpenAltMenu={annotations?.handleOpenAltMenu}
							highlightedAnnotationId={highlightedAnnotationId}
							annotationGutter
							onOpenChapter={onOpenChapter ? (offset) => onOpenChapter(ch.chapterId, offset) : undefined}
						/>
					</div>
				);
			})}
		</>
	);
}

export class BookView extends LoomFileReactView {
	getViewType(): string {
		return VIEW_PROSE;
	}

	protected pageTitle(): string {
		return this.file ? `${this.file.basename} — ${bookLabel()}` : bookLabel();
	}

	getIcon(): string {
		return BOOK_ICON;
	}

	canAcceptExtension(extension: string): boolean {
		return extension === BOOK_EXTENSION;
	}

	protected renderReact(): ReactElement {
		return <Book key={this.file?.path ?? ''} view={this} />;
	}
}

/**
 * The whole-book view: Preview shows every Act in order with its own
 * Chapters (`ActChapterBlocks`, read-only) and Outline is a drag-reorder
 * tree — the only two panes; editing happens on the Chapter entity page's
 * own field (the one remaining live editor for Prose), never here.
 * `bookCommitQueueRef`/`queueBookEdit` still serializes Outline's own
 * reorders so two structural edits in flight at once can't land out of
 * order.
 *
 * Cross-act chapter dragging is deliberately NOT supported (Outline mode) —
 * same "v1 ships same-act reorder only" scope call as the Act page's own
 * Outline. Acts reorder at the top level; a chapter reorders within its own
 * act.
 */
/** Which side drawer is open on a Book surface — at most one. */
export type BookSidePanel = 'nav' | 'comments' | 'alt' | null;

/**
 * The Preview's left-margin drawer slot (Script's `navPanel`, for prose): a
 * toggle opening an act → chapter jump list, plus whichever comments/
 * alternatives browser is open. Jumps scroll `scroller` to the act's or
 * chapter's block (`data-book-act` / `data-chapter-id`). Closes on an
 * outside click.
 */
export function BookSidePanels({
	panel,
	setPanel,
	acts,
	chaptersOf,
	scroller,
	commentRows,
	altRows,
	onJumpAnnotation,
	scrollKey,
}: {
	panel: BookSidePanel;
	setPanel: (next: BookSidePanel) => void;
	acts: EntityRecord[];
	chaptersOf: (act: EntityRecord) => EntityRecord[];
	scroller: { current: HTMLElement | null };
	commentRows: UnresolvedCommentRow[];
	altRows: UndecidedAltRow[];
	onJumpAnnotation: (span: AnnotationSpan) => void;
	/** localStorage key the jump list's scroll position is kept under. */
	scrollKey?: string;
}): ReactElement {
	const ref = useRef<HTMLDivElement | null>(null);
	const navScrollRef = useRememberedScroll(scrollKey ?? null);
	useCloseOnOutsideClick(ref, panel !== null, () => setPanel(null));
	const jump = (selector: string) => {
		const container = scroller.current;
		const el = container?.querySelector(selector);
		if (container && el) scrollIntoContainer(container, el, 'smooth');
		setPanel(null);
	};
	return (
		<div ref={ref} className="loom-script-nav-sticky loom-script-nav-sticky-inset">
			<button
				className="loom-script-nav-toggle"
				aria-label={panel === 'nav' ? t('view.entity.script.hideNavigation') : t('view.entity.script.showNavigation')}
				onClick={() => setPanel(panel === 'nav' ? null : 'nav')}
			>
				<Icon name={panel === 'nav' ? 'panel-left-close' : 'panel-left-open'} />
			</button>
			{panel === 'nav' ? (
				<aside ref={navScrollRef} className="loom-script-nav">
					<div className="loom-script-nav-head">
						{t('view.entity.script.navigate')}
						<button
							className="loom-rel-filter"
							aria-label={t('view.entity.script.hideNavigation')}
							onClick={() => setPanel(null)}
						>
							<Icon name="chevron-left" />
						</button>
					</div>
					{acts.length === 0 ? <div className="loom-script-nav-empty">{t('view.script.noActsYetBook')}</div> : null}
					{acts.map((act) => (
						<div key={act.path}>
							<button className="loom-script-nav-act" onClick={() => jump(`[data-book-act="${act.actId}"]`)}>
								{act.name}
							</button>
							<div className="loom-script-nav-children">
								{chaptersOf(act).map((ch) => (
									<button
										key={ch.path}
										className="loom-script-nav-scene"
										onClick={() => jump(`[data-chapter-id="${ch.chapterId}"]`)}
									>
										{ch.name}
									</button>
								))}
							</div>
						</div>
					))}
				</aside>
			) : null}
			{panel === 'comments' ? (
				<CommentsBrowserPanel rows={commentRows} onJump={onJumpAnnotation} onClose={() => setPanel(null)} />
			) : null}
			{panel === 'alt' ? (
				<AlternativesBrowserPanel rows={altRows} onJump={onJumpAnnotation} onClose={() => setPanel(null)} />
			) : null}
		</div>
	);
}

function Book({ view }: { view: BookView }): ReactElement {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const file = view.file;
	const project = file ? plugin.indexer.projectForPath(file.path) : undefined;
	const bookText = useBookText(plugin, project ?? null);
	const parsed = useMemo(() => (bookText !== null ? parseBook(bookText) : null), [bookText]);
	const annotations = useBookAnnotations(plugin, project ?? null);

	/** The whole-book unified editor's own commit plumbing — mirrors Script's
	 *  `text`/`onBlur`/`commitQueue` (script-view.tsx): typing only updates the
	 *  live CM6 buffer (via `MarkdownField`'s own "sync external value only
	 *  while unfocused" effect) and this ref, never the vault; the actual
	 *  write happens on blur (including the blur teardown fires on every
	 *  Editor→Preview/Outline switch), queued so an overlapping structural
	 *  edit (Outline reorder, "+ New act") lands in request order instead of
	 *  racing a still-in-flight commit. */
	const bookCommitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	/** Serializes Outline's reorders. A failed run's rejection is swallowed
	 *  ON THE QUEUE ITSELF (same as script-view.tsx's `commit`): a rejected
	 *  promise never runs a later `.then()`, so one throw would wedge every
	 *  edit queued after it. */
	const queueBookEdit = (apply: (text: string) => string | null) => {
		if (!project) return;
		const run = bookCommitQueueRef.current.then(() => editBookAndSync(plugin, project, apply));
		bookCommitQueueRef.current = run.catch((e) => {
			console.error('Loom Loom: could not commit a book edit', e);
		});
	};

	const [mode, setMode] = usePersistedChoice(
		file ? `loom-book-mode:${file.path}` : null,
		['preview', 'outline'] as const,
		'preview'
	);
	const [query, setQuery] = useState('');
	/** Comment/alt-text search, separate from the plain-text search above
	 *  (`window.find()`, unchanged): that mechanism searches the RENDERED
	 *  page, which never includes comment bodies or alt-text options (they
	 *  live in the sidecar, not the document) — mirrors `ScriptSearchMatch`,
	 *  minus the `text`-kind case, which has no single shared offset space
	 *  to sort against here the way one Fountain buffer does (each chapter
	 *  is its own document). */
	const [matchIndex, setMatchIndex] = useState(0);
	const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [collapsedActs, setCollapsedActs] = useState<Set<string>>(new Set());
	/** The Preview's left drawer — navigation or a comments/alternatives
	 *  browser, one at a time (`BookSidePanels`). */
	const [sidePanel, setSidePanel] = useState<BookSidePanel>(null);

	/** Preview mode's own scroller — mirrors Script's `.loom-screenplay`. */
	const previewWrapperRef = useRef<HTMLDivElement | null>(null);

	/** Scrolls the tabs row into view on every click — mirrors Script's own
	 *  `clickTab`/`clickActTab` (`scrollTabsIntoView`), even a re-click of the
	 *  pane already active, so working in BookView from wherever the page
	 *  happens to be scrolled is one click away. */
	const tabsRef = useRef<HTMLDivElement | null>(null);
	const scrollTabsIntoView = () => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	const switchMode = (next: 'preview' | 'outline') => {
		if (next !== mode) setMode(next);
		window.requestAnimationFrame(scrollTabsIntoView);
	};

	// loomSeq drag-reorder — groups: 'book-top-level' (acts AND page breaks,
	// interleaved) and `book-chapters:<actId>` (one act's own chapters).
	const { drag: seqDrag, rowStyle: seqRowStyle, grip } = useSeqDrag();
	const seqGrip = <T,>(group: string, i: number, records: T[], onCommit: (reordered: T[]) => void) =>
		grip(group, i, records.length, (from, over) => onCommit(moveItem(records, from, over)));

	const linkNames = useMemo<LinkOption[]>(
		() => (project ? buildEntityLinkNames(plugin, project) : []),
		[plugin, project, version]
	);
	const linkLabels = useMemo(
		() => (project ? buildLinkTargetLabels(plugin, project) : new Map<string, string>()),
		[plugin, project, version]
	);

	const openLinkTarget = (target: string, newTab = false) => {
		if (!file) return;
		openEntityLink(plugin, view, file.path, target, newTab);
	};

	const openThisChapterFromBook = (chapterId: string, offset: number) =>
		openThisChapter(plugin, project, view, chapterId, offset);

	// Tutorial: the Book is where opening it and its Outline complete.
	const tutorialStep = currentTutorialStep(project?.config);
	useEffect(() => {
		if (!project) return;
		if (tutorialStep === 'openDoc') advanceTutorial(plugin, project, 'openDoc');
		else if (tutorialStep === 'openOutline' && mode === 'outline') advanceTutorial(plugin, project, 'openOutline');
	}, [tutorialStep, mode, project, plugin]);

	if (!project) {
		return <div className="loom-view loom-book-view loom-empty">{t('view.home.loadingProject')}</div>;
	}

	const acts = plugin.indexer
		.getAll('act', project.root)
		.sort(bySeq);
	// Grouped in ONE pass over every chapter, rather than re-resolving the
	// whole chapter list per act (the Outline/Preview JSX and the search loop
	// below both look chapters up per act).
	const chaptersByAct = new Map<string, EntityRecord[]>();
	const actlessChapters: EntityRecord[] = [];
	for (const c of plugin.indexer.getAll('chapter', project.root)) {
		const actPath = c.chapterAct !== '' ? plugin.indexer.resolve(c.chapterAct, c.path)?.path : undefined;
		if (!actPath) {
			actlessChapters.push(c);
			continue;
		}
		const list = chaptersByAct.get(actPath);
		if (list) list.push(c);
		else chaptersByAct.set(actPath, [c]);
	}
	for (const list of chaptersByAct.values()) list.sort(bySeq);
	const chaptersOf = (act: EntityRecord): EntityRecord[] => chaptersByAct.get(act.path) ?? [];
	const orphans = parsed ? orphanedBookEntities(plugin, project, parsed) : { acts: [], chapters: [] };

	/** The Outline's own top-level list — every Act AND every act-boundary
	 *  page break, interleaved in document order, mirrors `topLevelRows`
	 *  (script-view.tsx). Only acts already backed by an indexed note are
	 *  included (an id-less/not-yet-synced one has nothing to show). */
	type BookTopLevelRow =
		| { kind: 'act'; id: string; line: number; act: EntityRecord }
		| { kind: 'page-break'; id: string; line: number };
	// What the tutorial lights on this page for the current step (an act's
	// steps are reached from Home, through the Acts list).
	/** Outline button: the step itself, or the way on to the Outline. */
	const tutOutlineCue =
		mode === 'outline'
			? null
			: tutorialStep === 'openOutline'
				? t('tutorial.goHere')
				: tutorialStep === 'createAct' && acts.length > 0
					? t('tutorial.continueHere')
					: null;
	/** "+ New act" shows in both modes; with acts to open, only in Outline. */
	const tutNewAct = tutorialStep === 'createAct' && (acts.length === 0 || mode === 'outline');
	const tutTable = tutNewAct && acts.length > 0;
	const topLevelRows: BookTopLevelRow[] = (() => {
		if (!parsed) return [];
		const actByLoomId = new Map(acts.map((a) => [a.actId, a]));
		const rows: BookTopLevelRow[] = [];
		for (const a of parsed.acts) {
			if (a.loomId === null) continue;
			const rec = actByLoomId.get(a.loomId);
			if (rec) rows.push({ kind: 'act', id: a.loomId, line: a.line, act: rec });
		}
		for (const pb of parsed.pageBreaks) {
			if (pb.loomId === null) continue;
			rows.push({ kind: 'page-break', id: pb.loomId, line: pb.line });
		}
		return rows.sort((a, b) => a.line - b.line);
	})();
	/** The "manual page" a top-level line falls under — 1 + however many page
	 *  breaks sit before it. Prose has no real pagination (see prose.ts's own
	 *  doc comment), so this is a much simpler stand-in than Script's actual
	 *  typeset page ranges: a plain count of `===` markers crossed so far,
	 *  shared by an act row and every one of its own chapter rows (a chapter
	 *  never has its own page break — only acts do). */
	const pageOfLine = (line: number): number =>
		1 + (parsed ? parsed.pageBreaks.filter((pb) => pb.line < line).length : 0);
	/** Preview mode's own act groups, split at every page break — each group
	 *  renders in its OWN `.loom-book-page` sheet, so a page break actually
	 *  reads as a page break there (a fresh sheet, `.loom-screenplay`'s own
	 *  `gap`/box-shadow already visually separating them) instead of every
	 *  act sharing one continuous sheet regardless of any `===` markers.
	 *  Derived straight from `topLevelRows` (already in document order) —
	 *  no page breaks anywhere in the book collapses back to the original
	 *  single-group behavior. */
	const previewPageGroups: EntityRecord[][] = (() => {
		const groups: EntityRecord[][] = [[]];
		for (const row of topLevelRows) {
			if (row.kind === 'page-break') groups.push([]);
			else groups[groups.length - 1].push(row.act);
		}
		return groups.filter((g) => g.length > 0);
	})();

	type BookAnnotationMatch = { kind: 'comment' | 'altOption'; id: string };
	const bookMatches: BookAnnotationMatch[] = [];
	if (query.trim() !== '' && bookText !== null) {
		const needle = query.trim().toLowerCase();
		for (const act of acts) {
			for (const ch of chaptersOf(act)) {
				if (ch.chapterId === '') continue;
				const excerpt = chapterBookText(bookText, ch.chapterId);
				if (excerpt === null) continue;
				for (const span of findAnnotationSpans(excerpt)) {
					if (span.kind === 'comment') {
						const entries = annotations.comments[span.id] ?? [];
						if (entries.some((e) => e.text.toLowerCase().includes(needle))) {
							bookMatches.push({ kind: 'comment', id: span.id });
						}
					} else {
						const entry = annotations.altText[span.id];
						if (entry?.options.some((opt) => opt.toLowerCase().includes(needle))) {
							bookMatches.push({ kind: 'altOption', id: span.id });
						}
					}
				}
			}
		}
	}
	const gotoMatch = (index: number) => {
		if (bookMatches.length === 0) return;
		const next = ((index % bookMatches.length) + bookMatches.length) % bookMatches.length;
		setMatchIndex(next);
		const m = bookMatches[next];
		setHighlightedAnnotationId(m.kind === 'altOption' ? m.id : null);
		window.requestAnimationFrame(() => {
			const el = contentRef.current?.querySelector(`[data-loom-annotation-content="${m.id}"]`);
			if (!(el instanceof HTMLElement)) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			if (m.kind === 'comment') annotations.handleOpenComment(m.id, el.getBoundingClientRect());
		});
	};

	// Comments/Alternatives browse-all panels' own row data — shared with
	// Script's identical panels (script-notes.ts's `unresolvedCommentRows`/
	// `undecidedAltRows`, rendered via `CommentsBrowserPanel`/
	// `AlternativesBrowserPanel`, annotation-popover.tsx). Computed over the
	// WHOLE book text — `findAnnotationSpans` doesn't need to be scoped to a
	// chapter for this, ids are globally unique and the DOM lookup below
	// resolves by id regardless of which chapter's own excerpt originally
	// discovered it.
	const unresolvedCommentRowsList = bookText !== null ? unresolvedCommentRows(bookText, annotations.comments) : [];
	const undecidedAltRowsList = bookText !== null ? undecidedAltRows(bookText, annotations.altText) : [];

	/** Both browse-all panels' own "jump to this text" action — mirrors
	 *  `gotoMatch` above exactly (same DOM lookup, same comment-popover
	 *  open), just entered from a panel row instead of a search step. */
	const jumpToAnnotation = (span: AnnotationSpan) => {
		setSidePanel(null);
		switchMode('preview');
		setHighlightedAnnotationId(span.kind === 'alt' ? span.id : null);
		window.requestAnimationFrame(() => {
			const el = contentRef.current?.querySelector(`[data-loom-annotation-content="${span.id}"]`);
			if (!(el instanceof HTMLElement)) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			if (span.kind === 'comment') annotations.handleOpenComment(span.id, el.getBoundingClientRect());
		});
	};

	const toggleActCollapsed = (id: string) => {
		setCollapsedActs((cur) => {
			const next = new Set(cur);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<ViewShell
			view={view}
			project={project}
			title={`${project.name} — ${bookLabel()}`}
			railActive="book"
			tutorialPage="doc"
			titleExtra={
				<span className="loom-writer-stat">
					{acts.length} · {plugin.indexer.getAll('chapter', project.root).length}
				</span>
			}
		>
			<div className="loom-writer-layout">
				<div className="loom-writer-main" ref={contentRef}>
					<div className="loom-writer-tabs" ref={tabsRef}>
						{mode !== 'outline' ? (
							<>
								<SearchNav
									placeholder={t('project.common.searchPlaceholder')}
									query={query}
									onQuery={(q) => {
										setQuery(q);
										setMatchIndex(0);
									}}
									onEnter={(e) => {
										// Plain page text (`window.find()`, unaffected by the
										// comment/alt-text match list below — this searches the
										// rendered page directly, which comment bodies/alt-text
										// options never appear in). Shift+Enter searches backward.
										(window as unknown as { find?: (s: string, _cs?: boolean, backwards?: boolean) => boolean }).find?.(
											query,
											false,
											e.shiftKey
										);
									}}
									matchCount={bookMatches.length}
									onPrev={() => gotoMatch(matchIndex - 1)}
									onNext={() => gotoMatch(matchIndex + 1)}
								/>
								<AnnotationPanelToggles open={sidePanel === 'nav' ? null : sidePanel} onToggle={setSidePanel} />
							</>
						) : (
							// Outline's way back: Preview on the left, Outline on the right.
							<button className="loom-writer-outline-btn" onClick={() => switchMode('preview')}>
								{t('view.entity.script.preview')}
							</button>
						)}
						{mode !== 'outline' ? (
							<MatchStat query={query} count={bookMatches.length} index={matchIndex} />
						) : null}
						<div className="loom-shell-spacer" />
						{/* Preview is the sole read-only reading view now — this is the
						    one remaining toggle, swapping in the act/chapter
						    drag-reorder tree instead. Sits to the LEFT of the
						    creation-button group below, not on the far right — those
						    own that slot. */}
						{tutOutlineCue ? <StartCue side="right" text={tutOutlineCue} /> : null}
						<button
							className={mode === 'outline' ? 'loom-writer-outline-btn loom-seg-on' : 'loom-writer-outline-btn'}
							onClick={() => switchMode('outline')}
							data-tutorial-target={tutOutlineCue ? '' : undefined}
						>
							{t('view.entity.script.outline')}
						</button>
						<button
							className="loom-rel-add"
							onClick={() => new CreateEntityModal(plugin, 'chapter', project, {}).open()}
						>
							{t('view.entity.script.newChapterAction')}
						</button>
						<div className="loom-start-anchor">
							<button
								className="loom-rel-add"
								onClick={() => new CreateEntityModal(plugin, 'act', project, {}).open()}
								data-tutorial-target={tutNewAct ? '' : undefined}
							>
								{t('project.newActStub')}
							</button>
							{tutNewAct ? (
								<StartCue above text={acts.length === 0 ? t('tutorial.createFirstAct') : t('tutorial.createOrOpenAct')} />
							) : null}
						</div>
						{/* Page breaks are an Outline-only concept — the Editor already
						    writes a bare `===` by hand, and this button exists so a
						    manually-placed one isn't the only way onto the drag list.
						    Mirrors Script's own row (script-view.tsx). */}
						{mode === 'outline' ? (
							<button className="loom-rel-add" onClick={() => queueBookEdit((raw) => appendBookPageBreak(raw))}>
								{t('view.script.newPageBreakAction')}
							</button>
						) : null}
					</div>
					{mode === 'outline' ? (
						<div
							className={seqDrag ? 'loom-subloc-list loom-subloc-dragging loom-writer-outline' : 'loom-subloc-list loom-writer-outline'}
							data-tutorial-target={tutTable ? '' : undefined}
						>
							{/* No acts: nothing but the cue under "+ New act". */}
							{topLevelRows.length === 0 ? null : (
								topLevelRows.map((row, i) => {
									const grabbed = seqDrag?.group === 'book-top-level' && seqDrag.from === i;
									if (row.kind === 'page-break') {
										return (
											<div
												key={row.id}
												className={
													grabbed
														? 'loom-writer-outline-pagebreak loom-subloc-row-slide loom-subloc-row-dragging'
														: 'loom-writer-outline-pagebreak loom-subloc-row-slide'
												}
												style={seqRowStyle('book-top-level', i)}
												data-seq-row=""
												// Right-click only — deleting a page break isn't
												// destructive enough for a confirm modal (one line,
												// trivially retyped), mirrors Script's own row.
												onContextMenu={(e) => {
													e.preventDefault();
													const menu = new Menu();
													menu.addItem((item) =>
														item
															.setTitle(t('project.common.delete'))
															.setIcon('trash-2')
															.setWarning(true)
															.onClick(() => queueBookEdit((raw) => removeBookPageBreak(raw, row.id)))
													);
													menu.showAtMouseEvent(e.nativeEvent);
												}}
											>
												<div className="loom-writer-outline-row">
													{seqGrip('book-top-level', i, topLevelRows, (reordered) => {
														queueBookEdit((raw) => reorderBookTopLevelEntries(raw, reordered.map((r) => r.id)));
													})}
													<span className="loom-row-caret" aria-hidden="true" />
													<span className="loom-writer-outline-pagebreak-label">
														<Icon name="separator-horizontal" /> {t('view.script.pageBreakLabel')}
													</span>
													<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
													<span className="loom-writer-row-count">
														{t('view.entity.script.pageAbbrev', { range: String(pageOfLine(row.line) + 1) })}
													</span>
												</div>
											</div>
										);
									}
									const act = row.act;
									const chapters = chaptersOf(act);
									const collapsed = collapsedActs.has(act.actId);
									const page = pageOfLine(row.line);
									return (
										<div
											key={act.path}
											className="loom-writer-outline-act"
											data-act-id={act.actId}
											data-seq-row=""
											style={seqRowStyle('book-top-level', i)}
										>
											<div className={grabbed ? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging' : 'loom-writer-outline-row loom-subloc-row-slide'}>
												{seqGrip('book-top-level', i, topLevelRows, (reordered) => {
													queueBookEdit((raw) => reorderBookTopLevelEntries(raw, reordered.map((r) => r.id)));
												})}
												{chapters.length > 0 ? (
													<button
														className="loom-row-caret"
														aria-label={collapsed ? t('view.script.expandChaptersAria') : t('view.script.collapseChaptersAria')}
														onClick={() => toggleActCollapsed(act.actId)}
													>
														<span className={collapsed ? 'loom-caret' : 'loom-caret loom-caret-open'}>▸</span>
													</button>
												) : (
													<span className="loom-row-caret" aria-hidden="true" />
												)}
												<button className="loom-subloc-link" onClick={() => view.openEntity(act.path)}>
													{act.name}
												</button>
												<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
												<span className="loom-writer-row-count">
													{chapters.length} · {t('view.entity.script.pageAbbrev', { range: String(page) })}
												</span>
											</div>
											{!collapsed ? (
												<div className="loom-writer-outline-children">
													{chapters.length === 0 ? (
														<EmptyActMessage plugin={plugin} project={project ?? null} act={act} type="chapter" />
													) : (
														chapters.map((ch, j) => {
															const chGrabbed = seqDrag?.group === `book-chapters:${act.actId}` && seqDrag.from === j;
															return (
																<div
																	key={ch.path}
																	className={chGrabbed ? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging' : 'loom-writer-outline-row loom-subloc-row-slide'}
																	style={seqRowStyle(`book-chapters:${act.actId}`, j)}
																	data-seq-row=""
																>
																	{seqGrip(`book-chapters:${act.actId}`, j, chapters, (reordered) => {
																		queueBookEdit((raw) =>
																			reorderBookChaptersInAct(raw, act.actId, reordered.map((c) => c.chapterId))
																		);
																	})}
																	<span className="loom-writer-row-num">{j + 1}</span>
																	<button className="loom-subloc-link" onClick={() => view.openEntity(ch.path)}>
																		{ch.name}
																	</button>
																	<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
																	<span className="loom-writer-row-count">
																		{t('view.entity.script.pageAbbrev', { range: String(page) })}
																	</span>
																</div>
															);
														})
													)}
												</div>
											) : null}
										</div>
									);
								})
							)}
						</div>
					) : (
						<div className="loom-screenplay" ref={previewWrapperRef}>
							<BookSidePanels
								panel={sidePanel}
								setPanel={setSidePanel}
								scrollKey={file ? `loom-book-nav-scroll:${file.path}` : undefined}
								acts={acts}
								chaptersOf={chaptersOf}
								scroller={previewWrapperRef}
								commentRows={unresolvedCommentRowsList}
								altRows={undecidedAltRowsList}
								onJumpAnnotation={jumpToAnnotation}
							/>
							{acts.length === 0 ? (
								<div className="loom-writer-empty">{t('view.script.noActsYet')}</div>
							) : (
								previewPageGroups.map((group, gi) => (
									<div className="loom-book-page" key={gi}>
										{group.map((act) => (
											<div key={act.path} className="loom-field loom-field-sep" data-book-act={act.actId}>
												<span className="loom-field-label">
													{/* Plain, non-interactive text — see `ActChapterBlocks`'s own
													    chapter-title span for the full reasoning. */}
													<span className="loom-subloc-link">{act.name}</span>
												</span>
												<ActChapterBlocks
													plugin={plugin}
													bookText={bookText}
													chapters={chaptersOf(act)}
													names={linkNames}
													linkLabels={linkLabels}
													onOpenLink={openLinkTarget}
													emptyMessage={null}
													annotations={annotations}
													highlightedAnnotationId={highlightedAnnotationId}
													onOpenChapter={openThisChapterFromBook}
												/>
											</div>
										))}
									</div>
								))
							)}
						</div>
					)}
					{actlessChapters.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{t('view.script.chaptersWithoutAct')}</span>
							<div className="loom-tag-row">
								{actlessChapters.map((ch) => (
									<button key={ch.path} className="loom-chip" onClick={() => view.openEntity(ch.path)}>
										{ch.name}
									</button>
								))}
							</div>
							<span className="loom-field-hint">{t('view.script.chaptersWithoutActHint')}</span>
						</div>
					) : null}
					{orphans.acts.length > 0 || orphans.chapters.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{t('view.script.chaptersNoLongerInBook')}</span>
							<div className="loom-tag-row">
								{[...orphans.acts, ...orphans.chapters].map((r) => (
									<button key={r.path} className="loom-chip" onClick={() => view.openEntity(r.path)}>
										{r.name}
									</button>
								))}
							</div>
							<span className="loom-field-hint">{t('view.script.chaptersNoLongerHint')}</span>
						</div>
					) : null}
				</div>
			</div>
			{annotations.openComment ? (
				<CommentPopover
					anchorRect={annotations.openComment.rect}
					entries={annotations.comments[annotations.openComment.id] ?? []}
					onSaveEntry={(index, text) => annotations.handleSaveCommentEntry(annotations.openComment!.id, index, text)}
					onToggleResolvedEntry={(index) => annotations.handleToggleCommentResolved(annotations.openComment!.id, index)}
					onDeleteEntry={(index) => annotations.handleDeleteCommentEntry(annotations.openComment!.id, index)}
					onAddEntry={(text) => annotations.handleAddCommentReply(annotations.openComment!.id, text)}
					onClose={annotations.handleCloseComment}
				/>
			) : null}
		</ViewShell>
	);
}
