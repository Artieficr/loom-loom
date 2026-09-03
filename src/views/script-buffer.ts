import { useCallback, useSyncExternalStore } from 'react';
import { Notice, TFile, normalizePath } from 'obsidian';
import type LoomLoomPlugin from '../main';
import type { ProjectDef } from '../indexer';
import { SCRIPT_EXTENSION } from '../types';
import { t } from '../i18n';
import { queueWrite } from '../write-queue';
import {
	applyBranchLabels,
	cleanAnnotationMarkers,
	collapseBranchBlankLines,
	reconcileScriptText,
	renumberBranchGroups,
	renumberScenes,
} from '../fountain';

/**
 * One project's whole `.fountain` script, held live in memory and edited
 * into DIRECTLY by every UI operation — disk is a background persistence
 * target, not the thing an operation has to read fresh to be correct. This
 * replaces the previous architecture (every operation reading the file
 * fresh from disk, transforming, writing back) that caused a real class of
 * stale-read races: an empty-scene paste rejected because a scene-body
 * offset was computed against on-disk content while the live editor buffer
 * had already grown by a line; an undo-then-paste-again sequence reviving a
 * branch that had just been undone, because the second paste read
 * pre-undo disk content.
 *
 * **This module has NO dependency on `script-view.tsx`, deliberately** —
 * script-view.tsx imports FROM here (for both the low-level file utilities
 * below and the buffer API), matching this codebase's own established
 * one-directional-dependency convention (`project.ts`'s own doc comment on
 * `editScriptFile` notes the identical reasoning: it can't import from
 * script-view.tsx because script-view.tsx already imports FROM project.ts).
 * The one place this module needs script-view.tsx-resident logic —
 * `syncScenes`, run after every successful flush — is wired via
 * `registerPostFlushHook` (below) instead of a static import: script-view.tsx
 * registers it once, at its own module load, rather than this module
 * importing it back and creating a cycle.
 *
 * Keyed by `scriptFilePath(project)` — the SAME key `write-queue.ts`'s own
 * `'script'` registry already uses, so `flushScriptBufferNow` (below) can
 * reuse `editScript`'s serialization unchanged rather than inventing a
 * second lock.
 *
 * A buffer, once created, lives for the rest of the plugin session — its
 * `vault.on('modify'|'create')` listener is registered via
 * `plugin.registerEvent` (Obsidian's own Component-lifecycle cleanup, tied
 * to plugin unload) rather than torn down when the last subscribing
 * component unmounts, so an external change landing while no Scene/Script
 * view happens to be open for that project is still correctly reconciled
 * the moment one opens again — no separate "did I miss anything while
 * closed" reload check needed.
 */
interface ScriptBufferState {
	loaded: boolean;
	/** Current in-memory canonical text — what every reader/writer actually
	 *  operates against. */
	text: string;
	/** Text as of the last CONFIRMED disk write — the echo baseline
	 *  (`reconcileScriptText`'s own doc comment, fountain.ts, has the full
	 *  reasoning) and the merge base. */
	lastFlushedText: string;
	version: number;
	subscribers: Set<() => void>;
	activeRegion: { sceneId: string } | null;
	debounceTimer: number | null;
	flushing: Promise<void> | null;
	flushAgainAfter: boolean;
	listenerInstalled: boolean;
}

const buffers = new Map<string, ScriptBufferState>();

/** What runs after a successful flush, alongside re-reading the confirmed
 *  disk text — `syncScenes` + the comment/alt-text sidecar prune
 *  (`pruneOrphanedAnnotations`, script-view.tsx), registered once at that
 *  module's own load rather than imported here (see this file's own top
 *  doc comment for why). `undefined` only in the brief window before
 *  script-view.tsx has loaded — not a real concern in practice, since
 *  nothing calls `flushScriptBufferNow` before the app itself has finished
 *  loading every view module. */
type PostFlushHook = (plugin: LoomLoomPlugin, project: ProjectDef, text: string) => Promise<void>;
let postFlushHook: PostFlushHook | undefined;

/** Registers the post-flush hook — called exactly once, from
 *  script-view.tsx's own module body, immediately after `pruneOrphanedAnnotations`
 *  is defined there. */
export function registerPostFlushHook(hook: PostFlushHook): void {
	postFlushHook = hook;
}

/**
 * The project's Fountain script file's path: `<root>/<Project>.fountain`.
 * Moved here (from script-view.tsx) alongside `findScriptFile`/
 * `createScriptFile`/`editScript`/`prepareScriptText` — genuinely
 * low-level script I/O primitives with no dependency on the rest of
 * script-view.tsx, and needed here to keep this module's own dependency
 * direction one-way.
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
	const content = [`Title: ${project.name}`, 'Credit: Written by', 'Author:', 'Draft date:', '', ''].join('\n');
	return plugin.app.vault.create(scriptFilePath(project), content);
}

/**
 * Reads the script, applies `apply`, writes it back if changed — the one
 * low-level primitive every script write (whether through the buffer's own
 * `flushScriptBufferNow` or a still-unmigrated direct caller) funnels
 * through. Serialized via `write-queue.ts`'s `'script'` registry, keyed by
 * `scriptFilePath(project)`, so overlapping writers against the SAME
 * project's script never race each other's read-modify-write cycle.
 */
