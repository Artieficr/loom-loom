# Loom Loom! (WIP, not release ready)

Worldbuilding inside Obsidian for your writing or TTGRPG games.
`Loom Loom!` tracks your characters, locations, factions, items, events, and game sessions — shows Obsidian style connections, and weaves everything into a session timeline anda layered story graph.

## Features (v0.1)

- **Project scaffolding** — pick a folder; the plugin creates the entity and timeline
  structure inside it. Multiple projects can coexist in one vault (one active at a time).
- **Entities as plain notes** — every entity is a normal `.md` file with YAML
  frontmatter. Native `[[wikilinks]]` everywhere, so Obsidian's backlinks and graph keep
  working. No plugin lock-in: delete the plugin and your notes are still just notes.
- **Typed relationships** — declared in frontmatter (`- type: ally`,
  `target: "[[Sam]]"`), visible from both sides like backlinks.
- **Home & list views** — browse each entity type with search, sort, and plugin-tag
  filters (PC/NPC/Cast out of the box, configurable per type).
- **Timeline** — sessions and events ordered by date, with events nested under their
  linked session. Multiple timelines per project via small definition files. The date
  model is calendar-agnostic, ready for custom in-game calendars.
- **Story graph** — a custom layered graph: sessions and events in chronological rows,
  characters and other entities on their own axis below, pulled toward what they connect
  to. Drag nodes (they spring back), click one to dim everything unconnected and inspect
  its connections in a side panel.

## Usage

1. Run **Set up project** (or open the home view from the dice ribbon icon) and pick a
   project folder.
2. Create entities from the home page, list views, or the `Create …` commands.
3. Link events to sessions via the `linkedSession` frontmatter field (one link or a
   list — an event can span several sessions); add typed relationships in the
   `relationships` list.
4. Open the timeline and graph from home.

All your worldbuilding data stays local in your vault, in plain `.md` files — your notes,
entities, and relationships are never transmitted anywhere. The plugin makes a network
request only when checking an entered license key against the licensing provider (see
Pricing below); nothing else in the plugin calls out to the network.

## Pricing

Free: one project of each kind (Player/GM/Writer) per vault, with every feature
available — no trial, no time limit, no feature gating on the free tier beyond the
project-count cap. A one-time license key purchase (not a subscription) unlocks
unlimited projects of every kind, activatable on up to 3 devices.

## License

[PolyForm Shield 1.0.0 © Artyom Tsoy](https://github.com/Artieficr/loom-loom/blob/main/LICENSE.txt)