# Changelog

## Unreleased

### Changed
- Extension now scoped to Finder only — ForkLift support removed from description and UI subtitle

---

## [1.1.0] — 2026-05-14

### Added
- **Instant HUD** — when no files are selected, a floating notification appears at the bottom of the screen without opening the extension interface
- **Ctrl+X shortcut** — removes all tags from any position in the list, no need to scroll down to "Remove All Tags"
- **Parallel file detection** — Finder and ForkLift checks now run simultaneously, cutting detection time roughly in half
- **Two-command architecture** — a lightweight no-view launcher handles file detection; the tag list view opens only when files are confirmed selected

### Changed
- Extension interface opens immediately when files are selected — no freeze before the list appears
- Checkmarks load silently in the background after the list opens, no loading spinner
- Removed debug output (`xattr now: [...]`) from success toast messages

### Fixed
- Raycast window no longer flashes briefly before the HUD appears when no files are selected

---

## [1.0.1] — 2026-05-13

### Added
- `Ctrl+X` keyboard shortcut for Remove All Tags (initial implementation, later refined in 1.1.0)
- README with installation instructions, usage guide, permissions, and troubleshooting notes
- `.gitignore` to exclude `node_modules` and build artefacts from version control

---

## [1.0.0] — 2026-05-13

### Added
- Apply macOS colour tags to files selected in Finder
- Toggle behaviour — selecting a tag that all files already have removes it
- Checkmark indicator on tags applied to all selected files
- Dash indicator on tags applied to only some selected files
- Remove All Tags option
- Custom tag support — type a new tag name to create and apply it
- Works with multiple files selected simultaneously
- Favourite tags list pulled from Finder preferences
- ForkLift support (undocumented)
