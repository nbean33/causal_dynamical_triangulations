# Causal Dynamical Triangulations: explainer and research site

A static website, published with GitHub Pages, that explains Causal Dynamical Triangulations (CDT) and presents the audit, correction and validation work in the companion research repo `CDT_4d-master`.

It is plain HTML, CSS and JavaScript (ES modules), with **no build step**. Third-party libraries are vendored under [`vendor/`](vendor/README.md).

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page |
| `learn/` | Intro for non-specialists, physics for physicists, moves visualizer, 2D simulator |
| `research/` | Overview, sampler audit, C++ codebase, validation plots, roadmap |
| `references.html`, `about.html` | Bibliography and reading order; credits and licences |
| `404.html` | Not-found page; GitHub Pages serves it for any missing path, so it sets its own `<base>` |
| `css/site.css` | All styles (light and dark themes via tokens on `:root`) |
| `js/site.js` | Theme toggle, current-page nav marking, KaTeX rendering, and `CODE_REPO_URL` |
| `js/cdt2d/` | In-browser 2D CDT Monte Carlo: the kernel, a strip renderer and the Web Worker the simulator page runs it in |
| `js/hero.js`, `js/simulator.js` | The landing-page animation and the simulator page |
| `js/moves/` | Moves visualizer: 2D SVG animations, three.js 3D scenes (loaded on scroll) |
| `js/plots/` | `chart.js`, a thin uPlot layer (shared readout, legend, bands, data tables), and the validation charts |
| `js/references.js` | Builds the references page from `data/` |
| `data/`, `assets/fig/` | Results copied from `CDT_4d-master` by `tools/sync_from_cdt.py` (committed) |
| `tests/` | `check_site.py` (links, nav, metadata, JSON) and the simulator tests (`node --test`; on Node 24, `node --test tests/` fails to load) |

Every page has the same header nav, and pages in `learn/` and `research/` share a section sub-nav. `tests/check_site.py` fails if they drift. When adding a page, copy an existing page in the same folder.

## Preview locally

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/>. ES modules and `fetch` of `data/*.json` don't work from `file://`.

## Checks

```bash
python tests/check_site.py
```

```bash
node --test
```

## Updating results

```bash
python tools/sync_from_cdt.py ../CDT_4d-master
```

This rewrites `data/` and `assets/fig/` from the research repo. It never copies papers, archives, or other people's unpublished documents.

## Deploying

GitHub Pages → *Deploy from a branch* → `main`, folder `/` (root). The `.nojekyll` file makes Pages serve the files as they are. All links are relative, so the site works under `https://<user>.github.io/<repo>/`.

Until the research repository is public, code links show a placeholder: set `CODE_REPO_URL` in `js/site.js` and every `data-code-link` placeholder becomes a link.
