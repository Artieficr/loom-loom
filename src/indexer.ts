import {
	App,
	Component,
	Events,
	FrontMatterCache,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	normalizePath,
} from 'obsidian';
import {
	Connection,
	defaultMemberRole,
	EntityRecord,
	EntityType,
	EventKind,
	FM,
	FactionMemberDecl,
	LOOM_EXTENSION,
	PC_TAG,
	QUEST_OUTCOMES,
	QuestObjective,
	RelationshipDecl,
	SessionNoteDecl,
	TIMELINES_FOLDER,
	TimelineDef,
	isEntityType,
	isEventKind,
	legacyFmKeys,
	formatTimestamp,
	parseTimestamp,
} from './types';
import { ProjectConfig, parseLoomDate, parseProjectConfig } from './calendar';
import { managedEntityFileName } from './naming';
import { t } from './i18n';
import type LoomLoomPlugin from './main';

/** A project = a folder containing a .loom home file. */
export interface ProjectDef {
	/** Path of the .loom file. */
	loomPath: string;
	/** Root folder path ('' = vault root). */
	root: string;
	/** Project display name = .loom file basename. */
	name: string;
	config: ProjectConfig;
}

/**
 * Extracts the linkpath from a raw target value: "[[Sam|alias]]" -> "Sam".
 * Plain names without brackets are accepted as-is.
 */
export function extractLinkpath(raw: string): string | null {
	const wiki = /\[\[([^\]|#]+)/.exec(raw);
	const path = (wiki ? wiki[1] : raw).trim();
	return path.length > 0 ? path : null;
}

function parseTagList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Extracts the character linkpath from one raw `members` entry — a plain link
 * string ("[[Sam]]") or an object `{ character, role }`. Shared with the
 * entity page, which edits the faction's raw frontmatter list in place.
 */
export function memberEntryLinkpath(item: unknown): string | null {
	if (typeof item === 'string' && item !== '') return extractLinkpath(item);
	if (typeof item === 'object' && item !== null) {
		const character = (item as { character?: unknown }).character;
		if (typeof character === 'string' && character !== '') return extractLinkpath(character);
	}
	return null;
}

/** Parses a faction's `members` list into deduplicated membership declarations. */
function parseMemberList(value: unknown): FactionMemberDecl[] {
	const raw = Array.isArray(value) ? value : [value];
	const out: FactionMemberDecl[] = [];
	for (const item of raw) {
		const linkpath = memberEntryLinkpath(item);
		if (!linkpath || out.some((m) => m.linkpath === linkpath)) continue;
		const { role, location } =
			typeof item === 'object' && item !== null
				? (item as { role?: unknown; location?: unknown })
				: { role: undefined, location: undefined };
		out.push({
			linkpath,
			role: typeof role === 'string' && role.trim() !== '' ? role : defaultMemberRole(),
			location: typeof location === 'string' ? extractLinkpath(location) : null,
		});
	}
	return out;
}

/** Parses a frontmatter value holding one link or a list of links into deduplicated linkpaths. */
function parseLinkList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string' || item === '') continue;
		const linkpath = extractLinkpath(item);
		if (linkpath && !out.includes(linkpath)) out.push(linkpath);
	}
	return out;
}

/**
 * Frontmatter keys whose links are deliberately hidden: they never become
 * connections or graph edges (session attendance would spray edges over the
 * whole graph; sublocationOrder would duplicate the children's own
 * `sublocation` edges). Lowercase — compared case-insensitively; legacy
 * un-prefixed spellings included for not-yet-migrated notes.
 */
const HIDDEN_LINK_KEYS = [
	'loomattendance',
	'loomdeathsession',
	'loomsublocationorder',
	'loomregionorder',
	'loomitemowner',
	'loomobjectives',
	'loomscenebranch',
	'attendance',
	'deathsession',
	'sublocationorder',
	'regionorder',
];

/** The managed file path for `file` if renamed to `base` in its own folder. */
function managedNotePath(file: TFile, base: string): string {
	const parent = file.parent?.path ?? '';
	return normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
}

function isHiddenLinkKey(key: string): boolean {
	const lower = key.toLowerCase();
	// List entries come through as "attendance.0", "attendance.1", …
	return HIDDEN_LINK_KEYS.some((k) => lower === k || lower.startsWith(k + '.'));
}

/**
 * Case-insensitive frontmatter lookup. Obsidian's Properties UI treats
 * property names case-insensitively and can rewrite a key to another casing
 * (e.g. `loomTags` → `loomtags`), so our camelCase keys must be read loosely.
 */
function fmField(fm: FrontMatterCache | Record<string, unknown>, key: string): unknown {
	if (fm[key] !== undefined) return fm[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() === lower) return fm[k];
	}
	return undefined;
}

/** Reads a loom frontmatter key, falling back to its legacy spelling(s). */
function fmLoom(fm: FrontMatterCache | Record<string, unknown>, key: string): unknown {
	const value = fmField(fm, key);
	if (value !== undefined) return value;
	for (const legacy of legacyFmKeys(key)) {
		const v = fmField(fm, legacy);
		if (v !== undefined) return v;
	}
	return undefined;
}

/** Reads a loom key as a trimmed string, or '' if absent/not a string. */
function fmString(fm: FrontMatterCache | Record<string, unknown>, key: string): string {
	const v = fmLoom(fm, key);
	return typeof v === 'string' ? v.trim() : '';
}

