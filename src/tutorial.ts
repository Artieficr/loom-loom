import type { ProjectConfig } from './calendar';
import { parseProjectConfig, serializeProjectConfig } from './calendar';
import type { ProjectDef } from './indexer';
import type LoomLoomPlugin from './main';
import { editVaultFile } from './write-queue';

/**
 * The guided tutorial: an ordered chain of steps per project kind, its
 * progress kept in the project's .loom config so pausing (or closing
 * Obsidian) resumes at the same step. Views read the current step to show
 * their cue and mark what the spotlight leaves lit (`data-tutorial-target`);
 * each step completes on reaching a page or a state (see `advanceTutorial`'s
 * callers).
 */
export type TutorialStep =
	| 'openDoc'
	| 'fillTitle'
	| 'openOutline'
	| 'createAct'
	| 'openActOutline'
	| 'createBeat'
	| 'sceneIntExt'
	| 'sceneLocation'
	| 'openLocations'
	| 'locationRegion'
	| 'locationNotes'
	| 'locationItems'
	| 'locationSublocations'
	| 'locationRelationships'
	| 'openGraph'
	| 'graphSelect'
	| 'graphPanel'
	| 'graphBack'
	| 'graphFocus'
	| 'graphDrag'
	| 'graphPin'
	| 'graphUnpin'
	| 'graphFilter'
	| 'graphFilterInside'
	| 'graphViews'
	| 'graphTimeline'
	| 'graphTimelineClose'
	| 'graphAnimate'
	| 'graphCreate';

/** What kind of page a view is, for routing the user to the current step. */
export type TutorialPage =
	| 'home'
	| 'doc'
	| 'act'
	| 'actList'
	| 'scene'
	| 'sceneList'
	| 'beat'
	| 'location'
	| 'locationList'
	| 'graph'
	| 'entity'
	| 'other';

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
	'openDoc',
	'fillTitle',
	'openOutline',
	'createAct',
	'openActOutline',
	'createBeat',
	'sceneIntExt',
	'sceneLocation',
	'openLocations',
	'locationRegion',
	'locationNotes',
	'locationItems',
	'locationSublocations',
	'locationRelationships',
	'openGraph',
	'graphSelect',
	'graphPanel',
	'graphBack',
	'graphFocus',
	'graphDrag',
	'graphPin',
	'graphUnpin',
	'graphFilter',
	'graphFilterInside',
	'graphViews',
	'graphTimeline',
	'graphTimelineClose',
	'graphAnimate',
	'graphCreate',
];

/** The graph's steps — they need an act with a scene (chapter) in it, the
 *  one connection every project can be guided to make (`graphDetour`). */
export const GRAPH_STEPS: readonly TutorialStep[] = TUTORIAL_STEPS.slice(TUTORIAL_STEPS.indexOf('openGraph'));

/** Script-only steps: Prose has no title page and no scene heading, so its
 *  chain stops at the chapter. */
const SCRIPT_ONLY: readonly TutorialStep[] = [
	'fillTitle',
	'sceneIntExt',
	'sceneLocation',
	'openLocations',
	'locationRegion',
	'locationNotes',
	'locationItems',
	'locationSublocations',
	'locationRelationships',
];

export interface TutorialState {
	/** null = not started yet (the kind's first step). */
	step: TutorialStep | null;
	paused: boolean;
	/** Set on a detour back through the act/scene steps (`graphDetour`):
	 *  finishing "create or open a scene" returns here instead of going on. */
	returnTo?: TutorialStep;
}

/** The kind's chain. Player and GM have none yet — their tutorial flag is
 *  stored so their steps can start once they exist. */
export function tutorialSteps(config: ProjectConfig): TutorialStep[] {
	if (config.kind !== 'writer') return [];
	return config.writerMode === 'prose'
		? TUTORIAL_STEPS.filter((s) => !SCRIPT_ONLY.includes(s))
		: [...TUTORIAL_STEPS];
}

function stepOf(config: ProjectConfig): TutorialStep | null {
	const steps = tutorialSteps(config);
	const tut = config.tutorial;
	if (!tut || steps.length === 0) return null;
	const step = tut.step ?? steps[0];
	return steps.includes(step) ? step : null;
}

/** The step the user is on, or null when there's no running tutorial. */
export function currentTutorialStep(config: ProjectConfig | undefined): TutorialStep | null {
	if (!config || config.tutorial?.paused) return null;
	return stepOf(config);
}

/** A tutorial that's paused and can be continued. */
export function tutorialPaused(config: ProjectConfig | undefined): boolean {
	return !!config?.tutorial?.paused && stepOf(config) !== null;
}

