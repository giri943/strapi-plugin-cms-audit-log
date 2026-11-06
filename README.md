# Audit Log for Strapi 5

Know who changed what in your CMS, and when.

This plugin records every change made in Strapi, from a typo fixed in a page title to a new API token, and shows it in a dashboard you can filter, search and export. Each entry says exactly what changed, not just that something did.

Works with Strapi 5 (tested on 5.0, 5.42 and 5.61). Strapi 4 is not supported.

## What you see

Open an entry and you get the change itself, before and after:

```
Updated "Investor relations"
  layouts #1 · Home layout › section four › cards #3 "Our values" › title
      Our value  →  Our values
  layouts #3 · Legal layout      Removed (with its full content)
```

That works at any depth: an edit to one card inside one section of a dynamic zone is reported as that one field. Blocks that were added, removed or reordered are shown as such, files appear by name, and linked entries by their title. Long text and rich text get the changed words highlighted.

## What it records

- **Content.** Create, save, publish, unpublish, discard draft, duplicate and delete. A publish entry lists what went live. A discarded draft lists the edits that were thrown away. Failed saves are recorded with the error.
- **Media.** Uploads, edits, moves and deletes of files and folders: name, folder, alt text, caption, type and size.
- **Admin users and roles.** Invites, edits and deletes, with roles shown by name. Saving a role's permissions becomes one entry: what was granted, revoked or narrowed, by content type and action.
- **Settings.** API tokens, transfer tokens and webhooks: created, edited, regenerated and deleted.
- **Sign-ins.** Successful, failed and blocked (too many attempts), plus sign-outs.
- **Content types.** Changes made in the Content-Type Builder.
- **The log itself.** Exports, integrity checks, settings changes and old entries being removed. This can't be turned off.

Every entry also records who did it (admin, API token, website user or system), their IP address and browser, and when.

## Install

```bash
npm install strapi-plugin-cms-audit-log
```

Enable it in `config/plugins.ts`:

```ts
export default ({ env }) => ({
  'cms-audit-log': {
    enabled: true,
    config: {
      signingSecret: env('AUDIT_LOG_SIGNING_SECRET'),
    },
  },
});
```

Generate a secret for your `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Then rebuild the admin panel and restart Strapi:

```bash
npm run build
npm run develop
```

**Audit Log** now appears in the sidebar. The plugin adds one table, `cms_audit_logs`, and never touches your content tables.

## Who can see it

Super Admins can see everything. Everyone else needs permissions, granted under **Settings → Roles → Plugins → Audit Log**:

| Permission | Lets them |
|---|---|
| View audit logs | Open the dashboard, read entries and run the integrity check |
| Export audit logs | Download CSV files |
| View settings | Open Settings → Audit Log |
| Change settings | Save those settings |

The checks happen on the server, not just in the UI.

## Settings

Under **Settings → Audit Log** you can choose:

- how long to keep entries (90 days by default),
- which areas to record,
- whether to record API calls and changes made by scripts or cron jobs,
- content types to skip,
- extra field names to hide, such as `nationalId`.

A few options can only be set in `config/plugins.ts`, so nobody can loosen them from the admin panel:

| Option | Default | |
|---|---|---|
| `enabled` | `true` | `false` stops recording. Existing entries stay readable. |
| `signingSecret` | not set | Key used to sign entries. At least 32 characters. |
| `maxExportRows` | `50000` | Largest CSV export. |
| `exportsPerMinute` | `5` | Exports per user per minute. |
| `readsPerMinute` | `240` | Dashboard requests per user per minute. |
| `defaults` | `{}` | Starting values for the admin settings on a fresh install. |

Without a `signingSecret`, entries are signed with a key derived from `admin.auth.secret`. That works, but rotating that secret later makes every older entry fail the integrity check, so set your own.

## Security

- Passwords, tokens and secrets are never stored, however deeply they are nested. Webhook header values and URL query values are masked.
- Entries can't be edited or deleted through any API; only the retention timer removes them.
- Every entry is signed (HMAC-SHA256). **Verify integrity** in the dashboard flags any row changed directly in the database.
- CSV exports are protected against formula injection, rate limited, and recorded in the log themselves.

The full OWASP Top 10 review is in [docs/security.md](docs/security.md).

## Good to know

- Logging never slows down or breaks a save: entries are queued and written in batches about once a second. A normal shutdown writes the queue first; a hard kill can lose up to a second of entries.
- To work out what a save changed, the plugin reads the entry before and after it. On a large page builder this adds roughly 50 ms to a save.
- One entry keeps up to 200 changes. Past that, it notes how many were left out.
- Rate limits are counted per server, so three servers behind a load balancer allow three times the limit.
- Strapi Enterprise has its own audit log. Running both works, but you probably only need one.

## Development

```bash
npm install
npm run check                                   # types, unit tests, build
npm run pack:local -- --install playground
cd playground && node scripts/e2e-check.js      # 115 checks against a real Strapi server
```

## Licence

MIT
