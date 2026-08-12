import { normalizePath, TFile } from 'obsidian';
import { CSSProperties, ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
	BOOK_EXTENSION,
	BOOK_ICON,
	ENTITY_META,
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
	chapterBookText,
	ensureBookIds,
	liveBookActIds,
	liveBookChapterIds,
	parseBook,
	reorderBookActs,
	reorderBookChaptersInAct,
	replaceBookChapterBody,
} from '../prose';
import { ProjectDef, linkTargetOf } from '../indexer';
import { setLoomKey } from '../fm';
import { AltTextModal, CreateEntityModal, EntityTypeSuggestModal, createEntity, entityFileName } from '../project';
import { LoomFileReactView } from './react-view';
import { MarkdownField } from './markdown-field';
import { Icon, ViewShell } from './common';
import { useIndexVersion } from './hooks';
import { t } from '../i18n';
import { findAnnotationSpans } from '../fountain';
import { CommentEntry, mutateScriptNotes, useScriptNotes } from './script-notes';
import { CommentPopover } from './annotation-popover';
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

	const handleCreateComment = (id: string) => {
		if (!project) return;
		const entry: CommentEntry = { id, text: '', resolved: false, createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null };
		void mutateScriptNotes(plugin.app, project, (file) => ({
			...file,
			comments: { ...file.comments, [id]: [entry] },
		}));
	};

	const handleCreateAlt = (id: string, selectedText: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => ({
			...file,
			altText: { ...file.altText, [id]: { id, options: [selectedText], activeIndex: 0, acceptedIndex: null } },
		}));
	};

	const handleOpenComment = (id: string, rect: DOMRect) => setOpenComment({ id, rect });
	const handleCloseComment = () => setOpenComment(null);

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
		});
	};

	const handleAddCommentReply = (id: string, text: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entries = file.comments[id] ?? [];
			const entry: CommentEntry = { id, text, resolved: false, createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null };
			return { ...file, comments: { ...file.comments, [id]: [...entries, entry] } };
		});
	};

	/** The click already swapped the document (`markdown-field.tsx`'s own
	 *  mousedown handler, which has direct access to its own live view) —
	 *  this only persists the sidecar's `activeIndex`. */
	const handleCycleAlt = (id: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (file) => {
			const entry = file.altText[id];
			if (!entry || entry.options.length < 2) return file;
			const activeIndex = (entry.activeIndex + 1) % entry.options.length;
			return { ...file, altText: { ...file.altText, [id]: { ...entry, activeIndex, acceptedIndex: null } } };
		});
	};

	const handleOpenAltMenu = (id: string) => {
		if (!project) return;
		const entry = scriptNotes.altText[id];
		if (!entry) return;
		new AltTextModal(plugin.app, {
			options: entry.options,
			activeIndex: entry.activeIndex,
			acceptedIndex: entry.acceptedIndex,
			onDraft: (index) => {
				void mutateScriptNotes(plugin.app, project, (file) => {
					const e = file.altText[id];
					if (!e) return file;
					return { ...file, altText: { ...file.altText, [id]: { ...e, activeIndex: index, acceptedIndex: null } } };
				});
				void replaceAltContentInBook(plugin, project, id, entry.options[index]);
			},
			onAccept: (index) => {
				void mutateScriptNotes(plugin.app, project, (file) => {
					const e = file.altText[id];
					if (!e) return file;
					return { ...file, altText: { ...file.altText, [id]: { ...e, activeIndex: index, acceptedIndex: index } } };
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
			onDeleteOption: async (index) => {
				if (entry.options.length <= 1) return undefined;
				const options = entry.options.filter((_, i) => i !== index);
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
		handleOpenAltMenu,
	};
}

/**
 * Renders every chapter under one act as a stacked sequence of blocks —
 * heading + a `MarkdownField` scoped to that chapter's own body
 * (`chapterBookText`), Preview using the field's `readOnly` mode instead of
 * a separate paginated view (no pagination for prose — see this feature's
 * plan). Shared by the Act entity page's own Editor section
 * (`entity-view.tsx`) and `BookView` below (which calls this once per act in
 * the whole book) — the two differ only in how MANY acts' worth of chapters
 * they show, never in how one act's own chapters render.
 */
export function ActChapterBlocks({
	plugin,
	project,
	bookText,
	chapters,
	mode,
	names,
	onOpenLink,
	onCreateEntity,
	onOpenChapter,
	emptyMessage,
	annotations,
	highlightedAnnotationId,
}: {
	plugin: LoomLoomPlugin;
	project: ProjectDef;
	bookText: string | null;
	chapters: EntityRecord[];
	mode: 'editor' | 'preview';
	names: LinkOption[];
	onOpenLink: (target: string, newTab?: boolean) => void;
	onCreateEntity?: (name: string, insert: (linkInsert: string) => void) => void;
	onOpenChapter: (path: string) => void;
	emptyMessage: ReactElement;
	/** Comments/alternative-text — optional, same as `MarkdownField`'s own
	 *  props (omitting it leaves every chapter's field exactly as before). */
	annotations?: ReturnType<typeof useBookAnnotations>;
	highlightedAnnotationId?: string | null;
}): ReactElement {
	if (chapters.length === 0) return emptyMessage;
	return (
		<>
			{chapters.map((ch) => {
				const excerpt = bookText !== null && ch.chapterId !== '' ? chapterBookText(bookText, ch.chapterId) : null;
				if (excerpt === null) return null;
				return (
					<div key={ch.path} className="loom-field loom-field-sep" data-chapter-id={ch.chapterId}>
						<button className="loom-subloc-link" onClick={() => onOpenChapter(ch.path)}>
							{ch.name}
						</button>
						{mode === 'editor' ? (
							<MarkdownField
								app={plugin.app}
								value={excerpt}
								names={names}
								onOpenLink={onOpenLink}
								onCreateEntity={onCreateEntity}
								onChange={(v) => {
									void editBookAndSync(plugin, project, (raw) =>
										replaceBookChapterBody(raw, ch.chapterId, v)
									);
								}}
								comments={annotations?.comments}
								altText={annotations?.altText}
								onCreateComment={annotations?.handleCreateComment}
								onCreateAlt={annotations?.handleCreateAlt}
								onOpenComment={annotations?.handleOpenComment}
								onCycleAlt={annotations?.handleCycleAlt}
								onOpenAltMenu={annotations?.handleOpenAltMenu}
								highlightedAnnotationId={highlightedAnnotationId}
							/>
						) : (
							<MarkdownField
								app={plugin.app}
								value={excerpt}
								names={names}
								onOpenLink={onOpenLink}
								readOnly
								onChange={() => {}}
								comments={annotations?.comments}
								altText={annotations?.altText}
								onOpenComment={annotations?.handleOpenComment}
								highlightedAnnotationId={highlightedAnnotationId}
							/>
						)}
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
 * The whole-book view: every Act in order, each showing its own Chapters via
 * `ActChapterBlocks` (Editor/Preview), or a drag-reorder Outline tree.
 *
 * No single CM6 buffer and no commit queue, unlike `ScriptView` — each
 * chapter's `MarkdownField` (inside `ActChapterBlocks`) already reads/writes
 * its own excerpt independently via `editBookAndSync`, so there's no shared
 * "current text" state here to race across a mode switch the way Script's
 * one big buffer does. Structural edits (create/reorder) go through the
 * same `editBookAndSync`/`appendActToBook`/`appendChapterToBook` helpers
 * every other Book-touching surface uses.
 *
 * Cross-act chapter dragging is deliberately NOT supported — same "v1 ships
 * same-act reorder only" scope call as the Act page's own Outline. Acts
 * reorder at the top level; a chapter reorders within its own act.
 */
function Book({ view }: { view: BookView }): ReactElement {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
	const file = view.file;
	const project = file ? plugin.indexer.projectForPath(file.path) : undefined;
	const bookText = useBookText(plugin, project ?? null);
	const parsed = useMemo(() => (bookText !== null ? parseBook(bookText) : null), [bookText]);
	const annotations = useBookAnnotations(plugin, project ?? null);

	const [mode, setMode] = useState<'editor' | 'preview' | 'outline'>(() => {
		const saved = file ? window.localStorage.getItem(`loom-book-mode:${file.path}`) : null;
		return saved === 'preview' || saved === 'outline' ? saved : 'editor';
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

	/** Editor mode's own box — fixed height, resizable, scrolls internally,
	 *  remembered per file — mirrors Script's `.loom-writer-editor` exactly
	 *  (same class, same `loom-*-editor-height:<path>` localStorage
	 *  mechanism), restored before the ResizeObserver starts watching so its
	 *  own first callback doesn't immediately overwrite what was just set. */
	const editorWrapperRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (mode !== 'editor' || !file) return;
		const editor = editorWrapperRef.current;
		if (!editor) return;
		const key = `loom-book-editor-height:${file.path}`;
		const saved = window.localStorage.getItem(key);
		if (saved) editor.style.height = saved;
		const observer = new ResizeObserver(() => {
			if (editor.style.height) window.localStorage.setItem(key, editor.style.height);
		});
		observer.observe(editor);
		return () => observer.disconnect();
	}, [file, mode]);

	/** Preview mode's own scroller — mirrors Script's `.loom-screenplay`. */
	const previewWrapperRef = useRef<HTMLDivElement | null>(null);

	/** Switching Editor<->Preview keeps roughly the same READING position —
	 *  mirrors Script's Script<->Pages scroll sync in spirit, simplified: Book
	 *  has no per-field CM6 ref the way `FountainField` exposes (each chapter
	 *  is its own `MarkdownField` instance, and that field has no imperative
	 *  handle at all), so exact line-level restore isn't available. Both
	 *  modes render the SAME acts/chapters in the SAME order, though, so a
	 *  scroll-height FRACTION carries over close enough in practice. */
	const pendingScrollFractionRef = useRef<number | null>(null);
	/** Scrolls the tabs row into view on every click — mirrors Script's own
	 *  `clickTab`/`clickActTab` (`scrollTabsIntoView`), even a re-click of the
	 *  pane already active, so working in BookView from wherever the page
	 *  happens to be scrolled is one click away. */
	const tabsRef = useRef<HTMLDivElement | null>(null);
	const switchMode = (next: 'editor' | 'preview' | 'outline') => {
		if (next !== mode) {
			const fromBox = mode === 'editor' ? editorWrapperRef.current : mode === 'preview' ? previewWrapperRef.current : null;
			if (fromBox && (next === 'editor' || next === 'preview')) {
				const range = fromBox.scrollHeight - fromBox.clientHeight;
				pendingScrollFractionRef.current = range > 0 ? fromBox.scrollTop / range : 0;
			}
			setMode(next);
		}
		window.requestAnimationFrame(() => {
			tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	};
	useEffect(() => {
		const fraction = pendingScrollFractionRef.current;
		if (fraction === null) return;
		const toBox = mode === 'editor' ? editorWrapperRef.current : mode === 'preview' ? previewWrapperRef.current : null;
		if (!toBox) return;
		pendingScrollFractionRef.current = null;
		window.requestAnimationFrame(() => {
			const range = toBox.scrollHeight - toBox.clientHeight;
			if (range > 0) toBox.scrollTop = fraction * range;
		});
	}, [mode, bookText]);

	// --- generic loomSeq drag-reorder, mirrors entity-view.tsx's own seqGrip
	// (a third independent copy of this pattern, same as script-view.tsx's
	// `outlineGrip` — this codebase doesn't share it across files, only the
	// shape). Two groups: 'book-acts' (top level) and
	// `book-chapters:<actId>` (one act's own chapters).
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
	const endSeqDrag = (
		group: string,
		records: EntityRecord[],
		commit: boolean,
		onCommit: (reordered: EntityRecord[]) => void
	) => {
		seqDragRef.current = null;
		const drag = seqDrag;
		setSeqDrag(null);
		if (!commit || !drag || drag.group !== group || drag.from === drag.over) return;
		const next = [...records];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		onCommit(next);
	};
	const seqGrip = (group: string, i: number, records: EntityRecord[], onCommit: (reordered: EntityRecord[]) => void) => (
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

	const linkNames = useMemo<LinkOption[]>(() => {
		if (!project) return [];
		return plugin.indexer
			.getAll(undefined, project.root)
			.flatMap((r) => {
				const target = linkTargetOf(r);
				const label = r.name;
				const opts: LinkOption[] = [{ label, insert: target === label ? label : `${target}|${label}` }];
				const f = plugin.app.vault.getFileByPath(r.path);
				const aliases = f ? (plugin.app.metadataCache.getFileCache(f)?.frontmatter?.aliases as unknown) : undefined;
				if (Array.isArray(aliases)) {
					for (const a of aliases) {
						if (typeof a === 'string' && a.trim() !== '' && a !== label) {
							opts.push({ label: a, insert: `${target}|${a}` });
						}
					}
				}
				return opts;
			})
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [plugin, project]);

	const openLinkTarget = (target: string, newTab = false) => {
		if (!file) return;
		const resolved = plugin.indexer.resolve(target, file.path);
		if (resolved) view.openEntity(resolved.path, newTab);
		else void plugin.app.workspace.openLinkText(target, file.path, newTab ? 'tab' : false);
	};

	const createLinkEntity = (entered: string, insert: (linkInsert: string) => void) => {
		if (!project) return;
		new EntityTypeSuggestModal(
			plugin,
			(type) =>
				new CreateEntityModal(plugin, type, project, {
					initialName: entered,
					onCreated: (created) => {
						const prefix = `${project.name} ${ENTITY_META[type].label} `;
						const label = created.basename.startsWith(prefix) ? created.basename.slice(prefix.length) : entered;
						insert(created.basename === label ? label : `${created.basename}|${label}`);
					},
				}).open(),
			project
		).open();
	};

	if (!project) {
		return <div className="loom-view loom-book-view loom-empty">{t('view.home.loadingProject')}</div>;
	}

	const acts = plugin.indexer
		.getAll('act', project.root)
		.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	const chaptersOf = (act: EntityRecord): EntityRecord[] =>
		plugin.indexer
			.getAll('chapter', project.root)
			.filter((c) => c.chapterAct !== '' && plugin.indexer.resolve(c.chapterAct, c.path)?.path === act.path)
			.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	const actlessChapters = plugin.indexer
		.getAll('chapter', project.root)
		.filter((c) => c.chapterAct === '' || !plugin.indexer.resolve(c.chapterAct, c.path));
	const orphans = parsed ? orphanedBookEntities(plugin, project, parsed) : { acts: [], chapters: [] };

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
						<div className="loom-seg">
							<button
								className={mode === 'editor' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => switchMode('editor')}
							>
								{t('view.entity.script.editorLabel')}
							</button>
							<button
								className={mode === 'preview' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => switchMode('preview')}
							>
								{t('view.entity.script.pagesPreview')}
							</button>
						</div>
						<div className="loom-shell-spacer" />
						<button
							className={mode === 'outline' ? 'loom-writer-outline-btn loom-seg-on' : 'loom-writer-outline-btn'}
							onClick={() => switchMode('outline')}
						>
							{t('view.entity.script.outline')}
						</button>
					</div>
					<div className="loom-writer-toolbar">
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
							</>
						) : null}
						<div className="loom-shell-spacer" />
						<button
							className="loom-rel-add"
							onClick={() => new CreateEntityModal(plugin, 'chapter', project, {}).open()}
						>
							{t('view.entity.script.newChapterAction')}
						</button>
						<button className="loom-rel-add" onClick={() => new CreateEntityModal(plugin, 'act', project, {}).open()}>
							{t('project.newActStub')}
						</button>
					</div>
					{mode === 'outline' ? (
						<div className={seqDrag ? 'loom-subloc-list loom-subloc-dragging loom-writer-outline' : 'loom-subloc-list loom-writer-outline'}>
							{acts.length === 0 ? (
								<div className="loom-attendance-empty">{t('view.script.noActsYetBook')}</div>
							) : (
								acts.map((act, i) => {
									const chapters = chaptersOf(act);
									const collapsed = collapsedActs.has(act.actId);
									const grabbed = seqDrag?.group === 'book-acts' && seqDrag.from === i;
									return (
										<div
											key={act.path}
											className="loom-writer-outline-act"
											data-act-id={act.actId}
											data-seq-row=""
											style={seqRowStyle('book-acts', i)}
										>
											<div className={grabbed ? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging' : 'loom-writer-outline-row loom-subloc-row-slide'}>
												{seqGrip('book-acts', i, acts, (reordered) => {
													void editBookAndSync(plugin, project, (raw) =>
														reorderBookActs(raw, reordered.map((a) => a.actId))
													);
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
												<span className="loom-writer-row-count">{chapters.length}</span>
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
																		void editBookAndSync(plugin, project, (raw) =>
																			reorderBookChaptersInAct(
																				raw,
																				act.actId,
																				reordered.map((c) => c.chapterId)
																			)
																		);
																	})}
																	<span className="loom-writer-row-num">{j + 1}</span>
																	<button className="loom-subloc-link" onClick={() => view.openEntity(ch.path)}>
																		{ch.name}
																	</button>
																	<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
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
					) : mode === 'editor' ? (
						<div className="loom-writer-editor" ref={editorWrapperRef}>
							{acts.length === 0 ? (
								<div className="loom-attendance-empty">{t('view.script.noActsYetBook')}</div>
							) : (
								acts.map((act) => (
									<div key={act.path} className="loom-field loom-field-sep">
										<span className="loom-field-label">
											<button className="loom-subloc-link" onClick={() => view.openEntity(act.path)}>
												{act.name}
											</button>
										</span>
										<ActChapterBlocks
											plugin={plugin}
											project={project}
											bookText={bookText}
											chapters={chaptersOf(act)}
											mode="editor"
											names={linkNames}
											onOpenLink={openLinkTarget}
											onCreateEntity={createLinkEntity}
											onOpenChapter={(path) => view.openEntity(path)}
											emptyMessage={
												<div className="loom-attendance-empty">
													{t('view.entity.script.noChaptersYetPre')}<code># {act.name}</code>{t('view.entity.script.noChaptersYetPost')}
												</div>
											}
											annotations={annotations}
											highlightedAnnotationId={highlightedAnnotationId}
										/>
									</div>
								))
							)}
						</div>
					) : (
						<div className="loom-screenplay" ref={previewWrapperRef}>
							<div className="loom-book-page">
								{acts.length === 0 ? (
									<div className="loom-attendance-empty">{t('view.script.noActsYetBook')}</div>
								) : (
									acts.map((act) => (
										<div key={act.path} className="loom-field loom-field-sep">
											<span className="loom-field-label">
												<button className="loom-subloc-link" onClick={() => view.openEntity(act.path)}>
													{act.name}
												</button>
											</span>
											<ActChapterBlocks
												plugin={plugin}
												project={project}
												bookText={bookText}
												chapters={chaptersOf(act)}
												mode="preview"
												names={linkNames}
												onOpenLink={openLinkTarget}
												onCreateEntity={createLinkEntity}
												onOpenChapter={(path) => view.openEntity(path)}
												emptyMessage={
													<div className="loom-attendance-empty">
														{t('view.entity.script.noChaptersYetPre')}<code># {act.name}</code>{t('view.entity.script.noChaptersYetPost')}
													</div>
												}
												annotations={annotations}
												highlightedAnnotationId={highlightedAnnotationId}
											/>
										</div>
									))
								)}
							</div>
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
