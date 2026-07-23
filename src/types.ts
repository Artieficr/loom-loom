export const ENTITY_TYPES = [
	'character',
	'location',
	'region',
	'faction',
	'item',
	'quest',
	'event',
	'session',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: unknown): value is EntityType {
	return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value);
}

export interface EntityTypeMeta {
	label: string;
	plural: string;
	/** Folder relative to the project root. */
	folder: string;
	/** Lucide icon name. */
	icon: string;
}

export const ENTITY_META: Record<EntityType, EntityTypeMeta> = {
	character: { label: 'Character', plural: 'Characters', folder: 'Entities/Characters', icon: 'user' },
	location: { label: 'Location', plural: 'Locations', folder: 'Entities/Locations', icon: 'map-pin' },
	region: { label: 'Region', plural: 'Regions', folder: 'Entities/Regions', icon: 'hexagon' },
	faction: { label: 'Faction', plural: 'Factions', folder: 'Entities/Factions', icon: 'flag' },
	item: { label: 'Item', plural: 'Items', folder: 'Entities/Items', icon: 'gem' },
	quest: { label: 'Quest', plural: 'Quests', folder: 'Entities/Quests', icon: 'scroll' },
	event: { label: 'Event', plural: 'Events', folder: 'Entities/Events', icon: 'calendar-days' },
	session: { label: 'Session', plural: 'Sessions', folder: 'Entities/Sessions', icon: 'book-open' },
};

/**
 * Hardcoded per-type tag vocabulary (deliberately not user-configurable —
 * plugin features key off these). First real use: PC drives session attendance.
 */
export const ENTITY_TAGS: Record<EntityType, string[]> = {
	character: ['PC', 'NPC', 'Cast'],
	location: [],
	region: [],
	faction: [],
	item: [],
	quest: ['main', 'important', 'side'],
	event: [],
	session: [],
};

/** Characters tagged PC appear in session attendance and carry the alive flag. */
export const PC_TAG = 'PC';

/**
 * The virtual "Group" faction: a picker-only entry that expands to every
 * PC-tagged character of the project — a fast way to connect the whole party
 * instead of adding PCs one by one. It has no file and never appears in the
 * entity list or the graph.
 */
export const PC_GROUP_NAME = 'Group';
/** Sentinel option value for the virtual Group (contains `:`, so it can never
 *  collide with a real file basename / link target). */
export const PC_GROUP_VALUE = 'loom:pc-group';
/** Icon of the virtual Group everywhere it appears (rail, home, its page). */
export const PC_GROUP_ICON = 'circle-star';


/** Entity types that live on the timeline layers of the graph. */
export const TIMELINE_TYPES: readonly EntityType[] = ['session', 'event'];
/** Entity types that live on the fixed lower axis of the graph. */
export const GLOBAL_TYPES: readonly EntityType[] = ['character', 'location', 'region', 'faction', 'item', 'quest'];

export const TIMELINES_FOLDER = 'Timelines';
/** File extension of project home files (shown in the file explorer like .canvas/.base). */
export const LOOM_EXTENSION = 'loom';

/**
 * Frontmatter keys owned by the plugin — every key is loom-prefixed so
 * plugin-managed properties are recognizable at a glance in any note.
 * Reads fall back to the legacy un-prefixed spellings (see `legacyFmKeys`);
 * the startup migration rewrites old files to these keys. Nested keys inside
 * list entries (session/text/involved…, type/target, character/role) stay
 * unprefixed — they only exist inside a loom-prefixed parent. `aliases` is
 * deliberately Obsidian's native key, written so the core [[link]]
 * autocomplete finds notes by their user-entered name.
 */
