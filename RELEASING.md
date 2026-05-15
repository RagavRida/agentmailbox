# Releasing AgentMailbox 0.1.0

Reference commands for the human cutting the first release. **Do not
let CI run these — review the PR, then run them manually.**

## Pre-flight

- All CI green on `main`.
- `CHANGELOG.md` updated.
- Versions bumped in:
  - `package.json`
  - `mcp/package.json`
  - `sdk-py/pyproject.toml`
- Logged into `npm whoami` and `twine` (or have a `~/.pypirc`).

## npm (`agentmailbox`)

```bash
cd ~/agentmailbox
npm ci
npm run build
npm test
npm pack --dry-run    # inspect the file list — should be dist/, README, LICENSE, package.json only
npm publish --access public
```

## npm (`agentmailbox-mcp`)

```bash
cd ~/agentmailbox/mcp
npm ci
npm run build
npm pack --dry-run
npm publish --access public
```

## PyPI (`agentmailbox`)

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
git tag v0.1.0
git push --tags
```

Cut a GitHub release with the relevant CHANGELOG excerpt.

Smoke test from a fresh directory on a fresh machine:

```bash
# JS server + SDK
npx -y agentmailbox-server &
sleep 2 && curl -sf http://localhost:3000/health

# Python SDK
pip install agentmailbox
python -c "from agentmailbox import AgentMailbox; print('ok')"

# MCP adapter
npx -y agentmailbox-mcp --help
```

If any of those fail, yank the bad version (`npm unpublish` within 72h,
`twine` has no equivalent — bump to `0.1.1` instead) and start over.
