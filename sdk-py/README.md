# AgentMail — Python SDK

Python client for [AgentMail](../README.md), the context-sync protocol
for AI agents. Mirrors the JS SDK feature-for-feature.

## Install

```bash
pip install -e ".[dev]"
```

Requires Python 3.10+.

## Start the server

The Python SDK is a pure HTTP client — it talks to the AgentMail
Node server. Start it first:

```bash
cd ~/agentmail
npm start
```

## Async usage

```python
import asyncio
from agentmail import AgentMail

async def main():
    async with AgentMail("researcher@demo", server="http://localhost:3000") as a:
        await a.connect()
        result = await a.send(
            "writer@demo",
            {"task": "summarize diffusion models"},
            context_snapshot={"step": "research_complete", "paper_count": 2},
        )
        print(result.thread_id)

asyncio.run(main())
```

## Multi-agent (CC/BCC/ReplyAll)

```python
async with AgentMail("orchestrator@demo", server=SERVER) as orchestrator:
    await orchestrator.connect()
    sent = await orchestrator.send(
        "researcher@demo",
        {"task": "find 50 papers on diffusion models"},
        cc=["writer@demo"],
        bcc=["logger@demo"],
        context_snapshot={"step": "task_dispatched", "priority": "high"},
    )

async with AgentMail("researcher@demo", server=SERVER) as researcher:
    await researcher.connect()
    inbound = await researcher.receive()
    # inbound.context.snapshot → {"step": "task_dispatched", "priority": "high"}
    # inbound.messages[0].cc   → ["writer@demo"]
    # inbound.messages[0].bcc  → None  (stripped from non-sender's view)

    await researcher.reply_all(
        sent.thread_id,
        {"result": "found 50 papers"},
        context_snapshot={"step": "research_complete", "paper_count": 50},
    )
```

Run the bundled demos:

```bash
python examples/basic.py
python examples/multi_agent.py
```

## Sync usage

For scripts and notebooks that aren't async-friendly:

```python
from agentmail import AgentMailSync

agent = AgentMailSync("researcher@demo")
agent.connect()
result = agent.send("writer@demo", {"task": "..."})
print(result.thread_id)
```

`AgentMailSync` drives a fresh event loop per call via `asyncio.run`.
It's convenient but slower than the async client.

## API

All methods return typed dataclasses (`SendResult`, `ReceiveResult`,
`Thread`, `ContextFrame`, `Message`, `ParticipantRole`, `Context`).
No untyped dicts in the public surface.

| Method                          | HTTP                                |
| ------------------------------- | ----------------------------------- |
| `connect()`                     | `POST /agents/register`             |
| `send(to, payload, ...)`        | `POST /messages/send`               |
| `reply_all(thread_id, payload)` | `POST /messages/reply-all`          |
| `unread()`                      | `GET /mailbox/:id/unread`           |
| `receive(from_agent=None)`      | `GET /mailbox/:id/unread` + filter  |
| `threads()`                     | `GET /mailbox/:id`                  |
| `sync(thread_id)`               | `GET /threads/:id/sync?as=:id`      |
| `participants(thread_id)`       | `GET /threads/:id/participants?as=` |
| `mark_read(thread_id)`          | `POST /mailbox/:id/read`            |

## Exceptions

- `AgentMailError` — base class. `.status_code` set when raised from HTTP.
- `NotFoundError` — 404
- `ServerError` — 5xx
- `ConnectionError` — server unreachable

## License

MIT
