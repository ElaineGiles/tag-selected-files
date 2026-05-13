# Tag Selected Files

Apply macOS colour tags to files selected in Finder — directly from Raycast.

---

## What It Does

- Shows your Finder favourite tags as a list
- Applies a tag to all selected files with one keypress
- Removes a tag if all selected files already have it (toggle behaviour)
- Removes all tags at once with **Ctrl+X**
- Works with multiple files selected at the same time
- Shows a checkmark next to tags already applied to all selected files
- Shows a dash next to tags applied to only some of the selected files

---

## Prerequisites

- macOS 12 or later
- [Raycast](https://raycast.com) installed
- Node.js 18 or later (only needed for manual installation)

---

## Installation

### From the Raycast Store *(coming soon)*

Search for **Tag Selected Files** in the Raycast Store and click Install.

### Manual Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/ElaineGiles/tag-selected-files
   cd tag-selected-files
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Load into Raycast:
   ```bash
   npm run dev
   ```
   Raycast will prompt you to add the extension — click **Add Extension**.

---

## How to Use

1. Select one or more files in Finder
2. Open Raycast and run **Tag Selected Files**
3. Choose a colour tag to apply or remove it
4. Use **Ctrl+X** to remove all tags from the selected files at once

The tag list is pulled from your Finder favourite tags. To customise which tags appear, open Finder → Settings → Tags and adjust your favourites.

---

## Permissions

Raycast will ask for **Accessibility access** the first time the extension runs. This is required to read which files are selected in Finder.

To grant it:
1. Open **System Settings → Privacy & Security → Accessibility**
2. Ensure **Raycast** is in the list and toggled on

---

## Troubleshooting

**"No files selected" appears**
Make sure files are selected in Finder *before* opening Raycast. The extension reads the selection at launch — selecting files while Raycast is already open won't work.

**Tags don't appear in the list**
The list is based on your Finder favourite tags. Open Finder → Settings → Tags and make sure at least one tag is marked as a favourite (shown in the Finder sidebar).

**A tag was applied but the coloured dot doesn't disappear after removal**
The tag has been correctly removed from the file. Some third-party file browsers cache tag display and may need a manual refresh (e.g. Cmd+R) to reflect the change.
