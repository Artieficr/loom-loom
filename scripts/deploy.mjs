// Copies the built plugin into each target vault for manual testing.
// Override the targets with LOOM_VAULT=/path/to/vault node scripts/deploy.mjs
import { cp, mkdir, access } from 'fs/promises';
import path from 'path';
import process from 'process';

const vaults = process.env.LOOM_VAULT
	? [process.env.LOOM_VAULT]
	: ['/home/artie/Dropbox/Obsidian/Test Vault', '/home/artie/Dropbox/Obsidian/Main vault'];

for (const vault of vaults) {
	const dest = path.join(vault, '.obsidian', 'plugins', 'loom-loom');
	try {
		await access(path.join(vault, '.obsidian'));
	} catch {
		console.error(`Not an Obsidian vault (no .obsidian dir): ${vault}`);
		process.exit(1);
	}
	await mkdir(dest, { recursive: true });
	for (const file of ['main.js', 'manifest.json', 'styles.css']) {
		await cp(file, path.join(dest, file));
	}
	console.log(`Deployed to ${dest}`);
}
