import { ENTITY_TYPES, EntityType } from './types';
import { t } from './i18n';

/**
 * Project kinds — the per-project "mode" that reshapes the plugin for a
 * different workflow. Stored in the project's .loom config, picked at setup
 * and switchable afterwards.
 *
 * The rule this module exists to enforce: **a kind is a config layer over the
 * shared data model, never a fork.** Acts and Scenes are their own entity
 * types (they carry genuinely different fields from Sessions and Events), but
 * the shared machinery — chronological columns, graph layout, timeline strip,
 * list/entity page shells — never names a type literally. It asks for the
 * project's *role* types instead (`roleType(kind, 'anchor')`), so one
 * implementation serves both, and the parts that really do differ gate on
 * `features(kind)` rather than on `type === 'session'`.
 */

export const PROJECT_KINDS = ['player', 'gm', 'writer'] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const DEFAULT_PROJECT_KIND: ProjectKind = 'player';

export function isProjectKind(value: unknown): value is ProjectKind {
	return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** A Writer project's own sub-mode, picked at setup alongside `kind` and
 *  never both at once in one project (a Fountain script and a prose Book
 *  would need two coexisting anchor/beat chronologies in one project — see
 *  `roleType`'s doc comment for why that's deliberately not supported).
 *  Meaningless outside `kind === 'writer'`; every other kind ignores it. */
export const WRITER_MODES = ['script', 'prose'] as const;
export type WriterMode = (typeof WRITER_MODES)[number];
export const DEFAULT_WRITER_MODE: WriterMode = 'script';

export function isWriterMode(value: unknown): value is WriterMode {
	return typeof value === 'string' && (WRITER_MODES as readonly string[]).includes(value);
}

export interface ProjectKindMeta {
	label: string;
	/** Lucide icon name. */
	icon: string;
	/** One-line explanation shown in the setup modal and settings. */
	description: string;
}

export const PROJECT_KIND_META: Record<ProjectKind, ProjectKindMeta> = {
	player: {
		label: 'Player',
		icon: 'dices',
		description: 'Playing in a campaign: sessions you attended, tracked as they happen.',
	},
	gm: {
		label: 'Game Master',
		icon: 'drama',
		description: 'Running a campaign: plan events ahead, then record what actually happened.',
	},
	writer: {
		label: 'Writer',
		icon: 'feather',
		description: 'Writing a story or screenplay: acts and scenes, with a Fountain script.',
	},
};

/** `PROJECT_KIND_META[kind].label`/`.description` are the English source
 *  strings — every DISPLAY read should go through these instead, mirroring
 *  `entityLabel`/`entityPlural` in `types.ts`. */
export function projectKindLabel(kind: ProjectKind): string {
	return t(`projectKind.${kind}.label`);
}
export function projectKindDescription(kind: ProjectKind): string {
	return t(`projectKind.${kind}.description`);
}

/**
 * The structural role a type plays in the chronological layout: the `anchor`
 * owns a column (Session / Act), the `beat` stacks beneath one (Event /
 * Scene / Chapter). A type has exactly one role regardless of kind, so
 * record-only code can ask `roleOf(record.type)` without resolving a
 * project. Writer/Prose reuses the SAME anchor (`act`) Writer/Script uses —
 * a project is always exclusively one Writer sub-mode or the other, never
 * both, so there's no ambiguity within one project — with `chapter`
 * substituting for `scene` as the beat. Both Writer sub-modes are the
 * two-tier Act(anchor)/beat shape every other kind already has; neither
 * needs a third structural tier for "Book" (see `docs/ARCHITECTURE.md`/
 * `ROADMAP.md` for why Book itself isn't a chronology-layer entity).
 */
export type TypeRole = 'anchor' | 'beat';

const ROLE_TYPES: Record<ProjectKind, Record<TypeRole, EntityType>> = {
	player: { anchor: 'session', beat: 'event' },
	gm: { anchor: 'session', beat: 'event' },
	writer: { anchor: 'act', beat: 'scene' },
};
const WRITER_PROSE_ROLE_TYPES: Record<TypeRole, EntityType> = { anchor: 'act', beat: 'chapter' };

const TYPE_ROLES: Partial<Record<EntityType, TypeRole>> = {
	session: 'anchor',
	act: 'anchor',
	event: 'beat',
	scene: 'beat',
	chapter: 'beat',
};

/** The entity type playing `role` in this kind of project. `writerMode` only
 *  matters for `kind === 'writer'`; every other kind ignores it. */
export function roleType(kind: ProjectKind, role: TypeRole, writerMode: WriterMode = DEFAULT_WRITER_MODE): EntityType {
	if (kind === 'writer' && writerMode === 'prose') return WRITER_PROSE_ROLE_TYPES[role];
	return ROLE_TYPES[kind][role];
}

/** The role `type` plays, or null for types outside the chronological layout. */
export function roleOf(type: EntityType): TypeRole | null {
	return TYPE_ROLES[type] ?? null;
}

/** Every type playing `role` across all kinds — for code that must accept a
 *  record from any project without knowing its kind (e.g. link resolution). */
export const ANCHOR_TYPES: readonly EntityType[] = ENTITY_TYPES.filter((t) => TYPE_ROLES[t] === 'anchor');
export const BEAT_TYPES: readonly EntityType[] = ENTITY_TYPES.filter((t) => TYPE_ROLES[t] === 'beat');

/**
 * Which entity types exist in a kind of project. The registry in types.ts
 * holds every type the plugin knows; this is what a given project shows in its
 * nav rail, home wheel, create picker and graph filters. Types are listed in
 * display order.
 */
const KIND_TYPES: Record<ProjectKind, readonly EntityType[]> = {
	player: ['character', 'location', 'region', 'faction', 'item', 'quest', 'event', 'session'],
	gm: ['character', 'location', 'region', 'faction', 'item', 'quest', 'event', 'session'],
	writer: ['character', 'location', 'region', 'faction', 'item', 'quest', 'scene', 'act'],
};
const WRITER_PROSE_TYPES: readonly EntityType[] = ['character', 'location', 'region', 'faction', 'item', 'quest', 'chapter', 'act'];

export function typesFor(kind: ProjectKind, writerMode: WriterMode = DEFAULT_WRITER_MODE): readonly EntityType[] {
	if (kind === 'writer' && writerMode === 'prose') return WRITER_PROSE_TYPES;
	return KIND_TYPES[kind];
}

/** Whether `type` is part of this kind of project at all. */
export function hasType(kind: ProjectKind, type: EntityType, writerMode: WriterMode = DEFAULT_WRITER_MODE): boolean {
	return typesFor(kind, writerMode).includes(type);
}

/**
 * What a kind switches on. Every flag guards a block of UI or behaviour that
 * genuinely differs between workflows — never mere wording, which `typesFor`
 * and the type registry already cover.
 */
export interface KindFeatures {
	/** Session attendance (which PCs were present) and the PC-death gating that
	 *  hangs off it. Meaningless without a table of players. */
	attendance: boolean;
	/** The virtual "Group" (the party): its page, rail/home entries and the
	 *  Group option in involve pickers. Built on the PC tag, so party-only. */
	group: boolean;
	/** PC life state on the character page: Alive / Active and the death-session
	 *  picker. A cast member in a story isn't "away from the party", and their
	 *  death is a scene rather than a flag — so writer projects don't show it. */
	pcLifecycle: boolean;
	/** GM: event planning state — `planned` / `locked` / `improvised` plus the
	 *  `happened` tick. Placeholder; the fields are read, the UI isn't built. */
	eventPlanning: boolean;
	/** GM: preplanned NPC lines / speech-style examples on character pages.
	 *  Placeholder; the field is read, the UI isn't built. */
	npcLines: boolean;
	/** Writer/Script: the project's Fountain script and everything parsed out
	 *  of it. Writer/Prose has its own separate project-root file (the
	 *  Book, see `book` below) instead — the two are mutually exclusive, so
	 *  this is never true alongside `book`. */
	script: boolean;
	/** Writer/Prose: the project's Book file and everything parsed out of it
	 *  — the prose-grammar analogue of `script` above. Mutually exclusive
	 *  with it (never both true in one project). */
	book: boolean;
	/** Anchors are ordered by their date (sessions happen on a day) or by their
	 *  manual sequence (acts are ordered, not dated). */
	anchorOrder: 'date' | 'sequence';
}

const KIND_FEATURES: Record<ProjectKind, KindFeatures> = {
	player: {
		attendance: true,
		group: true,
		pcLifecycle: true,
		eventPlanning: false,
		npcLines: false,
		script: false,
		book: false,
		anchorOrder: 'date',
	},
	gm: {
		attendance: true,
		group: true,
		pcLifecycle: true,
		eventPlanning: true,
		npcLines: true,
		script: false,
		book: false,
		anchorOrder: 'date',
	},
	writer: {
		attendance: false,
		group: false,
		pcLifecycle: false,
		eventPlanning: false,
		npcLines: false,
		script: true,
		book: false,
		anchorOrder: 'sequence',
	},
};

/** `writerMode` only matters for `kind === 'writer'`: Prose flips `script`
 *  off and `book` on (no `.fountain` file/UI, a Book file/UI instead) —
 *  every other flag is the same for both Writer sub-modes. */
export function featuresOf(kind: ProjectKind, writerMode: WriterMode = DEFAULT_WRITER_MODE): KindFeatures {
	const base = KIND_FEATURES[kind];
	if (kind === 'writer' && writerMode === 'prose') return { ...base, script: false, book: true };
	return base;
}

/**
 * Convenience wrappers taking a project config directly. Typed structurally on
 * `{ kind, writerMode? }` so this module never has to import calendar.ts
 * (which imports this one). `undefined` falls back to the default kind, for
 * the handful of spots that render before a project has resolved.
 */
type KindHolder = { kind: ProjectKind; writerMode?: WriterMode } | undefined;

function kindOf(config: KindHolder): ProjectKind {
	return config?.kind ?? DEFAULT_PROJECT_KIND;
}

function writerModeOf(config: KindHolder): WriterMode {
	return config?.writerMode ?? DEFAULT_WRITER_MODE;
}

export function projectTypes(config: KindHolder): readonly EntityType[] {
	return typesFor(kindOf(config), writerModeOf(config));
}

export function projectHasType(config: KindHolder, type: EntityType): boolean {
	return hasType(kindOf(config), type, writerModeOf(config));
}

export function projectRoleType(config: KindHolder, role: TypeRole): EntityType {
	return roleType(kindOf(config), role, writerModeOf(config));
}

export function features(config: KindHolder): KindFeatures {
	return featuresOf(kindOf(config), writerModeOf(config));
}
