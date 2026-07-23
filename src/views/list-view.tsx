import { Menu, ViewStateResult, normalizePath } from 'obsidian';
import { Fragment, MouseEvent as ReactMouseEvent, ReactElement, useMemo, useState } from 'react';
import {
	ENTITY_META,
	ENTITY_TAGS,
	EntityRecord,
	EntityType,
	FM,
	MAPS_ICON,
	MAPS_LABEL,
	PC_TAG,
	QUEST_OUTCOMES,
	VIEW_LIST,
	VIEW_MAP,
	isEntityType,
	pcGroupStub,
} from '../types';
import {
	AddRelationshipModal,
	AddToHoldersModal,
	ConfirmModal,
	CreateEntityModal,
	RecordSuggestModal,
	TextInputModal,
	copyEntityRecord,
	purgeEntityReferences,
	recordPickLabel,
	renameEntityRecord,
	sessionFileName,
} from '../project';
import { linkTargetOf } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { LoomReactView } from './react-view';
import {
	EntityChip,
	Icon,
	QUEST_TAG_ICONS,
	QuestTagChip,
	SearchableSelect,
	Truncated,
	ViewShell,
	locationLabel,
	noProjectMessage,
	recordDate,
	recordLabel,
} from './common';
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

/** Sentinel path of the synthetic "Unspecified Region" group in the location
 *  list — locations with no region nest under it. */
