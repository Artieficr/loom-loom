import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{ ignores: ["main.js", "esbuild.config.mjs", "eslint.config.js", "scripts/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: process.cwd(),
			},
		},
		rules: {
			// "Loom Loom" is the plugin's brand name and keeps its casing in UI copy.
			"obsidianmd/ui/sentence-case": ["error", { brands: ["Loom", "Obsidian"] }],
		},
	},
];
