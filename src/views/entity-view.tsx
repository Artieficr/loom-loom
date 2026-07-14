import { Notice, TFile, normalizePath } from 'obsidian';
import { ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ENTITY_META, VIEW_ENTITY, VIEW_LIST } from '../types';
import { CreateEntityModal, sanitizeFileName, sessionFileName } from '../project';
import { LoomFileReactView } from './react-view';
import { recordLabel } from './common';
import { LinkTextarea } from './link-textarea';
import { useIndexVersion } from './hooks';
import type LoomLoomPlugin from '../main';

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

/**
 * Entity page: a structured form over an entity's .md file, opened by every
 * loom-internal click. The file stays a normal markdown note — opening it
 * from the file explorer still gives the raw editor, and [[wikilinks]] typed
 * in any field connect exactly like links in any other note.
 */
export class EntityView extends LoomFileReactView {
	getViewType(): string {
		return VIEW_ENTITY;
	}

	getDisplayText(): string {
		if (!this.file) return 'Entity';
		const record = this.plugin.indexer.get(this.file.path);
		if (!record) return this.file.basename;
		const project = this.plugin.indexer.getProjectByRoot(record.project) ?? null;
		return recordLabel(record, project);
	}

	getIcon(): string {
		const record = this.file ? this.plugin.indexer.get(this.file.path) : undefined;
		return record ? ENTITY_META[record.type].icon : 'file';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === 'md';
	}

	async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <EntityPage key={this.file?.path ?? ''} view={this} />;
	}
}

function useFrontmatterWriter(plugin: LoomLoomPlugin, file: TFile | null) {
	return useMemo(
		() => (apply: (fm: Record<string, unknown>) => void) => {
			if (!file) return;
			plugin.app.fileManager.processFrontMatter(file, apply).catch((e) => {
				console.error('Loom Loom: failed to update frontmatter', e);
				new Notice('Could not save the change.');
			});
		},
		[plugin, file]
	);
}

interface RelationshipDraft {
	type: string;
	target: string;
}

