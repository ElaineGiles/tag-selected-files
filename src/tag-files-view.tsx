import {
  ActionPanel,
  Action,
  List,
  showToast,
  Toast,
  Color,
  Icon,
  closeMainWindow,
  showHUD,
  LaunchProps,
} from "@raycast/api";
import { execSync } from "child_process";
import { useState, useMemo, useEffect } from "react";
import {
  TagItem,
  ViewLaunchContext,
  SYSTEM_TAG_COLORS,
  APPLY_TAG_PYTHON,
  REMOVE_TAG_PYTHON,
  REMOVE_ALL_TAGS_PYTHON,
  READ_TAGS_PYTHON,
  runPythonScript,
  refreshForkLift,
  getFavoriteTags,
} from "./shared";

// ── View command ──────────────────────────────────────────────────────────────
// Opened automatically by the no-view launcher with files + tags pre-loaded.

export default function TagFilesView(props: LaunchProps<{ launchContext?: ViewLaunchContext }>) {
  const context = props.launchContext;

  const [searchText, setSearchText] = useState("");
  const [fileTags, setFileTags] = useState<Record<string, string[]>>(
    context?.initialFileTags ?? {}
  );
  const [favoriteTags] = useState<TagItem[]>(getFavoriteTags);

  const files = context?.files ?? [];
  const source = context?.source ?? null;

  // If launched directly (not via the launcher), show HUD and exit
  useEffect(() => {
    if (!context) {
      showHUD("Use the 'Tag Selected Files' command instead").then(() => closeMainWindow());
    }
  }, [context]);

  const activeTags = useMemo<Set<string>>(() => {
    if (files.length === 0) return new Set();
    const allTags = new Set(Object.values(fileTags).flat());
    return new Set([...allTags].filter((t) => files.every((f) => fileTags[f]?.includes(t))));
  }, [fileTags, files]);

  const partialTags = useMemo<Set<string>>(() => {
    if (files.length === 0) return new Set();
    const allTags = new Set(Object.values(fileTags).flat());
    return new Set([...allTags].filter((t) => !activeTags.has(t)));
  }, [fileTags, files, activeTags]);

  const hasAnyTags = Object.values(fileTags).some((tags) => tags.length > 0);

  const filteredTags = favoriteTags.filter((t) =>
    t.name.toLowerCase().includes(searchText.toLowerCase())
  );

  const showCreateNew =
    searchText.length > 0 &&
    !favoriteTags.some((t) => t.name.toLowerCase() === searchText.toLowerCase());

  const selectionSubtitle =
    files.length > 0
      ? `${files.length} file${files.length !== 1 ? "s" : ""} in ${source}`
      : "";

  async function handleToggleTag(tag: string) {
    const removing = activeTags.has(tag);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: removing ? `Removing "${tag}"…` : `Applying "${tag}"…`,
      message: `${files.length} file${files.length !== 1 ? "s" : ""}`,
    });

    try {
      runPythonScript(removing ? REMOVE_TAG_PYTHON : APPLY_TAG_PYTHON, [
        tag,
        JSON.stringify(files),
      ]);

      setFileTags((prev) => {
        const next = { ...prev };
        for (const f of files) {
          if (removing) {
            next[f] = (prev[f] ?? []).filter((t) => t !== tag);
          } else if (!(prev[f] ?? []).includes(tag)) {
            next[f] = [...(prev[f] ?? []), tag];
          }
        }
        return next;
      });

      // Verify by re-reading xattr
      let verifyMsg = "";
      try {
        const verifyJson = runPythonScript(READ_TAGS_PYTHON, [JSON.stringify(files)]);
        const verifyTags: Record<string, string[]> = JSON.parse(verifyJson);
        const sample = files[0] ? (verifyTags[files[0]] ?? []) : [];
        verifyMsg = `xattr now: [${sample.join(", ")}]`;
      } catch { verifyMsg = "verify failed"; }

      if (source === "ForkLift") {
        if (removing) {
          const file = files[0];
          const quoted = file.replace(/"/g, '\\"');
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              const mdls = execSync(`/usr/bin/mdls -name kMDItemUserTags "${quoted}"`, {
                encoding: "utf8",
                timeout: 2000,
              });
              if (mdls.includes("(null)") || /\(\s*\)/.test(mdls)) break;
            } catch { break; }
          }
        }
        refreshForkLift();
      }

      toast.style = Toast.Style.Success;
      toast.title = removing
        ? `Removed "${tag}" from ${files.length} file${files.length !== 1 ? "s" : ""}`
        : `Applied "${tag}" to ${files.length} file${files.length !== 1 ? "s" : ""}`;
      toast.message = verifyMsg;
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed";
      toast.message = String(err);
    }
  }

  async function handleCreateTag(tag: string) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Applying "${tag}"…`,
      message: `${files.length} file${files.length !== 1 ? "s" : ""}`,
    });

    try {
      runPythonScript(APPLY_TAG_PYTHON, [tag, JSON.stringify(files)]);
      if (source === "ForkLift") refreshForkLift();
      toast.style = Toast.Style.Success;
      toast.title = `Applied "${tag}"`;
      await closeMainWindow();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed";
      toast.message = String(err);
    }
  }

  async function handleRemoveAllTags() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Removing all tags…",
      message: `${files.length} file${files.length !== 1 ? "s" : ""}`,
    });

    try {
      runPythonScript(REMOVE_ALL_TAGS_PYTHON, [JSON.stringify(files)]);
      if (source === "ForkLift") refreshForkLift();
      setFileTags(Object.fromEntries(files.map((f) => [f, []])));
      toast.style = Toast.Style.Success;
      toast.title = `All tags removed from ${files.length} file${files.length !== 1 ? "s" : ""}`;
      await closeMainWindow();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to remove tags";
      toast.message = String(err);
    }
  }

  function tagAccessory(name: string): List.Item.Accessory[] {
    if (activeTags.has(name)) {
      return [{ icon: { source: Icon.Checkmark, tintColor: Color.Green }, tooltip: "Applied to all files" }];
    }
    if (partialTags.has(name)) {
      return [{ icon: { source: Icon.Minus, tintColor: Color.SecondaryText }, tooltip: "Applied to some files" }];
    }
    return [];
  }

  if (!context) return null;

  return (
    <List
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Filter tags or type a new one…"
      navigationTitle="Tag Selected Files"
    >
      {showCreateNew && (
        <List.Section title="New Tag">
          <List.Item
            icon={{ source: Icon.Tag, tintColor: Color.PrimaryText }}
            title={`Create "${searchText}"`}
            subtitle={selectionSubtitle}
            actions={
              <ActionPanel>
                <Action
                  title={`Apply Tag "${searchText}"`}
                  icon={Icon.Tag}
                  onAction={() => handleCreateTag(searchText)}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {filteredTags.length > 0 && (
        <List.Section title="Favorite Tags" subtitle={selectionSubtitle}>
          {filteredTags.map((tag) => {
            const isActive = activeTags.has(tag.name);
            return (
              <List.Item
                key={tag.name}
                icon={{ source: Icon.Circle, tintColor: tag.color ?? Color.PrimaryText }}
                title={tag.name}
                accessories={tagAccessory(tag.name)}
                actions={
                  <ActionPanel>
                    <Action
                      title={isActive ? `Remove Tag "${tag.name}"` : `Apply Tag "${tag.name}"`}
                      icon={isActive ? Icon.Minus : Icon.Tag}
                      onAction={() => handleToggleTag(tag.name)}
                    />
                    {hasAnyTags && (
                      <Action
                        title="Remove All Tags"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        shortcut={{ modifiers: ["ctrl"], key: "x" }}
                        onAction={handleRemoveAllTags}
                      />
                    )}
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {!searchText && hasAnyTags && (
        <List.Section title="Remove All">
          <List.Item
            icon={{ source: Icon.Trash, tintColor: Color.Red }}
            title="Remove All Tags"
            subtitle={selectionSubtitle}
            actions={
              <ActionPanel>
                <Action
                  title="Remove All Tags"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={handleRemoveAllTags}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}
