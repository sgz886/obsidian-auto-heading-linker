export class Plugin {
	app: any;
	constructor(app: any, _manifest: any) { this.app = app; }
	registerEvent() {}
}

export class TFile {
	path: string;
	constructor(path: string) { this.path = path; }
}

// stripHeading: normalizes headings for link matching
export function stripHeading(heading: string): string {
	return heading.replace(/[#|^\\[\]%:]/g, '').replace(/\s+/g, ' ').trim();
}

// stripHeadingForLink: prepares headings for linking (generates link text)
export function stripHeadingForLink(heading: string): string {
	return heading.replace(/[#|^\\[\]%:]/g, '').replace(/\s+/g, ' ').trim();
}

// Stubs for unused imports
export type HeadingCache = any;
export type LinkCache = any;
export type CachedMetadata = any;
