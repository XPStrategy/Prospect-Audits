#!/usr/bin/env python3
"""Build the Prospect Audits master hub (hub/index.html): one page listing every audit with its links.

Reads accounts/*/links.json (always matches what is published) plus tools/hub_status.json
(optional prospect / client status). Same look as the Monthly-Audits Account Hubs page.
Run after any publish (a GitHub Action also runs it on every push to accounts/):
    python3 tools/build_hub.py --repo .
"""
import argparse, glob, html, json, os, re
from datetime import date, datetime

esc = lambda s: html.escape(str(s or ""), quote=True)

BASE = "https://xpstrategy.github.io/Prospect-Audits"

# page key prefix -> (column label, sort order)
TYPES = [
    ("audit", "PPC Audit"), ("category", "Category"), ("global", "Global Scorecard"),
    ("seo", "SEO"), ("sqp", "SQP"), ("amc", "AMC"), ("ttc", "Time to Convert"),
    ("bundles", "Virtual Bundles"),
]
TYPE_LABEL = dict(TYPES)
TYPE_ORDER = {k: i for i, (k, _) in enumerate(TYPES)}

CSS = """
.tools { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin: 0 0 18px; }
.tools select, .tools input { font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid #e6e4de;
  border-radius: 6px; background: #fff; color: #1a1d24; min-width: 0; }
.tools input { flex: 1 1 220px; }
.tools select { flex: 0 1 220px; }
td.dt { white-space: nowrap; }
.count { font-size: 12.5px; color: #666666; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e6e4de; border-radius: 6px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e6e4de; font-size: 13.5px; vertical-align: top; }
th { background: #111318; color: #fff; font-weight: 600; font-size: 12px; letter-spacing: .3px; text-transform: uppercase; }
td a { color: #111318; }
a.hubl { font-weight: 600; text-decoration: none; border-bottom: 2px solid #FF9900; }
.pill { display:inline-block; font-size: 11.5px; padding: 2px 8px; border-radius: 10px; border: 1px solid #e6e4de; color: #666666; white-space: nowrap; margin: 0 4px 4px 0; }
.pill.on { border-color: #FF9900; color: #111318; }
a .pill.on:hover { background: #FF9900; color: #fff; }
.pill.st-client { border-color: #2e7d4f; color: #2e7d4f; }
.pill.st-lost { background: #f1f2f4; }
tr.lost td { opacity: .6; }
.na { color: #666666; }
.sub { font-size: 12px; color: #666666; }
.wrap { overflow-x: auto; }
.kpis { display:flex; flex-wrap:wrap; gap:12px; margin: 0 0 18px; }
.kpi { background:#fff; border:1px solid #e6e4de; border-left:4px solid #FF9900; border-radius:6px; padding:10px 16px; min-width:150px; }
.kpi b { display:block; font-size:22px; color:#111318; line-height:1.2; }
.kpi span { font-size:12px; color:#666666; }
@media (max-width: 720px) {
  table, thead, tbody, tr, td { display: block; width: 100%; }
  thead { display: none; }
  tr { border-bottom: 1px solid #e6e4de; padding: 8px 0; }
  td { border: 0; padding: 4px 12px; }
  td[data-l]::before { content: attr(data-l) ": "; color: #666666; font-size: 12px; }
}
.xph-meta > div:first-child { display: none; }
"""

DISCLAIMER = ("This analysis is XP Strategy proprietary methodology. All findings are derived from Amazon "
              "Advertising and Seller Central data supplied for the reporting period. Figures reflect the "
              "account state at report creation.")


def shell(repo):
    """Base <style> block and logo from any published account hub, so the look stays in sync."""
    for p in sorted(glob.glob(os.path.join(repo, "accounts", "*", "index.html"))):
        s = open(p, encoding="utf-8").read()
        st = re.search(r"<style>(.*?)</style>", s, re.S)
        logo = re.search(r'<img src="(data:image/[^"]+)"', s)
        if st and logo:
            return st.group(1), logo.group(1)
    raise SystemExit("no account index.html with a style block and logo found")


def page_type(pg):
    k = (pg.get("key") or pg.get("file") or "").lower()
    for t, _ in TYPES:
        if k == t or k.startswith(t + "-") or k.startswith(t + "_"):
            return t
    return k.split("-")[0] or "other"


def fmt_date(d):
    try:
        return datetime.strptime(d, "%Y-%m-%d").strftime("%b %-d, %Y")
    except Exception:
        return d or ""


