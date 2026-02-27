# Install Packages Tool

Install dependencies with fallback manager selection.

## When to Use

- Package installs in `code_execution` are failing or flaky.
- You need controlled install attempts with structured diagnostics.

## Supported Kinds

- `node` — tries node managers (pnpm/npm/yarn/bun)
- `python` — pip/uv flow
- `go` — `go install`
- `uv` — `uv tool install`
- `apt` — apt-get flow with root/sudo checks
- `auto` — chooses a default flow from inputs

## Guidelines

1. Pass explicit `kind` when known to avoid ambiguous installs.
2. Use `prefer_manager` if project policy requires a specific manager.
3. Review `attempts` in tool output to understand fallback behavior and errors.
4. If install fails repeatedly, report exact failing command and stderr to user.