const UNSPEC_REGION = 'loom:unspecified-region';

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
	/** Flips the active sort's natural direction. */
	const [sortAsc, setSortAsc] = useState(true);
	const [tagFilter, setTagFilter] = useState('');
	/** Quests only: '' = every status, 'active', or a finished outcome. */
	const [questStatus, setQuestStatus] = useState('');
	/** Quests only: rows or the session-page-style card grid. */
	const [questView, setQuestView] = useState<'list' | 'cards'>('list');
	/** Events only: paths of the involved-entity / location filters. */
	const [eventInvolved, setEventInvolved] = useState<string | null>(null);
	const [eventLocation, setEventLocation] = useState<string | null>(null);
	/** Locations only: explicit per-parent collapse choices; parents absent
	 *  here auto-collapse once they hold more than 5 sublocations. */
	const [collapseOverride, setCollapseOverride] = useState<ReadonlyMap<string, boolean>>(new Map());

	const project = resolveProject(plugin.indexer, projectRoot);
	const vocab = ENTITY_TAGS[type];

	// --- Event filter matching (involved incl. group snapshots; a location
	// matches its own events and every descendant's, like location pages). ---
	const locDescendsFrom = (place: EntityRecord, ancestorPath: string): boolean => {
		const seen = new Set<string>();
		let cur: EntityRecord | null = place;
		while (cur && cur.type === 'location' && !seen.has(cur.path)) {
			if (cur.path === ancestorPath) return true;
			seen.add(cur.path);
			cur = cur.parentLocation !== null ? plugin.indexer.resolve(cur.parentLocation, cur.path) : null;
		}
		return false;
	};
	const eventHasInvolved = (r: EntityRecord, path: string) =>
		r.sessionNotes.some((n) =>
			[...n.involved, ...n.group].some((lp) => plugin.indexer.resolve(lp, r.path)?.path === path)
		);
	const eventAtLocation = (r: EntityRecord, path: string) =>
		r.sessionNotes.some((n) =>
			n.places.some((lp) => {
				const place = plugin.indexer.resolve(lp, r.path);
				return place?.type === 'location' && locDescendsFrom(place, path);
			})
		);

	const records = useMemo(() => {
		if (!project) return [];
		const q = query.toLowerCase();
		const dir = sortAsc ? 1 : -1;
		return plugin.indexer
			.getAll(type, project.root)
			.filter(
				(r) =>
					q === '' ||
					recordLabel(r, project).toLowerCase().includes(q) ||
					r.description.toLowerCase().includes(q)
			)
			.filter((r) => tagFilter === '' || r.loomTags.includes(tagFilter))
			.filter(
				(r) =>
					type !== 'quest' ||
					questStatus === '' ||
					(questStatus === 'active' ? r.questOutcome === '' : r.questOutcome === questStatus)
			)
			.filter((r) => type !== 'event' || eventInvolved === null || eventHasInvolved(r, eventInvolved))
			.filter((r) => type !== 'event' || eventLocation === null || eventAtLocation(r, eventLocation))
			.sort((a, b) => dir * compare(a, b, sort));
	}, [plugin.indexer, version, project, type, query, sort, sortAsc, tagFilter, questStatus, eventInvolved, eventLocation]);

	// Locations nest under their parentLocation, items under their original (a
	// character-specific copy under the item it derives from). Searching flattens
	// the list — a match shouldn't hide inside a collapsed parent. Cycles fall
	// back to top level.
	const nested = (type === 'location' || type === 'item') && query === '';
	const parentLinkOf = (r: EntityRecord): string | null =>
		type === 'item' ? r.itemOrigin : r.parentLocation;
	const { roots, childrenOf } = useMemo(() => {
		const childrenOf = new Map<string, EntityRecord[]>();
		const roots: EntityRecord[] = [];
		if (!nested) return { roots: records, childrenOf };
		const byPath = new Map(records.map((r) => [r.path, r]));
		const parentInList = (r: EntityRecord): EntityRecord | null => {
			const link = parentLinkOf(r);
			const parent = link !== null ? plugin.indexer.resolve(link, r.path) : null;
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
		// Sublocation (or item-copy) nesting: children hang under their parent;
		// everything else is a top-level record.
		const topLevel: EntityRecord[] = [];
		for (const r of records) {
			const parent = !inCycle(r) ? parentInList(r) : null;
			if (parent) {
				if (!childrenOf.has(parent.path)) childrenOf.set(parent.path, []);
				childrenOf.get(parent.path)?.push(r);
			} else {
				topLevel.push(r);
			}
		}
		// Locations get an extra top layer: each main location nests under its
		// Region (or "Unspecified Region" when it has none).
		if (type !== 'location' || !project) return { roots: topLevel, childrenOf };
		const groups = new Map<string, { region: EntityRecord | null; mains: EntityRecord[] }>();
		for (const m of topLevel) {
			const reg = m.region ? plugin.indexer.resolve(m.region, m.path) : null;
			const region = reg?.type === 'region' ? reg : null;
			const key = region?.path ?? UNSPEC_REGION;
			if (!groups.has(key)) groups.set(key, { region, mains: [] });
			groups.get(key)?.mains.push(m);
		}
		const realKeys = [...groups.keys()]
			.filter((k) => k !== UNSPEC_REGION)
			.sort((a, b) => (groups.get(a)?.region?.name ?? '').localeCompare(groups.get(b)?.region?.name ?? ''));
		// No region in use yet → keep the plain flat location list (don't wrap
		// everything under a lone "Unspecified Region").
		if (realKeys.length === 0) return { roots: topLevel, childrenOf };
		for (const k of realKeys) {
			const g = groups.get(k);
			if (!g?.region) continue;
			roots.push(g.region);
			childrenOf.set(g.region.path, g.mains);
		}
		const unspec = groups.get(UNSPEC_REGION);
		if (unspec) {
			const stub: EntityRecord = {
				...pcGroupStub(project.root),
				path: UNSPEC_REGION,
				name: 'Unspecified Region',
				type: 'region',
			};
			roots.push(stub);
			childrenOf.set(UNSPEC_REGION, unspec.mains);
		}
		return { roots, childrenOf };
	}, [plugin.indexer, records, nested, type, project]);

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

	// --- Context-menu write helpers (all through the record's frontmatter). ---
	const writeFmOf = (r: EntityRecord, fn: (fm: Record<string, unknown>) => void) => {
		const file = plugin.app.vault.getFileByPath(r.path);
		if (file) void plugin.app.fileManager.processFrontMatter(file, fn);
	};
	const appendFmList = (r: EntityRecord, key: string, value: unknown) =>
		writeFmOf(r, (fm) => {
			const cur = fmLoomValue(fm, key);
			const list = Array.isArray(cur) ? [...(cur as unknown[])] : [];
			list.push(value);
			setLoomKey(fm, key, list);
		});
	const toggleTagOf = (r: EntityRecord, tag: string) =>
		writeFmOf(r, (fm) => {
			const next = r.loomTags.includes(tag)
				? r.loomTags.filter((t) => t !== tag)
				: [...r.loomTags, tag];
			setLoomKey(fm, FM.tags, next);
		});
	const pickLabel = (r: EntityRecord) => recordPickLabel(plugin, project, r);
	/** Involves `r` in the event's first note (its `places` for a location) —
	 *  the list counterpart of the pages' "Add an event…". */
	const involveInEvent = (event: EntityRecord, r: EntityRecord) => {
		const key = r.type === 'location' ? 'places' : 'involved';
		const link = `[[${linkTargetOf(r)}]]`;
		writeFmOf(event, (fm) => {
			const cur = fmLoomValue(fm, FM.sessionNotes);
			const arr = Array.isArray(cur) ? [...(cur as unknown[])] : [];
			if (arr.length === 0) {
				arr.push({ session: '', text: '', seq: Date.now(), [key]: [link] });
			} else {
				const first = arr[0];
				const note: Record<string, unknown> =
					typeof first === 'object' && first !== null
						? { ...(first as Record<string, unknown>) }
						: { session: '', text: typeof first === 'string' ? first : '' };
				const list = Array.isArray(note[key]) ? [...(note[key] as unknown[])] : [];
				list.push(link);
				note[key] = list;
				arr[0] = note;
			}
			setLoomKey(fm, FM.sessionNotes, arr);
		});
	};
	const pickEventFor = (r: EntityRecord) => {
		const already = (ev: EntityRecord) =>
			r.type === 'location' ? eventAtLocation(ev, r.path) : eventHasInvolved(ev, r.path);
		new RecordSuggestModal(
			plugin.app,
			plugin.indexer
				.getAll('event', project.root)
				.filter((ev) => !already(ev))
				.sort((a, b) => a.name.localeCompare(b.name)),
			(ev) => involveInEvent(ev, r),
			'Pick the event…'
		).open();
	};
	const pickSessionNoteFor = (r: EntityRecord) =>
		new RecordSuggestModal(
			plugin.app,
			plugin.indexer
				.getAll('session', project.root)
				.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0)),
			(ses) =>
				appendFmList(r, FM.sessionNotes, {
					session: `[[${linkTargetOf(ses)}]]`,
					text: '',
					seq: Date.now(),
				}),
			'Pick the session…',
			pickLabel
		).open();
	const changeSessionDate = (r: EntityRecord) =>
		new TextInputModal(plugin.app, {
			title: 'Change the date',
			initial: r.date?.raw ?? '',
			placeholder: 'YYYY-MM-DD',
			cta: 'Save',
			onSubmit: (value) => {
				writeFmOf(r, (fm) => setLoomKey(fm, FM.date, value));
				const file = plugin.app.vault.getFileByPath(r.path);
				if (!file || !project) return;
				const base = sessionFileName(project, value);
				const parent = file.parent?.path ?? '';
				const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
				if (newPath !== file.path && !plugin.app.vault.getAbstractFileByPath(newPath)) {
					void plugin.app.fileManager.renameFile(file, newPath);
				}
			},
		}).open();
	/** PCs offered for a session's attendance (dead PCs drop off after their
	 *  death session — mirrors the session page). */
	const sessionPcs = (ses: EntityRecord) =>
		plugin.indexer
			.getAll('character', project.root)
			.filter((c) => c.loomTags.includes(PC_TAG))
			.filter((c) => {
				if (c.alive || !c.deathSession || !ses.date) return true;
				const death = plugin.indexer.resolve(c.deathSession, c.path);
				if (!death || death.type !== 'session' || !death.date) return true;
				return ses.date.sortKey <= death.date.sortKey;
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	const toggleAttendanceOf = (ses: EntityRecord, pc: EntityRecord) => {
		const attends = ses.attendance.some(
			(lp) => plugin.indexer.resolve(lp, ses.path)?.path === pc.path
		);
		const next = attends
			? ses.attendance.filter((lp) => plugin.indexer.resolve(lp, ses.path)?.path !== pc.path)
			: [...ses.attendance, linkTargetOf(pc)];
		writeFmOf(ses, (fm) => setLoomKey(fm, FM.attendance, next.map((n) => `[[${n}]]`)));
	};

	const onRowMenu = (e: ReactMouseEvent, r: EntityRecord) => {
		e.preventDefault();
		// The synthetic "Unspecified Region" group has no note → no menu.
		if (r.path === UNSPEC_REGION) return;
		const menu = new Menu();
		const isItemCopy = r.type === 'item' && r.itemOrigin !== null;

		// General actions (copies derive their name — no rename/copy for them).
		if (r.type !== 'session' && !isItemCopy) {
			menu.addItem((i) =>
				i
					.setTitle('Rename')
					.setIcon('pencil')
					.onClick(() =>
						new TextInputModal(plugin.app, {
							title: `Rename "${r.name}"`,
							initial: r.name,
							cta: 'Rename',
							onSubmit: (v) => void renameEntityRecord(plugin, project, r, v),
						}).open()
					)
			);
		}
		if (!isItemCopy) {
			menu.addItem((i) =>
				i
					.setTitle('Copy')
					.setIcon('copy')
					.onClick(() => void copyEntityRecord(plugin, project, r))
			);
		}
		if (r.type !== 'session') {
			menu.addItem((i) =>
				i
					.setTitle('Add alias')
					.setIcon('at-sign')
					.onClick(() =>
						new TextInputModal(plugin.app, {
							title: `Add alias — ${r.name}`,
							placeholder: 'Alias',
							cta: 'Add',
							onSubmit: (alias) =>
								writeFmOf(r, (fm) => {
									const cur: unknown[] = Array.isArray(fm.aliases)
										? (fm.aliases as unknown[]).filter((a) => a !== alias)
										: [];
									fm.aliases = [...cur, alias];
								}),
						}).open()
					)
			);
		}
		menu.addItem((i) =>
			i
				.setTitle('Add relationship')
				.setIcon('link')
				.onClick(() => new AddRelationshipModal(plugin, project, r).open())
		);

		if (r.type === 'character') {
			menu.addSeparator();
			for (const tag of ENTITY_TAGS.character) {
				menu.addItem((i) =>
					i
						.setTitle(`Tag: ${tag}`)
						.setIcon('tag')
						.setChecked(r.loomTags.includes(tag))
						.onClick(() => toggleTagOf(r, tag))
				);
			}
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add a faction')
					.setIcon(ENTITY_META.faction.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('faction', project.root)
								.filter(
									(f) =>
										!f.members.some(
											(m) => plugin.indexer.resolve(m.linkpath, f.path)?.path === r.path
										)
								)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(faction) => appendFmList(faction, FM.members, `[[${linkTargetOf(r)}]]`),
							'Pick the faction…'
						).open()
					)
			);
			menu.addItem((i) =>
				i.setTitle('Add an event').setIcon(ENTITY_META.event.icon).onClick(() => pickEventFor(r))
			);
			menu.addItem((i) =>
				i
					.setTitle('Add an item')
					.setIcon(ENTITY_META.item.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('item', project.root)
								.filter((it) => it.itemOrigin === null)
								.filter(
									(it) =>
										!r.items.some((lp) => plugin.indexer.resolve(lp, r.path)?.path === it.path)
								)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(it) => appendFmList(r, FM.items, `[[${linkTargetOf(it)}]]`),
							'Pick the item…'
						).open()
					)
			);
		}

		if (r.type === 'location') {
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle('Add an event').setIcon(ENTITY_META.event.icon).onClick(() => pickEventFor(r))
			);
			menu.addItem((i) =>
				i
					.setTitle('Add an item')
					.setIcon(ENTITY_META.item.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('item', project.root)
								.filter((it) => it.itemOrigin === null)
								.filter(
									(it) =>
										!r.items.some((lp) => plugin.indexer.resolve(lp, r.path)?.path === it.path)
								)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(it) => appendFmList(r, FM.items, `[[${linkTargetOf(it)}]]`),
							'Pick the item…'
						).open()
					)
			);
			menu.addItem((i) =>
				i
					.setTitle('Add sublocation')
					.setIcon(ENTITY_META.location.icon)
					.onClick(() =>
						new CreateEntityModal(plugin, 'location', project, {
							parentLocation: r,
							onCreated: () => {},
						}).open()
					)
			);
		}

		if (r.type === 'region') {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add location')
					.setIcon(ENTITY_META.location.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('location', project.root)
								.filter((l) => plugin.indexer.resolve(l.region ?? '', l.path)?.path !== r.path)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(l) => writeFmOf(l, (fm) => setLoomKey(fm, FM.region, `[[${linkTargetOf(r)}]]`)),
							'Pick the location…'
						).open()
					)
			);
			menu.addItem((i) =>
				i
					.setTitle('New location in region')
					.setIcon(ENTITY_META.location.icon)
					.onClick(() =>
						new CreateEntityModal(plugin, 'location', project, {
							region: r,
							onCreated: () => {},
						}).open()
					)
			);
		}

		if (r.type === 'faction') {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add a member')
					.setIcon(ENTITY_META.character.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('character', project.root)
								.filter(
									(c) =>
										!r.members.some(
											(m) => plugin.indexer.resolve(m.linkpath, r.path)?.path === c.path
										)
								)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(c) => appendFmList(r, FM.members, `[[${linkTargetOf(c)}]]`),
							'Pick the character…'
						).open()
					)
			);
			menu.addItem((i) =>
				i.setTitle('Add an event').setIcon(ENTITY_META.event.icon).onClick(() => pickEventFor(r))
			);
		}

		if (r.type === 'item') {
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle('Add an event').setIcon(ENTITY_META.event.icon).onClick(() => pickEventFor(r))
			);
			menu.addItem((i) =>
				i
					.setTitle('Add to character')
					.setIcon(ENTITY_META.character.icon)
					.onClick(() => new AddToHoldersModal(plugin, project, r, 'character').open())
			);
			menu.addItem((i) =>
				i
					.setTitle('Add to location')
					.setIcon(ENTITY_META.location.icon)
					.onClick(() => new AddToHoldersModal(plugin, project, r, 'location').open())
			);
		}

		if (r.type === 'quest') {
			menu.addSeparator();
			for (const tag of ENTITY_TAGS.quest) {
				menu.addItem((i) =>
					i
						.setTitle(`Tag: ${tag}`)
						.setIcon(QUEST_TAG_ICONS[tag] ?? 'tag')
						.setChecked(r.loomTags.includes(tag))
						.onClick(() => toggleTagOf(r, tag))
				);
			}
			menu.addSeparator();
			const setOutcome = (outcome: string) =>
				writeFmOf(r, (fm) => {
					setLoomKey(fm, FM.questOutcome, outcome);
					if (outcome === '') setLoomKey(fm, FM.questOutcomeSession, '');
				});
			menu.addItem((i) =>
				i
					.setTitle('Status: active')
					.setIcon('circle')
					.setChecked(r.questOutcome === '')
					.onClick(() => setOutcome(''))
			);
			for (const outcome of QUEST_OUTCOMES) {
				menu.addItem((i) =>
					i
						.setTitle(`Status: ${outcome}`)
						.setIcon(
							outcome === 'completed' ? 'circle-check' : outcome === 'failed' ? 'circle-x' : 'circle-off'
						)
						.setChecked(r.questOutcome === outcome)
						.onClick(() => setOutcome(outcome))
				);
			}
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add a quest giver')
					.setIcon(ENTITY_META.character.icon)
					.onClick(() =>
						new RecordSuggestModal(
							plugin.app,
							plugin.indexer
								.getAll('character', project.root)
								.filter(
									(c) =>
										!r.questGivers.some(
											(lp) => plugin.indexer.resolve(lp, r.path)?.path === c.path
										)
								)
								.sort((a, b) => a.name.localeCompare(b.name)),
							(c) => appendFmList(r, FM.questGiver, `[[${linkTargetOf(c)}]]`),
							'Pick the character…'
						).open()
					)
			);
			menu.addItem((i) =>
				i
					.setTitle('Add a session note')
					.setIcon(ENTITY_META.session.icon)
					.onClick(() => pickSessionNoteFor(r))
			);
		}

		if (r.type === 'event') {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add a session note')
					.setIcon(ENTITY_META.session.icon)
					.onClick(() => pickSessionNoteFor(r))
			);
			menu.addItem((i) =>
				i
					.setTitle(r.date ? 'Change the date' : 'Add a date')
					.setIcon('calendar')
					.onClick(() =>
						new TextInputModal(plugin.app, {
							title: r.date ? 'Change the date' : 'Add a date',
							initial: r.date?.raw ?? '',
							placeholder: 'YYYY-MM-DD',
							cta: 'Save',
							onSubmit: (value) => writeFmOf(r, (fm) => setLoomKey(fm, FM.date, value)),
						}).open()
					)
			);
		}

		if (r.type === 'session') {
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle('Change the date').setIcon('calendar').onClick(() => changeSessionDate(r))
			);
			const pcs = sessionPcs(r);
			if (pcs.length > 0) menu.addSeparator();
			for (const pc of pcs) {
				menu.addItem((i) =>
					i
						.setTitle(`Attends: ${pc.name}`)
						.setIcon(ENTITY_META.character.icon)
						.setChecked(
							r.attendance.some((lp) => plugin.indexer.resolve(lp, r.path)?.path === pc.path)
						)
						.onClick(() => toggleAttendanceOf(r, pc))
				);
			}
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle('Add an event')
					.setIcon(ENTITY_META.event.icon)
					.onClick(() =>
						new CreateEntityModal(plugin, 'event', project, {
							noteSession: r,
							onCreated: () => {},
						}).open()
					)
			);
			menu.addItem((i) =>
				i
					.setTitle('Add a quest')
					.setIcon(ENTITY_META.quest.icon)
					.onClick(() =>
						new CreateEntityModal(plugin, 'quest', project, {
							noteSession: r,
							onCreated: () => {},
						}).open()
					)
			);
		}

		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Delete')
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() =>
					new ConfirmModal(
						plugin.app,
						`Delete "${recordLabel(r, project)}"?`,
						'The note is moved to the trash.',
						() => {
							const file = plugin.app.vault.getFileByPath(r.path);
							if (!file) return;
							void purgeEntityReferences(plugin, r.path, r.project).finally(() =>
								plugin.app.fileManager.trashFile(file)
							);
						},
						'Delete'
					).open()
				)
		);
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const allCollapsed = [...childrenOf.keys()].every((p) => isCollapsed(p));
	const involvedFilterRecord = eventInvolved !== null ? plugin.indexer.get(eventInvolved) : undefined;
	const locationFilterRecord = eventLocation !== null ? plugin.indexer.get(eventLocation) : undefined;

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
			<button
				className="loom-list-iconbtn"
				aria-label={sortAsc ? 'Ascending — click to reverse' : 'Descending — click to reverse'}
				onClick={() => setSortAsc(!sortAsc)}
			>
				<Icon name={sortAsc ? 'arrow-up-narrow-wide' : 'arrow-down-wide-narrow'} />
			</button>
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
			{type === 'quest' ? (
				<>
					<select
						className="dropdown"
						value={questStatus}
						onChange={(e) => setQuestStatus(e.target.value)}
					>
						<option value="">All statuses</option>
						<option value="active">Active</option>
						{QUEST_OUTCOMES.map((o) => (
							<option key={o} value={o}>
								{o[0].toUpperCase() + o.slice(1)}
							</option>
						))}
					</select>
					<button
						className="loom-list-iconbtn"
						aria-label={questView === 'list' ? 'Card view' : 'List view'}
						onClick={() => setQuestView(questView === 'list' ? 'cards' : 'list')}
					>
						<Icon name={questView === 'list' ? 'layout-grid' : 'list'} />
					</button>
				</>
			) : null}
			{type === 'event' ? (
				<>
					{involvedFilterRecord ? (
						<EntityChip
							plugin={plugin}
							record={involvedFilterRecord}
							onRemove={() => setEventInvolved(null)}
							removeLabel="Clear involved filter"
						/>
					) : (
						<div className="loom-list-filter">
							<SearchableSelect
								placeholder="Involved…"
								options={plugin.indexer
									.getAll(undefined, project.root)
									.filter((c) => c.type !== 'session' && c.type !== 'event' && c.type !== 'location')
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((c) => ({ value: c.path, label: c.name }))}
								onPick={(path) => setEventInvolved(path)}
							/>
						</div>
					)}
					{locationFilterRecord ? (
						<EntityChip
							plugin={plugin}
							record={locationFilterRecord}
							label={locationLabel(locationFilterRecord, plugin)}
							onRemove={() => setEventLocation(null)}
							removeLabel="Clear location filter"
						/>
					) : (
						<div className="loom-list-filter">
							<SearchableSelect
								placeholder="Location…"
								options={plugin.indexer
									.getAll('location', project.root)
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((c) => ({ value: c.path, label: locationLabel(c, plugin) }))}
								onPick={(path) => setEventLocation(path)}
							/>
						</div>
					)}
				</>
			) : null}
			{nested && childrenOf.size > 0 ? (
				<button
					className="loom-list-iconbtn"
					aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
					onClick={() => setAllCollapsed(!allCollapsed)}
				>
					<Icon
						name={allCollapsed ? 'list-chevrons-up-down' : 'list-chevrons-down-up'}
						fallback={allCollapsed ? 'chevrons-up-down' : 'chevrons-down-up'}
					/>
				</button>
			) : null}
			<div className="loom-shell-spacer" />
			{type === 'location' ? (
				<button
					className="loom-rel-filter"
					aria-label={`Open ${MAPS_LABEL}`}
					title={MAPS_LABEL}
					onClick={() => view.navigateTo(VIEW_MAP, { project: project.root })}
				>
					<Icon name={MAPS_ICON} />
				</button>
			) : null}
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
		const isUnspecRegion = r.path === UNSPEC_REGION;
		return (
			<div
				key={r.path}
				className={
					(depth > 0 ? 'loom-row loom-row-sub' : 'loom-row') +
					(r.type === 'region' ? ' loom-row-region' : '')
				}
				onClick={() => {
					if (isUnspecRegion) toggleCollapsed(r.path);
					else view.openEntity(r.path);
				}}
				onContextMenu={(e) => onRowMenu(e, r)}
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
				{(() => {
					// A character-specific item copy carries its owner as a chip.
					const owner =
						r.type === 'item' && r.itemOwner ? plugin.indexer.resolve(r.itemOwner, r.path) : null;
					return owner ? <EntityChip plugin={plugin} record={owner} /> : null;
				})()}
				{r.type === 'quest'
					? r.loomTags.map((tag) => <QuestTagChip key={tag} plugin={plugin} tag={tag} />)
					: r.loomTags.map((tag) => (
							<span key={tag} className="loom-chip">
								{tag}
							</span>
						))}
				{r.date && r.type !== 'session' ? (
					<span className="loom-row-date">{recordDate(r, project)}</span>
				) : null}
				<span className="loom-row-desc">{r.description}</span>
				{isUnspecRegion ? null : (
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
								if (!file) return;
								void purgeEntityReferences(plugin, r.path, r.project).finally(() =>
									plugin.app.fileManager.trashFile(file)
								);
							},
							'Delete'
						).open();
					}}
				>
					<Icon name="trash-2" />
				</button>
				)}
			</div>
		);
	};

	/** Session-page-style quest card (title, giver, received, status, tags). */
	const questCard = (q: EntityRecord) => {
		const givers = q.questGivers
			.map((lp) => plugin.indexer.resolve(lp, q.path))
			.filter((c): c is EntityRecord => c !== null && c.type === 'character');
		const received = q.questReceived !== null ? plugin.indexer.resolve(q.questReceived, q.path) : null;
		const outcomeSes =
			q.questOutcomeSession !== null ? plugin.indexer.resolve(q.questOutcomeSession, q.path) : null;
		return (
			<div key={q.path} className="loom-quest-card" onContextMenu={(e) => onRowMenu(e, q)}>
				<div className="loom-quest-card-titlerow">
					<button className="loom-subloc-link loom-quest-card-title" onClick={() => view.openEntity(q.path)}>
						<Truncated className="loom-clip" text={q.name} />
					</button>
				</div>
				<div className="loom-quest-card-row">
					<span className="loom-quest-card-label">{givers.length > 1 ? 'Quest givers:' : 'Quest giver:'}</span>
					<span className="loom-quest-card-value">
						{givers.length > 0 ? (
							givers.map((g) => (
								<button key={g.path} className="loom-subloc-link" onClick={() => view.openEntity(g.path)}>
									<Truncated className="loom-clip" text={g.name} />
								</button>
							))
						) : (
							<span>—</span>
						)}
					</span>
				</div>
				<div className="loom-quest-card-row">
					<span className="loom-quest-card-label">Received on:</span>
					<span className="loom-quest-card-value">
						{received && received.type === 'session' ? (
							<button className="loom-subloc-link" onClick={() => view.openEntity(received.path)}>
								{recordLabel(received, project)}
							</button>
						) : (
							<span>—</span>
						)}
					</span>
				</div>
				<div className="loom-quest-card-row">
					<span className="loom-quest-card-label">Status:</span>
					<span className="loom-quest-card-value">
						{q.questOutcome === '' ? 'Active' : q.questOutcome[0].toUpperCase() + q.questOutcome.slice(1)}
					</span>
				</div>
				{q.questOutcome !== '' && outcomeSes && outcomeSes.type === 'session' ? (
					<div className="loom-quest-card-row">
						<span className="loom-quest-card-label">Completed on:</span>
						<span className="loom-quest-card-value">
							<button className="loom-subloc-link" onClick={() => view.openEntity(outcomeSes.path)}>
								{recordLabel(outcomeSes, project)}
							</button>
						</span>
					</div>
				) : null}
				{q.loomTags.length > 0 ? (
					<div className="loom-quest-card-row">
						<span className="loom-quest-card-label">{q.loomTags.length > 1 ? 'Tags:' : 'Tag:'}</span>
						<span className="loom-quest-card-value">
							{q.loomTags.map((t) => (
								<QuestTagChip key={t} plugin={plugin} tag={t} />
							))}
						</span>
					</div>
				) : null}
			</div>
		);
	};

	// Each nesting level hangs off its own vertical rail: a `.loom-subtree`
	// wraps a parent's children, and each child with children of its own gets a
	// further nested subtree. The outermost (root) subtree owns the horizontal
	// scroll so deep nesting scrolls as one unit, not the whole list.
	const renderSubtree = (parent: EntityRecord, depth: number, isRoot: boolean): ReactElement | null => {
		if (!nested || isCollapsed(parent.path)) return null;
		const children = childrenOf.get(parent.path) ?? [];
		if (children.length === 0) return null;
		return (
			<div
				key={parent.path + ':subtree'}
				className={isRoot ? 'loom-subtree loom-subtree-root' : 'loom-subtree'}
			>
				{children.map((child) => (
					<Fragment key={child.path}>
						{row(child, depth)}
						{renderSubtree(child, depth + 1, false)}
					</Fragment>
				))}
			</div>
		);
	};
	const rows: ReactElement[] = [];
	for (const r of roots) {
		rows.push(row(r, 0));
		const sub = renderSubtree(r, 1, true);
		if (sub) rows.push(sub);
	}

	return (
		<ViewShell view={view} project={project} title={ENTITY_META[type].plural} railActive={type} toolbar={toolbar}>
			{records.length === 0 ? (
				<div className="loom-empty">Nothing here yet.</div>
			) : type === 'quest' && questView === 'cards' ? (
				<div className="loom-quest-cards loom-list-quest-cards">{records.map((q) => questCard(q))}</div>
			) : (
				<div className="loom-list">{rows}</div>
			)}
		</ViewShell>
	);
}
