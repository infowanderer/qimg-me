import { constants } from "node:fs";
import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export type MediaKind = "directory" | "image" | "video" | "other" | "symlink";

export type MediaEntry = {
  path: string;
  name: string;
  kind: MediaKind;
  size: number;
  modifiedAt: string;
  mediaType: string | null;
  tags: string[];
  contentUrl: string | null;
};

export class MediaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

const imageTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".apng": "image/apng",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const videoTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
};

export function mediaTypeFor(name: string): {
  kind: "image" | "video" | "other";
  mime: string | null;
} {
  const extension = path.extname(name).toLowerCase();
  if (imageTypes[extension]) return { kind: "image", mime: imageTypes[extension] };
  if (videoTypes[extension]) return { kind: "video", mime: videoTypes[extension] };
  return { kind: "other", mime: null };
}

export function splitTaggedFilename(name: string): {
  stem: string;
  extension: string;
  tags: string[];
} {
  // A leading dot alone is a hidden basename, not an extension.
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  let stem = extension ? name.slice(0, -extension.length) : name;
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = / \[([^\[\]\r\n]+)\]$/u.exec(stem))) {
    tags.unshift(match[1]);
    stem = stem.slice(0, match.index);
  }
  return { stem, extension, tags };
}

export function normalizeTag(value: string): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new MediaError(400, "Tags must not contain control characters.");
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new MediaError(400, "A tag cannot be empty.");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    /[\/\\<>:"|?*\[\]]/u.test(normalized)
  ) {
    throw new MediaError(400, `Unsafe tag: "${normalized}".`);
  }
  if (Buffer.byteLength(normalized, "utf8") > 80) {
    throw new MediaError(400, "Tags must be 80 bytes or fewer.");
  }
  return normalized;
}

export function composeTaggedFilename(
  sourceName: string,
  operation: "add" | "remove" | "edit",
  input: { tags?: string[]; oldTag?: string; newTag?: string },
): string {
  const { stem, extension, tags } = splitTaggedFilename(sourceName);
  let next = tags.slice();
  if (operation === "add") {
    if (!input.tags?.length) throw new MediaError(400, "Enter at least one tag.");
    for (const raw of input.tags) {
      const tag = normalizeTag(raw);
      if (!next.includes(tag)) next.push(tag);
    }
  } else if (operation === "remove") {
    const oldTag = normalizeTag(input.oldTag ?? "");
    next = next.filter((tag) => tag !== oldTag);
  } else {
    const oldTag = normalizeTag(input.oldTag ?? "");
    const newTag = normalizeTag(input.newTag ?? "");
    next = next.map((tag) => (tag === oldTag ? newTag : tag));
    // Editing into a tag already on the filename should not create duplicates.
    next = next.filter((tag, index) => next.indexOf(tag) === index);
  }
  const name = `${stem}${next.map((tag) => ` [${tag}]`).join("")}${extension}`;
  if (Buffer.byteLength(name, "utf8") > 255) {
    throw new MediaError(400, `Filename is too long after tagging: "${sourceName}".`);
  }
  return name;
}

export function validateRelativePath(relative: string, allowRoot = false): string[] {
  if (typeof relative !== "string") throw new MediaError(400, "Invalid media path.");
  if (relative === "" && allowRoot) return [];
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(relative)
  ) {
    throw new MediaError(400, "Invalid media path.");
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new MediaError(400, "Paths must stay inside the media root.");
  }
  return segments;
}

export function relativeJoin(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile() && b.isFile();
}

