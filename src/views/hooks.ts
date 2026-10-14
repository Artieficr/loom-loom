import { Dispatch, SetStateAction, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { App } from 'obsidian';
import { LoomIndexer, ProjectDef } from '../indexer';

/**
 * Subscribes a component to index changes; returns the index version so any
 * data read from the indexer during render stays fresh.
 */
export function useIndexVersion(indexer: LoomIndexer): number {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const ref = indexer.events.on('changed', onChange);
			return () => indexer.events.offref(ref);
		},
		[indexer]
	);
	return useSyncExternalStore(subscribe, () => indexer.version);
}

/**
 * Resolves a project from a view-state root path, falling back to the only
 * project in the vault when the state carries none (e.g. opened via command).
 */
export function resolveProject(indexer: LoomIndexer, root: string | null): ProjectDef | null {
	if (root !== null) {
		const byRoot = indexer.getProjectByRoot(root);
		if (byRoot) return byRoot;
	}
	const all = indexer.getProjects();
	return all.length === 1 ? all[0] : null;
}

/** A string-union UI preference remembered per `key` in localStorage (not
 *  vault data); a stored value outside `allowed` reads as `fallback`. A null
 *  key is neither read nor written. */
export function usePersistedChoice<T extends string>(
	key: string | null,
	allowed: readonly T[],
	fallback: T
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState<T>(() => {
		const saved = key ? window.localStorage.getItem(key) : null;
		return saved !== null && (allowed as readonly string[]).includes(saved) ? (saved as T) : fallback;
	});
	useEffect(() => {
		if (key) window.localStorage.setItem(key, value);
	}, [key, value]);
	return [value, setValue];
}

/** A ref for a scrolling panel that's re-created each time it opens (the
 *  Script/Book jump list): restores its scroll position from `key`
 *  (localStorage) when it mounts and saves it as you scroll, so it reopens
 *  where you left it. */
export function useRememberedScroll(key: string | null): (el: HTMLElement | null) => void {
	return useCallback(
		(el: HTMLElement | null) => {
			if (!el || !key) return;
			const saved = Number(window.localStorage.getItem(key));
			if (saved > 0) el.scrollTop = saved;
			let timer: number | undefined;
			el.addEventListener('scroll', () => {
				window.clearTimeout(timer);
				timer = window.setTimeout(() => window.localStorage.setItem(key, String(Math.round(el.scrollTop))), 150);
			});
		},
		[key]
	);
}

/** The text of the vault file at `path`, re-read whenever that file is
 *  modified, created or deleted; null while it doesn't exist (or `path` is
 *  null). Reads with `vault.read`, never `cachedRead` — a 'modify' event for
 *  a write this session just made can fire before the read cache catches up. */
export function useVaultFileText(app: App, path: string | null): string | null {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		if (path === null) {
			setText(null);
			return;
		}
		let cancelled = false;
		const read = () => {
			const file = app.vault.getFileByPath(path);
			if (!file) {
				setText(null);
				return;
			}
			void app.vault.read(file).then((raw) => {
				if (!cancelled) setText(raw);
			});
		};
		read();
		const touched = (f: { path: string }) => {
			if (f.path === path) read();
		};
		const refs = [app.vault.on('modify', touched), app.vault.on('create', touched), app.vault.on('delete', touched)];
		return () => {
			cancelled = true;
			for (const ref of refs) app.vault.offref(ref);
		};
	}, [app, path]);
	return text;
}
