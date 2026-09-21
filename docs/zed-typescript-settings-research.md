# Zed TypeScript settings research

Date: 2026-09-08

## Current state

- TypeScript, TSX, and JavaScript support are built into Zed and use `vtsls` by default: [Zed TypeScript documentation](https://zed.dev/docs/languages/typescript).
- This project has Biome 2 configured in `biome.json` and installed as a development dependency.
- The project now uses the official Biome Zed language-server extension for formatting and safe code actions.
- The global Prettier override has been removed. That was the original source of the format-on-save failure because this project does not install Prettier.

## Findings

1. Zed's external formatter receives the buffer on stdin and expects formatted text on stdout. External formatters do not support format selections, which is why the language-server integration is preferable here: [Zed settings reference](https://zed.dev/docs/reference/all-settings) and [Zed language configuration](https://zed.dev/docs/configuring-languages).
2. The official Biome Zed extension supports JavaScript, TypeScript, JSX, TSX, JSON, JSONC, CSS, HTML, GraphQL, Vue, Astro, and Svelte. It is compatible with Biome 2 starting with extension version 0.2.0: [Biome Zed extension](https://github.com/biomejs/biome-zed).
3. Zed can explicitly select a language server as a formatter and can run safe Biome fixes on save with `source.fixAll.biome`: [Biome linter documentation](https://biomejs.dev/linter/) and [Zed formatting/linting documentation](https://zed.dev/docs/configuring-languages).
4. Zed's defaults already enable format-on-save, final newlines, and removal of trailing whitespace. Repeating those defaults is optional and does not fix formatter discovery: [Zed settings reference](https://zed.dev/docs/reference/all-settings).
5. Zed supports project-local tasks in `.zed/tasks.json`. This is useful for `bun run check` and `bun run typecheck`: [Zed tasks documentation](https://zed.dev/docs/tasks).
6. Zed already provides TypeScript debugging through `vscode-js-debug`, including Bun test discovery when `@types/bun` is present: [Zed TypeScript debugging documentation](https://zed.dev/docs/languages/typescript).

## Recommended next step

Install the Biome extension from Zed's Extensions view, then replace the absolute external formatter with this project-local configuration:

```json
{
  "languages": {
    "TypeScript": {
      "language_servers": ["vtsls", "biome"],
      "format_on_save": "on",
      "formatter": [
        { "language_server": { "name": "biome" } },
        { "code_action": "source.fixAll.biome" },
        { "code_action": "source.organizeImports.biome" }
      ]
    },
    "TSX": {
      "language_servers": ["vtsls", "biome"],
      "format_on_save": "on",
      "formatter": [
        { "language_server": { "name": "biome" } },
        { "code_action": "source.fixAll.biome" },
        { "code_action": "source.organizeImports.biome" }
      ]
    },
    "JavaScript": {
      "language_servers": ["vtsls", "biome"],
      "format_on_save": "on",
      "formatter": [
        { "language_server": { "name": "biome" } },
        { "code_action": "source.fixAll.biome" },
        { "code_action": "source.organizeImports.biome" }
      ]
    },
    "JSX": {
      "language_servers": ["vtsls", "biome"],
      "format_on_save": "on",
      "formatter": [
        { "language_server": { "name": "biome" } },
        { "code_action": "source.fixAll.biome" },
        { "code_action": "source.organizeImports.biome" }
      ]
    },
    "JSON": {
      "format_on_save": "on",
      "formatter": { "language_server": { "name": "biome" } }
    },
    "JSONC": {
      "format_on_save": "on",
      "formatter": { "language_server": { "name": "biome" } }
    }
  }
}
```

The import-organizing action is optional. Remove it if automatic import movement is undesirable. Avoid adding large-project memory settings, code lenses, semantic tokens, or extra language servers until there is a concrete need.