/** Reads a loom key as a linkpath, or null if absent/not a string. */
function fmLinkpath(fm: FrontMatterCache | Record<string, unknown>, key: string): string | null {
	const v = fmLoom(fm, key);
	return typeof v === 'string' ? extractLinkpath(v) : null;
}

/**
 * The link target for a record: the file basename. Links resolve by file
 * name, never by display name — every plugin-written `[[link]]` must use
 * this, while UI labels use `record.name` (the user-entered `loomName`).
 */
export function linkTargetOf(record: EntityRecord): string {
	const base = record.path.split('/').pop() ?? record.path;
	return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Conflict files a sync client (Dropbox, Syncthing, …) drops straight into the
 * vault next to the note they clashed on. They carry a full copy of the note's
 * frontmatter, so indexing them would duplicate every entity — and the managed
 * file-name migration would then see several notes competing for one target
 * name. Ignored everywhere: never indexed, never renamed, never stamped.
 */
const SYNC_CONFLICT_RE = /conflicted copy|\.sync-conflict-|~syncthing~|\(case[- ]conflict/i;

export function isSyncConflictPath(path: string): boolean {
	return SYNC_CONFLICT_RE.test(path);
}

/**
 * Above this many renames the automatic startup migration stops and asks: a
 * vault that is already on the managed naming scheme needs zero, so a big
 * number means the vault is in an unexpected state (a half-finished sync, a
 * restored backup, conflict copies) and bulk-renaming into it makes it worse.
 * The user can still run the whole pass from the "Apply managed file names"
 * command, which skips this cap.
 */
const BULK_RENAME_LIMIT = 25;

/**
 * The index cache: entity records built from frontmatter across all projects
 * (any folder holding a .loom file).
 *
 * Indexing has no rendering concerns — views subscribe to the `changed`
 * event and query through the public getters; they never re-scan files.
 * Records store *unresolved* linkpaths; resolution to concrete files happens
 * at query time via metadataCache, so renames/creations elsewhere in the
 * vault never leave stale resolved paths in the index.
 */
export class LoomIndexer extends Component {
	readonly events = new Events();
	version = 0;

	private projects = new Map<string, ProjectDef>();
	private records = new Map<string, EntityRecord>();
	private timelines = new Map<string, TimelineDef>();
	/** Lazily built reverse edges: target path -> incoming connections. */
	private incoming: Map<string, Connection[]> | null = null;

	private rebuilding = false;
	private rebuildQueued = false;
	/** The in-flight rebuild (plus anything queued behind it), for `rebuildNow`. */
	private rebuildChain: Promise<void> = Promise.resolve();
	private reconciling = false;
	/** Path -> last time we stamped `loomModified`, so the metadata-change echo
	 *  from our own write (and rapid edit bursts) don't loop back into a stamp. */
	private lastStamp = new Map<string, number>();
	/** Path -> the `loomModified` value the note carried when we last saw it.
	 *  A change that also moved this value was stamped by whoever wrote it (us,
	 *  or another machine via sync), so it must not be answered with a stamp of
	 *  our own — see `stampModified`. */
	private knownModified = new Map<string, string>();

	constructor(private app: App, private plugin: LoomLoomPlugin) {
		super();
	}

	onload(): void {
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!this.projectForPath(file.path)) return;
				// Read the stamp we knew *before* re-indexing: whether the change
				// carried a new one is what decides if it was a local content edit
				// or an already-stamped write arriving from elsewhere.
				const prevStamp = this.knownModified.get(file.path);
				this.indexFile(file);
				this.bump();
				void this.stampModified(file, prevStamp);
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) this.rebuild();
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) this.rebuild();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) {
					this.rebuild();
					return;
				}
				this.knownModified.delete(file.path);
				if (this.records.delete(file.path) || this.timelines.delete(file.path)) this.bump();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				// Renames can retarget link resolution or move project roots,
				// so rebuild rather than patch. Renames are rare enough.
				if (
					(file instanceof TFile && file.extension === LOOM_EXTENSION) ||
					this.projectForPath(oldPath) ||
					this.projectForPath(file.path)
				) {
					this.rebuild();
				}
			})
		);
	}

	// --- Rebuild -------------------------------------------------------------

	rebuild(): void {
		void this.rebuildNow();
	}

	/** `rebuild()` for callers that must wait for the index to be populated — the
	 *  startup migration reads records and resolves links, so it can't run against
	 *  a half-built index. Coalesces with an in-flight pass and resolves only once
	 *  that pass *and* anything queued behind it has finished. */
	rebuildNow(): Promise<void> {
		if (this.rebuilding) {
			// A pass is already running, but it may have started before whatever
			// prompted this call — queue another and wait for the whole chain.
			this.rebuildQueued = true;
			return this.rebuildChain;
		}
		this.rebuilding = true;
		this.rebuildChain = (async () => {
			try {
				await this.doRebuild();
			} finally {
				this.rebuilding = false;
			}
			if (this.rebuildQueued) {
				this.rebuildQueued = false;
				await this.rebuildNow();
			}
		})();
		return this.rebuildChain;
	}

	private async doRebuild(): Promise<void> {
		const loomFiles = this.app.vault.getFiles().filter((f) => f.extension === LOOM_EXTENSION);
		const projects = new Map<string, ProjectDef>();
		for (const file of loomFiles) {
			let config = parseProjectConfig('');
			try {
				config = parseProjectConfig(await this.app.vault.cachedRead(file));
			} catch (e) {
				console.error('Loom Loom: could not read project file', file.path, e);
			}
			const parent = file.parent;
			projects.set(file.path, {
				loomPath: file.path,
				root: parent && parent.path !== '/' ? parent.path : '',
				name: file.basename,
				config,
			});
		}
		this.projects = projects;

		this.records.clear();
		this.timelines.clear();
		for (const project of projects.values()) {
			const folder =
				project.root === '' ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(project.root);
			if (!(folder instanceof TFolder)) continue;
			Vault.recurseChildren(folder, (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') this.indexFile(file);
			});
		}
		this.bump();
		// Repair any character-specific item copies whose source was renamed
		// (no-op when nothing is stale; its writes don't retrigger a rebuild).
		void this.reconcileItemCopies();
	}

	// --- Startup migration -----------------------------------------------------

	/**
	 * One-shot pass after the initial rebuild: rewrites legacy un-prefixed
	 * frontmatter keys to their loom spellings, seeds `loomName` (+ a native
	 * alias) from the file basename where missing, and renames entity files to
	 * the managed `<Project> <Type label> <name>` convention (Obsidian updates
	 * every link). Automatic: it runs on load, no command, since no released
	 * vaults predate it.
	 *
	 * **Idempotent means "writes nothing", not "writes the same thing".** Every
	 * change is decided against the cached frontmatter first and the note is only
	 * opened for writing when something actually differs, because
	 * `processFrontMatter` always rewrites the file: touching every note on every
	 * load makes a synced vault (Dropbox/iCloud/…) re-upload itself at each start,
	 * and with two machines doing that at once the sync client answers with
	 * conflicted copies — which are themselves notes, which get migrated, which
	 * conflict again.
	 *
	 * `force` runs the rename half past its safety cap (the manual command).
	 */
	async migrateFiles(force = false): Promise<void> {
		// Resolve each sublocation's parent name up front (links are stable now,
		// before any rename moves files around).
		const parentNameOf = new Map<string, string>();
		// Character-specific item copies name from the original item + owner
		// character (`<Project> Item <original> — <owner>`), not their loomName.
		const copyNamingOf = new Map<string, { name: string; owner: string }>();
		for (const record of this.records.values()) {
			if (record.type === 'location' && record.parentLocation !== null) {
				const parent = this.resolve(record.parentLocation, record.path);
				if (parent?.type === 'location') parentNameOf.set(record.path, parent.name);
			}
			if (record.type === 'item' && record.itemOrigin && record.itemOwner) {
				const orig = this.resolve(record.itemOrigin, record.path);
				const owner = this.resolve(record.itemOwner, record.path);
				if (orig && owner) copyNamingOf.set(record.path, { name: orig.name, owner: owner.name });
			}
		}
		// Pass 1 — plan. Decide every write against the cached frontmatter without
		// touching a single file, so a vault that is already migrated (the normal
		// case, every single load) comes out of this method having written nothing.
		const fmWork: { file: TFile; displayName: string; isSession: boolean }[] = [];
		const renames: { file: TFile; newPath: string }[] = [];
		for (const record of [...this.records.values()]) {
			const project = this.getProjectByRoot(record.project);
			const file = this.app.vault.getFileByPath(record.path);
			if (!project || !file || isSyncConflictPath(file.path)) continue;
			const isSession = record.type === 'session';
			// record.name already read loomName-with-basename-fallback, so for an
			// unmigrated file it is the old display name — exactly what to keep.
			const displayName = record.name;
			const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
			// Dry run on a copy: the mutator reports whether it changes anything.
			if (this.applyFmMigration({ ...(cached ?? {}) }, displayName, isSession, file.stat)) {
				fmWork.push({ file, displayName, isSession });
			}
			// Sessions already follow their own managed scheme (from the date).
			if (isSession) continue;
			// The managed name of a sublocation embeds its parent's name, and an
			// item copy's embeds its original and owner. If those links don't
			// resolve the note isn't conforming — its target name is simply not
			// known yet (a half-synced vault resolves nothing), and renaming on a
			// guess only has to be undone once the missing note turns up.
			if (record.type === 'location' && record.parentLocation !== null && !parentNameOf.has(record.path)) {
				continue;
			}
			if (
				record.type === 'item' &&
				record.itemOrigin !== null &&
				record.itemOwner !== null &&
				!copyNamingOf.has(record.path)
			) {
				continue;
			}
			const copyNaming = copyNamingOf.get(record.path);
			const base = copyNaming
				? managedEntityFileName(project.name, record.type, copyNaming.name, undefined, copyNaming.owner)
				: managedEntityFileName(project.name, record.type, displayName, parentNameOf.get(record.path));
			if (file.basename === base) continue;
			const newPath = managedNotePath(file, base);
			// The managed name is taken by another note. Historically this appended
			// " 2", " 3", … — which, on a synced vault where the same collision
			// happens on both machines, manufactures an unbounded pile of numbered
			// duplicates that then sync into each other. Leave the note alone and
			// say so instead; the two notes need a human to tell them apart.
			const clash = this.app.vault.getAbstractFileByPath(newPath);
			if (clash !== null && clash.path !== file.path) {
				console.warn(
					'Loom Loom: skipped renaming',
					file.path,
					'— the managed name is already taken by',
					newPath
				);
				continue;
			}
			renames.push({ file, newPath });
		}

		// Pass 2 — apply. The rename cap only guards the automatic run.
		for (const { file, displayName, isSession } of fmWork) {
			// This migration write fires a metadata 'changed' echo — guard it so
			// stampModified doesn't overwrite loomModified with the startup time.
			this.lastStamp.set(file.path, Date.now());
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					this.applyFmMigration(fm, displayName, isSession, file.stat);
				});
			} catch (e) {
				console.error('Loom Loom: frontmatter migration failed for', file.path, e);
			}
		}
		if (renames.length > BULK_RENAME_LIMIT && !force) {
			console.warn(`Loom Loom: ${renames.length} notes are off the managed naming scheme — not renaming.`);
			new Notice(t('notice.bulkRenameSkipped', { count: String(renames.length) }), 15000);
		} else {
			for (const { file, newPath } of renames) {
				// Re-check: an earlier rename in this same loop may have taken the name.
				const clash = this.app.vault.getAbstractFileByPath(newPath);
				if (clash !== null && clash.path !== file.path) continue;
				try {
					await this.app.fileManager.renameFile(file, newPath);
				} catch (e) {
					console.error('Loom Loom: file rename migration failed for', file.path, e);
				}
			}
		}
		// Timeline definition files: same key rewrite (name/types/tags are
		// plugin-owned there and move under the loom prefix).
		for (const def of [...this.timelines.values()]) {
			const file = this.app.vault.getFileByPath(def.path);
			if (!file) continue;
			const migrate = (fm: Record<string, unknown>): boolean => {
				let changed = false;
				for (const [legacy, key] of [
					['name', FM.name],
					['types', FM.timelineTypes],
					['tags', FM.tags],
				] as const) {
					if (fmField(fm, key) === undefined && fmField(fm, legacy) !== undefined) {
						fm[key] = fmField(fm, legacy);
						changed = true;
					}
					for (const k of Object.keys(fm)) {
						if (k !== key && k.toLowerCase() === legacy) {
							delete fm[k];
							changed = true;
						}
					}
				}
				return changed;
			};
			// Same dry run first: a timeline file with nothing to migrate must not
			// be rewritten, or every load re-uploads it to the sync provider.
			const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!migrate({ ...(cached ?? {}) })) continue;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					migrate(fm);
				});
			} catch (e) {
				console.error('Loom Loom: timeline migration failed for', def.path, e);
			}
		}
		await this.reconcileItemCopies();
	}

	/**
	 * The frontmatter rewrite the startup migration performs, as a mutator that
	 * reports whether it actually changed anything. Run it on a shallow copy of
	 * the cached frontmatter to find out whether a note needs a write at all
	 * (see `migrateFiles` on why writing unconditionally is destructive on a
	 * synced vault), then for real inside `processFrontMatter`.
	 */
	private applyFmMigration(
		fm: Record<string, unknown>,
		displayName: string,
		isSession: boolean,
		stat: { ctime: number; mtime: number }
	): boolean {
		let changed = false;
		for (const key of Object.values(FM)) {
			if (key === FM.timelineTypes) continue; // timeline files only
			const legacyNames = legacyFmKeys(key);
			if (fmField(fm, key) === undefined) {
				for (const legacy of legacyNames) {
					const v = fmField(fm, legacy);
					if (v !== undefined) {
						fm[key] = v;
						changed = true;
						break;
					}
				}
			}
			for (const k of Object.keys(fm)) {
				const lower = k.toLowerCase();
				if (k !== key && legacyNames.some((l) => l.toLowerCase() === lower)) {
					delete fm[k];
					changed = true;
				}
			}
		}
		if (!isSession) {
			const cur = fmField(fm, FM.name);
			if (typeof cur !== 'string' || cur.trim() === '') {
				fm[FM.name] = displayName;
				changed = true;
			}
			const aliases: unknown[] = Array.isArray(fm.aliases) ? (fm.aliases as unknown[]) : [];
			if (!aliases.includes(displayName)) {
				fm.aliases = [displayName, ...aliases];
				changed = true;
			}
		}
		// Loom-managed timestamps: seed from the filesystem stats when absent
		// (capturing the real creation date before cloud-sync overwrites ctime),
		// and normalize to the datetime-property format so a value stamped in
		// another shape (e.g. an ISO string with a Z) renders in Obsidian's date &
		// time picker. Only write when the note doesn't already say the same
		// thing — a value the YAML parser handed back as a Date is already stored
		// unquoted, exactly as we'd write it, so rewriting it changes nothing but
		// the file's mtime (and on a synced vault, that is a fresh upload of every
		// note on every load).
		const stamp = (key: string, fallback: number) => {
			const cur = fmField(fm, key);
			const parsed = parseTimestamp(cur);
			if (parsed !== null && typeof cur !== 'string') return; // stored as a Date — canonical enough
			const want = formatTimestamp(parsed ?? fallback);
			if (cur === want) return;
			fm[key] = want;
			changed = true;
		};
		stamp(FM.created, stat.ctime);
		stamp(FM.modified, stat.mtime);
		return changed;
	}

	/**
	 * Keeps character-specific item copies in step with their source. A copy's
	 * label (`<original> [<owner>]`) lives in its `loomName`/`aliases`/file name;
	 * renaming the original item or the owner character leaves those stale. This
	 * rewrites them (block-style frontmatter — valid YAML that survives Obsidian's
	 * own rewrites) and renames the file. A no-op when everything matches, so it's
	 * safe to run after every rebuild; re-entrancy is guarded so its own writes
	 * don't recurse.
	 */
	async reconcileItemCopies(): Promise<void> {
		if (this.reconciling) return;
		this.reconciling = true;
		try {
			for (const record of [...this.records.values()]) {
				if (record.type !== 'item' || record.itemOrigin === null || record.itemOwner === null) continue;
				const origin = this.resolve(record.itemOrigin, record.path);
				const owner = this.resolve(record.itemOwner, record.path);
				const project = this.getProjectByRoot(record.project);
				const file = this.app.vault.getFileByPath(record.path);
				if (!origin || !owner || !project || !file) continue;
				const label = `${origin.name} [${owner.name}]`;
				const originFile = this.app.vault.getFileByPath(origin.path);
				const originAliases: unknown = originFile
					? this.app.metadataCache.getFileCache(originFile)?.frontmatter?.aliases
					: null;
				const expectedAliases = [
					label,
					...(Array.isArray(originAliases) ? (originAliases as unknown[]) : [])
						.filter((a): a is string => typeof a === 'string' && a.trim() !== '' && a !== origin.name)
						.map((a) => `${a} [${owner.name}]`),
				];
				const curAliases: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
				const aliasesOk =
					Array.isArray(curAliases) &&
					curAliases.length === expectedAliases.length &&
					expectedAliases.every((a) => (curAliases as unknown[]).includes(a));
				if (record.name !== label || !aliasesOk) {
					this.lastStamp.set(file.path, Date.now());
					try {
						await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
							fm[FM.name] = label;
							fm.aliases = expectedAliases;
						});
					} catch (e) {
						console.error('Loom Loom: item-copy frontmatter reconcile failed for', record.path, e);
					}
				}
				const base = managedEntityFileName(project.name, 'item', origin.name, undefined, owner.name);
				if (file.basename !== base) {
					const newPath = managedNotePath(file, base);
					// Never invent " 2", " 3", … on a clash: on a synced vault the same
					// clash occurs on every machine, and the numbered copies then sync
					// into each other without bound. Leave the file where it is.
					const clash = this.app.vault.getAbstractFileByPath(newPath);
					if (clash !== null && clash.path !== file.path) {
						console.warn('Loom Loom: item copy', file.path, 'cannot take its managed name', newPath);
					} else if (newPath !== file.path) {
						try {
							await this.app.fileManager.renameFile(file, newPath);
						} catch (e) {
							console.error('Loom Loom: item-copy rename failed for', record.path, e);
						}
					}
				}
			}
		} finally {
			this.reconciling = false;
		}
	}

	// --- Projects ------------------------------------------------------------

	getProjects(): ProjectDef[] {
		return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	getProjectByLoomPath(path: string): ProjectDef | undefined {
		return this.projects.get(path);
	}

	getProjectByRoot(root: string): ProjectDef | undefined {
		for (const p of this.projects.values()) if (p.root === root) return p;
		return undefined;
	}

	/** The deepest project whose root contains `path`, or undefined. */
	projectForPath(path: string): ProjectDef | undefined {
		let best: ProjectDef | undefined;
		for (const p of this.projects.values()) {
			if (p.root !== '' && path !== p.root && !path.startsWith(p.root + '/')) continue;
			if (!best || p.root.length > best.root.length) best = p;
		}
		return best;
	}

	// --- Indexing one file -----------------------------------------------------

	private indexFile(file: TFile): void {
		const project = this.projectForPath(file.path);
		if (!project) return;
		if (isSyncConflictPath(file.path)) {
			// A sync client's conflict copy: a byte-for-byte duplicate entity.
			// Indexing it would double the entity everywhere and hand the
			// migration two notes fighting over one managed file name.
			this.records.delete(file.path);
			this.timelines.delete(file.path);
			this.knownModified.delete(file.path);
			return;
		}
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (this.isTimelineDefPath(file.path, project)) {
			this.records.delete(file.path);
			this.timelines.set(file.path, this.parseTimelineDef(file, project, fm));
			return;
		}
		const record = fm ? this.parseEntity(file, project, fm) : null;
		if (record) {
			this.records.set(file.path, record);
			// Compare as an instant, not as raw YAML: the parser can hand the same
			// stamp back as a string on one machine and a Date on another, and a
			// spurious difference there would re-open the stamping loop.
			const stamp = fm ? parseTimestamp(fmLoom(fm, FM.modified)) : null;
			this.knownModified.set(file.path, stamp === null ? '' : String(stamp));
		} else {
			this.records.delete(file.path);
			this.knownModified.delete(file.path);
		}
	}

	private isTimelineDefPath(path: string, project: ProjectDef): boolean {
		const prefix = project.root === '' ? TIMELINES_FOLDER : project.root + '/' + TIMELINES_FOLDER;
		return path.startsWith(prefix + '/');
	}

	private parseTimelineDef(file: TFile, project: ProjectDef, fm: FrontMatterCache | undefined): TimelineDef {
		const types: EntityType[] = [];
		const rawTypes = fm ? fmLoom(fm, FM.timelineTypes) : undefined;
		if (Array.isArray(rawTypes)) {
			for (const t of rawTypes) {
				const lower = typeof t === 'string' ? t.toLowerCase() : '';
				if (isEntityType(lower)) types.push(lower);
			}
		}
		const rawName = fm ? fmLoom(fm, FM.name) : undefined;
		const rawTags = fm ? fmLoom(fm, FM.tags) : undefined;
		return {
			path: file.path,
			project: project.root,
			name: typeof rawName === 'string' && rawName.trim() !== '' ? rawName : file.basename,
			types: types.length > 0 ? types : ['session', 'event'],
			tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [],
		};
	}

	private parseEntity(file: TFile, project: ProjectDef, fm: FrontMatterCache): EntityRecord | null {
		const rawType = fmLoom(fm, FM.type);
		const type = typeof rawType === 'string' ? rawType.toLowerCase() : '';
		if (!isEntityType(type)) return null;

		const relationships: RelationshipDecl[] = [];
		const rawRelationships = fmLoom(fm, FM.relationships);
		if (Array.isArray(rawRelationships)) {
			for (const rel of rawRelationships) {
				if (typeof rel !== 'object' || rel === null) continue;
				const { type: relType, target } = rel as { type?: unknown; target?: unknown };
				if (typeof target !== 'string') continue;
				const linkpath = extractLinkpath(target);
				if (!linkpath) continue;
				relationships.push({
					type: typeof relType === 'string' && relType.trim() !== '' ? relType : 'related',
					targetRaw: target,
					linkpath,
				});
			}
		}

		const sessionNotes: SessionNoteDecl[] = [];
		const rawSessionNotes = fmLoom(fm, FM.sessionNotes);
		if (Array.isArray(rawSessionNotes)) {
			for (const note of rawSessionNotes) {
				if (typeof note !== 'object' || note === null) continue;
				const { session, text, places, seq, involved, group } = note as {
					session?: unknown;
					text?: unknown;
					places?: unknown;
					seq?: unknown;
					involved?: unknown;
					group?: unknown;
				};
				sessionNotes.push({
					session: typeof session === 'string' ? extractLinkpath(session) : null,
					text: typeof text === 'string' ? text : '',
					places: parseLinkList(places),
					seq: typeof seq === 'number' ? seq : null,
					involved: parseLinkList(involved),
					group: parseLinkList(group),
				});
			}
		}

		const objectives: QuestObjective[] = [];
		const rawObjectives = fmLoom(fm, FM.objectives);
		if (Array.isArray(rawObjectives)) {
			for (const obj of rawObjectives) {
				if (typeof obj !== 'object' || obj === null) continue;
				const { name, finishedOn } = obj as { name?: unknown; finishedOn?: unknown };
				objectives.push({
					name: typeof name === 'string' ? name : '',
					finishedSession: typeof finishedOn === 'string' ? extractLinkpath(finishedOn) : null,
				});
			}
		}

		// Sessions always track real-world dates; everything else follows the
		// project's calendar (a custom calendar when enabled).
		const calendar =
			type !== 'session' && project.config.customCalendar.enabled ? 'custom' : 'gregorian';
		const nameValue = fmLoom(fm, FM.name);
		const descriptionValue = fmLoom(fm, FM.description);
		const aliveValue = fmLoom(fm, FM.alive);
		const outcomeValue = fmLoom(fm, FM.questOutcome);
		const rewardValue = fmLoom(fm, FM.reward);
		return {
			path: file.path,
			// Display name = `loomName` (the user-entered name; the managed file
			// name is derived from it). Sessions display their date instead and
			// never carry a loomName; a missing loomName falls back to the file
			// basename so foreign/unmigrated notes still work.
			name:
				type !== 'session' && typeof nameValue === 'string' && nameValue.trim() !== ''
					? nameValue.trim()
					: file.basename,
			type,
			project: project.root,
			// `loomTags` is the current key; `pluginTags` is its pre-rename
			// spelling, still read so existing notes keep their tags.
			loomTags: parseTagList(fmLoom(fm, FM.tags)),
			description: typeof descriptionValue === 'string' ? descriptionValue : '',
			relationships,
			sessionNotes,
			date: parseLoomDate(fmLoom(fm, FM.date), calendar, project.config),
			attendance: parseLinkList(fmLoom(fm, FM.attendance)),
			parentLocation: fmLinkpath(fm, FM.parentLocation),
			sublocationOrder: parseLinkList(fmLoom(fm, FM.sublocationOrder)),
			region: fmLinkpath(fm, FM.region),
			regionOrder: parseLinkList(fmLoom(fm, FM.regionOrder)),
			items: parseLinkList(fmLoom(fm, FM.items)),
			itemOrigin: fmLinkpath(fm, FM.itemOrigin),
			itemOwner: fmLinkpath(fm, FM.itemOwner),
			members: parseMemberList(fmLoom(fm, FM.members)),
			alive: typeof aliveValue === 'boolean' ? aliveValue : true,
			active: fmLoom(fm, FM.active) !== false,
			deathSession: fmLinkpath(fm, FM.deathSession),
			questReceived: fmLinkpath(fm, FM.questReceived),
			questOutcome:
				typeof outcomeValue === 'string' &&
				(QUEST_OUTCOMES as readonly string[]).includes(outcomeValue.toLowerCase())
					? outcomeValue.toLowerCase()
					: '',
			questOutcomeSession: fmLinkpath(fm, FM.questOutcomeSession),
			questGivers: parseLinkList(fmLoom(fm, FM.questGiver)),
			reward: typeof rewardValue === 'string' ? rewardValue : '',
			objectives,
			seq: (() => {
				const v = fmLoom(fm, FM.seq);
				return typeof v === 'number' ? v : null;
			})(),
			eventKind: (() => {
				const v = fmLoom(fm, FM.eventKind);
				return typeof v === 'string' && isEventKind(v.toLowerCase()) ? (v.toLowerCase() as EventKind) : '';
			})(),
			happened: fmLoom(fm, FM.happened) === true,
			npcLines: parseTagList(fmLoom(fm, FM.npcLines)),
			displayTitle: fmString(fm, FM.displayTitle),
			sceneId: fmString(fm, FM.sceneId),
			sceneIntExt: fmString(fm, FM.sceneIntExt),
			sceneTime: fmString(fm, FM.sceneTime),
			sceneLocation: fmLinkpath(fm, FM.sceneLocation) ?? '',
			sceneCast: parseLinkList(fmLoom(fm, FM.sceneCast)),
			sceneFactions: parseLinkList(fmLoom(fm, FM.sceneFactions)),
			sceneItems: parseLinkList(fmLoom(fm, FM.sceneItems)),
			sceneMentionedLocations: parseLinkList(fmLoom(fm, FM.sceneMentionedLocations)),
			sceneChapter: fmLinkpath(fm, FM.sceneChapter) ?? '',
			sceneBranch: fmString(fm, FM.sceneBranch),
			chapterId: fmString(fm, FM.chapterId),
			// Loom-managed timestamps win over the filesystem stats (cloud-sync can
			// overwrite ctime/mtime with the sync time); stats are the fallback for
			// notes not yet stamped.
			created: parseTimestamp(fmLoom(fm, FM.created)) ?? file.stat.ctime,
			modified: parseTimestamp(fmLoom(fm, FM.modified)) ?? file.stat.mtime,
		};
	}

	private bump(): void {
		this.version++;
		this.incoming = null;
		this.persistLater();
		this.events.trigger('changed');
	}

	/**
	 * Stamps `loomModified` on a loom entity note whenever its content changes.
	 * Every edit — plugin write or a manual markdown edit — flows through the
	 * `metadataCache.on('changed')` handler, so this is the single place the
	 * modification time is maintained. Only stamps indexed entity notes, never
	 * .loom/timeline files. Absence of `loomModified` still falls back to the
	 * filesystem mtime.
	 *
	 * **Never answer a stamp with a stamp.** If the change that triggered this
	 * already moved `loomModified` (`prevStamp` differs from what the note now
	 * carries) it was written by us or by another machine that stamped it before
	 * syncing. Re-stamping it would write the file again, which syncs back, which
	 * fires `changed` over there, which stamps again — two vaults on one Dropbox
	 * folder ping-pong writes forever and the sync client turns every collision
	 * into a conflicted copy. Comparing the stamp itself (rather than trusting a
	 * timer) breaks that by construction: a stamped write is never re-stamped, on
	 * any machine, in any session. A brand-new path (`prevStamp === undefined`)
	 * is skipped too — notes are born with both timestamps, so a first sighting
	 * is a note arriving from sync, not an edit.
	 */
	private async stampModified(file: TFile, prevStamp: string | undefined): Promise<void> {
		if (!this.records.has(file.path)) return;
		if (prevStamp === undefined) return;
		if ((this.knownModified.get(file.path) ?? '') !== prevStamp) return;
		const now = Date.now();
		if (now - (this.lastStamp.get(file.path) ?? 0) < 2000) return;
		this.lastStamp.set(file.path, now);
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[FM.modified] = formatTimestamp(now);
			});
		} catch (e) {
			console.error('Loom Loom: modified-stamp failed for', file.path, e);
		}
	}

	/** Re-render subscribed views without re-indexing — for settings changes
	 *  that affect rendering (e.g. quest tag colors) but not the index data. */
	refreshViews(): void {
		this.version++;
		this.events.trigger('changed');
	}


	// --- Queries -----------------------------------------------------------

	get(path: string): EntityRecord | undefined {
		return this.records.get(path);
	}

	getAll(type?: EntityType, projectRoot?: string): EntityRecord[] {
		const all = [...this.records.values()];
		return all.filter(
			(r) => (type === undefined || r.type === type) && (projectRoot === undefined || r.project === projectRoot)
		);
	}

	/** The party right now: PC-tagged characters that are alive and active —
	 *  what the virtual "Group" faction snapshots when picked in a search.
	 *  (Dead or away PCs stop being added; past snapshots keep them.) */
	getGroupMembers(projectRoot: string): EntityRecord[] {
		return this.getAll('character', projectRoot).filter(
			(r) => r.loomTags.includes(PC_TAG) && r.alive && r.active
		);
	}

	getTimelines(projectRoot?: string): TimelineDef[] {
		return [...this.timelines.values()]
			.filter((t) => projectRoot === undefined || t.project === projectRoot)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Resolves a linkpath declared in `sourcePath` to an indexed record, or null. */
	resolve(linkpath: string, sourcePath: string): EntityRecord | null {
		const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		return file ? this.records.get(file.path) ?? null : null;
	}

	/**
	 * Connections declared on the note: typed relationships, sessions picked
	 * for session notes, and plain [[wikilinks]] anywhere in the note (body
	 * or frontmatter) that land on another indexed entity.
	 */
	getOutgoing(path: string): Connection[] {
		const record = this.records.get(path);
		if (!record) return [];
		const out: Connection[] = [];
		const linked = new Set<string>();
		for (const rel of record.relationships) {
			const target = this.resolve(rel.linkpath, record.path);
			if (target) {
				out.push({ record: target, relType: rel.type, direction: 'outgoing' });
				linked.add(target.path);
			}
		}
		// Ticked attendance connects the PC to the session (typed edge); the
		// key stays in HIDDEN_LINK_KEYS only to keep the generic pass from
		// double-counting it as a plain link.
		for (const lp of record.attendance) {
			const pc = this.resolve(lp, record.path);
			if (pc?.type === 'character' && !linked.has(pc.path)) {
				out.push({ record: pc, relType: 'attendance', direction: 'outgoing' });
				linked.add(pc.path);
			}
		}
		// Before the generic wikilink pass so these keep their typed relType
		// instead of degrading to a plain 'link'.
		// A custom membership role labels the connection (graph edge, side
		// panel); only the default role reads as plain 'member'.
		for (const m of record.members) {
			const member = this.resolve(m.linkpath, record.path);
			if (member?.type === 'character' && !linked.has(member.path)) {
				out.push({
					record: member,
					relType: m.role === defaultMemberRole() ? 'member' : m.role,
					direction: 'outgoing',
				});
				linked.add(member.path);
			}
		}
		if (record.parentLocation !== null) {
			const parent = this.resolve(record.parentLocation, record.path);
			if (parent?.type === 'location' && parent.path !== record.path && !linked.has(parent.path)) {
				out.push({ record: parent, relType: 'sublocation', direction: 'outgoing' });
				linked.add(parent.path);
			}
		}
		// A location's `region` connects it to that region (a grouping layer).
		if (record.region !== null) {
			const region = this.resolve(record.region, record.path);
			if (region?.type === 'region' && region.path !== record.path && !linked.has(region.path)) {
				out.push({ record: region, relType: 'region', direction: 'outgoing' });
				linked.add(region.path);
			}
		}
		for (const note of record.sessionNotes) {
			const target = note.session ? this.resolve(note.session, record.path) : null;
			if (target?.type === 'session' && !linked.has(target.path)) {
				out.push({ record: target, relType: 'session note', direction: 'outgoing' });
				linked.add(target.path);
			}
			// Group-snapshot members connect exactly like involved entities — the
			// "Group" chip is a display collapse only, the graph shows individuals.
			for (const lp of [...note.involved, ...note.group]) {
				const inv = this.resolve(lp, record.path);
				if (inv && inv.path !== record.path && !linked.has(inv.path)) {
					out.push({ record: inv, relType: 'involved', direction: 'outgoing' });
					linked.add(inv.path);
				}
			}
			// Events/quests store a note's location per-note in `places`; connect it.
			if (record.type === 'event' || record.type === 'quest') {
				for (const lp of note.places) {
					const loc = this.resolve(lp, record.path);
					if (loc?.type === 'location' && loc.path !== record.path && !linked.has(loc.path)) {
						out.push({ record: loc, relType: 'location', direction: 'outgoing' });
						linked.add(loc.path);
					}
				}
			}
		}
		const file = this.app.vault.getFileByPath(path);
		const cache = file ? this.app.metadataCache.getFileCache(file) : null;
		const fmLinks = (cache?.frontmatterLinks ?? []).filter((l) => !isHiddenLinkKey(l.key));
		for (const link of [...(cache?.links ?? []), ...fmLinks]) {
			const linkpath = extractLinkpath(link.link);
			const target = linkpath ? this.resolve(linkpath, path) : null;
			if (target && target.path !== path && !linked.has(target.path)) {
				out.push({ record: target, relType: 'link', direction: 'outgoing' });
				linked.add(target.path);
			}
		}
		return out;
	}

	getIncoming(path: string): Connection[] {
		if (!this.incoming) {
			this.incoming = new Map();
			for (const record of this.records.values()) {
				for (const conn of this.getOutgoing(record.path)) {
					let list = this.incoming.get(conn.record.path);
					if (!list) {
						list = [];
						this.incoming.set(conn.record.path, list);
					}
					list.push({ record, relType: conn.relType, direction: 'incoming' });
				}
			}
		}
		return this.incoming.get(path) ?? [];
	}

	/**
	 * All connections of a note, both declared on it and declared elsewhere
	 * pointing at it — direction of declaration doesn't matter for visibility.
	 */
	getConnections(path: string): Connection[] {
		const seen = new Set<string>();
		const all: Connection[] = [];
		for (const conn of [...this.getOutgoing(path), ...this.getIncoming(path)]) {
			const key = conn.record.path + ' ' + conn.relType;
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(conn);
		}
		return all;
	}

	// --- Persistence -------------------------------------------------------

	/**
	 * Snapshot of the index written next to the plugin for debugging and fast
	 * cold starts. The in-memory index is authoritative; this file is never
	 * read back as a source of truth within a session.
	 */
	private persistLater = debounce(() => void this.persist(), 2000, true);

	private async persist(): Promise<void> {
		const dir = this.plugin.manifest.dir;
		if (!dir) return;
		const payload = JSON.stringify(
			{
				// v4: members entries became { linkpath, role } declarations.
				schemaVersion: 4,
				generatedAt: Date.now(),
				projects: [...this.projects.values()],
				records: [...this.records.values()],
				timelines: [...this.timelines.values()],
			},
			null,
			'\t'
		);
		try {
			await this.app.vault.adapter.write(normalizePath(dir + '/index-cache.json'), payload);
		} catch (e) {
			console.error('Loom Loom: failed to write index cache', e);
		}
	}
}
