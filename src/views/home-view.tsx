import { TAbstractFile } from 'obsidian';
import { CSSProperties, ReactElement, useEffect, useState } from 'react';
import {
	BOOK_ICON,
	ENTITY_META,
	EntityType,
	LOOM_EXTENSION,
	MAPS_ICON,
	SCRIPT_ICON,
	PC_GROUP_ICON,
	VIEW_GRAPH,
	VIEW_GROUP,
	VIEW_HOME,
	VIEW_LIST,
	VIEW_MAP,
	bookLabel,
	entityPlural,
	mapsLabel,
	scriptLabel,
} from '../types';
import { groupNameOf } from '../calendar';
import { features, projectTypes } from '../project-kind';
import { LoomFileReactView } from './react-view';
import { Icon, NavRail } from './common';
import { useIndexVersion } from './hooks';
import { countMapPages, mapsFilePath } from './map-view';
import { createScriptFile, scriptFilePath } from './script-buffer';
import { createBookFile, findBookFile } from './book-view';
import { t } from '../i18n';
import type LoomLoomPlugin from '../main';

/**
 * Project home: a FileView over the project's .loom file, so every project
 * has a visible entry point in the file explorer (like .canvas/.base files)
 * and multiple projects can coexist in one vault.
 */
export class HomeView extends LoomFileReactView {
	getViewType(): string {
		return VIEW_HOME;
	}

	getDisplayText(): string {
		return this.file?.basename ?? 'Loom Loom';
	}

	getIcon(): string {
		return 'dices';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === LOOM_EXTENSION;
	}

	protected renderReact(): ReactElement {
		return <Home view={this} />;
	}
}

/**
 * The project's map-page count for the wheel's Maps entry. Maps live in a JSON
 * file, not in the entity index, so this reads that file directly and re-reads it
 * whenever it changes — the index version never moves for a maps edit.
 */
function useMapPageCount(plugin: LoomLoomPlugin, project: { root: string; name: string } | undefined): number {
	const [count, setCount] = useState(0);
	const root = project?.root;
	const name = project?.name;
	useEffect(() => {
		if (root === undefined || name === undefined) return;
		const proj = { root, name };
		const mapsPath = mapsFilePath(proj);
		let cancelled = false;
		const refresh = () => {
			void countMapPages(plugin.app, proj).then((n) => {
				if (!cancelled) setCount(n);
			});
		};
		refresh();
		const touched = (file: TAbstractFile) => {
			if (file.path === mapsPath) refresh();
		};
		const refs = [
			plugin.app.vault.on('modify', touched),
			plugin.app.vault.on('create', touched),
			plugin.app.vault.on('delete', touched),
		];
		return () => {
			cancelled = true;
			for (const ref of refs) plugin.app.vault.offref(ref);
		};
	}, [plugin, root, name]);
	return count;
}

