import { useAgent } from "agents/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ReleaseAgent } from "../server/agent";
import { SAMPLES } from "../shared/samples";
import type { AgentState, ChatMessage, Verdict } from "../shared/types";

const SAMPLE_LABELS: Record<keyof typeof SAMPLES, string> = {
  environmentFailure: "Registry timeout",
  changeFailure: "Failing test",
  mixedFailure: "Crash-looping deploy",
  changeDescription: "Describe a change",
};

export function App() {
  const [service, setService] = useState("checkout-api");
  const [draftService, setDraftService] = useState(service);

  return (
    <main>
      <header>
        <h1>Release Safety Assistant</h1>
        <form
          className="service"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftService.trim()) setService(draftService.trim().toLowerCase());
          }}
        >
          <label htmlFor="service">Service</label>
          <input id="service" value={draftService} onChange={(e) => setDraftService(e.target.value)} />
          <button type="submit">Switch</button>
        </form>
      </header>
      {/* key remounts the chat so each service gets its own agent connection */}
      <Chat key={service} service={service} />
    </main>
  );
}

function Chat({ service }: { service: string }) {
  // Connects a WebSocket to /agents/release-agent/<service>, the Durable Object for this service.
  const agent = useAgent<ReleaseAgent, AgentState>({ agent: "release-agent", name: service });
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const messages = agent.state?.messages ?? [];
  const busy = agent.state?.busy ?? false;

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setError(null);
    const text = input;
    setInput("");
    try {
      await agent.stub.triage(text);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <p className="empty">
            Paste a failing CI or deploy log, or describe a change you want to ship. History for <b>{service}</b> is kept
            separately from other services.
          </p>
        )}
        {messages.map((m) => <Message key={m.id} message={m} />)}
        {busy && <p className="thinking">Triaging…</p>}
        <div ref={bottom} />
      </div>

      <div className="samples">
        Try a sample:
        {(Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]).map((k) => (
          <button key={k} type="button" onClick={() => setInput(SAMPLES[k])}>{SAMPLE_LABELS[k]}</button>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
          placeholder="Paste a log or describe a change… (⌘/Ctrl+Enter to send)"
          rows={6}
        />
        <button type="submit" disabled={busy || !input.trim()}>Triage</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return <pre className="msg user">{message.text}</pre>;
  }
  return (
    <div className="msg assistant">
      {message.verdict ? <VerdictCard verdict={message.verdict} /> : <p>{message.text}</p>}
    </div>
  );
}

const ACTION_LABEL: Record<Verdict["action"], string> = {
  retry: "Retry",
  rollback: "Roll back",
  staged_rollout: "Staged rollout (canary → 25% → 100%)",
};

function VerdictCard({ verdict }: { verdict: Verdict }) {
  const pct = Math.round(verdict.confidence * 100);
  const title = verdict.kind === "change_description" ? "Change assessment" : `Likely cause: ${verdict.cause}`;
  return (
    <div className={`verdict cause-${verdict.cause}`}>
      <div className="verdict-head">
        <strong>{title}</strong>
        {verdict.kind === "failure_log" && <span className="confidence">{pct}% confidence</span>}
        <span className="source">via {verdict.source}</span>
      </div>
      <p>{verdict.reasoning}</p>
      {verdict.evidence.length > 0 && (
        <>
          <h4>Evidence</h4>
          <ul>{verdict.evidence.map((e) => <li key={e}><code>{e}</code></li>)}</ul>
        </>
      )}
      <p className="action">Recommended: <b>{ACTION_LABEL[verdict.action]}</b></p>
    </div>
  );
}
