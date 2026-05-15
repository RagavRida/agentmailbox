import { AgentMailbox } from "../src/agentmailbox";

async function main() {
  const server = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:3000";

  // ResearchAgent
  const researcher = new AgentMailbox({
    agentId: "researcher@demo",
    server,
  });
  await researcher.connect();

  const { threadId } = await researcher.send(
    "writer@demo",
    { task: "summarize diffusion models", papers: ["paper1", "paper2"] },
    { contextSnapshot: { step: "research_complete", paperCount: 2 } }
  );
  console.log("[researcher] sent on thread:", threadId);

  // WriterAgent — picks up full context even after restart
  const writer = new AgentMailbox({
    agentId: "writer@demo",
    server,
  });
  await writer.connect();

  const { messages, context } = await writer.receive();
  console.log("[writer] unread messages:", messages.length);
  console.log("[writer] context.snapshot:", context.snapshot);
  // → { step: "research_complete", paperCount: 2 }
  // Writer is fully caught up. Never started cold.

  const reply = await writer.send(
    "researcher@demo",
    { draft: "Diffusion models work by..." },
    {
      threadId,
      contextSnapshot: { step: "draft_complete", wordCount: 500 },
    }
  );
  console.log("[writer] reply sent:", reply.messageId);

  await writer.markRead(threadId);

  // Researcher syncs full thread
  const synced = await researcher.sync(threadId);
  console.log("[researcher] synced snapshot:", synced.context.snapshot);
  console.log(
    "[researcher] recent messages:",
    synced.context.recentMessages.map((m) => ({ from: m.from, payload: m.payload }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