/** Where each step happens. */
const STEP_PAGE: Record<TutorialStep, TutorialPage> = {
	openDoc: 'doc',
	fillTitle: 'doc',
	openOutline: 'doc',
	createAct: 'doc',
	openActOutline: 'act',
	createBeat: 'act',
	sceneIntExt: 'scene',
	sceneLocation: 'scene',
	// Done on arriving at a location's page (from the Locations list).
	openLocations: 'location',
	locationRegion: 'location',
	locationNotes: 'location',
	locationItems: 'location',
	locationSublocations: 'location',
	locationRelationships: 'location',
	openGraph: 'graph',
	graphSelect: 'graph',
	// Done on opening a node's page (double-click)…
	graphPanel: 'graph',
	// …and on coming back from it: on any entity page, its Back button.
	graphBack: 'entity',
	graphFocus: 'graph',
	graphDrag: 'graph',
	graphPin: 'graph',
	graphUnpin: 'graph',
	graphFilter: 'graph',
	graphFilterInside: 'graph',
	graphViews: 'graph',
	graphTimeline: 'graph',
	graphTimelineClose: 'graph',
	graphAnimate: 'graph',
	graphCreate: 'graph',
};

/** The list each record page is reached through. */
const LIST_OF: Partial<Record<TutorialPage, TutorialPage>> = {
	act: 'actList',
	scene: 'sceneList',
	location: 'locationList',
};

/**
 * How this page leads on to the step's page: `'here'` (it is that page),
 * `'list'` (it's the list the step's record page is opened from — light its
 * rows), `'wheel'` (home: light the satellite) or `'rail'` (light the side
 * rail's button for it, with Home lit as the other way there).
 */
export function tutorialRoute(step: TutorialStep, page: TutorialPage): 'here' | 'list' | 'wheel' | 'rail' {
	const target = STEP_PAGE[step];
	if (page === target) return 'here';
	if (page === LIST_OF[target]) return 'list';
	return page === 'home' ? 'wheel' : 'rail';
}

/** The rail button / home-wheel satellite (`script`, `book` or an entity
 *  type) that leads towards the step. */
export function tutorialRouteKey(step: TutorialStep, config: ProjectConfig): string {
	switch (STEP_PAGE[step]) {
		case 'act':
			return 'act';
		case 'scene':
			return 'scene';
		case 'location':
			return 'location';
		case 'graph':
		case 'entity':
			return 'graph';
		default:
			return config.writerMode === 'prose' ? 'book' : 'script';
	}
}

function writeTutorial(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	next: (config: ProjectConfig) => TutorialState | null | undefined
): Promise<boolean> {
	return editVaultFile(
		plugin.app,
		project.loomPath,
		(text) => {
			const config = parseProjectConfig(text);
			const tutorial = next(config);
			if (tutorial === undefined) return null;
			return serializeProjectConfig({ ...config, tutorial });
		},
		'project file'
	);
}

/**
 * The step whose completion ends the tutorial. None yet: while the chain is
 * still being built, finishing the last step leaves the user on it (so the
 * chain can be extended from there) instead of ending the tutorial.
 */
const FINAL_STEP: TutorialStep | null = null;

/**
 * Moves past `from` if that's the current step — idempotent, so every view
 * that sees the step completed can call it. Only `FINAL_STEP` ends the
 * tutorial; the chain's last step otherwise stays current.
 */
export function advanceTutorial(plugin: LoomLoomPlugin, project: ProjectDef, from: TutorialStep): void {
	if (currentTutorialStep(project.config) !== from) return;
	void writeTutorial(plugin, project, (config) => {
		if (currentTutorialStep(config) !== from) return undefined;
		if (from === FINAL_STEP) return null;
		// The end of a detour: back to where it was taken from.
		const returnTo = config.tutorial?.returnTo;
		if (from === 'createBeat' && returnTo) return { step: returnTo, paused: false };
		const steps = tutorialSteps(config);
		const next = steps[steps.indexOf(from) + 1];
		return next ? { step: next, paused: false } : undefined;
	});
}

/**
 * The graph's steps need an act with a scene (chapter) in it. When the
 * project has none — deleted during a pause — the tutorial goes back through
 * the act/scene steps first (from "create an act" when there's no act at all)
 * and returns to the graph's start once a scene is created or opened.
 */
export function graphDetour(plugin: LoomLoomPlugin, project: ProjectDef, hasAct: boolean): void {
	const step = currentTutorialStep(project.config);
	if (!step || !GRAPH_STEPS.includes(step)) return;
	void writeTutorial(plugin, project, (config) => {
		const current = currentTutorialStep(config);
		if (!current || !GRAPH_STEPS.includes(current)) return undefined;
		return { step: hasAct ? 'openActOutline' : 'createAct', paused: false, returnTo: 'openGraph' };
	});
}

/** Moves straight from `from` to `to` (a stretch walked elsewhere — the
 *  new-scene dialog covers the Scene page's heading steps). Resolves once
 *  written, so a caller can wait before opening the next page. */
export async function jumpTutorial(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	from: TutorialStep,
	to: TutorialStep
): Promise<void> {
	if (currentTutorialStep(project.config) !== from) return;
	await writeTutorial(plugin, project, (config) => {
		if (currentTutorialStep(config) !== from) return undefined;
		// A detour's scene ends it: back to where it was taken from.
		const target = from === 'createBeat' && config.tutorial?.returnTo ? config.tutorial.returnTo : to;
		return tutorialSteps(config).includes(target) ? { step: target, paused: false } : undefined;
	});
}

export function setTutorialPaused(plugin: LoomLoomPlugin, project: ProjectDef, paused: boolean): void {
	void writeTutorial(plugin, project, (config) =>
		config.tutorial ? { ...config.tutorial, paused } : undefined
	);
}
