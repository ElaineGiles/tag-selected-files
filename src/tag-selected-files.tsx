import {
  ActionPanel,
  Action,
  List,
  showToast,
  Toast,
  Color,
  Icon,
  closeMainWindow,
} from "@raycast/api";
import { runAppleScript, usePromise } from "@raycast/utils";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useState, useMemo, useEffect } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface TagItem {
  name: string;
  color?: Color;
}

interface LoadResult {
  files: string[];
  source: "Finder" | "ForkLift" | null;
  initialFileTags: Record<string, string[]>;
  debugInfo?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_TAG_COLORS: Record<string, Color> = {
  Red: Color.Red,
  Orange: Color.Orange,
  Yellow: Color.Yellow,
  Green: Color.Green,
  Blue: Color.Blue,
  Purple: Color.Purple,
  Gray: Color.SecondaryText,
};

// All Python scripts use only macOS built-ins: python3 + xattr CLI + plistlib.

// macOS stores colour tags in two places:
//   1. com.apple.metadata:_kMDItemUserTags  – tag strings like "Red\n6"
//   2. com.apple.FinderInfo fdFlags bits 1-3 – classic Finder label (the coloured dot)
// ForkLift reads BOTH: text from (1), coloured dot from (2).
// We must keep both in sync so that adding/removing a tag is fully reflected in ForkLift.
// Finder label indices per modern tag-suffix number (reverse ordering: 8 - tag_num).
// Used to keep Finder's label index in sync when tags change.
const TAG_HELPERS = `
COLOR_MAP = {"Gray":"Gray\\n1","Green":"Green\\n2","Purple":"Purple\\n3",
             "Blue":"Blue\\n4","Yellow":"Yellow\\n5","Red":"Red\\n6","Orange":"Orange\\n7"}

_TAG_TO_LABEL = {1:7, 2:6, 3:5, 4:4, 5:3, 6:2, 7:1}

def encode_tag(name):
    return COLOR_MAP.get(name, name)

def tag_name(stored):
    return stored.split("\\n")[0]

def tag_matches(stored, name):
    return stored == name or stored == COLOR_MAP.get(name, name)

def _finder_label(tags):
    for t in tags:
        parts = t.split("\\n")
        if len(parts) > 1:
            try:
                return _TAG_TO_LABEL.get(int(parts[1]), 0)
            except ValueError:
                pass
    return 0

def _set_finder_label(path, label):
    safe = path.replace('"', '\\"')
    if label == 0:
        # Deleting FinderInfo directly is faster and more reliable than going
        # through Finder AppleScript, which can silently do nothing on some files.
        subprocess.run(["xattr", "-d", "com.apple.FinderInfo", path], capture_output=True)
    else:
        script = f'tell application "Finder" to set label index of (POSIX file "{safe}" as alias) to {label & 7}'
        subprocess.run(["/usr/bin/osascript"], input=script, text=True, capture_output=True, timeout=10)
    subprocess.run(["/usr/bin/mdimport", "-f", path], capture_output=True, timeout=8)
`;

const READ_TAGS_PYTHON = `
import plistlib, subprocess, sys, json

ATTR = "com.apple.metadata:_kMDItemUserTags"
files = json.loads(sys.argv[1])
result = {}

for path in files:
    try:
        raw = subprocess.check_output(
            ["xattr", "-px", ATTR, path], stderr=subprocess.DEVNULL
        )
        tags = plistlib.loads(
            bytes.fromhex(raw.decode().replace("\\n", "").replace(" ", ""))
        )
        result[path] = [t.split("\\n")[0] for t in tags]
    except Exception:
        result[path] = []

print(json.dumps(result))
`;

const APPLY_TAG_PYTHON = `
import plistlib, subprocess, sys, json
${TAG_HELPERS}
ATTR = "com.apple.metadata:_kMDItemUserTags"
tag, files = sys.argv[1], json.loads(sys.argv[2])

for path in files:
    try:
        raw = subprocess.check_output(
            ["xattr", "-px", ATTR, path], stderr=subprocess.DEVNULL
        )
        existing = plistlib.loads(
            bytes.fromhex(raw.decode().replace("\\n", "").replace(" ", ""))
        )
    except Exception:
        existing = []

    if not any(tag_matches(t, tag) for t in existing):
        existing.append(encode_tag(tag))

    data = plistlib.dumps(existing, fmt=plistlib.FMT_BINARY)
    formatted = " ".join(data.hex()[i : i + 2] for i in range(0, len(data.hex()), 2))
    subprocess.run(["xattr", "-wx", ATTR, formatted, path], check=True)
    _set_finder_label(path, _finder_label(existing))
`;

const REMOVE_TAG_PYTHON = `
import plistlib, subprocess, sys, json
${TAG_HELPERS}
ATTR = "com.apple.metadata:_kMDItemUserTags"
tag, files = sys.argv[1], json.loads(sys.argv[2])

for path in files:
    try:
        raw = subprocess.check_output(
            ["xattr", "-px", ATTR, path], stderr=subprocess.DEVNULL
        )
        existing = plistlib.loads(
            bytes.fromhex(raw.decode().replace("\\n", "").replace(" ", ""))
        )
    except Exception:
        existing = []

    updated = [t for t in existing if not tag_matches(t, tag)]
    if updated == existing:
        continue

    if updated:
        data = plistlib.dumps(updated, fmt=plistlib.FMT_BINARY)
        formatted = " ".join(data.hex()[i : i + 2] for i in range(0, len(data.hex()), 2))
        subprocess.run(["xattr", "-wx", ATTR, formatted, path], check=True)
    else:
        subprocess.run(["xattr", "-d", ATTR, path], check=True)
    _set_finder_label(path, _finder_label(updated))
`;

const REMOVE_ALL_TAGS_PYTHON = `
import subprocess, sys, json
${TAG_HELPERS}
ATTR = "com.apple.metadata:_kMDItemUserTags"
files = json.loads(sys.argv[1])

for path in files:
    subprocess.run(["xattr", "-d", ATTR, path], capture_output=True)
    _set_finder_label(path, 0)
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function runPythonScript(script: string, args: string[]): string {
  const scriptPath = join(tmpdir(), `raycast-tag-${Date.now()}.py`);
  writeFileSync(scriptPath, script);
  try {
    const result = spawnSync("python3", [scriptPath, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "Unknown error");
    }
    return result.stdout ?? "";
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

// Runs an AppleScript synchronously via a temp file — identical to running
// `osascript script.applescript` in Terminal, which we know works reliably.
function runAppleScriptSync(script: string): string {
  const scriptPath = join(tmpdir(), `raycast-as-${Date.now()}.applescript`);
  writeFileSync(scriptPath, script);
  try {
    const result = spawnSync("/usr/bin/osascript", [scriptPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    return result.stdout?.trim() ?? "";
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

// Converts a file:// URL (which the Accessibility API returns) to a plain POSIX path.
// "file:///Users/foo/My%20Docs/a.txt" → "/Users/foo/My Docs/a.txt"
function fileURLToPath(url: string): string {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
  return url;
}

async function tryFinder(): Promise<{ files: string[]; source: "Finder" | null }> {
  const script = `
try
  tell application "Finder"
    if it is running then
      set sel to selection
      if (count of sel) > 0 then
        set out to ""
        repeat with i from 1 to count of sel
          if i > 1 then set out to out & "||"
          set out to out & POSIX path of (item i of sel as alias)
        end repeat
        return out
      end if
    end if
  end tell
end try
return ""
  `;
  try {
    const result = await runAppleScript(script);
    const files = result?.trim() ? result.split("||").filter(Boolean) : [];
    return { files, source: files.length > 0 ? "Finder" : null };
  } catch {
    return { files: [], source: null };
  }
}

// Search for a directory containing all filenames. Tries Spotlight first (fast),
// then falls back to find (slower but works on unindexed files).
function findDirForFiles(filenames: string[]): string | null {
  if (filenames.length === 0) return null;

  const checkDir = (dir: string) =>
    filenames.every((name) => existsSync(join(dir, name)));

  // 1. Spotlight — instant when indexed
  try {
    const escaped = filenames[0].replace(/'/g, "'\\''");
    const out = execSync(`mdfind "kMDItemFSName == '${escaped}'"`, {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    for (const candidate of out.split("\n").filter(Boolean)) {
      const dir = candidate.slice(0, candidate.lastIndexOf("/"));
      if (checkDir(dir)) return dir;
    }
  } catch { /* fall through */ }

  // 2. find — searches HOME and mounted volumes directly, no Spotlight needed
  try {
    const escaped = filenames[0].replace(/'/g, "'\\''").replace(/\\/g, "\\\\");
    const out = execSync(
      `{ find "$HOME" -maxdepth 8 -name '${escaped}' -not -path '*/.*' 2>/dev/null; find /Volumes -maxdepth 8 -name '${escaped}' -not -path '*/.*' 2>/dev/null; } | head -20`,
      { encoding: "utf8", timeout: 12000 }
    ).trim();
    for (const candidate of out.split("\n").filter(Boolean)) {
      const dir = candidate.slice(0, candidate.lastIndexOf("/"));
      if (checkDir(dir)) return dir;
    }
  } catch { /* fall through */ }

  return null;
}

async function tryForkLift(): Promise<{ files: string[]; source: "ForkLift" | null; debug: string }> {
  // Get selected filenames via the Accessibility API.
  // Tries scroll areas 1-4 inside each group to cope with varying ForkLift layouts.
  const filenameScript = `
try
  set filePaths to {}
  tell application "System Events"
    tell process "ForkLift"
      if (count of windows) is 0 then return ""
      set theWindow to front window
      repeat with grp in (every group of splitter group 1 of splitter group 1 of theWindow)
        if (count of filePaths) > 0 then exit repeat
        repeat with saIdx from 1 to 4
          try
            set ol to outline 1 of scroll area saIdx of grp
            set selRows to every row of ol whose selected is true
            if (count of selRows) > 0 then
              repeat with theRow in selRows
                set rowName to ""
                try
                  set cell1 to UI element 1 of theRow
                  repeat with kid in (every UI element of cell1)
                    try
                      if role of kid is "AXTextField" then
                        set candidate to value of kid as text
                        if candidate is not "" then
                          set rowName to candidate
                          exit repeat
                        end if
                      end if
                    end try
                  end repeat
                end try
                if rowName is not "" then set end of filePaths to rowName
              end repeat
            end if
          end try
        end repeat
      end repeat
    end tell
  end tell
  if (count of filePaths) is 0 then return ""
  set out to ""
  repeat with i from 1 to count of filePaths
    if i > 1 then set out to out & "||"
    set out to out & (item i of filePaths as text)
  end repeat
  return out
end try
return ""
  `;

  // Get the current directory from ForkLift directly.
  // "activeTab" as one word avoids the AppleScript reserved-word conflict with "active".
  const dirScript = `
try
  tell application "ForkLift"
    tell front window
      return displayedUrl of activeTab 1
    end tell
  end tell
end try
return ""
  `;

  // Retry up to 3 times with a short delay — ForkLift's accessibility tree
  // may not be settled immediately when Raycast first activates.
  let rawFilenames = "";
  let rawDir = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
    try { rawDir = runAppleScriptSync(dirScript); } catch { /* ignore */ }
    try { rawFilenames = runAppleScriptSync(filenameScript); } catch { /* ignore */ }
    if (rawFilenames.trim()) break;
  }

  const filenames = rawFilenames.split("||").map((s) => s.trim()).filter(Boolean);

  if (filenames.length === 0) {
    const dbg = `names=[] rawDir="${rawDir}" rawNames="${rawFilenames}"`;
    return { files: [], source: null, debug: dbg };
  }

  // Prefer the path from ForkLift's activeTab (avoids filesystem search entirely).
  let dir: string | null = null;
  const candidate = rawDir ? fileURLToPath(rawDir) : "";
  if (candidate && existsSync(candidate)) dir = candidate;

  // Fall back to filesystem search (HOME + /Volumes) when the tab URL isn't available.
  if (!dir) dir = findDirForFiles(filenames);
  if (!dir) {
    const dbg = `names=${JSON.stringify(filenames)} rawDir="${rawDir}" dirNotFound`;
    return { files: [], source: null, debug: dbg };
  }

  const base = dir.endsWith("/") ? dir : dir + "/";
  return { files: filenames.map((name) => base + name), source: "ForkLift", debug: "ok" };
}

async function getSelectedFiles(): Promise<{ files: string[]; source: "Finder" | "ForkLift" | null; debug?: string }> {
  const finder = await tryFinder();
  if (finder.files.length > 0) return finder;
  return tryForkLift();
}

// Send Cmd+R to ForkLift to reload the current directory listing.
// Now that FinderInfo is cleared via Finder before this runs, the dot will be gone.
function refreshForkLift(): void {
  try {
    spawnSync("/usr/bin/osascript", ["-e",
      `tell application "System Events" to tell process "ForkLift" to keystroke "r" using {command down}`
    ], { timeout: 3000 });
  } catch { /* ignore */ }
}


async function loadSelectionAndTags(): Promise<LoadResult> {
  const { files, source, debug } = await getSelectedFiles();
  if (files.length === 0) return { files, source, initialFileTags: {}, debugInfo: debug };

  try {
    const json = runPythonScript(READ_TAGS_PYTHON, [JSON.stringify(files)]);
    return { files, source, initialFileTags: JSON.parse(json) };
  } catch {
    return { files, source, initialFileTags: Object.fromEntries(files.map((f) => [f, []])) };
  }
}

function getFavoriteTags(): TagItem[] {
  try {
    const output = execSync("defaults read com.apple.finder FavoriteTagNames 2>/dev/null", {
      encoding: "utf8",
    });
    const matches = [...output.matchAll(/"([^"]+)"/g)];
    if (matches.length > 0) {
      return matches.map((m) => ({ name: m[1], color: SYSTEM_TAG_COLORS[m[1]] }));
    }
  } catch { /* fall through */ }
  return Object.keys(SYSTEM_TAG_COLORS).map((name) => ({ name, color: SYSTEM_TAG_COLORS[name] }));
}

// ── Main command ─────────────────────────────────────────────────────────────

export default function TagSelectedFiles() {
  const [searchText, setSearchText] = useState("");
  const { data, isLoading } = usePromise(loadSelectionAndTags);
  const [fileTags, setFileTags] = useState<Record<string, string[]>>({});
  const [favoriteTags] = useState<TagItem[]>(getFavoriteTags);

  // Initialise fileTags once the async load completes; show debug toast if no files found
  useEffect(() => {
    if (!data) return;
    if (data.initialFileTags) setFileTags(data.initialFileTags);
    if (data.files.length === 0 && data.debugInfo) {
      showToast({ style: Toast.Style.Failure, title: "No files found", message: data.debugInfo });
    }
  }, [data]);

  const files = data?.files ?? [];
  const source = data?.source ?? null;

  // Tags that EVERY selected file already has
  const activeTags = useMemo<Set<string>>(() => {
    if (files.length === 0) return new Set();
    const allTags = new Set(Object.values(fileTags).flat());
    return new Set([...allTags].filter((t) => files.every((f) => fileTags[f]?.includes(t))));
  }, [fileTags, files]);

  // Tags that SOME (but not all) selected files have
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
      : "No files selected";

  // Toggle: if ALL files have the tag remove it, otherwise add it to all
  async function handleToggleTag(tag: string) {
    if (files.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "No files selected" });
      return;
    }

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

      // Update local state so the UI reflects the change immediately
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

      // Verify by re-reading the actual xattr so we can confirm what happened
      let verifyMsg = "";
      try {
        const verifyJson = runPythonScript(READ_TAGS_PYTHON, [JSON.stringify(files)]);
        const verifyTags: Record<string, string[]> = JSON.parse(verifyJson);
        const sample = files[0] ? (verifyTags[files[0]] ?? []) : [];
        verifyMsg = `xattr now: [${sample.join(", ")}]`;
      } catch { verifyMsg = "verify failed"; }

      if (source === "ForkLift") {
        if (removing) {
          // Wait until Spotlight confirms the tag is gone (up to 3 s) before
          // sending Cmd+R — otherwise ForkLift re-queries stale Spotlight data.
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

  // Create and immediately apply a brand-new tag, then close
  async function handleCreateTag(tag: string) {
    if (files.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "No files selected" });
      return;
    }

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

  // Accessory shown on the right side of each tag row
  function tagAccessory(name: string): List.Item.Accessory[] {
    if (activeTags.has(name)) {
      return [{ icon: { source: Icon.Checkmark, tintColor: Color.Green }, tooltip: "Applied to all files" }];
    }
    if (partialTags.has(name)) {
      return [{ icon: { source: Icon.Minus, tintColor: Color.SecondaryText }, tooltip: "Applied to some files" }];
    }
    return [];
  }

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Filter tags or type a new one…"
      navigationTitle="Tag Selected Files"
    >
      {!isLoading && files.length === 0 && !data?.debugInfo && (
        <List.EmptyView
          icon={Icon.Tag}
          title="No Files Selected"
          description="Select one or more files in Finder or ForkLift, then run this command."
        />
      )}

      {!isLoading && files.length === 0 && data?.debugInfo && (
        <List.Section title="No Files Found — Debug Info">
          <List.Item
            icon={{ source: Icon.Warning, tintColor: Color.Red }}
            title={data.debugInfo}
          />
        </List.Section>
      )}

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

      {!searchText && hasAnyTags && files.length > 0 && (
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
