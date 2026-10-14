import { Notice, normalizePath } from 'obsidian';
import type LoomLoomPlugin from './main';
import { ProjectDef, isSyncConflictPath } from './indexer';
import { ENTITY_META, ENTITY_TYPES, EntityRecord, EntityType, FM, entityLabel, normalizeEntityType, pcGroupStub } from './types';
import { fmValue } from './fm';
import { LocaleKey, t, tn } from './i18n';
import {
	deleteEntityNote,
	ensureFolder,
	frontmatterLinkpaths,
	linkPointsAt,
	MENTIONABLE_TYPES,
	purgeEntityReferences,
	RecordSuggestModal,
	relinkDeletedNote,
	REPEATABLE_NAME_TYPES,
	unlinkDeletedNote,
} from './project';
import { features } from './project-kind';
import { findEntityLinks, liveSceneIds, parseFountain, removeAct, removeScene } from './fountain';
import { liveBookChapterIds, parseBook, removeBookAct, removeBookChapter } from './prose';
import { editScript, findScriptFile } from './views/script-buffer';
import { editBook, findBookFile, syncActsChapters } from './views/book-view';
import { entityBacking, sceneName, syncScenes } from './views/script-view';
import { managedEntityFileName } from './naming';

/**
 * Notes deleted OUTSIDE Loom — Obsidian's file explorer, another app, a sync —
 * that leave something behind: a scene/act/chapter's text still in the
 * script/book, or references in other notes (properties, `[[links]]`,
 * `@[mentions]`). Each becomes a row in its project's window, which covers
 * every tab of that project (only those tabs) until each row is resolved — a
 * deleted note's leftovers have to be dealt with, and there's no close
 * button that could act on its own. In-app deletes clean up before they
 * trash and never get here (`plugin.deletePromptPause`). Deletes made while
 * Obsidian was closed send no event; `ensureChecked` finds them the first
 * time a project's tab shows.
 */

/** Raw text of every entity note, so one deleted outside Loom can be put back
 *  exactly — by the time the delete event fires the file is already gone,
 *  and Obsidian has no event before a delete. */
const noteCopies = new Map<string, string>();

/** Starts keeping `noteCopies` current: seeded from the built index, then
 *  refreshed from every metadata change (which carries the file's text). */
export function trackNoteCopies(plugin: LoomLoomPlugin): void {
	const { vault, metadataCache } = plugin.app;
	plugin.registerEvent(
		metadataCache.on('changed', (file, data, cache) => {
			if (normalizeEntityType(fmValue(cache.frontmatter ?? {}, FM.type))) noteCopies.set(file.path, data);
			else noteCopies.delete(file.path);
		})
	);
	plugin.registerEvent(
		vault.on('rename', (file, oldPath) => {
			const copy = noteCopies.get(oldPath);
			if (copy === undefined) return;
			noteCopies.delete(oldPath);
			noteCopies.set(file.path, copy);
		})
	);
	for (const r of plugin.indexer.getAll()) {
		const file = vault.getFileByPath(r.path);
		if (!file) continue;
		vault
			.cachedRead(file)
			.then((text) => {
				if (!noteCopies.has(r.path)) noteCopies.set(r.path, text);
			})
			.catch(() => undefined);
	}
}

/** How long a delete waits before it's looked at: a sync client delivers a
 *  moved note as delete-then-create, which must not count as a deletion. */
const SETTLE_MS = 3000;
const queued = new Map<string, EntityRecord>();
let queueTimer: number | undefined;

/** Whether a deleted note is still waiting on a decision — queued, or a row
 *  in the window. Maps holds off clearing its leftovers until it isn't. */
export function isDeletePending(path: string): boolean {
	return queued.has(path) || [...states.values()].some((state) => state.rows.has(path));
}

/** Called by the indexer for every entity note that leaves the vault. */
export function noteDeletedOutside(plugin: LoomLoomPlugin, record: EntityRecord): void {
	if (plugin.deletePromptPause > 0) return;
	queued.set(record.path, record);
	window.clearTimeout(queueTimer);
	queueTimer = window.setTimeout(() => void settleQueued(plugin), SETTLE_MS);
}

/** Whether a deleted note has come back by another route — the same path, or
 *  (a sync move) the same type and name, or the same scene/act/chapter id. */
