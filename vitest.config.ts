import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Pure triage logic: plain Node, no Workers runtime, runs in milliseconds.
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] },
      },

      // ReleaseAgent inside workerd (the real Workers runtime) with a real
      // Durable Object and SQLite storage.
      {
        plugins: [
          agents(), // decorator transform for @callable()
          cloudflareTest({
            main: "./src/server/index.ts",
            // Bindings are declared here rather than read from wrangler.jsonc:
            // its AI binding is remote and would need a Cloudflare login in CI.
            // Tests swap in a fake classifier instead (see ReleaseAgent.classify).
            miniflare: {
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: { ReleaseAgent: { className: "ReleaseAgent", useSQLite: true } },
            },
          }),
        ],
        test: { name: "workers", include: ["test/workers/**/*.test.ts"] },
      },
    ],
  },
});
