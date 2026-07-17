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

export function managedEntityFileName(projectName: string, type: EntityType, name: string): string {
	if (type === 'session') return managedSessionFileName(projectName, name);
	return (
		sanitizeFileName(`${projectName} ${ENTITY_META[type].label} ${name}`.trim()) ||
		`New ${ENTITY_META[type].label.toLowerCase()}`
	);
}
