import { routeAgentRequest } from "agents";
import { isValidServiceName } from "../shared/service";

export { ReleaseAgent } from "./agent";

// The only agent route this app serves: /agents/release-agent/<service>[/...]
const AGENT_PATH = /^\/agents\/release-agent\/([^/]+)(?:\/|$)/;

export default {
  // Static assets (the React app) are served before this runs. Everything under
  // /agents/release-agent/:name is routed to the matching Durable Object instance.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/agents/")) {
      const name = AGENT_PATH.exec(url.pathname)?.[1];
      // Checked as sent: a valid name never needs percent-encoding.
      if (!name || !isValidServiceName(name)) {
        return new Response("Invalid service name: use lowercase letters, digits, and dashes.", { status: 400 });
      }
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
