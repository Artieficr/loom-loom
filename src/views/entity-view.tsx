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
	/** Locations only: linkpaths of places this note is about. */
	places: string[];
}

interface LocNoteEntry {
	owner: EntityRecord;
	idx: number;
	session: string | null;
	text: string;
	seq: number | null;
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
		record?.sessionNotes.map((n) => ({ session: n.session ?? '', text: n.text, places: n.places })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);
	/** Live sublocation reorder: rows slide in real time while the grip is
	 *  held; the row itself is never carried by the cursor. */
	const [sublocDrag, setSublocDrag] = useState<{ from: number; over: number } | null>(null);
	const sublocDragRef = useRef<{ startY: number; slot: number } | null>(null);
	const sublocListRef = useRef<HTMLDivElement | null>(null);
	/** Locations: pending "new session note" draft (place defaults to Self). */
	const [locDraft, setLocDraft] = useState<{ session: string; place: string; text: string } | null>(
		null
	);
	const [questsOpen, setQuestsOpen] = useState<{ active: boolean; finished: boolean }>({
		active: true,
		finished: false,
	});
	/** Hub row whose action menu (trash / unlink) is slid open, if any. */
	const [hubMenu, setHubMenu] = useState<string | null>(null);
	/** Per-hub-row entity-type filter for the Involve picker. */
	const [hubFilter, setHubFilter] = useState<Record<string, EntityType | null>>({});
	/** Live reorder of a session group's note rows (same slide as sublocations). */
	const [noteDrag, setNoteDrag] = useState<{ gkey: string; from: number; over: number } | null>(null);
	const noteDragRef = useRef<{ startY: number; slot: number } | null>(null);

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
		setSessionNotes(record.sessionNotes.map((n) => ({ session: n.session ?? '', text: n.text, places: n.places })));
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

	// Faction members: dedicated character list, not relationships.
	const memberRecords =
		record.type === 'faction'
			? record.members
					.map((lp) => plugin.indexer.resolve(lp, record.path))
					.filter((r): r is EntityRecord => r != null && r.type === 'character')
			: [];
	const projectCharacters =
		record.type === 'faction' && project ? plugin.indexer.getAll('character', project.root) : [];
	const writeMembers = (names: string[]) => {
		writeFm((fm) => {
			setFmKey(fm, 'members', names.map((n) => `[[${n}]]`));
		});
	};

