# Loom Loom!

Worldbuilding inside Obsidian for your writing or TTRPG games. `Loom Loom!` tracks your characters, locations, factions, items, quests, events, and game sessions — shows Obsidian-style connections, and weaves everything into a session timeline and a layered story graph. A dedicated **Writer** mode adds a real Fountain screenplay editor; a **Maps** view adds a spatial drawing canvas for your world.

📖 **[Full documentation is on the wiki](https://github.com/Artieficr/loom-loom/wiki)** — this README stays a short pitch and feature list; the wiki has the how and why for everything, kept up to date as features ship.

## Features

- **Project scaffolding** — pick a folder; the plugin creates the entity and timeline structure inside it. Multiple projects can coexist in one vault, each a **Player**, **Game Master**, or **Writer** project. See [Project Kinds](https://github.com/Artieficr/loom-loom/wiki/Project-Kinds).
- **Entities as plain notes** — every entity is a normal `.md` file with YAML frontmatter. Native `[[wikilinks]]` everywhere, so Obsidian's backlinks and graph keep working. No plugin lock-in: delete the plugin and your notes are still just notes. See [Entities & Relationships](https://github.com/Artieficr/loom-loom/wiki/Entities-and-Relationships).
- **Timeline & story graph** — sessions/acts and their events/scenes in chronological order, plus a custom layered graph pulling every other entity toward what it connects to. See [Timeline & Graph](https://github.com/Artieficr/loom-loom/wiki/Timeline-and-Graph).
- **Maps** — a spatial drawing canvas: zones, roads, multi-page maps, background images, and an in-map connections graph. See [Maps](https://github.com/Artieficr/loom-loom/wiki/Maps).
- **Writer mode** — a real Fountain screenplay editor, with acts/scenes kept in sync with the script automatically, PDF export, narrative branching, and script comments/alternative text. See [Writer Mode](https://github.com/Artieficr/loom-loom/wiki/Writer-Mode).
- **Quests** — tracked as their own entity, resolving against sessions or scenes depending on project kind. See [Quests](https://github.com/Artieficr/loom-loom/wiki/Entities-and-Relationships#quests).

## Getting started

See [Getting Started](https://github.com/Artieficr/loom-loom/wiki/Getting-Started) on the wiki for installation and setting up your first project.

All your worldbuilding data stays local in your vault, in plain `.md` files — your notes, entities, and relationships are never transmitted anywhere. The plugin makes a network request only when checking an entered license key against the licensing provider (see Pricing below); nothing else in the plugin calls out to the network.

## Disclaimer

Hey, my name is Artie and I'm not a Software Engineer.

I can't code. 
I had design and tools ideas that I'd like to use myself.
Then I went to Anthropic, paid them for Claude Code, and then Claude Code created this plugin under my supervision.

I don't think LLM coding is a tool — it's a whole service.
And I couldn't afford to pay a human coder for the same service.
I also did not find a capacity to learn to code myself for such a big project, since I have different priorities (I'd love to learn to code one day).
But I could afford a monthly subscription.

I don't want to trick anybody — I wouldn't be able to release this plugin without an LLM.
As much as I'm against AI in the creative area, I acknowledge that coding has its own creativity in it, and I want to apologize to Software Engineers for my hypocrisy.
I just hope that all creativity that this plugin will help to shape and to pour into the world by its users can compensate the theft behind its code-writing process.

As much as AI changes the world and not generally in a good direction — it still provides opportunities for fair people and responsible use.

I encourage you, and myself, to keep creativity human.
Write great stories, share them with other people and remember who you are, and why you do what you do.

## Pricing

Free: one project of each kind (Player/GM/Writer) per vault, with every feature available — no trial, no time limit, no feature gating on the free tier beyond the project-count cap.

A one-time license key purchase (not a subscription) unlocks unlimited projects of every kind, activatable on up to 3 devices. Details: [Licensing & Pricing](https://github.com/Artieficr/loom-loom/wiki/Licensing-and-Pricing).

Since the project is open source, you can still break it down and cut out the license-key mechanism, build the plugin and use it without any limitations on your machine — I can't prevent it, nor do I intend to.

I've invested a good amount of hours trying to tinker with the plugin's functionality to reflect my vision and the features I needed.
And I'll gladly try to implement things that users will ask to add.
All I want is to be fairly compensated if `Loom Loom!` serves you well.
But I have no hard feelings if you decide to bypass a paywall. It's not an encouragement, just you do you.

## License

[PolyForm Shield 1.0.0 © Artyom Tsoy](https://github.com/Artieficr/loom-loom/blob/main/LICENSE.txt)
