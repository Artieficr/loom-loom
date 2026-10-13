import type { App } from 'obsidian';

/**
 * Per-key promise queues: async operations on the same key (a file's vault
 * path) run one after another in request order instead of racing on a stale
 * read. Dependency-free so `project.ts`, which views import, can share the
 * same queue as `editBook`/`editScript` for the same file.
 */
const queues = new Map<string, Promise<unknown>>();

export function queueWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
	const started = (queues.get(key) ?? Promise.resolve()).then(run);
	queues.set(
		key,
		started.catch(() => {})
	);
	return started;
}

/** Queued read → `apply` → write of the vault file at `path`. Resolves false
 *  when the file is missing, `apply` returns null or unchanged text, or the
 *  write fails (logged as `what`, then `onFail`). */
export function editVaultFile(
	app: App,
	path: string,
	apply: (text: string) => string | null,
	what: string,
	onFail?: () => void
): Promise<boolean> {
	return queueWrite(path, async () => {
		const file = app.vault.getFileByPath(path);
		if (!file) return false;
		try {
			const raw = await app.vault.read(file);
			const next = apply(raw);
			if (next === null || next === raw) return false;
			await app.vault.modify(file, next);
			return true;
		} catch (e) {
			console.error(`Loom Loom: could not edit the ${what}`, e);
			onFail?.();
			return false;
		}
	});
}
