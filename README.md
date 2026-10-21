# XP Strategy — Audits

Hosted account pages for XP Strategy prospect audits (GitHub Pages).
One link per account. Opens in the browser, no download.

```
accounts/<company>-<8 hex>/
  index.html     account hub — the link used on calls (links bar + one card per page)
  audit.html     PPC audit
  category.html  category scorecard (optional)
  seo.html       SEO / listing review (optional)
  links.json     live links + Google Sheet tab ids (pages read this on load)
templates/hub.html   hub shell used by the Drive linker
apps-script/         Drive -> Google Sheets -> GitHub linker
```

- Client view: `https://<owner>.github.io/<repo>/accounts/<slug>/`
- Team view (adds Seller Central, Ads console, GHL, ClickUp, Drive, client files): add `?team=1`

## Visibility

GitHub Pages sites are public on the internet, including from a private repo
(only GitHub Enterprise Cloud can restrict access). Protection here is:
unguessable slugs, `noindex` on every page, `robots.txt Disallow: /`, a root page
that lists nothing, and team links hidden unless `?team=1`. The account library
lives in a private Google Sheet ("XP Audits Library"), not in this repo.
Do not put notes about people, pricing proposals or anything confidential in a
page or in `links.json`.

## One-time setup (about 20 minutes)

### 1. GitHub (owned by XP Strategy, not a personal account)
1. Create a GitHub **organization** (e.g. `xp-strategy`) with Abe as Owner and
   Guilherme as Owner — access survives any single person.
2. Create repo `audits` in the org and upload this folder's contents.
3. Settings > Pages > Source: **Deploy from a branch**, `main`, `/ (root)`.
   The base URL is `https://xp-strategy.github.io/audits`.
4. Create a **fine-grained token**: Settings > Developer settings > Fine-grained
   tokens > resource owner = the org, repository = `audits` only,
   permission **Contents: Read and write**. Set an expiry and a calendar reminder.

### 2. Google Drive
1. In the shared **Audits** folder, create a subfolder **XP Audits - Inbox**.
2. Copy both folder ids from their URLs (`.../folders/<id>`).

### 3. Apps Script linker
1. script.google.com > New project > name it **XP Audit Linker** (from the XP
   Strategy Google account).
2. Paste `apps-script/Code.gs` into `Code.gs`.
3. Project Settings > tick "Show appsscript.json" > paste `apps-script/appsscript.json`.
4. Project Settings > Script properties:

   | Property | Value |
   |---|---|
   | GITHUB_TOKEN | the fine-grained token |
   | GITHUB_REPO | `xp-strategy/audits` |
   | GITHUB_BRANCH | `main` |
   | PAGES_BASE | `https://xp-strategy.github.io/audits` |
   | INBOX_FOLDER_ID | id of XP Audits - Inbox |
   | AUDITS_FOLDER_ID | id of Audits |

5. Run `testSetup` once (approve the permissions), then run `installTrigger`.

## Per audit (after setup)

1. Run the `xp-audit-prospect` skill in Claude. Outputs:
   - `[AUDIT]-<Company> - XP Strategy.html`
   - `[AUDIT]-<Company> - XP Strategy - Account Data.xlsx`
   - `[AUDIT]-<Company> - XP Strategy - PPC Audit.xlsx`
2. Drop them into **XP Audits - Inbox** (or let Claude push straight to this repo
   when the repo is attached to the session).
3. Within 15 minutes the linker:
   - finds the account folder `<Account> - <Prospect> - <Date>` (or creates it)
   - imports the Account Data sheet as a Google Sheet there; on a re-run it replaces
     the data tabs and **keeps Links, Account Overview and Account Notes as typed**
   - publishes the page(s) and the hub, writes `links.json` with the sheet URL and
     tab ids, so every "View data" link opens the right tab
   - writes the hosted URL into the sheet's Links tab and the XP Audits Library
   - moves the processed files into `<account folder>/_source`

Extra pages: name them `[AUDIT]-<Company> - XP Strategy - Category.html`,
`- SEO.html` or `- ASIN.html` and drop them in the same inbox.

Edit a link later: change it in the sheet's **Links** tab and re-drop the Account
Data file, or edit `accounts/<slug>/links.json` on GitHub. The pages update on reload.

## Troubleshooting

- Nothing happened: Apps Script > Executions shows each run; a failed file gets the
  error in its Drive description.
- 404 on the page: Pages takes 1-2 minutes after a commit.
- `View data` opens the sheet but not the tab: the sheet was not imported by the
  linker yet (tab ids are filled on import).
