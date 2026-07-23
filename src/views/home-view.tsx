import { CSSProperties, ReactElement } from 'react';
import {
	ENTITY_META,
	ENTITY_TYPES,
	EntityType,
	LOOM_EXTENSION,
	MAPS_ICON,
	MAPS_LABEL,
	PC_GROUP_ICON,
	VIEW_GRAPH,
	VIEW_GROUP,
	VIEW_HOME,
	VIEW_LIST,
	VIEW_MAP,
} from '../types';
import { groupNameOf } from '../calendar';
import { LoomFileReactView } from './react-view';
import { Icon } from './common';
import { useIndexVersion } from './hooks';

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

function Home({ view }: { view: HomeView }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);

	const loomPath = view.file?.path;
	const project = loomPath ? plugin.indexer.getProjectByLoomPath(loomPath) : undefined;
	if (!project) {
		return <div className="loom-empty">Loading project…</div>;
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
		// Maps sits right after Locations (no count — it's a canvas, not a list).
		...ENTITY_TYPES.flatMap((type) => {
			const entry = {
				key: type,
				icon: ENTITY_META[type].icon,
				label: ENTITY_META[type].plural,
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
						label: MAPS_LABEL,
						color: plugin.settings.mapsColor,
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
					<span className="loom-card-label">Loom</span>
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
	);
}