export async function editScript(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): Promise<boolean> {
	return queueWrite('script', scriptFilePath(project), async () => {
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
	});
}

/**
 * The renumber/label/clean pipeline every structural script edit runs
 * through before it's written to disk. Renumbering rides along with every
 * structural edit: a move/reorder physically relocates a scene's block,
 * number included, so an existing `#N#` numbering scheme is kept
 * sequential rather than traveling with the scene to its new, wrong
 * position. A script with no numbers at all is untouched (`renumberScenes`
 * is a no-op when nothing is numbered). `cleanAnnotationMarkers` rides
 * along too — a structural edit (move, delete, heading rewrite) is exactly
 * the kind of change that can leave a comment/alt-text marker orphaned.
 * `applyBranchLabels` rides along for the identical reason: a branch's
 * printed `>**Title**<` marker is auto-derived from its OWN heading text,
 * with no separate note field the way an Act's `loomDisplayTitle` has — a
 * title rename through `renameSectionTitle` would otherwise leave that
 * printed label stale until the next flush happened to touch it.
 */
export function prepareScriptText(text: string): string {
	return cleanAnnotationMarkers(collapseBranchBlankLines(applyBranchLabels(renumberBranchGroups(renumberScenes(text)))))
		.text;
}

function newState(): ScriptBufferState {
	return {
		loaded: false,
		text: '',
		lastFlushedText: '',
		version: 0,
		subscribers: new Set(),
		activeRegion: null,
		debounceTimer: null,
		flushing: null,
		flushAgainAfter: false,
		listenerInstalled: false,
	};
}

function notify(state: ScriptBufferState): void {
	state.version++;
	for (const cb of state.subscribers) cb();
}

/** Adopts `text` as both the current and last-flushed value (no pending
 *  local edit to protect) — used for the initial disk load and for a
 *  reconciled external change that isn't in conflict with anything. */
function adopt(state: ScriptBufferState, text: string): void {
	state.loaded = true;
	state.text = text;
	state.lastFlushedText = text;
	notify(state);
}

/** Reconciles a fresh disk read against the buffer's current in-memory
 *  state via `reconcileScriptText` (fountain.ts) and applies the result —
 *  the one place `vault.on('modify')` events actually land. */
function reconcile(state: ScriptBufferState, diskText: string): void {
	if (!state.loaded) {
		adopt(state, diskText);
		return;
	}
	const result = reconcileScriptText(state.text, state.lastFlushedText, diskText, state.activeRegion);
	switch (result.kind) {
		case 'echo':
			return;
		case 'adopt':
			adopt(state, result.text);
			return;
		case 'merged':
		case 'local-wins':
			// The merge/fallback result differs from what's now on disk —
			// `lastFlushedText` has to reflect the disk read we just
			// reconciled AGAINST (not the merged text itself), or the next
			// flush's own `diskRaw !== baseline` guard would incorrectly
			// think its own write raced a change that's already accounted
			// for here.
			state.text = result.text;
			state.lastFlushedText = diskText;
			notify(state);
			return;
	}
}

function ensureBuffer(plugin: LoomLoomPlugin, project: ProjectDef): ScriptBufferState {
	const path = scriptFilePath(project);
	let state = buffers.get(path);
	if (state) return state;
	state = newState();
	buffers.set(path, state);

	if (!state.listenerInstalled) {
		state.listenerInstalled = true;
		const read = () => {
			const file = findScriptFile(plugin, project);
			if (!file) return;
			void plugin.app.vault.read(file).then((raw) => reconcile(state, raw));
		};
		read();
		const touched = (f: { path: string }) => {
			if (f.path === path) read();
		};
		plugin.registerEvent(plugin.app.vault.on('modify', touched));
		plugin.registerEvent(plugin.app.vault.on('create', touched));
	}
	return state;
}

/** Subscribes a component to one project's script buffer; returns its
 *  current text (`null` until the first disk read lands, matching the old
 *  `useScriptText`'s own "loading" contract) so data read from it during
 *  render stays fresh — a `useSyncExternalStore`-based hook, following the
 *  same precedent `hooks.ts`'s `useIndexVersion` already establishes in
 *  this codebase rather than a new state-sharing idiom. */
