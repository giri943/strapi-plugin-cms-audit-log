# Changelog

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
