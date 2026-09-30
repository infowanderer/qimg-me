import { constants } from "node:fs";
import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  composeTaggedFilename,
  lstatIfPresent,
  MediaError,
  type MediaLibrary,
  relativeJoin,
  sameIdentity,
  validateRelativePath,
} from "./media-files";

type Source = { relative: string; absolute: string; stat: Stats; handle: FileHandle };
type Plan = Source & {
  destinationPath: string;
  destinationAbsolute: string;
  parentPath: string;
  parentAbsolute: string;
  parentStat: Stats;
  parentHandle: FileHandle;
};

export type TagInput = {
  operation: "add" | "remove" | "edit";
  paths: string[];
  tags?: string[];
  oldTag?: string;
  newTag?: string;
};

export type TransferInput = {
  operation: "copy" | "move";
  paths: string[];
  destinationDirectory: string;
};

// A single process must not run two of its own preflight/commit sequences at once.
let mutationQueue: Promise<void> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(work);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function sourcesFor(library: MediaLibrary, paths: string[]): Promise<Source[]> {
  if (paths.length < 1 || paths.length > 250 || new Set(paths).size !== paths.length) {
    throw new MediaError(400, "Select between 1 and 250 different files.");
  }
  const sources: Source[] = [];
  try {
    for (const relative of paths) {
      validateRelativePath(relative);
      const { absolute, stat, handle } = await library.inspect(relative, "file");
      sources.push({ relative, absolute, stat, handle });
    }
    return sources;
  } catch (error) {
    await Promise.allSettled(sources.map((source) => source.handle.close()));
    throw error;
  }
}

function sameDirectoryIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isDirectory() && b.isDirectory();
}

async function verifyPlan(library: MediaLibrary, plan: Plan): Promise<void> {
  const source = await library.inspect(plan.relative, "file");
  try {
    const parent = await library.inspect(plan.parentPath, "directory");
    try {
      if (!sameIdentity(plan.stat, source.stat) || !sameDirectoryIdentity(plan.parentStat, parent.stat)) {
        throw new MediaError(409, "A file or folder changed during the operation. Refresh and try again.");
      }
    } finally {
      await parent.handle.close();
    }
  } finally {
    await source.handle.close();
  }
}

async function preflightDestinations(plans: Plan[]): Promise<void> {
  const namesByDirectory = new Map<string, string[]>();
  const intended = new Set<string>();
  for (const plan of plans) {
    const directoryKey = `${plan.parentStat.dev}:${plan.parentStat.ino}`;
    const collisionKey = `${directoryKey}\0${path.basename(plan.destinationAbsolute).toLowerCase()}`;
    if (intended.has(collisionKey)) {
      throw new MediaError(409, "Two selected files would get the same destination name.");
    }
    intended.add(collisionKey);
    let names = namesByDirectory.get(directoryKey);
    if (!names) {
      names = await fs.readdir(plan.parentAbsolute);
      namesByDirectory.set(directoryKey, names);
    }
    const destinationName = path.basename(plan.destinationAbsolute);
    // Conservative case-insensitive collision check protects mounted FAT/SMB shares,
    // even when the server itself runs on a case-sensitive Linux filesystem.
    if (names.some((name) => name.toLowerCase() === destinationName.toLowerCase())) {
      throw new MediaError(409, `Destination already exists: "${plan.destinationPath}". Nothing was changed.`);
    }
  }
}

async function assertDestinationFree(plan: Plan): Promise<void> {
  const names = await fs.readdir(plan.parentAbsolute);
  if (names.some((name) => name.toLowerCase() === path.basename(plan.destinationAbsolute).toLowerCase())) {
    throw new MediaError(409, `Destination already exists: "${plan.destinationPath}".`);
  }
}

async function assertSourceUnchanged(plan: Plan): Promise<void> {
  const current = await lstatIfPresent(plan.absolute);
  if (!current || !sameIdentity(current, plan.stat)) {
    throw new MediaError(409, "The source file changed. Refresh before retrying.");
  }
}

async function safeRemoveLinkedTarget(plan: Plan): Promise<boolean> {
  const target = await lstatIfPresent(plan.destinationAbsolute);
  if (!target) return true;
  if (!sameIdentity(target, plan.stat)) return false;
  await fs.unlink(plan.destinationAbsolute);
  return true;
}

