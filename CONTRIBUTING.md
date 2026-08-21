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
src/webflow-embed.html   ->  webflow/embed-part1.html   styles + markup
                         ->  webflow/embed-part2.html   logic
                         ->  preview.html               local test, readable source
                         ->  prototype.html             shareable demo, no live calls
```

The build splits automatically once the embed passes Webflow's 50,000-character
cap, and prints which files to paste. Under the cap it emits a single
`webflow/embed.html` instead.

Build outputs are gitignored because they carry the live API key. Clone, add
the key, build.

## Before you ship

```bash
npm test          # builds, then 56 checks on desktop + mobile
```

Webflow caps a Code Embed at 50,000 characters and **truncates silently** past
it. That cap is the one thing here that breaks without an error message, so the
build guards it and CI runs the same check on every PR.

The suite drives the built files in a real browser with Default and Google
stubbed, so it never touches a live service. For a manual look, open
`preview.html` with `?demo=1`.

## Field names are a contract

Default maps its own fields to the `name` attributes on this form. Renaming an
input silently unmaps it on Default's side and the data stops flowing. Change a
label (`CFG.FIELDS`) freely; change a `name` only deliberately, and re-map it in
Default afterwards.
