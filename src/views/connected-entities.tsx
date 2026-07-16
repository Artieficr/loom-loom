import { Notice } from 'obsidian';
import { useEffect, useState } from 'react';
import { ENTITY_META, ENTITY_TYPES, EntityRecord, EntityType } from '../types';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';
import { FRONTMATTER_RE, Icon, Truncated, autoGrowTextarea, recordLabel } from './common';

/**
 * Inline view of every entity connected to the page's record: one collapsible
 * section per entity type (collapsed by default, shown only when it has
 * entries), with collapsible entries inside. An expanded entry shows the
 * target's description and notes, editable in place via the pencil/check
 * button; the arrow opens its full entity page.
 */
export function ConnectedEntities({
	navigator,
	record,
	project,
}: {
	navigator: LoomNavigator;
	record: EntityRecord;
	project: ProjectDef | null;
}) {
	const groups = new Map<EntityType, EntityRecord[]>();
	for (const conn of navigator.plugin.indexer.getConnections(record.path)) {
		const list = groups.get(conn.record.type) ?? [];
		// getConnections is per relType — the same entity can appear twice.
		if (!list.some((r) => r.path === conn.record.path)) list.push(conn.record);
		groups.set(conn.record.type, list);
	}
	const types = ENTITY_TYPES.filter((t) => groups.has(t));
	if (types.length === 0) return null;

	return (
		<div className="loom-connected">
			<span className="loom-field-label">Overview</span>
			{types.map((t) => (
				<Section
					// key on record.path so collapsed state resets per page
					key={record.path + t}
					label={ENTITY_META[t].plural}
					entries={(groups.get(t) ?? []).sort((a, b) =>
						recordLabel(a, project).localeCompare(recordLabel(b, project))
					)}
					navigator={navigator}
					project={project}
				/>
			))}
		</div>
	);
}

function Section({
	label,
	entries,
	navigator,
	project,
}: {
	label: string;
	entries: EntityRecord[];
	navigator: LoomNavigator;
	project: ProjectDef | null;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="loom-section">
			<button className="loom-section-header" onClick={() => setOpen(!open)}>
				<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
				{label}
				<span className="loom-section-count">{entries.length}</span>
			</button>
			{open ? (
				<div className="loom-connected-body">
					{entries.map((r) => (
						<Entry key={r.path} target={r} label={recordLabel(r, project)} navigator={navigator} />
					))}
				</div>
			) : null}
		</div>
	);
}

function Entry({
	target,
	label,
	navigator,
}: {
	target: EntityRecord;
	label: string;
	navigator: LoomNavigator;
}) {
	const plugin = navigator.plugin;
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	/** Target's note body without frontmatter; null until loaded. */
	const [body, setBody] = useState<string | null>(null);
	const [descDraft, setDescDraft] = useState('');
	const [bodyDraft, setBodyDraft] = useState('');

	// Load the body as soon as the entry mounts (its section is expanded), so
	// editing never starts from a not-yet-loaded body.
	useEffect(() => {
		const file = plugin.app.vault.getFileByPath(target.path);
		if (!file) return;
		let cancelled = false;
		void plugin.app.vault.cachedRead(file).then((data) => {
			if (!cancelled) setBody(data.replace(FRONTMATTER_RE, '').trim());
		});
		return () => {
			cancelled = true;
		};
	}, [plugin, target.path]);

	const startEdit = () => {
		if (body === null) return;
		setDescDraft(target.description);
		setBodyDraft(body);
		setOpen(true);
		setEditing(true);
	};

	const save = async () => {
		const file = plugin.app.vault.getFileByPath(target.path);
		if (!file) return;
		try {
			await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm.description = descDraft;
			});
			await plugin.app.vault.process(file, (data) => {
				const m = FRONTMATTER_RE.exec(data);
				return (m ? m[0] : '') + bodyDraft;
			});
			setBody(bodyDraft.trim());
			setEditing(false);
		} catch (e) {
			console.error('Loom Loom: failed to save connected entity', e);
			new Notice('Could not save the change.');
		}
	};

	const hasContent = target.description !== '' || (body !== null && body !== '');

	return (
		<div className="loom-entry">
			<div className="loom-entry-head">
				<button className="loom-entry-toggle" onClick={() => setOpen(!open)}>
					<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
					<Truncated className="loom-entry-name" text={label} />
				</button>
				<button
					className="loom-entry-btn"
					aria-label={editing ? 'Save' : 'Edit in place'}
					onClick={() => (editing ? void save() : startEdit())}
				>
					<Icon name={editing ? 'check' : 'pencil'} />
				</button>
				<button
					className="loom-entry-btn"
					aria-label="Open full page"
					onClick={() => navigator.openEntity(target.path)}
				>
					<Icon name="arrow-right" />
				</button>
			</div>
			{open ? (
				<div className="loom-entry-body">
					{editing ? (
						<>
							<label className="loom-field">
								<span className="loom-field-label">Description</span>
								<textarea rows={1} ref={(el) => autoGrowTextarea(el)} onInput={(ev) => autoGrowTextarea(ev.currentTarget)} value={descDraft} onChange={(e) => setDescDraft(e.target.value)} />
							</label>
							<label className="loom-field">
								<span className="loom-field-label">Notes</span>
								<textarea rows={1} ref={(el) => autoGrowTextarea(el)} onInput={(ev) => autoGrowTextarea(ev.currentTarget)} value={bodyDraft} onChange={(e) => setBodyDraft(e.target.value)} />
							</label>
						</>
					) : (
						<>
							{target.description !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">Description</span>
									<div className="loom-entry-text">{target.description}</div>
								</div>
							) : null}
							{body !== null && body !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">Notes</span>
									<div className="loom-entry-text">{body}</div>
								</div>
							) : null}
							{!hasContent ? (
								<div className="loom-entry-text loom-entry-empty">No description or notes yet.</div>
							) : null}
						</>
					)}
				</div>
			) : null}
		</div>
	);
}