function Home({ view }: { view: HomeView }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);

	const loomPath = view.file?.path;
	const project = loomPath ? plugin.indexer.getProjectByLoomPath(loomPath) : undefined;
	// Before the early return — hooks can't live behind a condition.
	const mapCount = useMapPageCount(plugin, project);
	if (!project) {
		return <div className="loom-empty">{t('view.home.loadingProject')}</div>;
	}

	const state = { project: project.root };
	const openList = (type: EntityType) => view.navigateTo(VIEW_LIST, { ...state, entityType: type });

	// The wheel's satellites: Group first (12 o'clock), then the entity types
	// clockwise in their canonical order. Positions distribute evenly, so a
	// future entry just narrows the angle step. Each carries its node color
	// (Group wears the faction color, like its chips).
	const satellites: {
		key: string;
		icon: string;
		label: string;
		color: string;
		count?: number;
		open: () => void;
	}[] = [
		// The script takes the 12 o'clock slot the Group holds in the other
		// kinds, so every entity satellite below keeps its usual place. It counts
		// its scenes — the one satellite that isn't an entity list.
		...(features(project.config).script
			? [
					{
						key: 'script',
						icon: SCRIPT_ICON,
						label: scriptLabel(),
						color: plugin.settings.groupColor,
						// No count: a project has exactly one script, so "1" is noise.
						open: () => {
							const path = scriptFilePath(project);
							const scriptFile = plugin.app.vault.getFileByPath(path);
							if (scriptFile) view.openLoomFile(path);
							else void createScriptFile(plugin, project).then((f) => view.openLoomFile(f.path));
						},
					},
				]
			: []),
		// Writer/Prose's own 12 o'clock entry, mirroring Script's — mutually
		// exclusive with it (never both in one project), same slot. Like
		// Script, a project has exactly one Book, so no count (noise).
		// Chapters keep their own normal entry further down the wheel too —
		// this is a separate "whole book" entry point, not a replacement for it.
		...(project.config.kind === 'writer' && project.config.writerMode === 'prose'
			? [
					{
						key: 'book',
						icon: BOOK_ICON,
						label: bookLabel(),
						color: plugin.settings.groupColor,
						// No count: a project has exactly one Book, so "1" is noise —
						// same reasoning as Script's own entry above.
						open: () => {
							const bookFile = findBookFile(plugin, project);
							if (bookFile) view.openLoomFile(bookFile.path);
							else void createBookFile(plugin, project).then((f) => view.openLoomFile(f.path));
						},
					},
				]
			: []),
		// The Group is the party — it only exists in kinds that have one.
		...(features(project.config).group
			? [
					{
						key: 'group',
						icon: PC_GROUP_ICON,
						label: groupNameOf(project.config),
						color: plugin.settings.groupColor,
						count: plugin.indexer.getGroupMembers(project.root).length,
						open: () =>
							view.navigateTo(VIEW_GROUP, {
								...state,
								origin: { type: view.getViewType(), state: view.getState() },
							}),
					},
				]
			: []),
		// Maps sits right after Locations, counting the project's map PAGES (its
		// entities aren't notes, so the count comes from the Maps file, not the
		// index). Regions are reached through Locations (the location list groups by
		// region) and Decision Points through Events (same grouping, one tier
		// down), so neither gets its own wheel satellite. Chapter keeps its
		// normal satellite here too — the "Book" 12-o'clock entry above is an
		// additional whole-book entry point, not a replacement for this one.
		...projectTypes(project.config)
			.filter((t) => t !== 'region' && t !== 'decisionPoint')
			.flatMap((type) => {
			const entry = {
				key: type,
				icon: ENTITY_META[type].icon,
				label: entityPlural(type),
				color: plugin.settings.nodeColors[type],
				count: plugin.indexer.getAll(type, project.root).length,
				open: () => openList(type),
			};
			if (type === 'location') {
				return [
					entry,
					{
						key: 'maps',
						icon: MAPS_ICON,
						label: mapsLabel(),
						color: plugin.settings.mapsColor,
						count: mapCount,
						open: () => view.navigateTo(VIEW_MAP, state),
					},
				];
			}
			return [entry];
		}),
	];

	// Loom button colors: "original" carries no inline colors — CSS supplies
	// the plum/cream pair and flips it with the app theme (body.theme-dark),
	// live. Custom pins the user's own pair.
	const loomCustom = plugin.settings.loomButtonStyle === 'custom';

	return (
		<div className="loom-shell-row">
		{/* No entity-list/script/graph buttons here — the wheel below already
		    covers that navigation — just Quick Notes, so its trigger lands in
		    the exact spot every other page's does instead of a hand-tuned
		    stand-in position. */}
		<NavRail navigator={view} project={project} minimal />
		<div className="loom-home">
			<h2>{project.name}</h2>
			<div className="loom-home-wheel">
				<button
					className={
						loomCustom
							? 'loom-card loom-wheel-center'
							: 'loom-card loom-wheel-center loom-wheel-center-original'
					}
					style={
						loomCustom
							? ({
									'--wheel-center-bg': plugin.settings.loomButtonBg,
									'--wheel-center-icon': plugin.settings.loomButtonIcon,
								} as CSSProperties)
							: undefined
					}
					onClick={() => view.navigateTo(VIEW_GRAPH, state)}
				>
					<Icon name="spool" />
					<span className="loom-card-label">{t('common.loomGraph')}</span>
				</button>
				{satellites.map((s, i) => {
					const angle = ((-90 + (360 / satellites.length) * i) * Math.PI) / 180;
					const style = {
						'--wheel-x': Math.cos(angle).toFixed(4),
						'--wheel-y': Math.sin(angle).toFixed(4),
						'--wheel-color': s.color,
					} as CSSProperties;
					return (
						<button key={s.key} className="loom-card loom-wheel-card" style={style} onClick={s.open}>
							<Icon name={s.icon} fallback={s.key === 'group' ? 'star' : undefined} />
							<span className="loom-card-label">{s.label}</span>
							{s.count !== undefined ? <span className="loom-card-count">{s.count}</span> : null}
						</button>
					);
				})}
			</div>
		</div>
		</div>
	);
}