	// Location session notes live on the location they are ABOUT: a note about
	// the Tavern is stored in Tavern's frontmatter and surfaces (editable) on
	// every ancestor, labeled with its place — "Self" on its own page. Adding
	// a note for a descendant place from here writes into that descendant.
	const locDescendants = projectLocations
		.filter((l) => l.path !== record.path && descendsFromThis(l))
		.sort((a, b) => a.name.localeCompare(b.name));
	const locEntries: LocNoteEntry[] = isLocation
		? [record, ...locDescendants].flatMap((owner) =>
				owner.sessionNotes
					.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq }))
					.filter((e) => e.session !== null)
			)
		: [];
	const locGroups = (() => {
		const map = new Map<
			string,
			{ session: EntityRecord | null; raw: string; entries: typeof locEntries }
		>();
		for (const e of locEntries) {
			const ses = e.session !== null ? plugin.indexer.resolve(e.session, e.owner.path) : null;
			const key = ses?.path ?? 'raw:' + String(e.session);
			if (!map.has(key)) map.set(key, { session: ses, raw: String(e.session), entries: [] });
			map.get(key)?.entries.push(e);
		}
		// Within a group: creation order (seq, stamped on creation); legacy
		// notes without one keep their stable pre-seq order, first.
		for (const g of map.values()) g.entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
		return [...map.values()].sort(
			(a, b) => (b.session?.date?.sortKey ?? 0) - (a.session?.date?.sortKey ?? 0)
		);
	})();
	const noteShift = (gkey: string, i: number): number => {
		if (!noteDrag || noteDrag.gkey !== gkey) return 0;
		const { from, over } = noteDrag;
		if (i === from) return over - from;
		if (from < i && i <= over) return -1;
		if (over <= i && i < from) return 1;
		return 0;
	};
	const endNoteDrag = (entries: LocNoteEntry[], commit: boolean) => {
		noteDragRef.current = null;
		const drag = noteDrag;
		setNoteDrag(null);
		if (!commit || !drag || drag.from === drag.over) return;
		const next = [...entries];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		// Re-stamp the whole group in its new order; seq lives on each note,
		// so the order reads the same on every ancestor page.
		const base = Date.now();
		const perOwner = new Map<string, Map<number, number>>();
		next.forEach((en, i) => {
			if (!perOwner.has(en.owner.path)) perOwner.set(en.owner.path, new Map());
			perOwner.get(en.owner.path)?.set(en.idx, base + i);
		});
		for (const [ownerPath, seqs] of perOwner) {
			const owner = plugin.indexer.get(ownerPath);
			if (!owner) continue;
			writeOwnerNotes(owner, (arr) => {
				for (const [idx, seq] of seqs) {
					const item = arr[idx];
					if (typeof item === 'object' && item !== null) (item as { seq?: unknown }).seq = seq;
				}
			});
		}
	};
	const writeOwnerNotes = (owner: EntityRecord, apply: (arr: unknown[]) => void) => {
		const f = plugin.app.vault.getFileByPath(owner.path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const arr = Array.isArray(fm.sessionNotes) ? fm.sessionNotes : [];
				apply(arr);
				fm.sessionNotes = arr;
			})
			.catch((e) => {
				console.error('Loom Loom: failed to update session notes', e);
				new Notice('Could not save the change.');
			});
	};
	const commitLocDraft = () => {
		if (!locDraft || locDraft.session.trim() === '') return;
		const target =
			locDraft.place === record.name
				? record
				: locDescendants.find((l) => l.name === locDraft.place) ?? record;
	writeOwnerNotes(target, (arr) =>
			arr.push({ session: `[[${locDraft.session}]]`, text: locDraft.text, seq: Date.now() })
		);
	setLocDraft(null);
	};

	// Session pages are hubs: every note in the project pinned to this session,
	// editable here (writes go to the owning note's file), plus quest states
	// AS OF this session's date.
	const hubEntries: LocNoteEntry[] = isSession
		? plugin.indexer
				.getAll(undefined, record.project)
				.flatMap((owner) =>
					owner.sessionNotes
						.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq }))
						.filter(
							(e) =>
								e.session !== null &&
								plugin.indexer.resolve(e.session, owner.path)?.path === record.path
						)
				)
				.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
		: [];
	const hubTargets =
		isSession && project
			? plugin.indexer
					.getAll(undefined, project.root)
					.filter((r) => r.type !== 'session' && r.type !== 'event')
					.sort((a, b) => a.name.localeCompare(b.name))
			: [];
	const isInvolvedType = (t: string) => {
		const lower = t.trim().toLowerCase();
		return lower === 'involved' || lower === 'involves';
	};
	const involvedOf = (owner: EntityRecord) =>
		owner.relationships
			.filter((r) => isInvolvedType(r.type))
			.map((r) => ({ rel: r, target: plugin.indexer.resolve(r.linkpath, owner.path) }))
			.sort(
				(a, b) =>
					(a.target ? ENTITY_TYPES.indexOf(a.target.type) : 99) -
						(b.target ? ENTITY_TYPES.indexOf(b.target.type) : 99) ||
					(a.target?.name ?? a.rel.linkpath).localeCompare(b.target?.name ?? b.rel.linkpath)
			);
	const writeOwnerRels = (owner: EntityRecord, apply: (rels: unknown[]) => unknown[]) => {
		const f = plugin.app.vault.getFileByPath(owner.path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				fm.relationships = apply(Array.isArray(fm.relationships) ? fm.relationships : []);
			})
			.catch((e) => {
				console.error('Loom Loom: failed to update relationships', e);
				new Notice('Could not save the change.');
			});
	};
	const renameEntity = (owner: EntityRecord, raw: string) => {
		const base = sanitizeFileName(raw);
		if (base === '' || base === owner.name) return;
		const f = plugin.app.vault.getFileByPath(owner.path);
		if (!f) return;
		const parent = f.parent?.path ?? '';
		const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
		if (plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice('A note with that name already exists.');
			return;
		}
		void plugin.app.fileManager.renameFile(f, newPath);
	};
	const asOf = record.date?.sortKey ?? Number.MAX_SAFE_INTEGER;
	const sessionQuests = (isSession && project ? plugin.indexer.getAll('quest', project.root) : [])
		.map((q) => {
			const rec = q.questReceived !== null ? plugin.indexer.resolve(q.questReceived, q.path) : null;
			if (rec?.date && rec.date.sortKey > asOf) return null; // not yet received then
			const out =
				q.questOutcomeSession !== null
					? plugin.indexer.resolve(q.questOutcomeSession, q.path)
					: null;
			const finished = q.questOutcome !== '' && out?.date !== undefined && out.date !== null && out.date.sortKey <= asOf;
			return { quest: q, state: finished ? 'finished' : 'active' };
		})
		.filter((e): e is { quest: EntityRecord; state: string } => e !== null)
		.sort((a, b) => a.quest.name.localeCompare(b.quest.name));

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
			<div className="loom-rel-targetbox">
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
				className="loom-rel-filter"
				aria-label="Filter suggestions by entity type"
				onClick={(e) => openRelFilterMenu(e, i)}
			>
				<Icon name={rel.filter ? ENTITY_META[rel.filter].icon : 'filter'} />
			</button>
			</div>
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
			{isLocation ? (
					<div className="loom-tag-row">
						{note.places.map((pl, pi) => (
							<span key={pl} className="loom-chip loom-session-chip">
								{pl}
								<button
									className="loom-chip-remove"
									aria-label="Remove place"
									onClick={() => setNote({ places: note.places.filter((_, j) => j !== pi) }, true)}
								>
									✕
								</button>
							</span>
						))}
						<SearchableSelect
							placeholder="Add a place…"
							options={projectLocations
								.filter((l) => l.path !== record.path && !note.places.includes(l.name))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((l) => ({ value: l.name, label: l.name }))}
							onPick={(name) => setNote({ places: [...note.places, name] }, true)}
						/>
					</div>
				) : null}
				<div className="loom-note-text">
					<LinkTextarea
						rows={1}
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
			<span
					className="loom-chip"
					style={{
						background: plugin.settings.nodeColors[record.type] + '40',
						border: `1px solid ${plugin.settings.nodeColors[record.type]}`,
					}}
				>
					{ENTITY_META[record.type].label}
				</span>
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


			{isSession && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Quests</span>
					{(['active', 'finished'] as const).map((state) => {
						const list = sessionQuests.filter((q) => q.state === state);
						const open = questsOpen[state];
						return (
							<div key={state} className="loom-section">
								<button
									className="loom-section-header"
									onClick={() => setQuestsOpen({ ...questsOpen, [state]: !open })}
								>
									<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
									{state === 'active' ? 'Active' : 'Finished'}
									<span className="loom-section-count">{list.length}</span>
								</button>
								{open
									? list.map(({ quest }) => (
											<div key={quest.path} className="loom-locnote-head">
												<button
													className="loom-subloc-link"
													onClick={() => view.openEntity(quest.path)}
												>
													{quest.name}
												</button>
												{state === 'finished' ? (
													<span className="loom-row-count">{quest.questOutcome}</span>
												) : null}
											</div>
										))
									: null}
							</div>
						);
					})}
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
						rows={1}
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

			{isSession && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Session notes</span>
					{/* Creation first, as always. An event born here starts with a
					    session note already pinned to this session. */}
				<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'event', project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add an event
						</button>
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'quest', project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add a quest
						</button>
					</div>
					{ENTITY_TYPES.filter((t) => hubEntries.some((e) => e.owner.type === t)).map((t) => (
						<div key={t} className="loom-hub-section">
							<span className="loom-rel-group-label">{ENTITY_META[t].plural}</span>
							{hubEntries.filter((e) => e.owner.type === t).map((en) => {
						const menuKey = en.owner.path + String(en.idx);
						const involved = involvedOf(en.owner);
						return (
							<div key={menuKey} className="loom-locnote">
								<div className="loom-locnote-head">
									<input
										type="text"
										className="loom-hub-name"
										defaultValue={en.owner.name}
										onBlur={(e) => renameEntity(en.owner, e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter') renameEntity(en.owner, e.currentTarget.value);
										}}
									/>
									<button
										className="loom-nav-btn"
										aria-label="Open page"
										onClick={() => view.openEntity(en.owner.path)}
									>
									→
									</button>
									
									<div className="loom-shell-spacer" />
									<div
										className={
											hubMenu === menuKey ? 'loom-hub-actions loom-hub-actions-open' : 'loom-hub-actions'
										}
									>
										<button
											className="loom-nav-btn loom-entity-delete"
											aria-label="Delete this entity"
											onClick={() =>
												new ConfirmModal(
													plugin.app,
													`Delete "${en.owner.name}"?`,
													'The note is moved to the trash.',
													() => {
														const f = plugin.app.vault.getFileByPath(en.owner.path);
														if (f) void plugin.app.fileManager.trashFile(f);
													},
													'Delete'
												).open()
											}
										>
											<Icon name="trash-2" />
										</button>
										<button
											className="loom-nav-btn"
											aria-label="Remove from this session"
											onClick={() => {
												const remove = () => writeOwnerNotes(en.owner, (arr) => arr.splice(en.idx, 1));
												if (en.text.trim() === '') remove();
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
									<button
										className="loom-nav-btn"
										aria-label={hubMenu === menuKey ? 'Close actions' : 'Show actions'}
										onClick={() => setHubMenu(hubMenu === menuKey ? null : menuKey)}
									>
										{hubMenu === menuKey ? '>' : '<'}
									</button>
								</div>
							{(() => {
										const locs = en.owner.relationships
											.map((r) => ({ rel: r, target: plugin.indexer.resolve(r.linkpath, en.owner.path) }))
											.filter(
												(e) =>
													e.rel.type.trim().toLowerCase() === 'location' &&
													e.target?.type === 'location'
											);
									return (
											<>
												<div className="loom-hub-involve-row loom-hub-location-row">
													<div className="loom-hub-location">
													<SearchableSelect
														placeholder="Location…"
														options={hubTargets
															.filter(
																(t) =>
																	t.type === 'location' && !locs.some((l) => l.target?.path === t.path)
															)
															.map((t) => ({ value: t.name, label: t.name }))}
														onPick={(name) =>
															writeOwnerRels(en.owner, (rels) => {
																rels.push({ type: 'location', target: `[[${name}]]` });
																return rels;
															})
														}
												/>
													</div>
												</div>
												{locs.length > 0 ? (
													<div className="loom-hub-involved loom-tag-row">
														{locs.map(({ rel, target }, li2) => (
													<span
														key={rel.linkpath + String(li2)}
														className="loom-chip loom-session-chip"
														style={{
															background: plugin.settings.nodeColors.location + '40',
															borderColor: plugin.settings.nodeColors.location,
														}}
													>
														{target?.name ?? rel.linkpath}
														<button
															className="loom-chip-remove"
															aria-label="Remove location"
															onClick={() =>
																writeOwnerRels(en.owner, (rels) => {
																	const i = rels.findIndex(
																		(r) =>
																			typeof r === 'object' &&
																			r !== null &&
																			(r as { target?: unknown }).target === rel.targetRaw &&
																			(r as { type?: unknown }).type === rel.type
																	);
																	if (i >= 0) rels.splice(i, 1);
																	return rels;
																})
															}
														>
															✕
														</button>
												</span>
														))}
													</div>
												) : null}
											</>
										);
									})()}
								<div className="loom-hub-involve-row">
									<div className="loom-hub-involve">
										<SearchableSelect
										placeholder="Involve…"
										options={hubTargets
											.filter((t) => !involved.some((iv) => iv.target?.path === t.path))
											.filter((t) => !hubFilter[menuKey] || t.type === hubFilter[menuKey])
											.map((t) => ({ value: t.name, label: t.name }))}
										onPick={(name) =>
											writeOwnerRels(en.owner, (rels) => {
												rels.push({ type: 'involved', target: `[[${name}]]` });
												return rels;
											})
										}
									/>
										<button
										className="loom-rel-filter"
										aria-label="Filter suggestions by entity type"
										onClick={(e) => {
											const menu = new Menu();
											const current = hubFilter[menuKey] ?? null;
											menu.addItem((item) =>
												item
													.setTitle('All entities')
													.setIcon('filter')
													.setChecked(current === null)
													.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: null }))
											);
											for (const t of ENTITY_TYPES.filter((t) => t !== 'session' && t !== 'event')) {
												menu.addItem((item) =>
													item
														.setTitle(ENTITY_META[t].plural)
														.setIcon(ENTITY_META[t].icon)
														.setChecked(current === t)
														.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: t }))
												);
											}
											menu.showAtMouseEvent(e.nativeEvent);
										}}
									>
										<Icon
											name={hubFilter[menuKey] ? ENTITY_META[hubFilter[menuKey]].icon : 'filter'}
										/>
									</button>
									</div>
								</div>
								{involved.length > 0 ? (
									<div className="loom-hub-involved loom-tag-row">
										{involved.map(({ rel, target }, ii) => (
											<span
												key={rel.linkpath + String(ii)}
												className="loom-chip loom-session-chip"
												style={
													target
														? {
																background: plugin.settings.nodeColors[target.type] + '40',
																borderColor: plugin.settings.nodeColors[target.type],
															}
														: undefined
												}
											>
												{target?.name ?? rel.linkpath}
												<button
													className="loom-chip-remove"
													aria-label="Remove involved entity"
													onClick={() =>
														writeOwnerRels(en.owner, (rels) => {
															const i = rels.findIndex(
																(r) =>
																	typeof r === 'object' &&
																	r !== null &&
																	(r as { target?: unknown }).target === rel.targetRaw &&
																	typeof (r as { type?: unknown }).type === 'string' &&
																	isInvolvedType((r as { type: string }).type)
															);
															if (i >= 0) rels.splice(i, 1);
															return rels;
														})
													}
												>
													✕
												</button>
											</span>
										))}
									</div>
								) : null}
								<div className="loom-note-text">
									<div className="loom-resizable">
									<textarea
										ref={(el) => autoGrowTextarea(el)}
										onInput={(ev) => autoGrowTextarea(ev.currentTarget)}
										rows={1}
										defaultValue={en.text}
										onBlur={(e) =>
											writeOwnerNotes(en.owner, (arr) => {
												const item = arr[en.idx];
												if (typeof item === 'object' && item !== null) {
													(item as { text?: unknown }).text = e.target.value;
												}
											})
										}
									/>
									<div
										className="loom-resize-edge"
										onMouseDown={(ev) => {
											const prev = ev.currentTarget.previousElementSibling;
											if (prev instanceof HTMLTextAreaElement) startTextareaResize(prev, ev);
										}}
									/>
									</div>
								</div>
							</div>
						);
					})}
						</div>
					))}
				</div>
			) : null}


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

			{record.type === 'faction' ? (
				<div className="loom-field">
					<span className="loom-field-label">Members</span>
					{memberRecords.length > 0 ? (
						<div className="loom-tag-row">
							{memberRecords.map((c) => (
								<span key={c.path} className="loom-chip loom-session-chip">
									{c.name}
									<button
										className="loom-chip-remove"
										aria-label="Remove member"
										onClick={() =>
											writeMembers(memberRecords.filter((o) => o.path !== c.path).map((o) => o.name))
										}
									>
										✕
									</button>
								</span>
							))}
						</div>
					) : null}
					<SearchableSelect
						placeholder="Add a member…"
						options={projectCharacters
							.filter((c) => !memberRecords.some((m) => m.path === c.path))
							.sort((a, b) => a.name.localeCompare(b.name))
							.map((c) => ({ value: c.name, label: c.name }))}
						onPick={(name) => writeMembers([...memberRecords.map((m) => m.name), name])}
					/>
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

			{!isSession ? (
<div className="loom-field loom-field-body">
				<span className="loom-field-label">Notes</span>
				<LinkTextarea
					rows={1}
					value={body ?? ''}
					names={linkNames}
					textareaRef={notesRef}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>
			) : null}


			{!isSession && !isLocation ? (
				<div className="loom-field loom-field-sep">
					{sessionNotes.length > 0 ? <span className="loom-field-label">Session notes</span> : null}
					<button
						className="loom-rel-add"
						onClick={() => setSessionNotes([...sessionNotes, { session: '', text: '', places: [] }])}
					>
						+ Add a session note
					</button>
{sessionNotes.map((note, i) => sessionNoteRow(note, i))}
					
				</div>
			) : null}

			{isLocation && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Session notes</span>
					{locDraft ? (
						<div className="loom-locnote loom-locnote-new">
							<div className="loom-note-session">
								<SearchableSelect
									placeholder="Pick a session…"
									options={sessionsByDate.map((se) => ({ value: se.name, label: shortSessionLabel(se) }))}
									onPick={(v) => setLocDraft({ ...locDraft, session: v })}
								/>
							</div>
							<select
								value={locDraft.place}
								onChange={(e) => {
									if (e.target.value === '__new__') {
										new CreateEntityModal(plugin, 'location', project, {
											parentLocation: record,
											onCreated: (created) =>
												setLocDraft((d) => (d ? { ...d, place: created.basename } : d)),
										}).open();
										return;
									}
									setLocDraft({ ...locDraft, place: e.target.value });
								}}
							>
								<option value="__new__">+ New sublocation…</option>
								<option value={record.name}>Self</option>
								{locDescendants.map((l) => (
									<option key={l.path} value={l.name}>
										{l.name}
									</option>
								))}
							</select>
							<div className="loom-note-text">
								<div className="loom-resizable">
								<textarea
									ref={(el) => autoGrowTextarea(el)}
									onInput={(ev) => autoGrowTextarea(ev.currentTarget)}
									rows={1}
									value={locDraft.text}
									onChange={(e) => setLocDraft({ ...locDraft, text: e.target.value })}
								/>
								<div
									className="loom-resize-edge"
									onMouseDown={(ev) => {
										const prev = ev.currentTarget.previousElementSibling;
										if (prev instanceof HTMLTextAreaElement) startTextareaResize(prev, ev);
									}}
								/>
								</div>
							</div>
							<button className="loom-rel-add" disabled={locDraft.session === ''} onClick={commitLocDraft}>
								Add
							</button>
							<button className="loom-nav-btn" onClick={() => setLocDraft(null)}>
								Cancel
							</button>
						</div>
					) : (
						<button
							className="loom-rel-add"
							onClick={() => setLocDraft({ session: '', place: record.name, text: '' })}
						>
							+ Add a session note
						</button>
					)}
{locGroups.map((g) => (
						<div key={g.raw} className="loom-locnote-group">
							<div className="loom-tag-row">
								<span className="loom-chip loom-session-chip">
									{g.session && g.session.type === 'session' ? shortSessionLabel(g.session) : g.raw}
								</span>
							</div>
						{g.entries.map((en, gi) => (
							<div
								key={en.owner.path + String(en.idx)}
								className="loom-locnote"
								style={
									noteShift(g.raw, gi) !== 0
										? { transform: `translateY(${noteShift(g.raw, gi) * (noteDragRef.current?.slot ?? 64)}px)` }
										: undefined
								}
							>
								<div className="loom-locnote-head">
<span
									className="loom-subloc-grip"
									onPointerDown={(e) => {
										e.preventDefault();
										e.currentTarget.setPointerCapture(e.pointerId);
										const list = e.currentTarget.closest('.loom-locnote-group');
										let slot = 64;
										if (list) {
											const rows = list.querySelectorAll('.loom-locnote');
											if (rows.length > 1) {
												slot =
													(rows[1] as HTMLElement).offsetTop - (rows[0] as HTMLElement).offsetTop || 64;
											}
										}
										noteDragRef.current = { startY: e.clientY, slot };
										setNoteDrag({ gkey: g.raw, from: gi, over: gi });
									}}
									onPointerMove={(e) => {
										const start = noteDragRef.current;
										if (!start) return;
										const over = Math.max(
											0,
											Math.min(g.entries.length - 1, gi + Math.round((e.clientY - start.startY) / start.slot))
										);
										setNoteDrag((cur) => (cur && cur.over !== over ? { ...cur, over } : cur));
									}}
									onPointerUp={() => endNoteDrag(g.entries, true)}
									onPointerCancel={() => endNoteDrag(g.entries, false)}
								>
									<Icon name="grip-vertical" />
								</span>
									<button
										className="loom-nav-btn"
										aria-label="Change session"
										onClick={() =>
											new RecordSuggestModal(
												plugin.app,
												sessionsByDate,
												(ses) =>
													writeOwnerNotes(en.owner, (arr) => {
														const item = arr[en.idx];
														if (typeof item === 'object' && item !== null) {
															(item as { session?: unknown }).session = `[[${ses.name}]]`;
														}
													}),
												'Move note to session…'
											).open()
										}
									>
										<Icon name="calendar" />
									</button>
									{en.owner.path === record.path ? (
										<span className="loom-locnote-place">Self</span>
									) : (
										<button
											className="loom-subloc-link loom-locnote-place"
											onClick={() => view.openEntity(en.owner.path)}
										>
											{en.owner.name}
										</button>
									)}
									<button
										className="loom-nav-btn"
										aria-label="Remove session note"
										onClick={() => {
											const remove = () => writeOwnerNotes(en.owner, (arr) => arr.splice(en.idx, 1));
											if (en.text.trim() === '') remove();
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
										<div className="loom-resizable">
										<textarea
										ref={(el) => autoGrowTextarea(el)}
										onInput={(ev) => autoGrowTextarea(ev.currentTarget)}
											rows={1}
											defaultValue={en.text}
											onBlur={(e) =>
												writeOwnerNotes(en.owner, (arr) => {
													const item = arr[en.idx];
													if (typeof item === 'object' && item !== null) {
														(item as { text?: unknown }).text = e.target.value;
													}
												})
											}
										/>
										<div
											className="loom-resize-edge"
											onMouseDown={(ev) => {
												const prev = ev.currentTarget.previousElementSibling;
												if (prev instanceof HTMLTextAreaElement) startTextareaResize(prev, ev);
											}}
										/>
										</div>
									</div>
									
								</div>
							))}
						</div>
					))}
					
				</div>
			) : null}

			{/* Sublocations live outside the relationships model: the list of
			    children, creating one, and demoting this location under another
			    all work through the dedicated parentLocation key. */}
			{isLocation && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Sublocations</span>
					<div className="loom-subloc-actions">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'location', project, {
									parentLocation: record,
									// Append at the END of the order and stay on this page.
									onCreated: (created) =>
										writeFm((fm) => {
											setFmKey(fm, 'sublocationOrder', [
												...sublocations.map((s) => `[[${s.name}]]`),
												`[[${created.basename}]]`,
											]);
										}),
								}).open()
							}
						>
							+ New sublocation
						</button>
					</div>
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
				</div>
			) : null}

			<div className="loom-field loom-field-sep">
				<span className="loom-field-label">Relationships</span>
				<button
					className="loom-rel-add"
					onClick={() => setRelationships([...relationships, { type: '', target: '' }])}
				>
					Add relationship
				</button>
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
				
			</div>

			<ConnectedEntities navigator={view} record={record} project={project} />
			</div>
		</div>
	);
}
