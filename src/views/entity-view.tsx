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
	QUEST_OUTCOMES,
	VIEW_ENTITY,
	VIEW_LIST,
} from '../types';
import {
	ConfirmModal,
	CreateEntityModal,
	EntityTypeSuggestModal,
	RecordSuggestModal,
	sanitizeFileName,
	sessionFileName,
} from '../project';
import { formatLoomDateShort, todayRaw } from '../calendar';
import { LoomFileReactView } from './react-view';
import {
	FRONTMATTER_RE,
	Icon,
	NavRail,
	SearchableSelect,
	autoGrowTextarea,
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

interface SessionNoteDraft {
	/** Session linkpath; '' while no session is picked yet. */
	session: string;
	text: string;
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
	const [reward, setReward] = useState(record?.reward ?? '');
	const [date, setDate] = useState(record?.date?.raw ?? '');
	const [relationships, setRelationships] = useState<RelationshipDraft[]>(
		record?.relationships.map((r) => ({ type: r.type, target: r.linkpath })) ?? []
	);
	const [sessionNotes, setSessionNotes] = useState<SessionNoteDraft[]>(
		record?.sessionNotes.map((n) => ({ session: n.session ?? '', text: n.text })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);
	/** Live sublocation reorder: rows slide in real time while the grip is
	 *  held; the row itself is never carried by the cursor. */
	const [sublocDrag, setSublocDrag] = useState<{ from: number; over: number } | null>(null);
	const sublocDragRef = useRef<{ startY: number; slot: number } | null>(null);
	const sublocListRef = useRef<HTMLDivElement | null>(null);

	// A freshly created note opens before metadataCache has indexed it, so the
	// record can arrive one tick after mount — seed the drafts then.
	const seeded = useRef(record !== undefined);
	useEffect(() => {
		if (!record || seeded.current) return;
		seeded.current = true;
		setName(record.name);
		setDescription(record.description);
		setRole(record.role);
		setReward(record.reward);
		setDate(record.date?.raw ?? '');
		setRelationships(record.relationships.map((r) => ({ type: r.type, target: r.linkpath })));
		setSessionNotes(record.sessionNotes.map((n) => ({ session: n.session ?? '', text: n.text })));
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

	// Description fits its content — no natural scrolling (the notes box does
	// the same inside LinkTextarea); a manual resize turns auto-grow off.
	useEffect(() => {
		autoGrowTextarea(descriptionRef.current);
	}, [description]);

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

	const commitSessionNotes = (next: SessionNoteDraft[]) => {
		setSessionNotes(next);
		writeFm((fm) => {
			setFmKey(
				fm,
				'sessionNotes',
				next
					.filter((n) => n.session.trim() !== '' || n.text.trim() !== '')
					.map((n) => ({
						session: n.session.trim() === '' ? '' : `[[${n.session.trim()}]]`,
						text: n.text,
					}))
			);
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

	// Quest fields: giver characters (several), received/outcome sessions, reward.
	const isQuest = record.type === 'quest';
	const questGiverRecords = isQuest
		? record.questGivers
				.map((lp) => plugin.indexer.resolve(lp, record.path))
				.filter((r): r is EntityRecord => r !== null && r !== undefined)
		: [];
	const characters = isQuest && project ? plugin.indexer.getAll('character', project.root) : [];
	const writeQuestGivers = (names: string[]) => {
		writeFm((fm) => {
			setFmKey(fm, 'questGiver', names.map((n) => `[[${n}]]`));
		});
	};
	const questReceived =
		isQuest && record.questReceived !== null
			? plugin.indexer.resolve(record.questReceived, record.path)
			: null;
	const questOutcomeSession =
		isQuest && record.questOutcomeSession !== null
			? plugin.indexer.resolve(record.questOutcomeSession, record.path)
			: null;
	const setQuestSession = (key: 'questReceived' | 'questOutcomeSession', name: string | null) => {
		writeFm((fm) => {
			setFmKey(fm, key, name === null ? '' : `[[${name}]]`);
		});
	};
	const setQuestOutcome = (outcome: string) => {
		writeFm((fm) => {
			setFmKey(fm, 'questOutcome', outcome);
			if (outcome === '') setFmKey(fm, 'questOutcomeSession', '');
		});
	};
	const sessionsByDate = sessions
		.slice()
		.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
	const sessionChip = (s: EntityRecord, clear: () => void) => (
		<div className="loom-tag-row">
			<span className="loom-chip loom-session-chip">
				{recordLabel(s, project)}
				<button className="loom-chip-remove" aria-label="Clear session" onClick={clear}>
					✕
				</button>
			</span>
		</div>
	);

	// Locations: `parentLocation` makes this a sublocation — dedicated logic,
	// deliberately not a relationship. Any location can hold sublocations of
	// its own (nesting); the parent picker excludes the location itself and
	// its descendants so a cycle can't be built.
	const isLocation = record.type === 'location';
	const projectLocations =
		isLocation && project ? plugin.indexer.getAll('location', project.root) : [];
	const resolveParentOf = (l: EntityRecord) =>
		l.parentLocation !== null ? plugin.indexer.resolve(l.parentLocation, l.path) : null;
	const parentLocation = isLocation ? resolveParentOf(record) : null;
	// Children follow the parent's drag-reordered `sublocationOrder`; entries
	// not (yet) in it append alphabetically.
	const sublocOrderIdx = new Map<string, number>(
		record.sublocationOrder
			.map((lp, i) => [plugin.indexer.resolve(lp, record.path)?.path, i] as const)
			.filter((e): e is [string, number] => e[0] !== undefined)
	);
	const sublocations = projectLocations
		.filter((l) => l.path !== record.path && resolveParentOf(l)?.path === record.path)
		.sort(
			(a, b) =>
				(sublocOrderIdx.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
					(sublocOrderIdx.get(b.path) ?? Number.MAX_SAFE_INTEGER) ||
				a.name.localeCompare(b.name)
		);
	const writeSublocationOrder = (ordered: EntityRecord[]) => {
		writeFm((fm) => {
			setFmKey(fm, 'sublocationOrder', ordered.map((s) => `[[${s.name}]]`));
		});
	};
	const sublocSlotHeight = (): number => {
		const list = sublocListRef.current;
		if (!list || list.children.length < 2) return 28;
		const a = list.children[0] as HTMLElement;
		const b = list.children[1] as HTMLElement;
		return b.offsetTop - a.offsetTop || 28;
	};
	/** How many slots row `i` is displaced by the drag in progress. */
	const sublocShift = (i: number): number => {
		if (!sublocDrag) return 0;
		const { from, over } = sublocDrag;
		if (i === from) return over - from;
		if (from < i && i <= over) return -1;
		if (over <= i && i < from) return 1;
		return 0;
	};
	const endSublocDrag = (commit: boolean) => {
		sublocDragRef.current = null;
		const drag = sublocDrag;
		setSublocDrag(null);
		if (!commit || !drag || drag.from === drag.over) return;
		const next = [...sublocations];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		writeSublocationOrder(next);
	};
	/** Detaching lives on the parent's page — the child's own page only shows
	 *  its parent as a link (no removal there). */
	const detachSublocation = (s: EntityRecord) => {
		const childFile = plugin.app.vault.getFileByPath(s.path);
		if (!childFile) return;
		plugin.app.fileManager
			.processFrontMatter(childFile, (fm: Record<string, unknown>) => {
				for (const k of Object.keys(fm)) {
					if (k.toLowerCase() === 'parentlocation') delete fm[k];
				}
			})
			.catch((e) => {
				console.error('Loom Loom: failed to detach sublocation', e);
				new Notice('Could not detach the sublocation.');
			});
		writeSublocationOrder(sublocations.filter((o) => o.path !== s.path));
	};
	const descendsFromThis = (l: EntityRecord): boolean => {
		let cur: EntityRecord | null = l;
		for (let guard = 0; guard < 20 && cur !== null; guard++) {
			const parent: EntityRecord | null = resolveParentOf(cur);
			if (!parent) return false;
			if (parent.path === record.path) return true;
			cur = parent;
		}
		return false;
	};
	const setParentLocation = (name: string) => {
		writeFm((fm) => {
			setFmKey(fm, 'parentLocation', `[[${name}]]`);
		});
	};
	/** "Turn to a sublocation": fuzzy-searchable picker over every other
	 *  location (including sublocations — the whole child hierarchy moves
	 *  along), minus this location's own descendants so a cycle can't be
	 *  built. A search, not a plain menu — projects can get huge. */
	const openTurnIntoPicker = () => {
		const candidates = projectLocations
			.filter((l) => l.path !== record.path && !descendsFromThis(l))
			.sort((a, b) => a.name.localeCompare(b.name));
		new RecordSuggestModal(
			plugin.app,
			candidates,
			(l) => setParentLocation(l.name),
			'Pick the parent location…'
		).open();
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
				onClick={() => {
					const remove = () => commitRelationships(relationships.filter((_, j) => j !== i));
					// A still-empty new row goes silently; a filled one asks first.
					if (rel.target.trim() === '') remove();
					else {
						new ConfirmModal(
							plugin.app,
							'Remove relationship?',
							`Removes "${rel.type.trim() === '' ? 'related' : rel.type.trim()}" → ${rel.target.trim()}.`,
							remove,
							'Remove'
						).open();
					}
				}}
			>
				✕
			</button>
		</div>
	);

	// One session-scoped note: session picker on the left (chip once picked),
	// note text on the right. Picking the session commits immediately, which is
	// what connects the entity to it; the text commits on blur like other fields.
	// The picker column is narrow, so dates always use the compact form here.
	const shortSessionLabel = (s: EntityRecord) =>
		s.date && project ? formatLoomDateShort(s.date, project.config) : s.name;
	const sessionNoteRow = (note: SessionNoteDraft, i: number) => {
		const picked =
			note.session.trim() !== '' ? plugin.indexer.resolve(note.session.trim(), record.path) : null;
		// A session already carrying a note isn't offered again.
		const takenSessions = new Set(
			sessionNotes
				.filter((_, j) => j !== i)
				.map((n) =>
					n.session.trim() !== '' ? plugin.indexer.resolve(n.session.trim(), record.path)?.path : undefined
				)
				.filter((p): p is string => p !== undefined)
		);
		const setNote = (patch: Partial<SessionNoteDraft>, commit: boolean) => {
			const next = [...sessionNotes];
			next[i] = { ...note, ...patch };
			if (commit) commitSessionNotes(next);
			else setSessionNotes(next);
		};
		return (
			<div key={i} className="loom-note-row" onBlur={() => commitSessionNotes(sessionNotes)}>
				<div className="loom-note-head">
				<div className="loom-note-session">
					{picked && picked.type === 'session' ? (
						<div className="loom-tag-row">
							<span className="loom-chip loom-session-chip">
								{shortSessionLabel(picked)}
								<button
									className="loom-chip-remove"
									aria-label="Clear session"
									onClick={() => setNote({ session: '' }, true)}
								>
									✕
								</button>
							</span>
						</div>
					) : (
						<SearchableSelect
							placeholder="Pick a session…"
							options={sessionsByDate
								.filter((s) => s.path !== record.path && !takenSessions.has(s.path))
								.map((s) => ({ value: s.name, label: shortSessionLabel(s) }))}
							onPick={(name) => setNote({ session: name }, true)}
							action={
								project
									? {
											label: '+ New session…',
											onPick: () =>
												new CreateEntityModal(plugin, 'session', project, {
													onCreated: (created) => setNote({ session: created.basename }, true),
												}).open(),
										}
									: undefined
							}
						/>
					)}
				</div>
				<button
					className="loom-nav-btn loom-note-remove"
					aria-label="Remove session note"
					onClick={() => {
						const remove = () => commitSessionNotes(sessionNotes.filter((_, j) => j !== i));
						// Only a note that actually holds text needs a confirmation.
						if (note.text.trim() === '') remove();
						else {
							new ConfirmModal(
								plugin.app,
								'Delete this session note?',
								'The note text will be lost.',
								remove,
								'Delete'
							).open();
						}
					}}
				>
					✕
				</button>
				</div>
				<div className="loom-note-text">
					<LinkTextarea
						rows={5}
						value={note.text}
						names={linkNames}
						onChange={(v) => setNote({ text: v }, false)}
					/>
				</div>
			</div>
		);
	};

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
				{isLocation && record.parentLocation === null && project ? (
					<button className="loom-nav-btn" onClick={openTurnIntoPicker}>
						Turn to a sublocation
					</button>
				) : null}
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

			{/* Plain link, no detach here — a sublocation is released from its
			    parent's page, not its own. */}
			{isLocation && record.parentLocation !== null ? (
				<div className="loom-field">
					<span className="loom-field-label">Sublocation of</span>
					{parentLocation ? (
						<button className="loom-subloc-link" onClick={() => view.openEntity(parentLocation.path)}>
							{parentLocation.name}
						</button>
					) : (
						<span>{record.parentLocation}</span>
					)}
				</div>
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

			{/* Quest fields: givers left of a full-height separator; session/outcome
			    row + reward right of it. The separator stretches with whichever
			    side grows (wrapping giver chips, multi-line reward). */}
			{isQuest ? (
				<div className="loom-quest-grid">
					<div className="loom-field loom-quest-givers">
						<span className="loom-field-label">Quest givers</span>
						<SearchableSelect
							placeholder="Add a quest giver…"
							options={characters
								.filter((c) => !questGiverRecords.some((g) => g.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: c.name, label: c.name }))}
							onPick={(name) => writeQuestGivers([...questGiverRecords.map((g) => g.name), name])}
						/>
						{questGiverRecords.length > 0 ? (
							<div className="loom-tag-row">
								{questGiverRecords.map((c) => (
									<span key={c.path} className="loom-chip loom-session-chip">
										{c.name}
										<button
											className="loom-chip-remove"
											aria-label="Remove quest giver"
											onClick={() =>
												writeQuestGivers(
													questGiverRecords.filter((o) => o.path !== c.path).map((o) => o.name)
												)
											}
										>
											✕
										</button>
									</span>
								))}
							</div>
						) : null}
					</div>
					<div className="loom-quest-right">
						<div className="loom-quest-sessions">
							<div className="loom-field">
								<span className="loom-field-label">Received in session</span>
								{questReceived && questReceived.type === 'session' ? (
									sessionChip(questReceived, () => setQuestSession('questReceived', null))
								) : (
									<SearchableSelect
										placeholder="Pick the session…"
										options={sessionsByDate.map((s) => ({ value: s.name, label: recordLabel(s, project) }))}
										onPick={(name) => setQuestSession('questReceived', name)}
									/>
								)}
							</div>
							{record.questOutcome !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">
										{record.questOutcome[0].toUpperCase() + record.questOutcome.slice(1)} in session
									</span>
									{questOutcomeSession && questOutcomeSession.type === 'session' ? (
										sessionChip(questOutcomeSession, () => setQuestSession('questOutcomeSession', null))
									) : (
										<SearchableSelect
											placeholder="Pick the session…"
											options={sessionsByDate.map((s) => ({ value: s.name, label: recordLabel(s, project) }))}
											onPick={(name) => setQuestSession('questOutcomeSession', name)}
										/>
									)}
								</div>
							) : null}
							<label className="loom-field">
								<span className="loom-field-label">Outcome</span>
								<select value={record.questOutcome} onChange={(e) => setQuestOutcome(e.target.value)}>
									<option value="">Active</option>
									{QUEST_OUTCOMES.map((o) => (
										<option key={o} value={o}>
											{o[0].toUpperCase() + o.slice(1)}
										</option>
									))}
								</select>
							</label>
						</div>
						<label className="loom-field">
							<span className="loom-field-label">Reward</span>
							<input
								type="text"
								placeholder="Not specified"
								value={reward}
								onChange={(e) => setReward(e.target.value)}
								onBlur={() =>
									writeFm((fm) => {
										fm.reward = reward;
									})
								}
							/>
						</label>
					</div>
				</div>
			) : null}

			<label className="loom-field">
				<span className="loom-field-label">Description</span>
				<div className="loom-resizable">
					<textarea
						ref={descriptionRef}
						rows={3}
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
					rows={3}
					value={body ?? ''}
					names={linkNames}
					textareaRef={notesRef}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>

			{!isSession ? (
				<div className="loom-field loom-field-sep">
					{sessionNotes.length > 0 ? <span className="loom-field-label">Session notes</span> : null}
					{sessionNotes.map((note, i) => sessionNoteRow(note, i))}
					<button
						className="loom-rel-add"
						onClick={() => setSessionNotes([...sessionNotes, { session: '', text: '' }])}
					>
						+ Add a session note
					</button>
				</div>
			) : null}

			{/* Sublocations live outside the relationships model: the list of
			    children, creating one, and demoting this location under another
			    all work through the dedicated parentLocation key. */}
			{isLocation && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Sublocations</span>
					{sublocations.length > 0 ? (
						<div className="loom-subloc-list" ref={sublocListRef}>
							{sublocations.map((s, i) => (
								<div
									key={s.path}
									className="loom-subloc-row"
									style={
										sublocShift(i) !== 0
											? { transform: `translateY(${sublocShift(i) * (sublocDragRef.current?.slot ?? 28)}px)` }
											: undefined
									}
								>
									<span
										className="loom-subloc-grip"
										onPointerDown={(e) => {
											e.preventDefault();
											e.currentTarget.setPointerCapture(e.pointerId);
											sublocDragRef.current = { startY: e.clientY, slot: sublocSlotHeight() };
											setSublocDrag({ from: i, over: i });
										}}
										onPointerMove={(e) => {
											const start = sublocDragRef.current;
											if (!start) return;
											const over = Math.max(
												0,
												Math.min(
													sublocations.length - 1,
													i + Math.round((e.clientY - start.startY) / start.slot)
												)
											);
											setSublocDrag((cur) => (cur && cur.over !== over ? { ...cur, over } : cur));
										}}
										onPointerUp={() => endSublocDrag(true)}
										onPointerCancel={() => endSublocDrag(false)}
									>
										<Icon name="grip-vertical" />
									</span>
									<button className="loom-subloc-link" onClick={() => view.openEntity(s.path)}>
										{s.name}
									</button>
									<button
										className="loom-chip-remove"
										aria-label="Detach sublocation"
										onClick={() => detachSublocation(s)}
									>
										✕
									</button>
								</div>
							))}
						</div>
					) : null}
					<div className="loom-subloc-actions">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'location', project, {
									parentLocation: record,
									onCreated: (created) => view.openEntity(created.path),
								}).open()
							}
						>
							+ New sublocation
						</button>
					</div>
				</div>
			) : null}

			<div className="loom-field loom-field-sep">
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
