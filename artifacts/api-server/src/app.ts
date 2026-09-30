import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// The dev preview uses Vite. The single-container Umbrel build sets STATIC_DIR
// and serves the same frontend from this process on one origin and port.
if (process.env.STATIC_DIR) {
  const publicDirectory = path.resolve(process.env.STATIC_DIR);
  const indexFile = path.join(publicDirectory, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error("STATIC_DIR must contain the built frontend index.html.");
  }
  app.use(express.static(publicDirectory));
  app.get("/{*splat}", (req, res): void => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      res.status(404).json({ error: "API route not found." });
      return;
    }
    res.sendFile(indexFile);
  });
}

export default app;
