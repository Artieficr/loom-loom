/**
 * A plain module-level variable, not the OS Clipboard API — deliberately, per
 * the modular branch editor's own plan doc: the OS clipboard buys cross-
 * window paste at the cost of serialization robustness, permission prompts,
 * and defending against foreign clipboard content being misinterpreted, none
 * of which is worth it for what's fundamentally a single-editing-session
 * rearrangement (cut a decision point, paste it somewhere else in the SAME
 * script, all within one Obsidian session). Revisitable later without any
 * file-format change, since nothing here touches disk.
 */
let branchClipboard: string | null = null;

export function setBranchClipboard(block: string): void {
	branchClipboard = block;
}

export function getBranchClipboard(): string | null {
	return branchClipboard;
}
