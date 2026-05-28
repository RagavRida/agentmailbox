import { AgentMailbox } from "./src/agentmailbox";

async function checkAgent(agentId: string, server: string) {
  try {
    const agent = new AgentMailbox({ agentId, server });
    await agent.connect();
    
    // Check unread messages
    const { messages, context } = await agent.receive();
    
    // Check all threads
    const threads = await agent.threads();
    
    return {
      agentId,
      server,
      success: true as const,
      unreadCount: messages.length,
      threadsCount: threads.length,
      messages,
      context,
      threads
    };
  } catch (err: unknown) {
    return {
      agentId,
      server,
      success: false as const,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

async function main() {
  const servers = [
    "http://localhost:3000",
    "https://hdnxa5c8yr.us-east-1.awsapprunner.com"
  ];
  
  const agents = [
    "gemini@local",
    "claude@local",
    "cursor@local",
    "claude-code@local",
    "researcher@demo",
    "writer@demo"
  ];
  
  console.log("Checking mailboxes...");
  
  for (const server of servers) {
    console.log(`\n=== Server: ${server} ===`);
    for (const agentId of agents) {
      const res = await checkAgent(agentId, server);
      if (res.success) {
        console.log(`Agent: ${agentId} - Success! Unread: ${res.unreadCount}, Total Threads: ${res.threadsCount}`);
        if (res.unreadCount > 0) {
          console.log("Unread Messages:", JSON.stringify(res.messages, null, 2));
          console.log("Context Snapshot:", JSON.stringify(res.context, null, 2));
        }
        if (res.threadsCount > 0) {
          console.log("Threads:");
          for (const thread of res.threads) {
            console.log(`  - Thread ID: ${thread.id}`);
            console.log(`    Participants: ${thread.participants?.join(", ")}`);
            const lastMsg = thread.messages[thread.messages.length - 1];
            console.log(`    Last Message: ${lastMsg ? JSON.stringify(lastMsg.payload) : "(none)"}`);
            console.log(`    Message Count: ${thread.messages.length}`);
          }
        }
      } else {
        // Only print if not connection refused
        const errMsg = res.error;
        if (errMsg && !errMsg.includes("ECONNREFUSED") && !errMsg.includes("fetch failed")) {
          console.log(`Agent: ${agentId} - Error: ${errMsg}`);
        }
      }
    }
  }
}

main().catch(console.error);
