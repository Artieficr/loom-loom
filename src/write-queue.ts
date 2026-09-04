/**
 * Generic per-key promise queues, serializing concurrent async operations
 * that touch the same underlying resource (a file, by path) so overlapping
 * calls land in request order instead of racing on a stale read — the
 * classic read-then-write lost-update bug.
 *
 * Lives in its own dependency-free module rather than inside `editScript`/
 * `editBook` (script-buffer.ts/book-view.tsx, the two original call sites)
 * because `project.ts`'s own scene/act creation writes need to serialize
 * against the SAME underlying file too. Script's own creation modals
 * (`submitScene`/`submitAct`, project.ts) now write through
 * `script-buffer.ts`'s shared in-memory buffer directly (`mutateScriptBuffer`/
 * `flushScriptBufferNow`, a module with no dependency on project.ts, so no
 * import-cycle problem to dodge there) rather than a private duplicate
 * queued through this registry — but Prose hasn't been migrated onto an
 * equivalent shared buffer yet, so `project.ts`'s own private `editBookFile`
 * still exists for exactly this reason: `project.ts` can't import from
 * book-view.tsx (it already imports FROM project.ts, e.g. `CreateEntityModal`),
 * so `editBookFile` needs this registry to serialize against `editBook`'s own
 * writes to the same file. A confirmed real gap this closes: before this, a
 * creation-modal write and any other write against the same script/book file
 * went through two entirely separate, uncoordinated read-modify-write paths
 * and could still race each other the exact way `editScript`/`editBook`'s
 * own internal queue was built to prevent for every OTHER caller.
 *
 * `registryName` scopes the key space (`'script'`/`'book'`) so a script
 * path and a book path never collide even if a project's names happened to
 * coincide; every caller touching the same registry+key genuinely
 * serializes, regardless of which module the call originates from.
 */
const registries = new Map<string, Map<string, Promise<unknown>>>();

function registry(registryName: string): Map<string, Promise<unknown>> {
	let r = registries.get(registryName);
	if (!r) {
		r = new Map();
		registries.set(registryName, r);
	}
	return r;
}

export function queueWrite<T>(registryName: string, key: string, run: () => Promise<T>): Promise<T> {
	const queue = registry(registryName);
	const started = (queue.get(key) ?? Promise.resolve()).then(run);
	queue.set(
		key,
		started.catch(() => {})
	);
	return started;
}
