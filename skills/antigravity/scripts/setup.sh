#!/bin/bash
# AgentMailbox — Antigravity/Gemini CLI Setup Script
# Installs and configures AgentMailbox for use as an MCP tool

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     AgentMailbox — Setup for Antigravity      ║${NC}"
echo -e "${BLUE}║  Context-sync protocol for AI agents          ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check Node.js
echo -e "${YELLOW}[1/4]${NC} Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed. Please install Node.js 18+ first.${NC}"
    echo "  → https://nodejs.org/"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}✗ Node.js 18+ required (found v$(node -v))${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"

# Step 2: Install MCP adapter
echo ""
echo -e "${YELLOW}[2/4]${NC} Installing agentsmcp-adapter..."
if command -v agentsmcp-adapter &> /dev/null; then
    echo -e "${GREEN}✓${NC} agentsmcp-adapter already installed"
else
    npm install -g agentsmcp-adapter 2>/dev/null || {
        echo -e "${YELLOW}→${NC} Installing with npx (no global install needed)..."
        echo -e "${GREEN}✓${NC} Will use npx -y agentsmcp-adapter (auto-installs on first run)"
    }
fi

# Step 3: Check server
echo ""
echo -e "${YELLOW}[3/4]${NC} Checking AgentMailbox server..."

SERVER_URL="${AGENTSMCP_SERVER:-http://localhost:3000}"
DEMO_URL="https://hdnxa5c8yr.us-east-1.awsapprunner.com"

if curl -s --max-time 3 "$SERVER_URL/health" 2>/dev/null | grep -q '"ok":true'; then
    echo -e "${GREEN}✓${NC} Local server running at $SERVER_URL"
    ACTIVE_SERVER="$SERVER_URL"
elif curl -s --max-time 5 "$DEMO_URL/health" 2>/dev/null | grep -q '"ok":true'; then
    echo -e "${YELLOW}→${NC} Local server not running. Using public demo server."
    echo -e "${GREEN}✓${NC} Demo server available at $DEMO_URL"
    ACTIVE_SERVER="$DEMO_URL"
    echo ""
    echo -e "${YELLOW}  To start your own server:${NC}"
    echo "  npx agentsmcp-server"
else
    echo -e "${YELLOW}→${NC} No server detected. You can:"
    echo "  1. Start a local server:  npx agentsmcp-server"
    echo "  2. Use the demo server:   $DEMO_URL"
    ACTIVE_SERVER="$DEMO_URL"
fi

# Step 4: Print MCP config
AGENT_ID="${AGENTSMCP_AGENT_ID:-gemini@local}"

echo ""
echo -e "${YELLOW}[4/4]${NC} MCP Configuration"
echo ""
echo -e "${GREEN}Add this to your MCP settings:${NC}"
echo ""
cat << EOF
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "$AGENT_ID",
        "AGENTSMCP_SERVER": "$ACTIVE_SERVER"
      }
    }
  }
}
EOF

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "  Agent ID:  $AGENT_ID"
echo "  Server:    $ACTIVE_SERVER"
echo ""
echo "  Your agent can now:"
echo "    • agentsmcp_receive  — Check for context from previous sessions"
echo "    • agentsmcp_send     — Send messages to other agents"
echo "    • agentsmcp_sync     — Rejoin a thread with full context"
echo "    • agentsmcp_threads  — List all threads"
echo ""
echo -e "  ${BLUE}GitHub:${NC}  https://github.com/RagavRida/agentsmcp"
echo -e "  ${BLUE}Docs:${NC}    https://github.com/RagavRida/agentsmcp#readme"
echo ""
