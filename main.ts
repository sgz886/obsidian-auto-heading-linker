import { Plugin, TFile, HeadingCache, LinkCache, CachedMetadata, stripHeading, stripHeadingForLink } from 'obsidian';

interface HeadingSnapshot {
	line: number;
	heading: string;
}

export default class AutoHeadingLinker extends Plugin {
	private snapshots = new Map<string, HeadingSnapshot[]>();

	async onload() {
		this.addCommand({ id: 'test-strip', name: 'Test strip functions', callback: () => {
			['h1: v1', 'test#value', 'a|b', 'hello?', 'hello!'].forEach(t =>
				console.log(`"${t}" → strip: "${stripHeading(t)}" | forLink: "${stripHeadingForLink(t)}"`)
			);
		}});

		// Snapshot headings when a file is opened
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) this.takeSnapshot(file);
			})
		);

		// On any file change, diff headings and update links
		this.registerEvent(
			this.app.metadataCache.on('changed', (file, data, cache) => {
				this.onFileChanged(file, cache);
			})
		);

		// Snapshot the currently open file on load
		const active = this.app.workspace.getActiveFile();
		if (active) this.takeSnapshot(active);
	}

	private takeSnapshot(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.headings) {
			this.snapshots.set(file.path, []);
			return;
		}
		this.snapshots.set(
			file.path,
			cache.headings.map((h) => ({ line: h.position.start.line, heading: h.heading }))
		);
	}

	private async onFileChanged(file: TFile, cache: CachedMetadata) {
		const oldSnap = this.snapshots.get(file.path);
		if (!oldSnap) {
			this.takeSnapshot(file);
			return;
		}

		const newHeadings = cache.headings ?? [];
		const changes = this.diffHeadings(oldSnap, newHeadings);

		if (changes.length > 0) {
			// Update snapshot before modifying other files to avoid re-triggering
			this.snapshots.set(
				file.path,
				newHeadings.map((h) => ({ line: h.position.start.line, heading: h.heading }))
			);
			await this.updateLinks(file, changes);
		} else {
			this.takeSnapshot(file);
		}
	}

	private diffHeadings(
		oldSnap: HeadingSnapshot[],
		newHeadings: HeadingCache[]
	): { oldHeading: string; newHeading: string }[] {
		const changes: { oldHeading: string; newHeading: string }[] = [];

		// Match by line number — if a heading on the same line changed text, it was renamed
		const oldByLine = new Map(oldSnap.map((h) => [h.line, h.heading]));

		for (const nh of newHeadings) {
			const oldH = oldByLine.get(nh.position.start.line);
			if (oldH !== undefined && oldH !== nh.heading) {
				changes.push({ oldHeading: oldH, newHeading: nh.heading });
			}
		}

		return changes;
	}

	private async updateLinks(
		targetFile: TFile,
		changes: { oldHeading: string; newHeading: string }[]
	) {
		// Build rename map: stripHeading for matching keys, stripHeadingForLink for replacement values
		const renameMap = new Map<string, string>();
		for (const c of changes) {
			renameMap.set(stripHeading(c.oldHeading), stripHeadingForLink(c.newHeading));
		}

		const targetPath = targetFile.path;

		// Pre-filter: only check files that link to the target file
		// resolvedLinks is { [sourcePath]: { [targetPath]: linkCount } }
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const candidatePaths = new Set<string>();
		// Add the target file itself (for same-file [[#heading]] links)
		candidatePaths.add(targetPath);
		for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
			if (targets[targetPath]) {
				candidatePaths.add(sourcePath);
			}
		}

		for (const filePath of candidatePaths) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(file);

			// Combine both links ([[...]]) and embeds (![[...]])
			const allLinks = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
			if (allLinks.length === 0) continue;

			// Check if any link/embed in this file points to a renamed heading in targetFile
			const matchingLinks = allLinks.filter((link) => {
				if (!link.link.includes('#')) return false;
				const [notePart, headingPart] = link.link.split('#', 2);
				// Link matches if it points to our target file (or is same-file link)
				const isTargetLink =
					notePart === '' && file.path === targetPath || // same-file [[#heading]]
					this.resolveLink(notePart, file) === targetPath;
				// Compare using stripHeading on both sides for normalization
				return isTargetLink && renameMap.has(stripHeading(headingPart));
			});

			if (matchingLinks.length === 0) continue;

			let content = await this.app.vault.read(file);
			// Process links in reverse order to preserve positions
			const sorted = [...matchingLinks].sort(
				(a, b) => b.position.start.offset - a.position.start.offset
			);

			for (const link of sorted) {
				const [notePart, oldHeading] = link.link.split('#', 2);
				const newHeading = renameMap.get(stripHeading(oldHeading));
				if (!newHeading) continue;

				const start = link.position.start.offset;
				const end = link.position.end.offset;
				const original = content.slice(start, end);

				const updated = original.replace(
					`${notePart}#${oldHeading}`,
					`${notePart}#${newHeading}`
				);
				content = content.slice(0, start) + updated + content.slice(end);
			}

			await this.app.vault.modify(file, content);
		}
	}

	private resolveLink(linkText: string, sourceFile: TFile): string | null {
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkText, sourceFile.path);
		return resolved?.path ?? null;
	}
}
