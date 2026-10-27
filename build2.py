import json, os

here = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(here, *a)

meta = json.load(open(P("data", "docs-meta.json")))
cats = meta["cats"]
docs = [{k: d[k] for k in ("id", "title", "cat", "path", "url")} for d in meta["docs"]]

js = lambda o: json.dumps(o, ensure_ascii=False).replace("</", "<\\/")
t = open(P("ph", "template.html")).read()
out = t.replace("__NDOCS__", str(len(docs))).replace("__DOCS__", js(docs)).replace("__CATS__", js(cats))

open(P("ph", "handbook-signal.html"), "w").write(out)
os.makedirs(P("serve"), exist_ok=True)
page = (
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>body{margin:0}</style>\n'
    + out
)
open(P("serve", "index.html"), "w").write(page)
open(P("index.html"), "w").write(page)  # static entry point (GitHub Pages)
print(f"Built index.html ({len(out)} bytes, {len(docs)} doc metadata entries, {len(cats)} categories, 0 embedded .md copies)")
