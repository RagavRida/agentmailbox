# Releasing AgentMail 0.1.0

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

## npm (`agentmail`)

```bash
cd ~/agentmail
npm ci
npm run build
npm test
npm pack --dry-run    # inspect the file list — should be dist/, README, LICENSE, package.json only
npm publish --access public
```

## npm (`agentmail-mcp`)

```bash
cd ~/agentmail/mcp
npm ci
npm run build
npm pack --dry-run
npm publish --access public
```

## PyPI (`agentmail`)

```bash
cd ~/agentmail/sdk-py
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
npx -y agentmail-server &
sleep 2 && curl -sf http://localhost:3000/health

# Python SDK
pip install agentmail
python -c "from agentmail import AgentMail; print('ok')"

# MCP adapter
npx -y agentmail-mcp --help
```

If any of those fail, yank the bad version (`npm unpublish` within 72h,
`twine` has no equivalent — bump to `0.1.1` instead) and start over.
