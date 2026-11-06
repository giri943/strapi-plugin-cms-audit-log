# Audit Log for Strapi 5

Records who changed what in the CMS, and when. Comes with a dashboard to filter the history and export it as CSV.

Works with Strapi 5. Tested on 5.0.0 and 5.61.0. It does not support Strapi 4.

## What it records

- **Content:** create, update, delete, publish, unpublish, discard draft and duplicate, for every content type.
  - Updates store a before/after value for each field that actually changed, at any depth. An edit to one card inside one section of a dynamic zone is recorded as that one field, with a readable location such as `layouts #2 · Home layout › section four › cards #3 “Our values” › title`.
  - Components and dynamic zone blocks that were added, removed or moved are recorded as such, with the content of the block.
  - Files are shown by name and related entries by their title.
  - Publishing records what went live: the differences between the previous live version and the draft that replaced it. Discarding a draft records the edits that were thrown away.
  - Saving without changing anything is still recorded, and marked "no changes".
  - Failed saves are recorded too, with the error.
- **Media:** uploads, edits, moves and deletes of files and folders, with each changed detail before and after (name, location, alternative text, caption, type, size).
- **Sign-in:** successful sign-ins, sign-outs, failed sign-ins and blocked sign-ins (too many attempts).
- **Admin users:** invites, edits and deletes. Edits show each changed field before and after, with roles by name. Passwords are never stored, only that one was changed.
- **Roles and permissions:** role renames, and permission changes. Saving a role's permissions is one entry listing what was granted, revoked and narrowed, by content type and action.
- **Content types:** changes made in the Content-Type Builder.
- **Settings:** API tokens, transfer tokens and webhooks: created, edited, regenerated and deleted, field by field. Token values and webhook header values are never stored.
- **The audit log itself:** exports, integrity checks, settings changes and expired entries being removed. This category cannot be turned off.

Each entry stores:

- The user, their role type (admin, API token, website user, system), IP address and browser
- The item that changed and its content type
- The time

## Dashboard

- Filter by period, user, area, content type, result (succeeded or failed) and free text.
- Filters are kept in the URL, so you can bookmark or share a filtered view.
- Summary tiles: total events, content changes, active users, failed sign-ins.
- A chart of events per day, plus the most active users and the most edited content types. Click one to filter by it.
- Click any row to see the full entry: the changes grouped by block, with words added and removed highlighted in long text, request details and whether the entry has been tampered with.
- **Export CSV** downloads whatever the current filters show.
- **Verify integrity** re-checks the signature on every matching entry and reports any that were changed.

## Install

```bash
npm install strapi-plugin-cms-audit-log
```

Add it to `config/plugins.ts`:

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

Generate a signing secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Then rebuild the admin panel and restart:

```bash
npm run build
npm run develop
```

The plugin creates one table, `cms_audit_logs`. It does not touch your content tables.

## Who can see it

Go to **Settings → Roles** and open a role. There are four permissions under **Plugins → Audit Log**:

| Permission | Allows |
|---|---|
| View audit logs | Opening the dashboard and entry details, and running the integrity check |
| Export audit logs | Downloading CSV files |
| View settings | Opening Settings → Audit Log |
| Change settings | Saving those settings |

- Super Admins get all four automatically.
- Nobody else gets any of them until you grant them.
- The checks are done on the server, so hiding a button is not the only protection.

## Settings

Change these in the admin panel, under **Settings → Audit Log → Configuration**:

- How many days to keep entries (default 90). Older entries are deleted every 6 hours.
- Which areas to record.
- Whether to record changes made through the REST/GraphQL API (on by default).
- Whether to record changes with no user behind them, like seed scripts and cron jobs (off by default).
- Content types to skip.
- Extra field names to hide, for example `nationalId`.

These can only be set in `config/plugins.ts`, so nobody can loosen them from the admin panel:

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Set to `false` to stop recording. Old entries can still be viewed. |
| `signingSecret` | not set | Key used to sign each entry. At least 32 characters. |
| `maxExportRows` | `50000` | Most rows one CSV file can hold. |
| `exportsPerMinute` | `5` | Exports allowed per user per minute. |
| `readsPerMinute` | `240` | Dashboard requests allowed per user per minute. |
| `defaults` | `{}` | Starting values for the admin settings on a fresh install. |

If `signingSecret` is not set, a key made from `admin.auth.secret` is used instead. That works, but if you ever change `admin.auth.secret`, every older entry will fail the integrity check. Set your own secret.

## Security

The plugin was built against the OWASP Top 10. The full list of what was done for each item is in [docs/security.md](docs/security.md). In short:

- Passwords, tokens and secrets are never stored, at any depth.
- Entries can't be edited or deleted through any API. Only the retention timer removes them.
- Every entry is signed (HMAC-SHA256). Editing a row directly in the database shows up as "Signature mismatch".
- Filters are checked against a fixed list before they reach the database.
- CSV cells that start with `=`, `+`, `-` or `@` get a leading `'`, so Excel doesn't run them as formulas.
- Exports and dashboard requests are rate limited per user.
- Every export is itself recorded, with the filters used and the number of rows downloaded.

## Good to know

- Writes are queued and saved in batches about once a second. An editor's save never waits for the log to be written, and never fails because of it.
- To work out what a save changed, the plugin reads the entry before and after it, including every nested component. On a page builder with three large layout blocks this added about 50 ms to a save on SQLite (roughly 45% more queries than the save itself). The read-back happens before the save returns, so each entry describes exactly that save even when saves follow each other quickly.
- One entry keeps up to 200 changes and about 250 KB of values. Past that, the remaining locations are still listed without their values, and the entry says how many changes were left out.
- If the server is killed hard (not a normal restart), up to a second of entries can be lost. A normal shutdown saves the queue first.
- Rate limits are counted per server. With 3 servers behind a load balancer, a user can do 3 times the limit.
- Relation changes show the related entries by title, before and after. If the entries could not be read back, the entry falls back to what was connected or disconnected.
- Strapi Enterprise has its own audit log. You can run both, but you probably only need one.

## Development

```bash
npm install
npm run check          # typecheck, unit tests, build
npm run pack:local -- --install playground
cd playground && node scripts/e2e-check.js
```

`playground/scripts/e2e-check.js` starts a real Strapi server on a temporary database and runs 115 checks over HTTP: what gets recorded, the diffs (including edits deep inside dynamic zones, what a publish put live, admin user, role and permission changes, media, API tokens and webhooks), filters, permissions, export, settings and tamper detection.

To check an older Strapi, copy the playground, pin `@strapi/strapi` and `@strapi/plugin-users-permissions` to that version, install the packed plugin and run the same script.

## Licence

MIT
