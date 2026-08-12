/**
 * Every entity type the plugin knows. A given project only shows the subset its
 * kind declares (`typesFor` in project-kind.ts) — Session/Event are the
 * player + GM chronology, Act/Scene the writer one. They're separate types
 * rather than one renamed pair because they carry genuinely different fields
 * (a session has a date and attendance; an act has an order and a display
 * title), but they play the same structural *roles*, so the shared layout,
 * timeline and page code addresses them through `roleType`/`roleOf` and never
 * by name.
 */
import { LocaleKey, t } from './i18n';

export const ENTITY_TYPES = [
	'character',
	'location',
	'region',
	'faction',
	'item',
	'quest',
	'event',
	'session',
	'scene',
	'act',
	'chapter',
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
	scene: { label: 'Scene', plural: 'Scenes', folder: 'Entities/Scenes', icon: 'clapperboard' },
	act: { label: 'Act', plural: 'Acts', folder: 'Entities/Acts', icon: 'book-open' },
	chapter: { label: 'Chapter', plural: 'Chapters', folder: 'Entities/Chapters', icon: 'book-text' },
};

/** `ENTITY_META[type].label`/`.plural` are the English source strings — folder
 *  names and other structural uses read those fields directly, but every
 *  DISPLAY read of the type's noun should go through these instead, so the
 *  whole plugin's entity-type vocabulary localizes from one place. */
export function entityLabel(type: EntityType): string {
	return t(`entityType.${type}.label`);
}
export function entityPlural(type: EntityType): string {
	return t(`entityType.${type}.plural`);
}
/** "New {noun}" for an entity type's own creation button/menu item — a SEPARATE
 *  key per type rather than one generic `t('… New {label}')` template, because
 *  Russian (and most gendered languages) needs "New" itself declined to agree
 *  with the noun's gender ("Новый персонаж" masc. / "Новая сессия" fem. /
 *  "Новое событие" neut.) — a single template combining an invariant "New" with
 *  a runtime-provided label can't do that. Scene/Act already have their own
 *  dedicated `newSceneTitle`/`newActTitle` keys for the same reason and are
 *  untouched by this — this covers every OTHER type. */
export function newEntityTitle(type: EntityType): string {
	return t(`entityType.${type}.newTitle`);
}

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
	scene: [],
	act: [],
	chapter: [],
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


/** Entity types that live on the timeline layers of the graph, across all
 *  kinds. A project only ever holds one pair (see `ANCHOR_TYPES`/`BEAT_TYPES`
 *  in project-kind.ts for the role split) — Chapter (Writer/Prose) is the one
 *  anchor with no beat counterpart; see `roleType`'s `EntityType | null`
 *  return for the `'beat'` role. */