export const FM = {
	type: 'loomType',
	name: 'loomName',
	tags: 'loomTags',
	description: 'loomDescription',
	relationships: 'loomRelationships',
	sessionNotes: 'loomSessionNotes',
	date: 'loomDate',
	attendance: 'loomAttendance',
	parentLocation: 'loomParentLocation',
	sublocationOrder: 'loomSublocationOrder',
	/** Location only: link to the region this location is part of (a grouping
	 *  layer above main locations — not a sublocation). Its own field, like
	 *  `parentLocation`; emits a typed `region` connection. */
	region: 'loomRegion',
	/** Region only: manual display order of the region's member locations. */
	regionOrder: 'loomRegionOrder',
	members: 'loomMembers',
	alive: 'loomAlive',
	/** Character only (PC): false while the character is away from the party —
	 *  excluded from new virtual-Group picks until re-ticked. */
	active: 'loomActive',
	deathSession: 'loomDeathSession',
	questGiver: 'loomQuestGiver',
	questReceived: 'loomQuestReceived',
	questOutcome: 'loomQuestOutcome',
	questOutcomeSession: 'loomQuestOutcomeSession',
	reward: 'loomReward',
	/** Quest only: ordered list of objective entries ({ name, finishedOn }). */
	objectives: 'loomObjectives',
	/** Manual order stamp: events (timeline + session page) and quests (session
	 *  page) sort by it, so drag-reordering persists in the file. */
	seq: 'loomSeq',
	/** Character/location only: ordered item links shown in their Items section
	 *  (each a plain link, so it also connects in the graph). */
	items: 'loomItems',
	/** Character-specific item copy only: link to the original item it derives
	 *  from (visible → connects to the original in the graph). */
	itemOrigin: 'loomItemOrigin',
	/** Character-specific item copy only: link to the owning character. Hidden
	 *  from the link pass — the character already connects via its `loomItems`. */
	itemOwner: 'loomItemOwner',
	/** Timeline definition files. */
	timelineTypes: 'loomTypes',
	/** Loom-managed creation timestamp (ISO 8601). Authoritative over the
	 *  filesystem ctime, which cloud-sync can overwrite with the sync time. */
	created: 'loomCreated',
	/** Loom-managed modification timestamp (ISO 8601), stamped on every edit. */
	modified: 'loomModified',
} as const;

/** Legacy spelling(s) of a loom frontmatter key, still read and migrated. */
export function legacyFmKeys(key: string): string[] {
	if (key === FM.tags) return ['pluginTags'];
	if (key === FM.name) return []; // never existed un-prefixed
	// Timestamps are loom-owned only — never adopt/delete a bare `created`/
	// `modified` some other plugin (e.g. Linter) may already maintain.
	if (key === FM.created || key === FM.modified) return [];
	const stripped = key.replace(/^loom/, '');
	return [stripped[0].toLowerCase() + stripped.slice(1)];
}

/** Parses a loom timestamp frontmatter value (ISO string or epoch-ms number)
 *  to epoch milliseconds, or null when absent/unparseable. */
export function parseTimestamp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const ms = Date.parse(value);
		if (!Number.isNaN(ms)) return ms;
	}
	return null;
}

/** Formats an epoch-ms timestamp in Obsidian's "Date & time" property format
 *  (`YYYY-MM-DDTHH:mm:ss`, local time — no timezone suffix, no milliseconds),
 *  so the value renders in the datetime picker once the property is typed. */
