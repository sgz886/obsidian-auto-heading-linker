# Auto Heading Linker — Design Document

## 1. Problem Statement

Obsidian automatically updates internal links (`[[NoteA]]`) when a **file** is renamed, but does **not** update heading links (`[[NoteA#heading]]`) when a **heading** is edited. The built-in "Rename this heading" (right-click menu) does update links, but it's manual and only works one heading at a time.

This is especially problematic when:
- The **Number Headings** plugin bulk-modifies headings (adding/changing numbering)
- The user manually edits heading text in the editor

In both cases, all `[[Note#old-heading]]` links across the vault become broken.

## 2. Design Goals

- **Fully automatic**: no user interaction required
- **Works for any heading change**: manual edits, Number Headings plugin, or any other source
- **Efficient**: use Obsidian's in-memory metadata cache instead of full-text vault scanning
- **Non-destructive**: only modify the link portion of files, never touch other content

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Obsidian App                       │
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌────────────┐ │
│  │  Editor   │───▶│ MetadataCache│───▶│ Our Plugin │ │
│  │ (or any   │    │  'changed'   │    │            │ │
│  │  plugin)  │    │   event      │    │ 1. Diff    │ │
│  │ modifies  │    └──────────────┘    │ 2. Find    │ │
│  │ heading   │                        │ 3. Update  │ │
│  └──────────┘                         └────────────┘ │
└─────────────────────────────────────────────────────┘
```

The plugin operates in a **snapshot-diff-update** cycle:

1. **Snapshot** — Record all headings (text + line number) when a file is opened
2. **Diff** — When the file changes, compare new headings against the snapshot
3. **Update** — For any renamed heading, find and update all links across the vault

## 4. Core Data Structures

### 4.1 HeadingSnapshot

```ts
interface HeadingSnapshot {
    line: number;    // Line number in the file (0-based)
    heading: string; // Heading text without the # prefix
}
```

Stored in an in-memory `Map<string, HeadingSnapshot[]>` keyed by file path.

### 4.2 Change Detection Result

```ts
{ oldHeading: string; newHeading: string }[]
```

An array of heading renames detected in a single file change event.

## 5. Detailed Flow

### 5.1 Snapshot Phase

**Trigger**: `workspace.on('file-open')` event, or plugin load for the active file.

**Action**: Read headings from `app.metadataCache.getFileCache(file).headings` and store as `HeadingSnapshot[]`.

**Why line-based**: We use line numbers as the identity of a heading. If the heading text on line 10 changes from "Introduction" to "1.1 Introduction", we know it was renamed (not deleted + new one created).

### 5.2 Diff Phase

**Trigger**: `app.metadataCache.on('changed', ...)` event. This fires after Obsidian re-parses a file's metadata.

**Algorithm**:
1. Build a `Map<lineNumber, headingText>` from the old snapshot
2. For each heading in the new cache, check if the same line existed in the old snapshot
3. If the line existed but the text differs → it's a rename

**Limitations of line-based matching**:
- If a heading is moved to a different line (e.g., lines inserted above it), it won't be matched. This is acceptable because moving a heading doesn't change its text — the snapshot will simply refresh.
- If two headings swap lines in a single edit, this could produce incorrect matches. This is an extreme edge case.

### 5.3 Update Phase

**Trigger**: One or more heading renames detected in the diff.

**Algorithm**:
1. Build a `renameMap`: `Map<oldHeading, newHeading>`
2. Use `app.metadataCache.resolvedLinks` to find only files that link to the target file (plus the target file itself for same-file links)
3. For each candidate file, read its cached `links` array from `metadataCache`
4. Filter links that:
   - Contain `#` (heading links)
   - Resolve to the target file (using `metadataCache.getFirstLinkpathDest`)
   - Have a heading part that matches an entry in `renameMap`
5. For matching files, read file content, replace link text at exact positions (in reverse offset order to preserve positions), and write back

**Why reverse offset order**: When replacing text in a string, earlier replacements shift the positions of later text. Processing from end to start avoids this.

### 5.4 Link Resolution

Links can take several forms:
- `[[NoteA#heading]]` — explicit note + heading
- `[[#heading]]` — same-file heading link
- `[[folder/NoteA#heading]]` — path-qualified link

We use `app.metadataCache.getFirstLinkpathDest(linkText, sourcePath)` to resolve the note part to an actual file path, then compare against the target file. Same-file links (`[[#heading]]`) are detected by checking if the note part is empty and the source file is the target file.

## 6. Obsidian APIs Used

| API | Purpose |
|-----|---------|
| `workspace.on('file-open')` | Trigger snapshot when user opens a file |
| `metadataCache.on('changed')` | Detect file content changes after metadata re-parse |
| `metadataCache.getFileCache(file)` | Read cached headings and links for a file |
| `metadataCache.getFirstLinkpathDest(link, source)` | Resolve a link text to a target file |
| `vault.getMarkdownFiles()` | List all markdown files in the vault |
| `vault.read(file)` | Read file content for link replacement |
| `vault.modify(file, content)` | Write updated content back |

## 7. How Obsidian's Metadata Cache Works

Obsidian maintains an **in-memory index** of all files' metadata. On vault open, it parses every markdown file and caches:
- Headings (text, level, position)
- Links (target, display text, position)
- Tags, frontmatter, embeds, etc.

When a file changes, Obsidian re-parses only that file and fires the `'changed'` event with the new cache. This is incremental — not a full vault re-scan.

The `resolvedLinks` object tracks file-to-file link relationships, but **not** heading-level granularity. To find links to a specific heading, we must iterate through individual files' `links` arrays. However, this is still fast because:
- It's all in-memory (no disk I/O for the search phase)
- We only read/write files that actually contain matching links

## 8. Known Limitations & Edge Cases

### 8.1 Cold Start
On Obsidian restart, no snapshots exist. The plugin takes a snapshot when you first open a file. If the Number Headings plugin modifies headings before the snapshot is taken, those changes won't be detected.

**Possible fix**: Persist snapshots to a JSON file in the plugin's data directory.

### 8.2 Line-Based Matching
If headings are inserted/deleted (shifting other headings to different lines), the diff may not correctly identify renames vs. new headings. The snapshot refreshes after each change, so this only affects the single edit where lines shift.

**Possible fix**: Use fuzzy matching (e.g., Levenshtein distance) or sequence alignment to match headings across line shifts.

### 8.3 Rapid Successive Edits
If the user types quickly, multiple `'changed'` events may fire in rapid succession. The plugin processes each one sequentially. The snapshot is updated before link modification begins, so re-triggering from our own file writes should not cause loops.

### 8.4 Bulk Heading Changes
When the Number Headings plugin renumbers all headings at once, the `'changed'` event fires once with all headings already modified. The diff detects all changes in a single pass and updates all links in one batch.

### 8.5 Same-File Links
Links like `[[#heading]]` within the same file are handled. The plugin detects these by checking if the note part of the link is empty and the source file matches the target file.

## 9. Future Improvements

- **Snapshot persistence**: Save snapshots to disk to survive restarts
- **Undo support**: Record link changes for potential rollback
- **Settings UI**: Configurable debounce delay, enable/disable per-vault
- **Notification**: Show a notice when links are updated (count of files modified)
- **Fuzzy heading matching**: Handle line shifts from insertions/deletions
- ~~**Performance**: Use `resolvedLinks` to pre-filter files~~ — **Implemented**
