import { Menu, Notice, TFile, normalizePath } from 'obsidian';
import { MouseEvent as ReactMouseEvent, ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
	EntityRecord,
	EntityType,
	FM,
	SCRIPT_EXTENSION,
	SCRIPT_ICON,
	SCRIPT_LABEL,
	VIEW_SCRIPT,
	pcGroupStub,
} from '../types';
import {
	ParsedScene,
	ParsedScript,
	TitlePage,
	applyDisplayTitles,
	elementText,
	ensureSceneIds,
	hasTitlePage,
	parseFountain,
	reattachSceneIds,
	reattachSectionIds,
	renderInline,
	renumberScenes,
	stripLoomIds,
	renderTitlePage,
	splitLocationSub,
	splitTitlePage,
} from '../fountain';
import { pdfPages, renderScreenplayPdf } from '../pdf';
import { ProjectDef, linkTargetOf } from '../indexer';
import { setLoomKey } from '../fm';
import { ConfirmModal, createEntity, entityFileName } from '../project';
import { LoomFileReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage } from './common';
import { useIndexVersion } from './hooks';
import type LoomLoomPlugin from '../main';

/**
 * The project's Fountain script: `<root>/<Project>.fountain`, registered like
 * the .loom home file rather than stored as markdown.
 *
 * Two reasons it can't be a .md note. Fountain's note syntax **is** `[[…]]`, so
 * Obsidian would index every non-exporting script note as a wikilink and fill
 * the graph with them. And an own extension round-trips byte-for-byte with
 * Better Fountain / Highland / Fade In, which is what makes "Open in external
 * app" honest rather than a lossy export.
 */
export function scriptFilePath(project: ProjectDef): string {
	const base = `${project.name}.${SCRIPT_EXTENSION}`;
	return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
}

/** The project's script file, or null when it hasn't been created yet. */
export function findScriptFile(plugin: LoomLoomPlugin, project: ProjectDef): TFile | null {
	return plugin.app.vault.getFileByPath(scriptFilePath(project));
}

/** Creates the script with a title page seeded from the project name. */
export async function createScriptFile(plugin: LoomLoomPlugin, project: ProjectDef): Promise<TFile> {
	const existing = findScriptFile(plugin, project);
	if (existing) return existing;
	const content = [`Title: ${project.name}`, 'Credit: Written by', 'Author:', 'Draft date:', '', ''].join(
		'\n'
	);
	return plugin.app.vault.create(scriptFilePath(project), content);
}

export class ScriptView extends LoomFileReactView {
	getViewType(): string {
		return VIEW_SCRIPT;
	}

	getDisplayText(): string {
		return this.file ? `${this.file.basename} — ${SCRIPT_LABEL}` : SCRIPT_LABEL;
	}

	getIcon(): string {
		return SCRIPT_ICON;
	}

	canAcceptExtension(extension: string): boolean {
		return extension === SCRIPT_EXTENSION;
	}

	protected renderReact(): ReactElement {
		return <Script key={this.file?.path ?? ''} view={this} />;
	}
}

/**
 * Mirrors the script's scenes into Scene entity notes.
 *
 * Matching is by the heading's `[[loom:<id>]]` marker, never by heading text —
 * that is the whole reason the marker exists, since a scene renamed *and* moved
 * in one edit would detach under any text heuristic and take its relationships
 * and notes with it.
 *
 * Deliberately additive: it creates missing notes and updates existing ones, but
 * **never deletes**. A heading removed from the script leaves its note behind as
 * an orphan (surfaced in the view) rather than silently destroying whatever was
 * written on it.
 */
