import { ViewStateResult } from 'obsidian';
import { ReactElement, useMemo, useState } from 'react';
import { ENTITY_META, ENTITY_TAGS, EntityRecord, EntityType, VIEW_LIST, isEntityType } from '../types';
import { ConfirmModal, CreateEntityModal } from '../project';
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
	/** Locations only: explicit per-parent collapse choices; parents absent
	 *  here auto-collapse once they hold more than 5 sublocations. */
	const [collapseOverride, setCollapseOverride] = useState<ReadonlyMap<string, boolean>>(new Map());

	const project = resolveProject(plugin.indexer, projectRoot);
	const vocab = ENTITY_TAGS[type];

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
			.filter((r) => tagFilter === '' || r.loomTags.includes(tagFilter))
			.sort((a, b) => compare(a, b, sort));
	}, [plugin.indexer, version, project, type, query, sort, tagFilter]);

	// Locations nest under their parentLocation (searching flattens the list —
	// a match shouldn't hide inside a collapsed parent). Cycles fall back to
	// top level.
	const nested = type === 'location' && query === '';
	const { roots, childrenOf } = useMemo(() => {
		const childrenOf = new Map<string, EntityRecord[]>();
		const roots: EntityRecord[] = [];
		if (!nested) return { roots: records, childrenOf };
		const byPath = new Map(records.map((r) => [r.path, r]));
		const parentInList = (r: EntityRecord): EntityRecord | null => {
			const parent =
				r.parentLocation !== null ? plugin.indexer.resolve(r.parentLocation, r.path) : null;
			return parent && parent.path !== r.path && byPath.has(parent.path)
				? byPath.get(parent.path) ?? null
				: null;
		};
		const inCycle = (r: EntityRecord): boolean => {
			const seen = new Set([r.path]);
			let cur: EntityRecord | null = parentInList(r);
			while (cur) {
				if (seen.has(cur.path)) return true;
				seen.add(cur.path);
				cur = parentInList(cur);
			}
			return false;
		};
		for (const r of records) {
			const parent = !inCycle(r) ? parentInList(r) : null;
			if (parent) {
				if (!childrenOf.has(parent.path)) childrenOf.set(parent.path, []);
				childrenOf.get(parent.path)?.push(r);
			} else {
				roots.push(r);
			}
		}
		return { roots, childrenOf };
	}, [plugin.indexer, records, nested]);

	const isCollapsed = (path: string) =>
		collapseOverride.get(path) ?? (childrenOf.get(path)?.length ?? 0) > 5;
	const setAllCollapsed = (value: boolean) =>
		setCollapseOverride(new Map([...childrenOf.keys()].map((p) => [p, value])));
	const toggleCollapsed = (path: string) => {
		const next = new Map(collapseOverride);
		next.set(path, !isCollapsed(path));
		setCollapseOverride(next);
	};

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
			{nested && childrenOf.size > 0 ? (
				<>
					<button onClick={() => setAllCollapsed(true)}>Collapse all</button>
					<button onClick={() => setAllCollapsed(false)}>Expand all</button>
				</>
			) : null}
			<div className="loom-shell-spacer" />
			<button
				className="mod-cta"
				onClick={() =>
					new CreateEntityModal(plugin, type, project, {
						// Open through the view so this list is recorded as the
						// origin — the new entity page's Back returns here.
						onCreated: (file) => view.openEntity(file.path),
					}).open()
				}
			>
				New {ENTITY_META[type].label.toLowerCase()}
			</button>
		</>
	);

	const row = (r: EntityRecord, depth: number) => {
		const hasChildren = nested && (childrenOf.get(r.path)?.length ?? 0) > 0;
		return (
			<div
				key={r.path}
				className={depth > 0 ? 'loom-row loom-row-sub' : 'loom-row'}
				style={depth > 0 ? { paddingLeft: depth * 20 } : undefined}
				onClick={() => view.openEntity(r.path)}
			>
				{/* The caret slot is always reserved in nested mode so names line
				    up on each hierarchy level whether a row can collapse or not. */}
				{nested ? (
					hasChildren ? (
						<button
							className="loom-row-caret"
							aria-label={isCollapsed(r.path) ? 'Expand sublocations' : 'Collapse sublocations'}
							onClick={(e) => {
								e.stopPropagation();
								toggleCollapsed(r.path);
							}}
						>
							<span className={isCollapsed(r.path) ? 'loom-caret' : 'loom-caret loom-caret-open'}>▸</span>
						</button>
					) : (
						<span className="loom-row-caret" aria-hidden="true" />
					)
				) : null}
				<span className="loom-row-name">{recordLabel(r, project)}</span>
				{hasChildren ? (
					<span className="loom-row-count">{childrenOf.get(r.path)?.length}</span>
				) : null}
				{r.loomTags.map((tag) => (
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
						new ConfirmModal(
							plugin.app,
							`Delete "${recordLabel(r, project)}"?`,
							'The note is moved to the trash.',
							() => {
								const file = plugin.app.vault.getFileByPath(r.path);
								if (file) void plugin.app.fileManager.trashFile(file);
							},
							'Delete'
						).open();
					}}
				>
					<Icon name="trash-2" />
				</button>
			</div>
		);
	};

	// Depth-first emit; collapsed parents keep their subtree hidden. Each main
	// location's descendants share one horizontal scroll container, so deep
	// nesting scrolls per subtree instead of the whole list.
	const rows: ReactElement[] = [];
	for (const r of roots) {
		rows.push(row(r, 0));
		if (!nested || isCollapsed(r.path) || (childrenOf.get(r.path)?.length ?? 0) === 0) continue;
		const subRows: ReactElement[] = [];
		const emit = (parent: EntityRecord, depth: number) => {
			for (const child of childrenOf.get(parent.path) ?? []) {
				subRows.push(row(child, depth));
				if (!isCollapsed(child.path)) emit(child, depth + 1);
			}
		};
		emit(r, 1);
		rows.push(
			<div key={r.path + ':subtree'} className="loom-subtree">
				{subRows}
			</div>
		);
	}

	return (
		<ViewShell view={view} project={project} title={ENTITY_META[type].plural} railActive={type} toolbar={toolbar}>
			{records.length === 0 ? (
				<div className="loom-empty">Nothing here yet.</div>
			) : (
				<div className="loom-list">{rows}</div>
			)}
		</ViewShell>
	);
}
