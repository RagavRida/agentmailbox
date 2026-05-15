# Research + Writer demo

Three long-running agents talking over AgentMail:

- **`user@demo`** (`kickoff.ts`) — sends one task and prints the final draft.
- **`researcher@demo`** (`researcher.ts`) — turns the task into a list of papers.
- **`writer@demo`** (`writer.ts`) — turns the papers into a short summary, replies on the thread.

It exists to demonstrate one specific claim: **no agent ever starts
cold.** Kill the writer mid-thread, restart it, and it resumes from
the researcher's snapshot without keeping any local state — every
piece of context lives on the thread.

## Setup

```bash
cd ~/agentmail/examples/research-writer
npm install
```

This pulls in the local `agentmail` package via `file:../..` plus the
Anthropic SDK. If `ANTHROPIC_API_KEY` is set, the agents call Claude;
otherwise they print a clearly-labelled stub response so the demo
still runs offline.

## Run it (four terminals)

```bash
# Terminal 1 — start the AgentMail server
cd ~/agentmail && npm start

# Terminal 2 — researcher loop
cd ~/agentmail/examples/research-writer && npm run researcher

# Terminal 3 — writer loop
cd ~/agentmail/examples/research-writer && npm run writer

# Terminal 4 — kick off one task
cd ~/agentmail/examples/research-writer && npm run kickoff -- "summarize diffusion models"
```

You should see the researcher pick up the task, then the writer pick
up the findings, then the kickoff script print the final draft.

## The cold-restart demo

This is the point of the example.

1. Start everything as above.
2. After kickoff prints a draft, run another kickoff:
   ```bash
   npm run kickoff -- "explain RLHF"
   ```
3. While the researcher is working, **kill the writer process** (Ctrl-C in terminal 3).
4. Restart it:
   ```bash
   npm run writer
   ```
5. Watch the writer's stdout: it logs
   `[writer] cold-resume thread <id> snapshot=...` for every thread it
   participates in. That snapshot comes from the researcher's last
   `contextSnapshot` — the writer has no local state of its own.
6. The new task completes normally. The writer resumed from the
   protocol, not from disk.

## Without an API key

The demo still works. Each agent prints:

```
[demo] ANTHROPIC_API_KEY unset — using stub responses
```

The stub replies are clearly labeled with `[STUB]` in their text so no
one mistakes them for real model output.