function reappeared(plugin: LoomLoomPlugin, record: EntityRecord): boolean {
	if (plugin.app.vault.getAbstractFileByPath(record.path)) return true;
	// Scene/act/chapter/session names repeat, so only their ids identify them.
	const name = REPEATABLE_NAME_TYPES.has(record.type) ? null : record.name.trim().toLowerCase();
	return plugin.indexer.getAll(record.type, record.project).some(
		(r) =>
			r.name.trim().toLowerCase() === name ||
			(record.sceneId !== '' && r.sceneId === record.sceneId) ||
			(record.actId !== '' && r.actId === record.actId) ||
			(record.chapterId !== '' && r.chapterId === record.chapterId)
	);
}

async function settleQueued(plugin: LoomLoomPlugin): Promise<void> {
	const records = [...queued.values()];
	const rows: Row[] = [];
	for (const record of records) {
		if (reappeared(plugin, record)) continue;
		const project = plugin.indexer.getProjectByRoot(record.project);
		if (!project) continue;
		rows.push({ record, project, copy: noteCopies.get(record.path) ?? null, trashPath: await trashCopyOf(plugin, record.path) });
	}
	await addRows(plugin, rows);
	// Only now — `isDeletePending` must stay true until the window holds them.
	for (const record of records) queued.delete(record.path);
}

// --- Conflicts ---------------------------------------------------------------

interface Row {
	record: EntityRecord;
	project: ProjectDef;
	/** Text to put the note back from; null when no copy was kept. */
	copy: string | null;
	/** The note in the vault's `.trash` folder, when it's there. */
	trashPath: string | null;
}

interface Conflict {
	/** Where its own text still sits, for a scene/act/chapter. */
	text: 'script' | 'book' | null;
	/** Notes (and the project's Book) that still refer to it. */
	places: number;
}

/** Removes one note's block from the script/book text; null when it isn't there. */
function removeBackingBlock(text: string, record: EntityRecord, inScript: boolean): string | null {
	if (inScript) {
		if (record.type === 'scene') return removeScene(text, record.sceneId);
		if (record.type === 'act') return removeAct(text, record.actId);
		return null;
	}
	if (record.type === 'chapter') return removeBookChapter(text, record.chapterId);
	if (record.type === 'act') return removeBookAct(text, record.actId);
	return null;
}

