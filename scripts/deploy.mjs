// Copies the built plugin into the test vault for manual testing.
// Override the target with LOOM_VAULT=/path/to/vault node scripts/deploy.mjs
import { cp, mkdir, access } from 'fs/promises';
import path from 'path';
import process from 'process';

const vault = process.env.LOOM_VAULT ?? '/home/artie/Dropbox/Obsidian/Test Vault';
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