export async function syncScenes(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	parsed: ParsedScript
): Promise<void> {
	const existing = new Map<string, EntityRecord>();
	for (const record of plugin.indexer.getAll('scene', project.root)) {
		const id = record.sceneId;
		if (id !== '') existing.set(id, record);
	}

	const byName = (type: EntityType) => {
		const map = new Map<string, EntityRecord>();
		for (const r of plugin.indexer.getAll(type, project.root)) {
			map.set(r.name.trim().toLowerCase(), r);
		}
		return map;
	};
	const characters = byName('character');
	// Only TOP-LEVEL locations, keyed by name — a heading's "main" location part
	// (see `splitLocationSub`) names a place the same way the modular Scene-page
	// editor does, and matching against every location including sublocations
	// would risk matching an unrelated sublocation that happens to share a name.
	const mainLocations = new Map<string, EntityRecord>();
	for (const r of plugin.indexer.getAll('location', project.root)) {
		if (r.parentLocation === null) mainLocations.set(r.name.trim().toLowerCase(), r);
	}

	// Characters and top-level locations the script names but the project
	// doesn't have yet are created automatically, so importing or writing a
	// script never leaves a cue pointing at nothing. Matching is by name, so an
	// entity that already exists is REFERENCED, never duplicated or
	// overwritten — its page, description and relationships are untouched.
	const ensureNamed = async (type: 'character' | 'location', names: string[], map: Map<string, EntityRecord>) => {
		for (const raw of names) {
			const name = raw.trim();
			const key = name.toLowerCase();
			if (name === '' || map.has(key)) continue;
			const created = await createEntity(plugin, project, type, {
				name,
				tag: type === 'character' ? 'Cast' : '',
				date: '',
				description: '',
			});
			map.set(key, { ...pcGroupStub(project.root), path: created.path, name, type });
		}
	};
	const mainLocationNames = [
		...new Set(parsed.scenes.map((s) => splitLocationSub(s.location).main).filter((n) => n !== '')),
	];
	await ensureNamed('character', parsed.characters, characters);
	await ensureNamed('location', mainLocationNames, mainLocations);

	/** Resolves the most specific location a scene's heading names — the
	 *  sublocation itself when the heading includes one (`CAFE - COUNTER`),
	 *  else the top-level location — creating the sublocation if it doesn't
	 *  exist yet. Mirrors exactly what the Scene page's modular location editor
	 *  writes, so a heading typed straight into the script (or imported)
	 *  connects the same way a script edited through that editor would. */
	const resolveSceneLocation = async (scene: ParsedScene): Promise<EntityRecord | undefined> => {
		const { main, sub } = splitLocationSub(scene.location);
		if (main === '') return undefined;
		const mainRecord = mainLocations.get(main.toLowerCase());
		if (!mainRecord) return undefined;
		if (sub === '') return mainRecord;
		const key = sub.toLowerCase();
		const existingSub = plugin.indexer
			.getAll('location', project.root)
			.find(
				(r) =>
					r.name.trim().toLowerCase() === key &&
					r.parentLocation !== null &&
					plugin.indexer.resolve(r.parentLocation, r.path)?.path === mainRecord.path
			);
		if (existingSub) return existingSub;
		const created = await createEntity(plugin, project, 'location', {
			name: sub,
			tag: '',
			date: '',
			description: '',
			parentLocation: linkTargetOf(mainRecord),
		});
		return {
			...pcGroupStub(project.root),
			path: created.path,
			name: sub,
			type: 'location',
			parentLocation: linkTargetOf(mainRecord),
		};
	};

	// Chapters come from the script's `#` sections — the TOP level of a scene's
	// section path, since `# Chapter` is what the user writes. Unlike characters
	// and locations (shared entities that may already exist elsewhere), chapters
	// are structural: the script owns them, so they're created automatically,
	// exactly like the scenes themselves.
	// Chapters are matched by their section's `[[loom:…]]` id, never by title —
	// renaming `# ACT ONE` to `# ACT I` must move the same chapter, not orphan
	// it and create a second one. The SCRIPT owns the title: the note is renamed
	// to follow its section, while the note owns `loomDisplayTitle`, which is
	// written back into the script (see `applyDisplayTitles`).
	const chaptersById = new Map<string, EntityRecord>();
	for (const record of plugin.indexer.getAll('chapter', project.root)) {
		if (record.chapterId !== '') chaptersById.set(record.chapterId, record);
	}
	const sectionsById = new Map<string, { title: string; seq: number }>();
	parsed.sections
		.filter((sec) => sec.level === 1 && sec.loomId !== null)
		.forEach((sec, i) => sectionsById.set(sec.loomId as string, { title: sec.text.trim(), seq: i + 1 }));

	/** Section loom id owning a scene, from the nearest preceding `#` line. */
	const sectionIdOf = (scene: ParsedScene): string => {
		let best = '';
		for (const sec of parsed.sections) {
			if (sec.level === 1 && sec.loomId !== null && sec.line <= scene.line) best = sec.loomId;
		}
		return best;
	};

	const chapterById = new Map<string, EntityRecord>();
	for (const [id, section] of sectionsById) {
		const found = chaptersById.get(id);
		if (found) {
			// Chapters order by their position in the script, so moving a section
			// reorders them without anyone dragging anything.
			if (found.seq !== section.seq || found.name !== section.title) {
				const chapterFile = plugin.app.vault.getFileByPath(found.path);
				if (chapterFile) {
					const renamed = found.name !== section.title;
					await plugin.app.fileManager.processFrontMatter(
						chapterFile,
						(fm: Record<string, unknown>) => {
							setLoomKey(fm, FM.seq, section.seq);
							if (renamed) {
								setLoomKey(fm, FM.name, section.title);
								fm.aliases = [section.title];
							}
						}
					);
					// The managed file name embeds the title too — without this the
					// note's `loomName` and its actual file name silently disagree
					// the moment the title is edited (from the script OR from the
					// Chapter page's own Title field).
					if (renamed) {
						const base = entityFileName(project, 'chapter', section.title);
						const dir = chapterFile.parent?.path ?? '';
						let newPath = normalizePath(dir === '' ? `${base}.md` : `${dir}/${base}.md`);
						for (let i = 2; plugin.app.vault.getAbstractFileByPath(newPath) !== null; i++) {
							newPath = normalizePath(dir === '' ? `${base} ${i}.md` : `${dir}/${base} ${i}.md`);
						}
						if (newPath !== chapterFile.path) {
							try {
								await plugin.app.fileManager.renameFile(chapterFile, newPath);
							} catch (e) {
								console.error('Loom Loom: chapter rename failed', e);
							}
						}
					}
				}
			}
			chapterById.set(id, found);
			continue;
		}
		const created = await createEntity(plugin, project, 'chapter', {
			name: section.title,
			tag: '',
			date: '',
			description: '',
		});
		await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.chapterId, id);
			setLoomKey(fm, FM.seq, section.seq);
		});
		// The index hasn't caught the new file yet — stand in a record shaped
		// just enough for `linkTargetOf` and the lookups below.
		chapterById.set(id, {
			...pcGroupStub(project.root),
			path: created.path,
			name: section.title,
			type: 'chapter',
		});
	}

	for (const scene of parsed.scenes) {
		if (scene.loomId === null) continue;
		const name = sceneName(scene);
		const chapter = chapterById.get(sectionIdOf(scene));
		const location = await resolveSceneLocation(scene);
		const cast = scene.characters
			.map((c) => characters.get(c.trim().toLowerCase()))
			.filter((c): c is EntityRecord => c !== undefined);

		const apply = (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.sceneId, scene.loomId);
			setLoomKey(fm, FM.sceneIntExt, scene.intExt);
			setLoomKey(fm, FM.sceneTime, scene.timeOfDay);
			// Visible links, so a scene connects to its place and its cast in the
			// graph without any extra wiring.
			setLoomKey(fm, FM.sceneLocation, location ? `[[${linkTargetOf(location)}]]` : '');
			// The chapter link is what stacks the scene under it in the graph and
			// timeline — `buildColumns` takes any connection to an anchor.
			setLoomKey(fm, FM.sceneChapter, chapter ? `[[${linkTargetOf(chapter)}]]` : '');
			setLoomKey(
				fm,
				FM.sceneCast,
				cast.map((c) => `[[${linkTargetOf(c)}]]`)
			);
			// Scene order follows the script, so the graph and lists read in
			// script order without anyone dragging anything.
			setLoomKey(fm, FM.seq, scene.index);
		};

		const record = existing.get(scene.loomId);
		if (record) {
			// `processFrontMatter` always rewrites the file, so a pass that
			// touched every scene note on every edit would re-upload them
			// through the user's sync client and invite conflict copies (see
			// ARCHITECTURE, "Playing nicely with file sync"). Only write when
			// something actually differs.
			const sameCast =
				record.sceneCast.length === cast.length &&
				cast.every((c, i) => record.sceneCast[i] === linkTargetOf(c));
			const clean =
				record.name === name &&
				record.sceneChapter === (chapter ? linkTargetOf(chapter) : '') &&
				record.sceneIntExt === scene.intExt &&
				record.sceneTime === scene.timeOfDay &&
				record.sceneLocation === (location ? linkTargetOf(location) : '') &&
				record.seq === scene.index &&
				sameCast;
			if (clean) continue;
			const file = plugin.app.vault.getFileByPath(record.path);
			if (!file) continue;
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				apply(fm);
				if (record.name !== name) {
					setLoomKey(fm, FM.name, name);
					fm.aliases = [name];
				}
			});
			continue;
		}
		const file = await createEntity(plugin, project, 'scene', {
			name,
			tag: '',
			date: '',
			description: '',
		});
		await plugin.app.fileManager.processFrontMatter(file, apply);
	}
}

