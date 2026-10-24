"""Static checks for the site. Run from anywhere: python tests/check_site.py

- every internal href/src points at a file that exists, and same-page #fragments exist
- the header nav is the same on every page, and each sub-nav is the same across its section
  (links are compared after resolving them to site paths, since pages sit at different depths)
- every page has a <title>, a meta description and exactly one <h1>
- every JSON file under data/ parses
"""
import json
import posixpath
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"vendor", ".git", "node_modules"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []          # (attr, value)
        self.ids = set()
        self.title = ""
        self.description = None
        self.h1 = 0
        self.navs = {}           # nav class -> list of (href, text)
        self._in_title = False
        self._nav = None
        self._nav_depth = 0
        self._anchor = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        for attr in ("href", "src"):
            if attr in a and a[attr] is not None:
                self.links.append((attr, a[attr]))
        if tag == "title":
            self._in_title = True
        elif tag == "meta" and a.get("name") == "description":
            self.description = a.get("content", "")
        elif tag == "h1":
            self.h1 += 1
        if tag == "nav":
            if self._nav is None:
                self._nav = (a.get("class") or "").split()[0] if a.get("class") else "nav"
                self.navs[self._nav] = []
            self._nav_depth += 1
        if tag == "a" and self._nav is not None:
            self._anchor = [a.get("href", ""), ""]

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "a" and self._anchor is not None:
            self.navs[self._nav].append((self._anchor[0], self._anchor[1].strip()))
            self._anchor = None
        elif tag == "nav" and self._nav is not None:
            self._nav_depth -= 1
            if self._nav_depth == 0:
                self._nav = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._anchor is not None:
            self._anchor[1] += data


def site_path(page_rel, href):
    """Resolve a relative href from page_rel (posix, relative to ROOT) to a site path."""
    path = urlsplit(href).path
    if not path:
        return page_rel
    return posixpath.normpath(posixpath.join(posixpath.dirname(page_rel), path))


def is_internal(value):
    s = urlsplit(value)
    return not s.scheme and not s.netloc and not value.startswith(("mailto:", "data:", "javascript:"))


def main():
    errors = []
    pages = sorted(p for p in ROOT.rglob("*.html") if not SKIP_DIRS & set(p.relative_to(ROOT).parts))
    parsed = {}
    for p in pages:
        rel = p.relative_to(ROOT).as_posix()
        page = Page()
        page.feed(p.read_text(encoding="utf-8"))
        parsed[rel] = page

        if not page.title.strip():
            errors.append(f"{rel}: missing <title>")
        if not page.description:
            errors.append(f"{rel}: missing meta description")
        if page.h1 != 1:
            errors.append(f"{rel}: expected one <h1>, found {page.h1}")

        for attr, value in page.links:
            if not is_internal(value):
                continue
            parts = urlsplit(value)
            if not parts.path:
                if parts.fragment and parts.fragment not in page.ids:
                    errors.append(f"{rel}: {attr}='{value}' has no matching id on the page")
                continue
            target = ROOT / site_path(rel, value)
            if target.is_dir():
                target = target / "index.html"
            if not target.exists():
                errors.append(f"{rel}: {attr}='{value}' -> missing {target.relative_to(ROOT).as_posix()}")

    def normalised(rel, nav):
        return [(site_path(rel, href), text) for href, text in parsed[rel].navs.get(nav, [])]

    reference = None
    for rel in parsed:
        header = normalised(rel, "site-nav")
        if not header:
            errors.append(f"{rel}: no header nav")
            continue
        if reference is None:
            reference = (rel, header)
        elif header != reference[1]:
            errors.append(f"{rel}: header nav differs from {reference[0]}")

    sections = {}
    for rel in parsed:
        if "sub-nav" in parsed[rel].navs:
            section = rel.split("/")[0]
            sub = normalised(rel, "sub-nav")
            if section in sections and sections[section][1] != sub:
                errors.append(f"{rel}: sub-nav differs from {sections[section][0]}")
            sections.setdefault(section, (rel, sub))

    for p in sorted((ROOT / "data").rglob("*.json")):
        try:
            json.loads(p.read_text(encoding="utf-8"))
        except ValueError as e:
            errors.append(f"{p.relative_to(ROOT).as_posix()}: invalid JSON ({e})")

    for e in errors:
        print("FAIL", e)
    print(f"{len(pages)} pages checked, {len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
