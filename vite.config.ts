import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// agents() adds the TC39 decorator transform that @callable() needs (Vite 8's
// Oxc transpiler doesn't support decorators yet). cloudflare() runs the Worker
// inside workerd during dev and builds it alongside the client.
export default defineConfig({
  plugins: [agents(), react(), cloudflare()],
});
