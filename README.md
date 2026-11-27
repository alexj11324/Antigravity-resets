# Antigravity Resets

[![LINUX DO](./assets-src/linux-do-badge.svg)](https://linux.do)

Antigravity Resets is an independent tracker for Google Antigravity quota reset announcements. Check when the latest verified reset happened, browse the archive, and follow links to the original announcements. It tracks public announcements and has no access to your personal quota.

**[Open the live tracker](https://antigravity-resets.com/)** · [How quotas work](https://antigravity-resets.com/guide) · [API reference](https://antigravity-resets.com/api-docs)

## Get reset alerts

- [Telegram](https://t.me/antigravity_resets_alert) for new reset announcements.
- Browser and email alerts from the [live tracker](https://antigravity-resets.com/).
- [RSS feed](https://antigravity-resets.com/feed.xml) for feed readers.

## Use the data

The public JSON API and read-only MCP server are available without an API key. Start with [current status](https://antigravity-resets.com/api/v1/status), the [reset archive API](https://antigravity-resets.com/api/v1/resets), or the [MCP setup guide](https://antigravity-resets.com/api-docs#mcp). The API reference also includes [examples for embedding the live status badge](https://antigravity-resets.com/api-docs#feeds).

## Run locally

Use Node.js 24.

```sh
git clone https://github.com/alexj11324/Antigravity-resets.git
cd Antigravity-resets
npm run db:migrate:local
npm run dev:worker
```

Open [localhost:8787](http://localhost:8787) to preview the tracker with sample data and a local D1 database. The local preview runs without credentials. Production uses Cloudflare Workers, D1, and X webhooks. See [`.env.example`](.env.example) for integration settings.

Run `npm test` to check changes before opening a PR.

## Help and license

[Open a GitHub issue](https://github.com/alexj11324/Antigravity-resets/issues) to report a bug or suggest a change. For advertising and sponsorship, email [ads@antigravity-resets.com](mailto:ads@antigravity-resets.com).

This project is licensed under [GPL-3.0](LICENSE).
