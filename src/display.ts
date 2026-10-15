import { formatLoomDate } from './calendar';
import type { ProjectDef } from './indexer';
import { roleOf } from './project-kind';
import type { EntityRecord } from './types';
import type LoomLoomPlugin from './main';

/* Display helpers with no React in them, so modals (project.ts) and views
 * share one copy. */

/**
 * User-facing label of a record. Dated anchors (Sessions) display their date —
 * their file name is managed and never exposed inside the plugin. Acts are
 * named, so they fall through to the name like everything else.
 */
export function recordLabel(record: EntityRecord, project: ProjectDef | null): string {
	if (roleOf(record.type) === 'anchor' && record.date && project) {
		return formatLoomDate(record.date, project.config);
	}
	return record.name;
}

/** Formatted date of a record, or empty string. */
export function recordDate(record: EntityRecord, project: ProjectDef | null): string {
	if (!record.date || !project) return record.date?.raw ?? '';
	return formatLoomDate(record.date, project.config);
}

/** Search/display label for a location: a sublocation reads "Secret room,
 *  Tavern, City" (its full ancestry, so same-named places stay distinct). The
 *  `subChipFullAncestry` setting can trim it to just the sublocation's own name. */
export function locationLabel(record: EntityRecord, plugin: LoomLoomPlugin): string {
	if (record.type !== 'location' || record.parentLocation === null) return record.name;
	if (!plugin.settings.subChipFullAncestry) return record.name;
	return [record, ...plugin.indexer.locationAncestors(record)].map((r) => r.name).join(', ');
}

/** Location picker order: top-level locations before sublocations (so searching
 *  "City" lists City above "Tavern, City"), then alphabetically within each. */
export function mainLocationFirst(a: EntityRecord, b: EntityRecord): number {
	const da = a.parentLocation === null ? 0 : 1;
	const db = b.parentLocation === null ? 0 : 1;
	return da - db || a.name.localeCompare(b.name);
}

/** Grows (or shrinks) a textarea to fit its content, with the `rows`
 *  attribute as the floor. */
export function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	// Collapse to the natural (rows-attribute) height to measure the content,
	// then grow to it; the offset/client difference re-adds the borders.
	el.setCssProps({ height: 'auto' });
	el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * A one-line preview of a note's Notes (`record.notes`): the first line with
 * any text, its markdown reduced to plain text — `[[target|label]]` to
 * `label`, emphasis marks, a heading's `#`s and a list bullet dropped.
 */
export function notesPreview(notes: string): string {
	const line = notes.split('\n').find((l) => l.trim() !== '') ?? '';
	return line
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/[*_~`]+/g, '')
		.replace(/^\s*(#+|[-+*]|\d+\.|>)\s+/, '')
		.trim();
}