export const TIMELINE_TYPES: readonly EntityType[] = ['session', 'event', 'act', 'scene', 'chapter'];
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
	/** GM projects, beat entities: planning state — see `EVENT_KINDS`. Absent/''
	 *  on anything that was simply recorded. */
	eventKind: 'loomEventKind',
	/** GM projects, beat entities: whether the beat actually happened at the
	 *  table. A `planned` event is speculative until this is ticked. */
	happened: 'loomHappened',
	/** GM projects, characters: preplanned lines / speech-style examples for an
	 *  NPC, one entry per line. Free-form text, no links resolved. */
	npcLines: 'loomNpcLines',
	/** Writer projects, acts: the title as it should appear in the exported
	 *  script. Fountain sections (`# Act`) are navigation-only and never
	 *  export, so an exported act/act title has to be emitted separately as
	 *  centered bold (`>**ACT ONE**<`); this field is what goes inside it. */
	displayTitle: 'loomDisplayTitle',
	/** Scenes only: the `[[loom:<id>]]` marker in the script's scene heading —
	 *  what ties this note to its slice of the .fountain file. Survives any
	 *  rename or reorder, which heuristic re-matching would not. */
	sceneId: 'loomSceneId',
	/** Scenes only: `INT.` / `EXT.` / … as parsed from the heading. It belongs to
	 *  the SCENE, not the location — the same house is INT. in one scene and
	 *  EXT. in the next. */
	sceneIntExt: 'loomSceneIntExt',
	/** Scenes only: trailing time of day from the heading (`DAY`, `NIGHT`, …). */
	sceneTime: 'loomSceneTime',
	/** Scenes only: link to the Location the heading names. A visible link, so
	 *  the scene connects to its place in the graph. */
	sceneLocation: 'loomSceneLocation',
	/** Scenes only: links to the Characters with a cue in this scene. Visible,
	 *  so the cast connects in the graph. Also carries any Character named via
	 *  an `@[...]` inline entity link in the scene's text, even one who never
	 *  gets a cue — merged in by `syncScenes`, same field either way. */
	sceneCast: 'loomSceneCast',
	/** Scenes only: links to the Factions named via `@[...]` in this scene's
	 *  text. Visible, so they connect in the graph. */
	sceneFactions: 'loomSceneFactions',
	/** Scenes only: links to the Items named via `@[...]` in this scene's
	 *  text. Visible, so they connect in the graph. */
	sceneItems: 'loomSceneItems',
	/** Scenes only: links to Locations named via `@[...]` in this scene's
	 *  text that AREN'T the scene's own heading location (`sceneLocation`
	 *  already covers that one) — a place merely mentioned or referenced,
	 *  not where the scene is set. Visible, so they connect in the graph. */
	sceneMentionedLocations: 'loomSceneMentionedLocations',
	/** Scenes only: link to the Act this scene belongs to — derived from the
	 *  `#` section enclosing it in the script. A scene's writing lives inside its
	 *  act's stretch of the script, so an actless scene has nowhere to be
	 *  stored. Visible, and it is what makes the scene stack under its act in
	 *  the graph and timeline (`buildColumns` takes any connection to an anchor). */
	sceneAct: 'loomSceneAct',
	/** Scenes only: the RAW loom id (not a link — there's no Branch note to
	 *  link to) of the branch-tagged section (`= branch: <id>`) this scene
	 *  sits under, or '' when it isn't in a branch. */
	sceneBranch: 'loomSceneBranch',
	/** Acts only: the `[[loom:<id>]]` marker on the script's `#` section
	 *  line. Same job as a scene's — it survives a rename or a move, where
	 *  matching the section text would not. */
	actId: 'loomActId',
	/** Chapters only: link to the Act this chapter belongs to — the
	 *  Writer/Prose analogue of `sceneAct`. Visible, so a chapter stacks
	 *  under its act in the graph and timeline, same mechanism. Currently
	 *  stamped directly at creation (no Book file to derive it from yet —
	 *  see ROADMAP's Prose-support entry); once the Book parser exists this
	 *  becomes derived the same way `sceneAct` is. */
	chapterAct: 'loomChapterAct',
	/** Chapters only: the `[[loom:<id>]]` marker on the Book file's `##`
	 *  section line — the Writer/Prose analogue of `sceneId`. Ties this note
	 *  to its slice of the Book file, surviving a rename/reorder. */
	chapterId: 'loomChapterId',
	/** Timeline definition files. */
	timelineTypes: 'loomTypes',
	/** Loom-managed creation timestamp (ISO 8601). Authoritative over the
	 *  filesystem ctime, which cloud-sync can overwrite with the sync time. */
	created: 'loomCreated',
	/** Loom-managed modification timestamp (ISO 8601), stamped on every edit. */
	modified: 'loomModified',
	/** Sessions only: `[[<daily note name>]]` for the calendar day this
	 *  session happened — a real link (ghost note if it doesn't exist yet),
	 *  so Obsidian's own native graph connects a session to its daily note
	 *  automatically. Formatted from the vault's configured Daily Notes date
	 *  format (falling back to Obsidian's own default, `YYYY-MM-DD`, if the
	 *  core plugin isn't enabled) — never assume every vault uses the same
	 *  format. Hidden from Loom's OWN graph/connections (`HIDDEN_LINK_KEYS`,
	 *  indexer.ts) — this is for Obsidian's native graph specifically. */
	dailyNote: 'loomDailyNote',
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
	// An unquoted `2026-07-29T10:00:00` can come back from a YAML parser as a
	// Date rather than a string. Reading that as "no timestamp" would make the
	// startup migration re-seed the field from the file stats on every load —
	// losing the real creation date and rewriting the note each time.
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
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

