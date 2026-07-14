import { useCallback, useSyncExternalStore } from 'react';
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
