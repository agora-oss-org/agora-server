# Contributing

**Contributors welcome — Agora is built in the open, and we'd genuinely love your help.** 🌱 Bug fixes,
new admin-app slices, docs, test coverage, deployment guides, or closing a contract gap against
Replyke — there's room to jump in, whatever your level.

> Before you start, read
> [`CONTRIBUTING.md`](https://github.com/agora-oss-org/agora-server/blob/root/CONTRIBUTING.md) — dev
> setup, the contract rules, coding conventions, the migration workflow, and how to open a PR.

## The one hard rule

**The contract is the constraint.** Any change to request/response shapes, REST paths, or socket.io
events must keep [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) working 1:1 — see
[[API & Contract|API-Contract]].

## Engineering principles (non-negotiable)

- **Security first** — validate *and* authorize on the server; fail closed; wire every gate on every new
  path. See [[Security]].
- **Test what deserves testing** — pure/branching logic ships with unit tests; DB-backed behavior gets
  an integration test; security-relevant logic asserts the negative cases too.
- **Log with intent** — `info`/`error` are message-only; raw errors/context go on `debug`.

`pnpm -r typecheck` and `pnpm test` must pass before any work is considered done.

## Keeping mirrors in sync

One change often has many mirrors — a new env var touches three `.env.*.example` templates, three
compose files, `docs/`, this wiki, and the `CHANGELOG`. `docs/PROPAGATION.yaml` maps what mirrors what,
and the **`/propagate`** workflow runs a drift-checker over your branch diff and drafts the mirror
edits for review (propose-then-approve, never auto-commits). Run it before finishing a branch, and keep
`CHANGELOG.md` current under `## [Unreleased]`.

## Friendly first areas

Admin-app features, test coverage, and the deployment guide. Browse the
[open issues](https://github.com/agora-oss-org/agora-server/issues) or the project status backlog.

## Licensing & sign-off

The server is **AGPL-3.0-only**; the shared wire contract (`@agora-server/contract`) is **Apache-2.0**.
Contributions are accepted under the **Developer Certificate of Origin** — sign off your commits with
`git commit -s`. There is **no CLA**.

## Editing this wiki

These wiki pages are authored in
[`wiki/`](https://github.com/agora-oss-org/agora-server/tree/root/wiki) in the main repo and
auto-published by the `wiki-sync` workflow. **Edit them via PR there — not in the published wiki
directly**, or the next sync overwrites your change.
