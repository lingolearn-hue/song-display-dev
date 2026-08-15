// trainer.js — Guitar Trainer: chord viewer (fretboard diagrams)
const Trainer = (() => {
  const $ = id => document.getElementById(id);

  const STRING_NAMES = ['E','A','D','G','B','e']; // low to high, left to right in diagram

  // ── Render one chord as an SVG fretboard diagram ──────────
  function renderDiagram(chordName, chordData) {
    const FRET_COUNT = 4; // frets shown in the diagram window
    const W = 180, H = 210;
    const marginLeft = 24, marginRight = 16, marginTop = 34, marginBottom = 16;
    const gridW = W - marginLeft - marginRight;
    const gridH = H - marginTop - marginBottom;
    const stringGap = gridW / 5;
    const fretGap   = gridH / FRET_COUNT;

    const { frets, fingers, barre, baseFret } = chordData;

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="chord-diagram-svg">`;

    // Chord name label
    svg += `<text x="${W/2}" y="16" text-anchor="middle" class="diagram-title">${esc(chordName)}</text>`;

    // Base fret indicator (only shown when not starting at fret 1)
    if (baseFret > 1) {
      svg += `<text x="${marginLeft - 8}" y="${marginTop + fretGap * 0.7}" text-anchor="end" class="diagram-basefret">${baseFret}fr</text>`;
    }

    // Nut (thick line at top) or fret line if baseFret > 1
    const nutY = marginTop;
    if (baseFret === 1) {
      svg += `<rect x="${marginLeft}" y="${nutY-2}" width="${gridW}" height="4" class="diagram-nut"/>`;
    } else {
      svg += `<line x1="${marginLeft}" y1="${nutY}" x2="${marginLeft+gridW}" y2="${nutY}" class="diagram-fretline"/>`;
    }

    // Fret lines
    for (let f = 1; f <= FRET_COUNT; f++) {
      const y = marginTop + f * fretGap;
      svg += `<line x1="${marginLeft}" y1="${y}" x2="${marginLeft+gridW}" y2="${y}" class="diagram-fretline"/>`;
    }

    // Strings (vertical lines)
    for (let s = 0; s < 6; s++) {
      const x = marginLeft + s * stringGap;
      svg += `<line x1="${x}" y1="${marginTop}" x2="${x}" y2="${marginTop+gridH}" class="diagram-string"/>`;
    }

    // Barre indicator — rounded bar behind the dots
    if (barre) {
      const fretRelative = barre.fret - baseFret;
      const y = marginTop + fretRelative * fretGap + fretGap / 2;
      const x1 = marginLeft + barre.from * stringGap;
      const x2 = marginLeft + barre.to * stringGap;
      svg += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="diagram-barre"/>`;
    }

    // Open / muted string markers above the nut
    frets.forEach((fret, s) => {
      const x = marginLeft + s * stringGap;
      const y = marginTop - 10;
      if (fret === 0) {
        svg += `<circle cx="${x}" cy="${y}" r="4" class="diagram-open"/>`;
      } else if (fret === -1) {
        svg += `<text x="${x}" y="${y+4}" text-anchor="middle" class="diagram-muted">✕</text>`;
      }
    });

    // Fretted note dots
    frets.forEach((fret, s) => {
      if (fret > 0) {
        const fretRelative = fret - baseFret;
        const x = marginLeft + s * stringGap;
        const y = marginTop + fretRelative * fretGap + fretGap / 2;
        svg += `<circle cx="${x}" cy="${y}" r="8" class="diagram-dot"/>`;
        if (fingers[s]) {
          svg += `<text x="${x}" y="${y+3.5}" text-anchor="middle" class="diagram-finger">${fingers[s]}</text>`;
        }
      }
    });

    svg += `</svg>`;
    return svg;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Quick-access grid ──────────────────────────────────────
  function buildQuickGrid() {
    const grid = $('chord-quick-grid');
    grid.innerHTML = '';
    QUICK_CHORDS.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'chord-quick-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => showChord(name));
      grid.appendChild(btn);
    });
  }

  // ── Search ──────────────────────────────────────────────────
  // Users commonly search using flat spellings (Bb, Eb, Ab, Db, Gb) even
  // though the library is keyed by sharps — alias flat root names to their
  // enharmonic sharp equivalent so both spellings find the same chords.
  const FLAT_TO_SHARP = {
    'db': 'c#', 'eb': 'd#', 'gb': 'f#', 'ab': 'g#', 'bb': 'a#',
  };

  function normaliseQuery(q) {
    // Replace a leading flat-root spelling with its sharp equivalent,
    // keeping whatever quality suffix follows (e.g. "bbm7" -> "a#m7")
    for (const [flat, sharp] of Object.entries(FLAT_TO_SHARP)) {
      if (q.startsWith(flat)) return sharp + q.slice(flat.length);
    }
    return q;
  }

  function buildSearchResults(query) {
    const resultsEl = $('chord-search-results');
    resultsEl.innerHTML = '';
    const raw = query.trim().toLowerCase();
    if (!raw) { resultsEl.classList.add('hidden'); return; }
    const q = normaliseQuery(raw);

    const matches = Object.keys(CHORD_LIBRARY)
      .filter(name => name.toLowerCase().startsWith(q))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 30);

    if (!matches.length) {
      resultsEl.innerHTML = '<div class="chord-search-empty">No chords found</div>';
      resultsEl.classList.remove('hidden');
      return;
    }

    // If the user typed a flat spelling, display results using flat names
    // too, so "Bb7" shows as "Bb7" rather than the internal "A#7" key
    const usedFlat = Object.keys(FLAT_TO_SHARP).some(f => raw.startsWith(f));
    const SHARP_TO_FLAT = { 'C#':'Db','D#':'Eb','F#':'Gb','G#':'Ab','A#':'Bb' };

    matches.forEach(name => {
      let displayName = name;
      if (usedFlat) {
        for (const [sharp, flat] of Object.entries(SHARP_TO_FLAT)) {
          if (name.startsWith(sharp)) { displayName = flat + name.slice(sharp.length); break; }
        }
      }
      const item = document.createElement('button');
      item.className = 'chord-search-item';
      item.textContent = displayName;
      item.addEventListener('click', () => {
        showChord(name, displayName);
        $('chord-search-input').value = displayName;
        resultsEl.classList.add('hidden');
      });
      resultsEl.appendChild(item);
    });
    resultsEl.classList.remove('hidden');
  }

  // ── Show a chord's diagram ─────────────────────────────────
  let currentChord = null;
  function showChord(name, displayName) {
    const data = CHORD_LIBRARY[name];
    if (!data) return;
    currentChord = name;
    $('chord-diagram-container').innerHTML = renderDiagram(displayName || name, data);
    $('chord-diagram-container').classList.remove('empty');
    document.querySelectorAll('.chord-quick-btn').forEach(b => {
      b.classList.toggle('active', b.textContent === name);
    });
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    buildQuickGrid();

    const searchInput = $('chord-search-input');
    searchInput.addEventListener('input', () => buildSearchResults(searchInput.value));
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) buildSearchResults(searchInput.value);
    });

    // Close search results when tapping elsewhere
    document.addEventListener('click', e => {
      const wrap = $('chord-search-wrap');
      if (wrap && !wrap.contains(e.target)) {
        $('chord-search-results').classList.add('hidden');
      }
    });

    // Show first quick chord by default
    if (QUICK_CHORDS.length) showChord(QUICK_CHORDS[0]);
  }

  return { init, showChord };
})();
