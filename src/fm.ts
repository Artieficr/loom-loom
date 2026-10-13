import type { App, TFile } from 'obsidian';
import { FM } from './types';

/**
 * Frontmatter read/write helpers shared by every surface that edits notes.
 * Reads are case-insensitive (Obsidian's Properties UI can rewrite key
 * casing); writes emit the exact key and delete other casings of it.
 */

/** Case-insensitive frontmatter read. */
export function fmValue(fm: Record<string, unknown>, key: string): unknown {
	if (fm[key] !== undefined) return fm[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() === lower) return fm[k];
	}
	return undefined;
}

/** Sets a loom key, deleting other casings of it. */
export function setLoomKey(fm: Record<string, unknown>, key: string, value: unknown) {
	const lower = key.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k !== key && k.toLowerCase() === lower) delete fm[k];
	}
	fm[key] = value;
}

/** Deletes a frontmatter key, case-insensitively — several fields clear a relationship by
 *  removing the key entirely rather than writing it empty (detaching a
 *  sublocation, clearing a region, reviving a PC). */
export function clearFmKeys(fm: Record<string, unknown>, ...names: string[]): void {
	const wanted = new Set(names.map((n) => n.toLowerCase()));
	for (const k of Object.keys(fm)) {
		if (wanted.has(k.toLowerCase())) delete fm[k];
	}
}

/** Edits a loom list key: reads it under any casing (a non-array reads as
 *  empty), hands a copy to `apply` — which may mutate it or return a
 *  replacement — and writes the result back under the loom key. */
export function editLoomList(
	fm: Record<string, unknown>,
	key: string,
	apply: (arr: unknown[]) => unknown[] | void
): void {
	const cur = fmValue(fm, key);
	const arr = Array.isArray(cur) ? [...(cur as unknown[])] : [];
	setLoomKey(fm, key, apply(arr) ?? arr);
}

/** Appends one value to a loom list key. */
export function appendLoomList(fm: Record<string, unknown>, key: string, value: unknown): void {
	editLoomList(fm, key, (arr) => {
		arr.push(value);
	});
}

/** A fresh session-note entry: empty text, stamped with the current time
 *  so it sorts last. `session` is the raw link (`''` = no session). */
export function newNoteEntry(session: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { session, text: '', seq: Date.now(), ...extra };
}

/** Adds `link` to the `key` list of an event's FIRST session note, creating
 *  a session-less note when it has none yet. */
export function involveInFirstNote(fm: Record<string, unknown>, key: 'involved' | 'places', link: string): void {
	editLoomList(fm, FM.sessionNotes, (arr) => {
		if (arr.length === 0) {
			arr.push(newNoteEntry('', { [key]: [link] }));
			return;
		}
		const first = arr[0];
		const note: Record<string, unknown> =
			typeof first === 'object' && first !== null
				? { ...(first as Record<string, unknown>) }
				: { session: '', text: typeof first === 'string' ? first : '' };
		note[key] = [...(Array.isArray(note[key]) ? (note[key] as unknown[]) : []), link];
		arr[0] = note;
	});
}

/** `processFrontMatter` on the note at `path`; resolves false when there is
 *  no such file. Rejects if the write itself fails. */
export async function writeFmAt(
	app: App,
	path: string,
	apply: (fm: Record<string, unknown>) => void
): Promise<boolean> {
	const file = app.vault.getFileByPath(path);
	if (!file) return false;
	await app.fileManager.processFrontMatter(file, apply);
	return true;
}

/** Matches a note's leading frontmatter block (used to split it from the body). */
export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

/** A note's text without its frontmatter block. */
export function stripFrontmatter(text: string): string {
	return text.replace(FRONTMATTER_RE, '');
}

/** Replaces a note's body, keeping its frontmatter block as-is. */
export async function writeNoteBody(app: App, file: TFile, body: string): Promise<void> {
	await app.vault.process(file, (data) => {
		const m = FRONTMATTER_RE.exec(data);
		return (m ? m[0] : '') + body;
	});
}

/** `list` (a raw relationships array) without the entries whose `target`
 *  string `drop` matches; entries without a string target always stay. */
export function withoutRelationships(list: unknown[], drop: (target: string) => boolean): unknown[] {
	return list.filter((rel) => {
		if (typeof rel !== 'object' || rel === null) return true;
		const target = (rel as { target?: unknown }).target;
		return typeof target !== 'string' || !drop(target);
	});
}
