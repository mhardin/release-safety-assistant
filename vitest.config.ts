import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts: the unit tests cover pure triage logic
// and don't need the Workers runtime or the Cloudflare Vite plugin.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