def rows(repo):
    status = {}
    sp = os.path.join(repo, "tools", "hub_status.json")
    if os.path.exists(sp):
        status = {k: v for k, v in json.load(open(sp, encoding="utf-8")).items() if not k.startswith("_")}
    out = []
    for p in glob.glob(os.path.join(repo, "accounts", "*", "links.json")):
        lj = json.load(open(p, encoding="utf-8"))
        slug = lj.get("slug") or os.path.basename(os.path.dirname(p))
        d = os.path.dirname(p)
        groups = {}
        for pg in lj.get("pages", []):
            f = pg.get("file")
            if not f or not os.path.exists(os.path.join(d, f)):
                continue
            groups.setdefault(page_type(pg), []).append(f)
        items = {i.get("key"): i.get("url") for i in lj.get("items", [])}
        st = status.get(slug, {})
        out.append(dict(
            slug=slug, company=lj.get("company") or slug, brand=lj.get("brand") or "",
            date=lj.get("report_date") or "", window=lj.get("window") or "",
            groups=groups, drive=items.get("drive_folder"),
            sheet=lj.get("account_sheet") or items.get("ppc_sheet"),
            listing=items.get("amazon_listing"),
            status=st.get("status", "prospect"), client_hub=st.get("client_hub"), note=st.get("note", ""),
        ))
    out.sort(key=lambda r: (r["date"], r["company"].lower()), reverse=True)
    return out


def build_page(rs, style, logo, today):
    trs, types_present, months = [], set(), set()
    for r in rs:
        h = f"../accounts/{r['slug']}/"
        sub = []
        if r["brand"] and r["brand"].lower() != r["company"].lower():
            sub.append(f"Brand: {esc(r['brand'])}")
        if r["note"]:
            sub.append(esc(r["note"]))
        sub_html = f'<div class="sub">{" · ".join(sub)}</div>' if sub else ""

        g = r["groups"]
        types_present.update(g)
        ppc = (f'<a href="{h}{esc(g["audit"][0])}"><span class="pill on">Open audit</span></a>'
               if "audit" in g else '<span class="pill">Not published</span>')
        other = []
        for t in sorted((t for t in g if t != "audit"), key=lambda t: TYPE_ORDER.get(t, 99)):
            files, label = g[t], TYPE_LABEL.get(t, t.title())
            href = h + files[0] if len(files) == 1 else h  # many pages of one type -> the account hub lists them
            label += f" · {len(files)}" if len(files) > 1 else ""
            other.append(f'<a href="{esc(href)}"><span class="pill on">{esc(label)}</span></a>')
        other_html = "".join(other) or '<span class="na">None</span>'

        links = []
        if r["sheet"]:
            links.append(f'<a href="{esc(r["sheet"])}" target="_blank" rel="noopener">Data sheet</a>')
        if r["drive"]:
            links.append(f'<a href="{esc(r["drive"])}" target="_blank" rel="noopener">Drive</a>')
        if r["listing"]:
            links.append(f'<a href="{esc(r["listing"])}" target="_blank" rel="noopener">Amazon</a>')
        links_html = " · ".join(links) or '<span class="na">None</span>'

        if r["status"] == "client":
            st_html = '<span class="pill st-client">Client</span>'
            if r["client_hub"]:
                st_html = f'<a href="{esc(r["client_hub"])}" target="_blank" rel="noopener">{st_html}</a>'
        elif r["status"] == "lost":
            st_html = '<span class="pill st-lost">Closed</span>'
        else:
            st_html = '<span class="pill">Prospect</span>'

        month = r["date"][:7]
        months.add(month)
        q = " ".join([r["company"], r["brand"], r["note"]]).lower()
        trs.append(
            f'<tr data-slug="{esc(r["slug"])}" data-q="{esc(q)}" data-types="|{"|".join(sorted(g))}|" '
            f'data-st="{esc(r["status"])}" data-m="{esc(month)}">'
            f'<td data-l="Account"><a class="hubl" href="{h}">{esc(r["company"])}</a>{sub_html}</td>'
            f'<td class="dt" data-l="Audit date">{esc(fmt_date(r["date"]))}</td>'
            f'<td data-l="PPC Audit">{ppc}</td>'
            f'<td data-l="Other reports">{other_html}</td>'
            f'<td data-l="Data window"><span class="sub">{esc(r["window"])}</span></td>'
            f'<td data-l="Links">{links_html}</td>'
            f'<td data-l="Status">{st_html}</td></tr>')

    opts = "".join(f'<option value="{esc(r["slug"])}">{esc(r["company"])}'
                   f'{" — " + esc(r["note"]) if r["note"] else ""}</option>'
                   for r in sorted(rs, key=lambda r: r["company"].lower()))
    topts = "".join(f'<option value="{t}">Report: {esc(TYPE_LABEL.get(t, t.title()))}</option>'
                    for t in sorted(types_present, key=lambda t: TYPE_ORDER.get(t, 99)))
    mopts = "".join(f'<option value="{m}">{datetime.strptime(m, "%Y-%m").strftime("%B %Y")}</option>'
                    for m in sorted((m for m in months if re.match(r"\d{4}-\d{2}$", m)), reverse=True))
    n_ppc = sum(1 for r in rs if "audit" in r["groups"])
    n_client = sum(1 for r in rs if r["status"] == "client")
    latest = rs[0]["date"] if rs else ""

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>XP Strategy Analysis - Prospect Audits</title>
<style>{style}
{CSS}</style>
</head>
<body>
<header class="xph-hero"><div class="xph-in"><div class="xph-brand"><img src="{logo}" alt="XP Strategy"/><div class="xph-title"><strong>XP Strategy Analysis</strong> &middot; Prospect Audits</div></div><div class="xph-meta"><div>&nbsp;</div><div>Marketplace: US</div><div>Report Created: {today}</div></div></div></header>
<main><h2>Prospect Audits</h2>
<div class="kpis">
  <div class="kpi"><b>{len(rs)}</b><span>Audit hubs published</span></div>
  <div class="kpi"><b>{n_ppc}</b><span>With a PPC audit</span></div>
  <div class="kpi"><b>{n_client}</b><span>Now clients</span></div>
  <div class="kpi"><b>{esc(fmt_date(latest))}</b><span>Latest audit</span></div>
