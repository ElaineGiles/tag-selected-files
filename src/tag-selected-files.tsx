import { showHUD, launchCommand, LaunchType, closeMainWindow } from "@raycast/api";
import { getSelectedFiles, runPythonScript, READ_TAGS_PYTHON } from "./shared";

// ── No-view launcher ──────────────────────────────────────────────────────────
// Checks for selected files before opening any UI.
// If nothing is selected the HUD appears instantly and the extension exits.
// If files are found their tags are loaded and the view command opens.

export default async function Command() {
  // Dismiss the Raycast window immediately so nothing is visible while we check.
  await closeMainWindow();

  const { files, source } = await getSelectedFiles();

  if (files.length === 0) {
    await showHUD("No files selected — select files in Finder first");
    return;
  }

  let initialFileTags: Record<string, string[]> = {};
  try {
    const json = runPythonScript(READ_TAGS_PYTHON, [JSON.stringify(files)]);
    initialFileTags = JSON.parse(json);
  } catch { /* start with empty tags if read fails */ }

  await launchCommand({
    name: "tag-files-view",
    type: LaunchType.UserInitiated,
    context: { files, source, initialFileTags },
  });
}