function EntityPage({ view }: { view: EntityView }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const file = view.file;
	const record = file ? plugin.indexer.get(file.path) : undefined;
	const project = record ? plugin.indexer.getProjectByRoot(record.project) ?? null : null;
	const writeFm = useFrontmatterWriter(plugin, file);
	const datalistId = useId();

	// Drafts are seeded once per file (component is keyed by path) so index
	// updates triggered by our own saves never clobber what's being typed.
	const [name, setName] = useState(record?.name ?? '');
	const [description, setDescription] = useState(record?.description ?? '');
	const [role, setRole] = useState(record?.role ?? '');
	const [date, setDate] = useState(record?.date?.raw ?? '');
	const [relationships, setRelationships] = useState<RelationshipDraft[]>(
		record?.relationships.map((r) => ({ type: r.type, target: r.linkpath })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);

	// A freshly created note opens before metadataCache has indexed it, so the
	// record can arrive one tick after mount — seed the drafts then.
	const seeded = useRef(record !== undefined);
	useEffect(() => {
		if (!record || seeded.current) return;
		seeded.current = true;
		setName(record.name);
		setDescription(record.description);
		setRole(record.role);
		setDate(record.date?.raw ?? '');
		setRelationships(record.relationships.map((r) => ({ type: r.type, target: r.linkpath })));
	}, [record]);

	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		void plugin.app.vault.cachedRead(file).then((data) => {
			if (!cancelled) setBody(data.replace(FRONTMATTER_RE, ''));
		});
		return () => {
			cancelled = true;
		};
	}, [plugin, file]);

	// Project entities first (alphabetical), then the rest of the vault.
	const linkNames = useMemo(() => {
		const entityNames = record
			? plugin.indexer
					.getAll(undefined, record.project)
					.map((r) => r.name)
					.sort((a, b) => a.localeCompare(b))
			: [];
		const seen = new Set(entityNames);
		const rest = plugin.app.vault
			.getMarkdownFiles()
			.map((f) => f.basename)
			.filter((n) => !seen.has(n));
		return [...entityNames, ...rest];
	}, [plugin, record, version]);

	const saveBody = useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				void plugin.app.vault.process(file, (data) => {
					const m = FRONTMATTER_RE.exec(data);
					return (m ? m[0] : '') + value;
				});
			}, 600);
		};
	}, [plugin, file]);

	if (!file || !record) {
		return (
			<div className="loom-entity loom-empty">
				<p>Loading… If this note is not a Loom Loom entity (no `type` frontmatter), it has no entity page.</p>
				<button onClick={() => view.navigateTo('markdown', { file: file?.path })}>Open as markdown</button>
			</div>
		);
	}

	const isSession = record.type === 'session';
	const vocab = plugin.settings.tagVocabulary[record.type];
	const allTags = [...new Set([...vocab, ...record.pluginTags])];
	const sessions = project ? plugin.indexer.getAll('session', project.root) : [];
	const linkedSession = plugin.indexer.resolveLinkedSession(record);
	const targetNames = project
		? plugin.indexer.getAll(undefined, project.root).map((r) => r.name)
		: [];

	const commitName = async () => {
		const base = sanitizeFileName(name);
		if (base === '' || base === record.name) {
			setName(record.name);
			return;
		}
		const parent = file.parent?.path ?? '';
		const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
		if (plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice('A note with that name already exists.');
			setName(record.name);
			return;
		}
		await plugin.app.fileManager.renameFile(file, newPath);
	};

	const commitDate = async () => {
		const value = date.trim();
		writeFm((fm) => {
			fm.date = value;
		});
		if (isSession && project && value !== '') {
			const base = sessionFileName(project, value);
			const parent = file.parent?.path ?? '';
			const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			if (newPath !== file.path && !plugin.app.vault.getAbstractFileByPath(newPath)) {
				await plugin.app.fileManager.renameFile(file, newPath);
			}
		}
	};

	const commitRelationships = (next: RelationshipDraft[]) => {
		setRelationships(next);
		writeFm((fm) => {
			fm.relationships = next
				.filter((r) => r.target.trim() !== '')
				.map((r) => ({ type: r.type.trim() === '' ? 'related' : r.type.trim(), target: `[[${r.target.trim()}]]` }));
		});
	};

	const toggleTag = (tag: string) => {
		const next = record.pluginTags.includes(tag)
			? record.pluginTags.filter((t) => t !== tag)
			: [...record.pluginTags, tag];
		writeFm((fm) => {
			fm.pluginTags = next;
		});
	};

	return (
		<div className="loom-entity">
			<div className="loom-entity-header">
				<button
					className="loom-nav-btn"
					onClick={() =>
						view.navigateTo(VIEW_LIST, { entityType: record.type, project: record.project })
					}
				>
					← {ENTITY_META[record.type].plural}
				</button>
				<span className="loom-chip">{ENTITY_META[record.type].label}</span>
				<div className="loom-shell-spacer" />
				<button
					className="loom-nav-btn"
					onClick={() => view.navigateTo('markdown', { file: file.path })}
				>
					Open as markdown
				</button>
			</div>

			{!isSession ? (
				<label className="loom-field">
					<span className="loom-field-label">Name</span>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => void commitName()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitName();
						}}
					/>
				</label>
			) : null}

			{record.type === 'event' || isSession ? (
				<label className="loom-field">
					<span className="loom-field-label">Date</span>
					<input
						type="text"
						placeholder="2026-07-14"
						value={date}
						onChange={(e) => setDate(e.target.value)}
						onBlur={() => void commitDate()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitDate();
						}}
					/>
				</label>
			) : null}

			<label className="loom-field">
				<span className="loom-field-label">Description</span>
				<textarea
					rows={3}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					onBlur={() =>
						writeFm((fm) => {
							fm.description = description;
						})
					}
				/>
			</label>

			{allTags.length > 0 ? (
				<div className="loom-field">
					<span className="loom-field-label">Tags</span>
					<div className="loom-tag-row">
						{allTags.map((tag) => (
							<button
								key={tag}
								className={record.pluginTags.includes(tag) ? 'loom-chip loom-chip-on' : 'loom-chip'}
								onClick={() => toggleTag(tag)}
							>
								{tag}
							</button>
						))}
					</div>
				</div>
			) : null}

			{record.type === 'character' ? (
				<label className="loom-field">
					<span className="loom-field-label">Role</span>
					<input
						type="text"
						value={role}
						onChange={(e) => setRole(e.target.value)}
						onBlur={() =>
							writeFm((fm) => {
								fm.role = role;
							})
						}
					/>
				</label>
			) : null}

			{record.type === 'event' ? (
				<label className="loom-field">
					<span className="loom-field-label">Linked session</span>
					<select
						className="dropdown"
						value={linkedSession?.name ?? ''}
						onChange={(e) => {
							const value = e.target.value;
							if (value === '__create__') {
								// Controlled select snaps back to the current link;
								// the new session is written once the modal creates it.
								if (project) {
									new CreateEntityModal(plugin, 'session', project, (created) => {
										writeFm((fm) => {
											fm.linkedSession = `[[${created.basename}]]`;
										});
									}).open();
								}
								return;
							}
							writeFm((fm) => {
								fm.linkedSession = value === '' ? '' : `[[${value}]]`;
							});
						}}
					>
						<option value="">—</option>
						{sessions.map((s) => (
							<option key={s.path} value={s.name}>
								{recordLabel(s, project)}
							</option>
						))}
						{project ? <option value="__create__">+ New session…</option> : null}
					</select>
				</label>
			) : null}

			<div className="loom-field">
				<span className="loom-field-label">Relationships</span>
				<datalist id={datalistId}>
					{targetNames.map((n) => (
						<option key={n} value={n} />
					))}
				</datalist>
				{relationships.map((rel, i) => (
					<div key={i} className="loom-rel-row">
						<input
							type="text"
							className="loom-rel-type"
							placeholder="ally, parent-of…"
							value={rel.type}
							onChange={(e) => {
								const next = [...relationships];
								next[i] = { ...rel, type: e.target.value };
								setRelationships(next);
							}}
							onBlur={() => commitRelationships(relationships)}
						/>
						<input
							type="text"
							className="loom-rel-target"
							placeholder="Target note"
							list={datalistId}
							value={rel.target}
							onChange={(e) => {
								const next = [...relationships];
								next[i] = { ...rel, target: e.target.value };
								setRelationships(next);
							}}
							onBlur={() => commitRelationships(relationships)}
						/>
						<button
							className="loom-nav-btn"
							aria-label="Remove relationship"
							onClick={() => commitRelationships(relationships.filter((_, j) => j !== i))}
						>
							✕
						</button>
					</div>
				))}
				<button
					className="loom-rel-add"
					onClick={() => setRelationships([...relationships, { type: '', target: '' }])}
				>
					Add relationship
				</button>
			</div>

			<div className="loom-field loom-field-body">
				<span className="loom-field-label">Notes</span>
				<LinkTextarea
					rows={10}
					placeholder="Freeform notes. [[Wikilinks]] connect like in any other note."
					value={body ?? ''}
					names={linkNames}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>
		</div>
	);
}