</div>
<div class="tools">
  <select id="pick" aria-label="Open an audit hub"><option value="">Open an audit hub…</option>{opts}</select>
  <select id="ty" aria-label="Report"><option value="">Report: all</option>{topts}</select>
  <select id="mo" aria-label="Month"><option value="">Month: all</option>{mopts}</select>
  <select id="st" aria-label="Status"><option value="">All audits</option><option value="prospect">Prospects</option><option value="client">Now clients</option><option value="lost">Closed</option></select>
  <input id="q" type="search" placeholder="Filter accounts" aria-label="Filter accounts">
  <span class="count" id="count"></span>
</div>
<div class="wrap"><table><thead><tr><th>Account</th><th>Audit date</th><th>PPC Audit</th><th>Other reports</th><th>Data window</th><th>Links</th><th>Status</th></tr></thead>
<tbody>{"".join(trs)}</tbody></table></div>
<p class="source" style="font-size:12px;color:#666666;margin-top:8px">Source: each account's links.json in the Prospect-Audits repo, rebuilt on every publish; status from tools/hub_status.json. Newest audit first. Client status links to the account's Monthly-Audits hub.</p>
</main>
<footer class="xph-foot"><div class="disclaimer">{DISCLAIMER}</div><div class="xph-window">XP Strategy &middot; Prospect Audits &middot; Data: all audit hubs &middot; Report created {today}</div></footer>
<script>
(function(){{
  var $ = function(i){{ return document.getElementById(i); }}, rows = [].slice.call(document.querySelectorAll('tbody tr'));
  rows.forEach(function(r){{ if (r.getAttribute('data-st') === 'lost') r.className = 'lost'; }});
  $('pick').addEventListener('change', function(){{ if ($('pick').value) location.href = '../accounts/' + $('pick').value + '/'; }});
  function apply(){{
    var t = $('q').value.trim().toLowerCase(), ty = $('ty').value, mo = $('mo').value, st = $('st').value, n = 0;
    rows.forEach(function(r){{
      var ok = (!t || r.getAttribute('data-q').indexOf(t) >= 0)
        && (!ty || r.getAttribute('data-types').indexOf('|' + ty + '|') >= 0)
        && (!mo || r.getAttribute('data-m') === mo)
        && (!st || r.getAttribute('data-st') === st);
      r.style.display = ok ? '' : 'none'; if (ok) n++;
    }});
    $('count').textContent = n + ' audit' + (n === 1 ? '' : 's');
    try {{ localStorage.setItem('xp-audits-hub-f', JSON.stringify({{ty: ty, mo: mo, st: st}})); }} catch (e) {{}}
  }}
  try {{ var f = JSON.parse(localStorage.getItem('xp-audits-hub-f') || '{{}}'); ['ty','mo','st'].forEach(function(k){{ if (f[k] !== undefined && [].some.call($(k).options, function(o){{ return o.value === f[k]; }})) $(k).value = f[k]; }}); }} catch (e) {{}}
  ['ty','mo','st'].forEach(function(k){{ $(k).addEventListener('change', apply); }}); $('q').addEventListener('input', apply);
  apply();
}})();
</script>
</body></html>
"""


def build(repo, today=None):
    style, logo = shell(repo)
    rs = rows(repo)
    os.makedirs(os.path.join(repo, "hub"), exist_ok=True)
    p = os.path.join(repo, "hub", "index.html")
    open(p, "w", encoding="utf-8").write(build_page(rs, style, logo, today or date.today().isoformat()))
    return p, len(rs)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    a = ap.parse_args()
    p, n = build(a.repo)
    print(f"wrote {p} ({n} audits)")
