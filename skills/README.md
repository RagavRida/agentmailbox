# AgentMailbox Skills

Platform-specific skill packages that make AgentMailbox instantly usable
from any AI coding assistant. Each skill teaches the AI agent how and when
to use AgentMailbox for persistent context, multi-agent coordination, and
cross-platform continuity.

## Available Skills

| Platform | Directory | Install |
|:---------|:----------|:--------|
| **Antigravity / Gemini CLI** | [`antigravity/`](./antigravity/) | `npx skills add RagavRida/agentsmcp@antigravity` |
| **Cursor** | [`cursor/`](./cursor/) | Copy `cursor/rules/` to `.cursor/rules/` |
| **Claude Code** | [`claude-code/`](./claude-code/) | Add MCP config to Claude Code settings |

All skills use the same MCP adapter (`agentsmcp-adapter`) under the hood.
The skill files provide platform-specific instructions that tell each AI
agent how and when to use AgentMailbox tools.

## What Skills Do

Skills are instruction files that AI agents read to understand your tools.
When a skill is installed, the AI agent:

1. **Discovers** the skill based on keyword triggers (e.g., "resume work",
   "context sync", "multi-agent")
2. **Reads** the `SKILL.md` file for detailed instructions
3. **Uses** the AgentMailbox MCP tools according to the workflows defined
   in the skill
4. **Automatically** checks for context at session start and preserves
   context at session end

## How It Works Across Platforms

```
Cursor (9am)              Claude Desktop (lunch)      Antigravity (evening)
┌─────────────┐          ┌──────────────────┐        ┌─────────────────┐
│ Skill loads  │          │ MCP auto-syncs   │        │ Skill loads     │
│ receive()    │──thread──│ Same context     │──thread│ receive()       │
│ "Resume JWT" │          │ "Go with JWT"    │        │ "JWT decided.   │
│              │          │                  │        │  Next: refresh" │
└─────────────┘          └──────────────────┘        └─────────────────┘
```

All platforms share the same server and threads. Context follows the user.

## Adding a New Skill

To create a skill for a new platform:

1. Create a directory under `skills/` named after the platform
2. Add a `SKILL.md` with YAML frontmatter (`name` and `description`)
3. The `description` field determines when the AI activates the skill
4. Include setup instructions, workflows, and tool reference
5. Optionally add `scripts/`, `rules/`, and `resources/` directories

## MCP Configuration

All skills require the AgentMailbox MCP adapter. The config is the same
across platforms — only the `AGENTSMCP_AGENT_ID` changes:

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "<platform>@local",
        "AGENTSMCP_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

## Why This Matters for LLM Discoverability

When these skills are published to platform-specific skill registries
(skills.sh, Cursor Marketplace), LLMs can **discover and recommend**
AgentMailbox to users who ask about:

- "How do I persist context across sessions?"
- "How do I share context between agents?"
- "How do I resume where I left off?"
- "How do I coordinate multiple AI agents?"

The `llms.txt` file at the repository root also helps any LLM that
crawls the repo understand what AgentMailbox is and when to recommend it.