export function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
		d.getMinutes()
	)}:${p(d.getSeconds())}`;
}

export type CalendarId = 'gregorian' | 'custom';

/**
 * A parsed date. `sortKey` is calendar-agnostic (year/month/day packed into a
 * monotonically sortable number), so timeline/graph ordering never depends on
 * JS `Date`. Display formatting happens separately via the owning project's
 * config (see calendar.ts).
 */
export interface LoomDate {
	raw: string;
	sortKey: number;
	year: number;
	month: number;
	day: number;
	calendar: CalendarId;
}

/** A session-scoped note as declared in one note's frontmatter: freeform text
 *  pinned to the session it was written about, so when something was noted is
 *  tracked alongside what. Linking a session connects the entity to it. */
export interface SessionNoteDecl {
	/** Linkpath of the session ("..." from "[[...]]"), or null while unpicked. */
	session: string | null;
	text: string;
	/** Locations only: linkpaths of locations/sublocations this note is about.
	 *  Notes surface on every ancestor of their owner and of these places. */
	places: string[];
	/** Creation/reorder stamp: group entries sort by it, so appending lands at
	 *  the end and drag-reorder persists identically on every ancestor page. */
	seq: number | null;
	/** Linkpaths of entities involved in this note — the note (not a
	 *  relationship) is the home of involvement. */
	involved: string[];
	/** Virtual-Group snapshot: linkpaths of the PCs the party consisted of when
	 *  "Group" was picked for this note (alive + active at pick time; frozen —
	 *  later deaths/leaves don't rewrite history). Rendered as one "Group" chip
	 *  but each member connects individually, exactly like `involved`. */
	group: string[];
}

/** One faction membership as declared in the faction's `members` frontmatter.
 *  Entries are plain links ("[[Sam]]", role = the default "Member", no
 *  location) or objects `{ character: "[[Sam]]", role: "Quartermaster",
 *  location: "[[Harbor]]" }` once a role or location is set. The faction is
 *  the membership's only home — the character page's "Faction(s)" section
 *  reads and writes the faction's file. */
export interface FactionMemberDecl {
	/** Extracted linkpath of the member character; resolved at query time. */
	linkpath: string;
	role: string;
	/** Linkpath of the location the member serves at, or null. */
	location: string | null;
}

/** Role shown (and stored as a plain link) when a membership has no explicit role. */
export const DEFAULT_MEMBER_ROLE = 'Member';

/** One quest objective as declared in the quest's `loomObjectives` frontmatter.
 *  Stored as `{ name, finishedOn?: "[[session]]" }`; an objective with a
 *  `finishedOn` session is resolved, otherwise it's still active. */
export interface QuestObjective {
	name: string;
	/** Linkpath of the session this objective was finished in, or null. */
	finishedSession: string | null;
}

/** A typed relationship as declared in one note's frontmatter. */
export interface RelationshipDecl {
	type: string;
	/** Raw target as written, e.g. "[[Sam]]" or "[[Sam|the gardener]]". */
	targetRaw: string;
	/** Extracted linkpath ("Sam"); resolved against the vault at query time. */
	linkpath: string;
}

export interface EntityRecord {
	path: string;
	/** Display name = file basename (renames propagate). Sessions display their date instead. */
	name: string;
	type: EntityType;
	/** Root folder path of the owning project. */
	project: string;
	loomTags: string[];
	description: string;
	relationships: RelationshipDecl[];
	/** Session-scoped notes; each picked session becomes a connection. */
	sessionNotes: SessionNoteDecl[];
	date: LoomDate | null;
	/** Session only: linkpaths of attending PC characters. These are hidden
	 *  connections — deliberately no graph edges or side-panel entries. */
	attendance: string[];
	/** Location only: linkpath of the parent location — what makes this a
	 *  sublocation. Its own frontmatter key (not a relationship): sublocations
	 *  have dedicated UI (parent link + sublocation lists, nested location
	 *  list, grid rows under the locations row in the graph) and a typed
	 *  `sublocation` connection. */
	parentLocation: string | null;
	/** Location only: manual display order of this location's sublocations
	 *  (drag-reordered on the parent's page). Hidden links — the children
	 *  already connect via their own parentLocation. */
	sublocationOrder: string[];
	/** Location only: linkpath of the region this location is part of (a grouping
	 *  layer above main locations), or null. Dedicated field like
	 *  `parentLocation`; emits a typed `region` connection. */
	region: string | null;
	/** Region only: manual display order of its member locations (drag-reordered
	 *  on the region's page). */
	regionOrder: string[];
	/** Character/location only: ordered item linkpaths shown in the Items
	 *  section (drag-reordered here); also connect in the graph as plain links. */
	items: string[];
	/** Item only: linkpath of the original item this is a character-specific
	 *  copy of, or null for a plain item. Set alongside `itemOwner`. */
	itemOrigin: string | null;
	/** Item only: linkpath of the character a copy belongs to, or null. */
	itemOwner: string | null;
	/** Faction only: member characters with per-membership roles (dedicated
	 *  list, not relationships; typed `member` connection). */
	members: FactionMemberDecl[];
	/** Character only (PC): false once the character has died. */
	alive: boolean;
	/** Character only (PC): false while away from the party (narrative absence);
	 *  new virtual-Group picks skip inactive PCs. Default true. */
	active: boolean;
	/** Character only (PC): linkpath of the session they died in. Sessions
	 *  after it no longer offer the character for attendance. */
	deathSession: string | null;
	/** Quest only: linkpath of the session the quest was received in. */
	questReceived: string | null;
	/** Quest only: '' while active, else one of QUEST_OUTCOMES. */
	questOutcome: string;
	/** Quest only: linkpath of the session the outcome happened in. */
	questOutcomeSession: string | null;
	/** Quest only: linkpaths of the characters who gave the quest. */
	questGivers: string[];
	/** Quest only: reward text (free-form, supports markdown). */
	reward: string;
	/** Quest only: ordered objective entries. Those with a `finishedSession`
	 *  are resolved; the rest are still active. */
	objectives: QuestObjective[];
	/** Manual order stamp (events + quests). Null = never reordered; callers
	 *  fall back to `created` so unstamped entries stay chronological. */
	seq: number | null;
	created: number;
	modified: number;
}

/** Picker-only stub record for the virtual "Group" faction — handed to
 *  suggests that operate on records. Never indexed, never rendered as a page.
 *  `name` is the project's custom group name (default "Group"). */
export function pcGroupStub(projectRoot: string, name = PC_GROUP_NAME): EntityRecord {
	return {
		path: PC_GROUP_VALUE,
		name,
		type: 'faction',
		project: projectRoot,
		loomTags: [],
		description: '',
		relationships: [],
		sessionNotes: [],
		date: null,
		attendance: [],
		parentLocation: null,
		sublocationOrder: [],
		region: null,
		regionOrder: [],
		items: [],
		itemOrigin: null,
		itemOwner: null,
		members: [],
		alive: true,
		active: true,
		deathSession: null,
		questReceived: null,
		questOutcome: '',
		questOutcomeSession: null,
		questGivers: [],
		reward: '',
		objectives: [],
		seq: null,
		created: 0,
		modified: 0,
	};
}

/** How a quest can end; '' in `questOutcome` means it's still active. */
export const QUEST_OUTCOMES = ['completed', 'abandoned', 'failed'] as const;

/** A resolved connection between two indexed entities. */
export interface Connection {
	record: EntityRecord;
	relType: string;
	direction: 'outgoing' | 'incoming';
}

/** A timeline definition file from a project's Timelines folder. */
export interface TimelineDef {
	path: string;
	project: string;
	name: string;
	types: EntityType[];
	tags: string[];
}

/** Where an entity page was opened from; its Back button returns there. */
export interface EntityOrigin {
	type: string;
	state: Record<string, unknown>;
}

/** Graph camera: screen = world * k + t. */
export interface GraphCamera {
	tx: number;
	ty: number;
	k: number;
}

export const VIEW_HOME = 'loom-loom-home';
export const VIEW_LIST = 'loom-loom-list';
export const VIEW_GRAPH = 'loom-loom-graph';
export const VIEW_ENTITY = 'loom-loom-entity';
export const VIEW_GROUP = 'loom-loom-group';
export const VIEW_MAP = 'loom-loom-map';

/** Maps: a spatial drawing canvas where zones (polygons) are associated with
 *  locations. Lucide icon + the folder maps/images live under. */
export const MAPS_ICON = 'map';
export const MAPS_LABEL = 'Maps';
export const MAPS_FOLDER = 'Maps';
export const MAPS_IMAGES_FOLDER = 'Maps/Images';

/** Standard graph/map node sizes (radius px), pickable per node. */
export const NODE_SIZE_PRESETS = {
	small: 12,
	regular: 17,
	big: 24,
	'very-big': 34,
} as const;
export type NodeSizePreset = keyof typeof NODE_SIZE_PRESETS;
