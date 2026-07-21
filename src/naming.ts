import { ENTITY_META, EntityType } from './types';

/**
 * Managed file-name construction, dependency-free so both the indexer (the
 * startup migration) and project.ts can use it without a circular import.
 * File names are `<Project> <Type label> <name>` (`<Project> Session <date>`
 * for sessions); the user-entered name itself lives in `loomName`
 * frontmatter and is the only thing plugin UI shows or searches.
 */

export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function managedSessionFileName(projectName: string, dateRaw: string): string {
	return sanitizeFileName(`${projectName} Session ${dateRaw}`.trim()) || `Session ${dateRaw}`;
}

export function managedEntityFileName(
	projectName: string,
	type: EntityType,
	name: string,
	/** Locations only: the parent location's display name, so sublocations of
	 *  same-named places stay distinct (`<Project> Sublocation of <parent> — <name>`). */
	parentName?: string,
	/** Items only: the owning character's name for a character-specific copy
	 *  (`<Project> Item <name> — <owner>`); `name` here is the original item's name. */
	ownerName?: string
): string {
	if (type === 'session') return managedSessionFileName(projectName, name);
	const fallback = `New ${ENTITY_META[type].label.toLowerCase()}`;
	if (type === 'location' && parentName !== undefined && parentName.trim() !== '') {
		return sanitizeFileName(`${projectName} Sublocation of ${parentName} — ${name}`.trim()) || fallback;
	}
	if (type === 'item' && ownerName !== undefined && ownerName.trim() !== '') {
		return sanitizeFileName(`${projectName} Item ${name} — ${ownerName}`.trim()) || fallback;
	}
	return sanitizeFileName(`${projectName} ${ENTITY_META[type].label} ${name}`.trim()) || fallback;
}
