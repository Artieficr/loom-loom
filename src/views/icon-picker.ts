import { App, Modal, getIconIds, setIcon } from 'obsidian';
import { t } from '../i18n';
import { TABLER_ICONS } from '../tabler-icons';

/**
 * Icons for map markers — Obsidian's bundled Lucide set plus the Tabler subset
 * the plugin registers (`tabler-*`, tabler-icons.ts). A curated catalogue
 * comes first, each icon with English and Russian search words, so "tavern",
 * "таверна", "beer" and "bed" all find the drink and bed icons; every other
 * icon is still found by its name (and a Tabler one by its own tags). A bare
 * id is Lucide's; Tabler ids are written in full.
 */
const CATALOG: [id: string, words: string][] = [
	// Homes and buildings
	['house', 'house home cottage hut building dwelling дом домик хижина изба здание жильё'],
	['hotel', 'mansion manor estate villa hotel inn building особняк усадьба поместье вилла отель гостиница здание'],
	['building', 'building office administration town hall guild здание офис администрация ратуша гильдия'],
	['building-2', 'building office tower block city здание офис многоэтажка город'],
	['landmark', 'temple hall court bank museum administration landmark building храм зал суд банк музей администрация здание'],
	['castle', 'castle tower fort fortress keep citadel palace building замок башня форт крепость цитадель дворец здание'],
	['church', 'temple church chapel shrine monastery abbey building храм церковь часовня святилище монастырь аббатство здание'],
	['university', 'university academy college school building университет академия колледж школа здание'],
	['school', 'school academy college building школа академия училище здание'],
	['library', 'library archive books scriptorium библиотека архив книги'],
	['hospital', 'hospital infirmary clinic healer building больница лазарет клиника лекарь здание'],
	['warehouse', 'warehouse storehouse depot barn granary building склад амбар хранилище здание'],
	['store', 'store shop market merchant trader building магазин лавка рынок торговец здание'],
	['factory', 'factory mill workshop industry building фабрика завод мельница мастерская промышленность здание'],
	['tabler-tower', 'tower watchtower keep turret башня дозорная донжон'],
	['tabler-building-castle', 'castle fortress keep palace building замок крепость дворец здание'],
	['tabler-building-fortress', 'fortress fort citadel stronghold building крепость форт цитадель твердыня здание'],
	['tabler-chess-rook', 'tower rook keep fort башня ладья донжон'],
	['tabler-building-estate', 'mansion manor estate villa building особняк усадьба поместье вилла здание'],
	['tabler-building-cottage', 'cottage house hut farmhouse building коттедж дом хижина изба здание'],
	['tabler-home', 'house home dwelling дом жильё'],
	['tabler-building-community', 'village town houses building деревня посёлок дома здание'],
	['tabler-buildings', 'city town district buildings город район здания'],
	['tabler-building-church', 'temple church chapel building храм церковь часовня здание'],
	['tabler-building-mosque', 'temple mosque building храм мечеть здание'],
	['tabler-torii', 'shrine temple gate torii святилище храм врата'],
	['tabler-building-monument', 'monument obelisk statue памятник обелиск монумент'],
	['tabler-building-arch', 'arch gate triumph арка ворота'],
	['tabler-building-bank', 'bank treasury building банк казна здание'],
	['tabler-building-store', 'store shop market building магазин лавка рынок здание'],
	['tabler-building-warehouse', 'warehouse storehouse barn building склад амбар здание'],
	['tabler-building-factory', 'factory workshop mill building фабрика завод мастерская здание'],
	['tabler-building-hospital', 'hospital infirmary building больница лазарет здание'],
	['tabler-building-stadium', 'stadium arena colosseum стадион арена колизей'],
	['tabler-building-circus', 'circus tent fair цирк шатёр ярмарка'],
	['tabler-building-lighthouse', 'lighthouse beacon coast маяк берег'],
	['tabler-building-bridge', 'bridge crossing мост переправа'],
	['tabler-building-bridge-2', 'bridge aqueduct мост акведук'],
	['tabler-building-tunnel', 'tunnel cave mine entrance туннель пещера вход в шахту'],
	['tabler-windmill', 'windmill mill farm мельница ветряная мельница ферма'],
	['tabler-building-wind-turbine', 'wind turbine power ветряк электростанция'],
	['tabler-wall', 'wall city wall fortification стена городская стена укрепление'],
	['tabler-prison', 'prison jail dungeon тюрьма темница'],
	['tower-control', 'tower watchtower lookout airport башня дозорная вышка аэропорт'],
	['radio-tower', 'tower radio mast antenna башня радио вышка антенна'],
	['tent', 'tent camp encampment shelter палатка лагерь стоянка шатёр'],
	['tent-tree', 'camp camping forest tent лагерь кемпинг лес палатка'],
	['caravan', 'caravan wagon trailer camp караван фургон повозка'],
	['door-open', 'door gate entrance дверь ворота вход'],
	['fence', 'fence wall farm yard pen забор стена ферма двор загон'],
	['columns-3', 'columns ruins temple колонны руины храм'],
	['pyramid', 'pyramid tomb monument ruin пирамида гробница памятник'],
	['construction', 'construction building site works стройка строительство'],
	// Taverns, food and drink
	['tabler-beer', 'beer ale tavern inn pub пиво эль таверна трактир паб food еда'],
	['tabler-barrel', 'barrel tavern brewery cellar storage бочка таверна пивоварня погреб склад food еда'],
	['tabler-glass-full', 'drink tavern bar glass выпивка таверна бар бокал food еда'],
	['tabler-mug', 'mug tavern tea кружка таверна чай food еда'],
	['beer', 'beer ale tavern inn pub bar drink brewery пиво эль таверна трактир корчма паб бар выпивка пивоварня food еда'],
	['hop', 'hop brewery beer tavern хмель пивоварня пиво таверна plant plants растение растения food еда'],
	['wine', 'wine tavern inn bar winery drink вино таверна трактир бар винодельня выпивка food еда'],
	['bottle-wine', 'wine bottle cellar winery tavern вино бутылка погреб винодельня таверна food еда'],
	['martini', 'bar cocktail drink tavern бар коктейль выпивка таверна food еда'],
	['bed', 'bed inn tavern rest sleep lodging кровать постоялый двор таверна отдых сон ночлег'],
	['bed-double', 'bed inn tavern lodging hotel кровать постоялый двор таверна ночлег гостиница'],
	['bed-single', 'bed barracks dormitory inn кровать казарма общежитие ночлег'],
	['utensils', 'food restaurant tavern kitchen eatery еда ресторан таверна кухня столовая food еда'],
	['utensils-crossed', 'restaurant canteen food ресторан столовая еда food еда'],
	['coffee', 'coffee cafe tea кофе кафе чай кофейня food еда'],
	['cup-soda', 'drink soda cafe напиток газировка кафе food еда'],
	['cooking-pot', 'kitchen cook food stew кухня повар еда похлёбка food еда'],
	['chef-hat', 'chef cook kitchen restaurant повар кухня ресторан food еда'],
	['croissant', 'bakery bread pastry пекарня хлеб выпечка food еда'],
	['cake', 'bakery cake sweets пекарня торт сладости food еда'],
	['pizza', 'pizza food пицца еда food еда'],
	['soup', 'soup food kitchen суп еда кухня food еда'],
	['beef', 'butcher meat мясник мясо food еда'],
	['ham', 'butcher meat ham мясник мясо окорок food еда'],
	['fish', 'fish fishmonger market рыба рыбная лавка рынок animal animals животное животные зверь food еда'],
	['ice-cream-cone', 'ice cream sweets мороженое сладости food еда'],
	// Crafts and work
	['hammer', 'smithy forge blacksmith hammer workshop carpenter кузница кузнец молот мастерская плотник'],
	['anvil', 'smithy forge blacksmith anvil кузница кузнец наковальня'],
	['tabler-hammer', 'smithy forge blacksmith hammer кузница кузнец молот'],
	['tabler-pick', 'mine quarry miner pickaxe шахта рудник карьер кирка'],
	['tabler-axe', 'lumber woodcutter axe лесоруб топор'],
	['tabler-campfire', 'campfire camp bonfire fire костёр лагерь огонь'],
	['tabler-crystal-ball', 'magic seer fortune teller witch магия провидец гадалка ведьма'],
	['tabler-wand', 'magic wizard mage магия волшебник маг'],
	['tabler-script', 'scroll scribe archive свиток писарь архив'],
	['tabler-books', 'library books school библиотека книги школа'],
	['tabler-candle', 'candle shrine chapel свеча святилище часовня'],
	['flame', 'forge fire hearth flame furnace кузница огонь очаг пламя печь'],
	['flame-kindling', 'campfire fire bonfire костёр огонь'],
	['pickaxe', 'mine quarry miner pickaxe шахта рудник карьер шахтёр кирка'],
	['axe', 'lumber woodcutter sawmill axe лесоруб лесопилка топор'],
	['shovel', 'dig grave farm shovel копать могила лопата'],
	['wrench', 'workshop repair mechanic garage мастерская ремонт механик гараж'],
	['drill', 'workshop drill tools мастерская дрель инструменты'],
	['scissors', 'tailor barber scissors портной цирюльник парикмахер ножницы'],
	['shirt', 'tailor clothes shop портной одежда'],
	['palette', 'artist painter studio художник мастерская'],
	['paintbrush', 'painter artist paint художник маляр'],
	['flask-conical', 'alchemist lab potion laboratory алхимик лаборатория зелье'],
	['flask-round', 'alchemy potion apothecary алхимия зелье аптекарь'],
	['pill', 'apothecary pharmacy medicine аптека аптекарь лекарство'],
	['stethoscope', 'doctor healer clinic врач лекарь клиника'],
	['heart-pulse', 'healer hospital health лекарь больница здоровье'],
	['scale', 'court justice judge суд правосудие судья весы'],
	['gavel', 'court judge law суд судья закон'],
	['scroll', 'scroll archive scribe library свиток архив писарь библиотека'],
	['book-open', 'library school study книга библиотека учёба'],
	['microscope', 'lab science research лаборатория наука исследование'],
	['telescope', 'observatory stars astronomer обсерватория звёзды астроном'],
	['wand-sparkles', 'magic wizard mage tower магия волшебник маг башня'],
	// Trade and money
	['tabler-treasure-chest', 'treasure chest loot hoard сокровище сундук клад'],
	['tabler-moneybag', 'money bank treasury trade деньги банк казна торговля'],
	['tabler-crown', 'royal palace king throne crown королевский дворец король трон корона'],
	['tabler-diamond', 'gem jeweller diamond mine драгоценность ювелир алмаз рудник'],
	['coins', 'bank money treasury mint coins банк деньги казна монетный двор монеты'],
	['banknote', 'bank money exchange банк деньги обмен'],
	['vault', 'bank vault treasury банк хранилище казна сейф'],
	['piggy-bank', 'bank savings банк сбережения'],
	['hand-coins', 'trade market merchant торговля рынок торговец'],
	['shopping-basket', 'market grocery shop рынок бакалея лавка'],
	['shopping-cart', 'shop supermarket store магазин супермаркет'],
	['shopping-bag', 'shop boutique store магазин бутик'],
	['package', 'goods trade delivery cargo товар торговля доставка груз'],
	['container', 'cargo port warehouse груз порт склад контейнер'],
	['gem', 'jeweller gem treasure mine ювелир драгоценность сокровище рудник'],
	['crown', 'royal palace king throne королевский дворец король трон корона'],
	// Water and travel
	['tabler-anchor', 'pier dock harbor port anchor пирс причал гавань порт якорь'],
	['tabler-ferry', 'ferry pier dock crossing паром пирс причал переправа'],
	['tabler-ship', 'ship port harbor dock корабль порт гавань причал'],
	['tabler-beach', 'beach coast shore sea пляж берег побережье море'],
	['tabler-fountain', 'fountain square plaza фонтан площадь'],
	['tabler-road-sign', 'signpost crossroads road указатель перекрёсток дорога'],
	['anchor', 'pier dock harbor port wharf anchor пирс причал гавань порт пристань якорь'],
	['ship', 'ship port harbor dock shipyard корабль порт гавань причал верфь'],
	['sailboat', 'boat pier dock harbor sail лодка пирс причал гавань парус'],
	['ship-wheel', 'ship harbor navy port штурвал корабль флот порт'],
	['fishing-hook', 'fishing pier fisher рыбалка пирс рыбак'],
	['fishing-rod', 'fishing pier lake рыбалка пирс озеро удочка'],
	['waves', 'water sea lake river beach вода море озеро река пляж'],
	['droplet', 'water well spring fountain вода колодец родник источник фонтан'],
	['bath', 'bath bathhouse spa баня купальня спа'],
	['road', 'road highway street дорога шоссе улица'],
	['signpost', 'crossroads signpost road перекрёсток указатель дорога'],
	['milestone', 'milestone road waypoint веха дорога путевой камень'],
	['map', 'map cartographer карта картограф'],
	['compass', 'navigator explorer compass навигатор исследователь компас'],
	['flag', 'outpost border camp flag застава граница лагерь флаг'],
	// Modern places and transport
	['tabler-gas-station', 'gas station fuel petrol заправка бензин топливо азс'],
	['tabler-car-garage', 'garage car service гараж автосервис'],
	['tabler-bus-stop', 'bus stop station остановка автобус'],
	['tabler-building-airport', 'airport terminal аэропорт терминал'],
	['tabler-charging-pile', 'charging station electric car зарядная станция электромобиль'],
	['fuel', 'gas station fuel petrol заправка бензин топливо азс'],
	['car', 'car garage parking dealer машина гараж парковка'],
	['car-front', 'car garage street машина гараж улица'],
	['parking-circle', 'parking car park парковка стоянка'],
	['bus', 'bus station stop автобус остановка автовокзал'],
	['train', 'train station railway поезд вокзал железная дорога'],
	['train-track', 'railway tracks rail железная дорога рельсы'],
	['tram-front', 'tram station трамвай остановка'],
	['plane', 'airport airfield plane аэропорт аэродром самолёт'],
	['bike', 'bike bicycle rental велосипед прокат'],
	['traffic-cone', 'roadworks construction дорожные работы стройка'],
	['plug-zap', 'power station electricity charging электростанция электричество зарядка'],
	['zap', 'power station electricity energy электростанция энергия электричество'],
	['server', 'data center server дата-центр сервер'],
	['phone', 'phone booth telephone телефон будка'],
	['mail', 'post office mail letters почта письма'],
	['mailbox', 'post mailbox почтовый ящик почта'],
	['newspaper', 'newspaper press printing газета типография пресса'],
	['radio', 'radio station broadcast радиостанция радио'],
	['tv', 'tv studio television телестудия телевидение'],
	['siren', 'police station emergency полиция участок тревога'],
	['shield', 'guard barracks police garrison стража казарма полиция гарнизон щит'],
	['fire-extinguisher', 'fire station firefighters пожарная часть пожарные'],
	['ambulance', 'ambulance hospital emergency скорая больница'],
	['hard-hat', 'construction workers site строители стройка'],
	['forklift', 'warehouse depot loading склад погрузка'],
	// Leisure
	['drama', 'theater theatre opera stage театр опера сцена'],
	['theater', 'theater cinema театр кинотеатр'],
	['clapperboard', 'cinema film studio кино киностудия'],
	['music', 'music hall concert bard музыка концерт бард'],
	['guitar', 'music bard musician музыка бард музыкант'],
	['ticket', 'tickets show circus билеты шоу цирк'],
	['ferris-wheel', 'fair amusement park ярмарка парк аттракционов колесо обозрения'],
	['roller-coaster', 'amusement park парк развлечений американские горки'],
	['dices', 'gambling casino dice game азартные игры казино кости'],
	['gamepad-2', 'games arcade игры аркада'],
	['trophy', 'arena stadium tournament арена стадион турнир'],
	['dumbbell', 'gym training ground спортзал тренировочная площадка'],
	['swords', 'arena battle duel training ground арена битва дуэль тренировочная площадка'],
	['sword', 'armory weapons blacksmith оружейная оружие'],
	['target', 'archery range target стрельбище мишень'],
	['crosshair', 'shooting range стрельбище'],
	// Nature and farming
	['tabler-trees', 'forest woods grove лес роща деревья plant plants растение растения'],
	['tabler-tree', 'tree park grove дерево парк роща plant plants растение растения'],
	['tabler-mushroom', 'mushroom forest grove гриб лес plant plants растение растения'],
	['tabler-plant', 'grass plant garden трава растение сад plant plants растение растения'],
	['tabler-seedling', 'grass sprout tuft field трава росток поле plant plants растение растения'],
	['tabler-clover', 'grass meadow clover луг клевер трава plant plants растение растения'],
	['tabler-leaf', 'leaf grass meadow лист трава луг plant plants растение растения'],
	['tabler-volcano', 'volcano mountain lava вулкан гора лава'],
	['tabler-mountain', 'mountain peak гора вершина'],
	['tabler-iceberg', 'iceberg ice glacier айсберг лёд ледник'],
	['tabler-cactus', 'desert cactus oasis пустыня кактус оазис plant plants растение растения'],
	['trees', 'forest woods grove лес роща чаща деревья plant plants растение растения'],
	['tree-pine', 'pine forest taiga fir сосна ель хвойный лес тайга plant plants растение растения'],
	['tree-deciduous', 'tree oak park дерево дуб парк plant plants растение растения'],
	['tree-palm', 'palm tropics beach oasis пальма тропики пляж оазис plant plants растение растения'],
	['shrub', 'grass bush tuft meadow shrub трава куст луг кустарник plant plants растение растения'],
	['sprout', 'grass tuft sprout garden field трава росток сад поле plant plants растение растения'],
	['leaf', 'grass garden leaf meadow трава сад лист луг plant plants растение растения'],
	['leafy-green', 'garden vegetables herbs огород овощи травы plant plants растение растения'],
	['flower', 'garden flowers meadow сад цветы луг plant plants растение растения'],
	['flower-2', 'garden flower park сад цветок парк plant plants растение растения'],
	['wheat', 'farm field wheat grain mill ферма поле пшеница зерно мельница plant plants растение растения'],
	['tractor', 'farm tractor field ферма трактор поле'],
	['carrot', 'farm vegetables garden ферма овощи огород plant plants растение растения food еда'],
	['apple', 'orchard fruit garden сад фрукты яблоко plant plants растение растения food еда'],
	['grape', 'vineyard grapes winery виноградник виноград винодельня plant plants растение растения food еда'],
	['cherry', 'orchard fruit cherry сад фрукты вишня plant plants растение растения food еда'],
	['mountain', 'mountain peak hill гора вершина холм'],
	['mountain-snow', 'mountain snow peak гора снег вершина'],
	['snowflake', 'ice frost winter cold лёд мороз зима холод'],
	['sun', 'sun desert sunny солнце пустыня'],
	['moon', 'moon night shrine луна ночь святилище'],
	['cloud', 'sky cloud небо облако'],
	// Animals
	['tabler-horse', 'stable horse ranch конюшня лошадь ранчо animal animals животное животные зверь'],
	['tabler-horseshoe', 'stable smithy horseshoe конюшня кузница подкова animal animals животное животные зверь'],
	['tabler-deer', 'deer hunting forest олень охота лес animal animals животное животные зверь'],
	['tabler-dragon', 'dragon lair danger дракон логово опасность animal animals животное животные зверь'],
	['tabler-spider', 'spider cave lair danger паук пещера логово animal animals животное животные зверь'],
	['tabler-bat', 'bat cave night летучая мышь пещера ночь animal animals животное животные зверь'],
	['tabler-fish', 'fish fishmonger fishing рыба рыбная лавка рыбалка animal animals животное животные зверь'],
	['tabler-pig', 'pig farm pigsty свинья ферма свинарник animal animals животное животные зверь'],
	['paw-print', 'stable kennel animals zoo конюшня псарня животные зоопарк animal animals животное животные зверь'],
	['dog', 'kennel dog pet псарня собака animal animals животное животные зверь'],
	['cat', 'cat pet кошка animal animals животное животные зверь'],
	['bird', 'bird aviary rookery птица птичник гнездовье animal animals животное животные зверь'],
	['birdhouse', 'birdhouse aviary dovecote скворечник птичник голубятня animal animals животное животные зверь'],
	['rabbit', 'rabbit farm hutch кролик ферма animal animals животное животные зверь'],
	['squirrel', 'squirrel forest белка лес animal animals животное животные зверь'],
	['turtle', 'turtle pond черепаха пруд animal animals животное животные зверь'],
	['rat', 'rat sewer undercity крыса канализация animal animals животное животные зверь'],
	['bug', 'insects swamp насекомые болото animal animals животное животные зверь'],
	['shell', 'shell beach coast ракушка пляж берег animal animals животное животные зверь'],
	// Danger and the dead
	['tabler-skull', 'danger dungeon lair death skull опасность подземелье логово смерть череп'],
	['tabler-grave', 'grave cemetery tomb могила кладбище гробница'],
	['tabler-grave-2', 'grave cemetery tombstone могила кладбище надгробие'],
	['tabler-coffin', 'coffin crypt undertaker гроб склеп гробовщик'],
	['tabler-ghost', 'haunted ghost spirit призрак дух'],
	['tabler-pumpkin-scary', 'haunted spooky witch жуткое ведьма тыква'],
	['tabler-swords', 'arena battle duel battlefield арена битва дуэль поле боя'],
	['tabler-sword', 'armory weapons оружейная оружие'],
	['tabler-shield', 'guard barracks garrison стража казарма гарнизон щит'],
	['tabler-bow', 'archery hunter bow стрельбище охотник лук'],
	['tabler-masks-theater', 'theater stage opera театр сцена опера'],
	['tabler-tent', 'tent camp шатёр лагерь палатка'],
	['skull', 'danger dungeon lair death skull опасность подземелье логово смерть череп'],
	['ghost', 'haunted ghost spirit crypt призрак дух склеп'],
	['bone', 'graveyard bones crypt кладбище кости склеп'],
	['cross', 'grave cemetery graveyard tomb могила кладбище гробница крест'],
	['biohazard', 'plague danger poison чума опасность яд'],
	['radiation', 'radiation danger zone радиация опасная зона'],
	['bomb', 'explosives danger bomb взрывчатка опасность бомба'],
	// Generic markers
	['star', 'important capital star важное столица звезда'],
	['eye', 'lookout watch secret дозор наблюдение тайна'],
	['key', 'key secret locked ключ тайна запертый'],
	['lock', 'locked prison jail запертый тюрьма темница'],
	['users', 'people guild meeting люди гильдия собрание'],
	['person-standing', 'person npc resident человек житель'],
];

/** A catalogue id as `getIcon` takes it. */
const fullId = (id: string) => (id.startsWith('tabler-') ? id : `lucide-${id}`);
const CATALOG_IDS = new Set(CATALOG.map(([id]) => fullId(id)));
/** Bundled icons never offered: duplicates of one in the catalogue. */
const HIDDEN = new Set(['lucide-home']);

/** Icons whose id or search words match every word of `query`, catalogue
 *  first — then every other bundled icon whose name matches. An empty query
 *  is the whole catalogue. */
export function searchIcons(query: string): string[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (text: string) => terms.every((term) => text.includes(term));
	const out = CATALOG.filter(([id, words]) => !terms.length || matches(`${id} ${words}`)).map(([id]) => fullId(id));
	if (!terms.length) return out;
	for (const id of getIconIds()) {
		if (CATALOG_IDS.has(id) || HIDDEN.has(id) || !/^(lucide|tabler)-/.test(id)) continue;
		const name = id.replace(/^(lucide|tabler)-/, '');
		const tags = id.startsWith('tabler-') ? TABLER_ICONS[name]?.[1] ?? '' : '';
		if (matches(`${name.replace(/-/g, ' ')} ${tags}`)) out.push(id);
	}
	return out;
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
