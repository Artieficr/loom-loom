import { Menu, Notice, TFile, ViewStateResult, normalizePath } from 'obsidian';
import {
	MouseEvent as ReactMouseEvent,
	ReactElement,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	PC_TAG,
	VIEW_ENTITY,
	VIEW_LIST,
} from '../types';
import {
	ConfirmModal,
	CreateEntityModal,
	EntityTypeSuggestModal,
	sanitizeFileName,
	sessionFileName,
} from '../project';
import { todayRaw } from '../calendar';
import { LoomFileReactView } from './react-view';
import {
	FRONTMATTER_RE,
	Icon,
	NavRail,
	SearchableSelect,
	startTextareaResize,
	SuggestInput,
	recordLabel,
	useBoxSizeMemory,
} from './common';
import { ConnectedEntities } from './connected-entities';
import { LinkTextarea } from './link-textarea';
import { useIndexVersion } from './hooks';
import type LoomLoomPlugin from '../main';


/**
 * Entity page: a structured form over an entity's .md file, opened by every
 * loom-internal click. The file stays a normal markdown note — opening it
 * from the file explorer still gives the raw editor, and [[wikilinks]] typed
 * in any field connect exactly like links in any other note.
 */
export class EntityView extends LoomFileReactView {
	/** The view this entity page was opened from; Back returns there. */
	origin: EntityOrigin | null = null;

	getViewType(): string {
		return VIEW_ENTITY;
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), origin: this.origin };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const origin = (state as { origin?: unknown } | null)?.origin;
		if (
			typeof origin === 'object' &&
			origin !== null &&
			typeof (origin as EntityOrigin).type === 'string'
		) {
			this.origin = origin as EntityOrigin;
		}
		await super.setState(state, result);
		this.renderNow();
	}

	getDisplayText(): string {
		if (!this.file) return 'Entity';
		const record = this.plugin.indexer.get(this.file.path);
		if (!record) return this.file.basename;
		const project = this.plugin.indexer.getProjectByRoot(record.project) ?? null;
		return recordLabel(record, project);
	}

	getIcon(): string {
		const record = this.file ? this.plugin.indexer.get(this.file.path) : undefined;
		return record ? ENTITY_META[record.type].icon : 'file';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === 'md';
	}

	async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <EntityPage key={this.file?.path ?? ''} view={this} />;
	}
}

function useFrontmatterWriter(plugin: LoomLoomPlugin, file: TFile | null) {
	return useMemo(
		() => (apply: (fm: Record<string, unknown>) => void) => {
			if (!file) return;
			plugin.app.fileManager.processFrontMatter(file, apply).catch((e) => {
				console.error('Loom Loom: failed to update frontmatter', e);
				new Notice('Could not save the change.');
			});
		},
		[plugin, file]
	);
}

/**
 * Sets a frontmatter key, first removing other casings of it — Obsidian's
 * Properties UI treats names case-insensitively and may have rewritten ours —
 * plus any listed legacy keys.
 */
function setFmKey(fm: Record<string, unknown>, key: string, value: unknown, legacy: string[] = []) {
	const lowers = new Set([key, ...legacy].map((k) => k.toLowerCase()));
	for (const k of Object.keys(fm)) {
		if (k !== key && lowers.has(k.toLowerCase())) delete fm[k];
	}
	fm[key] = value;
}

interface RelationshipDraft {
	type: string;
	target: string;
	/** Transient, never written: narrows the target autocomplete to one entity type. */
	filter?: EntityType | null;
}

