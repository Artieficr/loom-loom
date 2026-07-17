import { legacyFmKeys } from './types';

/**
 * Frontmatter read/write helpers shared by every surface that edits notes.
 * Reads are case-insensitive (Obsidian's Properties UI can rewrite key
 * casing) and fall back to legacy un-prefixed spellings; writes always emit
 * the loom-prefixed key and delete the stale spellings.
 */

/** Sets `key`, deleting other casings of it and any of the `legacy` names. */
export function setFmKey(
	fm: Record<string, unknown>,
	key: string,
	value: unknown,
	legacy: string[] = []
) {
	const lowers = new Set([key, ...legacy].map((k) => k.toLowerCase()));
	for (const k of Object.keys(fm)) {
		if (k !== key && lowers.has(k.toLowerCase())) delete fm[k];
	}
	fm[key] = value;
}

/** Case-insensitive frontmatter read. */
export function fmValue(fm: Record<string, unknown>, key: string): unknown {
	if (fm[key] !== undefined) return fm[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() === lower) return fm[k];
	}
	return undefined;
}

/** fmValue with fallback to the key's legacy (un-prefixed) spellings. */
export function fmLoomValue(fm: Record<string, unknown>, key: string): unknown {
	const value = fmValue(fm, key);
	if (value !== undefined) return value;
	for (const legacy of legacyFmKeys(key)) {
		const v = fmValue(fm, legacy);
		if (v !== undefined) return v;
	}
	return undefined;
}

/** setFmKey for a loom key: writes the loom spelling, cleans legacy ones up. */
export function setLoomKey(fm: Record<string, unknown>, key: string, value: unknown) {
	setFmKey(fm, key, value, legacyFmKeys(key));
}