export function useScriptBuffer(plugin: LoomLoomPlugin, project: ProjectDef | null): string | null {
	const path = project ? scriptFilePath(project) : null;
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!project) return () => {};
			const state = ensureBuffer(plugin, project);
			state.subscribers.add(onChange);
			return () => {
				state.subscribers.delete(onChange);
			};
		},
		// `path` (not `project`) is the real identity here — `project` itself
		// is a fresh object most renders, which would otherwise resubscribe
		// on every render for no reason.
		[plugin, path]
	);
	const getSnapshot = useCallback(() => {
		if (!project) return null;
		const state = buffers.get(scriptFilePath(project));
		return state?.loaded ? state.text : null;
	}, [plugin, path]);
	return useSyncExternalStore(subscribe, getSnapshot);
}

/** Fully synchronous, in-memory-only mutation — no disk I/O at all. Every
 *  script write migrates to this for its in-memory half, followed by
 *  `scheduleFlush` for the disk-persist half. Returns whether a change was
 *  actually made (mirrors `editScript`'s own `apply === null ||
 *  apply === current` no-op contract) — `false` also (with a console
 *  warning) if the buffer isn't loaded yet, matching how every existing
 *  call site already gated on `scriptText !== null` before allowing an
 *  edit. */
export function mutateScriptBuffer(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string | null
): boolean {
	const state = ensureBuffer(plugin, project);
	if (!state.loaded) {
		console.warn('Loom Loom: mutateScriptBuffer called before the script buffer finished loading');
		return false;
	}
	const next = apply(state.text);
	if (next === null || next === state.text) return false;
	state.text = next;
	notify(state);
	return true;
}

/** Marks which scene (if any) is the currently-open Scene page's own body —
 *  the ONE region `reconcileScriptText` protects with a real merge instead
 *  of falling back to "local wins wholesale." Called from the Scene page's
 *  own mount/`record.sceneId`-change effect, `null` on unmount. */
export function registerActiveRegion(plugin: LoomLoomPlugin, project: ProjectDef, region: { sceneId: string } | null): void {
	const state = ensureBuffer(plugin, project);
	state.activeRegion = region;
}

/** The disk-persist step — debounced by default (`opts.debounceMs`,
 *  0 = flush on next tick, coalescing synchronous callers within the same
 *  tick), `600` used only by the Scene body's own non-urgent typing path
 *  (the one genuinely-debounced edit surface in this app; every other
 *  mutation already schedules an immediate flush). Resets any previously
 *  scheduled timer for this buffer — the usual debounce contract. */
export function scheduleFlush(plugin: LoomLoomPlugin, project: ProjectDef, opts?: { debounceMs?: number }): void {
	const state = ensureBuffer(plugin, project);
	if (state.debounceTimer !== null) window.clearTimeout(state.debounceTimer);
	const ms = opts?.debounceMs ?? 0;
	state.debounceTimer = window.setTimeout(() => {
		state.debounceTimer = null;
		void flushScriptBufferNow(plugin, project);
	}, ms);
}

/** Writes the CURRENT in-memory text to disk immediately (bypassing any
 *  pending debounce — callers that need to know persistence actually
 *  landed, e.g. before showing a `Notice`, should `await` this directly
 *  instead of `scheduleFlush`), then runs the registered post-flush hook
 *  (`syncScenes` + the sidecar prune, script-view.tsx's
 *  `pruneOrphanedAnnotations`) against the confirmed disk text. Coalesces
 *  overlapping calls: a flush requested while one is already in flight
 *  doesn't start a second overlapping write — it waits on the current one,
 *  then reflushes once, covering whatever changed in between. */
export async function flushScriptBufferNow(plugin: LoomLoomPlugin, project: ProjectDef): Promise<void> {
	const state = ensureBuffer(plugin, project);
	if (state.flushing) {
		state.flushAgainAfter = true;
		return state.flushing;
	}
	const run = (async () => {
		if (!state.loaded || state.text === state.lastFlushedText) return;
		const baseline = state.lastFlushedText;
		const desired = state.text;
		const changed = await editScript(plugin, project, (diskRaw) => {
			if (diskRaw !== baseline) return null;
			return prepareScriptText(desired);
		});
		if (!changed) {
			// The disk moved out from under `baseline` between this flush's
			// own turn in `write-queue.ts`'s queue and now — a genuine
			// external write racing in. That write's own `vault.on('modify')`
			// event has already reconciled (or is about to), which re-set
			// `lastFlushedText` and scheduled its own flush — nothing further
			// to do here.
			return;
		}
		const scriptFile = findScriptFile(plugin, project);
		if (!scriptFile) return;
		const raw = await plugin.app.vault.read(scriptFile);
		state.lastFlushedText = raw;
		if (state.text === desired) {
			// No newer local edit arrived while this flush was in flight —
			// fold in whatever `prepareScriptText` itself changed (renumbering,
			// label sync, marker cleanup) so the buffer matches disk exactly.
			state.text = raw;
		}
		notify(state);
		await postFlushHook?.(plugin, project, raw);
	})();
	state.flushing = run;
	try {
		await run;
	} finally {
		state.flushing = null;
		if (state.flushAgainAfter) {
			state.flushAgainAfter = false;
			await flushScriptBufferNow(plugin, project);
		}
	}
}
