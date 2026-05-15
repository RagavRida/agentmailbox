import { AgentMail } from "../src/agentmail";

async function main() {
  const server = process.env.AGENTMAIL_SERVER ?? "http://localhost:3000";

  // Orchestrator sends to Researcher
  // CC: Writer (watching, will jump in)
  // BCC: Logger (silent audit trail)
  const orchestrator = new AgentMail({
    agentId: "orchestrator@demo",
    server,
  });
  await orchestrator.connect();

  const { threadId, deliveredTo } = await orchestrator.send(
    "researcher@demo",
    { task: "find 50 papers on diffusion models" },
    {
      cc: ["writer@demo"],
      bcc: ["logger@demo"],
      contextSnapshot: { step: "task_dispatched", priority: "high" },
    }
  );
  console.log("[orchestrator] sent on thread:", threadId);
  console.log("[orchestrator] delivered to:", deliveredTo);

  // Researcher picks up — sees orchestrator sent it, writer is CC.
  // Does NOT see logger in bcc.
  const researcher = new AgentMail({
    agentId: "researcher@demo",
    server,
  });
  await researcher.connect();
  const inbound = await researcher.receive();
  console.log("[researcher] unread:", inbound.messages.length);
  console.log("[researcher] context.snapshot:", inbound.context.snapshot);
  console.log("[researcher] first message cc:", inbound.messages[0]?.cc);
  console.log(
    "[researcher] first message bcc (should be undefined):",
    inbound.messages[0]?.bcc
  );

  // Researcher replies to all (orchestrator + writer get it).
  const replied = await researcher.replyAll(
    threadId,
    {
      result: "found 50 papers",
      papers: ["paper1", "paper2"],
    },
    {
      contextSnapshot: { step: "research_complete", paperCount: 50 },
    }
  );
  console.log("[researcher] replyAll delivered to:", replied.deliveredTo);

  // Writer was CC'd — picks up full context.
  const writer = new AgentMail({ agentId: "writer@demo", server });
  await writer.connect();
  const writerInbox = await writer.receive();
  console.log("[writer] context.snapshot:", writerInbox.context.snapshot);
  console.log("[writer] unread count:", writerInbox.messages.length);

  // Logger was BCC'd — silently received the original message.
  const logger = new AgentMail({ agentId: "logger@demo", server });
  await logger.connect();
  const loggerUnread = await logger.unread();
  console.log("[logger] unread count:", loggerUnread.length);
  console.log(
    "[logger] bcc field stripped from their view:",
    loggerUnread[0]?.bcc === undefined
  );
  console.log("[logger] payload they saw:", loggerUnread[0]?.payload);

  // Participants endpoint — orchestrator (the bcc'er) sees logger.
  const orchView = await orchestrator.participants(threadId);
  console.log(
    "[orchestrator] sees participants:",
    orchView.map((p) => `${p.agentId}(${p.role})`)
  );

  // Writer (CC'd) does NOT see logger.
  const writerView = await writer.participants(threadId);
  console.log(
    "[writer] sees participants:",
    writerView.map((p) => `${p.agentId}(${p.role})`)
  );

  // Logger sees themselves listed.
  const loggerView = await logger.participants(threadId);
  console.log(
    "[logger] sees participants:",
    loggerView.map((p) => `${p.agentId}(${p.role})`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
