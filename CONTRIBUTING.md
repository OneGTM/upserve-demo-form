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

`config.local.json` is gitignored, and the tracked source keeps a
placeholder. **The one committed file that carries the live key is
`webflow/embed.html`** — deliberately, so the paste-ready embed is in the repo
and installing the form needs no build. CI fails if an `AIza…` key appears in
any *other* tracked file, `src/webflow-embed.html` above all.

That exception rides on **this repo being private.** If it ever goes public
again, re-ignore `webflow/embed.html`, restore the blanket CI check, and rotate
the key.

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
src/webflow-embed.html   ->  webflow/embed.html   the paste-ready embed
                         ->  preview.html         local test, readable source
                         ->  prototype.html       shareable demo, no live calls
```

`npm install` matters for the build, not just the tests: terser is worth ~7,200
characters, which is the difference between one embed and two. Without it the
build still works, just larger, and splits into two parts.

`webflow/embed.html` is committed, so a fresh clone can paste the form
straight into Webflow. The other build outputs (`preview.html`,
`prototype.html`, the split embeds) stay gitignored — add the key to
`config.local.json` and build to get them.

## Before you ship

```bash
npm test          # builds, then runs the suite on desktop + mobile
```

Webflow caps a Code Embed at 50,000 characters and **truncates silently** past
it. That cap is the one thing here that breaks without an error message, so the
build guards it and CI runs the same check on every PR.

The suite drives the built files in a real browser with Default and Google
stubbed, so it never touches a live service. For a manual look, open
`preview.html` with `?demo=1`.

## Editing the radio cards

The eleven option cards are a table in the script, not markup:

```js
status: ['restaurant_status',
  'brand_new_opening;We’re opening a brand-new spot;Not open yet, or opening soon',
  ...
```

`value ; title ; description`. Add a row and it renders. As markup this was
3.8k of scaffolding around 0.7k of copy.

If you add a value, add its routing in `CFG.ROUTING` or `CFG.ROUTING_HELP` —
an unmapped value falls back to SDR or SUPPORT.

## Field names are a contract

Default maps its own fields to the `name` attributes on this form. Renaming an
input silently unmaps it on Default's side and the data stops flowing. Change a
label (`CFG.FIELDS`) freely; change a `name` only deliberately, and re-map it in
Default afterwards.
