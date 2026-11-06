# Changelog

## 1.0.2

- Added a GitHub Sponsors link: a Sponsor button on the repository, a `funding` field for `npm fund`, and a short "Support this project" section in the README.

## 1.0.1

- Clearer npm description and keywords, so the plugin shows up when people search for a Strapi audit log, audit trail or activity log.
- README: logo, badges, and how to report issues and security problems.

## 1.0.0

First stable release. It includes everything from the 0.1.0 betas below, and was tested end to end on Strapi 5.0, 5.42 and 5.61.

## 0.1.0-beta.4

- Clicking Publish after saving no longer adds an "Updated · Saved with no changes" entry. The Content Manager's Publish button saves the form again inside the same request; when that save changes nothing, the publish entry beside it already says what went live. When it does change something (edit, then Publish without saving), it is kept and marked "saved as part of clicking Publish".
- Entries are named by the Content Manager's entry title setting for each content type, so a type whose title field is, say, `nrb_title` shows that title instead of the document id. Types without the setting fall back to their first required text field.

## 0.1.0-beta.3

- Media files and folders show what changed, before and after: name, location ("Media Library › Products" rather than `/3/12`), and for files the alternative text, caption, type, size and file. Moves are recorded, including "Move to…" on several items. Deleted files and folders keep their name and location; before, a deleted folder had neither.
- New **Settings** category recording API tokens, transfer tokens and webhooks: create, edit, regenerate and delete, field by field. Token values are never read; regenerating one is shown as "Token value: changed". Webhook header values are hidden, and query string values in webhook URLs are masked.
- Uploads whose metadata Strapi rewrites on its own (formats, provider data) no longer produce empty "Updated file" entries.

## 0.1.0-beta.2

- Admin user updates show each changed field before and after: name, email, username, active, blocked, interface language, and roles by name ("Roles: Editor → Author"). A password change is shown as changed, never with a value. Before, the entry showed the user as JSON after the change, with role ids.
- Role renames show the old and new name and description.
- Saving a role's permissions is recorded as one entry listing what was granted, revoked and narrowed, grouped like the Roles screen ("Content › Pages › Delete", "Plugins › Upload › Access the Media Library"). Unticking one field lists that field, not the whole list. Before, each save left several "Granted/Removed permissions" entries with a count and raw action ids.
- Invited and deleted admin users are shown as fields, with roles by name.
- Password-reset and registration token writes no longer create "Updated admin user" entries.

## 0.1.0-beta.1

- Changes inside components and dynamic zones are recorded at the field that changed, at any depth, with a readable location (`layouts #2 · Home layout › section four › cards #3 › title`). Before, a whole dynamic zone was stored as one value, nested sections were not loaded at all, and anything more than six levels down was cut to `[nested]`.
- Blocks and repeatable items are matched by id: added, removed and moved blocks are reported as such, and adding one card no longer shows every card after it as changed. A removed block keeps a copy of its content.
- Publish entries list what went live (previous live version against the draft), and discard entries list the edits thrown away. A first publish is marked as one.
- Files are shown by name and related entries by title, including inside components.
- Sensitive and configured hidden fields are redacted at any depth of a change path.
- The entry view groups changes by block, labels each one Edited, Added, Removed or Moved, highlights changed words in long text, and shows rich text as text.
- The before and after reads use the query engine, which is about six times faster than the Document Service on deeply nested pages.
- An entry keeps up to 200 changes and about 250 KB of values, and says how many changes were left out past that.

## 0.1.0

- First release for Strapi 5.
- Records content, media, sign-in, admin user, role and content-type changes.
- Field-by-field diff for content updates.
- Dashboard with filters, summary tiles, activity chart and entry details.
- CSV export of the filtered view.
- Signed entries and an integrity check.
- Retention, exclusions and extra hidden fields in the admin settings.
