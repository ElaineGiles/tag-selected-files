import { showHUD, launchCommand, LaunchType } from "@raycast/api";
import { getSelectedFiles } from "./shared";

// ── No-view launcher ──────────────────────────────────────────────────────────
// Detects selected files, then opens the view immediately.
// Tag reading (checkmarks) happens inside the view without blocking the open.

export default async function Command() {
  const { files, source } = await getSelectedFiles();

  if (files.length === 0) {
    await showHUD("No files selected — select files in Finder first");
    return;
  }

  await launchCommand({
    name: "tag-files-view",
    type: LaunchType.UserInitiated,
    context: { files, source },
  });
}