export async function lstatIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class MediaLibrary {
  private constructor(
    public readonly root: string,
    private readonly rootStat: Stats,
  ) {}

  static async open(configuredRoot = process.env.MEDIA_ROOT): Promise<MediaLibrary> {
    if (!configuredRoot && process.env.NODE_ENV === "production") {
      throw new MediaError(503, "MEDIA_ROOT is not configured.");
    }
    // Development's empty local library is intentionally separate from any host media.
    const candidate = path.resolve(configuredRoot ?? path.join(process.cwd(), "media"));
    try {
      if (!configuredRoot) await fs.mkdir(candidate, { recursive: true });
      const canonical = await fs.realpath(candidate);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) {
        throw new MediaError(503, "MEDIA_ROOT must point to a directory.");
      }
      return new MediaLibrary(canonical, stat);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(503, "MEDIA_ROOT is unavailable. Check its path and permissions.");
    }
  }

  async inspect(
    relative: string,
    expected: "file" | "directory",
  ): Promise<{ absolute: string; stat: Stats; handle: FileHandle }> {
    const segments = validateRelativePath(relative, expected === "directory");
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    // Umbrel runs Linux. Each child is opened relative to its already-open
    // parent via procfs, so replacing a checked ancestor with a symlink cannot
    // redirect any subsequent filesystem operation outside the pinned tree.
    let handle = await fs.open("/", flags);
    try {
      for (const segment of this.root.split(path.sep).filter(Boolean)) {
        const next = await fs.open(`/proc/self/fd/${handle.fd}/${segment}`, flags);
        await handle.close();
        handle = next;
      }
      const openedRoot = await handle.stat();
      if (!sameDirectory(openedRoot, this.rootStat)) {
        throw new MediaError(409, "The media root changed. Refresh and retry.");
      }
      const directorySegments = expected === "file" ? segments.slice(0, -1) : segments;
      for (const segment of directorySegments) {
        const next = await fs.open(`/proc/self/fd/${handle.fd}/${segment}`, flags);
        await handle.close();
        handle = next;
      }
      const directoryPath = `/proc/self/fd/${handle.fd}`;
      if (expected === "directory") {
        return { absolute: directoryPath, stat: await handle.stat(), handle };
      }
      const absolute = `${directoryPath}/${segments.at(-1)}`;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new MediaError(400, "Symlinks are not supported inside the media root.");
      }
      if (!stat.isFile()) {
        throw new MediaError(400, "Select regular files, not folders or special files.");
      }
      return { absolute, stat, handle };
    } catch (error) {
      await handle.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new MediaError(404, "File or directory not found. Refresh the library.");
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new MediaError(400, "Symlinks and non-directory path components are not supported.");
      }
      throw error;
    }
  }

  async list(relative = ""): Promise<{
    currentPath: string;
    parentPath: string | null;
    entries: MediaEntry[];
    totalEntries: number;
    totalMedia: number;
  }> {
    const { absolute, handle } = await this.inspect(relative, "directory");
    const entries: MediaEntry[] = [];
    try {
      const children = await fs.readdir(absolute);
      for (const name of children) {
        const stat = await lstatIfPresent(path.join(absolute, name));
        if (!stat) continue; // A file may disappear while the directory is listed.
        if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) continue;
        const itemPath = relativeJoin(relative, name);
        const media = stat.isFile() ? mediaTypeFor(name) : { kind: "other" as const, mime: null };
        const kind: MediaKind = stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : media.kind;
        entries.push({
          path: itemPath,
          name,
          kind,
          size: stat.isFile() ? stat.size : 0,
          modifiedAt: stat.mtime.toISOString(),
          mediaType: media.mime,
          tags: stat.isFile() ? splitTaggedFilename(name).tags : [],
          contentUrl:
            stat.isFile() && media.mime
              ? `/api/media/content?path=${encodeURIComponent(itemPath)}`
              : null,
        });
      }
    } finally {
      await handle.close();
    }
    const rank = (kind: MediaKind): number =>
      kind === "directory" ? 0 : kind === "image" || kind === "video" ? 1 : 2;
    entries.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const slash = relative.lastIndexOf("/");
    return {
      currentPath: relative,
      parentPath: relative === "" ? null : slash < 0 ? "" : relative.slice(0, slash),
      entries,
      totalEntries: entries.length,
      totalMedia: entries.filter((entry) => entry.kind === "image" || entry.kind === "video").length,
    };
  }

  async openContent(relative: string): Promise<{
    handle: FileHandle;
    stat: Stats;
    mime: string;
  }> {
    const pinned = await this.inspect(relative, "file");
    try {
      const { mime } = mediaTypeFor(path.basename(pinned.absolute));
      if (!mime) throw new MediaError(415, "This file type cannot be previewed in a browser.");
      // O_NOFOLLOW makes a last-moment replacement with a symlink fail closed.
      const handle = await fs.open(pinned.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameIdentity(pinned.stat, opened)) {
        await handle.close();
        throw new MediaError(409, "The file changed while opening it. Refresh the library.");
      }
      return { handle, stat: opened, mime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new MediaError(409, "The file changed while opening it. Refresh the library.");
      }
      throw error;
    } finally {
      await pinned.handle.close();
    }
  }
}

function sameDirectory(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isDirectory() && b.isDirectory();
}