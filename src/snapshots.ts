import { App, Modal, Notice, Setting, TFile, Vault, normalizePath } from 'obsidian';
import type LoomLoomPlugin from './main';
import type { ProjectDef } from './indexer';
import { ConfirmModal, ensureFolder } from './project';
import { findScriptFile, flushScriptBufferNow } from './views/script-buffer';
import { t, tn } from './i18n';

/**
 * Project snapshots: point-in-time copies of every text file in a project,
 * kept in a hidden `.snapshots` folder inside the project itself — hidden so
 * Obsidian never indexes the copies (and the indexer never finds a second
 * `.loom`), inside the project so they move and get trashed along with it.
 *
 * One gzipped JSON file per snapshot (`[[relativePath, text], …]`, sorted).
 * Everything retention and the dedupe check need is in the file NAME —
 * `<local time>_<kind>_<content hash>.json.gz` — so neither ever opens one.
 * Images and other binaries are left out: one map image outweighs a whole
 * project's text many times over.
 */

const SNAPSHOT_FOLDER = '.snapshots';
const TEXT_EXTENSIONS = new Set(['md', 'loom', 'fountain', 'loomprose', 'json', 'canvas', 'base', 'txt']);
const NAME_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(auto|manual|restore)_([0-9a-f]+)\.json\.gz$/;
const TICK_MS = 60 * 1000;

export const SNAPSHOT_INTERVALS = [15, 30, 60, 120] as const;
export const SNAPSHOT_KEEP_RECENT_MIN = 1;
export const SNAPSHOT_KEEP_RECENT_MAX = 48;
export const SNAPSHOT_KEEP_DAILY_MAX = 90;

export type SnapshotKind = 'auto' | 'manual' | 'restore';
export interface SnapshotInfo {
	path: string;
	time: number;
	kind: SnapshotKind;
	hash: string;
}
/** Why a snapshot is kept: one of the recent interval ones, a day's last
 *  one, or made by hand / before a restore (never deleted automatically). */
export type SnapshotRole = 'recent' | 'daily' | 'manual' | 'restore' | 'expired';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `YYYY-MM-DD_HH-mm-ss` — sortable, file-name safe, and its
 *  first 10 characters are the local day retention groups by. */