/** Role shown when a membership has no explicit role — never actually persisted to
 *  frontmatter (a default-role membership is stored as a bare link, no `role` key at
 *  all), so unlike `entityLabel`/`entityPlural` above this doesn't need a stored/
 *  compared value to stay locale-independent: every comparison against it reads the
 *  SAME live translation at the SAME instant, so a locale switch can't desync it
 *  against something written earlier under a different language. Still a function,
 *  not a module-level constant, for the same reason those two are — evaluated once at
 *  import time would freeze it at whatever locale was active on load. */
export function defaultMemberRole(): string {
	return t('project.createEntity.memberDefault');
}

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
	 *  fall back to `created` so unstamped entries stay chronological.
	 *  Acts order by this instead of by a date (`anchorOrder: 'sequence'`). */
	seq: number | null;
	/** Beat entities in a GM project: planning state, '' when none. */
	eventKind: EventKind | '';
	/** Beat entities in a GM project: whether it actually happened at the table. */
	happened: boolean;
	/** Characters in a GM project: preplanned lines / speech-style examples. */
	npcLines: string[];
	/** Acts: title as it should appear in the exported script; '' falls back
	 *  to the act's own name. */
	displayTitle: string;
	/** Scenes: the `[[loom:<id>]]` marker tying this note to its scene heading in
	 *  the script; '' for a scene note not (yet) backed by one. */
	sceneId: string;
	/** Scenes: `INT.` / `EXT.` / … from the heading. A property of the scene, not
	 *  of its location. */
	sceneIntExt: string;
	/** Scenes: time of day from the heading (`DAY`, `NIGHT`, …). */
	sceneTime: string;
	/** Scenes: linkpath of the Location the heading names, or ''. Visible link —
	 *  the scene connects to its place in the graph. */
	sceneLocation: string;
	/** Scenes: linkpaths of the Characters with a cue in this scene, in
	 *  first-appearance order. Visible links, so the cast connects in the graph. */
	sceneCast: string[];
	/** Scenes: linkpaths of the Factions named via `@[...]` in this scene's
	 *  text. Visible links, so they connect in the graph. */
	sceneFactions: string[];
	/** Scenes: linkpaths of the Items named via `@[...]` in this scene's
	 *  text. Visible links, so they connect in the graph. */
	sceneItems: string[];
	/** Scenes: linkpaths of Locations named via `@[...]` in this scene's text
	 *  that aren't the scene's own heading location (`sceneLocation`). Visible
	 *  links, so they connect in the graph. */
	sceneMentionedLocations: string[];
	/** Scenes: linkpath of the owning Act, or ''. */
	sceneAct: string;
	/** Scenes: the raw loom id (not a linkpath) of the branch-tagged section
	 *  this scene sits under, or '' when it isn't in a branch. */
	sceneBranch: string;
	/** Acts: the `[[loom:<id>]]` marker on their script section line. */
	actId: string;
	/** Chapters: linkpath of the owning Act, or ''. */
	chapterAct: string;
	/** Chapters: the `[[loom:<id>]]` marker on their Book section line. */
	chapterId: string;
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
		eventKind: '',
		happened: false,
		npcLines: [],
		displayTitle: '',
		sceneId: '',
		sceneIntExt: '',
		sceneTime: '',
		sceneLocation: '',
		sceneCast: [],
		sceneFactions: [],
		sceneItems: [],
		sceneMentionedLocations: [],
		sceneAct: '',
		sceneBranch: '',
		actId: '',
		chapterAct: '',
		chapterId: '',
		created: 0,
		modified: 0,
	};
}

/** How a quest can end; '' in `questOutcome` means it's still active. */
export const QUEST_OUTCOMES = ['completed', 'abandoned', 'failed'] as const;

