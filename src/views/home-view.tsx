import { ReactElement } from 'react';
import {
	ENTITY_META,
	ENTITY_TYPES,
	EntityType,
	LOOM_EXTENSION,
	VIEW_GRAPH,
	VIEW_HOME,
	VIEW_LIST,
	VIEW_TIMELINE,
} from '../types';
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

	return (
		<div className="loom-home">
			<h2>{project.name}</h2>
			<div className="loom-home-grid">
				{ENTITY_TYPES.map((type) => (
					<button key={type} className="loom-card" onClick={() => openList(type)}>
						<Icon name={ENTITY_META[type].icon} />
						<span className="loom-card-label">{ENTITY_META[type].plural}</span>
						<span className="loom-card-count">{plugin.indexer.getAll(type, project.root).length}</span>
					</button>
				))}
			</div>
			<div className="loom-home-grid loom-home-grid-wide">
				<button className="loom-card" onClick={() => view.navigateTo(VIEW_TIMELINE, state)}>
					<Icon name="calendar-range" />
					<span className="loom-card-label">Timeline</span>
				</button>
				<button className="loom-card" onClick={() => view.navigateTo(VIEW_GRAPH, state)}>
					<Icon name="git-fork" />
					<span className="loom-card-label">Loom graph</span>
				</button>
			</div>
		</div>
	);
}