/** A scene's display name: the heading without its INT./EXT. prefix. */
function sceneName(scene: ParsedScene): string {
	const place = scene.location.trim() === '' ? 'Untitled scene' : scene.location.trim();
	return scene.timeOfDay.trim() === '' ? place : `${place} — ${scene.timeOfDay.trim()}`;
}

function Script({ view }: { view: ScriptView }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
	const file = view.file;
	const project = file ? plugin.indexer.projectForPath(file.path) : undefined;

	const [text, setText] = useState<string | null>(null);
	/** Which pane the main area shows. */
	const [mode, setMode] = useState<'script' | 'pages'>('script');
	/** Page shown in the pages preview (1-based). */
	const [page, setPage] = useState(1);
	/** The page-number input's own typed text while being edited — separate
	 *  from `page` so clearing the field to type a new number doesn't
	 *  immediately snap back to showing the current page (a controlled input
	 *  bound straight to `page` re-filled itself with the old value the
	 *  instant the field went empty, before a new digit could be typed).
	 *  Null = not being edited, show the real current page. */
	const [pageDraft, setPageDraft] = useState<string | null>(null);
	/** Search across the script; shared by both panes. */
	const [query, setQuery] = useState('');
	/** Navigation panel, overlaid rather than taking width from the page. */
	const [navOpen, setNavOpen] = useState(false);
	const [matchIndex, setMatchIndex] = useState(0);
	/** Guards against writing back the text we just read. */
	const loadedFor = useRef<string | null>(null);
	/** The text last written to (or read from) disk, so a no-op commit doesn't
	 *  rewrite the file — a rewrite re-uploads it through the user's sync. */
	const onDisk = useRef<string | null>(null);
	/** Paths already given their one post-load commit pass. */
	const committedFor = useRef<string | null>(null);
	const editorRef = useRef<HTMLTextAreaElement | null>(null);
	const pagesRef = useRef<HTMLDivElement | null>(null);

	// Read the file once per path; afterwards the textarea is the source of
	// truth until it's written back.
	useEffect(() => {
		if (!file) return;
		if (loadedFor.current === file.path) return;
		loadedFor.current = file.path;
		void plugin.app.vault.read(file).then((raw) => {
			onDisk.current = raw;
			setText(raw);
		});
	}, [plugin, file]);

	// A floating panel that only closes from its own button feels stuck.
	useEffect(() => {
		if (!navOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle')) return;
			setNavOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [navOpen]);

	// Remembers the script textarea's manually-resized height across reloads —
	// a UI preference, not vault data, so it's kept in localStorage rather than
	// project settings. Restored before the ResizeObserver starts watching so
	// its own initial callback doesn't immediately overwrite what we just set.
	useEffect(() => {
		if (mode !== 'script' || !file) return;
		const editor = editorRef.current;
		if (!editor) return;
		const key = `loom-script-editor-height:${file.path}`;
		const saved = window.localStorage.getItem(key);
		if (saved) editor.style.height = saved;
		const observer = new ResizeObserver(() => {
			if (editor.style.height) window.localStorage.setItem(key, editor.style.height);
		});
		observer.observe(editor);
		return () => observer.disconnect();
	}, [file?.path, mode]);

	// Pages preview: the page-number readout should track manual scrolling, not
	// just the explicit jump buttons — otherwise it silently goes stale the
	// moment the user scrolls with the wheel instead of clicking Next/Prev.
	useEffect(() => {
		if (mode !== 'pages') return;
		const el = pagesRef.current;
		if (!el) return;
		const onScroll = () => {
			const top = el.getBoundingClientRect().top;
			const threshold = top + el.clientHeight / 3;
			let current = 1;
			for (const node of el.querySelectorAll<HTMLElement>('[data-page]')) {
				if (node.getBoundingClientRect().top <= threshold) current = Number(node.dataset.page);
			}
			setPage(current);
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		onScroll();
		return () => el.removeEventListener('scroll', onScroll);
	}, [mode]);

	// The outline re-parses on every keystroke — that's cheap and needs no ids.
	const parsed = useMemo(() => (text === null ? null : parseFountain(text)), [text]);

	/**
	 * Writes the script, gives every heading an id, and mirrors the scenes into
	 * notes. Both steps are idempotent and purely additive.
	 *
	 * Deliberately NOT debounced-while-typing: `ensureSceneIds` appends
	 * `[[loom:…]]` to heading lines, and rewriting the textarea's value mid-edit
	 * would yank the caret to the end. It runs on load and on blur instead, so
	 * the text only changes underneath the user when they've stopped typing.
	 */
	const commit = async (raw: string) => {
		if (!file || !project) return;
		const withIds = ensureSceneIds(raw);
		if (withIds.text !== onDisk.current) {
			await plugin.app.vault.modify(file, withIds.text);
			onDisk.current = withIds.text;
		}
		if (withIds.changed) setText(withIds.text);
		await syncScenes(plugin, project, parseFountain(withIds.text));

		// The one thing that flows the other way: a chapter's display title.
		// Fountain sections never export, so a title that must appear in the PDF
		// has to be emitted as a separate centered-bold line — the note owns it,
		// and this is what puts it into the script. Falls back to the chapter's
		// own name (the `#` section's title) when the display title is left
		// blank, so the exported line is never simply dropped — a blank display
		// title always renders something, and a script re-imported later still
		// carries a title to reattach against.
		const titles = new Map<string, string>();
		for (const chapter of plugin.indexer.getAll('chapter', project.root)) {
			if (chapter.chapterId !== '') {
				titles.set(chapter.chapterId, chapter.displayTitle.trim() !== '' ? chapter.displayTitle : chapter.name);
			}
		}
		const titled = applyDisplayTitles(withIds.text, titles);
		if (titled !== onDisk.current) {
			await plugin.app.vault.modify(file, titled);
			onDisk.current = titled;
			setText(titled);
		}
	};

	// Load, then one commit pass so a script dropped in from elsewhere gets its
	// ids and its Scene notes without anyone having to touch it.
	useEffect(() => {
		if (!file || !project || text === null || loadedFor.current !== file.path) return;
		if (committedFor.current === file.path) return;
		committedFor.current = file.path;
		// Runs once per file; `commit` deliberately closes over live state
		// rather than joining the dependency list, which would re-fire it.
		void commit(text);
	}, [file?.path, project?.root, text !== null]);

	if (!file) return <div className="loom-empty">Loading script…</div>;
	if (!project) return <>{noProjectMessage()}</>;
	if (text === null || parsed === null) return <div className="loom-empty">Loading script…</div>;

	const write = (next: string) => {
		setText(next);
		void commit(next);
	};

	/** Rewrites only the title page, leaving the body byte-identical. */
	const writeTitlePage = (title: TitlePage) => {
		const lines = text.split(/\r?\n/);
		const { bodyStart } = splitTitlePage(lines);
		const rendered = renderTitlePage(title);
		const body = lines.slice(bodyStart);
		write([...rendered, '', ...body].join('\n'));
	};

	const setTitleField = (field: keyof TitlePage, value: string) =>
		writeTitlePage({ ...parsed.titlePage, [field]: value });

	// Scene notes whose heading is gone from the script. Never auto-deleted —
	// they may carry notes and relationships that only a human should discard.
	const orphans = (() => {
		const live = new Set(parsed.scenes.map((s) => s.loomId).filter((id): id is string => id !== null));
		return plugin.indexer
			.getAll('scene', project.root)
			.filter((r) => r.sceneId !== '' && !live.has(r.sceneId));
	})();

	// A scene's writing lives inside its chapter's stretch of the script, so one
	// sitting outside every `#` section has nowhere to belong.
	const chapterless = parsed.scenes.filter((s) => (s.sectionPath[0]?.trim() ?? '') === '');

	const sceneNotes = plugin.indexer.getAll('scene', project.root);
	const sceneNote = (scene: ParsedScene): EntityRecord | undefined =>
		sceneNotes.find((r) => r.sceneId === scene.loomId);

	// --- Pagination ---------------------------------------------------------
	// From the PDF's real typeset geometry, not the parser's line-budget
	// estimate, so the preview and the exported file agree page for page.
	const bodyPages = pdfPages(parsed);
	// The PDF puts the title page first, so the preview must too — otherwise
	// every page number in the app is one off from the exported file.
	const titleFirst = hasTitlePage(parsed.titlePage);
	const pages = titleFirst ? [[] as typeof bodyPages[number], ...bodyPages] : bodyPages;
	const pageCount = Math.max(1, pages.length);
	const currentPage = Math.min(Math.max(1, page), pageCount);
	/** Real page range of a scene, from the same layout as the PDF. */
	const scenePages = (scene: ParsedScene): string => {
		const hits: number[] = [];
		bodyPages.forEach((elements, i) => {
			if (elements.some((el) => el.line >= scene.line && el.line < scene.endLine)) {
				hits.push(i + 1 + (titleFirst ? 1 : 0));
			}
		});
		if (hits.length === 0) return '—';
		const first = hits[0];
		const last = hits[hits.length - 1];
		return first === last ? String(first) : `${first}–${last}`;
	};

	// --- Search -------------------------------------------------------------
	const matches: number[] = [];
	if (query.trim() !== '') {
		const needle = query.toLowerCase();
		const hay = text.toLowerCase();
		for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
			matches.push(at);
		}
	}
	/** Line index a character offset falls on. */
	const lineAt = (offset: number) => text.slice(0, offset).split('\n').length - 1;

	/** The 1-based typeset page a line renders on. */
	const pageOfLine = (line: number) => {
		const offset = titleFirst ? 2 : 1;
		for (let i = 0; i < bodyPages.length; i++) {
			if (bodyPages[i].some((el) => el.line === line)) return i + offset;
		}
		// Nothing rendered sits exactly on this line — a section (`#` chapter)
		// heading never reaches the page itself. Land on whichever page holds
		// the first thing that comes AFTER it, so a chapter that starts fresh
		// on a new page jumps to that page rather than the one before it (the
		// last page whose first element preceded the target would always be
		// one page too early in exactly that case).
		for (let i = 0; i < bodyPages.length; i++) {
			if (bodyPages[i].some((el) => el.line > line)) return i + offset;
		}
		return Math.max(offset, bodyPages.length - 1 + offset);
	};

	const gotoMatch = (index: number) => {
		if (matches.length === 0) return;
		const next = ((index % matches.length) + matches.length) % matches.length;
		setMatchIndex(next);
		const offset = matches[next];
		if (mode === 'script') {
			const editor = editorRef.current;
			if (!editor) return;
			editor.focus();
			editor.setSelectionRange(offset, offset + query.length);
			// setSelectionRange doesn't scroll on its own in every engine.
			const ratio = offset / Math.max(1, text.length);
			editor.scrollTop = Math.max(0, ratio * editor.scrollHeight - editor.clientHeight / 2);
		} else {
			scrollToPage(pageOfLine(lineAt(offset)));
		}
	};

	/** Scrolls the active pane to a script line (outline navigation). */
	/** Scrolls the preview to a page (the pages all exist; navigation moves). */
	const scrollToPage = (target: number) => {
		setPage(target);
		window.requestAnimationFrame(() => {
			pagesRef.current
				?.querySelector(`[data-page="${target}"]`)
				?.scrollIntoView({ block: 'start', behavior: 'smooth' });
		});
	};

	const jumpToLine = (line: number) => {
		if (mode === 'pages') {
			scrollToPage(pageOfLine(line));
			return;
		}
		const editor = editorRef.current;
		if (!editor) return;
		const offset = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
		editor.focus();
		editor.setSelectionRange(offset, offset);
		const ratio = offset / Math.max(1, text.length);
		editor.scrollTop = Math.max(0, ratio * editor.scrollHeight - editor.clientHeight / 3);
	};

	// --- Menus --------------------------------------------------------------
	/**
	 * Hands a vault file to the OS.
	 *
	 * `openWithDefaultApp` and `showInFolder` are long-standing internal APIs,
	 * absent from the public typings; guarded so a rename in a future release
	 * degrades to a notice rather than throwing.
	 */
	const systemOpen = (method: 'openWithDefaultApp' | 'showInFolder', path: string) => {
		const api = plugin.app as unknown as Record<string, ((p: string) => void) | undefined>;
		const fn = api[method];
		if (typeof fn !== 'function') {
			new Notice('This Obsidian build cannot hand files to the system.');
			return;
		}
		try {
			fn.call(plugin.app, path);
		} catch (err) {
			console.error('Loom Loom: system open failed', err);
			new Notice('The system could not open that file.');
		}
	};

	/**
	 * Saves an export wherever the user says.
	 *
	 * Prefers the browser's native save dialog (`showSaveFilePicker`), which is
	 * a real OS file chooser and can write anywhere — including outside the
	 * vault, which is the point of an export. Falls back to a download, and
	 * finally to writing beside the script, so the action always completes.
	 */
	const saveExport = async (name: string, data: Uint8Array | string, mime: string) => {
		const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
		const picker = (
			window as unknown as {
				showSaveFilePicker?: (options: unknown) => Promise<{
					createWritable: () => Promise<{ write: (d: BlobPart) => Promise<void>; close: () => Promise<void> }>;
				}>;
			}
		).showSaveFilePicker;
		const ext = name.slice(name.lastIndexOf('.'));
		if (typeof picker === 'function') {
			try {
				const handle = await picker({
					suggestedName: name,
					types: [{ description: ext.toUpperCase().slice(1), accept: { [mime]: [ext] } }],
				});
				const writable = await handle.createWritable();
				await writable.write(new Blob([bytes as BlobPart], { type: mime }));
				await writable.close();
				new Notice(`Exported ${name}.`);
				return;
			} catch (err) {
				// A cancelled dialog throws AbortError — that's a choice, not a
				// failure, so it must not fall through to writing a file anyway.
				if ((err as { name?: string }).name === 'AbortError') return;
				console.error('Loom Loom: save dialog failed, falling back', err);
			}
		}
		try {
			const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
			const link = createEl('a');
			link.href = url;
			link.download = name;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
			new Notice(`Exported ${name}.`);
		} catch (err) {
			console.error('Loom Loom: export download failed, writing into the vault', err);
			const folder = file.parent?.path ?? '';
			const path = normalizePath(folder === '' ? name : `${folder}/${name}`);
			try {
				const existing = plugin.app.vault.getFileByPath(path);
				if (existing) await plugin.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer);
				else await plugin.app.vault.createBinary(path, bytes.buffer as ArrayBuffer);
				new Notice(`Exported to ${path}`);
			} catch (err2) {
				console.error('Loom Loom: export failed', err2);
				new Notice('Could not write the export. See console for details.');
			}
		}
	};

	/**
	 * Imports an external .fountain over this project's script.
	 *
	 * Destructive to the SCRIPT and only to the script: the current text is
	 * replaced wholesale. Entities are never touched — characters and locations
	 * already in the project keep their pages, descriptions and relationships,
	 * and the incoming script simply references them by name. Anything it names
	 * that doesn't exist yet is created.
	 *
	 * Scene notes are the subtle part, so the confirmation spells it out. An
	 * incoming file that still carries its `[[loom:…]]` markers re-attaches
	 * exactly. One that lost them (the export → edit elsewhere → import round
	 * trip) is matched back by heading text — see `reattachSceneIds`, the one
	 * place heuristics are the right answer. Whatever stays unmatched leaves its
	 * old Scene note behind as an orphan; nothing is deleted.
	 */
	const importScript = (raw: string, sourceName: string) => {
		// Matched against the CURRENT script rather than the Scene notes: it
		// carries the exact ids and the exact heading text, where a note's name
		// is a derived label the user may since have edited.
		const known = parsed.scenes
			.filter((sc): sc is ParsedScene & { loomId: string } => sc.loomId !== null)
			.map((sc) => ({ id: sc.loomId, heading: sc.heading }));
		// Top-level sections (chapters) need the same recovery: an export → edit
		// elsewhere → import round trip strips their `[[loom:…]]` markers too, and
		// without reattaching them every reimport orphaned the old Chapter notes
		// (silently losing their display titles).
		const knownSections = parsed.sections
			.filter((sec): sec is typeof sec & { loomId: string } => sec.level === 1 && sec.loomId !== null)
			.map((sec) => ({ id: sec.loomId, title: sec.text }));
		const incoming = parseFountain(raw);
		const sceneResult = reattachSceneIds(raw, known);
		const sectionResult = reattachSectionIds(sceneResult.text, knownSections);
		const result = { ...sceneResult, text: sectionResult.text };

		const known2 = new Set(
			plugin.indexer.getAll('character', project.root).map((r) => r.name.trim().toLowerCase())
		);
		const newCast = incoming.characters.filter((c) => !known2.has(c.trim().toLowerCase()));

		const lines = [
			`"${sourceName}" replaces the current script (${parsed.scenes.length} scenes, ${pageCount} pages) with ${incoming.scenes.length} scenes.`,
			'',
			'The script text is overwritten and cannot be undone from here.',
			'',
			'Your entities are NOT touched: characters and locations that already exist keep their pages, descriptions and relationships, and the imported script just references them. Anything new is created for you.',
		];
		if (newCast.length > 0) lines.push('', `New characters to create: ${newCast.join(', ')}.`);
		if (known.length > 0 || knownSections.length > 0) {
			lines.push(
				'',
				result.matched > 0
					? `${result.matched} scene note(s) re-attach to the imported scenes.`
					: 'No existing scene notes could be re-attached.',
				sectionResult.matched > 0
					? `${sectionResult.matched} chapter note(s) re-attach to the imported chapters.`
					: 'No existing chapter notes could be re-attached.',
				'Anything left without a match stays as an orphan — nothing is deleted.'
			);
		}

		new ConfirmModal(
			plugin.app,
			'Replace the script?',
			lines.join('\n'),
			() =>
				void (async () => {
					try {
						await plugin.app.vault.modify(file, result.text);
						onDisk.current = result.text;
						setText(result.text);
						committedFor.current = null;
						await commit(result.text);
						new Notice(`Imported ${incoming.scenes.length} scene(s) from "${sourceName}".`);
					} catch (err) {
						console.error('Loom Loom: import failed', err);
						new Notice('Could not import the script. See console for details.');
					}
				})(),
			'Replace script'
		).open();
	};

	/** Opens the OS file picker for a Fountain file and imports what comes back. */
	const pickImport = () => {
		const input = createEl('input', { type: 'file' });
		input.accept = '.fountain,.spmd,.txt';
		input.addEventListener('change', () => {
			const picked = input.files?.[0];
			if (!picked) return;
			void picked.text().then((raw) => importScript(raw, picked.name));
		});
		input.click();
	};

	/**
	 * The script's single action menu. One button rather than a row of icons:
	 * these are all "what to do with the file", and an "Export" label over a
	 * menu that also imports and opens externally was actively misleading.
	 *
	 * Note there is no "Open with…" entry: Electron exposes no cross-platform
	 * app-chooser dialog, so the honest options are the OS default app, or
	 * revealing the file so the system's own file manager can offer its "Open
	 * with" menu. Both hand over the LIVE file, which an external editor writes
	 * back to in place — so the loom ids are never stripped there. Stripping
	 * belongs to export, which produces a copy.
	 */
	const actionMenu = (e: ReactMouseEvent) => {
		const stem = file.basename;
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle('Open in the default app')
				.setIcon('external-link')
				.onClick(() => systemOpen('openWithDefaultApp', file.path))
		);
		menu.addItem((i) =>
			i
				.setTitle('Show in system file manager')
				.setIcon('folder-open')
				.onClick(() => systemOpen('showInFolder', file.path))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Export as PDF…')
				.setIcon('file-text')
				.onClick(() => void saveExport(`${stem}.pdf`, renderScreenplayPdf(parsed), 'application/pdf'))
		);
		menu.addItem((i) =>
			i
				.setTitle('Export as .fountain (no Loom ids)…')
				.setIcon('file-down')
				.onClick(() => void saveExport(`${stem}.fountain`, stripLoomIds(text), 'text/plain'))
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Import a script…').setIcon('file-up').onClick(pickImport));
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const titleField = (label: string, field: keyof TitlePage, placeholder = '') => (
		<label className="loom-field">
			<span className="loom-field-label">{label}</span>
			<input
				type="text"
				placeholder={placeholder}
				defaultValue={parsed.titlePage[field] as string}
				onBlur={(e) => {
					if (e.target.value !== parsed.titlePage[field]) setTitleField(field, e.target.value);
				}}
			/>
		</label>
	);

	// Scenes grouped under the chapter (top-level `#` section) they sit in.
	// Each group carries its section's own script line, so navigation can jump
	// to the `# Chapter` heading itself and not only to the scenes beneath it.
	const topSections = parsed.sections.filter((sec) => sec.level === 1);
	const sectionLineOf = (title: string, beforeLine: number) => {
		let best = -1;
		for (const sec of topSections) {
			if (sec.text.trim() === title && sec.line <= beforeLine) best = sec.line;
		}
		return best;
	};
	const groups: { section: string; line: number; scenes: ParsedScene[] }[] = [];
	for (const scene of parsed.scenes) {
		const section = scene.sectionPath[0]?.trim() ?? '';
		const last = groups[groups.length - 1];
		if (last && last.section === section) last.scenes.push(scene);
		else groups.push({ section, line: sectionLineOf(section, scene.line), scenes: [scene] });
	}

	return (
		<ViewShell
			view={view}
			project={project}
			title={`${project.name} — ${SCRIPT_LABEL}`}
			railActive="script"
			titleExtra={
				<div className="loom-script-actions">
					<span className="loom-script-stat">
						{parsed.scenes.length} scenes · {pageCount} pages
					</span>
					<button className="loom-rel-filter" aria-label="Script actions" onClick={actionMenu}>
						<Icon name="menu" fallback="more-horizontal" />
					</button>
				</div>
			}
		>
			<div className="loom-script-layout">
				{/* Script navigation. It OVERLAYS the working area rather than
				    sitting beside it — a permanent column stole width from the
				    page the whole time it was open. Chapters are jump targets
				    too: the script has a `# Chapter` line, so it's a place to go,
				    not a label. Unlike "Outline links" below, everything here
				    navigates within the SCRIPT rather than opening a page.
				    The zero-height sticky wrapper keeps the toggle (and the
				    panel, when open) pinned to the top of the scrolling view
				    instead of scrolling away with the title-page/toolbar above
				    the editor. */}
				<div className="loom-script-nav-sticky">
					<button
						className="loom-script-nav-toggle"
						aria-label={navOpen ? 'Hide navigation' : 'Show navigation'}
						onClick={() => setNavOpen(!navOpen)}
					>
						<Icon name={navOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
					</button>
					{navOpen ? (
						<aside className="loom-script-nav">
						<div className="loom-script-nav-head">
							Navigate
							<button
								className="loom-rel-filter"
								aria-label="Hide navigation"
								onClick={() => setNavOpen(false)}
							>
								<Icon name="chevron-left" />
							</button>
						</div>
						{groups.length === 0 ? <div className="loom-script-nav-empty">No scenes yet.</div> : null}
						{groups.map((group, gi) => (
							<div key={`${group.section}-${gi}`}>
								{group.section !== '' ? (
									<button
										className="loom-script-nav-chapter"
										disabled={group.line < 0}
										onClick={() => jumpToLine(group.line)}
										title={group.section}
									>
										{group.section}
									</button>
								) : null}
								{group.scenes.map((scene) => (
									<button
										key={scene.loomId ?? scene.line}
										className="loom-script-nav-scene"
										onClick={() => jumpToLine(scene.line)}
										title={scene.heading}
									>
										<span className="loom-script-nav-num">{scene.index}</span>
										<span className="loom-script-nav-text">{scene.heading}</span>
									</button>
								))}
							</div>
						))}
					</aside>
				) : null}
				</div>

				<div className="loom-script-main">
					<details className="loom-script-section">
						<summary>Title page</summary>
						<div className="loom-field-group">
							{titleField('Title', 'title', project.name)}
							{titleField('Credit', 'credit', 'Written by')}
							{titleField('Author', 'author')}
							{titleField('Draft date', 'draftDate')}
							{titleField('Source', 'source')}
							{titleField('Contact', 'contact')}
							{titleField('Copyright', 'copyright')}
							{/* `Notes:` is a real Fountain title-page key, so it stays —
							    but it's an author's note ABOUT the script, which no
							    renderer prints on the title page. That's why it never
							    shows up in the preview or the PDF. */}
							{titleField('Notes', 'notes')}
						</div>
					</details>

					<div className="loom-script-tabs loom-seg">
						<button
							className={mode === 'script' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
							onClick={() => setMode('script')}
						>
							Script
						</button>
						<button
							className={mode === 'pages' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
							onClick={() => setMode('pages')}
						>
							Pages preview
						</button>
					</div>

					<div className="loom-script-toolbar">
						<input
							className="loom-script-search"
							type="search"
							placeholder="Search the script…"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setMatchIndex(0);
							}}
							onKeyDown={(e) => {
								if (e.key !== 'Enter') return;
								e.preventDefault();
								gotoMatch(e.shiftKey ? matchIndex - 1 : matchIndex + 1);
							}}
						/>
						<button
							className="loom-rel-filter"
							aria-label="Previous match"
							disabled={matches.length === 0}
							onClick={() => gotoMatch(matchIndex - 1)}
						>
							<Icon name="chevron-up" />
						</button>
						<button
							className="loom-rel-filter"
							aria-label="Next match"
							disabled={matches.length === 0}
							onClick={() => gotoMatch(matchIndex + 1)}
						>
							<Icon name="chevron-down" />
						</button>
						{/* After the buttons, not before — so their position doesn't
						    shift when this text appears/disappears/changes length. */}
						<span className="loom-script-stat">
							{query.trim() === ''
								? ''
								: matches.length === 0
									? 'No matches'
									: `${(matchIndex % matches.length) + 1} of ${matches.length}`}
						</span>
						{mode === 'pages' ? (
							<>
								<div className="loom-shell-spacer" />
								<button
									className="loom-rel-filter"
									aria-label="Previous page"
									disabled={currentPage <= 1}
									onClick={() => scrollToPage(currentPage - 1)}
								>
									<Icon name="chevron-left" />
								</button>
								<input
									className="loom-script-pagenum"
									type="number"
									min={1}
									max={pageCount}
									value={pageDraft ?? currentPage}
									onChange={(e) => setPageDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key !== 'Enter') return;
										e.preventDefault();
										const n = Number(pageDraft);
										if (pageDraft && pageDraft.trim() !== '' && n > 0) scrollToPage(n);
										setPageDraft(null);
									}}
									onBlur={() => setPageDraft(null)}
								/>
								<span className="loom-script-stat">of {pageCount}</span>
								<button
									className="loom-rel-filter"
									aria-label="Next page"
									disabled={currentPage >= pageCount}
									onClick={() => scrollToPage(currentPage + 1)}
								>
									<Icon name="chevron-right" />
								</button>
							</>
						) : null}
					</div>

					{mode === 'pages' ? (
						// Every page in one scroller, like a PDF viewer: the page box
						// navigates by scrolling to a page rather than swapping which
						// one exists, so reading straight through still works.
						<div className="loom-screenplay" ref={pagesRef}>
							{titleFirst ? (
								// Mirrors the PDF's title page: title a third down,
								// credits under it, contact and draft date lower-left.
								<div className="loom-screenplay-page loom-sp-titlepage" data-page={1}>
									<div className="loom-sp-title">{parsed.titlePage.title}</div>
									{[parsed.titlePage.credit, parsed.titlePage.author, parsed.titlePage.source]
										.filter((v) => v.trim() !== '')
										.map((v, j) => (
											<div key={j} className="loom-sp-byline">
												{v}
											</div>
										))}
									<div className="loom-sp-lowerleft">
										{[parsed.titlePage.draftDate, parsed.titlePage.contact, parsed.titlePage.copyright]
											.filter((v) => v.trim() !== '')
											.map((v, j) => (
												<div key={j}>{v}</div>
											))}
									</div>
								</div>
							) : null}
							{bodyPages.map((elements, i) => {
								const number = i + (titleFirst ? 2 : 1);
								return (
									<div key={number} className="loom-screenplay-page" data-page={number}>
										<div className="loom-screenplay-pagenum">{number}.</div>
										{elements.map((el, j) =>
											el.type === 'scene-heading' ? (
												<p key={j} className="loom-sp-scene-heading">
													<span
														dangerouslySetInnerHTML={{
															__html: highlight(renderInline(elementText(el)), query),
														}}
													/>
													{el.sceneNumber ? (
														<span className="loom-sp-scene-num">{el.sceneNumber}</span>
													) : null}
												</p>
											) : (
												<p
													key={j}
													className={`loom-sp-${el.type}`}
													dangerouslySetInnerHTML={{
														__html: highlight(renderInline(elementText(el)), query),
													}}
												/>
											)
										)}
									</div>
								);
							})}
						</div>
					) : (
						<>
							<textarea
								ref={editorRef}
								className="loom-script-editor"
								spellCheck={false}
								value={text}
								onChange={(e) => setText(e.target.value)}
								onBlur={() => void commit(text)}
							/>
							<span className="loom-field-hint">
								Plain Fountain for now — live preview with clickable character and location links is
								the next step. Scene ids are written into the headings and never reach an export.
							</span>
						</>
					)}

					<details className="loom-script-section">
						<summary>Outline links ({parsed.scenes.length})</summary>
						{groups.length === 0 ? (
							<div className="loom-attendance-empty">
								No scenes yet — a heading like <code>INT. HOUSE - DAY</code> starts one.
							</div>
						) : null}
						{groups.map((group, gi) => (
							<div key={`${group.section}-${gi}`} className="loom-hub-section">
								{group.section !== '' ? (
									<span className="loom-rel-group-label">{group.section}</span>
								) : null}
								<div className="loom-script-scenes">
									{group.scenes.map((scene) => {
										const note = sceneNote(scene);
										return (
											<div key={scene.loomId ?? scene.line} className="loom-script-scene">
												<span className="loom-script-scene-num">{scene.index}</span>
												<span className="loom-script-scene-head">
													{note ? (
														<button
															className="loom-subloc-link"
															onClick={() => view.openEntity(note.path)}
														>
															{scene.heading}
														</button>
													) : (
														scene.heading
													)}
												</span>
												<span className="loom-script-scene-no">{scene.sceneNumber}</span>
												<span className="loom-script-scene-page">p. {scenePages(scene)}</span>
												<span className="loom-script-scene-cast">{scene.characters.join(', ')}</span>
											</div>
										);
									})}
								</div>
							</div>
						))}
					</details>

					{chapterless.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">Scenes without a chapter</span>
							<div className="loom-tag-row">
								{chapterless.map((s) => (
									<span key={s.loomId ?? s.line} className="loom-chip">
										{s.heading}
									</span>
								))}
							</div>
							<span className="loom-field-hint">
								A scene belongs to the <code>#</code> section it sits under — that is its chapter, and
								where its writing lives. Add a <code># Chapter name</code> line above these.
							</span>
						</div>
					) : null}

					{orphans.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">Scenes no longer in the script</span>
							<div className="loom-tag-row">
								{orphans.map((o) => (
									<button key={o.path} className="loom-chip" onClick={() => view.openEntity(o.path)}>
										{o.name}
									</button>
								))}
							</div>
							<span className="loom-field-hint">
								Their headings are gone from the script. Nothing is deleted automatically — open one to
								keep or remove it.
							</span>
						</div>
					) : null}
				</div>
			</div>
		</ViewShell>
	);
}

