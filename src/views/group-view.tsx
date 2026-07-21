import { Menu, ViewStateResult } from 'obsidian';
import { MouseEvent as ReactMouseEvent, ReactElement, useState } from 'react';
import {
	ENTITY_META,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	PC_GROUP_ICON,
	PC_GROUP_NAME,
	PC_TAG,
	VIEW_GROUP,
	pcGroupStub,
} from '../types';
import { formatLoomDateShort, groupNameOf, serializeProjectConfig } from '../calendar';
import { linkTargetOf } from '../indexer';
import { LoomReactView } from './react-view';
import {
	EntityChip,
	Icon,
	NavRail,
	SearchableSelect,
	locationLabel,
	noProjectMessage,
	recordLabel,
} from './common';
import { MarkdownField } from './markdown-field';
import type { LinkOption } from './link-textarea';
import { resolveProject, useIndexVersion } from './hooks';

const MONTH_LABELS = [
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * The virtual Group's page: the player hub, one click away from every page
 * (first rail entry + the home wheel). Mirrors the faction page layout, but
 * it is file-less — the (editable) name lives in the project's .loom config,
 * membership derives from the PC characters' own `alive`/`active` flags, and
 * the Events section lists every event/quest that touched the party: a
 * `group` snapshot on a note OR any PC (alive or not, active or not)
 * involved directly. Search covers event names and note texts; the PC-chip
 * filter narrows to notes involving every selected character (their group
 * snapshots count — a snapshot names exactly who was in the party then).
 */
export class GroupView extends LoomReactView {
	projectRoot: string | null = null;
	/** Where the page was opened from; its Back button returns there. */
	origin: EntityOrigin | null = null;

	getViewType(): string {
		return VIEW_GROUP;
	}

	getDisplayText(): string {
		const project =
			this.projectRoot !== null ? this.plugin.indexer.getProjectByRoot(this.projectRoot) : undefined;
		return project ? groupNameOf(project.config) : PC_GROUP_NAME;
	}

	getIcon(): string {
		return PC_GROUP_ICON;
	}

	getState(): Record<string, unknown> {
		return { project: this.projectRoot, origin: this.origin };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as { project?: unknown; origin?: unknown } | null;
		if (typeof s?.project === 'string') this.projectRoot = s.project;
		// A missing origin keeps the previous one (e.g. re-clicking the rail's
		// own Group entry); a Group origin would make Back a loop — ignored.
		if (
			typeof s?.origin === 'object' &&
			s.origin !== null &&
			(s.origin as EntityOrigin).type !== VIEW_GROUP
		) {
			this.origin = s.origin as EntityOrigin;
		}
		await super.setState(state, result);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <GroupPage key={this.projectRoot ?? ''} view={this} projectRoot={this.projectRoot} />;
	}
}

/** One event/quest note that touched the party (mirror of LocNoteEntry). */
interface GroupNoteEntry {
	owner: EntityRecord;
	session: string | null;
	text: string;
	involved: string[];
	group: string[];
	places: string[];
}

function GroupPage({ view, projectRoot }: { view: GroupView; projectRoot: string | null }) {
	const plugin = view.plugin;
	useIndexVersion(plugin.indexer);
	const [query, setQuery] = useState('');
	/** The filter panel (behind the filter icon). */
	const [filterOpen, setFilterOpen] = useState(false);
	/** Paths of the entities the hub is filtered by (PCs or anything else). */
	const [entityFilter, setEntityFilter] = useState<readonly string[]>([]);
	/** Entity-type filter of the filter panel's own entity search. */
	const [filterType, setFilterType] = useState<EntityType | null>(null);
	/** Selected session months as "year-month" keys (multi, across years). */
	const [monthFilter, setMonthFilter] = useState<readonly string[]>([]);
	/** Year the month grid currently shows; null = latest session year. */
	const [filterYear, setFilterYear] = useState<number | null>(null);
	const project = resolveProject(plugin.indexer, projectRoot);
	if (!project) return <>{noProjectMessage()}</>;

	const groupName = groupNameOf(project.config);
	const pcs = plugin.indexer
		.getAll('character', project.root)
		.filter((c) => c.loomTags.includes(PC_TAG))
		.sort((a, b) => a.name.localeCompare(b.name));
	const aliveActive = pcs.filter((c) => c.alive && c.active);
	const inactive = pcs.filter((c) => c.alive && !c.active);
	const dead = pcs.filter((c) => !c.alive);
	const pcPaths = new Set(pcs.map((c) => c.path));

	/** Writes the custom group name into the .loom config ('' = default). */
	const commitGroupName = (entered: string) => {
		const trimmed = entered.trim();
		if (trimmed === groupName) return;
		const file = plugin.app.vault.getFileByPath(project.loomPath);
		if (!file) return;
		void plugin.app.vault.process(file, () =>
			serializeProjectConfig({
				...project.config,
				groupName: trimmed === PC_GROUP_NAME ? '' : trimmed,
			})
		);
	};

	// The player hub: one entry per note carrying a group snapshot or a
	// directly involved PC, filtered by the search (event name OR note text),
	// the entity filter (every selected entity must be on the note — involved,
	// inside its group snapshot, or among its places) and the session-month
	// filter, then grouped/sorted exactly like the entity pages' Events
	// section (session groups by date, entries by loomSeq).
	const entryHasEntity = (en: GroupNoteEntry, path: string) =>
		[...en.involved, ...en.group, ...en.places].some(
			(lp) => plugin.indexer.resolve(lp, en.owner.path)?.path === path
		);
	const entrySession = (en: GroupNoteEntry): EntityRecord | null => {
		const ses = en.session !== null ? plugin.indexer.resolve(en.session, en.owner.path) : null;
		return ses?.type === 'session' ? ses : null;
	};
	const matchesMonths = (en: GroupNoteEntry) => {
		if (monthFilter.length === 0) return true;
		const d = entrySession(en)?.date;
		return d != null && monthFilter.includes(`${d.year}-${d.month}`);
	};
	const q = query.trim().toLowerCase();
	const entries: GroupNoteEntry[] = plugin.indexer
		.getAll(undefined, project.root)
		.filter((r) => r.type === 'event' || r.type === 'quest')
		.flatMap((owner) =>
			owner.sessionNotes
				.map((n) => ({
					owner,
					session: n.session,
					text: n.text,
					involved: n.involved,
					group: n.group,
					places: n.places,
				}))
				.filter(
					(e) =>
						e.group.length > 0 ||
						e.involved.some((lp) => {
							const inv = plugin.indexer.resolve(lp, owner.path);
							return inv !== null && pcPaths.has(inv.path);
						})
				)
		)
		.filter(
			(e) =>
				q === '' || e.owner.name.toLowerCase().includes(q) || e.text.toLowerCase().includes(q)
		)
		.filter((e) => entityFilter.every((p) => entryHasEntity(e, p)))
		.filter(matchesMonths);
	const newestFirst = plugin.settings.notesNewestFirst;
	const groups = (() => {
		const map = new Map<string, { session: EntityRecord | null; entries: GroupNoteEntry[] }>();
		for (const e of entries) {
			const ses = e.session !== null ? plugin.indexer.resolve(e.session, e.owner.path) : null;
			const session = ses?.type === 'session' ? ses : null;
			const key = session?.path ?? 'none';
			if (!map.has(key)) map.set(key, { session, entries: [] });
			map.get(key)?.entries.push(e);
		}
		for (const g of map.values())
			g.entries.sort((a, b) => (a.owner.seq ?? a.owner.created) - (b.owner.seq ?? b.owner.created));
		return [...map.values()].sort((a, b) => {
			const ka = a.session?.date?.sortKey;
			const kb = b.session?.date?.sortKey;
			if (ka === undefined && kb === undefined) return 0;
			if (ka === undefined) return 1; // lore last
			if (kb === undefined) return -1;
			return newestFirst ? kb - ka : ka - kb;
		});
	})();

	const shortSessionLabel = (s: EntityRecord) =>
		s.date ? formatLoomDateShort(s.date, project.config) : s.name;

	const toggleNotesOrder = () => {
		plugin.settings.notesNewestFirst = !plugin.settings.notesNewestFirst;
		void plugin.saveSettings();
		plugin.indexer.refreshViews();
	};

	const toggleEntityFilter = (path: string) =>
		setEntityFilter(
			entityFilter.includes(path) ? entityFilter.filter((p) => p !== path) : [...entityFilter, path]
		);
	const toggleMonth = (key: string) =>
		setMonthFilter(
			monthFilter.includes(key) ? monthFilter.filter((m) => m !== key) : [...monthFilter, key]
		);
	// Sessions are always Gregorian; the month grid navigates the years that
	// actually hold dated sessions (falling back to the current year).
	const sessionYears = [
		...new Set(
			plugin.indexer
				.getAll('session', project.root)
				.map((s) => s.date?.year)
				.filter((y): y is number => y !== undefined)
		),
	].sort((a, b) => a - b);
	const shownYear =
		filterYear ??
		(sessionYears.length > 0 ? sessionYears[sessionYears.length - 1] : new Date().getFullYear());
	const filtersActive = entityFilter.length > 0 || monthFilter.length > 0;
	/** Non-PC entities picked in the filter search (PCs show as quick chips). */
	const pickedOthers = entityFilter
		.filter((p) => !pcPaths.has(p))
		.map((p) => plugin.indexer.get(p))
		.filter((r): r is EntityRecord => r !== undefined);
	const openFilterTypeMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('All entities')
				.setIcon('filter')
				.setChecked(filterType === null)
				.onClick(() => setFilterType(null))
		);
		for (const t of ENTITY_TYPES.filter((t) => t !== 'session' && t !== 'event')) {
			menu.addItem((item) =>
				item
					.setTitle(ENTITY_META[t].plural)
					.setIcon(ENTITY_META[t].icon)
					.setChecked(filterType === t)
					.onClick(() => setFilterType(t))
			);
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};

	// Note texts render with the shared live-preview field (read-only): links,
	// bold/italic, bullets — the same formatting the editors show.
	const linkNames: LinkOption[] = plugin.indexer
		.getAll(undefined, project.root)
		.map((r) => {
			const target = linkTargetOf(r);
			const label = r.type === 'session' ? recordLabel(r, project) : r.name;
			return { label, insert: target === label ? label : `${target}|${label}` };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
	const openLinkFrom =
		(ownerPath: string) =>
		(target: string, newTab = false) => {
			const resolved = plugin.indexer.resolve(target, ownerPath);
			if (resolved) view.openEntity(resolved.path, newTab);
			else void plugin.app.workspace.openLinkText(target, ownerPath, newTab ? 'tab' : false);
		};

	const chipRow = (records: EntityRecord[]) => (
		<div className="loom-tag-row">
			{records.map((c) => (
				<EntityChip key={c.path} plugin={plugin} record={c} onOpen={() => view.openEntity(c.path)} />
			))}
		</div>
	);

	/** Read-only mirror of the entity pages' event rows: same classes, chips
	 *  instead of pickers — editing happens on the event page (name links). */
	const entryRow = (en: GroupNoteEntry, i: number) => {
		const involved = en.involved
			.map((lp) => ({ lp, target: plugin.indexer.resolve(lp, en.owner.path) }))
			.sort(
				(a, b) =>
					(a.target ? ENTITY_TYPES.indexOf(a.target.type) : 99) -
						(b.target ? ENTITY_TYPES.indexOf(b.target.type) : 99) ||
					(a.target?.name ?? a.lp).localeCompare(b.target?.name ?? b.lp)
			);
		const places = en.places
			.map((lp) => ({ lp, target: plugin.indexer.resolve(lp, en.owner.path) }))
			.filter((p) => p.target?.type === 'location');
		return (
			<div key={en.owner.path + String(i)} className="loom-locnote">
				<div className="loom-locnote-body">
					<div className="loom-locnote-head">
						<button
							className="loom-hub-name loom-hub-name-static loom-hub-name-link"
							onClick={() => view.openEntity(en.owner.path)}
						>
							{en.owner.name}
						</button>
						<div className="loom-shell-spacer" />
					</div>
					{involved.length > 0 || en.group.length > 0 || places.length > 0 ? (
						<div className="loom-tag-row">
							{en.group.length > 0 ? (
								<EntityChip
									plugin={plugin}
									record={pcGroupStub(project.root, groupName)}
									label={groupName}
								/>
							) : null}
							{involved.map(({ lp, target }, ii) => (
								<EntityChip
									key={lp + String(ii)}
									plugin={plugin}
									record={target}
									label={target?.name ?? lp}
									onOpen={target ? () => view.openEntity(target.path) : undefined}
								/>
							))}
							{places.map(({ lp, target }, ii) => (
								<EntityChip
									key={'p' + lp + String(ii)}
									plugin={plugin}
									record={target}
									label={target?.name ?? lp}
									onOpen={target ? () => view.openEntity(target.path) : undefined}
								/>
							))}
						</div>
					) : null}
					{en.text.trim() !== '' ? (
						<div className="loom-note-text">
							<MarkdownField
								app={plugin.app}
								value={en.text}
								names={linkNames}
								onOpenLink={openLinkFrom(en.owner.path)}
								onChange={() => undefined}
								readOnly
							/>
						</div>
					) : null}
				</div>
			</div>
		);
	};

	return (
		<div className="loom-entity-row">
			<NavRail navigator={view} project={project} active="group" />
			<div className="loom-entity">
				<div className="loom-entity-header">
					<button
						className="loom-nav-btn"
						disabled={!view.origin}
						onClick={() => {
							const origin = view.origin;
							if (origin) view.navigateTo(origin.type, origin.state);
						}}
					>
						← Back
					</button>
					<span
						className="loom-chip"
						style={{
							background: plugin.settings.groupColor + '40',
							border: `1px solid ${plugin.settings.groupColor}`,
						}}
					>
						{groupName}
					</span>
					<div className="loom-shell-spacer" />
				</div>

				<div className="loom-field">
					<span className="loom-field-label">Name</span>
					<input
						type="text"
						key={groupName}
						defaultValue={groupName}
						onBlur={(e) => commitGroupName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') commitGroupName(e.currentTarget.value);
						}}
					/>
				</div>

				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Members</span>
					<span className="loom-field-label loom-group-sublabel">Alive</span>
					{aliveActive.length > 0 ? (
						chipRow(aliveActive)
					) : (
						<div className="loom-empty">No active player characters (tag a character PC).</div>
					)}
					{inactive.length > 0 ? (
						<>
							<span className="loom-field-label loom-group-sublabel">Inactive</span>
							{chipRow(inactive)}
						</>
					) : null}
					{dead.length > 0 ? (
						<>
							<span className="loom-field-label loom-group-sublabel">Dead</span>
							{dead.map((c) => {
								const death =
									c.deathSession !== null ? plugin.indexer.resolve(c.deathSession, c.path) : null;
								return (
									<div key={c.path} className="loom-tag-row">
										<EntityChip
											plugin={plugin}
											record={c}
											onOpen={() => view.openEntity(c.path)}
										/>
										{death && death.type === 'session' ? (
											<EntityChip
												plugin={plugin}
												record={death}
												label={shortSessionLabel(death)}
												onOpen={() => view.openEntity(death.path)}
											/>
										) : null}
									</div>
								);
							})}
						</>
					) : null}
				</div>

				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Events</span>
					<div className="loom-hub-add-row">
						<input
							type="text"
							className="loom-search"
							placeholder="Search events and notes…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						<button
							className={
								filterOpen || filtersActive
									? 'loom-rel-filter loom-group-filter-btn loom-group-filter-btn-on'
									: 'loom-rel-filter loom-group-filter-btn'
							}
							aria-label="Filter the events"
							onClick={() => setFilterOpen(!filterOpen)}
						>
							<Icon name="filter" />
						</button>
						<button className="loom-rel-add loom-order-toggle" onClick={toggleNotesOrder}>
							<Icon name={newestFirst ? 'arrow-up-wide-narrow' : 'arrow-down-narrow-wide'} />
							{newestFirst ? 'New on top' : 'New on bottom'}
						</button>
					</div>
					{filterOpen ? (
						<div className="loom-group-filter">
							{pcs.length > 0 ? (
								<>
									<span className="loom-field-label loom-group-sublabel">Player characters</span>
									<div className="loom-tag-row">
										{pcs.map((c) => {
											const on = entityFilter.includes(c.path);
											return (
												<button
													key={c.path}
													className={
														on
															? 'loom-chip loom-session-chip loom-entity-chip'
															: 'loom-chip loom-session-chip loom-entity-chip loom-chip-filter-off'
													}
													style={
														on
															? {
																	background: plugin.settings.nodeColors.character + '40',
																	borderColor: plugin.settings.nodeColors.character,
																}
															: undefined
													}
													onClick={() => toggleEntityFilter(c.path)}
												>
													{c.name}
												</button>
											);
										})}
									</div>
								</>
							) : null}
							<span className="loom-field-label loom-group-sublabel">Any entity</span>
							<div className="loom-hub-involve">
								<SearchableSelect
									placeholder="Filter by entity…"
									options={plugin.indexer
										.getAll(undefined, project.root)
										.filter((r) => r.type !== 'session' && r.type !== 'event')
										.filter((r) => filterType === null || r.type === filterType)
										.filter((r) => !entityFilter.includes(r.path))
										.sort((a, b) => a.name.localeCompare(b.name))
										.map((r) => ({ value: r.path, label: locationLabel(r, plugin) }))}
									onPick={(path) => toggleEntityFilter(path)}
								/>
								<button
									className="loom-rel-filter"
									aria-label="Filter suggestions by entity type"
									onClick={openFilterTypeMenu}
								>
									<Icon name={filterType ? ENTITY_META[filterType].icon : 'filter'} />
								</button>
							</div>
							{pickedOthers.length > 0 ? (
								<div className="loom-tag-row">
									{pickedOthers.map((r) => (
										<EntityChip
											key={r.path}
											plugin={plugin}
											record={r}
											label={locationLabel(r, plugin)}
											onOpen={() => view.openEntity(r.path)}
											onRemove={() => toggleEntityFilter(r.path)}
											removeLabel="Remove from the filter"
										/>
									))}
								</div>
							) : null}
							<span className="loom-field-label loom-group-sublabel">Session months</span>
							<div className="loom-group-months">
								<div className="loom-group-year">
									<button
										className="loom-nav-btn"
										aria-label="Previous year"
										onClick={() => setFilterYear(shownYear - 1)}
									>
										‹
									</button>
									<span className="loom-group-year-label">{shownYear}</span>
									<button
										className="loom-nav-btn"
										aria-label="Next year"
										onClick={() => setFilterYear(shownYear + 1)}
									>
										›
									</button>
								</div>
								<div className="loom-month-grid">
									{MONTH_LABELS.map((label, m) => {
										const key = `${shownYear}-${m + 1}`;
										const on = monthFilter.includes(key);
										return (
											<button
												key={key}
												className={on ? 'loom-month-btn loom-month-btn-on' : 'loom-month-btn'}
												onClick={() => toggleMonth(key)}
											>
												{label}
											</button>
										);
									})}
								</div>
							</div>
							<div className="loom-group-filter-actions">
								<button
									className="loom-rel-add"
									disabled={!filtersActive}
									onClick={() => {
										setEntityFilter([]);
										setMonthFilter([]);
										setFilterType(null);
										setFilterYear(null);
									}}
								>
									<Icon name="rotate-ccw" />
									Reset filters
								</button>
							</div>
						</div>
					) : null}
					{groups.map((g) => (
						<div
							key={g.session?.path ?? 'none'}
							className="loom-locnote-group loom-char-event-group"
						>
							<div className="loom-tag-row loom-event-group-session">
								{g.session ? (
									<EntityChip
										plugin={plugin}
										record={g.session}
										label={shortSessionLabel(g.session)}
										onOpen={() => g.session && view.openEntity(g.session.path)}
									/>
								) : (
									<EntityChip plugin={plugin} record={null} label="No session" />
								)}
							</div>
							<div className="loom-event-nest">{g.entries.map((en, i) => entryRow(en, i))}</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
