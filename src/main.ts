import { ItemView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import {
	BOOK_EXTENSION,
	EntityOrigin,
	FM,
	LOOM_EXTENSION,
	SCRIPT_EXTENSION,
	VIEW_ENTITY,
	VIEW_GRAPH,
	VIEW_GROUP,
	VIEW_HOME,
	VIEW_LIST,
	VIEW_MAP,
	VIEW_PROJECTS,
	VIEW_PROSE,
	VIEW_SCRIPT,
} from './types';
import { DEFAULT_SETTINGS, LoomLoomSettingTab, LoomLoomSettings, mergeSettings } from './settings';
import { LoomIndexer, ProjectDef } from './indexer';
import {
	CreateEntityModal,
	EntityTypeSuggestModal,
	ProjectSuggestModal,
	SetupProjectModal,
	ensureFolder,
	followRenameInLinks,
} from './project';
import { projectFolderPath } from './project-kind';
import { HomeView } from './views/home-view';
import { LoomFileReactView, LoomReactView } from './views/react-view';
import { EntityListView } from './views/list-view';
import { GraphView } from './views/graph-view';
import { EntityView } from './views/entity-view';
import { GroupView } from './views/group-view';
import { MapView, relinkInMapsFile } from './views/map-view';
import { ScriptView } from './views/script-view';
import {
	holdsNoteRecreate,
	isDeletePending,
	noteDeletedOutside,
	OverlayHost,
	attachOverlayHost,
	syncOverlay,
	trackNoteCopies,
} from './outside-deletes';
import { BookView } from './views/book-view';
import { ProjectsView } from './views/projects-view';
import { SnapshotsModal, startSnapshots } from './snapshots';
import { LicenseManager } from './license/manager';
import { POLAR_ORGANIZATION_ID, PolarLicenseProvider } from './license/polar-provider';
import { resolveActiveLocale, setLocale, t } from './i18n';
import { registerIcons } from './icons';

/** How often the plugin re-checks an activated license in the background.
 *  Well inside the 30-day
 *  offline grace period (see `license/grace.ts`), so a machine that's online
 *  most days re-verifies quietly long before the grace window could matter. */
const LICENSE_RECHECK_TICK_MS = 6 * 60 * 60 * 1000;

export default class LoomLoomPlugin extends Plugin {
	settings: LoomLoomSettings = DEFAULT_SETTINGS;
	indexer!: LoomIndexer;
	/** Above 0 while Loom itself is trashing notes (an in-app delete, a
	 *  snapshot restore) — those deletes must not open the outside-delete
	 *  window (`src/outside-deletes.ts`). */
	deletePromptPause = 0;
	/** Whether a note deleted outside Loom still waits on the user's choice in
	 *  the outside-delete window — exposed here so views needn't import it. */
	isDeletePending = isDeletePending;
	/** See `holdsNoteRecreate` — read by the script/book syncs. */
	holdsNoteRecreate = holdsNoteRecreate;
	/** Hooks for every Loom tab (react-view.ts): the outside-delete window
	 *  covers a tab of a project that has notes deleted outside Loom. */
	attachDeleteOverlay = (host: OverlayHost): (() => void) => attachOverlayHost(this, host);
	syncDeleteOverlay = (host: OverlayHost): void => syncOverlay(this, host);
	private markIndexReady!: () => void;
	private markVaultReady!: () => void;
	/** Resolves once the index is first built on startup. */
	readonly indexReady = new Promise<void>((resolve) => (this.markIndexReady = resolve));
	/** Resolves once the vault has settled and the startup migration ran —
	 *  a half-synced vault isn't checked for deleted notes before this. */
	readonly vaultReady = new Promise<void>((resolve) => (this.markVaultReady = resolve));
	/** Freemium gate: one project of each kind is free, a license key unlocks
	 *  unlimited projects — see `src/license/`. `PolarLicenseProvider` is the
	 *  active provider (the Polar.sh org/product this points at is
	 *  `POLAR_ORGANIZATION_ID`, `src/license/polar-provider.ts`). */
	licenseManager!: LicenseManager;

	/** Every open window's `<body>` — the main one plus any popouts — so the
	 *  body-level classes/properties below reach views in a popout too. */
	private windowBodies = new Set<HTMLElement>([document.body]);

	async onload(): Promise<void> {
		registerIcons();
		await this.loadSettings();
		this.registerEvent(
			this.app.workspace.on('window-open', (_w, win) => {
				this.windowBodies.add(win.document.body);
				this.applyTextSize();
				this.applyThemeTextColoring();
			})
		);
		this.registerEvent(this.app.workspace.on('window-close', (_w, win) => this.windowBodies.delete(win.document.body)));
		this.applyTextSize();
		this.applyLocale();
		this.applyThemeTextColoring();
		// Obsidian's own event for "the active theme/snippets changed" — without
		// this, switching themes while "Follow theme text coloring" is already
		// on would leave the measured colors stale until the next settings save.
		this.registerEvent(this.app.workspace.on('css-change', () => this.applyThemeTextColoring()));

		this.licenseManager = new LicenseManager(this.app, new PolarLicenseProvider(POLAR_ORGANIZATION_ID));

		this.indexer = this.addChild(new LoomIndexer(this.app, this));
		this.indexer.onRecordDeleted = (record) => noteDeletedOutside(this, record);

		this.registerView(VIEW_HOME, (leaf) => new HomeView(leaf, this));
		this.registerView(VIEW_LIST, (leaf) => new EntityListView(leaf, this));
		this.registerView(VIEW_GRAPH, (leaf) => new GraphView(leaf, this));
		this.registerView(VIEW_ENTITY, (leaf) => new EntityView(leaf, this));
		this.registerView(VIEW_GROUP, (leaf) => new GroupView(leaf, this));
		this.registerView(VIEW_MAP, (leaf) => new MapView(leaf, this));
		this.registerView(VIEW_SCRIPT, (leaf) => new ScriptView(leaf, this));
		this.registerView(VIEW_PROSE, (leaf) => new BookView(leaf, this));
		this.registerView(VIEW_PROJECTS, (leaf) => new ProjectsView(leaf, this));
		// Project home files show up in the file explorer like .canvas/.base
		// files and open straight into the plugin.
		this.registerExtensions([LOOM_EXTENSION], VIEW_HOME);
		// The Fountain script gets its own extension for the same reason, plus
		// one of its own: Fountain's note syntax IS `[[…]]`, so keeping the
		// script out of markdown is what stops Obsidian indexing every
		// non-exporting script note as a wikilink.
		this.registerExtensions([SCRIPT_EXTENSION], VIEW_SCRIPT);
		// The Prose Book file needs the same treatment — its own hidden
		// `[[loom:<id>]]`/`[[loom-comment:…]]` markers would otherwise pollute
		// Obsidian's wikilink index if it were plain markdown.
		this.registerExtensions([BOOK_EXTENSION], VIEW_PROSE);

		this.addRibbonIcon('spool', t('command.ribbonTooltip'), () => this.openProjectsTab());

		this.addCommand({
			id: 'open-home',
			name: t('command.openHome'),
			callback: () => this.openHome(),
		});
		this.addCommand({
			id: 'open-projects',
			name: t('command.openProjects'),
			callback: () => this.openProjectsTab(),
		});
		this.addCommand({
			id: 'open-graph',
			name: t('command.openLoom'),
			callback: () => this.withProject((p) => void this.activateView(VIEW_GRAPH, { project: p.root })),
		});
		this.addCommand({
			id: 'manage-snapshots',
			name: t('command.manageSnapshots'),
			callback: () => this.withProject((p) => new SnapshotsModal(this, p).open()),
		});
		this.addCommand({
			id: 'setup-project',
			name: t('command.setupProject'),
			callback: () => new SetupProjectModal(this).open(),
		});
		this.addCommand({
			id: 'apply-managed-file-names',
			name: t('command.applyManagedFileNames'),
			callback: () => {
				new Notice(t('notice.applyingManagedFileNames'));
				void this.indexer.rebuildNow().then(() => this.indexer.migrateFiles(true));
			},
		});
		this.addCommand({
			id: 'create-entity',
			name: t('command.createEntity'),
			callback: () =>
				this.withProject((p) =>
					new EntityTypeSuggestModal(
						this,
						(type) => new CreateEntityModal(this, type, p).open(),
						p
					).open()
				),
		});
		this.addCommand({
			id: 'toggle-quick-notes',
			name: t('command.toggleQuickNotes'),
			// Toggles whichever leaf is currently focused — the panel is per-
			// view-instance, so this is correct even with several project tabs
			// open at once. No-ops when the active leaf isn't a loom view.
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(ItemView);
				if (view instanceof LoomReactView || view instanceof LoomFileReactView) {
					view.toggleQuickNotesPanel();
				}
			},
		});

		this.addSettingTab(new LoomLoomSettingTab(this.app, this));

		// Keep per-file UI state (settings.graphManualX, graphPins, …) attached to
		// the right file across renames, dropped on delete — both handlers walk
		// the same set of path-keyed maps, so it's pulled out once.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFolder) {
					if (this.rekeyProjectRoots(oldPath, file.path)) void this.saveSettings();
					return;
				}
				if (!(file instanceof TFile)) return;
				void followRenameInLinks(this, file, oldPath);
				const project = this.indexer.projectForPath(file.path);
				const from = oldPath.slice(oldPath.lastIndexOf('/') + 1).replace(/\.md$/, '');
				if (project && file.extension === 'md' && from !== file.basename)
					void relinkInMapsFile(this.app, project, from, file.basename);
				let changed = false;
				for (const entries of this.perFileStateMaps()) {
					if (oldPath in entries) {
						entries[file.path] = entries[oldPath];
						delete entries[oldPath];
						changed = true;
					}
				}
				if (changed) void this.saveSettings();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!(file instanceof TFile)) return;
				let changed = false;
				for (const entries of this.perFileStateMaps()) {
					if (file.path in entries) {
						delete entries[file.path];
						changed = true;
					}
				}
				if (changed) void this.saveSettings();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			// Re-measure once the workspace (and, in practice, the active
			// theme's stylesheet) has actually finished loading — the same
			// call fired earlier, inline in `onload()`, can run before theme
			// CSS is fully applied, which left the measured colors wrong
			// until the user happened to toggle the setting off and on again.
			// Popouts already open when the plugin loads never fire
			// `window-open`, so pick their bodies up from their leaves here.
			this.app.workspace.iterateAllLeaves((leaf) => this.windowBodies.add(leaf.view.containerEl.doc.body));
			this.applyTextSize();
			this.applyThemeTextColoring();
			this.applyProjectsSidebarTab();
			this.registerTimestampPropertyTypes();
			void (async () => {
				await this.indexer.rebuildNow();
				trackNoteCopies(this);
				this.markIndexReady();
				// Managed-file-name migration of existing notes. It reads records
				// and resolves links, so it needs a built index and a vault that has
				// stopped moving under it — see `waitForVaultSettled`.
				await this.waitForVaultSettled();
				await this.indexer.rebuildNow();
				await this.indexer.migrateFiles();
				this.markVaultReady();
				startSnapshots(this);
			})();
			// Internally throttled and a no-op with no local activation, so this
			// costs nothing for a free-tier user and doesn't fight the migration
			// work above for startup time.
			void this.licenseManager.revalidateNow(this.settings.licenseKey);
		});

		// The plugin's first genuinely *recurring* background task (every other
		// registerInterval use is a one-shot startup poll) — see
		// `license/manager.ts`'s own throttle for why overlapping ticks are safe.
		this.registerInterval(
			window.setInterval(() => {
				void this.licenseManager.revalidateNow(this.settings.licenseKey);
			}, LICENSE_RECHECK_TICK_MS)
		);

		// A device that's been offline a while has its OWN `lastCheckAt` sliding
		// forward on every failed periodic-tick attempt (`doRevalidate` stamps it
		// even on a thrown/network error), so the tick's own throttle
		// (`MIN_RECHECK_GAP_MS`) can't be trusted to fire again right away just
		// because connectivity came back. Reconnecting is real new information,
		// so this bypasses the throttle explicitly (`force: true`) rather than
		// waiting out however much of it remains.
		this.registerDomEvent(window, 'online', () => {
			void this.licenseManager.revalidateNow(this.settings.licenseKey, true);
		});
	}

	/** Every per-file, path-keyed UI-state dict that a rename/delete needs to
	 *  follow (or drop) — one list shared by both `vault.on` handlers above. */
	private perFileStateMaps(): Record<string, unknown>[] {
		return [
			...Object.values(this.settings.graphManualX),
			...Object.values(this.settings.graphManualY),
			...Object.values(this.settings.graphPins),
		];
	}

	/** Per-project-root settings follow a moved project folder (or a moved
	 *  folder above it): the root-keyed dicts, `projectOrder`, and any open view
	 *  whose state still names the old root. A folder rename also fires `rename`
	 *  for every file inside it, so the per-note maps (`perFileStateMaps`) follow
	 *  through the file branch of the same handler. */
	private rekeyProjectRoots(oldPath: string, newPath: string): boolean {
		// `::` — map cameras key as `<root>::<map page id>`.
		const moved = (key: string): string | null =>
			key === oldPath || key.startsWith(oldPath + '/') || key.startsWith(oldPath + '::')
				? newPath + key.slice(oldPath.length)
				: null;
		const s = this.settings;
		let changed = false;
		const maps: Record<string, unknown>[] = [
			s.graphCameras,
			s.mapCameras,
			s.graphManualX,
			s.graphManualY,
			s.graphPins,
			s.graphFilters,
			s.graphViews,
		];
		for (const map of maps) {
			for (const key of Object.keys(map)) {
				const next = moved(key);
				if (next === null) continue;
				map[next] = map[key];
				delete map[key];
				changed = true;
			}
		}
		s.projectOrder = s.projectOrder.map((root) => {
			const next = moved(root);
			if (next !== null) changed = true;
			return next ?? root;
		});
		this.app.workspace.iterateAllLeaves((leaf) => {
			const viewState = leaf.getViewState();
			const project = (viewState.state as { project?: unknown } | undefined)?.project;
			const next = typeof project === 'string' ? moved(project) : null;
			if (next !== null) void leaf.setViewState({ ...viewState, state: { ...viewState.state, project: next } });
		});
		return changed;
	}

	/** Moves every project folder into its kind subfolder under `next`
	 *  (`projectFolderPath`) and makes `next` the Loom root.
	 *  Skips (and reports) a project that can't move: one at the vault root,
	 *  one containing the new root, or one whose name is already taken there.
	 *  `fileManager.renameFile` keeps links intact; settings follow through the
	 *  folder branch of the `rename` handler. */
	async changeLoomRoot(next: string): Promise<void> {
		const previous = this.settings.loomRoot;
		const skipped: string[] = [];
		for (const project of this.indexer.getProjects()) {
			const folder = project.root === '' ? null : this.app.vault.getFolderByPath(project.root);
			const target = projectFolderPath(next, project.config.kind, project.root.split('/').pop() ?? '');
			if (target === project.root) continue;
			if (
				!folder ||
				next === project.root ||
				next.startsWith(project.root + '/') ||
				this.app.vault.getAbstractFileByPath(target)
			) {
				skipped.push(project.name);
				continue;
			}
			try {
				await ensureFolder(this.app, target.slice(0, target.lastIndexOf('/')));
				await this.app.fileManager.renameFile(folder, target);
			} catch (e) {
				console.error(`Loom Loom: failed to move project ${project.name}`, e);
				skipped.push(project.name);
			}
		}
		this.settings.loomRoot = next;
		await this.saveSettings();
		// The old root, left holding only empty kind folders, goes too.
		const old = this.app.vault.getFolderByPath(previous);
		const holdsFiles = (f: TFolder): boolean => f.children.some((c) => !(c instanceof TFolder) || holdsFiles(c));
		if (old && !holdsFiles(old)) await this.app.fileManager.trashFile(old);
		this.indexer.rebuild();
		new Notice(
			skipped.length > 0
				? t('settings.projects.root.skipped', { list: skipped.join(', ') })
				: t('settings.projects.root.moved', { root: next })
		);
	}

	/** Opens the project manager as a new main-area tab (the ribbon icon). */
	openProjectsTab(): void {
		void this.app.workspace.getLeaf('tab').setViewState({ type: VIEW_PROJECTS, active: true });
	}

	/** Last applied `projectsSidebarTab`, so the settings save this runs from
	 *  only touches the workspace when the toggle actually changed — and a
	 *  second save landing before the first leaf's view state settles can't
	 *  add a duplicate tab. */
	private appliedProjectsSidebarTab: boolean | null = null;

	/** Adds the project manager as a left-sidebar tab (beside Files/Search/
	 *  Bookmarks) or removes it, per `projectsSidebarTab`. Obsidian persists the
	 *  leaf in the workspace layout, so "on" only adds one when none exists. */
	applyProjectsSidebarTab(): void {
		const want = this.settings.projectsSidebarTab;
		if (!this.app.workspace.layoutReady || this.appliedProjectsSidebarTab === want) return;
		this.appliedProjectsSidebarTab = want;
		const { workspace } = this.app;
		const inSidebar = workspace
			.getLeavesOfType(VIEW_PROJECTS)
			.filter((leaf) => leaf.getRoot() === workspace.leftSplit);
		if (!want) {
			inSidebar.forEach((leaf) => leaf.detach());
		} else if (inSidebar.length === 0) {
			void workspace.getLeftLeaf(false)?.setViewState({ type: VIEW_PROJECTS, active: false });
		}
	}

	/**
	 * Resolves once the vault has stopped changing on its own: the metadata cache
	 * has finished its initial pass and no file has been created/modified/renamed
	 * /deleted for a few seconds.
	 *
	 * The startup migration renames notes and rewrites frontmatter. Running that
	 * against a vault a sync client is still filling in means acting on notes
	 * whose links don't resolve yet (so their managed name comes out wrong) and on
	 * transient duplicates — the renames then sync back out, the other machine
	 * does the same, and the two vaults generate conflict copies faster than
	 * either can index them. Waiting costs nothing: the migration is idempotent
	 * and there is always the next load.
	 */
	private waitForVaultSettled(quietMs = 5000, maxWaitMs = 10 * 60 * 1000): Promise<void> {
		return new Promise((resolve) => {
			const started = Date.now();
			let lastEvent = started;
			let cacheResolved = false;
			let done = false;
			const bump = () => {
				lastEvent = Date.now();
			};
			const vaultRefs = [
				this.app.vault.on('create', bump),
				this.app.vault.on('modify', bump),
				this.app.vault.on('delete', bump),
				this.app.vault.on('rename', bump),
			];
			// Fires when the cache finishes resolving links. In a vault that was
			// already indexed it may have fired before we got here, so it is a
			// hint, not a requirement — the elapsed-time floor below covers that.
			const cacheRef = this.app.metadataCache.on('resolved', () => {
				cacheResolved = true;
			});
			[...vaultRefs, cacheRef].forEach((ref) => this.registerEvent(ref));
			const finish = () => {
				if (done) return;
				done = true;
				window.clearInterval(timer);
				vaultRefs.forEach((ref) => this.app.vault.offref(ref));
				this.app.metadataCache.offref(cacheRef);
				resolve();
			};
			const timer = window.setInterval(() => {
				const now = Date.now();
				const quiet = now - lastEvent >= quietMs;
				const settled = cacheResolved || now - started >= 15000;
				if ((quiet && settled) || now - started >= maxWaitMs) finish();
			}, 1000);
			this.registerInterval(timer);
		});
	}

	/** Registers `loomCreated`/`loomModified` as "Date & time" properties in the
	 *  vault's type registry so Obsidian renders them in the datetime picker
	 *  rather than as plain text. `metadataTypeManager.setType` is a stable
	 *  (pre-1.13) internal API; guarded so a missing/renamed manager is a no-op. */
	private registerTimestampPropertyTypes(): void {
		const manager = (
			this.app as unknown as {
				metadataTypeManager?: { setType?: (name: string, type: string) => void };
			}
		).metadataTypeManager;
		if (typeof manager?.setType !== 'function') return;
		try {
			manager.setType(FM.created, 'datetime');
			manager.setType(FM.modified, 'datetime');
		} catch (e) {
			console.error('Loom Loom: failed to register timestamp property types', e);
		}
	}

	/**
	 * Project implied by the active leaf: a loom view carrying a project in its
	 * state (list/graph), or any open file inside a project folder (entity
	 * pages, home .loom files, and plain markdown notes alike).
	 */
	private activeProject(): ProjectDef | undefined {
		const state = this.app.workspace.getActiveViewOfType(ItemView)?.getState() as
			| { project?: unknown }
			| undefined;
		if (typeof state?.project === 'string') {
			const project = this.indexer.getProjectByRoot(state.project);
			if (project) return project;
		}
		const file = this.app.workspace.getActiveFile();
		return file ? this.indexer.projectForPath(file.path) : undefined;
	}

	/** Runs `action` with a project: the active one, the only one, or picked via suggester. */
	withProject(action: (project: ProjectDef) => void): void {
		const active = this.activeProject();
		if (active) {
			action(active);
			return;
		}
		const projects = this.indexer.getProjects();
		if (projects.length === 0) {
			new Notice(t('notice.noProjectYet'));
			new SetupProjectModal(this).open();
			return;
		}
		if (projects.length === 1) {
			action(projects[0]);
			return;
		}
		new ProjectSuggestModal(this, action).open();
	}

	openHome(): void {
		this.withProject((project) => {
			const file = this.app.vault.getFileByPath(project.loomPath);
			if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file);
		});
	}

	/** Opens an entity note in the plugin's entity page view, in a new tab. */
	openEntityFile(path: string, origin?: EntityOrigin): void {
		void this.app.workspace.getLeaf('tab').setViewState({
			type: VIEW_ENTITY,
			active: true,
			state: { file: path, origin },
		});
	}

	async activateView(viewType: string, state?: Record<string, unknown>): Promise<void> {
		const wanted = state?.project;
		const existing = this.app.workspace.getLeavesOfType(viewType).find((leaf: WorkspaceLeaf) => {
			const s = leaf.view.getState() as { project?: unknown };
			return wanted === undefined || s.project === wanted;
		});
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: viewType, active: true, state });
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applyTextSize();
		this.applyProjectsSidebarTab();
		this.applyLocale();
		this.applyThemeTextColoring();
	}

	/** Reflects the text-size setting as a body class the stylesheet keys off. */
	applyTextSize(): void {
		for (const body of this.windowBodies) {
			body.classList.toggle('loom-text-compact', this.settings.textSize === 'compact');
			body.classList.toggle('loom-text-large', this.settings.textSize === 'large');
		}
	}

	/** Reflects the "Follow theme text coloring" setting as a body class, AND
	 *  measures what the active theme actually renders headings/bold/italic as:
	 *  many themes color `h1`-`h6`/`strong`/`em` directly rather than through a
	 *  reusable custom property. `measureThemeTextColors` renders throwaway
	 *  probe elements and reads `getComputedStyle`; the results are stored as
	 *  our own `--loom-measured-*` properties on `document.body`, which
	 *  `styles.css` reads with a `--text-accent` fallback. */
	applyThemeTextColoring(): void {
		for (const body of this.windowBodies) {
			body.classList.toggle('loom-follow-theme-color', this.settings.followThemeTextColoring);
		}
		if (this.settings.followThemeTextColoring) this.measureThemeTextColors();
	}

	/** Renders one throwaway probe element per level/mark inside a hidden
	 *  `.markdown-rendered` container (the class most themes key their
	 *  heading/emphasis color rules off), reads each one's REAL computed
	 *  color, stores it as a `--loom-measured-*` custom property on
	 *  `document.body`, then removes the probe. Not a persistent DOM
	 *  fixture — cheap enough (a handful of elements, one layout pass) to
	 *  just redo on every call (`applyThemeTextColoring`, itself called on
	 *  load, on every settings save, and on Obsidian's own `css-change`
	 *  event) rather than trying to cache and invalidate. */
	private measureThemeTextColors(): void {
		// Probes mirror Live Preview's DOM: a heading is a `cm-header-N` span in
		// a `.cm-line.HyperMD-header.HyperMD-header-N` (never `<h1>`), emphasis
		// is `cm-strong`/`cm-em`. Mounted under `workspace.containerEl` so
		// themes whose colors resolve through ancestor-dependent custom
		// properties resolve the same way a real note does.
		const probe = this.app.workspace.containerEl.createDiv({
			cls: 'markdown-source-view mod-cm6 cm-editor cm-s-obsidian',
			attr: { style: 'position:fixed; top:-9999px; left:-9999px; visibility:hidden; pointer-events:none;' },
		});
		const content = probe.createDiv({ cls: 'cm-content' });
		const measure = (el: HTMLElement) => getComputedStyle(el).color;
		// `'X'`, not `'x'` — invisible to the user either way (the probe is
		// off-screen and removed immediately), but the Obsidian lint ruleset's
		// sentence-case check flags any lowercase `createEl(..., { text })` as
		// if it were real UI copy, with no way to mark a string as exempt.
		const headingLine = (level: number): HTMLElement =>
			content.createDiv({ cls: `cm-line HyperMD-header HyperMD-header-${level}` });
		const targets: [string, HTMLElement][] = [
			['h1', headingLine(1).createSpan({ cls: 'cm-header cm-header-1', text: 'X' })],
			['h2', headingLine(2).createSpan({ cls: 'cm-header cm-header-2', text: 'X' })],
			['h3', headingLine(3).createSpan({ cls: 'cm-header cm-header-3', text: 'X' })],
			['h4', headingLine(4).createSpan({ cls: 'cm-header cm-header-4', text: 'X' })],
			['bold', content.createSpan({ cls: 'cm-strong', text: 'X' })],
			['italic', content.createSpan({ cls: 'cm-em', text: 'X' })],
		];
		for (const [key, el] of targets) {
			const color = measure(el);
			for (const body of this.windowBodies) body.style.setProperty(`--loom-measured-${key}`, color);
		}
		probe.remove();
	}

	/** Resolves 'auto' against Obsidian's own display language (falling back
	 *  to English) and applies it to the i18n runtime every open view's `t()`
	 *  calls read from — mirrors `applyTextSize`'s "settings field -> global
	 *  runtime effect" shape. */
	applyLocale(): void {
		setLocale(resolveActiveLocale(this.settings.locale));
	}

	onunload(): void {
		for (const body of this.windowBodies) {
			body.classList.remove('loom-text-compact', 'loom-text-large', 'loom-follow-theme-color');
		}
	}
}
