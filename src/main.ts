import { ItemView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
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
	scaffoldProject,
} from './project';
import { HomeView } from './views/home-view';
import { LoomFileReactView, LoomReactView } from './views/react-view';
import { EntityListView } from './views/list-view';
import { GraphView } from './views/graph-view';
import { EntityView } from './views/entity-view';
import { GroupView } from './views/group-view';
import { MapView } from './views/map-view';
import { ScriptView } from './views/script-view';
import { BookView } from './views/book-view';
import { LicenseManager } from './license/manager';
import { POLAR_ORGANIZATION_ID, PolarLicenseProvider } from './license/polar-provider';
import { resolveActiveLocale, setLocale, t } from './i18n';

/** How often the plugin re-checks an activated license in the background,
 *  independent of the manual "Re-check now" button. Well inside the 30-day
 *  offline grace period (see `license/grace.ts`), so a machine that's online
 *  most days re-verifies quietly long before the grace window could matter. */
const LICENSE_RECHECK_TICK_MS = 6 * 60 * 60 * 1000;

export default class LoomLoomPlugin extends Plugin {
	settings: LoomLoomSettings = DEFAULT_SETTINGS;
	indexer!: LoomIndexer;
	/** Freemium gate: one project of each kind is free, a license key unlocks
	 *  unlimited projects — see `src/license/`. `PolarLicenseProvider` is the
	 *  active provider (the Polar.sh org/product this points at is
	 *  `POLAR_ORGANIZATION_ID`, `src/license/polar-provider.ts`). */
	licenseManager!: LicenseManager;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyTextSize();
		this.applyLocale();
		this.applyThemeTextColoring();
		// Obsidian's own event for "the active theme/snippets changed" — without
		// this, switching themes while "Follow theme text coloring" is already
		// on would leave the measured colors stale until the next settings save.
		this.registerEvent(this.app.workspace.on('css-change', () => this.applyThemeTextColoring()));

		this.licenseManager = new LicenseManager(this.app, new PolarLicenseProvider(POLAR_ORGANIZATION_ID));

		this.indexer = this.addChild(new LoomIndexer(this.app, this));

		this.registerView(VIEW_HOME, (leaf) => new HomeView(leaf, this));
		this.registerView(VIEW_LIST, (leaf) => new EntityListView(leaf, this));
		this.registerView(VIEW_GRAPH, (leaf) => new GraphView(leaf, this));
		this.registerView(VIEW_ENTITY, (leaf) => new EntityView(leaf, this));
		this.registerView(VIEW_GROUP, (leaf) => new GroupView(leaf, this));
		this.registerView(VIEW_MAP, (leaf) => new MapView(leaf, this));
		this.registerView(VIEW_SCRIPT, (leaf) => new ScriptView(leaf, this));
		this.registerView(VIEW_PROSE, (leaf) => new BookView(leaf, this));
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

		this.addRibbonIcon('dices', t('command.ribbonTooltip'), () => this.openHome());

		this.addCommand({
			id: 'open-home',
			name: t('command.openHome'),
			callback: () => this.openHome(),
		});
		this.addCommand({
			id: 'open-graph',
			name: t('command.openLoom'),
			callback: () => this.withProject((p) => void this.activateView(VIEW_GRAPH, { project: p.root })),
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
				if (!(file instanceof TFile)) return;
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
			this.applyThemeTextColoring();
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
			...Object.values(this.settings.timelineManualOrder),
		];
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
		this.applyLocale();
		this.applyThemeTextColoring();
	}

	/** Reflects the text-size setting as a body class the stylesheet keys off. */
	applyTextSize(): void {
		document.body.classList.toggle('loom-text-compact', this.settings.textSize === 'compact');
		document.body.classList.toggle('loom-text-large', this.settings.textSize === 'large');
	}

	/** Reflects the "Follow theme text coloring" setting as a body class, AND
	 *  (unlike `applyTextSize`) also measures what the active theme actually
	 *  renders headings/bold/italic as, since there's no reliable way to read
	 *  this from CSS variables alone — confirmed live: many themes color
	 *  `h1`-`h6`/`strong`/`em` directly on those selectors rather than
	 *  exposing a reusable `--h1-color`-style custom property, so `var(--h1-color, …)`
	 *  silently fell through to the fallback for a theme that never set it.
	 *  The only genuinely universal read is asking the browser what color it
	 *  actually computed for a real themed element — `measureThemeTextColors`
	 *  does that by rendering throwaway probe elements and reading
	 *  `getComputedStyle`, then this stores each result as our OWN CSS custom
	 *  property (`--loom-measured-h1` etc.) on `document.body`, which
	 *  `styles.css`'s opt-in rules read with the same `--text-accent`
	 *  fallback as before for anything the probe couldn't resolve. */
	applyThemeTextColoring(): void {
		document.body.classList.toggle('loom-follow-theme-color', this.settings.followThemeTextColoring);
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
		// Obsidian's Live Preview (where notes are actually edited, the same
		// context this plugin's own CM6 editors sit in) renders a heading as a
		// plain `<span class="cm-header cm-header-N">` inside a
		// `.cm-line.HyperMD-header.HyperMD-header-N` — never a semantic
		// `<h1>`-`<h6>` tag, confirmed directly against a real note's DOM.
		// Emphasis follows the identical span-plus-class convention
		// (`cm-strong`/`cm-em`), not `<strong>`/`<em>`. Mounted under
		// `workspace.containerEl` (the real app root Obsidian itself renders
		// every leaf inside), not a bare `document.body` child — a theme
		// whose colors resolve through several layers of custom properties
		// (confirmed live: one theme's compiled `light-dark()` output) can
		// depend on that exact ancestry to resolve the same way a real note
		// does, not just on `body`'s own theme-mode class.
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
			document.body.style.setProperty(`--loom-measured-${key}`, measure(el));
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
		document.body.classList.remove('loom-text-compact', 'loom-text-large', 'loom-follow-theme-color');
	}
}
