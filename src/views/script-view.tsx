import { Menu, Notice, TFile, normalizePath } from 'obsidian';
import { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { t, tn } from '../i18n';
import {
	EntityRecord,
	EntityType,
	FM,
	SCRIPT_EXTENSION,
	SCRIPT_ICON,
	VIEW_SCRIPT,
	entityPlural,
	pcGroupStub,
	scriptLabel,
} from '../types';
import {
	AnnotationSpan,
	FountainElement,
	ParsedScene,
	ParsedScript,
	TitlePage,
	appendPageBreak,
	applyBranchLabels,
	applyDisplayTitles,
	cleanAnnotationMarkers,
	elementText,
	ensureSceneIds,
	findAnnotationSpans,
	findEntityLinks,
	hasTitlePage,
	liveAnnotationIds,
	liveSceneIds,
	moveSceneToSection,
	nextTopSectionLine,
	parseFountain,
	preventOrphans,
	reattachSceneIds,
	reattachSectionIds,
	removeAct,
	removePageBreak,
	removeScene,
	renderInline,
	renumberScenes,
	sceneEndLine,
	reorderScenesInSection,
	reorderTopLevelEntries,
	stripAnnotationMarkers,
	stripEntityLinksForDisplay,
	stripLoomIds,
	renderTitlePage,
	splitLocationSub,
	splitTitlePage,
	wrapAnnotationMarkersForDisplay,
} from '../fountain';
import { AltTextEntry, CommentEntry, mutateScriptNotes, useScriptNotes } from './script-notes';
import { pdfPages, renderScreenplayPdf } from '../pdf';
import { ProjectDef, linkTargetOf } from '../indexer';
import { setLoomKey } from '../fm';
import {
	AltTextModal,
	ConfirmModal,
	CreateEntityModal,
	TextInputModal,
	createEntity,
	entityFileName,
	purgeEntityReferences,
} from '../project';
import { LoomFileReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage, scrollIntoContainer } from './common';
import { CommentPopover } from './annotation-popover';
import { useIndexVersion } from './hooks';
import { FountainField, FountainFieldHandle } from './fountain-field';
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
		return this.file ? `${this.file.basename} — ${scriptLabel()}` : scriptLabel();
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
	parsed: ParsedScript,
	text: string
): Promise<void> {
	const lines = text.split(/\r?\n/);
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
	const factions = byName('faction');
	const items = byName('item');
	// EVERY location, sublocations included — unlike `mainLocations` below, an
	// `@[...]` mention names a specific place directly rather than a heading's
	// "main location" part, so it can legitimately name a sublocation.
	const allLocations = byName('location');
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

	// Acts come from the script's `#` sections — the TOP level of a scene's
	// section path, since `# Act` is what the user writes. Unlike characters
	// and locations (shared entities that may already exist elsewhere), acts
	// are structural: the script owns them, so they're created automatically,
	// exactly like the scenes themselves.
	// Acts are matched by their section's `[[loom:…]]` id, never by title —
	// renaming `# ACT ONE` to `# ACT I` must move the same act, not orphan
	// it and create a second one. The SCRIPT owns the title: the note is renamed
	// to follow its section, while the note owns `loomDisplayTitle`, which is
	// written back into the script (see `applyDisplayTitles`).
	const actsById = new Map<string, EntityRecord>();
	for (const record of plugin.indexer.getAll('act', project.root)) {
		if (record.actId !== '') actsById.set(record.actId, record);
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

	const actById = new Map<string, EntityRecord>();
	for (const [id, section] of sectionsById) {
		const found = actsById.get(id);
		if (found) {
			// Acts order by their position in the script, so moving a section
			// reorders them without anyone dragging anything.
			if (found.seq !== section.seq || found.name !== section.title) {
				const actFile = plugin.app.vault.getFileByPath(found.path);
				if (actFile) {
					const renamed = found.name !== section.title;
					await plugin.app.fileManager.processFrontMatter(
						actFile,
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
					// Act page's own Title field).
					if (renamed) {
						const base = entityFileName(project, 'act', section.title);
						const dir = actFile.parent?.path ?? '';
						let newPath = normalizePath(dir === '' ? `${base}.md` : `${dir}/${base}.md`);
						for (let i = 2; plugin.app.vault.getAbstractFileByPath(newPath) !== null; i++) {
							newPath = normalizePath(dir === '' ? `${base} ${i}.md` : `${dir}/${base} ${i}.md`);
						}
						if (newPath !== actFile.path) {
							try {
								await plugin.app.fileManager.renameFile(actFile, newPath);
							} catch (e) {
								console.error('Loom Loom: act rename failed', e);
							}
						}
					}
				}
			}
			actById.set(id, found);
			continue;
		}
		const created = await createEntity(plugin, project, 'act', {
			name: section.title,
			tag: '',
			date: '',
			description: '',
		});
		await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.actId, id);
			setLoomKey(fm, FM.seq, section.seq);
		});
		// The index hasn't caught the new file yet — stand in a record shaped
		// just enough for `linkTargetOf` and the lookups below.
		actById.set(id, {
			...pcGroupStub(project.root),
			path: created.path,
			name: section.title,
			type: 'act',
		});
	}

	for (const scene of parsed.scenes) {
		if (scene.loomId === null) continue;
		const name = sceneName(scene);
		const act = actById.get(sectionIdOf(scene));
		const location = await resolveSceneLocation(scene);

		// Entities named via `@[...]` anywhere in the scene's own text — the
		// scene's own bounded line span (never the next act's), same
		// slicing `sceneScriptText` uses.
		const mentions = findEntityLinks(lines.slice(scene.line, sceneEndLine(parsed, scene)).join('\n'));
		const dedupe = (records: EntityRecord[]) => [...new Map(records.map((r) => [r.path, r])).values()];
		const cast = dedupe([
			...scene.characters.map((c) => characters.get(c.trim().toLowerCase())).filter((c): c is EntityRecord => c !== undefined),
			// A character merely mentioned in action text (never cued to speak)
			// still belongs in the cast — the field means "who's in this scene",
			// not "who has a line".
			...mentions.map((m) => characters.get(m.name.toLowerCase())).filter((c): c is EntityRecord => c !== undefined),
		]);
		const factionsHere = dedupe(
			mentions.map((m) => factions.get(m.name.toLowerCase())).filter((f): f is EntityRecord => f !== undefined)
		);
		const itemsHere = dedupe(
			mentions.map((m) => items.get(m.name.toLowerCase())).filter((i): i is EntityRecord => i !== undefined)
		);
		// Excludes the scene's own heading location — that one is already
		// `sceneLocation`, not a "mention".
		const mentionedLocations = dedupe(
			mentions
				.map((m) => allLocations.get(m.name.toLowerCase()))
				.filter((l): l is EntityRecord => l !== undefined && l.path !== location?.path)
		);

		const apply = (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.sceneId, scene.loomId);
			setLoomKey(fm, FM.sceneIntExt, scene.intExt);
			setLoomKey(fm, FM.sceneTime, scene.timeOfDay);
			// Visible links, so a scene connects to its place and its cast in the
			// graph without any extra wiring.
			setLoomKey(fm, FM.sceneLocation, location ? `[[${linkTargetOf(location)}]]` : '');
			// The act link is what stacks the scene under it in the graph and
			// timeline — `buildColumns` takes any connection to an anchor.
			setLoomKey(fm, FM.sceneAct, act ? `[[${linkTargetOf(act)}]]` : '');
			// A raw id, not a link — there's no Branch note to point at.
			setLoomKey(fm, FM.sceneBranch, scene.branchLoomId ?? '');
			setLoomKey(
				fm,
				FM.sceneCast,
				cast.map((c) => `[[${linkTargetOf(c)}]]`)
			);
			setLoomKey(
				fm,
				FM.sceneFactions,
				factionsHere.map((f) => `[[${linkTargetOf(f)}]]`)
			);
			setLoomKey(
				fm,
				FM.sceneItems,
				itemsHere.map((i) => `[[${linkTargetOf(i)}]]`)
			);
			setLoomKey(
				fm,
				FM.sceneMentionedLocations,
				mentionedLocations.map((l) => `[[${linkTargetOf(l)}]]`)
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
			const sameLinks = (existingLinks: string[], records: EntityRecord[]) =>
				existingLinks.length === records.length && records.every((r, i) => existingLinks[i] === linkTargetOf(r));
			const clean =
				record.name === name &&
				record.sceneAct === (act ? linkTargetOf(act) : '') &&
				record.sceneBranch === (scene.branchLoomId ?? '') &&
				record.sceneIntExt === scene.intExt &&
				record.sceneTime === scene.timeOfDay &&
				record.sceneLocation === (location ? linkTargetOf(location) : '') &&
				record.seq === scene.index &&
				sameLinks(record.sceneCast, cast) &&
				sameLinks(record.sceneFactions, factionsHere) &&
				sameLinks(record.sceneItems, itemsHere) &&
				sameLinks(record.sceneMentionedLocations, mentionedLocations);
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

/** A search match is either a plain text hit, a hit inside a comment's body,
 *  or a hit inside one of an alt-text's OPTIONS (not necessarily the
 *  currently active one) — comment/alt matches come from the sidecar, not
 *  the document text, so they need their own kinds rather than a bare
 *  offset. Shared by the main Script view and the Scene/Act pages' own
 *  search (entity-view.tsx), so all three branch on match kind identically. */
export type ScriptSearchMatch =
	| { kind: 'text'; offset: number }
	| { kind: 'comment'; id: string }
	| { kind: 'altOption'; id: string; optionIndex: number };

/** A scene's display name: the heading without its INT./EXT. prefix. */
function sceneName(scene: ParsedScene): string {
	const place = scene.location.trim() === '' ? t('project.createEntity.untitledScene') : scene.location.trim();
	return scene.timeOfDay.trim() === '' ? place : `${place} — ${scene.timeOfDay.trim()}`;
}

function Script({ view }: { view: ScriptView }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
	const file = view.file;
	const project = file ? plugin.indexer.projectForPath(file.path) : undefined;

	const [text, setText] = useState<string | null>(null);
	/** Which pane the main area shows. Script/Pages are the paired toggle;
	 *  Outline is a separate button on the far right of the same row (not
	 *  part of that pill) that swaps in an act/scene drag-reorder tree
	 *  instead. Remembered per file in `localStorage` — a UI preference, not
	 *  vault data, same reasoning as the editor's own resized-height memory
	 *  below — so reopening a script comes back to whichever pane was last
	 *  open rather than always resetting to Script. */
	const [mode, setMode] = useState<'script' | 'pages' | 'outline'>(() => {
		const saved = file ? window.localStorage.getItem(`loom-script-mode:${file.path}`) : null;
		return saved === 'pages' || saved === 'outline' ? saved : 'script';
	});
	/** Outline drag-reorder — same pointer-drag shape as the Act page's
	 *  own scene reorder, generalized with a `group` key so it serves BOTH
	 *  the top-level act list ('acts') and each act's own nested
	 *  scene list ('scenes:<actId>'), the same trick `seqGrip` in
	 *  entity-view.tsx uses for its several independent drag lists — scoped
	 *  locally here since this view has more than one now. `hoverActId`
	 *  is only meaningful mid-drag on a SCENE group: which act the
	 *  pointer is currently over, tracked separately from `over` (the
	 *  within-source-list insert index) so a scene can be dropped into a
	 *  DIFFERENT act — appended there — instead of only ever reordering
	 *  inside the one it started in. */
	const [outlineDrag, setOutlineDrag] = useState<{
		group: string;
		from: number;
		over: number;
		dy: number;
		hoverActId?: string;
	} | null>(null);
	const outlineDragRef = useRef<{
		startY: number;
		slot: number;
		mids: number[];
		/** Every act's own on-screen block, captured once at drag start
		 *  (siblings only shift via CSS transform during a drag, never
		 *  reflow, so this stays accurate for the drag's whole duration) —
		 *  only populated when dragging a SCENE, used to tell which act
		 *  the pointer is currently over. */
		actRects?: { id: string; top: number; bottom: number }[];
	} | null>(null);
	/** Acts currently collapsed in the Outline panel (hiding their nested
	 *  scenes) — an Act/loom-id set, default empty (everything expanded). */
	const [collapsedActs, setCollapsedActs] = useState<Set<string>>(new Set());
	/** Page shown in the pages preview (1-based) — remembered per file in
	 *  `localStorage`, same UI-preference reasoning as `mode` just below, so
	 *  reopening a script left on Pages mode restores the actual page rather
	 *  than always landing back on page 1 (the scroll-restore effect further
	 *  down is what turns this remembered number into an actual scroll on
	 *  first mount; this state alone only drives the readout/nav math). */
	const [page, setPage] = useState(() => {
		const saved = file ? window.localStorage.getItem(`loom-script-page:${file.path}`) : null;
		const n = saved ? Number(saved) : NaN;
		return Number.isFinite(n) && n >= 1 ? n : 1;
	});
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
	/** The Comments/Alternatives browser panels — same overlaid-panel slot as
	 *  the nav panel (mutually exclusive with it and each other, so opening
	 *  one always closes the other two: `openSidePanel` below). */
	const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
	const [altPanelOpen, setAltPanelOpen] = useState(false);
	const openSidePanel = (panel: 'nav' | 'comments' | 'alt' | null) => {
		setNavOpen(panel === 'nav');
		setCommentsPanelOpen(panel === 'comments');
		setAltPanelOpen(panel === 'alt');
	};
	/** The nav/comments/alt aside panels' shared wrapper — closes whichever is
	 *  open on an outside click, same as any other popover/menu in this app.
	 *  A click on one of the toolbar's own toggle buttons (outside this
	 *  wrapper) still composes correctly: this listener closes the current
	 *  panel first, then the button's own `onClick` runs immediately after
	 *  and opens whichever one it's for — same net result as if only one
	 *  handler had fired. */
	const sidePanelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!navOpen && !commentsPanelOpen && !altPanelOpen) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (sidePanelRef.current && !sidePanelRef.current.contains(e.target as Node)) openSidePanel(null);
		};
		document.addEventListener('mousedown', onDocMouseDown, true);
		return () => document.removeEventListener('mousedown', onDocMouseDown, true);
	}, [navOpen, commentsPanelOpen, altPanelOpen]);
	/** The Title page `<details>` — a plain native element (its open/closed
	 *  state isn't otherwise tracked in React), so jumping to it means
	 *  reaching through this ref rather than the line-based `jumpToLine`
	 *  every other nav target uses; it renders above the Script/Pages/Outline
	 *  tabs regardless of mode, so opening it is the same act in all three. */
	const titleDetailsRef = useRef<HTMLDetailsElement | null>(null);
	const [matchIndex, setMatchIndex] = useState(0);
	/** A marker id the CURRENT search match points at — highlights an
	 *  alt-text's icon, or a comment's icon while its popover is being
	 *  auto-opened. Cleared on a plain text match. */
	const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);
	/** Guards against writing back the text we just read. */
	const loadedFor = useRef<string | null>(null);
	/** The text last written to (or read from) disk, so a no-op commit doesn't
	 *  rewrite the file — a rewrite re-uploads it through the user's sync. */
	const onDisk = useRef<string | null>(null);
	/** Paths already given their one post-load commit pass. */
	const committedFor = useRef<string | null>(null);
	/** Serializes every `commit` call — each one does real async work
	 *  (`vault.modify`, `syncScenes`), and without a queue two overlapping
	 *  calls could interleave their disk writes out of order. Concretely: the
	 *  live editor unmounts on every Script → Pages/Outline switch, and CM6
	 *  losing focus as part of that teardown fires `onBlur` (its own
	 *  `commit(text)`, using whatever text was current at that moment); an
	 *  action taken right after switching — e.g. the toolbar's own
	 *  "+ New act" — starts a SECOND commit with the new content. Without
	 *  ordering, if the first (older, unmount-triggered) commit's
	 *  `vault.modify` happened to land after the second's, it silently wrote
	 *  the OLDER content back over the just-added act — even though
	 *  `syncScenes` inside the second commit had already created its note,
	 *  leaving an act note with nothing backing it in the script. Queuing
	 *  guarantees commits land on disk in the order they were REQUESTED. */
	const commitQueue = useRef<Promise<void>>(Promise.resolve());
	/** The resizable wrapper around the live-preview editor (for the
	 *  height-memory effect below) — not the editor itself, which is a CM6
	 *  view mounted by `FountainField`, not a native resizable textarea. */
	const editorWrapperRef = useRef<HTMLDivElement | null>(null);
	const fountainFieldRef = useRef<FountainFieldHandle | null>(null);
	const pagesRef = useRef<HTMLDivElement | null>(null);
	/** Comment bodies + alt-text option lists, project-level (Entities/Script
	 *  Notes/<Project> Script Notes.json) — kept live via `useScriptNotes`
	 *  the same way `text` itself is kept live against the .fountain file. */
	const scriptNotes = useScriptNotes(plugin, project ?? null);
	/** Which comment's popover is open, and where to anchor it — `null` when
	 *  none. Only ONE at a time, closed by the popover's own outside-click. */
	const [openComment, setOpenComment] = useState<{ id: string; rect: DOMRect } | null>(null);
	/** Marker ids that have had a reply added THIS session, checked by
	 *  `handleCloseComment` instead of `scriptNotes.comments` directly —
	 *  `scriptNotes` only catches up once the sidecar's own `vault.modify` +
	 *  file-watch round trip completes, so trusting it at close time would
	 *  misjudge a comment added and then immediately closed away from
	 *  (within that round trip's window) as never having been written. */
	const commentsWithNewEntryRef = useRef<Set<string>>(new Set());
	/** `openComment.rect` is a one-time snapshot — without this, scrolling
	 *  the editor/pages content left the popover floating in the same screen
	 *  spot while the commented text scrolled out from under it. While a
	 *  comment popover is open, re-measure its icon's rect on every scroll
	 *  and follow it (closing if the icon can no longer be found, e.g. a
	 *  mode switch unmounted it). Capture phase on `document` — 'scroll'
	 *  doesn't bubble, so this is the only way to hear about a scroll on
	 *  some nested scrollable ancestor without knowing which one. */
	useEffect(() => {
		if (!openComment) return;
		const id = openComment.id;
		const track = () => {
			const editorContainer = editorWrapperRef.current;
			const pagesContainer = pagesRef.current;
			const icon =
				editorContainer?.querySelector(`[data-loom-annotation-id="${id}"]`) ??
				pagesContainer?.querySelector(`[data-loom-annotation-id="${id}"]`);
			if (!(icon instanceof HTMLElement)) {
				setOpenComment(null);
				return;
			}
			// The icon can still be IN THE DOM (and so pass the check above) while
			// scrolled fully outside its own container's visible viewport — e.g.
			// the CM6 gutter icon of a comment several screens up. Repositioning
			// the popover to that clamped, effectively-arbitrary spot is what put
			// it overlapping the tabs/search bar above the editor; closing it
			// instead matches the icon actually leaving view.
			const container = editorContainer?.contains(icon) ? editorContainer : pagesContainer;
			const rect = icon.getBoundingClientRect();
			if (container) {
				const containerRect = container.getBoundingClientRect();
				if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
					setOpenComment(null);
					return;
				}
			}
			setOpenComment((prev) => (prev && prev.id === id ? { id, rect } : prev));
		};
		document.addEventListener('scroll', track, true);
		return () => document.removeEventListener('scroll', track, true);
	}, [openComment?.id]);
	/** The Outline panel's own root — scoped lookups for every act's
	 *  on-screen block (`[data-act-id]`) during a scene drag read from
	 *  here rather than the whole document. */
	const outlineRef = useRef<HTMLDivElement | null>(null);
	/** The Script/Pages/Outline tabs row — clicking any of the three scrolls
	 *  the outer view so this row lands at the top, same as Pages preview
	 *  already did as a side effect of its own internal `scrollIntoView`
	 *  (bringing a page element into view drags every scrollable ancestor,
	 *  the outer shell body included). Script and Outline had no such effect
	 *  of their own, so this makes it deliberate and uniform across all
	 *  three — including a re-click on the pane that's already active, which
	 *  `switchMode`'s own same-mode early return would otherwise skip. */
	const tabsRef = useRef<HTMLDivElement | null>(null);
	/** A script line to land on once the Script pane is back — set when
	 *  leaving Pages mode, consumed by the effect below once `FountainField`
	 *  has remounted (it's torn down and rebuilt on every mode switch, so
	 *  the scroll has to be applied after the fact, not inline). Also
	 *  DOUBLES as the initial-open restore: seeded from `loom-script-line:
	 *  <path>` in `localStorage` (the Script editor's own last-scrolled line,
	 *  persisted on blur below) so a freshly-opened script — not just a
	 *  Pages→Script toggle within the same session — lands back where the
	 *  cursor was left rather than always at the top. The consuming effect
	 *  below doesn't care which of the two set it. */
	const pendingScrollLineRef = useRef<number | null>(
		(() => {
			if (!file) return null;
			const saved = window.localStorage.getItem(`loom-script-line:${file.path}`);
			const n = saved ? Number(saved) : NaN;
			return Number.isFinite(n) && n >= 0 ? n : null;
		})()
	);
	/** Same idea as `pendingScrollLineRef` just above, for the Comments/
	 *  Alternatives browser panels' own "jump to this text" action, which
	 *  needs a real SELECTION (not just a scroll position) and can be
	 *  triggered from Pages or Outline mode, not only Script. */
	const pendingSelectRangeRef = useRef<{ from: number; to: number } | null>(null);
	useEffect(() => {
		if (mode !== 'script') return;
		const range = pendingSelectRangeRef.current;
		if (!range) return;
		pendingSelectRangeRef.current = null;
		fountainFieldRef.current?.selectRange(range.from, range.to);
	}, [mode]);

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

	// Outline isn't an editing surface (unlike Script's live CM6 field, which
	// must never have its value rewritten out from under an active cursor —
	// see above), so it can safely re-sync from disk whenever it becomes the
	// active pane. Without this, a structural edit made from somewhere ELSE
	// (a Scene/Act page's own delete button, say) never reached this
	// component's `text` state, and the Outline kept showing the pre-delete
	// tree until the whole view happened to remount.
	useEffect(() => {
		if (mode !== 'outline' || !file) return;
		let cancelled = false;
		void plugin.app.vault.read(file).then((raw) => {
			if (cancelled || raw === onDisk.current) return;
			onDisk.current = raw;
			setText(raw);
		});
		return () => {
			cancelled = true;
		};
	}, [mode, plugin, file]);

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

	// Remembers the editor's manually-resized height across reloads — a UI
	// preference, not vault data, so it's kept in localStorage rather than
	// project settings. Restored before the ResizeObserver starts watching so
	// its own initial callback doesn't immediately overwrite what we just set.
	// This resizes the WRAPPER (plain CSS `resize: vertical`), not the CM6
	// view mounted inside it — a live-preview editor has no native resize
	// handle the way a `<textarea>` does.
	useEffect(() => {
		if (mode !== 'script' || !file) return;
		const editor = editorWrapperRef.current;
		if (!editor) return;
		const key = `loom-writer-editor-height:${file.path}`;
		const saved = window.localStorage.getItem(key);
		if (saved) editor.style.height = saved;
		const observer = new ResizeObserver(() => {
			if (editor.style.height) window.localStorage.setItem(key, editor.style.height);
		});
		observer.observe(editor);
		return () => observer.disconnect();
	}, [file?.path, mode]);

	// Persists the mode-per-file memory above — separate from the read, which
	// only needs to happen once (the lazy `useState` initializer), while this
	// needs to re-fire on every later switch.
	useEffect(() => {
		if (!file) return;
		window.localStorage.setItem(`loom-script-mode:${file.path}`, mode);
	}, [file?.path, mode]);

	// Persists the Pages-mode page number the same way — `page` changes both
	// on explicit navigation and on the scroll-tracking effect below, so
	// whichever page the user last actually had on screen is what's saved.
	useEffect(() => {
		if (!file) return;
		window.localStorage.setItem(`loom-script-page:${file.path}`, String(page));
	}, [file?.path, page]);

	// Restores the remembered scroll position ONCE, the first time Pages mode
	// has something rendered to scroll to — covers reopening a file that was
	// left on Pages mode (mode/page both come back from localStorage via their
	// lazy initializers above, but nothing has actually scrolled the container
	// yet). Guarded so it never re-fires on a later, ordinary mode switch —
	// `switchMode` already handles restoring position for that case itself.
	const restoredInitialPage = useRef(false);
	useEffect(() => {
		if (restoredInitialPage.current || mode !== 'pages') return;
		const container = pagesRef.current;
		if (!container) return;
		const el = container.querySelector(`[data-page="${page}"]`);
		if (!(el instanceof HTMLElement)) return; // pages not rendered yet this tick
		restoredInitialPage.current = true;
		if (page === 1) return; // already there, nothing to scroll
		scrollIntoContainer(container, el, 'auto');
	}, [mode, page, text]);

	// Script/Pages scroll sync (the other direction, script view -> pages,
	// happens inline in `switchMode` below since the pages DOM only needs a
	// scrollIntoView, not a freshly-mounted CM6 view to hand a ref to).
	// Also applies the initial-open restore seeded into `pendingScrollLineRef`
	// above — `text` is in the dependency list for that case specifically:
	// the ref's value is already set by the time this component FIRST
	// commits (still showing the "Loading…" placeholder, before `text` has
	// loaded), so `fountainFieldRef.current` is still null then; without
	// retrying once `text` actually arrives (and `FountainField` exists to
	// scroll), the pending line would never get consumed.
	useEffect(() => {
		if (mode !== 'script') return;
		const line = pendingScrollLineRef.current;
		if (line === null) return;
		const field = fountainFieldRef.current;
		if (!field) return; // not mounted yet — retry on the next relevant render
		pendingScrollLineRef.current = null;
		field.scrollToLine(line);
	}, [mode, text]);

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
	// The PDF's real typeset layout of the whole document — memoized on
	// `parsed` (not recomputed inline in the render body) so unrelated
	// re-renders that never touch the text — outline drag pointer-move, panel
	// toggles, … — don't redo it. Must sit above the early-return guards below
	// so this hook always runs, same reasoning as `parsed` just above.
	const bodyPages = useMemo(() => (parsed === null ? [] : pdfPages(parsed)), [parsed]);

	/**
	 * Writes the script, gives every heading an id, and mirrors the scenes into
	 * notes. Both steps are idempotent and purely additive.
	 *
	 * Deliberately NOT debounced-while-typing: `ensureSceneIds` appends
	 * `[[loom:…]]` to heading lines, and rewriting the textarea's value mid-edit
	 * would yank the caret to the end. It runs on load and on blur instead, so
	 * the text only changes underneath the user when they've stopped typing.
	 */
	const runCommit = async (raw: string) => {
		if (!file || !project) return;
		const withIds = ensureSceneIds(raw);
		// Keeps an existing #N# production-numbering scheme sequential even when
		// the scene was added by plain typing here, not through a structural
		// drag/move action — a no-op when nothing in the script is numbered.
		const renumberedRaw = renumberScenes(withIds.text);
		// Strips any LONE surviving comment/alt-text marker (a partial delete
		// took out only one half of a pair) — must run before either write
		// point below, and its output has to flow through both, or a stray
		// token from an OLDER commit could linger even after this one lands.
		const cleaned = cleanAnnotationMarkers(renumberedRaw);
		const renumbered = cleaned.text;
		const changed = withIds.changed || renumbered !== withIds.text;
		if (renumbered !== onDisk.current) {
			await plugin.app.vault.modify(file, renumbered);
			onDisk.current = renumbered;
		}
		if (changed) setText(renumbered);
		await syncScenes(plugin, project, parseFountain(renumbered), renumbered);

		// The one thing that flows the other way: an act's display title.
		// Fountain sections never export, so a title that must appear in the PDF
		// has to be emitted as a separate centered-bold line — the note owns it,
		// and this is what puts it into the script. Falls back to the act's
		// own name (the `#` section's title) when the display title is left
		// blank, so the exported line is never simply dropped — a blank display
		// title always renders something, and a script re-imported later still
		// carries a title to reattach against.
		const titles = new Map<string, string>();
		for (const act of plugin.indexer.getAll('act', project.root)) {
			if (act.actId !== '') {
				titles.set(act.actId, act.displayTitle.trim() !== '' ? act.displayTitle : act.name);
			}
		}
		// Branch sections get the same treatment, auto-derived from their own
		// title text rather than a note field — there's no Branch note to own
		// one — so a branch's printed marker stays in sync purely from its
		// heading, kept separate from the act-title pass above.
		const titled = applyBranchLabels(applyDisplayTitles(renumbered, titles));
		if (titled !== onDisk.current) {
			await plugin.app.vault.modify(file, titled);
			onDisk.current = titled;
			setText(titled);
		}

		// Prune the sidecar of any comment/alt-text entry whose marker id is
		// no longer backed by a live pair in the text that just landed —
		// deleting the commented/alt-texted span (both markers included)
		// needs no special handling of its own, this is what actually clears
		// the now-orphaned data out afterward, run against the TRUE final
		// text (post-titles), not the intermediate `renumbered`.
		const liveIds = liveAnnotationIds(titled);
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
	};

	/** Enqueues a commit behind whatever's already running, so overlapping
	 *  calls land on disk in request order instead of racing (see
	 *  `commitQueue`'s own comment). Errors are swallowed on the QUEUE only
	 *  — not from this call's own returned promise, so an awaited caller
	 *  (`importScript`) still sees a real rejection — otherwise one failed
	 *  commit would wedge every commit after it. */
	const commit = (raw: string): Promise<void> => {
		const run = commitQueue.current.then(() => runCommit(raw));
		commitQueue.current = run.catch(() => {});
		return run;
	};

	// Load, then one commit pass so a script dropped in from elsewhere gets its
	// ids and its Scene notes without anyone having to touch it.
	useEffect(() => {
		if (!file || !project || text === null || loadedFor.current !== file.path) return;
		if (committedFor.current === file.path) return;
		committedFor.current = file.path;
		const path = file.path;
		// `syncScenes` decides "does a note for this id already exist?" from
		// `plugin.indexer`'s CURRENT contents — if this view is restored as part
		// of Obsidian's own workspace-layout restore, that can run before the
		// plugin's startup rebuild has populated anything, so every scene looks
		// new and gets a full set of duplicate Scene/Character/Location notes
		// created for it (their managed file names dodge the collision with a
		// " 2" suffix, but the loom ids are true duplicates). Waiting for a
		// settled index first is the same guard the startup migration already
		// uses for the same reason. `rebuildNow()` coalesces with an in-flight
		// pass, so this is free once the index is already built.
		void plugin.indexer.rebuildNow().then(() => {
			// The view may have moved on to a different file while this awaited.
			if (committedFor.current !== path) return;
			// Runs once per file; `commit` deliberately closes over live state
			// rather than joining the dependency list, which would re-fire it.
			void commit(text);
		});
	}, [file?.path, project?.root, text !== null]);

	if (!file) return <div className="loom-empty">{t('view.script.loading')}</div>;
	if (!project) return <>{noProjectMessage()}</>;
	if (text === null || parsed === null) return <div className="loom-empty">{t('view.script.loading')}</div>;

	const write = (next: string) => {
		setText(next);
		void commit(next);
	};

	/** Persists whatever `fountainFieldRef` currently holds — for a caller
	 *  that just dispatched a document change THROUGH the ref (alt-text
	 *  cycling/drafting/accepting/deleting, all reachable from the gutter
	 *  icon, the Pages-preview icon, or `AltTextModal`, none of which put
	 *  real EDITOR FOCUS on this field) rather than by typing. Normal typing
	 *  persists on blur (`onBlur={() => void commit(text)}` on the
	 *  `FountainField` below); a change applied straight through the ref
	 *  never focuses it in the first place, so that blur never fires, and
	 *  without this the edit would sit in the live CM6 document only —
	 *  gone the moment the file reloads from disk. Reads the FRESH text
	 *  straight off the `EditorView` (`getValue`), not React's own `text`
	 *  state, since whether that's re-rendered yet by the time this runs
	 *  isn't guaranteed. */
	const commitFieldEdit = () => {
		const fresh = fountainFieldRef.current?.getValue();
		if (fresh !== undefined) write(fresh);
	};

	/** A new comment marker was just inserted around a selection — open its
	 *  popover immediately (no second click needed) so the user can type
	 *  straight into its always-available reply box. Deliberately does NOT
	 *  pre-create a sidecar entry: `entries: []` is what makes that reply box
	 *  the thing the user lands in — writing an empty `CommentEntry` here
	 *  used to be needed for the old single-comment popover's own "no text
	 *  yet → start in edit mode" check, but the threaded redesign renders
	 *  every entry as its own row, so a pre-created empty one showed up as a
	 *  blank row instead of ever reaching the reply box. The marker was only
	 *  just dispatched into the CM6 document THIS tick, but CM6 updates its
	 *  DOM (including the gutter) synchronously as part of `view.dispatch`,
	 *  so by the time this callback runs the icon already exists — still
	 *  deferred one frame (rather than queried inline) purely to stay
	 *  consistent with every other "find the rendered icon" lookup in this
	 *  file (search-jump), not because it's actually needed here. */
	const handleCreateComment = (id: string, _selectedText: string) => {
		window.requestAnimationFrame(() => {
			const icon =
				editorWrapperRef.current?.querySelector(`[data-loom-annotation-id="${id}"]`) ??
				pagesRef.current?.querySelector(`[data-loom-annotation-id="${id}"]`);
			if (icon instanceof HTMLElement) handleOpenComment(id, icon.getBoundingClientRect());
		});
	};

	/** A new alt-text marker was just inserted, wrapping the selection as
	 *  option 0 (the wording that was already there). Immediately prompts for
	 *  a SECOND option — same "picking the menu item opens something to type
	 *  into" expectation as the comment flow above — via the same
	 *  `TextInputModal` the right-click menu's own "Add alternative…" uses.
	 *  Cancelling (closing the modal without submitting) undoes the WHOLE
	 *  creation, not just the second option: a span stuck at one option is
	 *  exactly the "nothing left to alternate between" case
	 *  `handleDeleteAltOption` already strips back down to plain text, so
	 *  backing out here does the same — remove the sidecar entry and strip
	 *  the just-inserted marker pair, leaving the originally selected text
	 *  untouched or annotated. */
	const handleCreateAlt = (id: string, selectedText: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => ({
			...notes,
			altText: { ...notes.altText, [id]: { id, options: [selectedText], activeIndex: 0, acceptedIndex: null } },
		}));
		new TextInputModal(plugin.app, {
			title: t('view.entity.altText.addWordingTitle'),
			placeholder: selectedText,
			cta: t('project.common.add'),
			multiline: true,
			onSubmit: (value) => {
				void mutateScriptNotes(plugin.app, project, (notes) => {
					const cur = notes.altText[id];
					if (!cur) return notes;
					return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options: [...cur.options, value] } } };
				});
			},
			onCancel: () => {
				void mutateScriptNotes(plugin.app, project, (notes) => {
					const { [id]: _dropped, ...rest } = notes.altText;
					return { ...notes, altText: rest };
				}).then(() => {
					fountainFieldRef.current?.removeAnnotationMarkers(id);
					commitFieldEdit();
				});
			},
		}).open();
	};

	const handleOpenComment = (id: string, rect: DOMRect) => setOpenComment({ id, rect });

	/** Closing the popover with nothing ever added to the thread abandons the
	 *  whole comment creation, mirroring `handleCreateAlt`'s own cancel — a
	 *  freshly inserted marker pair backed by no `comments[id]` entry (only
	 *  `handleAddCommentReply` ever creates one) would otherwise sit in the
	 *  document forever as a permanently-empty gutter icon with no thread
	 *  behind it. Checks BOTH `scriptNotes` (an existing comment, reopened)
	 *  and `commentsWithNewEntryRef` (a reply just added this session, ahead
	 *  of the sidecar's own async round trip) — only when neither shows a
	 *  reply does the span get torn back out. */
	const handleCloseComment = () => {
		if (
			openComment &&
			!commentsWithNewEntryRef.current.has(openComment.id) &&
			!scriptNotes.comments[openComment.id]
		) {
			fountainFieldRef.current?.removeAnnotationMarkers(openComment.id);
			commitFieldEdit();
		}
		setOpenComment(null);
	};

	/** Saves an EDIT to one reply's text (the popover's per-row Edit action) —
	 *  never touches `resolved`/`resolvedAt`, which the check icon owns. */
	const handleSaveCommentEntry = (id: string, index: number, text: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const next = list.slice();
			next[index] = { ...next[index], text, updatedAt: Date.now() };
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		});
	};

	/** Toggles ONE reply's resolved state — stamps/clears `resolvedAt`
	 *  separately from `updatedAt`, since editing an already-resolved
	 *  comment's text later shouldn't change when it was resolved. */
	const handleToggleCommentResolved = (id: string, index: number) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const existing = list[index];
			const resolved = !existing.resolved;
			const next = list.slice();
			next[index] = { ...existing, resolved, resolvedAt: resolved ? Date.now() : null };
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		});
	};

	/** Removes ONE reply from the thread — if that empties it, the whole
	 *  `comments[id]` key goes too (an empty thread is the same as none), AND
	 *  the marker pair itself has to come out of the document — otherwise an
	 *  orphaned marker with no sidecar data behind it keeps rendering as a
	 *  live (permanently "unresolved," since there's nothing to check "all
	 *  resolved" against) span with no way to open it back up. */
	const handleDeleteCommentEntry = (id: string, index: number) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const next = list.filter((_, i) => i !== index);
			if (next.length === 0) {
				const { [id]: _dropped, ...rest } = notes.comments;
				return { ...notes, comments: rest };
			}
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		}).then((next) => {
			if (!next.comments[id]) {
				fountainFieldRef.current?.removeAnnotationMarkers(id);
				commitFieldEdit();
				// The marker pair (and so the whole span) is gone — a reply typed
				// into the now-empty popover's box would have nothing left in the
				// document to attach to, so close it rather than leave a dead end.
				setOpenComment((prev) => (prev && prev.id === id ? null : prev));
			}
		});
	};

	/** The popover's always-available reply box — appends a new entry to the
	 *  thread without touching any existing one. */
	const handleAddCommentReply = (id: string, text: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
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
		});
	};

	/** The CURRENT live text between an alt-text span's markers, straight from
	 *  the document (`text` React state, kept in sync with the CM6 editor on
	 *  every keystroke) — not the sidecar's own stored copy, which is exactly
	 *  the point: the active option's wording can be, and normally is, edited
	 *  directly in the script rather than through `AltTextModal`, and that
	 *  edit needs somewhere to land before the span switches away from it. */
	const liveAltSpanText = (id: string): string | null => {
		if (text === null) return null;
		const span = findAnnotationSpans(text).find((s) => s.kind === 'alt' && s.id === id);
		return span ? text.slice(span.contentFrom, span.contentTo) : null;
	};

	/** Rewrites `cur`'s OUTGOING (currently active) option to match whatever
	 *  is actually live in the document right now, before a swap moves away
	 *  from it — shared by every handler below that changes `activeIndex`.
	 *  Without this, a hand-edit typed directly into the active option's text
	 *  (the normal way to revise it, not through the modal) never reached the
	 *  sidecar: switching to a different option and back later would silently
	 *  revert the edit, restoring the STALE text the sidecar last remembered
	 *  instead of what was actually left on the page. */
	const syncOutgoingAltOption = (id: string, cur: AltTextEntry): AltTextEntry => {
		const live = liveAltSpanText(id);
		if (live === null || live === cur.options[cur.activeIndex]) return cur;
		const options = cur.options.slice();
		options[cur.activeIndex] = live;
		return { ...cur, options };
	};

	/** Left-click cycle: computes the next option and persists it, then calls
	 *  back into the live `FountainField` (the only thing holding the actual
	 *  `EditorView`) to apply the swap in the document. The next index is
	 *  computed INSIDE `mutateScriptNotes`'s mutate callback, against its own
	 *  freshly re-read file, not against the `scriptNotes` React state closed
	 *  over at click time — that state only catches up after a real vault
	 *  read round-trip, so a click landing before it caught up (a fast
	 *  double-click, or just a slow filesystem) would otherwise recompute the
	 *  SAME "next" index every time and the cycle would stall after one step. */
	const handleCycleAlt = (id: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || cur0.options.length === 0) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			const nextIndex = (cur.activeIndex + 1) % cur.options.length;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: nextIndex } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) {
				fountainFieldRef.current?.replaceAltContent(id, cur.options[cur.activeIndex]);
				commitFieldEdit();
			}
		});
	};

	/** Right-click: opens `AltTextModal` (project.ts) — a real closeable
	 *  window, scrollable, every option in its own EDITABLE textarea — rather
	 *  than the old `Menu`-based picker, which truncated each option to 60
	 *  chars, couldn't be scrolled, and only ever let you PICK an option, not
	 *  rewrite one. The modal owns its own local copy of `options`/
	 *  `activeIndex` and re-renders itself after every action, so it needs no
	 *  React state here to track "is it open." **`syncOutgoingAltOption`
	 *  patches the active row's text before handing it over** — `entry`
	 *  itself is the sidecar's own stored copy, stale for the active option
	 *  the instant it's hand-edited directly in the script (the sidecar only
	 *  actually catches up lazily, on the next cycle/draft/accept SWAP), so
	 *  opening the modal right after such an edit used to show the OLD
	 *  wording for a beat until the next swap resynced it. This only patches
	 *  what's DISPLAYED, not a write — the sidecar itself stays lazily synced
	 *  exactly as before, still caught up for real the next time a swap
	 *  actually happens. */
	const handleOpenAltMenu = (id: string) => {
		const entry = scriptNotes.altText[id];
		if (!entry) return;
		const { options } = syncOutgoingAltOption(id, entry);
		new AltTextModal(plugin.app, {
			options,
			activeIndex: entry.activeIndex,
			acceptedIndex: entry.acceptedIndex,
			onDraft: (index) => handleDraftAlt(id, index),
			onAccept: (index) => handleAcceptAlt(id, index),
			onEditOption: (index, newText) => handleEditAltOption(id, index, newText),
			onAddOption: (text) => handleAddAltOption(id, text),
			onDeleteOption: (index) => handleDeleteAltOption(id, index),
		}).open();
	};

	/** A row was picked as the DRAFT — same "compute the next state INSIDE
	 *  the fresh re-read" shape as `handleCycleAlt` above, so a pick right
	 *  after another script-notes write can't act on stale data. Clears
	 *  `acceptedIndex`: choosing a different draft means the span is back to
	 *  "still deciding," even if it had a finalized choice before. */
	const handleDraftAlt = (id: string, index: number) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || index < 0 || index >= cur0.options.length) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: index, acceptedIndex: null } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) {
				fountainFieldRef.current?.replaceAltContent(id, cur.options[cur.activeIndex]);
				commitFieldEdit();
			}
		});
	};

	/** A row was picked as the ACCEPTED, final option — same as Draft but
	 *  also stamps `acceptedIndex`, marking this span as no longer "in doubt"
	 *  (see the Alternatives browser panel, which surfaces spans where this
	 *  is still `null`). */
	const handleAcceptAlt = (id: string, index: number) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || index < 0 || index >= cur0.options.length) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: index, acceptedIndex: index } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) {
				fountainFieldRef.current?.replaceAltContent(id, cur.options[cur.activeIndex]);
				commitFieldEdit();
			}
		});
	};

	/** An existing option's wording was edited in place inside the modal — if
	 *  it's the currently ACTIVE option, the live document has to follow the
	 *  edit too: the active option's stored text is supposed to always mirror
	 *  what's actually on the page. */
	const handleEditAltOption = (id: string, index: number, newText: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur || index < 0 || index >= cur.options.length) return notes;
			const options = cur.options.slice();
			options[index] = newText;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur && cur.activeIndex === index) {
				fountainFieldRef.current?.replaceAltContent(id, newText);
				commitFieldEdit();
			}
		});
	};

	/** "Add" in the open `AltTextModal` — appends a new option without
	 *  activating it (add and swap stay distinct actions). */
	const handleAddAltOption = (id: string, text: string) => {
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur) return notes;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options: [...cur.options, text] } } };
		});
	};

	/** Deletes ONE option outright (the modal's trash icon, after its own
	 *  confirm). Refused ONLY when just one option is left already (nothing
	 *  left to delete down TO) — the modal's own trash button disables at
	 *  that point. Deleting down to exactly one remaining, though, is a real
	 *  action: an alt-text span with a single option has nothing left to
	 *  alternate BETWEEN, so — mirroring a comment thread's own "delete the
	 *  last one strips the markers" behavior — the whole `[[loom-alt:<id>]]`
	 *  wrapper comes OUT of the document, leaving the survivor's wording as
	 *  ordinary text, and the sidecar entry is dropped entirely rather than
	 *  left describing a single-option span. Otherwise shifts `activeIndex`/
	 *  `acceptedIndex` down past the removed slot, falls the active index
	 *  back to the nearest remaining option if the deleted one WAS active,
	 *  and clears `acceptedIndex` if the deleted one was the accepted choice
	 *  — then hands the fresh `AltTextEntry` back to the modal so it can
	 *  re-render without duplicating this renumbering itself. */
	const handleDeleteAltOption = (id: string, index: number) => {
		let strippedTo: string | null = null;
		return mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur || cur.options.length <= 1 || index < 0 || index >= cur.options.length) return notes;
			const options = cur.options.slice();
			options.splice(index, 1);
			if (options.length <= 1) {
				strippedTo = options[0] ?? '';
				const { [id]: _dropped, ...rest } = notes.altText;
				return { ...notes, altText: rest };
			}
			let activeIndex = cur.activeIndex;
			if (index === activeIndex) activeIndex = Math.min(index, options.length - 1);
			else if (index < activeIndex) activeIndex -= 1;
			let acceptedIndex = cur.acceptedIndex;
			if (acceptedIndex !== null) {
				if (index === acceptedIndex) acceptedIndex = null;
				else if (index < acceptedIndex) acceptedIndex -= 1;
			}
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options, activeIndex, acceptedIndex } } };
		}).then((next) => {
			if (strippedTo !== null) {
				// The surviving option's text has to actually BE the live
				// document content before the wrapper markers come out, or
				// stripping would leave whichever text happened to be active
				// (possibly the just-deleted option's) instead of the survivor.
				fountainFieldRef.current?.replaceAltContent(id, strippedTo);
				fountainFieldRef.current?.removeAnnotationMarkers(id);
				commitFieldEdit();
				return undefined;
			}
			const cur = next.altText[id];
			if (cur) {
				fountainFieldRef.current?.replaceAltContent(id, cur.options[cur.activeIndex]);
				commitFieldEdit();
			}
			return cur;
		});
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
		const live = liveSceneIds(parsed);
		return plugin.indexer
			.getAll('scene', project.root)
			.filter((r) => r.sceneId !== '' && !live.has(r.sceneId));
	})();

	// A scene's writing lives inside its act's stretch of the script, so one
	// sitting outside every `#` section has nowhere to belong.
	const actless = parsed.scenes.filter((s) => (s.sectionPath[0]?.trim() ?? '') === '');

	const sceneNotes = plugin.indexer.getAll('scene', project.root);
	const sceneNote = (scene: ParsedScene): EntityRecord | undefined =>
		sceneNotes.find((r) => r.sceneId === scene.loomId);

	// What the `@[` inline entity-link autocomplete offers, and what its
	// clicks resolve against — never auto-created, so only what already
	// exists shows up here.
	const entityOptions = (['character', 'faction', 'location', 'item'] as const).flatMap((et) =>
		plugin.indexer.getAll(et, project.root).map((r) => ({ name: r.name, type: r.type, path: r.path }))
	);

	// --- Outline panel ----------------------------------------------------
	// Every top-level section already carrying its stable id — `ensureSceneIds`
	// gives one to every level-1 section, so the only way one's missing here is
	// the brief window before the load-time commit pass finishes.
	const actSections = parsed.sections.filter(
		(sec): sec is typeof sec & { loomId: string } => sec.level === 1 && sec.loomId !== null
	);
	const actNoteByLoomId = new Map(
		plugin.indexer.getAll('act', project.root).map((r) => [r.actId, r])
	);
	/** The Outline's actual top-level drag list: acts AND the page breaks
	 *  that sit between them, interleaved in document order — a page break's
	 *  whole reason to exist here is to be repositioned exactly like a
	 *  act, so both are one reorderable sequence rather than two. Only
	 *  act-BOUNDARY page breaks (`parsed.pageBreaks`) ever show up; one
	 *  typed inside a scene stays there, plain content, never promoted. */
	const topLevelRows: (
		| { kind: 'act'; sec: (typeof actSections)[number]; line: number }
		| { kind: 'page-break'; id: string; line: number }
	)[] = [
		...actSections.map((sec) => ({ kind: 'act' as const, sec, line: sec.line })),
		...parsed.pageBreaks
			.filter((pb): pb is typeof pb & { loomId: string } => pb.loomId !== null)
			.map((pb) => ({ kind: 'page-break' as const, id: pb.loomId, line: pb.line })),
	].sort((a, b) => a.line - b.line);
	/** Every scene inside one act's own stretch of the script — the same
	 *  `[act line, next top-level section)` boundary `reorderScenesInSection`
	 *  and `actScriptText` use. */
	const actScenes = (sec: (typeof actSections)[number]): ParsedScene[] => {
		const end = nextTopSectionLine(parsed, sec.line) ?? Infinity;
		return parsed.scenes.filter((s) => s.line > sec.line && s.line < end);
	};
	const isActCollapsed = (id: string) => collapsedActs.has(id);
	const toggleActCollapsed = (id: string) => {
		const next = new Set(collapsedActs);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setCollapsedActs(next);
	};
	const allActsCollapsed =
		actSections.length > 0 && actSections.every((sec) => isActCollapsed(sec.loomId));
	const setAllActsCollapsed = (value: boolean) =>
		setCollapsedActs(value ? new Set(actSections.map((sec) => sec.loomId)) : new Set());

	/** Row transform while an outline row is being dragged — same shape as
	 *  the Act page's own scene-reorder grip, generalized with a `group`
	 *  key so the top-level act list and each act's own nested scene
	 *  list can each drag independently without fighting over one piece of
	 *  state (mirrors `seqGrip`'s `group` parameter in entity-view.tsx). */
	const outlineRowStyle = (group: string, i: number): CSSProperties | undefined => {
		if (!outlineDrag || outlineDrag.group !== group) return undefined;
		const slot = outlineDragRef.current?.slot ?? 40;
		if (outlineDrag.from === i)
			return { transform: `translateY(${outlineDrag.dy}px)`, position: 'relative', zIndex: 2 };
		const sourceActId = group.startsWith('scenes:') ? group.slice('scenes:'.length) : null;
		// Once the pointer has moved into a DIFFERENT act, the drop no
		// longer lands among these siblings at all — stop previewing a
		// within-list shift for them.
		if (sourceActId && outlineDrag.hoverActId && outlineDrag.hoverActId !== sourceActId) {
			return undefined;
		}
		const { from, over } = outlineDrag;
		const shift = from < i && i <= over ? -1 : over <= i && i < from ? 1 : 0;
		return shift !== 0 ? { transform: `translateY(${shift * slot}px)` } : undefined;
	};
	const endOutlineDrag = (
		group: string,
		commit: boolean,
		onCommit: (from: number, over: number, hoverActId?: string) => void
	) => {
		outlineDragRef.current = null;
		const drag = outlineDrag;
		setOutlineDrag(null);
		if (!commit || !drag || drag.group !== group) return;
		// Nothing to do only when NEITHER changed — a scene can numerically
		// land back at its own starting index while still having crossed
		// into a different act along the way.
		if (drag.from === drag.over && !drag.hoverActId) return;
		onCommit(drag.from, drag.over, drag.hoverActId);
	};
	/** The 6-dot grab handle placed before an outline row (act or scene).
	 *  `sceneActId` — the scene's OWN act id — is passed only for
	 *  scene rows; its presence is what turns on cross-act drop
	 *  detection (acts themselves never move between acts). */
	const outlineGrip = (
		group: string,
		i: number,
		length: number,
		onCommit: (from: number, over: number, hoverActId?: string) => void,
		sceneActId?: string
	) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest('[data-seq-row]');
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				const rows = row?.parentElement
					? [...row.parentElement.querySelectorAll(':scope > [data-seq-row]')]
					: [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				// Every act's own on-screen block, captured once up front
				// (siblings only shift via CSS transform during a drag, never
				// reflow, so this stays accurate for the whole gesture) — only
				// scenes need this, acts can't move between acts.
				const actRects = sceneActId
					? [...(outlineRef.current?.querySelectorAll<HTMLElement>('[data-act-id]') ?? [])].map((el) => {
							const b = el.getBoundingClientRect();
							return { id: el.dataset.actId as string, top: b.top, bottom: b.bottom };
						})
					: undefined;
				outlineDragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? 40) + 8, mids, actRects };
				setOutlineDrag({ group, from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = outlineDragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(0, Math.min(length - 1, start.mids.filter((m) => m < e.clientY).length));
				// The act block whose top the pointer has most recently
				// passed — blocks are captured top-to-bottom, so the LAST one
				// still satisfying this is the one currently under the pointer.
				let hoverActId: string | undefined;
				if (start.actRects && start.actRects.length > 0) {
					hoverActId = start.actRects[0].id;
					for (const r of start.actRects) {
						if (r.top <= e.clientY) hoverActId = r.id;
					}
				}
				setOutlineDrag((cur) =>
					cur &&
					cur.group === group &&
					(cur.over !== over || cur.dy !== dy || cur.hoverActId !== hoverActId)
						? { ...cur, over, dy, hoverActId }
						: cur
				);
			}}
			onPointerUp={() => endOutlineDrag(group, true, onCommit)}
			onPointerCancel={() => endOutlineDrag(group, false, onCommit)}
		>
			<Icon name="grip-vertical" />
		</span>
	);
	/** One atomic rewrite of the whole document's act order — robust to
	 *  any drag distance, mirroring `reorderScenesInSection` one level up. */
	const commitTopLevelOrder = (from: number, over: number) => {
		const next = [...topLevelRows];
		const [moved] = next.splice(from, 1);
		next.splice(over, 0, moved);
		const reordered = reorderTopLevelEntries(
			text,
			next.map((row) => (row.kind === 'act' ? row.sec.loomId : row.id))
		);
		if (reordered !== null) write(reordered);
	};
	/** Same, scoped to one act's own scene list — unless the drop lands
	 *  in a DIFFERENT act (`hoverActId`), in which case the scene
	 *  moves there instead of being reordered in place, via the same
	 *  `moveSceneToSection` the Scene page's own act picker uses. */
	const commitSceneOrder =
		(sec: (typeof actSections)[number], scenes: ParsedScene[]) =>
		(from: number, over: number, hoverActId?: string) => {
			if (hoverActId && hoverActId !== sec.loomId) {
				const moved = scenes[from];
				if (!moved || moved.loomId === null) return;
				const reordered = moveSceneToSection(text, moved.loomId, hoverActId);
				if (reordered !== null) write(reordered);
				return;
			}
			const next = [...scenes];
			const [moved] = next.splice(from, 1);
			next.splice(over, 0, moved);
			const ids = next.map((s) => s.loomId).filter((id): id is string => id !== null);
			const reordered = reorderScenesInSection(text, sec.loomId, ids);
			if (reordered !== null) write(reordered);
		};

	// --- Pagination ---------------------------------------------------------
	// The PDF puts the title page first, so the preview must too — otherwise
	// every page number in the app is one off from the exported file.
	const titleFirst = hasTitlePage(parsed.titlePage);
	const pages = titleFirst ? [[] as typeof bodyPages[number], ...bodyPages] : bodyPages;
	const pageCount = Math.max(1, pages.length);
	const currentPage = Math.min(Math.max(1, page), pageCount);
	/** Real page range of a scene, from the same layout as the PDF. */
	const scenePages = (scene: ParsedScene): string => {
		if (!parsed) return '—';
		const end = sceneEndLine(parsed, scene);
		const hits: number[] = [];
		bodyPages.forEach((elements, i) => {
			if (elements.some((el) => el.line >= scene.line && el.line < end)) {
				hits.push(i + 1 + (titleFirst ? 1 : 0));
			}
		});
		if (hits.length === 0) return '—';
		const first = hits[0];
		const last = hits[hits.length - 1];
		return first === last ? String(first) : `${first}–${last}`;
	};
	/** The page an act-boundary break shows against — `layoutPages` (pdf.ts)
	 *  drops the break itself from every page's own element list (it only
	 *  ever forces the NEXT one to start fresh), so unlike `scenePages` this
	 *  can't look for its own line among `bodyPages`; it finds the first page
	 *  whose own content starts after the break's line instead, i.e. the page
	 *  the break actually produces. A TRAILING break (nothing left in the
	 *  document to start a next page) falls back to the page it sits at the
	 *  END of — the last page whose own content comes before it — so it still
	 *  reads as a real page instead of a bare dash; only a script with
	 *  nothing in it at all falls through both. */
	const pageBreakPage = (line: number): string => {
		for (let i = 0; i < bodyPages.length; i++) {
			const first = bodyPages[i][0];
			if (first && first.line > line) return String(i + 1 + (titleFirst ? 1 : 0));
		}
		for (let i = bodyPages.length - 1; i >= 0; i--) {
			const pageEls = bodyPages[i];
			if (pageEls.length > 0 && pageEls[pageEls.length - 1].line < line) {
				return String(i + 1 + (titleFirst ? 1 : 0));
			}
		}
		return '—';
	};

	// --- Search -------------------------------------------------------------
	const annotationSpans = findAnnotationSpans(text);
	const matches: ScriptSearchMatch[] = [];
	if (query.trim() !== '') {
		const needle = query.toLowerCase();
		const hay = text.toLowerCase();
		for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
			matches.push({ kind: 'text', offset: at });
		}
		for (const [id, entries] of Object.entries(scriptNotes.comments)) {
			if (entries.some((e) => e.text.toLowerCase().includes(needle))) matches.push({ kind: 'comment', id });
		}
		for (const [id, entry] of Object.entries(scriptNotes.altText)) {
			entry.options.forEach((opt, optionIndex) => {
				if (opt.toLowerCase().includes(needle)) matches.push({ kind: 'altOption', id, optionIndex });
			});
		}
		// Document order, not "all text hits then all annotations" — a
		// comment/alt-text match sorts by its marker's own position.
		const posOf = (m: ScriptSearchMatch) =>
			m.kind === 'text' ? m.offset : (annotationSpans.find((s) => s.id === m.id)?.from ?? Infinity);
		matches.sort((a, b) => posOf(a) - posOf(b));
	}
	/** Line index a character offset falls on. */
	const lineAt = (offset: number) => text.slice(0, offset).split('\n').length - 1;

	/** How many physical lines an element's OWN `.line` covers — only
	 *  `dialogue` ever merges consecutive source lines into one element
	 *  (`\n`-joined), so it's the one type whose span can be more than 1;
	 *  matches the identical check in `fountain-field.tsx`'s decorations. */
	const elementSpan = (el: ParsedScript['elements'][number]) =>
		el.type === 'dialogue' ? el.text.split('\n').length : 1;

	/** The 1-based typeset page a line renders on. Checks the element's WHOLE
	 *  span, not just its start line — a line landing mid-dialogue (a
	 *  multi-line merged element) has no element starting exactly there, so
	 *  an exact-match-only check fell through to the "after this line"
	 *  fallback below and could land a page later than the one actually
	 *  showing that line. */
	const pageOfLine = (line: number) => {
		const offset = titleFirst ? 2 : 1;
		for (let i = 0; i < bodyPages.length; i++) {
			if (bodyPages[i].some((el) => line >= el.line && line < el.line + elementSpan(el))) return i + offset;
		}
		// Nothing rendered sits exactly on this line — a section (`#` act)
		// heading never reaches the page itself. Land on whichever page holds
		// the first thing that comes AFTER it, so an act that starts fresh
		// on a new page jumps to that page rather than the one before it (the
		// last page whose first element preceded the target would always be
		// one page too early in exactly that case).
		for (let i = 0; i < bodyPages.length; i++) {
			if (bodyPages[i].some((el) => el.line > line)) return i + offset;
		}
		return Math.max(offset, bodyPages.length - 1 + offset);
	};

	/** First rendered line on a typeset page — the inverse of `pageOfLine`,
	 *  used to land the Script pane near where Pages was scrolled to. */
	const lineOfPage = (target: number) => {
		const idx = target - (titleFirst ? 2 : 1);
		if (idx < 0 || idx >= bodyPages.length) return 0;
		return bodyPages[idx][0]?.line ?? 0;
	};

	const gotoMatch = (index: number) => {
		if (matches.length === 0) return;
		const next = ((index % matches.length) + matches.length) % matches.length;
		setMatchIndex(next);
		const m = matches[next];
		if (m.kind === 'text') {
			setOpenComment(null);
			setHighlightedAnnotationId(null);
			if (mode === 'script') {
				fountainFieldRef.current?.selectRange(m.offset, m.offset + query.length);
			} else {
				scrollToPage(pageOfLine(lineAt(m.offset)));
			}
			return;
		}
		const span = annotationSpans.find((s) => s.id === m.id);
		if (!span) return;
		if (m.kind === 'altOption') {
			setOpenComment(null);
			setHighlightedAnnotationId(m.id);
		} else {
			setHighlightedAnnotationId(null);
		}
		if (mode === 'script') {
			fountainFieldRef.current?.selectRange(span.contentFrom, span.contentFrom);
			if (m.kind === 'comment') {
				// Same "wait a frame, then find the rendered icon" trick the
				// click handler doesn't need (it already has the icon under
				// the pointer) — a keyboard/button-driven jump has no DOM
				// element to hand `handleOpenComment` yet until CM6's gutter
				// has actually redrawn for the newly-scrolled-to line.
				window.requestAnimationFrame(() => {
					const icon = editorWrapperRef.current?.querySelector(`[data-loom-annotation-id="${m.id}"]`);
					if (icon instanceof HTMLElement) handleOpenComment(m.id, icon.getBoundingClientRect());
				});
			}
		} else {
			scrollToPage(pageOfLine(lineAt(span.from)));
			if (m.kind === 'comment') {
				window.requestAnimationFrame(() => {
					const icon = pagesRef.current?.querySelector(`[data-loom-annotation-id="${m.id}"]`);
					if (icon instanceof HTMLElement) handleOpenComment(m.id, icon.getBoundingClientRect());
				});
			}
		}
	};

	/** Scrolls the preview to a page (the pages all exist; navigation moves).
	 *  `behavior` defaults to smooth for an explicit jump (Prev/Next, the page
	 *  number field, search) — landing back where you were on a mode switch
	 *  is a restore, not a jump, so `switchMode` passes 'auto' there instead
	 *  of animating a scroll across the whole document on every toggle. */
	const scrollToPage = (target: number, behavior: ScrollBehavior = 'smooth') => {
		setPage(target);
		window.requestAnimationFrame(() => {
			const container = pagesRef.current;
			const el = container?.querySelector(`[data-page="${target}"]`);
			// `scrollIntoContainer`, never `Element.scrollIntoView` — the latter
			// cascades through every scrollable ancestor by default, dragging
			// the outer view's own scroll along with it on every search/nav jump.
			if (container && el instanceof HTMLElement) scrollIntoContainer(container, el, behavior);
		});
	};

	/** Persists the Script-mode editor's own scroll position — separate from
	 *  `mode`/`page` above (those cover WHICH pane and, for Pages, which page;
	 *  this covers where you actually were within the Script editor itself).
	 *  Captured on the field's `onBlur`, the same moment `commit` already
	 *  fires — every point the editor is genuinely left (a mode switch,
	 *  clicking elsewhere, or closing the note), so this stays fresh without
	 *  needing its own scroll listener. Read back into `pendingScrollLineRef`
	 *  above (see its own comment) on the next fresh open. */
	const saveScriptLine = () => {
		if (!file) return;
		const top = fountainFieldRef.current?.getTopLine();
		if (top === undefined) return;
		window.localStorage.setItem(`loom-script-line:${file.path}`, String(top));
	};

	const jumpToLine = (line: number) => {
		if (mode === 'pages') {
			scrollToPage(pageOfLine(line));
			return;
		}
		const offset = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
		fountainFieldRef.current?.selectRange(offset, offset);
	};

	/** Jumps to the Title page — Pages preview renders it as its own page 1
	 *  (when there's anything to show), so that's a plain page scroll there;
	 *  Script/Outline both render the real `<details>` above the tabs
	 *  regardless of mode, so there it's opened (native `<details>` stays
	 *  collapsed until told otherwise) and scrolled into view. */
	const jumpToTitlePage = () => {
		if (mode === 'pages') {
			if (titleFirst) scrollToPage(1);
			return;
		}
		const el = titleDetailsRef.current;
		if (!el) return;
		el.open = true;
		el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	};

	/** The Script/Pages toggle keeps roughly the same spot in the document
	 *  across a switch, rather than always landing back at the top. Leaving
	 *  Pages stashes a target line for the effect above to apply once
	 *  `FountainField` remounts; leaving Script can scroll immediately since
	 *  the pages markup, once mounted, needs nothing handed to it but a
	 *  `scrollIntoView`. Outline (the standalone button, not part of that
	 *  pill) is a plain swap either direction — it's a management list, not a
	 *  reading position to preserve. */
	const switchMode = (next: 'script' | 'pages' | 'outline') => {
		if (next === mode) return;
		if (next === 'pages') {
			const topLine = mode === 'script' ? fountainFieldRef.current?.getTopLine() : undefined;
			setMode('pages');
			// 'instant', not 'auto' — the container has `scroll-behavior: smooth`
			// for the ordinary jump navigation below, and 'auto' explicitly
			// means "defer to that CSS property", so it would animate anyway.
			if (topLine !== undefined) scrollToPage(pageOfLine(topLine), 'instant');
		} else if (next === 'script' && mode === 'pages') {
			pendingScrollLineRef.current = lineOfPage(currentPage);
			setMode('script');
		} else {
			setMode(next);
		}
	};

	/** Scrolls the outer view so the tabs row lands at the top — called on
	 *  every tab click, independent of whether the mode actually changes
	 *  (a re-click on the already-active tab still scrolls). */
	const scrollTabsIntoView = () => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	const clickTab = (next: 'script' | 'pages' | 'outline') => {
		scrollTabsIntoView();
		switchMode(next);
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
			new Notice(t('view.script.systemOpenUnsupported'));
			return;
		}
		try {
			fn.call(plugin.app, path);
		} catch (err) {
			console.error('Loom Loom: system open failed', err);
			new Notice(t('view.script.systemOpenFailed'));
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
				new Notice(t('view.script.exportedNotice', { name }));
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
			new Notice(t('view.script.exportedNotice', { name }));
		} catch (err) {
			console.error('Loom Loom: export download failed, writing into the vault', err);
			const folder = file.parent?.path ?? '';
			const path = normalizePath(folder === '' ? name : `${folder}/${name}`);
			try {
				const existing = plugin.app.vault.getFileByPath(path);
				if (existing) await plugin.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer);
				else await plugin.app.vault.createBinary(path, bytes.buffer as ArrayBuffer);
				new Notice(t('view.script.exportedToPath', { path }));
			} catch (err2) {
				console.error('Loom Loom: export failed', err2);
				new Notice(t('view.script.exportWriteFailed'));
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
		// Top-level sections (acts) need the same recovery: an export → edit
		// elsewhere → import round trip strips their `[[loom:…]]` markers too, and
		// without reattaching them every reimport orphaned the old Act notes
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
			t('view.script.replaceSummary', {
				name: sourceName,
				scenes: parsed.scenes.length,
				pages: pageCount,
				newScenes: incoming.scenes.length,
			}),
			'',
			t('view.script.replaceTextWarning'),
			'',
			t('view.script.replaceEntitiesNote'),
		];
		if (newCast.length > 0) lines.push('', t('view.script.newCharactersToCreate', { list: newCast.join(', ') }));
		if (known.length > 0 || knownSections.length > 0) {
			lines.push(
				'',
				result.matched > 0
					? tn('view.script.scenesReattached', result.matched)
					: t('view.script.noScenesReattached'),
				sectionResult.matched > 0
					? tn('view.script.actsReattached', sectionResult.matched)
					: t('view.script.noActsReattached'),
				t('view.script.orphanNote')
			);
		}

		new ConfirmModal(
			plugin.app,
			t('view.script.replaceScriptTitle'),
			lines.join('\n'),
			() =>
				void (async () => {
					try {
						await plugin.app.vault.modify(file, result.text);
						onDisk.current = result.text;
						setText(result.text);
						committedFor.current = null;
						await commit(result.text);
						new Notice(tn('view.script.importedNotice', incoming.scenes.length, { name: sourceName }));
					} catch (err) {
						console.error('Loom Loom: import failed', err);
						new Notice(t('view.script.importFailed'));
					}
				})(),
			t('view.script.replaceScriptCta')
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
				.setTitle(t('view.script.openInDefaultApp'))
				.setIcon('external-link')
				.onClick(() => systemOpen('openWithDefaultApp', file.path))
		);
		menu.addItem((i) =>
			i
				.setTitle(t('view.script.showInSystemFileManager'))
				.setIcon('folder-open')
				.onClick(() => systemOpen('showInFolder', file.path))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle(t('view.script.exportAsPdf'))
				.setIcon('file-text')
				.onClick(() => void saveExport(`${stem}.pdf`, renderScreenplayPdf(parsed), 'application/pdf'))
		);
		menu.addItem((i) =>
			i
				.setTitle(t('view.script.exportAsFountain'))
				.setIcon('file-down')
				.onClick(() =>
					void saveExport(
						`${stem}.fountain`,
						stripAnnotationMarkers(stripEntityLinksForDisplay(stripLoomIds(text))),
						'text/plain'
					)
				)
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t('view.script.importScriptAction')).setIcon('file-up').onClick(pickImport));
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

	// Scenes grouped under the act (top-level `#` section) they sit in.
	// Each group carries its section's own script line, so navigation can jump
	// to the `# Act` heading itself and not only to the scenes beneath it.
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

	// The navigation panel's own tree, built by `buildNavTree` (below) from
	// the whole script; the Scene page's own mini nav panel calls the same
	// function bounded to just one scene's line range.
	const navTree: NavNode = buildNavTree(parsed);

	/** Comment spans with at least one still-unresolved reply — the same
	 *  "needs attention" filter driving the persistent span highlight (see
	 *  fountain-field.tsx/fountain.ts), just surfaced as a browsable list
	 *  here instead of a passive color. A fully-resolved thread (or an id
	 *  with no sidecar entry at all yet) is left out entirely — the whole
	 *  point of this panel is finding what's NOT done. */
	const unresolvedCommentSpans = annotationSpans
		.filter((s) => s.kind === 'comment')
		.map((s) => ({ span: s, unresolvedEntries: (scriptNotes.comments[s.id] ?? []).filter((e) => !e.resolved) }))
		.filter((x) => x.unresolvedEntries.length > 0);

	/** Alt-text spans with no ACCEPTED option yet — "still in doubt," per the
	 *  `acceptedIndex`/`activeIndex` split (script-notes.ts). A span someone
	 *  is still drafting through (or hasn't touched since creation) shows
	 *  here; one with a finalized choice drops off the list. */
	const undecidedAltSpans = annotationSpans.filter(
		(s) => s.kind === 'alt' && (scriptNotes.altText[s.id]?.acceptedIndex ?? null) === null
	);

	/** A short single-line preview of a span's CURRENT wrapped text — panel
	 *  rows only need enough to recognize the passage, not the whole thing. */
	const excerptOf = (span: AnnotationSpan): string => {
		const raw = text.slice(span.contentFrom, span.contentTo).replace(/\s+/g, ' ').trim();
		return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
	};

	/** Both browser panels' own "jump to this text" action — closes whichever
	 *  side panel is open, then selects the span's full range in the Script
	 *  editor. Forces a switch INTO Script mode from Pages/Outline first
	 *  (`pendingSelectRangeRef`, applied once `FountainField` remounts) since
	 *  "gets selected" only means something there; already being in Script
	 *  mode just selects immediately. */
	const jumpToAnnotation = (span: AnnotationSpan) => {
		openSidePanel(null);
		if (mode === 'script') {
			fountainFieldRef.current?.selectRange(span.contentFrom, span.contentTo);
		} else {
			pendingSelectRangeRef.current = { from: span.contentFrom, to: span.contentTo };
			switchMode('script');
		}
	};

	// Lives INSIDE the editor/pages box (its own left margin), the same
	// `loom-script-nav-sticky-inset` placement the Scene/Act pages use —
	// more natural than floating above the Script/Pages tabs, and it means
	// one consistent spot for this toggle everywhere in the app rather than
	// a page-level position unique to this one view.
	const navPanel = (
			<div ref={sidePanelRef} className="loom-script-nav-sticky loom-script-nav-sticky-inset">
				<button
					className="loom-script-nav-toggle"
					aria-label={navOpen ? t('view.entity.script.hideNavigation') : t('view.entity.script.showNavigation')}
					onClick={() => openSidePanel(navOpen ? null : 'nav')}
				>
					<Icon name={navOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
				</button>
				{navOpen ? (
					<aside className="loom-script-nav">
						<div className="loom-script-nav-head">
							{t('view.entity.script.navigate')}
							<button
								className="loom-rel-filter"
								aria-label={t('view.entity.script.hideNavigation')}
								onClick={() => setNavOpen(false)}
							>
								<Icon name="chevron-left" />
							</button>
						</div>
						{/* Always first, and always present — every script has one,
						    unlike an act/scene it doesn't live at a line the Script
						    editor can select, so it jumps through its own `<details>`
						    ref (`jumpToTitlePage`) instead of `jumpToLine`. */}
						<button
							className="loom-script-nav-act"
							onClick={() => {
								jumpToTitlePage();
								setNavOpen(false);
							}}
						>
							{t('view.script.titlePage')}
						</button>
						{parsed.scenes.length === 0 ? (
							<div className="loom-script-nav-empty">{t('view.script.noScenesYet')}</div>
						) : null}
						{renderNavTreeNode(navTree, 0, jumpToLine)}
					</aside>
				) : null}
				{commentsPanelOpen ? (
					<aside className="loom-script-nav">
						<div className="loom-script-nav-head">
							{t('view.entity.script.unresolvedComments')}
							<button
								className="loom-rel-filter"
								aria-label={t('view.entity.script.hideComments')}
								onClick={() => setCommentsPanelOpen(false)}
							>
								<Icon name="chevron-left" />
							</button>
						</div>
						{unresolvedCommentSpans.length === 0 ? (
							<div className="loom-script-nav-empty">{t('view.entity.script.noUnresolvedComments')}</div>
						) : (
							unresolvedCommentSpans.map(({ span, unresolvedEntries }) => (
								<div key={span.id} className="loom-script-comments-panel-group">
									<button
										className="loom-script-nav-act loom-script-comments-panel-excerpt"
										onClick={() => jumpToAnnotation(span)}
									>
										{excerptOf(span)}
									</button>
									<div className="loom-script-comments-panel-nested">
										{unresolvedEntries.map((entry) => (
											<button
												key={entry.id + entry.createdAt}
												className="loom-script-comments-panel-reply"
												onClick={() => jumpToAnnotation(span)}
											>
												{entry.text.trim() === '' ? t('view.entity.script.emptyReply') : entry.text}
											</button>
										))}
									</div>
								</div>
							))
						)}
					</aside>
				) : null}
				{altPanelOpen ? (
					<aside className="loom-script-nav">
						<div className="loom-script-nav-head">
							{t('view.entity.script.unfinalizedAlternatives')}
							<button
								className="loom-rel-filter"
								aria-label={t('view.entity.script.hideAlternatives')}
								onClick={() => setAltPanelOpen(false)}
							>
								<Icon name="chevron-left" />
							</button>
						</div>
						{undecidedAltSpans.length === 0 ? (
							<div className="loom-script-nav-empty">{t('view.entity.script.everyAlternativeAccepted')}</div>
						) : (
							undecidedAltSpans.map((span) => (
								<button
									key={span.id}
									className="loom-script-nav-act loom-script-comments-panel-excerpt"
									onClick={() => jumpToAnnotation(span)}
								>
									{excerptOf(span)}
								</button>
							))
						)}
					</aside>
				) : null}
			</div>
	);

	return (
		<ViewShell
			view={view}
			project={project}
			title={`${project.name} — ${scriptLabel()}`}
			railActive="script"
			titleExtra={
				<div className="loom-script-actions">
					<span className="loom-writer-stat">
						{tn('view.script.sceneCount', parsed.scenes.length)} · {tn('view.script.pageCountLabel', pageCount)}
					</span>
					<button className="loom-rel-filter" aria-label={t('view.script.scriptActionsAria')} onClick={actionMenu}>
						<Icon name="menu" fallback="more-horizontal" />
					</button>
				</div>
			}
		>
			<div className="loom-writer-layout">
				<div className="loom-writer-main">
					<details className="loom-script-section" ref={titleDetailsRef}>
						<summary>{t('view.script.titlePage')}</summary>
						<div className="loom-field-group">
							{titleField(t('project.createEntity.titleLabel'), 'title', project.name)}
							{titleField(t('view.script.titlePageField.credit'), 'credit', t('view.script.creditDefault'))}
							{titleField(t('view.script.titlePageField.author'), 'author')}
							{titleField(t('view.script.titlePageField.draftDate'), 'draftDate')}
							{titleField(t('view.script.titlePageField.source'), 'source')}
							{titleField(t('view.script.titlePageField.contact'), 'contact')}
							{titleField(t('view.script.titlePageField.copyright'), 'copyright')}
							{/* `Notes:` is a real Fountain title-page key, so it stays —
							    but it's an author's note ABOUT the script, which no
							    renderer prints on the title page. That's why it never
							    shows up in the preview or the PDF. */}
							{titleField(t('project.notes'), 'notes')}
						</div>
					</details>

					<div className="loom-writer-tabs" ref={tabsRef}>
						<div className="loom-seg">
							<button
								className={mode === 'script' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => clickTab('script')}
							>
								{scriptLabel()}
							</button>
							<button
								className={mode === 'pages' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => clickTab('pages')}
							>
								{t('view.entity.script.pagesPreview')}
							</button>
						</div>
						{/* Comments/Alternatives browser panels — standalone icon toggles
						    next to the Script/Pages pill (not part of it: this doesn't
						    change what document is shown, just opens the same overlaid
						    side-panel slot the nav toggle uses). Mutually exclusive with
						    each other and the nav panel via `openSidePanel`. */}
						<div className="loom-script-side-toggles">
							<button
								className={commentsPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={commentsPanelOpen ? t('view.entity.script.hideComments') : t('view.entity.script.browseComments')}
								onClick={() => openSidePanel(commentsPanelOpen ? null : 'comments')}
							>
								<Icon name="message-square" />
							</button>
							<button
								className={altPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={altPanelOpen ? t('view.entity.script.hideAlternatives') : t('view.entity.script.browseAlternatives')}
								onClick={() => openSidePanel(altPanelOpen ? null : 'alt')}
							>
								<Icon name="repeat" fallback="arrow-right-left" />
							</button>
						</div>
						<div className="loom-shell-spacer" />
						{/* Deliberately NOT part of the Script/Pages pill above — that pair
						    is one logical toggle over the same document, while this swaps
						    in a management list (act/scene order), so it gets its own
						    standalone button on the far side of the row. */}
						<button
							className={mode === 'outline' ? 'loom-writer-outline-btn loom-seg-on' : 'loom-writer-outline-btn'}
							onClick={() => clickTab('outline')}
						>
							{t('view.entity.script.outline')}
						</button>
					</div>

					<div className="loom-writer-toolbar">
						{mode !== 'outline' ? (
							<>
								<div className="loom-search-wrap">
									<input
										className="loom-writer-search"
										type="search"
										placeholder={t('view.script.searchPlaceholder')}
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
									disabled={matches.length === 0}
									onClick={() => gotoMatch(matchIndex - 1)}
								>
									<Icon name="chevron-up" />
								</button>
								<button
									className="loom-rel-filter"
									aria-label={t('view.entity.script.nextMatch')}
									disabled={matches.length === 0}
									onClick={() => gotoMatch(matchIndex + 1)}
								>
									<Icon name="chevron-down" />
								</button>
								{/* After the buttons, not before — so their position doesn't
								    shift when this text appears/disappears/changes length. */}
								<span className="loom-writer-stat">
									{query.trim() === ''
										? ''
										: matches.length === 0
											? t('view.entity.script.noMatches')
											: t('view.entity.script.matchCount', {
													current: (matchIndex % matches.length) + 1,
													total: matches.length,
												})}
								</span>
							</>
						) : null}
						<div className="loom-shell-spacer" />
						{mode === 'pages' ? (
							<>
								<button
									className="loom-rel-filter"
									aria-label={t('view.script.previousPage')}
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
								<span className="loom-writer-stat">{t('view.script.ofCount', { count: pageCount })}</span>
								<button
									className="loom-rel-filter"
									aria-label={t('view.script.nextPage')}
									disabled={currentPage >= pageCount}
									onClick={() => scrollToPage(currentPage + 1)}
								>
									<Icon name="chevron-right" />
								</button>
							</>
						) : (
							// Script and Outline share this spot — Pages uses it for page
							// navigation instead, so these never coexist with that. Both
							// buttons share the same creation modal the entity list's own
							// "New scene"/"New act" use, rather than each view growing
							// its own bare-name prompt.
							<>
								<button
									className="loom-rel-add"
									onClick={() => new CreateEntityModal(plugin, 'scene', project, {}).open()}
								>
									{t('view.entity.script.newSceneAction')}
								</button>
								<button
									className="loom-rel-add"
									onClick={() => new CreateEntityModal(plugin, 'act', project, {}).open()}
								>
									{t('project.newActStub')}
								</button>
								{/* Page breaks are an Outline-only concept — the Script/Pages
								    editors already write a bare `===` by hand, and this
								    button exists so a manually-placed one isn't the only way
								    to get an act-boundary break onto the drag list. */}
								{mode === 'outline' ? (
									<button
										className="loom-rel-add"
										onClick={() => write(appendPageBreak(text))}
									>
										{t('view.script.newPageBreakAction')}
									</button>
								) : null}
							</>
						)}
					</div>

					{mode === 'outline' ? (
						<div className="loom-writer-outline" ref={outlineRef}>
							{/* Column headings — same row shape as the act rows below
							    (grip/caret placeholders reserve their gutters) so "Title"
							    and "Scenes" land exactly over their real columns; the
							    expand/collapse-all toggle takes the caret's own slot,
							    extending that same "caret acts on this row" language to
							    "this one acts on every row". Always shown (not just once
							    there's an act) since the Title page row below needs it
							    too. */}
							<div className="loom-writer-outline-row loom-writer-outline-headrow">
								<span className="loom-subloc-grip-static" aria-hidden="true" />
								<button
									className="loom-row-caret"
									aria-label={allActsCollapsed ? t('view.list.expandAll') : t('view.list.collapseAll')}
									onClick={() => setAllActsCollapsed(!allActsCollapsed)}
								>
									<Icon
										name={allActsCollapsed ? 'list-chevrons-up-down' : 'list-chevrons-down-up'}
										fallback={allActsCollapsed ? 'chevrons-up-down' : 'chevrons-down-up'}
									/>
								</button>
								<span className="loom-writer-row-num">#</span>
								<span className="loom-script-scene-head">{t('project.createEntity.titleLabel')}</span>
								<span className="loom-writer-outline-leader" aria-hidden="true" />
								<span className="loom-writer-row-count">{entityPlural('scene')}</span>
							</div>
							<div
								className={
									outlineDrag?.group === 'acts' ? 'loom-subloc-list loom-subloc-dragging' : 'loom-subloc-list'
										}
									>
									{/* First row, always present — not an act or a page break
									    (no `data-seq-row`, so the drag machinery never sees it),
									    just a shortcut into the same `<details>` the Script/Pages
									    tabs render above regardless of mode. */}
									<div className="loom-writer-outline-row loom-writer-outline-titlepage">
										<span className="loom-subloc-grip-static" aria-hidden="true" />
										<span className="loom-row-caret" aria-hidden="true" />
										<span className="loom-writer-row-num" aria-hidden="true" />
										<button className="loom-subloc-link" onClick={jumpToTitlePage}>
											{t('view.script.titlePage')}
										</button>
										<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
										<span className="loom-writer-row-count">
											{titleFirst ? t('view.entity.script.pageAbbrev', { range: '1' }) : '—'}
										</span>
									</div>
									{topLevelRows.length === 0 ? (
										<div className="loom-attendance-empty">
											{t('view.script.outlineNoActsPre')}
											<code># Act name</code>
											{t('view.script.outlineNoActsPost')}
										</div>
									) : null}
									{(() => {
										let actIndex = 0;
										return topLevelRows.map((row, i) => {
										const grabbed = outlineDrag?.group === 'acts' && outlineDrag.from === i;
										if (row.kind === 'page-break') {
											return (
												<div
													key={row.id}
													className={
														grabbed
															? 'loom-writer-outline-pagebreak loom-subloc-row-slide loom-subloc-row-dragging'
															: 'loom-writer-outline-pagebreak loom-subloc-row-slide'
													}
													style={outlineRowStyle('acts', i)}
													data-seq-row=""
													// Right-click only — deleting a page break isn't
													// destructive enough to warrant a confirm modal (it's
													// one line, trivially retyped/re-added), so a plain
													// context menu is enough.
													onContextMenu={(e) => {
														e.preventDefault();
														const menu = new Menu();
														menu.addItem((item) =>
															item
																.setTitle(t('project.common.delete'))
																.setIcon('trash-2')
																.setWarning(true)
																.onClick(() => {
																	const reordered = removePageBreak(text, row.id);
																	if (reordered !== null) write(reordered);
																})
														);
														menu.showAtMouseEvent(e.nativeEvent);
													}}
												>
													<div className="loom-writer-outline-row">
														{outlineGrip('acts', i, topLevelRows.length, commitTopLevelOrder)}
														<span className="loom-row-caret" aria-hidden="true" />
														<span className="loom-writer-row-num" aria-hidden="true" />
														<span className="loom-writer-outline-pagebreak-label">
															<Icon name="separator-horizontal" fallback="minus" /> {t('view.script.pageBreakLabel')}
														</span>
														<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
														<span className="loom-writer-row-count">
															{t('view.entity.script.pageAbbrev', { range: pageBreakPage(row.line) })}
														</span>
													</div>
												</div>
											);
										}
										const sec = row.sec;
										actIndex += 1;
										const actNum = actIndex;
										const note = actNoteByLoomId.get(sec.loomId);
										const scenes = actScenes(sec);
										const collapsed = isActCollapsed(sec.loomId);
										const sceneGroup = `scenes:${sec.loomId}`;
										const dropTarget =
											outlineDrag?.group.startsWith('scenes:') &&
											outlineDrag.group !== sceneGroup &&
											outlineDrag.hoverActId === sec.loomId;
										return (
											<div
												key={sec.loomId}
												className={[
													dropTarget ? 'loom-writer-outline-act loom-writer-outline-drop-target' : 'loom-writer-outline-act',
													grabbed ? 'loom-subloc-row-slide loom-subloc-row-dragging' : 'loom-subloc-row-slide',
												]
													.filter(Boolean)
													.join(' ')}
												style={outlineRowStyle('acts', i)}
												data-seq-row=""
												data-act-id={sec.loomId}
											>
												<div className="loom-writer-outline-row">
													{outlineGrip('acts', i, topLevelRows.length, commitTopLevelOrder)}
													{scenes.length > 0 ? (
														<button
															className="loom-row-caret"
															aria-label={collapsed ? t('view.script.expandScenesAria') : t('view.script.collapseScenesAria')}
															onClick={() => toggleActCollapsed(sec.loomId)}
														>
															<span className={collapsed ? 'loom-caret' : 'loom-caret loom-caret-open'}>▸</span>
														</button>
													) : (
														<span className="loom-row-caret" aria-hidden="true" />
													)}
													<span className="loom-writer-row-num">{actNum}</span>
													{note ? (
														<button className="loom-subloc-link" onClick={() => view.openEntity(note.path)}>
															{sec.text.trim()}
														</button>
													) : (
														<span className="loom-script-scene-head">{sec.text.trim()}</span>
													)}
													{/* A dashed leader — flex-grow — fills whatever's left
													    between the title and the count, adapting to title
													    length automatically instead of leaving a ragged gap. */}
													<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
													{/* Its own fixed-width column, not sized to its own text —
													    a two-digit count previously nudged this whole cell
													    (and thus its left edge) sideways row to row. */}
													<span className="loom-writer-row-count">
														{tn('view.script.sceneCount', scenes.length)}
													</span>
												</div>
												{!collapsed && scenes.length > 0 ? (
													<div
														className={
															outlineDrag?.group === sceneGroup
																? 'loom-subloc-list loom-subloc-dragging loom-writer-outline-children'
																: 'loom-subloc-list loom-writer-outline-children'
														}
													>
														{scenes.map((scene, si) => {
															const sceneGrabbed = outlineDrag?.group === sceneGroup && outlineDrag.from === si;
															const note2 = sceneNote(scene);
															return (
																<div
																	key={scene.loomId ?? scene.line}
																	className={
																		sceneGrabbed
																			? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging'
																			: 'loom-writer-outline-row loom-subloc-row-slide'
																	}
																	style={outlineRowStyle(sceneGroup, si)}
																	data-seq-row=""
																>
																	{/* No caret placeholder here (unlike the act row) —
																	    scenes never collapse, and keeping the grip close to
																	    the title reads better than preserving strict column
																	    alignment with the act row above. */}
																	{outlineGrip(sceneGroup, si, scenes.length, commitSceneOrder(sec, scenes), sec.loomId)}
																	<span className="loom-writer-row-num">{si + 1}</span>
																	{note2 ? (
																		<button
																			className="loom-subloc-link"
																			onClick={() => view.openEntity(note2.path)}
																		>
																			{scene.heading}
																		</button>
																	) : (
																		<span className="loom-script-scene-head">{scene.heading}</span>
																	)}
																	<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
																	<span className="loom-writer-row-count">
																		{t('view.entity.script.pageAbbrev', { range: scenePages(scene) })}
																	</span>
																</div>
															);
														})}
													</div>
												) : null}
											</div>
										);
									});
									})()}
								</div>
							</div>
					) : mode === 'pages' ? (
						// Every page in one scroller, like a PDF viewer: the page box
						// navigates by scrolling to a page rather than swapping which
						// one exists, so reading straight through still works.
						<div className="loom-screenplay" ref={pagesRef}>
							{navPanel}
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
							<PagesPreviewBody
								pages={bodyPages}
								startPageNumber={titleFirst ? 2 : 1}
								query={query}
								rawText={text}
								comments={scriptNotes.comments}
								altText={scriptNotes.altText}
								onOpenComment={handleOpenComment}
								onCycleAlt={handleCycleAlt}
								onOpenAltMenu={handleOpenAltMenu}
								highlightedAnnotationId={highlightedAnnotationId}
							/>
						</div>
					) : (
						<div className="loom-writer-editor" ref={editorWrapperRef}>
							{navPanel}
							<FountainField
								ref={fountainFieldRef}
								value={text}
								onChange={setText}
								onBlur={() => {
									saveScriptLine();
									void commit(text);
								}}
								characters={parsed.characters}
								locations={parsed.locations}
								entityOptions={entityOptions}
								onOpenCharacter={(name) => {
									if (!project) return;
									const match = plugin.indexer
										.getAll('character', project.root)
										.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
									if (match) view.openEntity(match.path);
								}}
								onOpenLocation={(sceneLoomId) => {
									const note = sceneNotes.find((r) => r.sceneId === sceneLoomId);
									if (!note || note.sceneLocation === '') return;
									const loc = plugin.indexer.resolve(note.sceneLocation, note.path);
									if (loc) view.openEntity(loc.path);
								}}
								onOpenAct={(actLoomId) => {
									if (!project) return;
									const act = plugin.indexer
										.getAll('act', project.root)
										.find((c) => c.actId === actLoomId);
									if (act) view.openEntity(act.path);
								}}
								onOpenEntity={(path) => view.openEntity(path)}
								comments={scriptNotes.comments}
								altText={scriptNotes.altText}
								onCreateComment={handleCreateComment}
								onCreateAlt={handleCreateAlt}
								onOpenComment={handleOpenComment}
								onCycleAlt={handleCycleAlt}
								onOpenAltMenu={handleOpenAltMenu}
								highlightedAnnotationId={highlightedAnnotationId}
							/>
						</div>
					)}
					{openComment ? (
						<CommentPopover
							anchorRect={openComment.rect}
							entries={scriptNotes.comments[openComment.id] ?? []}
							onSaveEntry={(index, text) => handleSaveCommentEntry(openComment.id, index, text)}
							onToggleResolvedEntry={(index) => handleToggleCommentResolved(openComment.id, index)}
							onDeleteEntry={(index) => handleDeleteCommentEntry(openComment.id, index)}
							onAddEntry={(text) => {
								commentsWithNewEntryRef.current.add(openComment.id);
								handleAddCommentReply(openComment.id, text);
							}}
							onClose={handleCloseComment}
						/>
					) : null}

					<details className="loom-script-section">
						<summary>{t('view.script.outlineLinksHeading', { count: parsed.scenes.length })}</summary>
						{groups.length === 0 ? (
							<div className="loom-attendance-empty">
								{t('view.script.outlineNoScenesPre')}
								<code>INT. HOUSE - DAY</code>
								{t('view.script.outlineNoScenesPost')}
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
												<span className="loom-script-scene-page">
													{t('view.entity.script.pageAbbrev', { range: scenePages(scene) })}
												</span>
												<span className="loom-script-scene-cast">{scene.characters.join(', ')}</span>
											</div>
										);
									})}
								</div>
							</div>
						))}
					</details>

					{actless.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{t('view.script.scenesWithoutAct')}</span>
							<div className="loom-tag-row">
								{actless.map((s) => (
									<span key={s.loomId ?? s.line} className="loom-chip">
										{s.heading}
									</span>
								))}
							</div>
							<span className="loom-field-hint">
								{t('view.script.scenesWithoutActHintPre')}
								<code>#</code>
								{t('view.script.scenesWithoutActHintMid')}
								<code># Act name</code>
								{t('view.script.scenesWithoutActHintPost')}
							</span>
						</div>
					) : null}

					{orphans.length > 0 ? (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{t('view.script.scenesNoLongerInScript')}</span>
							<div className="loom-tag-row">
								{orphans.map((o) => (
									<button key={o.path} className="loom-chip" onClick={() => view.openEntity(o.path)}>
										{o.name}
									</button>
								))}
							</div>
							<span className="loom-field-hint">{t('view.script.scenesNoLongerHint')}</span>
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
export function highlight(html: string, query: string): string {
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
 * The Pages-preview page-rendering loop — byte-for-byte identical across the
 * three places it used to be copy-pasted (the main Script view here, and the
 * Act/Scene pages' own Script sections in entity-view.tsx), now a single
 * shared component all three call. Owns `data-line` on every element (the
 * main Script view never had it before this extraction — needed here for
 * margin-icon placement, and it's what entity-view.tsx's exact-line
 * search-scroll already relied on) and the comment/alt-text margin icons
 * themselves, in the page's own unused 1in right margin
 * (`.loom-sp-annotation-icons`, styles.css) — a sibling of each `<p>`, not a
 * child (that would collide with `dangerouslySetInnerHTML`), so both live
 * inside one `.loom-sp-line-wrap` per element; the wrapper carries no
 * margin/padding of its own, so the `<p>`'s normal margins still collapse
 * through it exactly as if it weren't there.
 */
export function PagesPreviewBody({
	pages,
	startPageNumber,
	query,
	rawText,
	comments,
	altText,
	onOpenComment,
	onCycleAlt,
	onOpenAltMenu,
	highlightedAnnotationId,
}: {
	pages: FountainElement[][];
	/** Page number to label the FIRST entry of `pages` with (the main Script
	 *  view's own pagination — 2 when a title page precedes it, else 1).
	 *  `null` suppresses page-number rendering — the Scene/Act excerpt
	 *  previews have no real page number of their own to show. */
	startPageNumber: number | null;
	query: string;
	/** The full raw document/excerpt text these `pages` were laid out from —
	 *  needed to resolve each element's line to whichever annotation spans
	 *  START there (`findAnnotationSpans` works in character-offset space,
	 *  not per-element). */
	rawText: string;
	comments: Record<string, CommentEntry[]>;
	altText: Record<string, AltTextEntry>;
	onOpenComment: (id: string, anchorRect: DOMRect) => void;
	onCycleAlt: (id: string) => void;
	onOpenAltMenu: (id: string) => void;
	/** A marker id a search match currently points at — its icon gets a
	 *  highlight class (an alt-text match's icon, or a comment's icon while
	 *  its popover is being auto-opened) without touching the document. */
	highlightedAnnotationId?: string | null;
}): ReactElement {
	const spansByLine = new Map<number, AnnotationSpan[]>();
	for (const s of findAnnotationSpans(rawText)) {
		const ln = rawText.slice(0, s.from).split('\n').length - 1;
		const list = spansByLine.get(ln);
		if (list) list.push(s);
		else spansByLine.set(ln, [s]);
	}
	// Comment ids still needing attention — fed to `wrapAnnotationMarkersForDisplay`
	// so its span-box class matches the live editor's own persistent tint.
	const unresolvedCommentIds = new Set(
		Object.entries(comments)
			.filter(([, entries]) => !(entries.length > 0 && entries.every((e) => e.resolved)))
			.map(([id]) => id)
	);
	return (
		<>
			{pages.map((elements, i) => {
				const number = startPageNumber === null ? null : i + startPageNumber;
				return (
					<div key={i} className="loom-screenplay-page" data-page={number ?? i + 1}>
						{number !== null ? <div className="loom-screenplay-pagenum">{number}.</div> : null}
						{elements.map((el, j) => {
							const html = highlight(
								wrapAnnotationMarkersForDisplay(
									renderInline(preventOrphans(stripEntityLinksForDisplay(elementText(el)))),
									highlightedAnnotationId ?? null,
									unresolvedCommentIds
								),
								query
							);
							const lineSpans = spansByLine.get(el.line) ?? [];
							return (
								<div key={j} className="loom-sp-line-wrap" data-line={el.line}>
									{el.type === 'scene-heading' ? (
										<p className="loom-sp-scene-heading">
											<span dangerouslySetInnerHTML={{ __html: html }} />
											{el.sceneNumber ? <span className="loom-sp-scene-num">{el.sceneNumber}</span> : null}
										</p>
									) : (
										<p className={`loom-sp-${el.type}`} dangerouslySetInnerHTML={{ __html: html }} />
									)}
									{lineSpans.length > 0 ? (
										<span className="loom-sp-annotation-icons">
											{lineSpans.map((s) => {
												const entries = comments[s.id] ?? [];
												const unresolved =
													s.kind === 'comment' ? !(entries.length > 0 && entries.every((e) => e.resolved)) : false;
												return (
													<span
														key={s.id}
														data-loom-annotation-id={s.id}
														data-loom-annotation-kind={s.kind}
														className={
															highlightedAnnotationId === s.id
																? 'loom-sp-annotation-icon loom-sp-annotation-icon-highlight'
																: 'loom-sp-annotation-icon'
														}
														onClick={(e) => {
															if (s.kind === 'comment') onOpenComment(s.id, e.currentTarget.getBoundingClientRect());
															else onCycleAlt(s.id);
														}}
														onContextMenu={(e) => {
															if (s.kind !== 'alt') return;
															e.preventDefault();
															onOpenAltMenu(s.id);
														}}
													>
														<Icon
															name={
																s.kind === 'comment'
																	? unresolved
																		? 'message-square-dot'
																		: 'message-square'
																	: 'arrow-right-left'
															}
															fallback={s.kind === 'comment' ? 'message-square' : undefined}
														/>
													</span>
												);
											})}
										</span>
									) : null}
								</div>
							);
						})}
					</div>
				);
			})}
		</>
	);
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

/** One node in the script navigation tree — an act or a nested `##`/`###`
 *  section (a branch-tagged one carries its own `branchGroup`). */
export interface NavNode {
	title: string;
	line: number;
	branchGroup: string | null;
	/** The section's own hidden `[[loom:…]]` id — `null` for the synthetic
	 *  root node (`line: -1`) and for the brief window before a freshly
	 *  typed section gets one. Reordering a branch group needs this. */
	loomId: string | null;
	items: NavItem[];
}
export type NavItem =
	| { kind: 'scene'; scene: ParsedScene; items: NavItem[] }
	| { kind: 'section'; node: NavNode }
	| { kind: 'branchPoint'; id: string; items: NavItem[] };

/**
 * Builds the script navigation tree — every section LEVEL, not just the
 * top-level acts, and (optionally) bounded to `[startLine, endLine)` so
 * the Scene page's own mini nav panel can ask for just one scene's own
 * branching, reusing the exact same algorithm as the main Script view's full
 * tree.
 *
 * Walks sections and scenes together in document order (merged and
 * line-sorted) with a stack of currently-open sections, so a scene that
 * falls between two sibling `##` subsections stays attached to whichever one
 * actually precedes it, and content keeps its real reading order instead of
 * "every scene, then every child section" (which separate scenes/children
 * arrays would have produced).
 *
 * A branch-tagged section (`= branch: <id>`, see fountain.ts) is the one
 * exception to plain level-based nesting: it attaches under the nearest
 * SCENE seen so far (in document order, not just the current stack frame —
 * a run of several branch groups in a row, e.g. a reaction choice then an
 * item choice, all belong to the SAME preceding scene even though each
 * branch section's own frame gets pushed and popped in between), not the
 * enclosing act/section. Without this a `## Branch A` after a scene
 * heading rendered as a flush sibling of the act instead of nested under
 * that scene. An ordinary (untagged) nested section is unaffected — it still
 * nests by level exactly as before. A scene heading always belongs to the
 * nearest REAL (non-branch) section in turn — a branch holds prose, never a
 * further scene heading of its own — so hitting one closes any currently
 * open branch frame first (same reasoning as `parseFountain`'s own
 * `sectionStack` in fountain.ts), which is what keeps a scene written AFTER
 * a resolved choice point from staying nested inside the last branch.
 */
export function buildNavTree(parsed: ParsedScript, startLine = 0, endLine = Infinity): NavNode {
	const root: NavNode = { title: '', line: -1, branchGroup: null, loomId: null, items: [] };
	type SceneItem = Extract<NavItem, { kind: 'scene' }>;
	const stack: { node: NavNode; level: number }[] = [{ node: root, level: 0 }];
	let lastScene: SceneItem | null = null;
	const merged = [
		...parsed.sections
			.filter((s) => s.line >= startLine && s.line < endLine)
			.map((s) => ({
				line: s.line,
				kind: 'section' as const,
				level: s.level,
				title: s.text,
				branchGroup: s.branchGroup,
				loomId: s.loomId,
			})),
		...parsed.scenes
			.filter((s) => s.line >= startLine && s.line < endLine)
			.map((s) => ({ line: s.line, kind: 'scene' as const, scene: s })),
	].sort((a, b) => a.line - b.line);
	for (const m of merged) {
		if (m.kind === 'section') {
			while (stack.length > 1 && stack[stack.length - 1].level >= m.level) stack.pop();
			const top = stack[stack.length - 1];
			const node: NavNode = {
				title: m.title,
				line: m.line,
				branchGroup: m.branchGroup,
				loomId: m.loomId,
				items: [],
			};
			if (m.branchGroup !== null && lastScene) {
				// Every sibling sharing this decision point's identifier nests
				// under ONE shared parent (rather than sitting as flush siblings
				// under the scene), so the nav panel shows the decision point
				// itself — and how many of them a scene has — not just its
				// branches. Several groups in a row (a reaction choice, then an
				// item choice) each get their own parent; find-by-id rather than
				// "reuse the last one" copes with that even if they aren't
				// perfectly contiguous.
				let group = lastScene.items.find(
					(it): it is Extract<NavItem, { kind: 'branchPoint' }> =>
						it.kind === 'branchPoint' && it.id === m.branchGroup
				);
				if (!group) {
					group = { kind: 'branchPoint', id: m.branchGroup, items: [] };
					lastScene.items.push(group);
				}
				group.items.push({ kind: 'section', node });
			} else {
				top.node.items.push({ kind: 'section', node });
			}
			if (m.branchGroup === null) lastScene = null;
			stack.push({ node, level: m.level });
		} else {
			while (stack.length > 1 && stack[stack.length - 1].node.branchGroup !== null) stack.pop();
			const item: SceneItem = { kind: 'scene', scene: m.scene, items: [] };
			stack[stack.length - 1].node.items.push(item);
			lastScene = item;
		}
	}
	return root;
}

/**
 * Renders one nav item — a scene (its own button, plus any branch children
 * nested beneath it) or a section (recurses via `renderNavTreeNode`).
 *
 * Shared across all three nav panels — the main Script view's full tree, the
 * Act page's (bounded to that act), and the Scene page's (bounded to
 * that scene) — so they're genuinely the SAME navigation at different
 * scopes, not three separate implementations that could drift. `jump` is the
 * caller's own line-to-position logic (different for Script vs Pages mode,
 * and for how a bounded panel's absolute script line maps back to its own
 * excerpt's line numbering).
 */
export function renderNavTreeItem(
	item: NavItem,
	depth: number,
	jump: (line: number) => void
): ReactElement {
	if (item.kind === 'section') return renderNavTreeNode(item.node, depth, jump);
	if (item.kind === 'branchPoint') {
		return (
			<div key={`branch-${item.id}`}>
				{/* Not clickable — a decision point has no line of its own to
				    jump to, it's just the shared identifier its sibling
				    branches were tagged with (`= branch: <id>`). */}
				<span className="loom-script-nav-act loom-script-nav-sub loom-script-nav-branchpoint">
					{item.id}
				</span>
				<div className="loom-script-nav-children">
					{item.items.map((child) => renderNavTreeItem(child, depth + 1, jump))}
				</div>
			</div>
		);
	}
	return (
		<div key={item.scene.loomId ?? item.scene.line}>
			<button
				className="loom-script-nav-scene"
				onClick={() => jump(item.scene.line)}
				title={item.scene.heading}
			>
				<span className="loom-script-nav-num">{item.scene.index}</span>
				<span className="loom-script-nav-text">{item.scene.heading}</span>
			</button>
			{item.items.length > 0 ? (
				<div className="loom-script-nav-children">
					{item.items.map((child) => renderNavTreeItem(child, depth + 1, jump))}
				</div>
			) : null}
		</div>
	);
}

/** Renders one nav tree level, recursing into nested sections. `depth` 1 is
 *  a top-level act (styled like today); 2+ is a nested `##`/`###`
 *  section, indented and lighter-weight so it reads as a sub-level. A
 *  branch-tagged section gets its own modifier class too. */
export function renderNavTreeNode(
	node: NavNode,
	depth: number,
	jump: (line: number) => void
): ReactElement {
	return (
		<div key={`${node.line}-${node.title}`}>
			{node.title !== '' ? (
				<button
					className={
						(depth > 1 ? 'loom-script-nav-act loom-script-nav-sub' : 'loom-script-nav-act') +
						(node.branchGroup !== null ? ' loom-script-nav-branch' : '')
					}
					disabled={node.line < 0}
					onClick={() => jump(node.line)}
					title={node.title}
				>
					{node.title}
				</button>
			) : null}
			<div className={depth > 0 ? 'loom-script-nav-children' : undefined}>
				{node.items.map((item) => renderNavTreeItem(item, depth + 1, jump))}
			</div>
		</div>
	);
}

/** The lines of the script belonging to one scene, by its loom id. */
export function sceneScriptText(script: string | null, sceneId: string): string | null {
	if (script === null || sceneId === '') return null;
	const parsed = parseFountain(script);
	const scene = parsed.scenes.find((sc) => sc.loomId === sceneId);
	if (!scene) return null;
	return script
		.split(/\r?\n/)
		.slice(scene.line, sceneEndLine(parsed, scene))
		.join('\n')
		.replace(/\s+$/, '');
}

/** The lines of the script belonging to one act (its `#` section line
 *  through every scene under it), by the section's loom id — the Act
 *  page's own Script section excerpt, mirroring `sceneScriptText`. */
export function actScriptText(script: string | null, actId: string): string | null {
	if (script === null || actId === '') return null;
	const parsed = parseFountain(script);
	const section = parsed.sections.find((sec) => sec.level === 1 && sec.loomId === actId);
	if (!section) return null;
	const lines = script.split(/\r?\n/);
	const endLine = nextTopSectionLine(parsed, section.line) ?? lines.length;
	return lines
		.slice(section.line, endLine)
		.join('\n')
		.replace(/\s+$/, '');
}

/**
 * Re-writes the script's centered act-title lines from the Act notes.
 *
 * Called when a display title is edited on an Act page, where the script
 * view may not even be open — without it the note and the script would silently
 * disagree until the script was next touched.
 */
export async function pushActTitles(plugin: LoomLoomPlugin, project: ProjectDef): Promise<void> {
	const scriptFile = findScriptFile(plugin, project);
	if (!scriptFile) return;
	const titles = new Map<string, string>();
	for (const act of plugin.indexer.getAll('act', project.root)) {
		if (act.actId !== '') {
			titles.set(act.actId, act.displayTitle.trim() !== '' ? act.displayTitle : act.name);
		}
	}
	if (titles.size === 0) return;
	try {
		const raw = await plugin.app.vault.read(scriptFile);
		const next = applyDisplayTitles(raw, titles);
		if (next !== raw) await plugin.app.vault.modify(scriptFile, next);
	} catch (e) {
		console.error('Loom Loom: could not write act titles into the script', e);
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
		new Notice(t('view.script.editWriteFailed'));
		return false;
	}
}

/**
 * Like `editScript`, but also re-syncs Scene/Act notes from the result.
 *
 * `editScript` alone only rewrites the .fountain file — the notes' derived
 * fields (act link, location, cast, script order, …) are otherwise
 * re-synced only when the Script view itself is open and commits. Structural
 * edits made from elsewhere (the Act/Scene pages' own move/reorder/
 * delete/heading actions) need that sync to happen immediately, or the note
 * silently disagrees with the script until the Script view is next opened —
 * which is what made "move to another act" look broken from the Scene
 * page: the script moved, but the note's own act link never updated.
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
	// `cleanAnnotationMarkers` rides along too — a structural edit (move,
	// delete, heading rewrite) is exactly the kind of change that can leave a
	// comment/alt-text marker orphaned, same reasoning as `runCommit`'s own
	// pass in the main Script view.
	const changed = await editScript(plugin, project, (raw) => {
		const applied = apply(raw);
		return applied === null ? null : cleanAnnotationMarkers(renumberScenes(applied)).text;
	});
	if (changed) {
		const scriptFile = findScriptFile(plugin, project);
		if (scriptFile) {
			const raw = await plugin.app.vault.read(scriptFile);
			await syncScenes(plugin, project, parseFountain(raw), raw);
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
 * Trashes a Scene or Act note AND removes its backing block from the
 * script — a scene/act note that survives a script removal (or vice
 * versa) just resurrects itself on the next `syncScenes` pass, so the two
 * have to go together. Deleting an Act cascades onto every Scene note
 * that pointed at it (`sceneAct`): the act's script block held their
 * headings too, so once it's gone those notes have nothing left to reflect
 * and are trashed rather than left as permanent orphans.
 */
export async function deleteScriptEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	record: EntityRecord
): Promise<void> {
	if (record.type === 'scene' && record.sceneId !== '') {
		const sceneId = record.sceneId;
		await editScript(plugin, project, (raw) => removeScene(raw, sceneId));
	} else if (record.type === 'act' && record.actId !== '') {
		const actId = record.actId;
		const scenes = plugin.indexer
			.getAll('scene', record.project)
			.filter(
				(sc) =>
					sc.sceneAct !== '' &&
					plugin.indexer.resolve(sc.sceneAct, sc.path)?.path === record.path
			);
		await editScript(plugin, project, (raw) => removeAct(raw, actId));
		for (const sc of scenes) {
			const f = plugin.app.vault.getFileByPath(sc.path);
			if (!f) continue;
			await purgeEntityReferences(plugin, sc.path, sc.project);
			await plugin.app.fileManager.trashFile(f);
		}
	}
	const file = plugin.app.vault.getFileByPath(record.path);
	if (!file) return;
	await purgeEntityReferences(plugin, record.path, record.project);
	await plugin.app.fileManager.trashFile(file);
}
