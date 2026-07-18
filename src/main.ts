import { ItemView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import {
	EntityOrigin,
	LOOM_EXTENSION,
	VIEW_ENTITY,
	VIEW_GRAPH,
	VIEW_HOME,
	VIEW_LIST,
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
		// Project home files show up in the file explorer like .canvas/.base
		// files and open straight into the plugin.
		this.registerExtensions([LOOM_EXTENSION], VIEW_HOME);

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
			id: 'create-entity',
			name: 'Create entity in current project',
			callback: () =>
				this.withProject((p) =>
					new EntityTypeSuggestModal(this, (type) => new CreateEntityModal(this, type, p).open()).open()
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
			for (const entries of [
					...Object.values(this.settings.graphManualX),
					...Object.values(this.settings.graphManualY),
					...Object.values(this.settings.timelineManualOrder),
				]) {
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
			for (const entries of [
					...Object.values(this.settings.graphManualX),
					...Object.values(this.settings.graphManualY),
					...Object.values(this.settings.timelineManualOrder),
				]) {
					if (file.path in entries) {
						delete entries[file.path];
						changed = true;
					}
				}
				if (changed) void this.saveSettings();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			void this.migrateLegacyProject().then(() => {
				this.indexer.rebuild();
				// Frontmatter-key + managed-file-name migration of existing notes;
				// idempotent, so running it on every load is safe and cheap.
				void this.indexer.migrateFiles();
			});
		});
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