/**
 * Wraps search matches in `<mark>` inside already-rendered HTML.
 *
 * Splits on tags first so a query like "strong" can't match inside `<strong>`
 * and corrupt the markup.
 */
function highlight(html: string, query: string): string {
	const needle = query.trim();
	if (needle === '') return html;
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(escaped, 'gi');
	return html
		.split(/(<[^>]*>)/)
		.map((part) => (part.startsWith('<') ? part : part.replace(re, (m) => `<mark>${m}</mark>`)))
		.join('');
}

/**
 * The project's script text, kept current.
 *
 * Lets a Scene page show its own stretch of the script without duplicating any
 * of it into the note: the .fountain file stays the single source of the
 * writing, and the note carries only the metadata around it.
 */
export function useScriptText(plugin: LoomLoomPlugin, project: ProjectDef | null): string | null {
	const [text, setText] = useState<string | null>(null);
	const path = project ? scriptFilePath(project) : null;
	useEffect(() => {
		if (path === null) return;
		let cancelled = false;
		const read = () => {
			const scriptFile = plugin.app.vault.getFileByPath(path);
			if (!scriptFile) {
				setText(null);
				return;
			}
			void plugin.app.vault.cachedRead(scriptFile).then((raw) => {
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

/** The lines of the script belonging to one scene, by its loom id. */
export function sceneScriptText(script: string | null, sceneId: string): string | null {
	if (script === null || sceneId === '') return null;
	const parsed = parseFountain(script);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	if (!scene) return null;
	return script
		.split(/\r?\n/)
		.slice(scene.line, scene.endLine)
		.join('\n')
		.replace(/\s+$/, '');
}

/**
 * Re-writes the script's centered chapter-title lines from the Chapter notes.
 *
 * Called when a display title is edited on a Chapter page, where the script
 * view may not even be open — without it the note and the script would silently
 * disagree until the script was next touched.
 */
export async function pushChapterTitles(plugin: LoomLoomPlugin, project: ProjectDef): Promise<void> {
	const scriptFile = findScriptFile(plugin, project);
	if (!scriptFile) return;
	const titles = new Map<string, string>();
	for (const chapter of plugin.indexer.getAll('chapter', project.root)) {
		if (chapter.chapterId !== '') {
			titles.set(chapter.chapterId, chapter.displayTitle.trim() !== '' ? chapter.displayTitle : chapter.name);
		}
	}
	if (titles.size === 0) return;
	try {
		const raw = await plugin.app.vault.read(scriptFile);
		const next = applyDisplayTitles(raw, titles);
		if (next !== raw) await plugin.app.vault.modify(scriptFile, next);
	} catch (e) {
		console.error('Loom Loom: could not write chapter titles into the script', e);
	}
}

/**
 * Applies a change to the project's script file.
 *
 * The Scene page edits its own stretch of the script through this — the page is
 * a focused window onto the file rather than a copy of it, so there is exactly
 * one home for the writing and no sync to get wrong.
 */
export async function editScript(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	const scriptFile = findScriptFile(plugin, project);
	if (!scriptFile) return false;
	try {
		const raw = await plugin.app.vault.read(scriptFile);
		const next = apply(raw);
		if (next === null || next === raw) return false;
		await plugin.app.vault.modify(scriptFile, next);
		return true;
	} catch (e) {
		console.error('Loom Loom: could not edit the script', e);
		new Notice('Could not write to the script.');
		return false;
	}
}

/**
 * Like `editScript`, but also re-syncs Scene/Chapter notes from the result.
 *
 * `editScript` alone only rewrites the .fountain file — the notes' derived
 * fields (chapter link, location, cast, script order, …) are otherwise
 * re-synced only when the Script view itself is open and commits. Structural
 * edits made from elsewhere (the Chapter/Scene pages' own move/reorder/
 * delete/heading actions) need that sync to happen immediately, or the note
 * silently disagrees with the script until the Script view is next opened —
 * which is what made "move to another chapter" look broken from the Scene
 * page: the script moved, but the note's own chapter link never updated.
 */
export async function editScriptAndSync(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	// Renumbering rides along with every structural edit: a move/reorder
	// physically relocates a scene's block, number included, so an existing
	// `#N#` numbering scheme is kept sequential rather than traveling with
	// the scene to its new, wrong position. A script with no numbers at all
	// is untouched (`renumberScenes` is a no-op when nothing is numbered).
	const changed = await editScript(plugin, project, (raw) => {
		const applied = apply(raw);
		return applied === null ? null : renumberScenes(applied);
	});
	if (changed) {
		const scriptFile = findScriptFile(plugin, project);
		if (scriptFile) {
			const raw = await plugin.app.vault.read(scriptFile);
			await syncScenes(plugin, project, parseFountain(raw));
		}
	}
	return changed;
}
