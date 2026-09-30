import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeTaggedFilename,
  MediaError,
  MediaLibrary,
  normalizeTag,
  splitTaggedFilename,
} from "../src/lib/media-files";
import { applyTagOperation, transferSelected } from "../src/lib/media-operations";

async function withLibrary(
  callback: (library: MediaLibrary, root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qimgv-gallery-test-"));
  try {
    await callback(await MediaLibrary.open(root), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("parses ordered trailing tags without changing the final extension", () => {
  assert.deepEqual(splitTaggedFilename("Summer.photo [Trip] [2026].JPG"), {
    stem: "Summer.photo",
    extension: ".JPG",
    tags: ["Trip", "2026"],
  });
  assert.deepEqual(splitTaggedFilename(".hidden"), {
    stem: ".hidden",
    extension: "",
    tags: [],
  });
  assert.equal(composeTaggedFilename("cat.png", "add", { tags: ["  Warm   light ", "pet"] }), "cat [Warm light] [pet].png");
  assert.equal(composeTaggedFilename("cat [Pet].png", "add", { tags: ["Pet"] }), "cat [Pet].png");
  assert.equal(composeTaggedFilename("cat [Pet].png", "add", { tags: ["pet"] }), "cat [Pet] [pet].png");
  assert.equal(composeTaggedFilename("cat [one] [two].jpeg", "edit", { oldTag: "one", newTag: "two" }), "cat [two].jpeg");
  assert.equal(composeTaggedFilename("cat [one] [two].jpeg", "remove", { oldTag: "one" }), "cat [two].jpeg");
});

test("normalizes whitespace and rejects unsafe tags", () => {
  assert.equal(normalizeTag("  family   trip  "), "family trip");
  for (const tag of ["", " \t ", ".", "..", "trailing.", "bad/name", "bad\\name", "[bad]", "bad:name", "bad\nname", "a\u0000b"]) {
    assert.throws(() => normalizeTag(tag), MediaError, tag);
  }
  assert.throws(() => composeTaggedFilename(`${"x".repeat(245)}.jpg`, "add", { tags: ["long tag"] }), MediaError);
});

test("lists folders, previewable media, unsupported regular files, and blocked links", async () => {
  await withLibrary(async (library, root) => {
    await fs.mkdir(path.join(root, "Albums"));
    await fs.writeFile(path.join(root, "photo [Family].PNG"), "image");
    await fs.writeFile(path.join(root, "clip.mp4"), "video");
    await fs.writeFile(path.join(root, "notes.txt"), "note");
    await fs.symlink(path.join(root, "Albums"), path.join(root, "linked"));
    const listing = await library.list();
    assert.equal(listing.parentPath, null);
    assert.equal(listing.totalMedia, 2);
    assert.equal(listing.totalEntries, 5);
    assert.equal(listing.entries[0].name, "Albums");
    assert.deepEqual(listing.entries.find((entry) => entry.name === "photo [Family].PNG")?.tags, ["Family"]);
    assert.equal(listing.entries.find((entry) => entry.name === "photo [Family].PNG")?.contentUrl, "/api/media/content?path=photo%20%5BFamily%5D.PNG");
    assert.equal(listing.entries.find((entry) => entry.name === "notes.txt")?.contentUrl, null);
    assert.equal(listing.entries.find((entry) => entry.name === "linked")?.kind, "symlink");
    assert.equal((await library.list("Albums")).parentPath, "");
  });
});

test("tagging a multi-file selection preserves bytes and preflights every collision", async () => {
  await withLibrary(async (library, root) => {
    await fs.writeFile(path.join(root, "a.JPG"), "a-data");
    await fs.writeFile(path.join(root, "b.webp"), "b-data");
    const result = await applyTagOperation(library, {
      operation: "add",
      paths: ["a.JPG", "b.webp"],
      tags: ["One", "Two"],
    });
    assert.equal(result.changedCount, 2);
    assert.deepEqual(await fs.readFile(path.join(root, "a [One] [Two].JPG"), "utf8"), "a-data");
    assert.deepEqual(await fs.readFile(path.join(root, "b [One] [Two].webp"), "utf8"), "b-data");
    const second = await applyTagOperation(library, {
      operation: "add",
      paths: ["a [One] [Two].JPG"],
      tags: ["Two", "One"],
    });
    assert.equal(second.unchangedCount, 1);

    await fs.writeFile(path.join(root, "a [One] [Two] [New].JPG"), "unrelated");
    await assert.rejects(
      () => applyTagOperation(library, {
        operation: "add",
        paths: ["a [One] [Two].JPG", "b [One] [Two].webp"],
        tags: ["New"],
      }),
      (error: unknown) => error instanceof MediaError && error.status === 409,
    );
    assert.equal(await fs.readFile(path.join(root, "a [One] [Two] [New].JPG"), "utf8"), "unrelated");
    await fs.access(path.join(root, "b [One] [Two].webp"));
    await assert.rejects(() => fs.access(path.join(root, "b [One] [Two] [New].webp")));
  });
});

test("rejects case-folded collisions conservatively while matching tag names case-sensitively", async () => {
  await withLibrary(async (library, root) => {
    await fs.writeFile(path.join(root, "photo.jpg"), "source");
    await fs.writeFile(path.join(root, "PHOTO [blue].JPG"), "other");
    await assert.rejects(
      () => applyTagOperation(library, { operation: "add", paths: ["photo.jpg"], tags: ["Blue"] }),
      (error: unknown) => error instanceof MediaError && error.status === 409,
    );
    assert.equal(await fs.readFile(path.join(root, "PHOTO [blue].JPG"), "utf8"), "other");
    assert.equal(await fs.readFile(path.join(root, "photo.jpg"), "utf8"), "source");
  });
});

test("supports edit and remove on unsupported browser-preview file types", async () => {
  await withLibrary(async (library, root) => {
    await fs.writeFile(path.join(root, ".config [old] [Other].raw"), "raw");
    const edit = await applyTagOperation(library, {
      operation: "edit",
      paths: [".config [old] [Other].raw"],
      oldTag: "old",
      newTag: "new",
    });
    assert.equal(edit.results[0].destinationPath, ".config [new] [Other].raw");
    const remove = await applyTagOperation(library, {
      operation: "remove",
      paths: [".config [new] [Other].raw"],
      oldTag: "Other",
    });
    assert.equal(remove.results[0].destinationPath, ".config [new].raw");
    assert.equal(await fs.readFile(path.join(root, ".config [new].raw"), "utf8"), "raw");
  });
});

test("keeps traversal, absolute paths, and symlinks out of all operations", async () => {
  await withLibrary(async (library, root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "qimgv-outside-"));
    try {
      await fs.writeFile(path.join(outside, "private.jpg"), "private");
      await fs.symlink(outside, path.join(root, "external"));
      await fs.symlink(path.join(outside, "private.jpg"), path.join(root, "file-link.jpg"));
      for (const relative of ["../private.jpg", "/etc/passwd", "external/private.jpg", "file-link.jpg", "external/../file-link.jpg"]) {
        await assert.rejects(() => library.inspect(relative, "file"), MediaError);
      }
      await assert.rejects(
        () => applyTagOperation(library, { operation: "add", paths: ["file-link.jpg"], tags: ["tag"] }),
        (error: unknown) => error instanceof MediaError && error.status === 400,
      );
      await assert.rejects(() => library.openContent("external/private.jpg"), MediaError);
      assert.equal(await fs.readFile(path.join(outside, "private.jpg"), "utf8"), "private");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("pinned directories do not follow an ancestor swapped for a symlink", async () => {
  await withLibrary(async (library, root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "qimgv-outside-"));
    try {
      await fs.mkdir(path.join(root, "album"));
      await fs.writeFile(path.join(root, "album", "image.jpg"), "inside");
      await fs.writeFile(path.join(outside, "image.jpg"), "outside");
      const pinned = await library.inspect("album/image.jpg", "file");
      try {
        await fs.rename(path.join(root, "album"), path.join(root, "renamed"));
        await fs.symlink(outside, path.join(root, "album"));
        assert.equal(await fs.readFile(pinned.absolute, "utf8"), "inside");
        assert.equal(await fs.readFile(path.join(root, "album", "image.jpg"), "utf8"), "outside");
        await fs.writeFile(pinned.absolute, "changed safely");
        assert.equal(await fs.readFile(path.join(root, "renamed", "image.jpg"), "utf8"), "changed safely");
        assert.equal(await fs.readFile(path.join(outside, "image.jpg"), "utf8"), "outside");
        await assert.rejects(
          () => library.inspect("album/image.jpg", "file"),
          (error: unknown) => error instanceof MediaError && error.status === 400,
        );
      } finally {
        await pinned.handle.close();
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("copy and move transfer into nested folders without overwriting", async () => {
  await withLibrary(async (library, root) => {
    await fs.mkdir(path.join(root, "albums", "selected"), { recursive: true });
    await fs.writeFile(path.join(root, "photo.png"), "original");
    await fs.writeFile(path.join(root, "video.mp4"), "video");
    const copied = await transferSelected(library, {
      operation: "copy",
      paths: ["photo.png", "video.mp4"],
      destinationDirectory: "albums/selected",
    });
    assert.equal(copied.successCount, 2);
    assert.equal(await fs.readFile(path.join(root, "photo.png"), "utf8"), "original");
    assert.equal(await fs.readFile(path.join(root, "albums/selected/photo.png"), "utf8"), "original");

    await fs.unlink(path.join(root, "albums/selected/photo.png"));
    await assert.rejects(
      () => transferSelected(library, {
        operation: "move",
        paths: ["photo.png", "video.mp4"],
        destinationDirectory: "albums/selected",
      }),
      (error: unknown) => error instanceof MediaError && error.status === 409,
    );
    await fs.access(path.join(root, "photo.png"));
    await fs.access(path.join(root, "video.mp4"));
    await assert.rejects(() => fs.access(path.join(root, "albums/selected/photo.png")));
    const moved = await transferSelected(library, {
      operation: "move",
      paths: ["photo.png"],
      destinationDirectory: "albums/selected",
    });
    assert.equal(moved.successCount, 1);
    await assert.rejects(() => fs.access(path.join(root, "photo.png")));
    assert.equal(await fs.readFile(path.join(root, "albums/selected/photo.png"), "utf8"), "original");
  });
});

test("media open accepts supported images and rejects non-media", async () => {
  await withLibrary(async (library, root) => {
    await fs.writeFile(path.join(root, "image.gif"), "GIF89a");
    await fs.writeFile(path.join(root, "archive.raw"), "not browser media");
    const image = await library.openContent("image.gif");
    assert.equal(image.mime, "image/gif");
    await image.handle.close();
    await assert.rejects(
      () => library.openContent("archive.raw"),
      (error: unknown) => error instanceof MediaError && error.status === 415,
    );
  });
});