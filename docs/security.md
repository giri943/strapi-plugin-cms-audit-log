# Security notes

What the plugin does for each item in the OWASP Top 10 (2021), and where to find it in the code.

## A01 Broken access control

- Every route is admin-only. Nothing is exposed on the Content API (`server/src/routes/admin.ts`).
- Every route checks a plugin permission on the server, not only in the UI.
- Nobody except Super Admins has these permissions until a role is given them.
- There is no route to edit or delete an entry. Only the retention timer deletes, by date.

## A02 Cryptographic failures

- Values under keys that look like passwords, tokens, secrets, API keys, cookies or auth headers are replaced with `[REDACTED]`, at any depth (`server/src/core/redact.ts`).
- Fields of type `password` are recorded as "changed" with no values.
- Admins can add their own field names to hide.
- Event payloads (for example admin users) are copied field by field, never stored whole, so a password hash can't slip in (`server/src/core/events.ts`).
- The query string is never stored, only the path, because query strings can hold tokens.

## A03 Injection

- Every filter has a fixed name and operator. Values are checked against a fixed list or a strict pattern before they reach the query builder (`server/src/core/filters.ts`).
- Objects passed in the query string (like `?actor[$ne]=`) are rejected, so a user can't pick their own operator.
- The database is queried through Strapi's query engine and Knex with bound values. No SQL is built from strings.
- CSV cells starting with `=`, `+`, `-`, `@`, tab or carriage return (and their full-width forms) get a leading `'` (`server/src/core/csv.ts`).
- The detail view shows values as text, never as HTML.

## A04 Insecure design

- Recording fails open: if the log can't be written, the editor's action still goes through and the error is logged.
- The write queue has a size cap, so a flood of changes can't use up the server's memory.
- One entry is capped in size (long strings, big arrays and deep objects are cut down).
- Exports have a row cap. Exports and reads are rate limited per user (`server/src/core/rate-limit.ts`).

## A05 Security misconfiguration

- Settings that would weaken the log (signing secret, export cap, rate limits, turning recording off) can only be set in config files.
- Unknown settings keys are rejected, so a typo or extra field can't change anything (`server/src/services/settings.ts`).
- The "audit" category can't be turned off.
- CSV responses send `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- The settings page warns when no dedicated signing secret is set.

## A06 Vulnerable and outdated components

- One runtime dependency: `csv-stringify`.
- Everything else comes from Strapi itself.

## A07 Identification and authentication failures

- Failed and rate-limited admin sign-ins are recorded with the email tried, the IP address and the browser.
- The password from the sign-in form is never read.
- The dashboard shows a count of failed sign-ins for the period.

## A08 Software and data integrity failures

- Every entry is signed with HMAC-SHA256 when it is written (`server/src/core/signature.ts`).
- The key is derived from the configured secret, not the secret itself.
- Signatures are checked with a constant-time compare.
- The detail view shows whether one entry is intact. "Verify integrity" checks up to 50,000 entries at once and lists the ones that fail.
- Limit: a signature shows that an entry was changed. It does not show that an entry was deleted directly in the database. Take regular database backups if you need that.

## A09 Security logging and monitoring failures

- This is what the plugin is for.
- The log also records actions on itself: exports (with filters and row count), integrity checks, settings changes and retention clean-ups.
- Errors from the plugin go to the Strapi log without any entry content in them.

## A10 Server-side request forgery

- The plugin makes no outbound requests.

## Reporting a problem

Please open a private security advisory on the repository rather than a public issue.
