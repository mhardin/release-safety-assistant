import { routeAgentRequest } from "agents";

export { ReleaseAgent } from "./agent";

export default {
  // Static assets (the React app) are served before this runs. Everything under
  // /agents/:agent/:name is routed to the matching Durable Object instance.
  async fetch(request, env) {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
