# Releasing AgentsMCP

Reference commands for the human cutting a release. **Do not
let CI run these — review the PR, then run them manually.**

## Pre-flight

- All CI green on `main`.
- `CHANGELOG.md` updated.
- Versions bumped in:
  - `package.json` (main SDK + MCP adapter)
  - `mcp/package.json` (deprecated shim — bump if publishing)
  - `sdk-py/pyproject.toml` (Python SDK)
  - `langgraph/package.json` (LangGraph adapter)
- Logged into `npm whoami` and `twine` (or have a `~/.pypirc`).
- E2E smoke passes: `npm run smoke:e2e`

## npm (`agentsmcp`)

```bash
cd ~/agentmailbox
npm ci
npm run build
npm test
npm run smoke:e2e
npm pack --dry-run    # inspect: dist/, README, LICENSE, package.json
npm publish --access public
```

## npm (`agentsmcp-adapter` — deprecated shim)

Only needed if the shim itself changed. Usually skip this.

```bash
cd ~/agentmailbox/mcp
npm ci
npm run build
npm pack --dry-run
npm publish --access public --tag deprecated
```

## npm (`agentsmcp-langgraph`)

```bash
cd ~/agentmailbox/langgraph
npm ci
npm run build
npm test
npm pack --dry-run
npm publish --access public
```

## PyPI (`agentsmcp`)

```bash
cd ~/agentmailbox/sdk-py
python -m venv .venv
.venv/bin/pip install --upgrade pip build twine
.venv/bin/python -m build
.venv/bin/twine check dist/*
.venv/bin/twine upload dist/*
```

## Post-publish

```bash
git tag v0.4.0
git push --tags
```

Cut a GitHub release with the relevant CHANGELOG excerpt.

Smoke test from a fresh directory:

```bash
# JS server
npx -y agentsmcp-server &
sleep 2 && curl -sf http://localhost:3000/health

# MCP adapter (same package now)
npx -y agentsmcp --help

# Python SDK
pip install agentsmcp
python -c "from agentmailbox import AgentMailbox; print('ok')"

# Legacy adapter shim (should still work)
npx -y agentsmcp-adapter --help
```

If any of those fail, yank the bad version (`npm unpublish` within 72h,
`twine` has no equivalent — bump patch version instead) and start over.