async function conflictOf(plugin: LoomLoomPlugin, row: Row): Promise<Conflict | null> {
	const { vault, metadataCache } = plugin.app;
	const { record, project } = row;
	let text: Conflict['text'] = null;
	const backing = entityBacking(project, record);
	const backingFile =
		backing === 'script' ? findScriptFile(plugin, project) : backing === 'book' ? findBookFile(plugin, project) : null;
	if (backing && backingFile && removeBackingBlock(await vault.read(backingFile), record, backing === 'script') !== null) {
		text = backing;
	}
	let places = 0;
	for (const file of vault.getMarkdownFiles()) {
		// A sync client's conflict copy isn't a note Loom reads or cleans.
		if (file.path === record.path || isSyncConflictPath(file.path)) continue;
		const cache = metadataCache.getFileCache(file);
		const points = (linkpath: string) => linkPointsAt(plugin, linkpath, file.path, record.path);
		if (frontmatterLinkpaths(cache?.frontmatter).some(points) || (cache?.links ?? []).some((l) => points(l.link))) places++;
	}
	const book = findBookFile(plugin, project);
	if (book) {
		const raw = await vault.read(book);
		if ([...raw.matchAll(/\[\[([^\]|]+)/g)].some((m) => linkPointsAt(plugin, m[1], book.path, record.path))) places++;
	}
	// `@[Name]` mentions match by name — only while no other entity carries it.
	const script = MENTIONABLE_TYPES.includes(record.type) ? findScriptFile(plugin, project) : null;
	const name = record.name.trim().toLowerCase();
	const nameTaken = plugin.indexer
		.getAll(undefined, project.root)
		.some((r) => MENTIONABLE_TYPES.includes(r.type) && r.name.trim().toLowerCase() === name);
	if (script && !nameTaken && findEntityLinks(await vault.read(script)).some((m) => m.name.toLowerCase() === name)) {
		places++;
	}
	return text !== null || places > 0 ? { text, places } : null;
}

// --- Checking a project ----------------------------------------------------------

/**
 * Finds a project's notes deleted while Obsidian was closed (no delete event
 * was ever sent): links that still name one of its managed file names
 * (`<Project> <Type> <name>`) but resolve to nothing. Only Loom-shaped names
 * count, so a link typed ahead to a note you haven't made yet is left alone.
 */
async function findMissingNotes(plugin: LoomLoomPlugin, project: ProjectDef): Promise<Row[]> {
	const { vault, metadataCache } = plugin.app;
	const found = new Map<string, Row>();
	const consider = async (linkpath: string, from: string) => {
		const base = linkpath.split('#')[0].trim().split('/').pop() ?? '';
		if (base === '') return;
		// The name pattern first: resolving every link in the vault is the slow part.
		const parsed = parseManagedName(project, base);
		if (!parsed || metadataCache.getFirstLinkpathDest(base, from)) return;
		const path = normalizePath(`${project.root}/${ENTITY_META[parsed.type].folder}/${base}.md`);
		const record: EntityRecord = { ...pcGroupStub(project.root, parsed.name), path, type: parsed.type };
		found.set(path.toLowerCase(), { record, project, copy: null, trashPath: await trashCopyOf(plugin, path) });
	};
	for (const file of vault.getMarkdownFiles()) {
		if (isSyncConflictPath(file.path)) continue;
		const cache = metadataCache.getFileCache(file);
		for (const l of cache?.links ?? []) await consider(l.link, file.path);
		for (const lp of frontmatterLinkpaths(cache?.frontmatter)) await consider(lp, file.path);
	}
	const book = findBookFile(plugin, project);
	if (book) for (const m of (await vault.read(book)).matchAll(/\[\[([^\]|]+)/g)) await consider(m[1], book.path);
	// A scene/act/chapter heading whose note is gone: its text is still in the
	// script/book even when nothing links to it. Wins over a link-found row
	// for the same note, since it knows the heading's id.
	for (const row of await findOrphanedHeadings(plugin, project)) found.set(row.record.path.toLowerCase(), row);
	return [...found.values()];
}

/** Script/book headings carrying an id no note has — a scene/act/chapter
 *  note deleted while Obsidian was closed (or a heading whose note was never
 *  made; Keep text makes it, so that case is harmless). */
async function findOrphanedHeadings(plugin: LoomLoomPlugin, project: ProjectDef): Promise<Row[]> {
	const rows: Row[] = [];
	const known = (type: EntityType, id: string) =>
		plugin.indexer.getAll(type, project.root).some((r) => r.sceneId === id || r.actId === id || r.chapterId === id);
	const add = async (type: EntityType, name: string, ids: Partial<Pick<EntityRecord, 'sceneId' | 'actId' | 'chapterId'>>) => {
		const base = managedEntityFileName(project.name, type, name);
		const path = normalizePath(`${project.root}/${ENTITY_META[type].folder}/${base}.md`);
		const record: EntityRecord = { ...pcGroupStub(project.root, name), path, type, ...ids };
		rows.push({ record, project, copy: null, trashPath: await trashCopyOf(plugin, path) });
	};
	type Heading = { type: EntityType; idKey: 'sceneId' | 'actId' | 'chapterId'; id: string | null; name: string };
	const headings: Heading[] = [];
	const script = features(project.config).script ? findScriptFile(plugin, project) : null;
	if (script) {
		const parsed = parseFountain(await plugin.app.vault.read(script));
		for (const sc of parsed.scenes) headings.push({ type: 'scene', idKey: 'sceneId', id: sc.loomId, name: sceneName(sc) });
		for (const sec of parsed.sections.filter((x) => x.level === 1)) {
			headings.push({ type: 'act', idKey: 'actId', id: sec.loomId, name: sec.text });
		}
	}
	const book = features(project.config).book ? findBookFile(plugin, project) : null;
	if (book) {
		const parsed = parseBook(await plugin.app.vault.read(book));
		for (const act of parsed.acts) headings.push({ type: 'act', idKey: 'actId', id: act.loomId, name: act.title });
		for (const ch of parsed.chapters) headings.push({ type: 'chapter', idKey: 'chapterId', id: ch.loomId, name: ch.title });
	}
	for (const h of headings) {
		if (h.id && !known(h.type, h.id)) await add(h.type, h.name, { [h.idKey]: h.id });
	}
	return rows;
}

/**
 * Checks a project once per session, the first time one of its tabs shows.
 * A quick pass runs as soon as the index is built; if it finds anything the
 * project's tabs show "checking" straight away. The real pass waits for the
 * vault to settle (a half-synced vault looks like deleted notes) and turns
 * what's still missing into rows.
 */
async function ensureChecked(plugin: LoomLoomPlugin, root: string): Promise<void> {
	const state = stateOf(root);
	if (state.checked) return;
	state.checked = true;
	await plugin.indexReady;
	const project = plugin.indexer.getProjectByRoot(root);
	if (!project) {
		state.checkDone = true;
		return;
	}
	if ((await findMissingNotes(plugin, project)).length > 0) {
		state.checking = true;
		refreshAll(plugin);
	}
	await plugin.vaultReady;
	await addRows(plugin, await findMissingNotes(plugin, project));
	state.checking = false;
	state.checkDone = true;
	refreshAll(plugin);
}

/**
 * Whether a script/book sync should hold off re-making the note for heading
 * `id`: while the project's check is still running (opening the Script view
 * syncs on load, which would quietly re-make a deleted scene's note empty
 * before the check could offer it back), and while that heading waits in
 * the window.
 */
export function holdsNoteRecreate(root: string, id: string): boolean {
	const state = states.get(root);
	if (!state) return false;
	if (state.checked && !state.checkDone) return true;
	return [...state.rows.values()].some(
		({ row }) => row.record.sceneId === id || row.record.actId === id || row.record.chapterId === id
	);
}

/** A project's managed file name read back into its type and display name. */
function parseManagedName(project: ProjectDef, base: string): { type: EntityType; name: string } | null {
	const sub = `${project.name} Sublocation of `;
	if (base.startsWith(sub)) {
		const rest = base.slice(sub.length);
		const dash = rest.lastIndexOf(' — ');
		return { type: 'location', name: dash === -1 ? rest : rest.slice(dash + 3) };
	}
	for (const type of ENTITY_TYPES) {
		const prefix = `${project.name} ${ENTITY_META[type].label} `;
		if (base.startsWith(prefix)) return { type, name: base.slice(prefix.length) };
	}
	return null;
}

/** The note's copy in the vault's own `.trash` folder (Obsidian's "Move to
 *  Obsidian trash" setting), or null. The system trash can't be reached. */
async function trashCopyOf(plugin: LoomLoomPlugin, path: string): Promise<string | null> {
	const trashPath = `.trash/${path.split('/').pop() ?? path}`;
	return (await plugin.app.vault.adapter.exists(trashPath)) ? trashPath : null;
}

// --- Per-project state and the in-tab window -------------------------------------

type Action = 'putBack' | 'keepText' | 'removeText' | 'cleanUp';

/** Each action's button label — on a row, and in the "For all" row. */
const ACTION_LABELS: Record<Action, [LocaleKey, LocaleKey]> = {
	putBack: ['outsideDelete.putBack', 'outsideDelete.putAllBack'],
	keepText: ['outsideDelete.keepText', 'outsideDelete.keepAll'],
	removeText: ['outsideDelete.removeText', 'outsideDelete.removeAll'],
	cleanUp: ['outsideDelete.cleanUp', 'outsideDelete.cleanUp'],
};

interface ProjectState {
	rows: Map<string, { row: Row; conflict: Conflict }>;
	/** Rows an action settled by design (Keep text: the sync remakes the
	 *  note, but the index may not show it yet) — dropped without a re-check. */
	settled: Set<string>;
	/** The project's check is still running: rows can't be trusted yet. */
	checking: boolean;
	/** An action is running — every tab's buttons are disabled. */
	busy: boolean;
	/** The session's check for notes deleted while Obsidian was closed has
	 *  started / finished. */
	checked: boolean;
	checkDone: boolean;
}

const states = new Map<string, ProjectState>();

function stateOf(root: string): ProjectState {
	let state = states.get(root);
	if (!state) {
		state = { rows: new Map(), settled: new Set(), checking: false, busy: false, checked: false, checkDone: false };
		states.set(root, state);
	}
	return state;
}

/** A Loom tab: while its project has rows (or is being checked), the window
 *  covers the tab's content — only that tab, so the rest of Obsidian stays
 *  usable, and every tab of the project shows the same window. */
export interface OverlayHost {
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	overlayProject(): string | null;
}

const hosts = new Set<OverlayHost>();

export function attachOverlayHost(plugin: LoomLoomPlugin, host: OverlayHost): () => void {
	hosts.add(host);
	syncOverlay(plugin, host);
	return () => {
		hosts.delete(host);
		removeOverlay(host);
	};
}

/** Shows, updates or removes one tab's window — called on every render of
 *  the tab (its project can change when it navigates). */
export function syncOverlay(plugin: LoomLoomPlugin, host: OverlayHost): void {
	const root = host.overlayProject();
	if (root === null) {
		removeOverlay(host);
		return;
	}
	void ensureChecked(plugin, root);
	const state = stateOf(root);
	if (!state.checking && state.rows.size === 0) {
		removeOverlay(host);
		return;
	}
	let el = host.containerEl.querySelector<HTMLElement>(':scope > .loom-od-overlay');
	if (!el) {
		host.containerEl.addClass('loom-od-host');
		el = host.containerEl.createDiv({ cls: 'loom-od-overlay' });
	}
	// Nothing behind the window can take focus or input.
	host.contentEl.inert = true;
	renderWindow(plugin, state, el);
}

function removeOverlay(host: OverlayHost): void {
	host.containerEl.querySelector(':scope > .loom-od-overlay')?.remove();
	host.containerEl.removeClass('loom-od-host');
	host.contentEl.inert = false;
}

function refreshAll(plugin: LoomLoomPlugin): void {
	for (const host of hosts) syncOverlay(plugin, host);
}

/** Adds the rows that really conflict to their projects' windows. */
async function addRows(plugin: LoomLoomPlugin, rows: Row[]): Promise<void> {
	for (const row of rows) {
		const state = stateOf(row.project.root);
		if (state.rows.has(row.record.path)) continue;
		const conflict = await conflictOf(plugin, row);
		if (conflict) state.rows.set(row.record.path, { row, conflict });
	}
	refreshAll(plugin);
}

function canPutBack(row: Row): boolean {
	return row.copy !== null || row.trashPath !== null;
}

function actionsFor(row: Row, conflict: Conflict): Action[] {
	const out: Action[] = [];
	if (canPutBack(row)) out.push('putBack');
	if (conflict.text !== null) out.push('keepText', 'removeText');
	else out.push('cleanUp');
	return out;
}

function renderWindow(plugin: LoomLoomPlugin, state: ProjectState, el: HTMLElement): void {
	el.empty();
	const card = el.createDiv({ cls: 'loom-od-card' });
	card.createEl('h2', { cls: 'loom-od-title', text: t('outsideDelete.title') });
	if (state.checking) card.createEl('p', { cls: 'loom-od-checking', text: t('outsideDelete.checking') });
	const entries = [...state.rows.values()];
	if (entries.length === 0) return;
	card.createEl('p', { text: t('outsideDelete.intro') });

	const anyText = entries.some((e) => e.conflict.text !== null);
	const anyOther = entries.some((e) => e.conflict.text === null);
	const anyCopy = entries.some((e) => e.row.copy !== null);
	const anyTrashOnly = entries.some((e) => e.row.copy === null && e.row.trashPath !== null);
	const anyMissing = entries.some((e) => !canPutBack(e.row));
	const legend: [string, string][] = [];
	if (anyCopy) legend.push([t('outsideDelete.putBack'), t('outsideDelete.putBackDesc')]);
	if (anyTrashOnly) legend.push([t('outsideDelete.restoreFromTrash'), t('outsideDelete.restoreFromTrashDesc')]);
	if (anyText) {
		legend.push([t('outsideDelete.keepText'), t('outsideDelete.keepTextDesc')]);
		legend.push([t('outsideDelete.removeText'), t('outsideDelete.removeTextDesc')]);
	}
	if (anyOther) {
		legend.push([t('outsideDelete.linkTo'), t('outsideDelete.linkToDesc')]);
		legend.push([t('outsideDelete.cleanUp'), t('outsideDelete.cleanUpDesc')]);
	}
	if (anyMissing) legend.push([t('outsideDelete.checkAgain'), t('outsideDelete.checkAgainDesc')]);
	for (const [name, desc] of legend) {
		const line = card.createEl('p', { cls: 'loom-choice-desc' });
		line.createEl('strong', { text: name });
		line.appendText(` — ${desc}`);
	}

	const button = (parent: HTMLElement, action: Action, paths: string[], forAll = false) => {
		const [single, all] = ACTION_LABELS[action];
		// A row with no kept copy can only come back from the trash.
		const fromTrash = action === 'putBack' && !forAll && state.rows.get(paths[0])?.row.copy === null;
		const label = t(fromTrash ? 'outsideDelete.restoreFromTrash' : forAll ? all : single);
		// Removing text is the destructive one — red; everything else accent.
		const btn = parent.createEl('button', { cls: action === 'removeText' ? 'mod-warning' : 'mod-cta', text: label });
		btn.disabled = state.busy;
		btn.addEventListener('click', () =>
			void run(plugin, state, async () => {
				for (const path of paths) {
					const entry = state.rows.get(path);
					if (!entry) continue;
					const hasText = entry.conflict.text !== null;
					// "Keep all" only concerns rows with text; "Remove all" removes a
					// scene/act/chapter's text and cleans up every other row.
					if (forAll && action === 'keepText' && !hasText) continue;
					const act = forAll && action === 'removeText' && !hasText ? 'cleanUp' : action;
					await apply(plugin, state, act, entry.row);
				}
			})
		);
	};

	const list = card.createDiv({ cls: 'loom-od-list' });
	for (const { row, conflict } of entries) {
		const item = list.createDiv({ cls: 'loom-od-row' });
		const info = item.createDiv({ cls: 'loom-od-info' });
		info.createEl('strong', { text: row.record.name });
		info.createSpan({ cls: 'loom-od-type', text: ` ${entityLabel(row.record.type)}` });
		const details: string[] = [];
		if (conflict.text === 'script') details.push(t('outsideDelete.inScript'));
		if (conflict.text === 'book') details.push(t('outsideDelete.inBook'));
		if (conflict.places > 0) details.push(tn('outsideDelete.places', conflict.places));
		if (!canPutBack(row)) details.push(t('outsideDelete.noCopy'));
		info.createDiv({ cls: 'loom-od-detail', text: details.join(' ') });
		const buttons = item.createDiv({ cls: 'loom-od-buttons' });
		for (const action of actionsFor(row, conflict)) {
			// Link to… sits just before Clean up: both settle a note's
			// references, one by re-pointing them, one by removing them.
			if (action === 'cleanUp') linkToButton(plugin, state, buttons, row);
			button(buttons, action, [row.record.path]);
		}
	}

	const all = card.createDiv({ cls: 'loom-od-all' });
	const paths = [...state.rows.keys()];
	if (entries.length > 1) {
		all.createSpan({ cls: 'loom-od-all-label', text: t('outsideDelete.forAll') });
		if (entries.every((e) => canPutBack(e.row))) button(all, 'putBack', paths, true);
		if (anyText) button(all, 'keepText', paths, true);
		button(all, 'removeText', paths, true);
	}
	if (anyMissing) {
		const again = all.createEl('button', { text: t('outsideDelete.checkAgain') });
		again.disabled = state.busy;
		again.addEventListener('click', () =>
			void run(plugin, state, async () => {
				for (const entry of state.rows.values()) {
					entry.row.trashPath = await trashCopyOf(plugin, entry.row.record.path);
				}
			})
		);
	}
}

/** "Link to…": points every reference to the missing note at another note of
 *  the same type, picked from the project — for a note renamed or replaced
 *  outside Loom, where Clean up would throw the references away. */
function linkToButton(plugin: LoomLoomPlugin, state: ProjectState, parent: HTMLElement, row: Row): void {
	const btn = parent.createEl('button', { cls: 'mod-cta', text: t('outsideDelete.linkTo') });
	btn.disabled = state.busy;
	btn.addEventListener('click', () => {
		const candidates = plugin.indexer
			.getAll(row.record.type, row.project.root)
			.filter((r) => r.path !== row.record.path)
			.sort((a, b) => a.name.localeCompare(b.name));
		new RecordSuggestModal(
			plugin.app,
			candidates,
			(target) =>
				void run(plugin, state, async () => {
					await relinkDeletedNote(plugin, row.record, target);
					state.settled.add(row.record.path);
				}),
			t('outsideDelete.linkToPick', { type: entityLabel(row.record.type).toLowerCase() })
		).open();
	});
}

/** Runs one action with every tab's buttons disabled, then re-checks every
 *  row — one action can settle others (removing an act takes its scenes). */
async function run(plugin: LoomLoomPlugin, state: ProjectState, work: () => Promise<void>): Promise<void> {
	if (state.busy) return;
	state.busy = true;
	refreshAll(plugin);
	try {
		await work();
	} catch (e) {
		console.error('Loom Loom: outside-delete action failed', e);
	}
	// Other rows may have been settled by this action too (removing an act
	// takes its scenes along) — judge them once the cache has caught up.
	await metadataSettled(plugin);
	for (const [path, entry] of [...state.rows]) {
		const conflict =
			state.settled.has(path) || plugin.app.vault.getAbstractFileByPath(path) ? null : await conflictOf(plugin, entry.row);
		if (conflict) entry.conflict = conflict;
		else state.rows.delete(path);
	}
	state.busy = false;
	refreshAll(plugin);
}

async function apply(plugin: LoomLoomPlugin, state: ProjectState, action: Action, row: Row): Promise<void> {
	const { record, project } = row;
	const inScript = features(project.config).script;
	if (action === 'putBack') {
		const { vault } = plugin.app;
		if (vault.getAbstractFileByPath(record.path)) return;
		const text = row.copy ?? (row.trashPath ? await vault.adapter.read(row.trashPath) : null);
		if (text === null) return;
		try {
			await ensureFolder(plugin.app, record.path.slice(0, record.path.lastIndexOf('/')));
			await vault.create(record.path, text);
			if (row.copy === null && row.trashPath) await vault.adapter.remove(row.trashPath);
		} catch (e) {
			console.error(`Loom Loom: could not put back ${record.path}`, e);
			new Notice(t('outsideDelete.putBackFailed', { name: record.name }));
		}
		return;
	}
	if (action === 'keepText') {
		// The sync remakes the note under the same name, so links resolve again.
		// The row leaves first, or `holdsNoteRecreate` would hold this very sync.
		state.settled.add(record.path);
		state.rows.delete(record.path);
		const file = inScript ? findScriptFile(plugin, project) : findBookFile(plugin, project);
		if (!file) return;
		const raw = await plugin.app.vault.read(file);
		if (inScript) await syncScenes(plugin, project, parseFountain(raw), raw);
		else await syncActsChapters(plugin, project, parseBook(raw), raw);
		return;
	}
	if (action === 'removeText') await removeBlock(plugin, project, record, inScript);
	await purgeEntityReferences(plugin, record.path, record.project);
	await unlinkDeletedNote(plugin, record);
	// Settled by this clean-up itself: re-checking it right away reads
	// Obsidian's metadata cache before it has caught up with these writes,
	// which kept rows around after "Clean up all".
	state.settled.add(record.path);
}

/** Resolves once Obsidian's metadata cache reports it has processed pending
 *  changes, or after `ms` — whichever comes first. */
function metadataSettled(plugin: LoomLoomPlugin, ms = 1500): Promise<void> {
	return new Promise((resolve) => {
		const { metadataCache } = plugin.app;
		const done = () => {
			metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = metadataCache.on('resolved', done);
		const timer = window.setTimeout(done, ms);
	});
}

/** Removes a deleted scene/act/chapter's block, then trashes the notes of the
 *  scenes/chapters that left the file with a removed act — what the in-app
 *  act delete does too. */
async function removeBlock(plugin: LoomLoomPlugin, project: ProjectDef, record: EntityRecord, inScript: boolean): Promise<void> {
	const memberIds = (text: string) => (inScript ? liveSceneIds(parseFountain(text)) : liveBookChapterIds(parseBook(text)));
	let gone = new Set<string>();
	const apply = (raw: string): string | null => {
		const next = removeBackingBlock(raw, record, inScript);
		if (next === null) return null;
		const after = memberIds(next);
		gone = new Set([...memberIds(raw)].filter((id) => !after.has(id)));
		return next;
	};
	if (inScript) await editScript(plugin, project, apply);
	else await editBook(plugin, project, apply);
	for (const r of plugin.indexer.getAll(inScript ? 'scene' : 'chapter', project.root)) {
		if (gone.has(inScript ? r.sceneId : r.chapterId)) await deleteEntityNote(plugin, r);
	}
}
