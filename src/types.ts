export const ENTITY_TYPES = [
	'character',
	'location',
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
	faction: [],
	item: [],
	quest: [],
	event: [],
	session: [],
};

/** Characters tagged PC appear in session attendance and carry the alive flag. */
export const PC_TAG = 'PC';


/** Entity types that live on the timeline layers of the graph. */
export const TIMELINE_TYPES: readonly EntityType[] = ['session', 'event'];
/** Entity types that live on the fixed lower axis of the graph. */
export const GLOBAL_TYPES: readonly EntityType[] = ['character', 'location', 'faction', 'item', 'quest'];

export const TIMELINES_FOLDER = 'Timelines';
/** File extension of project home files (shown in the file explorer like .canvas/.base). */
export const LOOM_EXTENSION = 'loom';

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
	/** Character only. */
	role: string;
	/** Character only (PC): false once the character has died. */
	alive: boolean;
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
	/** Quest only: reward text (free-form). */
	reward: string;
	created: number;
	modified: number;
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
