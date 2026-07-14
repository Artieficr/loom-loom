import { ViewStateResult } from 'obsidian';
import { ReactElement, useMemo, useState } from 'react';
import { ENTITY_META, EntityRecord, EntityType, VIEW_LIST, isEntityType } from '../types';
import { ConfirmDeleteModal, CreateEntityModal } from '../project';
import { LoomReactView } from './react-view';
import { Icon, ViewShell, noProjectMessage, recordDate, recordLabel } from './common';
import { resolveProject, useIndexVersion } from './hooks';

type SortMode = 'name' | 'created' | 'modified' | 'date';

export class EntityListView extends LoomReactView {
	entityType: EntityType = 'character';
	projectRoot: string | null = null;

	getViewType(): string {
		return VIEW_LIST;
	}

	getDisplayText(): string {
		return ENTITY_META[this.entityType].plural;
	}

	getIcon(): string {
		return ENTITY_META[this.entityType].icon;
	}

	getState(): Record<string, unknown> {
		return { entityType: this.entityType, project: this.projectRoot };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as { entityType?: unknown; project?: unknown } | null;
		if (isEntityType(s?.entityType)) this.entityType = s.entityType;
		if (typeof s?.project === 'string') this.projectRoot = s.project;
		await super.setState(state, result);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		// key remounts the component (resetting search/sort/filter) when the
		// same leaf is reused for a different entity type or project.
		return (
			<EntityList
				key={`${this.projectRoot ?? ''}:${this.entityType}`}
				view={this}
				type={this.entityType}
				projectRoot={this.projectRoot}
			/>
		);
	}
}

function compare(a: EntityRecord, b: EntityRecord, mode: SortMode): number {
	switch (mode) {
		case 'created':
			return b.created - a.created;
		case 'modified':
			return b.modified - a.modified;
		case 'date': {
			const ka = a.date?.sortKey ?? Number.POSITIVE_INFINITY;
			const kb = b.date?.sortKey ?? Number.POSITIVE_INFINITY;
			return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
		}
		default:
			return a.name.localeCompare(b.name);
	}
}

function EntityList({
	view,
	type,
	projectRoot,
}: {
	view: EntityListView;
	type: EntityType;
	projectRoot: string | null;
}) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const dated = type === 'event' || type === 'session';
	const [query, setQuery] = useState('');
	const [sort, setSort] = useState<SortMode>(type === 'session' ? 'date' : 'name');
	const [tagFilter, setTagFilter] = useState('');

	const project = resolveProject(plugin.indexer, projectRoot);
	const vocab = plugin.settings.tagVocabulary[type];

	const records = useMemo(() => {
		if (!project) return [];
		const q = query.toLowerCase();
		return plugin.indexer
			.getAll(type, project.root)
			.filter(
				(r) =>
					q === '' ||
					recordLabel(r, project).toLowerCase().includes(q) ||
					r.description.toLowerCase().includes(q)
			)
			.filter((r) => tagFilter === '' || r.pluginTags.includes(tagFilter))
			.sort((a, b) => compare(a, b, sort));
	}, [plugin.indexer, version, project, type, query, sort, tagFilter]);

	if (!project) {
		return (
			<ViewShell view={view} project={null} title={ENTITY_META[type].plural}>
				{noProjectMessage()}
			</ViewShell>
		);
	}

	const toolbar = (
		<>
			<input
				type="search"
				className="loom-search"
				placeholder="Search…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<select className="dropdown" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
				{type !== 'session' ? <option value="name">Sort: name</option> : null}
				<option value="created">Sort: created</option>
				<option value="modified">Sort: modified</option>
				{dated ? <option value="date">Sort: date</option> : null}
			</select>
			{vocab.length > 0 ? (
				<select className="dropdown" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
					<option value="">All tags</option>
					{vocab.map((tag) => (
						<option key={tag} value={tag}>
							{tag}
						</option>
					))}
				</select>
			) : null}
			<div className="loom-shell-spacer" />
			<button className="mod-cta" onClick={() => new CreateEntityModal(plugin, type, project).open()}>
				New {ENTITY_META[type].label.toLowerCase()}
			</button>
		</>
	);

	return (
		<ViewShell view={view} project={project} title={ENTITY_META[type].plural} toolbar={toolbar}>
			{records.length === 0 ? (
				<div className="loom-empty">Nothing here yet.</div>
			) : (
				<div className="loom-list">
					{records.map((r) => (
						<div key={r.path} className="loom-row" onClick={() => view.openEntity(r.path)}>
							<span className="loom-row-name">{recordLabel(r, project)}</span>
							{r.pluginTags.map((tag) => (
								<span key={tag} className="loom-chip">
									{tag}
								</span>
							))}
							{r.date && r.type !== 'session' ? (
								<span className="loom-row-date">{recordDate(r, project)}</span>
							) : null}
							<span className="loom-row-desc">{r.description}</span>
							<button
								className="loom-row-delete"
								aria-label="Delete"
								onClick={(e) => {
									e.stopPropagation();
									new ConfirmDeleteModal(plugin.app, recordLabel(r, project), () => {
										const file = plugin.app.vault.getFileByPath(r.path);
										if (file) void plugin.app.fileManager.trashFile(file);
									}).open();
								}}
							>
								<Icon name="trash-2" />
							</button>
						</div>
					))}
				</div>
			)}
		</ViewShell>
	);
}
