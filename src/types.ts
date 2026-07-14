export const ENTITY_TYPES = [
	'character',
	'location',
	'faction',
	'item',
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
	event: { label: 'Event', plural: 'Events', folder: 'Entities/Events', icon: 'calendar-days' },
	session: { label: 'Session', plural: 'Sessions', folder: 'Entities/Sessions', icon: 'book-open' },
};

/** Entity types that live on the timeline layers of the graph. */
export const TIMELINE_TYPES: readonly EntityType[] = ['session', 'event'];
/** Entity types that live on the fixed lower axis of the graph. */
export const GLOBAL_TYPES: readonly EntityType[] = ['character', 'location', 'faction', 'item'];

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
	pluginTags: string[];
	description: string;
	relationships: RelationshipDecl[];
	date: LoomDate | null;
	/** Event only: linkpath of the linked session note, unresolved. */
	linkedSession: string | null;
	/** Character only. */
	role: string;
	created: number;
	modified: number;
}

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

export const VIEW_HOME = 'loom-loom-home';
export const VIEW_LIST = 'loom-loom-list';
export const VIEW_TIMELINE = 'loom-loom-timeline';
export const VIEW_GRAPH = 'loom-loom-graph';
export const VIEW_ENTITY = 'loom-loom-entity';
