import { ItemView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import {
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
	VIEW_SCRIPT,
} from './types';
import { DEFAULT_SETTINGS, LoomLoomSettingTab, LoomLoomSettings, mergeSettings } from './settings';
import { LoomIndexer, ProjectDef } from './indexer';
import {
	CreateEntityModal,
	EntityTypeSuggestModal,
	ProjectSuggestModal,
	SetupProjectModal,
	scaffoldProject,
} from './project';
import { HomeView } from './views/home-view';
import { EntityListView } from './views/list-view';
import { GraphView } from './views/graph-view';
import { EntityView } from './views/entity-view';
import { GroupView } from './views/group-view';
import { MapView } from './views/map-view';
import { ScriptView } from './views/script-view';

export default class LoomLoomPlugin extends Plugin {
	settings: LoomLoomSettings = DEFAULT_SETTINGS;
	indexer!: LoomIndexer;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyTextSize();

		this.indexer = this.addChild(new LoomIndexer(this.app, this));

		this.registerView(VIEW_HOME, (leaf) => new HomeView(leaf, this));
		this.registerView(VIEW_LIST, (leaf) => new EntityListView(leaf, this));
		this.registerView(VIEW_GRAPH, (leaf) => new GraphView(leaf, this));
		this.registerView(VIEW_ENTITY, (leaf) => new EntityView(leaf, this));
		this.registerView(VIEW_GROUP, (leaf) => new GroupView(leaf, this));
		this.registerView(VIEW_MAP, (leaf) => new MapView(leaf, this));
		this.registerView(VIEW_SCRIPT, (leaf) => new ScriptView(leaf, this));
		// Project home files show up in the file explorer like .canvas/.base
		// files and open straight into the plugin.
		this.registerExtensions([LOOM_EXTENSION], VIEW_HOME);
		// The Fountain script gets its own extension for the same reason, plus
		// one of its own: Fountain's note syntax IS `[[…]]`, so keeping the
		// script out of markdown is what stops Obsidian indexing every
		// non-exporting script note as a wikilink.
		this.registerExtensions([SCRIPT_EXTENSION], VIEW_SCRIPT);

		this.addRibbonIcon('dices', 'Open Loom Loom home', () => this.openHome());

		this.addCommand({
			id: 'open-home',
			name: 'Open home',
			callback: () => this.openHome(),
		});
		this.addCommand({
			id: 'open-graph',
			name: 'Open Loom',
			callback: () => this.withProject((p) => void this.activateView(VIEW_GRAPH, { project: p.root })),
		});
		this.addCommand({
			id: 'setup-project',
			name: 'Set up project',
			callback: () => new SetupProjectModal(this).open(),
		});
		this.addCommand({
			id: 'apply-managed-file-names',
			name: 'Apply managed file names',
			callback: () => {
				new Notice('Loom Loom: applying managed file names…');
				void this.indexer.rebuildNow().then(() => this.indexer.migrateFiles(true));
			},
		});
		this.addCommand({
			id: 'create-entity',
			name: 'Create entity in current project',
			callback: () =>
				this.withProject((p) =>
					new EntityTypeSuggestModal(
						this,
						(type) => new CreateEntityModal(this, type, p).open(),
						p
					).open()
				),
		});

		this.addSettingTab(new LoomLoomSettingTab(this.app, this));

		// Keep per-file UI state (settings.entityBoxSizes, settings.graphManualX)
		// attached to the right file across renames, dropped on delete.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				let changed = false;
				const sizes = this.settings.entityBoxSizes[oldPath];
				if (sizes) {
					delete this.settings.entityBoxSizes[oldPath];
					this.settings.entityBoxSizes[file.path] = sizes;
					changed = true;
				}
			const renameMaps: Record<string, unknown>[] = [
					...Object.values(this.settings.graphManualX),
					...Object.values(this.settings.graphManualY),
					...Object.values(this.settings.graphPins),
					...Object.values(this.settings.timelineManualOrder),
				];
				for (const entries of renameMaps) {
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
				if (file.path in this.settings.entityBoxSizes) {
					delete this.settings.entityBoxSizes[file.path];
					changed = true;
				}
			const deleteMaps: Record<string, unknown>[] = [
					...Object.values(this.settings.graphManualX),
					...Object.values(this.settings.graphManualY),
					...Object.values(this.settings.graphPins),
					...Object.values(this.settings.timelineManualOrder),
				];
				for (const entries of deleteMaps) {
					if (file.path in entries) {
						delete entries[file.path];
						changed = true;
					}
				}
				if (changed) void this.saveSettings();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.registerTimestampPropertyTypes();
			void this.migrateLegacyProject().then(async () => {
				await this.indexer.rebuildNow();
				// Frontmatter-key + managed-file-name migration of existing notes.
				// It reads records and resolves links, so it needs a built index and
				// a vault that has stopped moving under it — see `waitForVaultSettled`.
				await this.waitForVaultSettled();
				await this.indexer.rebuildNow();
				await this.indexer.migrateFiles();
			});
		});
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

	/** Pre-.loom versions stored a single project root in settings. */
	private async migrateLegacyProject(): Promise<void> {
		const root = this.settings.projectRoot;
		if (root === '') return;
		const folder = this.app.vault.getFolderByPath(normalizePath(root));
		if (folder && !folder.children.some((f) => f instanceof TFile && f.extension === LOOM_EXTENSION)) {
			try {
				await scaffoldProject(this.app, folder.path);
			} catch (e) {
				console.error('Loom Loom: legacy project migration failed', e);
				return;
			}
		}
		this.settings.projectRoot = '';
		await this.saveSettings();
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
			new Notice('No project yet — set one up first.');
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

	/** Opens an entity page in a fresh tab (for middle-click). */
	openEntityInTab(path: string): void {
		void this.app.workspace.getLeaf('tab').setViewState({
			type: VIEW_ENTITY,
			active: true,
			state: { file: path },
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
	}

	/** Reflects the text-size setting as a body class the stylesheet keys off. */
	applyTextSize(): void {
		document.body.classList.toggle('loom-text-compact', this.settings.textSize === 'compact');
		document.body.classList.toggle('loom-text-large', this.settings.textSize === 'large');
	}

	onunload(): void {
		document.body.classList.remove('loom-text-compact', 'loom-text-large');
	}
}
