import { Keymap, Menu, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { KeyboardEvent, MouseEvent, ReactElement, useState } from 'react';
import { VIEW_PROJECTS } from '../types';
import { PROJECT_KINDS, PROJECT_KIND_META, ProjectKind, projectKindLabel } from '../project-kind';
import { ConfirmModal, SetupProjectModal } from '../project';
import { SnapshotsModal } from '../snapshots';
import type { ProjectDef } from '../indexer';
import { t } from '../i18n';
import { LoomReactView } from './react-view';
import { Icon, StartGuide, systemOpen } from './common';
import { useIndexVersion } from './hooks';

/**
 * Loom Loom's own project manager: every project grouped by kind, collapsible
 * groups, drag-to-reorder within a group. Opened as a main-area tab from the
 * ribbon, and optionally kept as a left-sidebar tab (settings →
 * `projectsSidebarTab`, applied by `LoomLoomPlugin.applyProjectsSidebarTab`).
 */
export class ProjectsView extends LoomReactView {
	getViewType(): string {
		return VIEW_PROJECTS;
	}

	protected pageTitle(): string {
		return t('view.projects.title');
	}

	getIcon(): string {
		return 'spool';
	}

	/** Where a clicked project opens. As a main-area tab this replaces itself
	 *  (Back returns here) or opens a new tab. In a sidebar it must never open
	 *  in place: `getLeaf(false)` reuses the active leaf whenever it can navigate,
	 *  and this view can, so a sidebar click goes to the most recent main-area
	 *  tab instead — what the file explorer does. */
	targetLeaf(newTab: boolean): WorkspaceLeaf {
		const { workspace } = this.app;
		if (newTab) return workspace.getLeaf('tab');
		if (this.leaf.getRoot() !== workspace.leftSplit && this.leaf.getRoot() !== workspace.rightSplit) {
			return workspace.getLeaf(false);
		}
		const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
		return recent && !recent.getViewState().pinned ? recent : workspace.getLeaf('tab');
	}

	protected renderReact(): ReactElement {
		return <ProjectManager view={this} />;
	}
}

/** `settings.projectOrder` first, then anything not in it yet, by name. */
function sortedProjects(projects: ProjectDef[], order: string[]): ProjectDef[] {
	const rank = (p: ProjectDef) => {
		const i = order.indexOf(p.root);
		return i === -1 ? Infinity : i;
	};
	return [...projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function ProjectManager({ view }: { view: ProjectsView }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
	const settings = plugin.settings;
	// Settings are mutated in place; this just re-renders after a write.
	const [, setTick] = useState(0);
	const [drag, setDrag] = useState<{ kind: ProjectKind; from: number; over: number } | null>(null);

	const byKind = new Map<ProjectKind, ProjectDef[]>();
	for (const p of sortedProjects(plugin.indexer.getProjects(), settings.projectOrder)) {
		const list = byKind.get(p.config.kind) ?? [];
		list.push(p);
		byKind.set(p.config.kind, list);
	}

	const save = () => {
		void plugin.saveSettings();
		setTick((n) => n + 1);
	};

	const toggleKind = (kind: ProjectKind) => {
		const collapsed = settings.collapsedProjectKinds;
		settings.collapsedProjectKinds = collapsed.includes(kind)
			? collapsed.filter((k) => k !== kind)
			: [...collapsed, kind];
		save();
	};

	const commitDrag = () => {
		if (!drag) return;
		const list = [...(byKind.get(drag.kind) ?? [])];
		const [moved] = list.splice(drag.from, 1);
		list.splice(drag.over > drag.from ? drag.over - 1 : drag.over, 0, moved);
		byKind.set(drag.kind, list);
		// Rewritten whole from what's live, so roots of deleted projects drop out.
		settings.projectOrder = PROJECT_KINDS.flatMap((k) => (byKind.get(k) ?? []).map((p) => p.root));
		setDrag(null);
		save();
	};

	/** Moves the whole project folder to the trash (recoverable from there),
	 *  with the outside-delete window held off — this delete is the user's own. */
	const confirmDelete = (project: ProjectDef) => {
		new ConfirmModal(
			plugin.app,
			t('view.projects.deleteTitle'),
			t('view.projects.deleteDetail', { name: project.name }),
			async () => {
				const folder = plugin.app.vault.getAbstractFileByPath(project.root);
				if (!(folder instanceof TFolder)) return;
				plugin.deletePromptPause++;
				try {
					await plugin.app.fileManager.trashFile(folder);
				} catch (err) {
					console.error('Loom Loom: failed to delete project', err);
					new Notice(t('view.projects.deleteFailed'));
					return;
				} finally {
					plugin.deletePromptPause--;
				}
				settings.projectOrder = settings.projectOrder.filter((r) => r !== project.root);
				save();
			},
			t('project.common.delete')
		).open();
	};

	const open = (project: ProjectDef, evt: MouseEvent | KeyboardEvent) => {
		const file = plugin.app.vault.getFileByPath(project.loomPath);
		if (file instanceof TFile) void view.targetLeaf(Keymap.isModEvent(evt.nativeEvent) !== false).openFile(file, { active: true });
	};

	return (
		<div
			className="loom-pm"
			onContextMenu={(e) => {
				e.preventDefault();
				new Menu()
					.addItem((item) =>
						item
							.setTitle(t('view.projects.newProject'))
							.setIcon('plus')
							.onClick(() => new SetupProjectModal(plugin).open())
					)
					.showAtMouseEvent(e.nativeEvent);
			}}
		>
			<div className="loom-pm-header">
				<span className="loom-pm-title">{t('view.projects.title')}</span>
				<button
					className="mod-cta loom-pm-new"
					aria-label={t('view.projects.newProject')}
					onClick={() => new SetupProjectModal(plugin).open()}
				>
					<Icon name="plus" />
				</button>
			</div>
			{byKind.size === 0 && (
				<div className="loom-pm-empty">
					<StartGuide
						stack
						label={t('view.projects.emptyCreate')}
						actions={PROJECT_KINDS.map((kind) => ({
							icon: PROJECT_KIND_META[kind].icon,
							label: projectKindLabel(kind),
							onClick: () => new SetupProjectModal(plugin, kind).open(),
						}))}
					/>
				</div>
			)}
			{PROJECT_KINDS.filter((kind) => byKind.has(kind)).map((kind) => {
				const list = byKind.get(kind) ?? [];
				const collapsed = settings.collapsedProjectKinds.includes(kind);
				return (
					<div key={kind} className="loom-pm-group">
						<div
							className="loom-pm-kind"
							role="button"
							tabIndex={0}
							aria-expanded={!collapsed}
							onClick={() => toggleKind(kind)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									toggleKind(kind);
								}
							}}
						>
							<Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
							<Icon name={PROJECT_KIND_META[kind].icon} />
							<span className="loom-pm-kind-label">{projectKindLabel(kind)}</span>
							<span className="loom-pm-count">{list.length}</span>
						</div>
						{!collapsed && (
							<div className="loom-pm-list">
								{list.map((project, i) => {
									const dropCls =
										drag?.kind === kind && drag.over !== drag.from && drag.over !== drag.from + 1
											? drag.over === i
												? ' loom-pm-drop-before'
												: drag.over === list.length && i === list.length - 1
													? ' loom-pm-drop-after'
													: ''
											: '';
									return (
										<div
											key={project.root}
											className={
												'loom-pm-project' +
												(drag?.kind === kind && drag.from === i ? ' loom-pm-dragging' : '') +
												dropCls
											}
											draggable
											role="button"
											tabIndex={0}
											onClick={(e) => open(project, e)}
											onKeyDown={(e) => {
												if (e.key === 'Enter') open(project, e);
											}}
											onAuxClick={(e) => {
												if (e.button === 1) open(project, e);
											}}
											onContextMenu={(e) => {
												e.preventDefault();
												// Not the manager's own "New project" menu.
												e.stopPropagation();
												new Menu()
													.addItem((item) =>
														item
															.setTitle(t('view.projects.snapshots'))
															.setIcon('history')
															.onClick(() => new SnapshotsModal(plugin, project).open())
													)
													.addItem((item) =>
														item
															.setTitle(t('common.showInSystemExplorer'))
															.setIcon('arrow-up-right')
															.onClick(() => systemOpen(plugin.app, 'showInFolder', project.root))
													)
													.addSeparator()
													.addItem((item) =>
														item
															.setTitle(t('view.projects.delete'))
															.setIcon('trash-2')
															.setWarning(true)
															.onClick(() => confirmDelete(project))
													)
													.showAtMouseEvent(e.nativeEvent);
											}}
											onDragStart={(e) => {
												e.dataTransfer.effectAllowed = 'move';
												e.dataTransfer.setData('text/plain', project.name);
												setDrag({ kind, from: i, over: i });
											}}
											onDragOver={(e) => {
												if (drag?.kind !== kind) return;
												e.preventDefault();
												const r = e.currentTarget.getBoundingClientRect();
												const over = e.clientY < r.top + r.height / 2 ? i : i + 1;
												if (over !== drag.over) setDrag({ ...drag, over });
											}}
											onDrop={(e) => {
												e.preventDefault();
												commitDrag();
											}}
											onDragEnd={() => setDrag(null)}
										>
											{project.name}
										</div>
									);
								})}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
