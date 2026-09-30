import { Router, type IRouter, type Request, type Response } from "express";
import {
  ApplyTagsBody,
  ApplyTagsResponse,
  GetMediaContentQueryParams,
  GetMediaEntriesQueryParams,
  GetMediaEntriesResponse,
  TransferFilesBody,
  TransferFilesResponse,
} from "@workspace/api-zod";
import { MediaError, MediaLibrary } from "../lib/media-files";
import { applyTagOperation, transferSelected } from "../lib/media-operations";

const router: IRouter = Router();

function configuredHosts(): Set<string> {
  const explicit = (process.env.MEDIA_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const replit = (process.env.REPLIT_DOMAINS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  if (process.env.REPLIT_DEV_DOMAIN) replit.push(process.env.REPLIT_DEV_DOMAIN);
  if (process.env.NODE_ENV === "production" && !explicit.length && !replit.length) {
    throw new Error("MEDIA_ALLOWED_HOSTS must list the public host:port in production.");
  }
  const local = process.env.NODE_ENV === "production"
    ? ["localhost:3000", "127.0.0.1:3000"]
    : ["localhost", "localhost:80", "localhost:8080", "127.0.0.1", "127.0.0.1:80", "127.0.0.1:8080"];
  return new Set([...explicit, ...replit, ...local].map((host) => host.toLowerCase()));
}

const allowedHosts = configuredHosts();

function respondWithError(req: Request, res: Response, error: unknown): void {
  if (error instanceof MediaError) {
    req.log.warn({ status: error.status, error: error.message }, "Media request rejected");
    res.status(error.status).json({ error: error.message });
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  req.log.error({ err: error }, "Media operation failed");
  res.status(code === "ENOENT" ? 404 : 500).json({
    error: code === "ENOENT"
      ? "File or directory not found. Refresh the library."
      : "The filesystem operation failed. Check permissions and retry.",
  });
}

// The UI uses the same host for the app and API. Reject cross-site mutations
// even if this service is later exposed behind a reverse proxy.
router.use("/media", (req, res, next): void => {
  const host = req.get("host")?.toLowerCase();
  if (!host || !allowedHosts.has(host)) {
    res.status(403).json({ error: "This hostname is not allowed for media access." });
    return;
  }
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) {
        res.status(403).json({ error: "Cross-origin media requests are not allowed." });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin." });
      return;
    }
  }
  if (req.method === "POST" && !req.is("application/json")) {
    res.status(400).json({ error: "Send a JSON request body." });
    return;
  }
  next();
});

router.get("/media/entries", async (req, res): Promise<void> => {
  if (req.query.path !== undefined && typeof req.query.path !== "string") {
    res.status(400).json({ error: "Invalid directory path." });
    return;
  }
  const query = GetMediaEntriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid directory path." });
    return;
  }
  try {
    const library = await MediaLibrary.open();
    res.json(GetMediaEntriesResponse.parse(await library.list(query.data.path)));
  } catch (error) {
    respondWithError(req, res, error);
  }
});

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size === 0 || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  ) return null;
  return { start, end: Math.min(end, size - 1) };
}

router.get("/media/content", async (req, res): Promise<void> => {
  if (typeof req.query.path !== "string") {
    res.status(400).json({ error: "Invalid file path." });
    return;
  }
  const query = GetMediaContentQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid file path." });
    return;
  }
  try {
    const library = await MediaLibrary.open();
    const { handle, stat, mime } = await library.openContent(query.data.path);
    const rawRange = req.get("range");
    const range = rawRange ? parseRange(rawRange, stat.size) : null;
    if (rawRange && !range) {
      await handle.close();
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      res.status(416).json({ error: "Invalid media byte range." });
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", Math.max(0, end - start + 1));
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (stat.size === 0) {
      await handle.close();
      res.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", (error) => {
      req.log.error({ err: error }, "Media stream failed");
      if (!res.headersSent) res.status(500).json({ error: "Could not read the media file." });
      else res.destroy(error);
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    respondWithError(req, res, error);
  }
});

router.post("/media/tags", async (req, res): Promise<void> => {
  const body = ApplyTagsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid tag request. Select files and enter valid tags." });
    return;
  }
  try {
    const library = await MediaLibrary.open();
    res.json(ApplyTagsResponse.parse(await applyTagOperation(library, body.data)));
  } catch (error) {
    respondWithError(req, res, error);
  }
});

router.post("/media/transfers", async (req, res): Promise<void> => {
  const body = TransferFilesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid transfer request. Select files and a destination folder." });
    return;
  }
  try {
    const library = await MediaLibrary.open();
    res.json(TransferFilesResponse.parse(await transferSelected(library, body.data)));
  } catch (error) {
    respondWithError(req, res, error);
  }
});

export default router;