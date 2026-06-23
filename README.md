# Polity 0.1.0

A Discord bot for mock-government communities, including citizenship, parties,
elections, legislation, referendums, courts, recalls, impeachment, offices, and
treasury management.

## Requirements

- Node.js 20 or newer
- A Discord application and bot token
- Bot permissions appropriate for the channels and roles the bot manages

## Setup

1. Copy `.env.example` to `.env`.
2. Set `DISCORD_TOKEN`. `APPLICATION_ID` is optional; the bot verifies it against
   the application associated with the token.
3. Install dependencies with `npm install`.
4. Start the bot with `npm start`.

The SQLite database is created at `data/governance.db`. Back up that file before
upgrading or performing administrative maintenance.

## Validation

- `npm test` runs governance-rule and tally regression tests.
- `npm run check` checks the syntax of every source file.
- `npm run dev` starts the bot in Node's watch mode for local development.

## Presentation conventions

Shared embed colors, footers, status fields, safe text limits, and list pagination
live in `src/utils/embeds.js` and `src/utils/presentation.js`. Keep new commands on
those helpers so private responses, Discord limits, and visual semantics remain
consistent.

`package.json` is the single source of truth for the release version. Release
archives should be named `<project-name>-<version>.zip` and contain a matching root
directory.

The database filename is intentionally brand-neutral so future presentation or
organization changes do not disrupt stored server data.
