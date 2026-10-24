// References page: reading order, textbooks and a filterable bibliography,
// built from data/reading.json and data/references.json (written by tools/sync_from_cdt.py).

const ARXIV_ID = /\b((?:hep-th|hep-lat|hep-ph|gr-qc|astro-ph|cond-mat|math-ph|quant-ph|math\.[A-Z]{2})\/\d{7}|\d{4}\.\d{4,5})(v\d+)?\b/g;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const arxivUrl = id => `https://arxiv.org/abs/${id}`;

// Escape, then turn bare arXiv ids into links.
function linkify(text) {
  return esc(text).replace(ARXIV_ID, (m, id) => `<a href="${arxivUrl(id)}">${m}</a>`);
}

function renderReading(reading, el) {
  const steps = reading.steps.map(step => {
    const items = step.items.length
      ? `<ul>${step.items.map(it => `<li>${linkify(it.text)}</li>`).join('')}</ul>`
      : '';
    return `<li><strong>${esc(step.title)}.</strong> ${linkify(step.text)}${items}</li>`;
  }).join('');
  el.querySelector('#reading-steps').innerHTML = steps;

  el.querySelector('#textbooks tbody').innerHTML = reading.textbooks.map(t =>
    `<tr><td>${esc(t.topic)}</td><td>${esc(t.books)}</td><td>${esc(t.use ?? '')}</td></tr>`
  ).join('');
}

function entryHtml(e, catName) {
  const title = e.arxiv
    ? `<a href="${arxivUrl(e.arxiv)}">${esc(e.title)}</a>`
    : e.doi ? `<a href="https://doi.org/${esc(e.doi)}">${esc(e.title)}</a>` : esc(e.title);
  const links = [
    e.arxiv ? `<a href="${arxivUrl(e.arxiv)}">arXiv:${esc(e.arxiv)}</a>` : '',
    e.doi ? `<a href="https://doi.org/${esc(e.doi)}">doi</a>` : '',
  ].filter(Boolean).join(' · ');
  return `<li class="ref">
    <div class="ref-title">${title}</div>
    <div class="ref-meta">${esc(e.authors.join(', '))} · ${e.year}${e.journal ? ` · <span class="ref-journal">${esc(e.journal)}</span>` : ''}</div>
    ${e.note ? `<p class="ref-note">${esc(e.note)}</p>` : ''}
    <div class="ref-links"><span class="ref-cat" title="${esc(catName)}">${esc(e.category)}</span> ${links}</div>
  </li>`;
}

function renderBibliography(refs, el) {
  const cats = Object.fromEntries(refs.categories.map(c => [c.id, c.name]));
  const select = el.querySelector('#ref-category');
  select.innerHTML = '<option value="">All categories</option>' +
    refs.categories.map(c => `<option value="${esc(c.id)}">${esc(c.id)}: ${esc(c.name)} (${c.count})</option>`).join('');
  const search = el.querySelector('#ref-search');
  const sort = el.querySelector('#ref-sort');
  const list = el.querySelector('#ref-list');
  const count = el.querySelector('#ref-count');

  const haystack = new Map(refs.entries.map(e =>
    [e, [e.title, e.authors.join(' '), e.note, e.arxiv, e.journal, String(e.year)].join(' ').toLowerCase()]));

  function update() {
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const cat = select.value;
    const shown = refs.entries
      .filter(e => (!cat || e.category === cat) && terms.every(t => haystack.get(e).includes(t)))
      .sort((a, b) => sort.value === 'old' ? a.year - b.year : b.year - a.year);
    list.innerHTML = shown.map(e => entryHtml(e, cats[e.category])).join('');
    count.textContent = `${shown.length} of ${refs.entries.length} papers`;
  }
  [search, select, sort].forEach(c => c.addEventListener('input', update));
  update();
}

async function main() {
  const root = document.getElementById('main');
  try {
    const [reading, refs] = await Promise.all([
      fetch('data/reading.json').then(r => r.json()),
      fetch('data/references.json').then(r => r.json()),
    ]);
    renderReading(reading, root);
    renderBibliography(refs, root);
  } catch (err) {
    root.querySelector('#ref-count').textContent = 'The reference list could not be loaded.';
    console.error(err);
  }
}

main();
