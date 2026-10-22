import { App, Modal, setIcon } from 'obsidian';
import { iconSearchWords, t } from '../i18n';
import { LUCIDE_TAGS } from '../lucide-tags';
import { TABLER_ICONS } from '../tabler-icons';

/**
 * Icons for map markers — the Tabler subset the plugin registers (`tabler-*`,
 * tabler-icons.ts) and the place-like part of Obsidian's bundled Lucide set.
 * A curated catalogue comes first, then every Tabler icon, then the Lucide
 * icons in `LUCIDE_EXTRA`. Search words — what an icon shows and what it could
 * mark, so "tavern", "таверна", "beer" and "bed" all find the drink and bed
 * icons — live in each locale file's `iconSearch` section, and a search
 * matches every language's at once; each icon is also found by its name and
 * its own tags (Tabler's data, lucide-tags.ts). A bare id is Lucide's; Tabler
 * ids are written in full.
 */
const CATALOG: string[] = [
	// Homes and buildings
	'house',
	'hotel',
	'building',
	'building-2',
	'landmark',
	'castle',
	'church',
	'university',
	'school',
	'library',
	'hospital',
	'warehouse',
	'store',
	'factory',
	'tabler-tower',
	'tabler-building-castle',
	'tabler-building-fortress',
	'tabler-chess-rook',
	'tabler-building-estate',
	'tabler-building-cottage',
	'tabler-home',
	'tabler-building-community',
	'tabler-buildings',
	'tabler-building-church',
	'tabler-building-mosque',
	'tabler-torii',
	'tabler-building-monument',
	'tabler-building-arch',
	'tabler-building-bank',
	'tabler-building-store',
	'tabler-building-warehouse',
	'tabler-building-factory',
	'tabler-building-hospital',
	'tabler-building-stadium',
	'tabler-building-circus',
	'tabler-building-lighthouse',
	'tabler-building-bridge',
	'tabler-building-bridge-2',
	'tabler-building-tunnel',
	'tabler-windmill',
	'tabler-building-wind-turbine',
	'tabler-wall',
	'tabler-prison',
	'tower-control',
	'radio-tower',
	'tent',
	'tent-tree',
	'caravan',
	'door-open',
	'fence',
	'columns-3',
	'pyramid',
	'construction',
	// Taverns, food and drink
	'tabler-beer',
	'tabler-barrel',
	'tabler-glass-full',
	'tabler-mug',
	'beer',
	'hop',
	'wine',
	'bottle-wine',
	'martini',
	'bed',
	'bed-double',
	'bed-single',
	'utensils',
	'utensils-crossed',
	'coffee',
	'cup-soda',
	'cooking-pot',
	'chef-hat',
	'croissant',
	'cake',
	'pizza',
	'soup',
	'beef',
	'ham',
	'fish',
	'ice-cream-cone',
	// Crafts and work
	'hammer',
	'anvil',
	'tabler-hammer',
	'tabler-pick',
	'tabler-axe',
	'tabler-campfire',
	'tabler-crystal-ball',
	'tabler-wand',
	'tabler-script',
	'tabler-books',
	'tabler-candle',
	'flame',
	'flame-kindling',
	'pickaxe',
	'axe',
	'shovel',
	'wrench',
	'drill',
	'scissors',
	'shirt',
	'palette',
	'paintbrush',
	'flask-conical',
	'flask-round',
	'pill',
	'stethoscope',
	'heart-pulse',
	'scale',
	'gavel',
	'scroll',
	'book-open',
	'microscope',
	'telescope',
	'wand-sparkles',
	// Trade and money
	'tabler-treasure-chest',
	'tabler-moneybag',
	'tabler-crown',
	'tabler-diamond',
	'coins',
	'banknote',
	'vault',
	'piggy-bank',
	'hand-coins',
	'shopping-basket',
	'shopping-cart',
	'shopping-bag',
	'package',
	'container',
	'gem',
	'crown',
	// Water and travel
	'tabler-anchor',
	'tabler-ferry',
	'tabler-ship',
	'tabler-beach',
	'tabler-fountain',
	'tabler-road-sign',
	'anchor',
	'ship',
	'sailboat',
	'ship-wheel',
	'fishing-hook',
	'fishing-rod',
	'waves',
	'droplet',
	'bath',
	'road',
	'signpost',
	'milestone',
	'map',
	'compass',
	'flag',
	// Modern places and transport
	'tabler-gas-station',
	'tabler-car-garage',
	'tabler-bus-stop',
	'tabler-building-airport',
	'tabler-charging-pile',
	'fuel',
	'car',
	'car-front',
	'parking-circle',
	'bus',
	'train-track',
	'tram-front',
	'plane',
	'bike',
	'traffic-cone',
	'plug-zap',
	'zap',
	'server',
	'phone',
	'mail',
	'mailbox',
	'newspaper',
	'radio',
	'tv',
	'siren',
	'shield',
	'fire-extinguisher',
	'ambulance',
	'hard-hat',
	'forklift',
	// Leisure
	'drama',
	'theater',
	'clapperboard',
	'music',
	'guitar',
	'ticket',
	'ferris-wheel',
	'roller-coaster',
	'dices',
	'gamepad-2',
	'trophy',
	'dumbbell',
	'swords',
	'sword',
	'target',
	'crosshair',
	// Nature and farming
	'tabler-trees',
	'tabler-tree',
	'tabler-mushroom',
	'tabler-plant',
	'tabler-seedling',
	'tabler-clover',
	'tabler-leaf',
	'tabler-volcano',
	'tabler-mountain',
	'tabler-iceberg',
	'tabler-cactus',
	'trees',
	'tree-pine',
	'tree-deciduous',
	'tree-palm',
	'shrub',
	'sprout',
	'leaf',
	'leafy-green',
	'flower',
	'flower-2',
	'wheat',
	'tractor',
	'carrot',
	'apple',
	'grape',
	'cherry',
	'mountain',
	'mountain-snow',
	'snowflake',
	'sun',
	'moon',
	'cloud',
	// Animals
	'tabler-horse',
	'tabler-horseshoe',
	'tabler-deer',
	'tabler-dragon',
	'tabler-spider',
	'tabler-bat',
	'tabler-fish',
	'tabler-pig',
	'paw-print',
	'dog',
	'cat',
	'bird',
	'birdhouse',
	'rabbit',
	'squirrel',
	'turtle',
	'rat',
	'bug',
	'shell',
	// Danger and the dead
	'tabler-skull',
	'tabler-grave',
	'tabler-grave-2',
	'tabler-coffin',
	'tabler-ghost',
	'tabler-pumpkin-scary',
	'tabler-swords',
	'tabler-sword',
	'tabler-shield',
	'tabler-bow',
	'tabler-masks-theater',
	'tabler-tent',
	'skull',
	'ghost',
	'bone',
	'cross',
	'biohazard',
	'radiation',
	'bomb',
	// Generic markers
	'star',
	'eye',
	'key',
	'lock',
	'users',
	'person-standing',
];