function EntityPage({ view }: { view: EntityView }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const file = view.file;
	const record = file ? plugin.indexer.get(file.path) : undefined;
	const project = record ? plugin.indexer.getProjectByRoot(record.project) ?? null : null;
	const writeFm = useFrontmatterWriter(plugin, file);

	// Drafts are seeded once per file (component is keyed by path) so index
	// updates triggered by our own saves never clobber what's being typed.
	const [name, setName] = useState(record?.name ?? '');
	const [description, setDescription] = useState(record?.description ?? '');
	const descriptionRef = useRef<HTMLTextAreaElement>(null);
	const notesRef = useRef<HTMLTextAreaElement | null>(null);
	useBoxSizeMemory(plugin, file?.path ?? '', 'description', descriptionRef, !!record);
	useBoxSizeMemory(plugin, file?.path ?? '', 'notes', notesRef, !!record);
	const [role, setRole] = useState(record?.role ?? '');
	const [date, setDate] = useState(record?.date?.raw ?? '');
	const [relationships, setRelationships] = useState<RelationshipDraft[]>(
		record?.relationships.map((r) => ({ type: r.type, target: r.linkpath })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);

	// A freshly created note opens before metadataCache has indexed it, so the
	// record can arrive one tick after mount — seed the drafts then.
	const seeded = useRef(record !== undefined);
	useEffect(() => {
		if (!record || seeded.current) return;
		seeded.current = true;
		setName(record.name);
		setDescription(record.description);
		setRole(record.role);
		setDate(record.date?.raw ?? '');
		setRelationships(record.relationships.map((r) => ({ type: r.type, target: r.linkpath })));
	}, [record]);

	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		void plugin.app.vault.cachedRead(file).then((data) => {
			if (!cancelled) setBody(data.replace(FRONTMATTER_RE, ''));
		});
		return () => {
			cancelled = true;
		};
	}, [plugin, file]);

	// Project entities first (alphabetical), then the rest of the vault.
	const linkNames = useMemo(() => {
		const entityNames = record
			? plugin.indexer
					.getAll(undefined, record.project)
					.map((r) => r.name)
					.sort((a, b) => a.localeCompare(b))
			: [];
		const seen = new Set(entityNames);
		const rest = plugin.app.vault
			.getMarkdownFiles()
			.map((f) => f.basename)
			.filter((n) => !seen.has(n));
		return [...entityNames, ...rest];
	}, [plugin, record, version]);

	const saveBody = useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				void plugin.app.vault.process(file, (data) => {
					const m = FRONTMATTER_RE.exec(data);
					return (m ? m[0] : '') + value;
				});
			}, 600);
		};
	}, [plugin, file]);

	if (!file || !record) {
		return (
			<div className="loom-entity loom-empty">
				<p>Loading… If this note is not a Loom Loom entity (no `type` frontmatter), it has no entity page.</p>
				<button onClick={() => view.navigateTo('markdown', { file: file?.path })}>Open as markdown</button>
			</div>
		);
	}

	const isSession = record.type === 'session';
	const vocab = ENTITY_TAGS[record.type];
	const allTags = [...new Set([...vocab, ...record.loomTags])];
	const sessions = project ? plugin.indexer.getAll('session', project.root) : [];
	const linkedSessions = plugin.indexer.resolveLinkedSessions(record);
	const targetRecords = project ? plugin.indexer.getAll(undefined, project.root) : [];

	const commitName = async () => {
		const base = sanitizeFileName(name);
		if (base === '' || base === record.name) {
			setName(record.name);
			return;
		}
		const parent = file.parent?.path ?? '';
		const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
		if (plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice('A note with that name already exists.');
			setName(record.name);
			return;
		}
		await plugin.app.fileManager.renameFile(file, newPath);
	};

	const commitDate = async (raw: string = date) => {
		const value = raw.trim();
		writeFm((fm) => {
			fm.date = value;
		});
		if (isSession && project && value !== '') {
			const base = sessionFileName(project, value);
			const parent = file.parent?.path ?? '';
			const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			if (newPath !== file.path && !plugin.app.vault.getAbstractFileByPath(newPath)) {
				await plugin.app.fileManager.renameFile(file, newPath);
			}
		}
	};

	const commitRelationships = (next: RelationshipDraft[]) => {
		setRelationships(next);
		writeFm((fm) => {
			fm.relationships = next
				.filter((r) => r.target.trim() !== '')
				.map((r) => ({ type: r.type.trim() === '' ? 'related' : r.type.trim(), target: `[[${r.target.trim()}]]` }));
		});
	};

	const writeLinkedSessions = (names: string[]) => {
		writeFm((fm) => {
			setFmKey(fm, 'linkedSession', names.map((n) => `[[${n}]]`));
		});
	};

	// Session attendance: PC characters offered as toggle chips. A PC who died
	// in an earlier session is no longer offered in sessions after it.
	const attendancePcs = isSession
		? plugin.indexer
				.getAll('character', record.project)
				.filter((c) => c.loomTags.includes(PC_TAG))
				.filter((c) => {
					if (c.alive || !c.deathSession || !record.date) return true;
					const death = plugin.indexer.resolve(c.deathSession, c.path);
					if (!death || death.type !== 'session' || !death.date) return true;
					return record.date.sortKey <= death.date.sortKey;
				})
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];
	const attendingPaths = new Set(
		record.attendance
			.map((lp) => plugin.indexer.resolve(lp, record.path)?.path)
			.filter((p): p is string => p !== undefined)
	);
	const toggleAttendance = (c: EntityRecord) => {
		const next = attendingPaths.has(c.path)
			? record.attendance.filter((lp) => plugin.indexer.resolve(lp, record.path)?.path !== c.path)
			: [...record.attendance, c.name];
		writeFm((fm) => {
			setFmKey(fm, 'attendance', next.map((n) => `[[${n}]]`));
		});
	};

	// PC life state: unticking Alive reveals the death-session picker.
	const isPc = record.type === 'character' && record.loomTags.includes(PC_TAG);
	const deathSession =
		record.deathSession !== null ? plugin.indexer.resolve(record.deathSession, record.path) : null;
	const clearDeathKey = (fm: Record<string, unknown>) => {
		for (const k of Object.keys(fm)) {
			if (k.toLowerCase() === 'deathsession') delete fm[k];
		}
	};
	const setAlive = (alive: boolean) => {
		writeFm((fm) => {
			setFmKey(fm, 'alive', alive);
			if (alive) clearDeathKey(fm);
		});
	};
	const setDeathSession = (sessionName: string | null) => {
		writeFm((fm) => {
			if (sessionName === null) clearDeathKey(fm);
			else setFmKey(fm, 'deathSession', `[[${sessionName}]]`);
		});
	};

	const toggleTag = (tag: string) => {
		const next = record.loomTags.includes(tag)
			? record.loomTags.filter((t) => t !== tag)
			: [...record.loomTags, tag];
		writeFm((fm) => {
			// Also migrates notes still carrying the key's pre-rename spelling.
			setFmKey(fm, 'loomTags', next, ['pluginTags']);
		});
	};

	// Relationship rows group under a subheader per target entity type; targets
	// that don't resolve to a project entity (including still-empty new rows)
	// stay at the bottom, ungrouped. A subheader only exists once it has rows.
	const relEntries = relationships.map((rel, i) => ({
		rel,
		i,
		entityType:
			rel.target.trim() === ''
				? null
				: plugin.indexer.resolve(rel.target.trim(), record.path)?.type ?? null,
	}));

	const setRowFilter = (i: number, filter: EntityType | null) => {
		const next = [...relationships];
		next[i] = { ...next[i], filter };
		setRelationships(next);
	};

	const openRelFilterMenu = (e: ReactMouseEvent<HTMLButtonElement>, i: number) => {
		const current = relationships[i]?.filter ?? null;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('All entities')
				.setIcon('filter')
				.setChecked(current === null)
				.onClick(() => setRowFilter(i, null))
		);
		for (const t of ENTITY_TYPES) {
			menu.addItem((item) =>
				item
					.setTitle(ENTITY_META[t].plural)
					.setIcon(ENTITY_META[t].icon)
					.setChecked(current === t)
					.onClick(() => setRowFilter(i, t))
			);
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const relRow = (rel: RelationshipDraft, i: number) => (
		<div key={i} className="loom-rel-row">
			<input
				type="text"
				className="loom-rel-type"
				placeholder="Identifier"
				value={rel.type}
				onChange={(e) => {
					const next = [...relationships];
					next[i] = { ...rel, type: e.target.value };
					setRelationships(next);
				}}
				onBlur={() => commitRelationships(relationships)}
			/>
			<button
				className="loom-rel-filter"
				aria-label="Filter suggestions by entity type"
				onClick={(e) => openRelFilterMenu(e, i)}
			>
				<Icon name={rel.filter ? ENTITY_META[rel.filter].icon : 'filter'} />
			</button>
			<SuggestInput
				className="loom-rel-target"
				placeholder={rel.filter ? `${ENTITY_META[rel.filter].label} note` : 'Target note'}
				value={rel.target}
				options={targetRecords
					.filter((r) => !rel.filter || r.type === rel.filter)
					.map((r) => r.name)
					.sort((a, b) => a.localeCompare(b))}
				onChange={(v) => {
					const next = [...relationships];
					next[i] = { ...rel, target: v };
					setRelationships(next);
				}}
				onPick={(v) => {
					const next = [...relationships];
					next[i] = { ...rel, target: v };
					commitRelationships(next);
				}}
				onBlur={() => commitRelationships(relationships)}
				action={
					project
						? {
								label: '+ Create entity…',
								onPick: () =>
									new EntityTypeSuggestModal(plugin, (type) =>
										new CreateEntityModal(plugin, type, project, {
											onCreated: (created) => {
												const next = [...relationships];
												next[i] = { ...rel, target: created.basename };
												commitRelationships(next);
											},
										}).open()
									).open(),
							}
						: undefined
				}
			/>
			<button
				className="loom-nav-btn"
				aria-label="Remove relationship"
				onClick={() => commitRelationships(relationships.filter((_, j) => j !== i))}
			>
				✕
			</button>
		</div>
	);

	return (
		<div className="loom-entity-row">
			{project ? <NavRail navigator={view} project={project} /> : null}
			<div className="loom-entity">
			<div className="loom-entity-header">
				{/* Greyed out when there is nowhere to return (e.g. the page
				    was opened right after creating the entity). */}
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
				<span className="loom-chip">{ENTITY_META[record.type].label}</span>
				<div className="loom-shell-spacer" />
				<button
					className="loom-nav-btn"
					onClick={() => view.navigateTo('markdown', { file: file.path })}
				>
					Open as markdown
				</button>
				<button
					className="loom-nav-btn loom-entity-delete"
					aria-label="Delete"
					onClick={() =>
						new ConfirmModal(
							plugin.app,
							`Delete "${recordLabel(record, project)}"?`,
							'The note is moved to the trash.',
							() => {
								// Leave the page first so the view never sits on a
								// trashed file, then delete.
								const origin = view.origin;
								if (origin) view.navigateTo(origin.type, origin.state);
								else if (project) {
									view.navigateTo(VIEW_LIST, { project: project.root, entityType: record.type });
								}
								void plugin.app.fileManager.trashFile(file);
							},
							'Delete'
						).open()
					}
				>
					<Icon name="trash-2" />
				</button>
			</div>

			{!isSession ? (
				<label className="loom-field">
					<span className="loom-field-label">Name</span>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => void commitName()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitName();
						}}
					/>
				</label>
			) : null}

			{isSession ? (
				<label className="loom-field">
					<span className="loom-field-label">Date</span>
					<input
						type="date"
						value={date}
						onChange={(e) => {
							setDate(e.target.value);
							void commitDate(e.target.value);
						}}
					/>
				</label>
			) : null}

			{record.type === 'event' ? (
				<label className="loom-field">
					<span className="loom-field-label">Date</span>
					<input
						type="text"
						placeholder="Not specified"
						value={date}
						onChange={(e) => setDate(e.target.value)}
						onBlur={() => void commitDate()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitDate();
						}}
					/>
					<span
						className="loom-today-link"
						role="button"
						tabIndex={0}
						onClick={() => {
							const today = todayRaw();
							setDate(today);
							void commitDate(today);
						}}
						onKeyDown={(e) => {
							if (e.key !== 'Enter' && e.key !== ' ') return;
							e.preventDefault();
							const today = todayRaw();
							setDate(today);
							void commitDate(today);
						}}
					>
						@today
					</span>
				</label>
			) : null}

			{isSession ? (
				<div className="loom-field">
					<span className="loom-field-label">Attendance</span>
					{attendancePcs.length > 0 ? (
						<div className="loom-tag-row">
							{attendancePcs.map((c) => (
								<button
									key={c.path}
									className={attendingPaths.has(c.path) ? 'loom-chip loom-chip-on' : 'loom-chip'}
									onClick={() => toggleAttendance(c)}
								>
									{c.name}
								</button>
							))}
						</div>
					) : (
						<div className="loom-attendance-empty">No PC characters in this project yet.</div>
					)}
				</div>
			) : null}

			{record.type === 'event' ? (
				<div className="loom-field">
					<span className="loom-field-label">Linked sessions</span>
					{linkedSessions.length > 0 ? (
						<div className="loom-tag-row">
							{linkedSessions.map((s) => (
								<span key={s.path} className="loom-chip loom-session-chip">
									{recordLabel(s, project)}
									<button
										className="loom-chip-remove"
										aria-label="Unlink session"
										onClick={() =>
											writeLinkedSessions(
												linkedSessions.filter((o) => o.path !== s.path).map((o) => o.name)
											)
										}
									>
										✕
									</button>
								</span>
							))}
						</div>
					) : null}
					<SearchableSelect
						placeholder="Link a session…"
						options={sessions
							.filter((s) => !linkedSessions.some((l) => l.path === s.path))
							.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0))
							.map((s) => ({ value: s.name, label: recordLabel(s, project) }))}
						onPick={(name) => writeLinkedSessions([...linkedSessions.map((s) => s.name), name])}
						action={
							project
								? {
										label: '+ New session…',
										onPick: () =>
											new CreateEntityModal(plugin, 'session', project, {
												onCreated: (created) => {
													writeLinkedSessions([...linkedSessions.map((s) => s.name), created.basename]);
												},
											}).open(),
									}
								: undefined
						}
					/>
				</div>
			) : null}

			<label className="loom-field">
				<span className="loom-field-label">Description</span>
				<div className="loom-resizable">
					<textarea
						ref={descriptionRef}
						rows={10}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						onBlur={() =>
							writeFm((fm) => {
								fm.description = description;
							})
						}
					/>
					<div
						className="loom-resize-edge"
						onMouseDown={(e) => startTextareaResize(descriptionRef.current, e)}
					/>
				</div>
			</label>

			{allTags.length > 0 ? (
				<div className="loom-field">
					<span className="loom-field-label">Tags</span>
					<div className="loom-tag-row">
						{allTags.map((tag) => (
							<button
								key={tag}
								className={record.loomTags.includes(tag) ? 'loom-chip loom-chip-on' : 'loom-chip'}
								onClick={() => toggleTag(tag)}
							>
								{tag}
							</button>
						))}
					</div>
				</div>
			) : null}

			{record.type === 'character' ? (
				<label className="loom-field">
					<span className="loom-field-label">Role</span>
					<input
						type="text"
						value={role}
						onChange={(e) => setRole(e.target.value)}
						onBlur={() =>
							writeFm((fm) => {
								fm.role = role;
							})
						}
					/>
				</label>
			) : null}

			{isPc ? (
				<div className="loom-field">
					<label className="loom-check">
						<input type="checkbox" checked={record.alive} onChange={(e) => setAlive(e.target.checked)} />
						Alive
					</label>
				</div>
			) : null}

			{isPc && !record.alive ? (
				<div className="loom-field">
					<span className="loom-field-label">Death session</span>
					{deathSession && deathSession.type === 'session' ? (
						<div className="loom-tag-row">
							<span className="loom-chip loom-session-chip">
								{recordLabel(deathSession, project)}
								<button
									className="loom-chip-remove"
									aria-label="Clear death session"
									onClick={() => setDeathSession(null)}
								>
									✕
								</button>
							</span>
						</div>
					) : (
						<SearchableSelect
							placeholder="Pick the session…"
							options={sessions
								.slice()
								.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0))
								.map((s) => ({ value: s.name, label: recordLabel(s, project) }))}
							onPick={(name) => setDeathSession(name)}
						/>
					)}
				</div>
			) : null}

			<div className="loom-field loom-field-body">
				<span className="loom-field-label">Notes</span>
				<LinkTextarea
					rows={10}
					placeholder="Freeform notes. [[Wikilinks]] connect like in any other note."
					value={body ?? ''}
					names={linkNames}
					textareaRef={notesRef}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>

			<div className="loom-field">
				<span className="loom-field-label">Relationships</span>
				{ENTITY_TYPES.filter((t) => relEntries.some((e) => e.entityType === t)).map((t) => (
					<div key={t} className="loom-rel-group">
						<span className="loom-rel-group-label">{ENTITY_META[t].plural}</span>
						{relEntries.filter((e) => e.entityType === t).map((e) => relRow(e.rel, e.i))}
					</div>
				))}
				{relEntries.some((e) => e.entityType === null) ? (
					<div className="loom-rel-ungrouped">
						{relEntries.filter((e) => e.entityType === null).map((e) => relRow(e.rel, e.i))}
					</div>
				) : null}
				<button
					className="loom-rel-add"
					onClick={() => setRelationships([...relationships, { type: '', target: '' }])}
				>
					Add relationship
				</button>
			</div>

			<ConnectedEntities navigator={view} record={record} project={project} />
			</div>
		</div>
	);
}
