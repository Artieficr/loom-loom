import { normalizePath, TFile } from 'obsidian';
import { ReactElement, useEffect, useState } from 'react';
import { BOOK_EXTENSION, BOOK_ICON, EntityRecord, FM, VIEW_PROSE, bookLabel, pcGroupStub } from '../types';
import {
	ParsedBook,
	appendBookAct,
	ensureBookIds,
	liveBookActIds,
	liveBookChapterIds,
	parseBook,
} from '../prose';
import { ProjectDef, linkTargetOf } from '../indexer';
import { setLoomKey } from '../fm';
import { createEntity, entityFileName } from '../project';
import { LoomFileReactView } from './react-view';
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

/**
 * Applies a change to the project's Book file. Mirrors `editScript`.
 */
export async function editBook(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
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
export async function syncActsChapters(plugin: LoomLoomPlugin, project: ProjectDef, parsed: ParsedBook): Promise<void> {
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
					}
				}
			}
			actById.set(act.loomId, found);
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
		const found = existingChapters.get(chapter.loomId);
		if (found) {
			const sameAct = found.chapterAct === (act ? linkTargetOf(act) : '');
			const clean = found.name === chapter.title && sameAct && found.seq === seq;
			if (clean) continue;
			const file = plugin.app.vault.getFileByPath(found.path);
			if (!file) continue;
			const renamed = found.name !== chapter.title;
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.chapterAct, act ? `[[${linkTargetOf(act)}]]` : '');
				setLoomKey(fm, FM.seq, seq);
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
		return applied === null ? null : ensureBookIds(applied).text;
	});
	if (changed) {
		const file = findBookFile(plugin, project);
		if (file) {
			const raw = await plugin.app.vault.read(file);
			await syncActsChapters(plugin, project, parseBook(raw));
		}
	}
	return changed;
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
			void plugin.app.vault.cachedRead(file).then((raw) => {
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

function Book({ view }: { view: BookView }): ReactElement {
	return <div className="loom-view loom-book-view">{view.file?.basename}</div>;
}
