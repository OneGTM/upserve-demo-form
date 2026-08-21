# Contributing

Small repo, one deliverable: the Webflow embed for Upserve's demo request form.
Same workflow as the rest of OneGTM.

## Setup (once)

```bash
bash scripts/setup-git.sh          # installs git new/save/ship/land
cp config.example.json config.local.json
# paste the Google Maps browser key into config.local.json
node build.js
```

`config.local.json` is gitignored. **A client's API key must never be
committed** — CI fails the build if an `AIza…` key appears in a tracked file.

## The loop

| Command | What it does |
| --- | --- |
| `git new feature/thing` | branch off the latest main |
| `git save "msg"` | stage everything + commit |
| `git ship` | push + open the PR into main |
| `git land` | squash-merge + delete the branch |

Never commit straight to `main`.

## What to edit

**`src/webflow-embed.html` is the source of truth.** Everything else under
`webflow/` and the two preview pages are generated — editing them works until
the next `node build.js` overwrites your changes.

```
src/webflow-embed.html   ->  webflow/embed.html    the paste-ready embed
                         ->  preview.html          local test, readable source
                         ->  prototype.html        shareable demo, no live calls
```

Build outputs are gitignored, including `webflow/embed.html`, because it
carries the live API key. Clone, add the key, build.

## Before you ship

```bash
node build.js     # must print "ok" — it exits non-zero over 50,000 chars
```

Webflow caps a Code Embed at 50,000 characters and **truncates silently** past
it. That cap is the one thing here that breaks without an error message, so the
build guards it and CI runs the same check on every PR.

Then open `preview.html` and put a real submission through with `?demo=1`:
pick a restaurant, trip the honeypot, trigger the typo rescue. There is no
automated browser test yet — see "Worth doing next" in the README.

## Field names are a contract

Default maps its own fields to the `name` attributes on this form. Renaming an
input silently unmaps it on Default's side and the data stops flowing. Change a
label (`CFG.FIELDS`) freely; change a `name` only deliberately, and re-map it in
Default afterwards.
