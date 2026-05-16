import { Color } from "@raycast/api";
import { execFile, execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TagItem {
  name: string;
  color?: Color;
}

export interface ViewLaunchContext {
  files: string[];
  source: "Finder" | "ForkLift" | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const SYSTEM_TAG_COLORS: Record<string, Color> = {
  Red: Color.Red,
  Orange: Color.Orange,
  Yellow: Color.Yellow,
  Green: Color.Green,
  Blue: Color.Blue,
  Purple: Color.Purple,
  Gray: Color.SecondaryText,
};

// ── Python scripts ────────────────────────────────────────────────────────────

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
        subprocess.run(["xattr", "-d", "com.apple.FinderInfo", path], capture_output=True)
    else:
        script = f'tell application "Finder" to set label index of (POSIX file "{safe}" as alias) to {label & 7}'
        subprocess.run(["/usr/bin/osascript"], input=script, text=True, capture_output=True, timeout=10)
    subprocess.run(["/usr/bin/mdimport", "-f", path], capture_output=True, timeout=8)
`;

export const READ_TAGS_PYTHON = `
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

export const APPLY_TAG_PYTHON = `
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

export const REMOVE_TAG_PYTHON = `
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

export const REMOVE_ALL_TAGS_PYTHON = `
import subprocess, sys, json
${TAG_HELPERS}
ATTR = "com.apple.metadata:_kMDItemUserTags"
files = json.loads(sys.argv[1])

for path in files:
    subprocess.run(["xattr", "-d", ATTR, path], capture_output=True)
    _set_finder_label(path, 0)
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function runPythonScript(script: string, args: string[]): string {
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

// Async version — non-blocking, safe to call from a no-view launcher.
export async function runPythonScriptAsync(script: string, args: string[]): Promise<string> {
  const scriptPath = join(tmpdir(), `raycast-tag-${Date.now()}.py`);
  writeFileSync(scriptPath, script);
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, ...args], { timeout: 10000 });
    return stdout ?? "";
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

// Runs AppleScript synchronously via a temp file.
export function runAppleScriptSync(script: string): string {
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

export function fileURLToPath(url: string): string {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
  return url;
}

export function findDirForFiles(filenames: string[]): string | null {
  if (filenames.length === 0) return null;
  const checkDir = (dir: string) => filenames.every((name) => existsSync(join(dir, name)));

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

export function refreshForkLift(): void {
  try {
    spawnSync("/usr/bin/osascript", ["-e",
      `tell application "System Events" to tell process "ForkLift" to keystroke "r" using {command down}`
    ], { timeout: 3000 });
  } catch { /* ignore */ }
}

export function getFavoriteTags(): TagItem[] {
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

// Runs an AppleScript file asynchronously — allows parallel execution.
async function runOsascriptAsync(script: string): Promise<string> {
  const scriptPath = join(tmpdir(), `raycast-as-${Date.now()}${Math.random().toString(36).slice(2)}.applescript`);
  writeFileSync(scriptPath, script);
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [scriptPath], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

const FINDER_SCRIPT = `
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

const FL_DIR_SCRIPT = `
try
  tell application "ForkLift"
    tell front window
      return displayedUrl of activeTab 1
    end tell
  end tell
end try
return ""
`;

const FL_FILES_SCRIPT = `
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

// Runs Finder and ForkLift checks in parallel so total time is the slowest
// single check (~300–500 ms) rather than all checks added together.
export async function getSelectedFiles(): Promise<{
  files: string[];
  source: "Finder" | "ForkLift" | null;
}> {
  const forkLiftRunning =
    spawnSync("pgrep", ["-x", "ForkLift"], { encoding: "utf8" }).status === 0;

  const tasks: Promise<string>[] = [runOsascriptAsync(FINDER_SCRIPT)];
  if (forkLiftRunning) {
    tasks.push(runOsascriptAsync(FL_DIR_SCRIPT));
    tasks.push(runOsascriptAsync(FL_FILES_SCRIPT));
  }

  const [finderOut = "", flDirOut = "", flFilesOut = ""] = await Promise.all(tasks);

  // Finder result
  const finderFiles = finderOut ? finderOut.split("||").filter(Boolean) : [];
  if (finderFiles.length > 0) return { files: finderFiles, source: "Finder" };

  // ForkLift result
  if (forkLiftRunning) {
    const filenames = flFilesOut.split("||").map((s) => s.trim()).filter(Boolean);
    if (filenames.length > 0) {
      let dir: string | null = null;
      const candidate = flDirOut ? fileURLToPath(flDirOut) : "";
      if (candidate && existsSync(candidate)) dir = candidate;
      if (!dir) dir = findDirForFiles(filenames);
      if (dir) {
        const base = dir.endsWith("/") ? dir : dir + "/";
        return { files: filenames.map((name) => base + name), source: "ForkLift" };
      }
    }
  }

  return { files: [], source: null };
}
