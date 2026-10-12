# Git and PRs

## Before committing

Run the checklist in `docs/agents/security.md` against the staged changes.

## Commits

Conventional commits: `<type>: <description>`, where type is one of `feat`,
`fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. A commitlint or
similar config in the repo overrides this list.

## Pull requests

Write the summary from the whole branch (`git log <base>..HEAD`), not just the
last commit, and end it with a test plan: what you ran and what a reviewer
should check by hand.