/** Display text for a `questOutcome` value — every render site used to build this
 *  by capitalizing the raw English word (`o[0].toUpperCase() + o.slice(1)`), which
 *  reads correctly in English but never localizes; one shared function instead of
 *  six independent copies of the same capitalize hack. Takes a plain `string`
 *  (matching `EntityRecord.questOutcome`'s own storage type) rather than the
 *  narrower `QUEST_OUTCOMES` union — every call site already branches on `''`
 *  (still active) before reaching this, so it's only ever called with one of
 *  `QUEST_OUTCOMES`' real values in practice. */
export function questOutcomeLabel(outcome: string): string {
	return t(`entityType.quest.outcomes.${outcome}` as LocaleKey);
}

/**
 * GM planning state of a beat entity ('' = none, just something that happened).
 *
 * - `planned` — written ahead of the session; may or may not come to pass.
 * - `locked` — a planned beat that player action has ruled out for good (the
 *   NPC it needed is dead), kept on file rather than deleted.
 * - `improvised` — happened at the table without being planned, written up
 *   afterwards.
 *
 * Placeholder: the field is indexed, the UI that sets it isn't built yet.
 */
export const EVENT_KINDS = ['planned', 'locked', 'improvised'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
	return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
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
export const VIEW_SCRIPT = 'loom-loom-script';
export const VIEW_PROSE = 'loom-loom-prose';

/** Maps: a spatial drawing canvas where zones (polygons) are associated with
 *  locations. Lucide icon + the folders maps/images live under. Maps sit under
 *  `Entities/` beside the entity-type folders — they belong to the project's
 *  content, not next to it. */
export const MAPS_ICON = 'map';
export function mapsLabel(): string {
	return t('common.mapsLabel');
}
export const MAPS_FOLDER = 'Entities/Maps';
export const MAPS_IMAGES_FOLDER = `${MAPS_FOLDER}/Images`;

/**
 * Writer projects: the Fountain script lives in its own file at the project
 * root (`<Project>.fountain`), registered like the .loom home file rather than
 * stored as markdown. Two reasons it can't be a .md note: Fountain's note
 * syntax **is** `[[…]]`, so Obsidian would index every non-exporting script
 * note as a wikilink; and an own extension round-trips byte-for-byte with
 * external Fountain apps (Better Fountain, Highland, Fade In), which is what
 * makes "Open in external app" honest. Scenes and acts are parsed out of
 * it into their own entity notes — see `src/fountain.ts` for the parser and
 * `src/views/script-view.tsx`/`fountain-field.tsx` for the editor.
 */
export const SCRIPT_EXTENSION = 'fountain';
export function scriptLabel(): string {
	return t('common.scriptLabel');
}
export const SCRIPT_ICON = 'file-text';

/**
 * Writer/Prose: the Book lives in its own file at the project root
 * (`<Project>.loomprose`), the prose analogue of `SCRIPT_EXTENSION` — same
 * reasoning as Fountain: it carries hidden `[[loom:<id>]]` section markers
 * that would otherwise pollute Obsidian's wikilink index if this were a
 * plain `.md` note. Acts and Chapters are parsed out of it into their own
 * entity notes — see `src/prose.ts` for the parser and
 * `src/views/book-view.tsx`/`prose-field.tsx` for the editor. Takes the same
 * 12 o'clock home-wheel slot the Script satellite takes in Writer/Script —
 * the two sub-modes are mutually exclusive per project, so only one is ever
 * offered.
 */
export const BOOK_EXTENSION = 'loomprose';
export function bookLabel(): string {
	return t('common.bookLabel');
}
export const BOOK_ICON = 'book';

/** Comments and alternative-text bodies, keyed by the hidden `[[loom-comment:…]]`/
 *  `[[loom-alt:…]]` marker ids embedded in the script — never in the script
 *  itself (it has no frontmatter to hold them) and never on a Scene/Act
 *  note (a marked range can span a scene boundary or predate any note).
 *  Sits under `Entities/` beside the type folders, same reasoning as Maps. */
export const SCRIPT_NOTES_FOLDER = 'Entities/Script Notes';

/** Standard graph/map node sizes (radius px), pickable per node. */
export const NODE_SIZE_PRESETS = {
	small: 12,
	regular: 17,
	big: 24,
	'very-big': 34,
} as const;
export type NodeSizePreset = keyof typeof NODE_SIZE_PRESETS;
