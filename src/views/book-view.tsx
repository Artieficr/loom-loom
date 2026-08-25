import { Menu, normalizePath, TFile } from 'obsidian';
import { CSSProperties, ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
	BOOK_EXTENSION,
	BOOK_ICON,
	EntityRecord,
	FM,
	VIEW_PROSE,
	bookLabel,
	pcGroupStub,
} from '../types';
import {
	ParsedBook,
	appendBookAct,
	appendBookChapter,
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
import {
	AltTextModal,
	CreateEntityModal,
	TextInputModal,
	createEntity,
	entityFileName,
	purgeEntityReferences,
} from '../project';
import { LoomFileReactView } from './react-view';
import { MarkdownField } from './markdown-field';
import {
	Icon,
	ViewShell,
	buildEntityLinkNames,
	buildLinkTargetLabels,
	openEntityLink,
} from './common';
import { useIndexVersion } from './hooks';
import { t } from '../i18n';
import { AnnotationSpan, cleanAnnotationMarkers, findAnnotationSpans, liveAnnotationIds } from '../fountain';
import {
	AltTextEntry,
	CommentEntry,
	mutateScriptNotes,
	undecidedAltRows,
	unresolvedCommentRows,
	useScriptNotes,
} from './script-notes';
import { AlternativesBrowserPanel, CommentPopover, CommentsBrowserPanel } from './annotation-popover';
import type { LinkOption } from './link-textarea';
import type LoomLoomPlugin from '../main';

/**
 * The project's Book: `<root>/<Project>.loomprose`, registered like the
 * .loom home file rather than stored as markdown — same reason Fountain
 * can't be: the hidden `[[loom:<id>]]` section markers would otherwise
 * pollute Obsidian's wikilink index. Mirrors `scriptFilePath`.
 */
export function bookFilePath(project: ProjectDef): string {
	const base = `${project.name}.${BOOK_EXTENSION}`;
	return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
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

/** Appends a new, empty Act to the Book, creating the file first if it
 *  doesn't exist yet — the "+ New act" affordance in a Prose project goes
 *  through this rather than assuming the file is already there. */
export async function appendActToBook(plugin: LoomLoomPlugin, project: ProjectDef, title: string): Promise<void> {
	const file = await createBookFile(plugin, project);
	const raw = await plugin.app.vault.read(file);
	await plugin.app.vault.modify(file, appendBookAct(raw, title));
}

/** Appends a new, empty Chapter to the very end of the Book, creating the
 *  file first if it doesn't exist yet — mirrors `appendActToBook`. Lands
 *  inside whichever act is last (or actless), same as `appendBookChapter`
 *  itself; the Chapter creation modal moves it under the picked act
 *  afterward via `moveBookChapterToAct`. */
export async function appendChapterToBook(plugin: LoomLoomPlugin, project: ProjectDef, title: string): Promise<void> {
	const file = await createBookFile(plugin, project);
	const raw = await plugin.app.vault.read(file);
	await plugin.app.vault.modify(file, appendBookChapter(raw, title));
}

/** Serializes every `editBook` call against the same project's Book file —
 *  same fix, same reasoning as `editScript`'s own `scriptWriteQueues`
 *  (script-view.tsx): `replaceAltContentInBook`/`stripAnnotationMarkerInBook`
 *  call `editBookAndSync` straight from an icon click, bypassing
 *  `queueBookEdit` entirely (that queue only ever covered the Editor field's
 *  own buffered draft and Outline's reorders), so two overlapping calls
 *  could each read the file before the other's write landed and silently
 *  lose one of them — the confirmed real cause of a reported "both alt-text
 *  options turned into the same text" data-loss bug from rapid clicking. */
const bookWriteQueues = new Map<string, Promise<unknown>>();

/**
 * Applies a change to the project's Book file. Mirrors `editScript`.
 */
export async function editBook(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	const path = bookFilePath(project);
	const run = (bookWriteQueues.get(path) ?? Promise.resolve()).then(async () => {
		const file = findBookFile(plugin, project);
		if (!file) return false;
		try {
			const raw = await plugin.app.vault.read(file);
			const next = apply(raw);
			if (next === null || next === raw) return false;
			await plugin.app.vault.modify(file, next);
			return true;
		} catch (e) {
			console.error('Loom Loom: could not edit the book', e);
			return false;
		}
	});
	bookWriteQueues.set(
		path,
		run.catch(() => {})
	);
	return run;
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
						const base = entityFileName(project, 'act', act.title);
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
		const created = await createEntity(plugin, project, 'act', {
			name: act.title,
			tag: '',
			date: '',
			description: '',
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
				const base = entityFileName(project, 'chapter', chapter.title);
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
		const created = await createEntity(plugin, project, 'chapter', {
			name: chapter.title,
			tag: '',
			date: '',
			description: '',
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
			// Prune the sidecar of any comment/alt-text entry whose marker id
			// is no longer backed by a live pair in the text that just
			// landed — mirrors `runCommit`'s identical prune. Without this,
			// Book never garbage-collected orphaned sidecar entries the way
			// Script does (deleting a commented/alt-texted span needs no
			// special handling of its own; this is what actually clears the
			// now-orphaned sidecar data out afterward).
			const liveIds = liveAnnotationIds(raw);
			void mutateScriptNotes(plugin.app, project, (notes) => {
				let touched = false;
				const comments = { ...notes.comments };
				for (const id of Object.keys(comments)) {
					if (!liveIds.has(id)) {
						delete comments[id];
						touched = true;
					}
				}
				const altText = { ...notes.altText };
				for (const id of Object.keys(altText)) {
					if (!liveIds.has(id)) {
						delete altText[id];
						touched = true;
					}
				}
				return touched ? { ...notes, comments, altText } : notes;
			});
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
		const chapters = plugin.indexer
			.getAll('chapter', record.project)
			.filter(
				(ch) =>
					ch.chapterAct !== '' &&
					plugin.indexer.resolve(ch.chapterAct, ch.path)?.path === record.path
			);
		await editBook(plugin, project, (raw) => removeBookAct(raw, actId));
		for (const ch of chapters) {
			const f = plugin.app.vault.getFileByPath(ch.path);
			if (!f) continue;
			await purgeEntityReferences(plugin, ch.path, ch.project);
			await plugin.app.fileManager.trashFile(f);
		}
	}
	const file = plugin.app.vault.getFileByPath(record.path);
	if (!file) return;
	await purgeEntityReferences(plugin, record.path, record.project);
	await plugin.app.fileManager.trashFile(file);
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
 *  path — mirrors `useScriptText`. Shared by the Chapter/Act pages' own
 *  Editor sections and `BookView` itself. */
export function useBookText(plugin: LoomLoomPlugin, project: ProjectDef | null): string | null {
	const [text, setText] = useState<string | null>(null);
	const path = project ? bookFilePath(project) : null;
	useEffect(() => {
		if (path === null) return;
		let cancelled = false;
		const read = () => {
			const file = plugin.app.vault.getFileByPath(path);
			if (!file) {
				setText(null);
				return;
			}
			// `vault.read`, never `cachedRead` — same fix, same reasoning as
			// `script-view.tsx`'s own `useScriptText` (a real, confirmed bug:
			// a just-landed write's own 'modify' event can fire before
			// Obsidian's read cache has caught up with it, so a just-written
			// alt-text swap silently looked reverted here too).
			void plugin.app.vault.read(file).then((raw) => {
				if (!cancelled) setText(raw);
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
	return text;
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

/** Reads an alt-text span's CURRENT live text straight off disk — the
 *  Book-level analogue of `script-view.tsx`'s own `liveAltSpanText`, which
 *  reads it from React state instead (Script keeps the whole document in
 *  memory; Book doesn't have an equivalent single source, since a span could
 *  sit in any chapter's own text). Used only to catch a hand-edit to the
 *  active option that hasn't reached the sidecar yet before a swap would
 *  otherwise discard it — see `syncOutgoingBookAltOption`. */
async function liveBookAltSpanText(plugin: LoomLoomPlugin, project: ProjectDef, id: string): Promise<string | null> {
	const file = findBookFile(plugin, project);
	if (!file) return null;
	// `handleOpenAltMenu` awaits this before opening `AltTextModal` at all —
	// a transient read failure (e.g. the file vanishing between
	// `findBookFile` and the read, on a syncing vault) must not leave the
	// modal permanently unopenable; falling back to `null` here just means
	// the caller's own `syncOutgoingBookAltOption` no-ops and shows the
	// sidecar's last-known text instead, same as before this sync existed.
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

/** Rewrites `entry`'s OUTGOING (currently active) option to match
 *  `outgoingLiveText` when it differs — the Book-level analogue of
 *  `script-view.tsx`'s own `syncOutgoingAltOption`. Without this, a hand-edit
 *  typed directly into the active option's text (the normal way to revise
 *  one — see fountain.ts's own architecture note) never reaches the sidecar:
 *  switching to a different option and back later would silently revert the
 *  edit, restoring the STALE text the sidecar last remembered instead of
 *  what was actually left on the page. */
function syncOutgoingBookAltOption(entry: AltTextEntry, outgoingLiveText: string | null): AltTextEntry {
	if (outgoingLiveText === null || outgoingLiveText === entry.options[entry.activeIndex]) return entry;
	const options = entry.options.slice();
	options[entry.activeIndex] = outgoingLiveText;
	return { ...entry, options };
}

/**
 * Comments/alternative-text data + handlers for the Book, shared by the
 * Chapter/Act entity page sections and `BookView` itself — one hook rather
 * than three copies of the same `mutateScriptNotes` plumbing.
 *
 * Reuses `script-notes.ts`'s sidecar AS-IS, same file
 * (`Entities/Script Notes/<Project> Script Notes.json`) a Script project
 * would use — confirmed keyed only by project + marker-id strings, no
 * Fountain/extension coupling, and Script/Prose are mutually exclusive per
 * project so there's no collision risk. A second, Book-only sidecar file
 * would be pure duplication for no isolation benefit.
 */
export function useBookAnnotations(plugin: LoomLoomPlugin, project: ProjectDef | null) {
	const scriptNotes = useScriptNotes(plugin, project);
	const [openComment, setOpenComment] = useState<{ id: string; rect: DOMRect } | null>(null);
	/** Marker ids that have had a reply added THIS session — mirrors
	 *  `script-view.tsx`'s own `commentsWithNewEntryRef`: `scriptNotes` only
	 *  catches up once the sidecar's `vault.modify` + file-watch round trip
	 *  completes, so `handleCloseComment` below checks this instead of
	 *  trusting `scriptNotes.comments[id]` alone, which could still read
	 *  stale-empty for a reply added moments ago. */
	const commentsWithNewEntryRef = useRef<Set<string>>(new Set());

	/** `openComment.rect` is a one-time snapshot — without this, scrolling
	 *  whichever Book/Act/Chapter surface is open left the popover floating
	 *  in the same screen spot while the commented text scrolled out from
	 *  under it. Mirrors `script-view.tsx`'s own copy of this effect, but
	 *  this hook has no single known container ref of its own (it's shared
	 *  identically by Book and the Act/Chapter sections, each with their own
	 *  wrapper DOM) — queries `document` for the icon directly and falls back
	 *  to a plain viewport-visibility check in place of a specific scroll
	 *  container's bounds. */
	useEffect(() => {
		if (!openComment) return;
		const id = openComment.id;
		const track = () => {
			const icon = document.querySelector(`[data-loom-annotation-id="${id}"]`);
			if (!(icon instanceof HTMLElement)) {
				setOpenComment(null);
				return;
			}
			const rect = icon.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > window.innerHeight) {
				setOpenComment(null);
				return;
			}
			setOpenComment((prev) => (prev && prev.id === id ? { id, rect } : prev));
		};
		document.addEventListener('scroll', track, true);
		return () => document.removeEventListener('scroll', track, true);
	}, [openComment?.id]);

	/** A new comment marker was just inserted — mirrors `script-view.tsx`'s
	 *  own `handleCreateComment` exactly: writes NOTHING to the sidecar.
	 *  `MarkdownField`'s own `insertMarkerPair` (markdown-field.tsx) already
	 *  opens the popover on its own right after calling this; the FIRST real
	 *  `CommentEntry` only gets created once the user actually types a reply
	 *  and submits (`handleAddCommentReply`, below), same as every reply
	 *  after it. This used to pre-create an EMPTY entry here, which made the
	 *  popover open showing an "existing" (blank) comment to edit instead of
	 *  a clean compose box — the exact bug this now avoids. */
	const handleCreateComment = (_id: string) => {};

	/** A new alt-text marker was just inserted, wrapping the selection as
	 *  option 0. Immediately prompts for a SECOND option via `TextInputModal`
	 *  — mirrors `script-view.tsx`'s own `handleCreateAlt` exactly (same "the
	 *  menu item that created this should open something to type into"
	 *  expectation), the same modal the right-click picker's own "Add
	 *  alternative…" uses. Cancelling backs the WHOLE creation out, same as
	 *  Script: drops the sidecar entry AND strips the just-inserted marker
	 *  pair (`stripAnnotationMarkerInBook`), rather than leaving it behind as
	 *  a dead, uninteractive span. */
	const handleCreateAlt = (id: string, selectedText: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => ({
			...file,
			altText: { ...file.altText, [id]: { id, options: [selectedText], activeIndex: 0, acceptedIndex: null } },
		}));
		new TextInputModal(plugin.app, {
			title: t('view.entity.altText.addWordingTitle'),
			placeholder: selectedText,
			cta: t('project.common.add'),
			multiline: true,
			onSubmit: (value) => {
				if (!project) return;
				void mutateScriptNotes(plugin.app, project, (file) => {
					const cur = file.altText[id];
					if (!cur) return file;
					return { ...file, altText: { ...file.altText, [id]: { ...cur, options: [...cur.options, value] } } };
				});
			},
			onCancel: () => {
				if (!project) return;
				void mutateScriptNotes(plugin.app, project, (file) => {
					const { [id]: _dropped, ...rest } = file.altText;
					return { ...file, altText: rest };
				}).then(() => stripAnnotationMarkerInBook(plugin, project, id));
			},
		}).open();
	};

	const handleOpenComment = (id: string, rect: DOMRect) => setOpenComment({ id, rect });

	/** Closing the popover with nothing ever added to the thread abandons the
	 *  whole comment creation, mirroring `handleCreateAlt`'s own cancel and
	 *  `script-view.tsx`'s own `handleCloseComment` exactly — a freshly
	 *  inserted marker pair backed by no `comments[id]` entry (only
	 *  `handleAddCommentReply` ever creates one) would otherwise sit in the
	 *  document forever as a permanently-unresolved, un-openable orphan span.
	 *  Checks BOTH `scriptNotes` (an existing comment, reopened) and
	 *  `commentsWithNewEntryRef` (a reply just added this session, ahead of
	 *  the sidecar's own async round trip) — only when neither shows a reply
	 *  does the span get torn back out. */
	const handleCloseComment = () => {
		if (
			project &&
			openComment &&
			!commentsWithNewEntryRef.current.has(openComment.id) &&
			!scriptNotes.comments[openComment.id]
		) {
			void stripAnnotationMarkerInBook(plugin, project, openComment.id);
		}
		setOpenComment(null);
	};

	const handleSaveCommentEntry = (id: string, index: number, text: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entries = file.comments[id];
			if (!entries?.[index]) return file;
			const next = [...entries];
			next[index] = { ...next[index], text, updatedAt: Date.now() };
			return { ...file, comments: { ...file.comments, [id]: next } };
		});
	};

	const handleToggleCommentResolved = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entries = file.comments[id];
			if (!entries?.[index]) return file;
			const next = [...entries];
			const resolved = !next[index].resolved;
			next[index] = { ...next[index], resolved, resolvedAt: resolved ? Date.now() : null };
			return { ...file, comments: { ...file.comments, [id]: next } };
		});
	};

	/** Removes ONE reply from the thread — if that empties it, the whole
	 *  `comments[id]` key goes too (an empty thread is the same as none), AND
	 *  the marker pair itself has to come out of the document — mirrors
	 *  `script-view.tsx`'s own `handleDeleteCommentEntry` exactly; otherwise
	 *  an orphaned marker with no sidecar data behind it keeps rendering as a
	 *  live (permanently "unresolved," since there's nothing to check "all
	 *  resolved" against) span with no way to open it back up. */
	const handleDeleteCommentEntry = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entries = file.comments[id];
			if (!entries) return file;
			const next = entries.filter((_, i) => i !== index);
			const comments = { ...file.comments };
			if (next.length === 0) delete comments[id];
			else comments[id] = next;
			return { ...file, comments };
		}).then((next) => {
			if (!next.comments[id]) {
				void stripAnnotationMarkerInBook(plugin, project, id);
				// The marker pair (and so the whole span) is gone — a reply
				// typed into the now-empty popover's box would have nothing
				// left in the document to attach to, so close it rather than
				// leave a dead end.
				setOpenComment((prev) => (prev && prev.id === id ? null : prev));
			}
		});
	};

	const handleAddCommentReply = (id: string, text: string) => {
		if (!project) return;
		commentsWithNewEntryRef.current.add(id);
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entries = file.comments[id] ?? [];
			const entry: CommentEntry = { id, text, resolved: false, createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null };
			return { ...file, comments: { ...file.comments, [id]: [...entries, entry] } };
		});
	};

	/** The click already swapped the document (`markdown-field.tsx`'s own
	 *  mousedown handler, which has direct access to its own live view) —
	 *  this persists the sidecar's `activeIndex`, but first reconciles
	 *  `outgoingLiveText` (the OUTGOING option's actual live document text,
	 *  read by `cycleAltInPlace` right before the swap overwrote it) against
	 *  the sidecar's own stored copy for that option — a hand-edit typed
	 *  straight into the active option (the normal way to edit one, per this
	 *  feature's own architecture note) would otherwise be silently discarded
	 *  the moment cycling swaps away from it, since the sidecar never saw it.
	 *  Mirrors `script-view.tsx`'s own `syncOutgoingAltOption`. */
	const handleCycleAlt = (id: string, outgoingLiveText: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entry = file.altText[id];
			if (!entry || entry.options.length < 2) return file;
			const options =
				outgoingLiveText !== entry.options[entry.activeIndex]
					? entry.options.map((opt, i) => (i === entry.activeIndex ? outgoingLiveText : opt))
					: entry.options;
			const activeIndex = (entry.activeIndex + 1) % options.length;
			return { ...file, altText: { ...file.altText, [id]: { ...entry, options, activeIndex, acceptedIndex: null } } };
		});
	};

	/** `ActChapterBlocks`'s own read-only cycle: `handleCycleAlt` above
	 *  assumes the caller's own field already committed the swap to disk —
	 *  true for the buffered/per-keystroke-committing Editor and Chapter
	 *  fields, false for a read-only field (`onChange` is a no-op there, so
	 *  nothing writes the sidecar's chosen text back into the document by
	 *  itself). Mirrors `handleOpenAltMenu`'s own already-correct shape
	 *  instead: write the sidecar, then explicitly call
	 *  `replaceAltContentInBook` to apply the swap. **Deliberately ignores
	 *  the `outgoingLiveText` parameter `cycleAltInPlace` (markdown-field.tsx)
	 *  passes** — a real, reported bug this fixes: a read-only field's own
	 *  doc is a downstream MIRROR of disk, never a live typing buffer (there
	 *  is nothing to hand-edit in `readOnly` mode), so it can lag behind the
	 *  PREVIOUS cycle's own write by the time a second click lands. The
	 *  earlier version compared `outgoingLiveText` against the stored option
	 *  and treated any mismatch as a hand-edit worth preserving — but a
	 *  mismatch here only ever meant "this field hasn't caught up yet,"
	 *  and preserving it overwrote a DIFFERENT (not-yet-displayed) option's
	 *  real text with stale wording, collapsing two options to the same
	 *  string after a couple of quick clicks. Always trusting the sidecar's
	 *  own stored text (never comparing against the field) is correct here:
	 *  there is no other source of truth a read-only field could diverge
	 *  from. */
	const handleCycleAltReadOnly = (id: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entry = file.altText[id];
			if (!entry || entry.options.length < 2) return file;
			const activeIndex = (entry.activeIndex + 1) % entry.options.length;
			return { ...file, altText: { ...file.altText, [id]: { ...entry, activeIndex, acceptedIndex: null } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) void replaceAltContentInBook(plugin, project, id, cur.options[cur.activeIndex]);
		});
	};

	const handleOpenAltMenu = (id: string) => {
		if (!project) return;
		const entry0 = scriptNotes.altText[id];
		if (!entry0) return;
		void (async () => {
			// The active option's wording is ordinarily edited by hand directly
			// in the text, not through this modal — read it back off disk once,
			// up front, so a not-yet-persisted hand-edit is what the modal shows
			// and acts on rather than the sidecar's own possibly-stale copy. Not
			// re-read per callback below (Script's own `syncOutgoingAltOption`
			// can, cheaply, off React state already held in memory; Book has no
			// such state and a per-click vault read isn't worth it for a modal
			// that's normally acted on once) — same "essentially never happens
			// in practice" race every other Book alt-text write already accepts.
			const outgoingLiveText = await liveBookAltSpanText(plugin, project, id);
			const entry = syncOutgoingBookAltOption(entry0, outgoingLiveText);
			new AltTextModal(plugin.app, {
				options: entry.options,
				activeIndex: entry.activeIndex,
				acceptedIndex: entry.acceptedIndex,
				onDraft: (index) => {
					void mutateScriptNotes(plugin.app, project, (file) => {
						const e = file.altText[id];
						if (!e) return file;
						const s = syncOutgoingBookAltOption(e, outgoingLiveText);
						return { ...file, altText: { ...file.altText, [id]: { ...s, activeIndex: index, acceptedIndex: null } } };
					});
					void replaceAltContentInBook(plugin, project, id, entry.options[index]);
				},
				onAccept: (index) => {
					void mutateScriptNotes(plugin.app, project, (file) => {
						const e = file.altText[id];
						if (!e) return file;
						const s = syncOutgoingBookAltOption(e, outgoingLiveText);
						return { ...file, altText: { ...file.altText, [id]: { ...s, activeIndex: index, acceptedIndex: index } } };
					});
					void replaceAltContentInBook(plugin, project, id, entry.options[index]);
				},
				onEditOption: (index, newText) => {
					void mutateScriptNotes(plugin.app, project, (file) => {
						const e = file.altText[id];
						if (!e) return file;
						const options = [...e.options];
						options[index] = newText;
						return { ...file, altText: { ...file.altText, [id]: { ...e, options } } };
					});
					if (index === entry.activeIndex) void replaceAltContentInBook(plugin, project, id, newText);
				},
				onAddOption: (text) => {
					void mutateScriptNotes(plugin.app, project, (file) => {
						const e = file.altText[id];
						if (!e) return file;
						return { ...file, altText: { ...file.altText, [id]: { ...e, options: [...e.options, text] } } };
					});
				},
				// Deleting down to exactly one remaining option is a real action,
				// not just another edit — mirrors `script-view.tsx`'s own
				// `handleDeleteAltOption` exactly: an alt-text span with a single
				// option has nothing left to alternate BETWEEN, so (same as a
				// comment thread's own "delete the last reply strips the
				// markers" behavior) the whole `[[loom-alt:<id>]]` wrapper comes
				// OUT of the document, leaving the survivor's wording as ordinary
				// text, and the sidecar entry is dropped entirely rather than
				// left describing a permanently single-option span. `undefined`
				// tells `AltTextModal` to close itself — there's nothing left for
				// it to show.
				onDeleteOption: async (index) => {
					if (entry.options.length <= 1) return undefined;
					const options = entry.options.filter((_, i) => i !== index);
					if (options.length <= 1) {
						const survivor = options[0] ?? '';
						await mutateScriptNotes(plugin.app, project, (file) => {
							const { [id]: _dropped, ...rest } = file.altText;
							return { ...file, altText: rest };
						});
						// The surviving option's text has to actually BE the live
						// document content before the wrapper markers come out, or
						// stripping would leave whichever text happened to be
						// active (possibly the just-deleted option's) instead of
						// the survivor's.
						await replaceAltContentInBook(plugin, project, id, survivor);
						await stripAnnotationMarkerInBook(plugin, project, id);
						return undefined;
					}
					let activeIndex = entry.activeIndex;
					let acceptedIndex = entry.acceptedIndex;
					if (index === activeIndex) activeIndex = Math.min(activeIndex, options.length - 1);
					else if (index < activeIndex) activeIndex -= 1;
					if (acceptedIndex !== null) {
						if (index === acceptedIndex) acceptedIndex = null;
						else if (index < acceptedIndex) acceptedIndex -= 1;
					}
					await mutateScriptNotes(plugin.app, project, (file) => {
						const e = file.altText[id];
						if (!e) return file;
						return { ...file, altText: { ...file.altText, [id]: { id, options, activeIndex, acceptedIndex } } };
					});
					if (index === entry.activeIndex) void replaceAltContentInBook(plugin, project, id, options[activeIndex] ?? '');
					return { options, activeIndex, acceptedIndex };
				},
			}).open();
		})();
	};

	return {
		comments: scriptNotes.comments,
		altText: scriptNotes.altText,
		openComment,
		handleCreateComment,
		handleCreateAlt,
		handleOpenComment,
		handleCloseComment,
		handleSaveCommentEntry,
		handleToggleCommentResolved,
		handleDeleteCommentEntry,
		handleAddCommentReply,
		handleCycleAlt,
		handleCycleAltReadOnly,
		handleOpenAltMenu,
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
	emptyMessage: ReactElement;
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
	if (chapters.length === 0) return emptyMessage;
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

	getDisplayText(): string {
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
function Book({ view }: { view: BookView }): ReactElement {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
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
	/** A real, confirmed gap against `script-view.tsx`'s own `commit` (see
	 *  that function's doc comment — this is a straight port of its `.catch`
	 *  reasoning, which this file never had): without swallowing a failed
	 *  run's rejection ON THE QUEUE ITSELF, `bookCommitQueueRef.current`
	 *  stays a REJECTED promise the moment any single `editBookAndSync` call
	 *  throws (e.g. `processFrontMatter` racing another write) — and since
	 *  `.then()` on an already-rejected promise never runs its callback, that
	 *  one failure would silently wedge EVERY edit queued after it for the
	 *  rest of this `Book` component's lifetime, with nothing visible to the
	 *  user beyond "my edits stopped landing." Outline's own reorders are the
	 *  only thing still going through this queue. */
	const queueBookEdit = (apply: (text: string) => string | null) => {
		if (!project) return;
		const run = bookCommitQueueRef.current.then(() => editBookAndSync(plugin, project, apply));
		bookCommitQueueRef.current = run.catch((e) => {
			console.error('Loom Loom: could not commit a book edit', e);
		});
	};

	const [mode, setMode] = useState<'preview' | 'outline'>(() => {
		const saved = file ? window.localStorage.getItem(`loom-book-mode:${file.path}`) : null;
		return saved === 'outline' ? saved : 'preview';
	});
	useEffect(() => {
		if (file) window.localStorage.setItem(`loom-book-mode:${file.path}`, mode);
	}, [file, mode]);
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
	/** Comments/Alternatives browse-all panels — mirrors Script's own
	 *  `openSidePanel` exclusivity (script-view.tsx), just without a 'nav'
	 *  option, since Book has no equivalent overlay nav tree (Outline is a
	 *  whole separate mode here, not a toggled panel). */
	const [sidePanel, setSidePanel] = useState<'comments' | 'alt' | null>(null);

	/** Preview mode's own scroller — mirrors Script's `.loom-screenplay`. */
	const previewWrapperRef = useRef<HTMLDivElement | null>(null);

	/** Scrolls the tabs row into view on every click — mirrors Script's own
	 *  `clickTab`/`clickActTab` (`scrollTabsIntoView`), even a re-click of the
	 *  pane already active, so working in BookView from wherever the page
	 *  happens to be scrolled is one click away. */
	const tabsRef = useRef<HTMLDivElement | null>(null);
	const switchMode = (next: 'preview' | 'outline') => {
		if (next !== mode) setMode(next);
		window.requestAnimationFrame(() => {
			tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	};

	// --- generic loomSeq drag-reorder, mirrors entity-view.tsx's own seqGrip
	// (a third independent copy of this pattern, same as script-view.tsx's
	// `outlineGrip` — this codebase doesn't share it across files, only the
	// shape). Three groups: 'book-top-level' (acts AND page breaks,
	// interleaved) and `book-chapters:<actId>` (one act's own chapters).
	// Generic over the dragged item's own type — neither function below ever
	// reads a field off `records`/`reordered`, just index math — so the SAME
	// pair serves both the `EntityRecord[]` chapter lists and the mixed
	// act/page-break top-level list.
	const [seqDrag, setSeqDrag] = useState<{ group: string; from: number; over: number; dy: number } | null>(null);
	const seqDragRef = useRef<{ startY: number; slot: number; mids: number[] } | null>(null);
	const seqShift = (group: string, i: number): number => {
		if (!seqDrag || seqDrag.group !== group) return 0;
		const { from, over } = seqDrag;
		if (i === from) return 0;
		if (from < i && i <= over) return -1;
		if (over <= i && i < from) return 1;
		return 0;
	};
	const seqRowStyle = (group: string, i: number): CSSProperties | undefined => {
		if (!seqDrag || seqDrag.group !== group) return undefined;
		const slot = seqDragRef.current?.slot ?? 40;
		if (seqDrag.from === i) return { transform: `translateY(${seqDrag.dy}px)`, position: 'relative', zIndex: 2 };
		const sh = seqShift(group, i);
		return sh !== 0 ? { transform: `translateY(${sh * slot}px)` } : undefined;
	};
	const endSeqDrag = <T,>(group: string, records: T[], commit: boolean, onCommit: (reordered: T[]) => void) => {
		seqDragRef.current = null;
		const drag = seqDrag;
		setSeqDrag(null);
		if (!commit || !drag || drag.group !== group || drag.from === drag.over) return;
		const next = [...records];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		onCommit(next);
	};
	const seqGrip = <T,>(group: string, i: number, records: T[], onCommit: (reordered: T[]) => void) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest('[data-seq-row]');
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				const rows = row?.parentElement ? [...row.parentElement.querySelectorAll(':scope > [data-seq-row]')] : [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				seqDragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? 40) + 8, mids };
				setSeqDrag({ group, from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = seqDragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(0, Math.min(records.length - 1, start.mids.filter((m) => m < e.clientY).length));
				setSeqDrag((cur) => (cur && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur));
			}}
			onPointerUp={() => endSeqDrag(group, records, true, onCommit)}
			onPointerCancel={() => endSeqDrag(group, records, false, onCommit)}
		>
			<Icon name="grip-vertical" />
		</span>
	);

	const linkNames = useMemo<LinkOption[]>(
		() => (project ? buildEntityLinkNames(plugin, project) : []),
		[plugin, project]
	);
	const linkLabels = useMemo(
		() => (project ? buildLinkTargetLabels(plugin, project) : new Map<string, string>()),
		[plugin, project]
	);

	const openLinkTarget = (target: string, newTab = false) => {
		if (!file) return;
		openEntityLink(plugin, view, file.path, target, newTab);
	};

	/** Preview's right-click "Open this chapter" (`ActChapterBlocks`'s
	 *  `onOpenChapter`, via `MarkdownField`'s own contextmenu handler) —
	 *  resolves the chapter id to its backing note and hands off the
	 *  clicked position through the exact `localStorage` key the Chapter
	 *  page's own mount-time restore reads (`pendingChapterScrollLineRef`,
	 *  entity-view.tsx — a character offset, not a line, since Chapter's
	 *  field has no line-based `scrollToLine`), mirroring
	 *  `PagesPreviewBody`'s own "Open this scene" (script-view.tsx). `offset`
	 *  is already in the same space Chapter's own page's field uses —
	 *  both render `chapterBookText(bookText, chapterId)` verbatim, with no
	 *  further offset translation the way Fountain's heading-stripped
	 *  excerpts need. */
	const openThisChapter = (chapterId: string, offset: number) => {
		if (!project) return;
		const record = plugin.indexer.getAll('chapter', project.root).find((r) => r.chapterId === chapterId);
		if (!record) return;
		window.localStorage.setItem(`loom-chapter-script-line:${record.path}`, String(offset));
		view.openEntity(record.path);
	};

	if (!project) {
		return <div className="loom-view loom-book-view loom-empty">{t('view.home.loadingProject')}</div>;
	}

	const acts = plugin.indexer
		.getAll('act', project.root)
		.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	// Grouped in ONE pass over every chapter (below), rather than `chaptersOf`
	// re-scanning + re-resolving the whole chapter list per act — this used to
	// run once per act per render (the Outline/Preview JSX below calls
	// `chaptersOf(act)` per act row) AND again per act inside the search-match
	// loop just below, an avoidable O(acts × chapters) with a real
	// `plugin.indexer.resolve` (Obsidian `getFirstLinkpathDest`) call per
	// chapter each time, unmemoized.
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
	for (const list of chaptersByAct.values()) list.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	const chaptersOf = (act: EntityRecord): EntityRecord[] => chaptersByAct.get(act.path) ?? [];
	const orphans = parsed ? orphanedBookEntities(plugin, project, parsed) : { acts: [], chapters: [] };

	/** The Outline's own top-level list — every Act AND every act-boundary
	 *  page break, interleaved in document order, mirrors `topLevelRows`
	 *  (script-view.tsx). Only acts already backed by an indexed note are
	 *  included (an id-less/not-yet-synced one has nothing to show). */
	type BookTopLevelRow =
		| { kind: 'act'; id: string; line: number; act: EntityRecord }
		| { kind: 'page-break'; id: string; line: number };
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
								<div className="loom-search-wrap">
									<input
										type="search"
										className="loom-writer-search"
										placeholder={t('project.common.searchPlaceholder')}
										value={query}
										onChange={(e) => {
											setQuery(e.target.value);
											setMatchIndex(0);
										}}
										onKeyDown={(e) => {
											if (e.key !== 'Enter') return;
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
									/>
									{query !== '' ? (
										<button
											className="loom-chip-remove loom-search-clear"
											aria-label={t('view.entity.script.clearSearch')}
											onClick={() => {
												setQuery('');
												setMatchIndex(0);
											}}
										>
											✕
										</button>
									) : null}
								</div>
								<button
									className="loom-rel-filter"
									aria-label={t('view.entity.script.previousMatch')}
									disabled={bookMatches.length === 0}
									onClick={() => gotoMatch(matchIndex - 1)}
								>
									<Icon name="chevron-up" />
								</button>
								<button
									className="loom-rel-filter"
									aria-label={t('view.entity.script.nextMatch')}
									disabled={bookMatches.length === 0}
									onClick={() => gotoMatch(matchIndex + 1)}
								>
									<Icon name="chevron-down" />
								</button>
							</>
						) : null}
						<div className="loom-script-side-toggles">
							{/* Mirrors Script's own pair (script-view.tsx) exactly, down to
							    the shared `CommentsBrowserPanel`/`AlternativesBrowserPanel`
							    components (annotation-popover.tsx) rendered below —
							    mutually exclusive with each other via `sidePanel`. */}
							<button
								className={sidePanel === 'comments' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={sidePanel === 'comments' ? t('view.entity.script.hideComments') : t('view.entity.script.browseComments')}
								onClick={() => setSidePanel(sidePanel === 'comments' ? null : 'comments')}
							>
								<Icon name="message-square" />
							</button>
							<button
								className={sidePanel === 'alt' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={sidePanel === 'alt' ? t('view.entity.script.hideAlternatives') : t('view.entity.script.browseAlternatives')}
								onClick={() => setSidePanel(sidePanel === 'alt' ? null : 'alt')}
							>
								<Icon name="repeat" fallback="arrow-right-left" />
							</button>
						</div>
						{mode !== 'outline' ? (
							<span className="loom-writer-stat">
								{query.trim() === ''
									? ''
									: bookMatches.length === 0
										? t('view.entity.script.noMatches')
										: t('view.entity.script.matchCount', {
												current: (matchIndex % bookMatches.length) + 1,
												total: bookMatches.length,
											})}
							</span>
						) : null}
						<div className="loom-shell-spacer" />
						{/* Preview is the sole read-only reading view now — this is the
						    one remaining toggle, swapping in the act/chapter
						    drag-reorder tree instead. Sits to the LEFT of the
						    creation-button group below, not on the far right — those
						    own that slot. */}
						<button
							className={mode === 'outline' ? 'loom-writer-outline-btn loom-seg-on' : 'loom-writer-outline-btn'}
							onClick={() => switchMode('outline')}
						>
							{t('view.entity.script.outline')}
						</button>
						<button
							className="loom-rel-add"
							onClick={() => new CreateEntityModal(plugin, 'chapter', project, {}).open()}
						>
							{t('view.entity.script.newChapterAction')}
						</button>
						<button className="loom-rel-add" onClick={() => new CreateEntityModal(plugin, 'act', project, {}).open()}>
							{t('project.newActStub')}
						</button>
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
						<div className={seqDrag ? 'loom-subloc-list loom-subloc-dragging loom-writer-outline' : 'loom-subloc-list loom-writer-outline'}>
							{topLevelRows.length === 0 ? (
								<div className="loom-attendance-empty">{t('view.script.noActsYetBook')}</div>
							) : (
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
														<Icon name="separator-horizontal" fallback="minus" /> {t('view.script.pageBreakLabel')}
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
														<div className="loom-attendance-empty">
															{t('view.entity.script.noChaptersYetPre')}<code># {act.name}</code>{t('view.entity.script.noChaptersYetPost')}
														</div>
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
							{sidePanel === 'comments' ? (
								<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
									<CommentsBrowserPanel
										rows={unresolvedCommentRowsList}
										onJump={jumpToAnnotation}
										onClose={() => setSidePanel(null)}
									/>
								</div>
							) : null}
							{sidePanel === 'alt' ? (
								<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
									<AlternativesBrowserPanel
										rows={undecidedAltRowsList}
										onJump={jumpToAnnotation}
										onClose={() => setSidePanel(null)}
									/>
								</div>
							) : null}
							{acts.length === 0 ? (
								<div className="loom-book-page">
									<div className="loom-attendance-empty">{t('view.script.noActsYetBook')}</div>
								</div>
							) : (
								previewPageGroups.map((group, gi) => (
									<div className="loom-book-page" key={gi}>
										{group.map((act) => (
											<div key={act.path} className="loom-field loom-field-sep">
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
													emptyMessage={
														<div className="loom-attendance-empty">
															{t('view.entity.script.noChaptersYetPre')}<code># {act.name}</code>{t('view.entity.script.noChaptersYetPost')}
														</div>
													}
													annotations={annotations}
													highlightedAnnotationId={highlightedAnnotationId}
													onOpenChapter={openThisChapter}
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
