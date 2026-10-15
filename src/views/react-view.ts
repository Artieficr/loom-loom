import { FileView, ItemView, TFile, View, WorkspaceLeaf } from 'obsidian';
import { ReactElement } from 'react';
import { Root, createRoot } from 'react-dom/client';
import { VIEW_ENTITY } from '../types';
import type LoomLoomPlugin from '../main';

/**
 * Shared navigation helpers for loom views. Entity notes always open in the
 * plugin's entity page view when navigated from inside the plugin — opening
 * from the file explorer still yields the normal markdown editor.
 */
export interface LoomNavigator {
	/** Opens the entity page in this leaf, or in a new tab when `newTab`. */
	openEntity(path: string, newTab?: boolean): void;
	navigateTo(viewType: string, state?: Record<string, unknown>): void;
	openLoomFile(path: string): void;
	/** Registers (or clears, with `null`) this leaf's Quick Notes toggle callback. */
	registerQuickNotesToggle(fn: (() => void) | null): void;
	/** Toggles this leaf's Quick Notes panel, if a callback is currently registered. */
	toggleQuickNotesPanel(): void;
	plugin: LoomLoomPlugin;
}

/**
 * Navigates the current leaf to an entity page, recording the current view
 * as the origin so the page's Back button returns exactly there. `newTab`
 * opens it in a fresh tab instead (for middle-click).
 */
function openEntityFrom(view: View, path: string, newTab = false): void {
	const leaf = newTab ? view.app.workspace.getLeaf('tab') : view.leaf;
	void leaf.setViewState({
		type: VIEW_ENTITY,
		active: true,
		state: {
			file: path,
			origin: { type: view.getViewType(), state: view.getState() },
		},
	});
}

/**
 * A Loom tab's title is its project's name, so tabs from one project read as
 * one set — the icon says which page each is. Outside a project (the project
 * manager, a page with no project) it falls back to the page's own title.
 */
function projectTabTitle(view: LoomNavigator & { overlayProject(): string | null }, pageTitle: string): string {
	const root = view.overlayProject();
	return (root !== null ? view.plugin.indexer.getProjectByRoot(root)?.name : undefined) ?? pageTitle;
}

/** Redraws a tab's title and icon when the index changes (a project
 *  renamed, a page opened before its project was indexed). `updateHeader`
 *  isn't public API, hence the guard. */
function refreshTabHeader(leaf: WorkspaceLeaf): void {
	(leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
}

/**
 * Base for the plugin's leaf-level custom views (home is file-backed — see
 * `LoomFileReactView`): mounts a React root in the content element on open
 * and tears it down on close. Subclasses implement `renderReact` and call
 * `renderNow` when view state changes; index-driven re-renders happen inside
 * components via `useIndexVersion`.
 */
export abstract class LoomReactView extends ItemView implements LoomNavigator {
	navigation = true;
	private root: Root | null = null;
	private quickNotesToggle: (() => void) | null = null;
	private detachDeleteOverlay: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, readonly plugin: LoomLoomPlugin) {
		super(leaf);
	}

	protected abstract renderReact(): ReactElement;

	/** The page's own title — the tab shows it only outside a project. */
	protected abstract pageTitle(): string;

	getDisplayText(): string {
		return projectTabTitle(this, this.pageTitle());
	}

	/** The project this tab shows (its `project` view state), if any. */
	overlayProject(): string | null {
		const project = this.getState().project;
		return typeof project === 'string' ? project : null;
	}

	protected renderNow(): void {
		this.root?.render(this.renderReact());
		this.plugin.syncDeleteOverlay(this);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('loom-view');
		this.root = createRoot(this.contentEl);
		this.detachDeleteOverlay = this.plugin.attachDeleteOverlay(this);
		this.registerEvent(this.plugin.indexer.events.on('changed', () => refreshTabHeader(this.leaf)));
		this.renderNow();
	}

	async onClose(): Promise<void> {
		this.detachDeleteOverlay?.();
		this.detachDeleteOverlay = null;
		this.root?.unmount();
		this.root = null;
	}

	openEntity(path: string, newTab = false): void {
		openEntityFrom(this, path, newTab);
	}

	/** Navigates this leaf to another plugin view (history-friendly). */
	navigateTo(viewType: string, state?: Record<string, unknown>): void {
		void this.leaf.setViewState({ type: viewType, active: true, state });
	}

	/** Opens a project's .loom home file in this leaf. */
	openLoomFile(path: string): void {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (file instanceof TFile) void this.leaf.openFile(file);
	}

	registerQuickNotesToggle(fn: (() => void) | null): void {
		this.quickNotesToggle = fn;
	}

	toggleQuickNotesPanel(): void {
		this.quickNotesToggle?.();
	}
}

/** File-backed variant (project home .loom files, entity pages over .md). */
export abstract class LoomFileReactView extends FileView implements LoomNavigator {
	navigation = true;
	allowNoFile = false;
	private root: Root | null = null;
	private quickNotesToggle: (() => void) | null = null;
	private detachDeleteOverlay: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, readonly plugin: LoomLoomPlugin) {
		super(leaf);
	}

	protected abstract renderReact(): ReactElement;

	/** The page's own title — the tab shows it only outside a project. */
	protected abstract pageTitle(): string;

	getDisplayText(): string {
		return projectTabTitle(this, this.pageTitle());
	}

	/** The project this tab's file belongs to, if any. */
	overlayProject(): string | null {
		return this.file ? (this.plugin.indexer.projectForPath(this.file.path)?.root ?? null) : null;
	}

	protected renderNow(): void {
		this.root?.render(this.renderReact());
		this.plugin.syncDeleteOverlay(this);
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.contentEl.addClass('loom-view');
		this.root = createRoot(this.contentEl);
		this.detachDeleteOverlay = this.plugin.attachDeleteOverlay(this);
		this.registerEvent(this.plugin.indexer.events.on('changed', () => refreshTabHeader(this.leaf)));
		this.renderNow();
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.renderNow();
	}

	async onClose(): Promise<void> {
		this.detachDeleteOverlay?.();
		this.detachDeleteOverlay = null;
		this.root?.unmount();
		this.root = null;
		await super.onClose();
	}

	openEntity(path: string, newTab = false): void {
		openEntityFrom(this, path, newTab);
	}

	navigateTo(viewType: string, state?: Record<string, unknown>): void {
		void this.leaf.setViewState({ type: viewType, active: true, state });
	}

	openLoomFile(path: string): void {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (file instanceof TFile) void this.leaf.openFile(file);
	}

	registerQuickNotesToggle(fn: (() => void) | null): void {
		this.quickNotesToggle = fn;
	}

	toggleQuickNotesPanel(): void {
		this.quickNotesToggle?.();
	}
}
