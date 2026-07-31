import { ProjectKind } from '../project-kind';
import { LicenseTier } from './types';

/**
 * Freemium rule: one project of each kind (player/gm/writer, and any future
 * kind) is free with no feature restrictions; a paid key unlocks unlimited
 * projects of every kind. Structurally typed on `{config:{kind}}` rather than
 * importing `ProjectDef` from `indexer.ts` — the same decoupling trick
 * `project-kind.ts` already documents ("so this module never imports
 * calendar.ts and the cycle stays broken"). Pure and Node-runnable.
 */
export function canCreateProjectOfKind(
	tier: LicenseTier,
	existingProjects: readonly { config: { kind: ProjectKind } }[],
	kind: ProjectKind
): boolean {
	if (tier === 'paid') return true;
	return !existingProjects.some((p) => p.config.kind === kind);
}