/** Lucide icons outside the catalogue that still mark a place or a thing on
 *  a map. Every other Lucide icon (arrows, text formatting, files, charts,
 *  panels…) is never offered. */
const LUCIDE_EXTRA = `amphora antenna armchair atom award backpack baggage-claim balloon banana bandage barrel beaker bean
bell binoculars book bow-arrow box boxes brick-wall brick-wall-fire brick-wall-shield briefcase
briefcase-medical brush bubbles bus-front cable-car cake-slice candy candy-cane cannabis
car-taxi-front cctv chess-bishop chess-king chess-knight chess-pawn chess-queen chess-rook cigarette
citrus cloud-drizzle cloud-fog cloud-hail cloud-lightning cloud-moon cloud-moon-rain cloud-rain
cloud-rain-wind cloud-snow cloud-sun cloud-sun-rain cloudy clover club concierge-bell cookie dam
dessert donut door-closed door-closed-locked drafting-compass drone droplets drum drumstick earth
eclipse egg egg-fried ev-charger feather film fish-symbol flag-triangle-left flag-triangle-right
flashlight footprints gamepad gift glass-water globe goal graduation-cap hamburger hand-heart
hand-platter handshake haze heart heart-handshake helicopter hourglass house-heart ice-cream-bowl
kayak key-round lamp lamp-floor land-plot lectern library-big life-buoy lock-keyhole lollipop
luggage map-pin map-pin-house map-pinned matches medal megaphone mic-vocal milk moon-star motorbike
nut panda parking-meter parking-square party-popper piano pill-bottle pin plane-landing
plane-takeoff pocket-knife popcorn popsicle puzzle radar rainbow recycle rocket rocking-chair rose
route salad sandwich satellite satellite-dish scroll-text shield-half shower-head shrimp
signpost-big snail sofa solar-panel spade sparkles spool spotlight stamp stone sunrise sunset
syringe tablets test-tube test-tubes thermometer thermometer-snowflake thermometer-sun tickets
toilet tool-case toolbox toy-brick train-front train-front-tunnel triangle-alert truck umbrella
utility-pole van venetian-mask volleyball vote wand washing-machine waves-ladder wind worm annoyed
baby angry circle-user laugh meh frown smile user user-round asterisk astroid sparkle orbit
badge-alert badge-check badge-question-mark badge-x circle-alert circle-question-mark circle-star
circle-x circle-check octagon-alert octagon-x ban shield-alert shield-question-mark battery
battery-charging bot circuit-board brain brain-circuit bell-electric biceps-flexed bolt cog boom-box
speaker camera clock alarm-clock watch cpu memory-stick microchip database hard-drive cylinder cone
hexagon pentagon triangle octagon square diamond cuboid torus shapes keyboard laptop computer
monitor lamp-desk paperclip printer paint-bucket paint-roller spray-can videotape cassette-tape disc
wallet credit-card`
	.split(/\s+/)
	.map((id) => `lucide-${id}`);

