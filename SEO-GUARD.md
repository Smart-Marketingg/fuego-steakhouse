# SEO guard: how it works (for Emilio, Joey and anyone who pushes a site)

Every client site on Cloudflare has a check that runs before each deploy. If a push would erase SEO work, Cloudflare stops the deploy and the live site stays as it was. Nothing breaks; the push just does not go live until it is fixed.

## What it blocks

The file `seo-lock.json` in each repo records the SEO state of every page. A deploy is stopped if any of these is missing or different from the lock:

- page title, meta description, canonical tag, `lang`, robots meta (and any page newly set to noindex)
- schema (JSON-LD) blocks
- GA4, Google Tag Manager, Google Ads and Meta pixel IDs
- Google, Bing and Facebook verification tags and files
- `og:title`, `og:description`, `og:image`
- speed preloads and the number of H1 headings
- image alt text (only where an image that had alt text now has none)
- redirects in `_redirects`, lines in `robots.txt` and `_headers`, URLs in `sitemap.xml`
- a deleted page, a new `Disallow` rule, or a missing guard file

Normal design and content edits pass: new pages, new sections, new images, text changes, CSS and JS changes.

## What a failure looks like

In Cloudflare (Workers & Pages > the site > Deployments > the failed build > build log) and on the commit in GitHub:

```
SEO GUARD: 3 problem(s) — DEPLOY STOPPED. The live site was not changed.
  30 pages
    x tracking tag G-4BFD2Y01D4 is missing
        on: index.html, catering.html, contact.html … and 27 more

  catering.html
    x meta description was removed
        locked:  "Cater your next gathering with Mangia Brick Oven Pizza: …"

  _redirects
    x 3 redirect rule(s) removed
        /gallery /projects 301
```

## If your push is stopped

It almost always means the export or folder you pushed is older than what is on GitHub.

1. In GitHub Desktop, Fetch origin and pull the latest `main`.
2. Put back the items the message lists. Copy them from `main`; do not re-type them.
3. Push again. The check runs again by itself.

Before a new Claude Design export: start from the latest `main`, and copy only the files you changed into the repo. Never replace the whole folder, and never force-push `main`. If the message says the guard files are missing, the push replaced the repo: restore `tools/seo-guard.mjs` and `seo-lock.json` from `main`.

Best long-term fix: put the SEO changes into the Claude Design project too, so the next export already has them. Ask Jullien for the list for that site.

## Making an SEO change on purpose

1. Make the change (title, description, schema, redirect, tag, and so on).
2. In the repo folder run: `node tools/seo-guard.mjs update`
3. It lists every difference it is about to accept. Read the list. If something is on it that you did not mean to change, fix that first.
4. Commit `seo-lock.json` in the same commit as the change, and push.

Check without pushing: `node tools/seo-guard.mjs`

Rule for the team: `seo-lock.json` is Jullien's file. If you need it changed, send Jullien the change; do not run `update` just to get a push through.
