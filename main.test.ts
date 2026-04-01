import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import AutoHeadingLinker from './main.ts';

function createPlugin(opts: {
	targetPath?: string;
	resolvedLinks?: Record<string, Record<string, number>>;
	fileCaches?: Record<string, any>;
	fileContents?: Record<string, string>;
}) {
	const written: Record<string, string> = {};
	const fileInstances: Record<string, TFile> = {};

	const allPaths = new Set([
		...(opts.targetPath ? [opts.targetPath] : []),
		...Object.keys(opts.fileCaches ?? {}),
		...Object.keys(opts.fileContents ?? {}),
	]);
	for (const p of allPaths) {
		fileInstances[p] = Object.assign(new TFile(p), { path: p });
	}

	const app = {
		workspace: { on: vi.fn(), getActiveFile: () => null },
		metadataCache: {
			on: vi.fn(),
			resolvedLinks: opts.resolvedLinks ?? {},
			getFileCache: (f: TFile) => opts.fileCaches?.[f.path] ?? null,
			getFirstLinkpathDest: (link: string) => fileInstances[link + '.md'] ?? null,
		},
		vault: {
			getAbstractFileByPath: (p: string) => fileInstances[p] ?? null,
			read: async (f: TFile) => opts.fileContents?.[f.path] ?? '',
			modify: async (f: TFile, content: string) => { written[f.path] = content; },
		},
	};

	const plugin = new (AutoHeadingLinker as any)(app, {} as any);
	plugin.app = app;
	return { plugin, written };
}

describe('updateLinks with colon in heading', () => {
	it('case 1: updates wikilink [[file#h1 v1]] when heading "h1: v1" is renamed', async () => {
		const targetPath = 'target.md';
		const linkingPath = 'linker.md';
		const linkingContent = 'some text [[target#h1 v1]] end';

		const { plugin, written } = createPlugin({
			targetPath,
			resolvedLinks: { [linkingPath]: { [targetPath]: 1 } },
			fileCaches: {
				[linkingPath]: {
					links: [{
						link: 'target#h1 v1',
						position: { start: { offset: 10 }, end: { offset: 26 } },
					}],
					embeds: [],
				},
			},
			fileContents: { [linkingPath]: linkingContent },
		});

		await plugin.updateLinks(
			Object.assign(new TFile(targetPath), { path: targetPath }),
			[{ oldHeading: 'h1: v1', newHeading: 'h1: v2' }]
		);

		expect(written[linkingPath]).toBe('some text [[target#h1 v2]] end');
	});

	it('case 2: updates embed ![[file#h1 v1]] when heading "h1: v1" is renamed', async () => {
		const targetPath = 'target.md';
		const linkingPath = 'linker.md';
		const linkingContent = 'some text ![[target#h1 v1]] end';

		const { plugin, written } = createPlugin({
			targetPath,
			resolvedLinks: { [linkingPath]: { [targetPath]: 1 } },
			fileCaches: {
				[linkingPath]: {
					links: [],
					embeds: [{
						link: 'target#h1 v1',
						position: { start: { offset: 10 }, end: { offset: 27 } },
					}],
				},
			},
			fileContents: { [linkingPath]: linkingContent },
		});

		await plugin.updateLinks(
			Object.assign(new TFile(targetPath), { path: targetPath }),
			[{ oldHeading: 'h1: v1', newHeading: 'h1: v2' }]
		);

		expect(written[linkingPath]).toBe('some text ![[target#h1 v2]] end');
	});
});