function stamp(time: number): string {
	const d = new Date(time);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function parseStamp(text: string): number {
	const [y, mo, d, h, mi, s] = text.split(/[-_]/).map(Number);
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function snapshotDir(project: ProjectDef): string {
	return normalizePath(`${project.root}/${SNAPSHOT_FOLDER}`);
}

function liveTextFiles(app: App, project: ProjectDef): TFile[] {
	const folder = app.vault.getFolderByPath(project.root);
	const files: TFile[] = [];
	if (folder) {
		Vault.recurseChildren(folder, (f) => {
			if (f instanceof TFile && TEXT_EXTENSIONS.has(f.extension)) files.push(f);
		});
	}
	return files;
}

async function gzip(text: string): Promise<ArrayBuffer> {
	return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function gunzip(data: ArrayBuffer): Promise<string> {
	return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export async function listSnapshots(app: App, project: ProjectDef): Promise<SnapshotInfo[]> {
	const dir = snapshotDir(project);
	if (project.root === '' || !(await app.vault.adapter.exists(dir))) return [];
	const out: SnapshotInfo[] = [];
	for (const path of (await app.vault.adapter.list(dir)).files) {
		const m = NAME_RE.exec(path.slice(path.lastIndexOf('/') + 1));
		if (m) out.push({ path, time: parseStamp(m[1]), kind: m[2] as SnapshotKind, hash: m[3] });
	}
	return out.sort((a, b) => b.time - a.time);
}

/** Retention, newest first: the first `keepRecent` interval snapshots, plus
 *  the newest (= that day's last) one of each of the `keepDaily` most recent
 *  days that HAVE one — days without changes produce no snapshot, so they
 *  don't use up a slot. */
export function snapshotRoles(snaps: SnapshotInfo[], keepRecent: number, keepDaily: number): Map<string, SnapshotRole> {
	const roles = new Map<string, SnapshotRole>();
	const days = new Set<string>();
	let recent = 0;
	for (const s of snaps) {
		if (s.kind !== 'auto') {
			roles.set(s.path, s.kind);
			continue;
		}
		let role: SnapshotRole = 'expired';
		if (recent < keepRecent) {
			role = 'recent';
			recent++;
		}
		const day = stamp(s.time).slice(0, 10);
		if (!days.has(day)) {
			days.add(day);
			if (role === 'expired' && days.size <= keepDaily) role = 'daily';
		}
		roles.set(s.path, role);
	}
	return roles;
}

/** Writes a snapshot of the project's text files as they are on disk. With
 *  `unlessHash`, skips it when the content hashes the same (nothing changed
 *  since that snapshot). Returns whether one was written. */
export async function takeSnapshot(
	app: App,
	project: ProjectDef,
	kind: SnapshotKind,
	unlessHash?: string
): Promise<boolean> {
	// ponytail: a project at the vault root would snapshot the whole vault; skipped.
	if (project.root === '') return false;
	const prefix = project.root.length + 1;
	const files = liveTextFiles(app, project).sort((a, b) => a.path.localeCompare(b.path));
	const entries: [string, string][] = [];
	for (const f of files) entries.push([f.path.slice(prefix), await app.vault.cachedRead(f)]);
	const payload = JSON.stringify(entries);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	const hash = Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
	if (hash === unlessHash) return false;
	const dir = snapshotDir(project);
	if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
	const path = `${dir}/${stamp(Date.now())}_${kind}_${hash}.json.gz`;
	// Same second, same content — e.g. the other synced device just wrote it.
	if (await app.vault.adapter.exists(path)) return false;
	await app.vault.adapter.writeBinary(path, await gzip(payload));
	return true;
}

async function removeSnapshot(app: App, path: string): Promise<void> {
	try {
		await app.vault.adapter.remove(path);
	} catch {
		// Already gone — the other synced device pruned it first.
	}
}

export async function deleteAllSnapshots(app: App, project: ProjectDef): Promise<void> {
	for (const s of await listSnapshots(app, project)) await removeSnapshot(app, s.path);
	try {
		await app.vault.adapter.rmdir(snapshotDir(project), false);
	} catch {
		// Not empty (something else lives there) or already gone.
	}
}

/**
 * Replaces the project's live text files with the snapshot's: changed files
 * are rewritten, missing ones recreated, and text files the snapshot doesn't
 * have go to the trash. Binaries are untouched. A pending script edit is
 * flushed first — otherwise the script buffer would treat the restored file
 * as an external change racing its own unsaved text and write that back.
 */
export async function restoreSnapshot(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	snap: SnapshotInfo,
	saveCurrentFirst: boolean
): Promise<{ failed: number }> {
	const { app } = plugin;
	if (findScriptFile(plugin, project)) await flushScriptBufferNow(plugin, project);
	if (saveCurrentFirst) await takeSnapshot(app, project, 'restore');
	const entries = JSON.parse(await gunzip(await app.vault.adapter.readBinary(snap.path))) as [string, string][];
	const wanted = new Map(entries.map(([rel, text]) => [normalizePath(`${project.root}/${rel}`), text]));
	let failed = 0;
	for (const file of liveTextFiles(app, project)) {
		if (wanted.has(file.path)) continue;
		try {
			await app.fileManager.trashFile(file);
		} catch (e) {
			console.error(`Loom Loom: restore could not trash ${file.path}`, e);
			failed++;
		}
	}
	for (const [path, text] of wanted) {
		try {
			const existing = app.vault.getFileByPath(path);
			if (existing) {
				if ((await app.vault.read(existing)) !== text) await app.vault.modify(existing, text);
			} else {
				await ensureFolder(app, path.slice(0, path.lastIndexOf('/')));
				await app.vault.create(path, text);
			}
		} catch (e) {
			console.error(`Loom Loom: restore could not write ${path}`, e);
			failed++;
		}
	}
	return { failed };
}

/** When each project was last found unchanged, so an unchanged project isn't
 *  re-read on every tick until its next interval comes round. */
const lastChecked = new Map<string, number>();
let ticking = false;

/** One scheduler pass: takes a snapshot of every project whose interval has
 *  elapsed (unless nothing changed), then applies retention. */
async function snapshotTick(plugin: LoomLoomPlugin): Promise<void> {
	const s = plugin.settings;
	if (!s.snapshotsEnabled || ticking) return;
	ticking = true;
	try {
		for (const project of plugin.indexer.getProjects()) {
			if (project.root === '') continue;
			let snaps = await listSnapshots(plugin.app, project);
			const lastAuto = snaps.find((x) => x.kind === 'auto')?.time ?? 0;
			const since = Math.max(lastAuto, lastChecked.get(project.root) ?? 0);
			if (Date.now() - since >= s.snapshotIntervalMin * 60 * 1000) {
				lastChecked.set(project.root, Date.now());
				if (await takeSnapshot(plugin.app, project, 'auto', snaps[0]?.hash)) {
					snaps = await listSnapshots(plugin.app, project);
				}
			}
			const roles = snapshotRoles(snaps, s.snapshotKeepRecent, s.snapshotKeepDaily);
			for (const snap of snaps) if (roles.get(snap.path) === 'expired') await removeSnapshot(plugin.app, snap.path);
		}
	} catch (e) {
		console.error('Loom Loom: snapshot pass failed', e);
	} finally {
		ticking = false;
	}
}

/** Starts the snapshot scheduler — call once the vault has settled, so a
 *  half-synced vault isn't the first thing snapshotted. */
export function startSnapshots(plugin: LoomLoomPlugin): void {
	void snapshotTick(plugin);
	plugin.registerInterval(window.setInterval(() => void snapshotTick(plugin), TICK_MS));
}

const ROLE_LABEL: Record<SnapshotRole, () => string> = {
	recent: () => t('snapshots.role.recent'),
	expired: () => t('snapshots.role.recent'),
	daily: () => t('snapshots.role.daily'),
	manual: () => t('snapshots.role.manual'),
	restore: () => t('snapshots.role.restore'),
};

/** One project's snapshots: take one now, restore, delete one or all. */
export class SnapshotsModal extends Modal {
	constructor(
		private plugin: LoomLoomPlugin,
		private project: ProjectDef
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle(t('snapshots.title', { name: this.project.name }));
		void this.render();
	}

	private async render(): Promise<void> {
		const { app } = this.plugin;
		const s = this.plugin.settings;
		const snaps = await listSnapshots(app, this.project);
		const el = this.contentEl;
		el.empty();
		new Setting(el)
			.setName(t('snapshots.takeNow.name'))
			.setDesc(t('snapshots.takeNow.desc'))
			.addButton((btn) =>
				btn
					.setButtonText(t('snapshots.takeNow.button'))
					.setCta()
					.onClick(async () => {
						await takeSnapshot(app, this.project, 'manual');
						new Notice(t('snapshots.taken'));
						await this.render();
					})
			);
		if (snaps.length === 0) {
			el.createEl('p', { cls: 'setting-item-description', text: t('snapshots.empty') });
			return;
		}
		const roles = snapshotRoles(snaps, s.snapshotKeepRecent, s.snapshotKeepDaily);
		const list = el.createDiv({ cls: 'loom-snapshot-list' });
		for (const snap of snaps) {
			const when = new Date(snap.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
			new Setting(list)
				.setName(when)
				.setDesc(ROLE_LABEL[roles.get(snap.path) ?? 'recent']())
				.addButton((btn) =>
					btn.setButtonText(t('snapshots.restore.button')).onClick(() => {
						const option = { label: t('snapshots.restore.saveCurrent'), value: true };
						new ConfirmModal(
							app,
							t('snapshots.restore.title'),
							t('snapshots.restore.body', { name: this.project.name, when }),
							async () => {
								const { failed } = await restoreSnapshot(this.plugin, this.project, snap, option.value);
								new Notice(failed > 0 ? tn('snapshots.restore.failed', failed) : t('snapshots.restore.done'));
								await this.render();
							},
							t('snapshots.restore.button'),
							option
						).open();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon('trash-2')
						.setTooltip(t('snapshots.delete'))
						.onClick(async () => {
							await removeSnapshot(app, snap.path);
							await this.render();
						})
				);
		}
		new Setting(el).addButton((btn) => {
			btn.setButtonText(t('snapshots.deleteAll.button')).onClick(() =>
				new ConfirmModal(
					app,
					t('snapshots.deleteAll.title'),
					tn('snapshots.deleteAll.body', snaps.length, { name: this.project.name }),
					async () => {
						await deleteAllSnapshots(app, this.project);
						await this.render();
					},
					t('snapshots.deleteAll.button')
				).open()
			);
			btn.buttonEl.addClass('loom-danger-btn');
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
