# Vendored libraries

Copied unmodified from the npm packages, so the site works without a CDN. Each folder keeps the upstream `LICENSE`.

| Folder | Package | Files kept | Used by |
|---|---|---|---|
| `katex-0.16.11/` | `katex@0.16.11` (MIT) | `katex.min.js`, `katex.min.css`, `contrib/auto-render.min.js`, `fonts/*.woff2` | every page with math (`js/site.js`) |
| `uplot-1.6.31/` | `uplot@1.6.31` (MIT) | `uPlot.esm.js`, `uPlot.min.css` | result plots, simulator profile |
| `three-0.169.0/` | `three@0.169.0` (MIT) | `three.module.min.js`, `addons/controls/OrbitControls.js` | `learn/moves.html` |

`OrbitControls.js` imports the bare specifier `three`, so pages that use it declare an import map:

```html
<script type="importmap">{ "imports": { "three": "../vendor/three-0.169.0/three.module.min.js" } }</script>
```

To upgrade, `npm pack <pkg>@<version>` into a scratch folder, copy the same files into a new versioned folder, and update the paths in the HTML.
