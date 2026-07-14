import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import {
	ENTITY_META,
	ENTITY_TYPES,
	LOOM_EXTENSION,
	VIEW_ENTITY,
	VIEW_GRAPH,
	VIEW_HOME,
	VIEW_LIST,
	VIEW_TIMELINE,
} from './types';
import { DEFAULT_SETTINGS, LoomLoomSettingTab, LoomLoomSettings, mergeSettings } from './settings';
import { LoomIndexer, ProjectDef } from './indexer';
import { CreateEntityModal, ProjectSuggestModal, SetupProjectModal, scaffoldProject } from './project';
import { HomeView } from './views/home-view';
import { EntityListView } from './views/list-view';
import { TimelineView } from './views/timeline-view';
import { GraphView } from './views/graph-view';
import { EntityView } from './views/entity-view';

export default class LoomLoomPlugin extends Plugin {
	settings: LoomLoomSettings = DEFAULT_SETTINGS;
	indexer!: LoomIndexer;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.indexer = this.addChild(new LoomIndexer(this.app, this));

		this.registerView(VIEW_HOME, (leaf) => new HomeView(leaf, this));
		this.registerView(VIEW_LIST, (leaf) => new EntityListView(leaf, this));
		this.registerView(VIEW_TIMELINE, (leaf) => new TimelineView(leaf, this));
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
			id: 'open-timeline',
			name: 'Open timeline',
			callback: () => this.withProject((p) => void this.activateView(VIEW_TIMELINE, { project: p.root })),
		});
		this.addCommand({
			id: 'open-graph',
			name: 'Open Loom graph',
			callback: () => this.withProject((p) => void this.activateView(VIEW_GRAPH, { project: p.root })),
		});
		this.addCommand({
			id: 'setup-project',
			name: 'Set up project',
			callback: () => new SetupProjectModal(this).open(),
		});
		for (const type of ENTITY_TYPES) {
			this.addCommand({
				id: `create-${type}`,
				name: `Create ${ENTITY_META[type].label.toLowerCase()}`,
				callback: () => this.withProject((p) => new CreateEntityModal(this, type, p).open()),
			});
		}

		this.addSettingTab(new LoomLoomSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.migrateLegacyProject().then(() => this.indexer.rebuild());
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

	/** Runs `action` with a project: the only one, or picked via suggester. */
	withProject(action: (project: ProjectDef) => void): void {
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
	openEntityFile(path: string): void {
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
	}
}