async function rollbackTagLinks(plans: Plan[], removedSources: Set<string>): Promise<boolean> {
  let complete = true;
  for (const plan of plans) {
    if (!removedSources.has(plan.relative)) continue;
    try {
      const existing = await lstatIfPresent(plan.absolute);
      const target = await lstatIfPresent(plan.destinationAbsolute);
      if (existing || !target || !sameIdentity(target, plan.stat)) {
        complete = false;
        continue;
      }
      await fs.link(plan.destinationAbsolute, plan.absolute);
    } catch {
      complete = false;
    }
  }
  for (const plan of plans) {
    try {
      const source = await lstatIfPresent(plan.absolute);
      if (!source || !sameIdentity(source, plan.stat) || !(await safeRemoveLinkedTarget(plan))) {
        complete = false;
      }
    } catch {
      complete = false;
    }
  }
  return complete;
}

export function applyTagOperation(
  library: MediaLibrary,
  input: TagInput,
): Promise<{
  results: { sourcePath: string; destinationPath: string; status: "renamed" | "unchanged" }[];
  changedCount: number;
  unchangedCount: number;
}> {
  return serialized(async () => {
    const sources = await sourcesFor(library, input.paths);
    const plans: Plan[] = [];
    const results = [];
    try {
    for (const source of sources) {
      const newName = composeTaggedFilename(
        path.basename(source.absolute),
        input.operation,
        input,
      );
      const parentPath = source.relative.includes("/")
        ? source.relative.slice(0, source.relative.lastIndexOf("/"))
        : "";
      const destinationPath = relativeJoin(parentPath, newName);
      if (destinationPath === source.relative) {
        results.push({
          sourcePath: source.relative,
          destinationPath,
          status: "unchanged" as const,
        });
        continue;
      }
      const parent = await library.inspect(parentPath, "directory");
      plans.push({
        ...source,
        destinationPath,
        destinationAbsolute: path.join(parent.absolute, newName),
        parentPath,
        parentAbsolute: parent.absolute,
        parentStat: parent.stat,
        parentHandle: parent.handle,
      });
      results.push({
        sourcePath: source.relative,
        destinationPath,
        status: "renamed" as const,
      });
    }
    await preflightDestinations(plans);

    const staged: Plan[] = [];
    const removedSources = new Set<string>();
    try {
      // Hard links reserve names with no overwrite and leave every source intact
      // until all destinations are safely staged. Tags never cross directories.
      for (const plan of plans) {
        await verifyPlan(library, plan);
        await assertDestinationFree(plan);
        await fs.link(plan.absolute, plan.destinationAbsolute);
        staged.push(plan);
        const linked = await fs.lstat(plan.destinationAbsolute);
        if (!sameIdentity(linked, plan.stat)) {
          throw new MediaError(409, "The file changed during the operation.");
        }
      }
      for (const plan of plans) {
        await verifyPlan(library, plan);
        await assertSourceUnchanged(plan);
        await fs.unlink(plan.absolute);
        removedSources.add(plan.relative);
      }
    } catch (error) {
      const restored = await rollbackTagLinks(staged, removedSources);
      if (!restored) {
        throw new MediaError(
          500,
          "A rename failed and rollback was incomplete. Refresh and inspect the affected files before retrying.",
        );
      }
      if (error instanceof MediaError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MediaError(409, "A destination appeared during the operation. Nothing was changed.");
      }
      throw new MediaError(500, "The rename failed. No filenames were changed.");
    }
    return {
      results,
      changedCount: plans.length,
      unchangedCount: results.length - plans.length,
    };
    } finally {
      await Promise.allSettled([
        ...sources.map((source) => source.handle.close()),
        ...plans.map((plan) => plan.parentHandle.close()),
      ]);
    }
  });
}