/** A catalogue id as `getIcon` takes it. */
const fullId = (id: string) => (id.startsWith('tabler-') ? id : `lucide-${id}`);
/** An icon's own tags: Tabler's from its data, Lucide's from lucide-tags.ts. */
const tagsOf = (id: string) =>
	id.startsWith('tabler-') ? TABLER_ICONS[id.slice('tabler-'.length)]?.[1] ?? '' : LUCIDE_TAGS[id.slice('lucide-'.length)] ?? '';
/** Everything a search matches an icon by: its name, its tags, and its search
 *  words in every language (the locale files' `iconSearch`) — each word led by
 *  a space, so a query word matches a word's start ("star" finds "stars", not
 *  "restaurant"). */
const searchText = (id: string) =>
	` ${id.replace(/^(lucide|tabler)-/, '').replace(/-/g, ' ')} ${iconSearchWords(id)} ${tagsOf(id)}`
		.toLowerCase()
		.replace(/\s+/g, ' ');
/** Every offered icon in picker order — the catalogue, then every other Tabler
 *  icon, then `LUCIDE_EXTRA` — with its search text. */
const ICONS: [id: string, text: string][] = [
	...new Set([...CATALOG.map(fullId), ...Object.keys(TABLER_ICONS).map((name) => `tabler-${name}`), ...LUCIDE_EXTRA]),
].map((id) => [id, searchText(id)]);

/** Every offered icon with a word starting with each word of `query`. An
 *  empty query is all of them. */
export function searchIcons(query: string): string[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return ICONS.filter(([, text]) => terms.every((term) => text.includes(` ${term}`))).map(([id]) => id);
}

/** A searchable grid of icons; picking one (or "No icon", when one is set)
 *  closes it. */
export class IconPickerModal extends Modal {
	constructor(
		app: App,
		private current: string | null,
		private onPick: (id: string | null) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.containerEl.addClass('loom-modal-top');
		this.titleEl.setText(t('view.map.iconPicker.title'));
		const input = this.contentEl.createEl('input', {
			type: 'search',
			cls: 'loom-icon-search',
			attr: { placeholder: t('view.map.iconPicker.search') },
		});
		const grid = this.contentEl.createDiv({ cls: 'loom-icon-grid' });
		const render = () => {
			grid.empty();
			if (this.current) {
				const none = grid.createEl('button', { cls: 'loom-icon-tile', attr: { 'aria-label': t('view.map.iconPicker.none') } });
				setIcon(none, 'circle');
				none.onclick = () => this.pick(null);
			}
			const ids = searchIcons(input.value);
			if (ids.length === 0) grid.createDiv({ cls: 'loom-icon-empty', text: t('view.map.iconPicker.empty') });
			for (const id of ids) {
				const tile = grid.createEl('button', {
					cls: id === this.current ? 'loom-icon-tile is-active' : 'loom-icon-tile',
					attr: { 'aria-label': id.replace(/^lucide-/, 'Lucide: ').replace(/^tabler-/, 'Tabler: ') },
				});
				setIcon(tile, id);
				tile.onclick = () => this.pick(id);
			}
		};
		input.oninput = render;
		render();
		input.focus();
	}

	private pick(id: string | null): void {
		this.onPick(id);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
