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
	openEntity(path: string): void;
	navigateTo(viewType: string, state?: Record<string, unknown>): void;
	openLoomFile(path: string): void;
	plugin: LoomLoomPlugin;
}

/**
 * Navigates the current leaf to an entity page, recording the current view
 * as the origin so the page's Back button returns exactly there.
 */
function openEntityFrom(view: View, path: string): void {
	void view.leaf.setViewState({
		type: VIEW_ENTITY,
		active: true,
		state: {
			file: path,
			origin: { type: view.getViewType(), state: view.getState() },
		},
	});
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

	constructor(leaf: WorkspaceLeaf, readonly plugin: LoomLoomPlugin) {
		super(leaf);
	}

	protected abstract renderReact(): ReactElement;

	protected renderNow(): void {
		this.root?.render(this.renderReact());
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('loom-view');
		this.root = createRoot(this.contentEl);
		this.renderNow();
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
	}

	openEntity(path: string): void {
		openEntityFrom(this, path);
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
}

/** File-backed variant (project home .loom files, entity pages over .md). */
export abstract class LoomFileReactView extends FileView implements LoomNavigator {
	navigation = true;
	allowNoFile = false;
	private root: Root | null = null;

	constructor(leaf: WorkspaceLeaf, readonly plugin: LoomLoomPlugin) {
		super(leaf);
	}

	protected abstract renderReact(): ReactElement;

	protected renderNow(): void {
		this.root?.render(this.renderReact());
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.contentEl.addClass('loom-view');
		this.root = createRoot(this.contentEl);
		this.renderNow();
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.renderNow();
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
		await super.onClose();
	}

	openEntity(path: string): void {
		openEntityFrom(this, path);
	}

	navigateTo(viewType: string, state?: Record<string, unknown>): void {
		void this.leaf.setViewState({ type: viewType, active: true, state });
	}

	openLoomFile(path: string): void {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (file instanceof TFile) void this.leaf.openFile(file);
	}
}