async function copyExclusive(library: MediaLibrary, plan: Plan): Promise<void> {
  const sourceHandle = await fs.open(plan.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let targetIdentity: Stats | undefined;
  try {
    const opened = await sourceHandle.stat();
    if (!sameIdentity(opened, plan.stat)) {
      throw new MediaError(409, "The source changed while copying it.");
    }
    targetHandle = await fs.open(
      plan.destinationAbsolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      plan.stat.mode,
    );
    targetIdentity = await targetHandle.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const count = Math.min(buffer.length, opened.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, count, position);
      if (bytesRead === 0) throw new MediaError(409, "The source changed while copying it.");
      let written = 0;
      while (written < bytesRead) {
        const write = await targetHandle.write(buffer, written, bytesRead - written, position + written);
        if (write.bytesWritten === 0) throw new MediaError(500, "Could not finish writing the file.");
        written += write.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (!sameIdentity(after, opened) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new MediaError(409, "The source changed while copying it.");
    }
    await verifyPlan(library, plan);
    await targetHandle.chmod(opened.mode);
    await targetHandle.utimes(opened.atime, opened.mtime);
    await targetHandle.sync();
  } catch (error) {
    if (targetHandle) await targetHandle.close();
    targetHandle = undefined;
    // Never delete an unexpected replacement created by another process.
    if (targetIdentity) {
      try {
        const current = await lstatIfPresent(plan.destinationAbsolute);
        if (current && sameIdentity(current, targetIdentity)) await fs.unlink(plan.destinationAbsolute);
      } catch {
        throw new MediaError(
          500,
          `Copy failed and the partial destination may remain: "${plan.destinationPath}". Inspect it before retrying.`,
        );
      }
    }
    throw error;
  } finally {
    await targetHandle?.close();
    await sourceHandle.close();
  }
}

function failureMessage(error: unknown, destinationPath: string): string {
  if (error instanceof MediaError) return error.message;
  switch ((error as NodeJS.ErrnoException).code) {
    case "EEXIST":
      return `Destination already exists: "${destinationPath}".`;
    case "ENOSPC":
      return "The destination is out of space.";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "Permission denied. Check the media mount's write access.";
    default:
      return "The filesystem operation failed. Refresh before trying again.";
  }
}

async function transferOne(library: MediaLibrary, plan: Plan, operation: "copy" | "move"): Promise<void> {
  await verifyPlan(library, plan);
  await assertDestinationFree(plan);
  if (operation === "copy") {
    await copyExclusive(library, plan);
    return;
  }

  let linked = false;
  try {
    await fs.link(plan.absolute, plan.destinationAbsolute);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Moving between two mounted filesystems cannot be atomic.
    await copyExclusive(library, plan);
    try {
      await verifyPlan(library, plan);
      await assertSourceUnchanged(plan);
      await fs.unlink(plan.absolute);
    } catch {
      throw new MediaError(
        500,
        `The copy at "${plan.destinationPath}" succeeded, but the source could not be removed. Both may remain.`,
      );
    }
    return;
  }
  if (linked) {
    try {
      const target = await fs.lstat(plan.destinationAbsolute);
      if (!sameIdentity(target, plan.stat)) {
        throw new MediaError(409, "The destination changed during the move.");
      }
      await verifyPlan(library, plan);
      await assertSourceUnchanged(plan);
      await fs.unlink(plan.absolute);
    } catch (error) {
      const source = await lstatIfPresent(plan.absolute);
      if (!source || !sameIdentity(source, plan.stat) || !(await safeRemoveLinkedTarget(plan))) {
        throw new MediaError(
          500,
          `The move did not finish cleanly. Refresh and inspect "${plan.destinationPath}".`,
        );
      }
      throw error;
    }
  }
}

export function transferSelected(
  library: MediaLibrary,
  input: TransferInput,
): Promise<{
  results: {
    sourcePath: string;
    destinationPath: string;
    status: "copied" | "moved" | "failed";
    error: string | null;
  }[];
  successCount: number;
  failureCount: number;
}> {
  return serialized(async () => {
    validateRelativePath(input.destinationDirectory, true);
    const directory = await library.inspect(input.destinationDirectory, "directory");
    let sources: Source[] = [];
    try {
    sources = await sourcesFor(library, input.paths);
    const plans: Plan[] = sources.map((source) => {
      const destinationPath = relativeJoin(
        input.destinationDirectory,
        path.basename(source.absolute),
      );
      return {
        ...source,
        destinationPath,
        destinationAbsolute: path.join(directory.absolute, path.basename(source.absolute)),
        parentPath: input.destinationDirectory,
        parentAbsolute: directory.absolute,
        parentStat: directory.stat,
        parentHandle: directory.handle,
      };
    });
    await preflightDestinations(plans);
    const results: {
      sourcePath: string;
      destinationPath: string;
      status: "copied" | "moved" | "failed";
      error: string | null;
    }[] = [];
    for (const plan of plans) {
      try {
        await transferOne(library, plan, input.operation);
        results.push({
          sourcePath: plan.relative,
          destinationPath: plan.destinationPath,
          status: input.operation === "copy" ? "copied" : "moved",
          error: null,
        });
      } catch (error) {
        results.push({
          sourcePath: plan.relative,
          destinationPath: plan.destinationPath,
          status: "failed",
          error: failureMessage(error, plan.destinationPath),
        });
      }
    }
    return {
      results,
      successCount: results.filter((result) => result.status !== "failed").length,
      failureCount: results.filter((result) => result.status === "failed").length,
    };
    } finally {
      await Promise.allSettled([
        directory.handle.close(),
        ...sources.map((source) => source.handle.close()),
      ]);
    }
  });
}