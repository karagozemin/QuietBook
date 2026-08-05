import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const bbBrowser = join(dirname(fileURLToPath(import.meta.resolve("@aztec/bb.js"))), "../browser");

function bbBrowserAssets() {
  return {
    name: "quietbook-bb-browser-assets",
    configureServer(server: { middlewares: { use: (path: string, handler: (request: { url?: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use("/bb", (request, response, next) => {
        const relative = (request.url ?? "/").replace(/^\//, "");
        const file = join(bbBrowser, relative);
        try {
          if (!statSync(file).isFile()) return next();
          const contentType = extname(file) === ".js" ? "text/javascript" : "application/octet-stream";
          response.setHeader("content-type", contentType);
          createReadStream(file).pipe(response as never);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      cpSync(bbBrowser, resolve(__dirname, "dist/bb"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), bbBrowserAssets()],
  server: {
    host: "127.0.0.1",
    fs: { allow: [resolve(__dirname, "../..")] },
  },
});
