# Contributing to Eggent

Thanks for helping improve Eggent.

## Ways to Contribute

- Report bugs
- Propose features
- Improve documentation
- Submit code changes

## Before Opening an Issue

- Search existing issues to avoid duplicates.
- Use the provided issue forms so maintainers get enough context.
- Keep reports focused on one problem/request per issue.

## Report a Bug

Use the `Bug report` template and include:

- what happened
- what you expected
- exact steps to reproduce
- environment details (OS, browser, Docker/local)
- relevant logs or screenshots

If a bug is hard to reproduce, add a minimal reproducible example.

## Request a Feature

Use the `Feature request` template and include:

- problem statement
- proposed solution
- alternatives considered
- expected user impact

## Development Setup

```bash
npm install
npm run dev
```

Production check:

```bash
npm run lint
npm run build
```

## Pull Request Guidelines

- Create a branch from `main`.
- Keep PRs small and focused.
- Explain the problem and solution clearly.
- Link related issues (for example: `Closes #123`).
- Include screenshots/GIFs for UI changes.
- Update docs when behavior changes.

## Commit Guidance

Conventional commits are recommended but not required.

Examples:

- `fix(chat): handle empty tool output`
- `feat(mcp): add server timeout setting`
- `docs: clarify Docker setup`

## Review and Triage

- Maintainers triage new issues and PRs on a best-effort basis.
- You may be asked for more context or a smaller repro.
- Inactive issues/PRs may be closed after follow-up attempts.
