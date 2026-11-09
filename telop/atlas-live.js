(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AtlasLive = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const kinds = ['eew', 'tsunami', 'intensity', 'vertical'];

  function newestFirst(items) {
    return [...items].sort((a, b) => (Date.parse(b.event?.publishedAt || '') || 0) - (Date.parse(a.event?.publishedAt || '') || 0)
      || Number(b.event?.serial || 0) - Number(a.event?.serial || 0));
  }

  function composeAtlasView(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !kinds.every((kind) => Array.isArray(snapshot.layers[kind]))) {
      throw new TypeError('invalid atlas snapshot');
    }
    const eew = newestFirst(snapshot.layers.eew)[0] || null;
    const tsunami = { major: new Set(), warning: new Set(), advisory: new Set() };
    for (const entry of snapshot.layers.tsunami) {
      for (const key of Object.keys(tsunami)) for (const area of entry.payload?.render?.[key] || []) tsunami[key].add(area);
    }
    const intensityLines = newestFirst(snapshot.layers.intensity).flatMap((entry) =>
      (entry.payload?.lines || []).map((text) => ({ eventId: entry.event.id, text })));
    const headlines = newestFirst(snapshot.layers.vertical).map((entry) => ({ eventId: entry.event.id, text: entry.payload?.text || '' })).filter((item) => item.text);
    return {
      eew,
      tsunami: Object.fromEntries(Object.entries(tsunami).map(([key, areas]) => [key, [...areas]])),
      intensityLines,
      headline: headlines[0] || null,
    };
  }

  function install(initialSnapshot) {
    if (typeof document === 'undefined') return;
    const clock = document.getElementById('atlas-clock');
    const intensity = document.getElementById('atlas-intensity');
    const headline = document.getElementById('atlas-headline');
    const alpha = document.getElementById('atlas-alpha-mirror');
    const eewElement = document.getElementById('eew-box');
    const tsunamiElement = document.getElementById('tsunami-mini');
    let lastEew = null;
    let lastTsunami = null;
    let lastLines = '';
    let lineIndex = 0;
    let lineTimer = null;

    function syncAlpha() {
      if (!alpha) return;
      alpha.replaceChildren();
      for (const [element, top, left] of [[eewElement, 270, 417], [tsunamiElement, 174, 1236]]) {
        if (!element) continue;
        const mirror = element.cloneNode(true);
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.top = `${top}px`;
        mirror.style.left = `${left}px`;
        alpha.appendChild(mirror);
      }
    }

    function showLines(lines) {
      if (!intensity) return;
      if (lineTimer) clearInterval(lineTimer);
      lineTimer = null;
      lineIndex = 0;
      intensity.replaceChildren();
      if (!lines.length) return;
      const label = document.createElement('div');
      const detail = document.createElement('div');
      label.className = 'atlas-intensity-label';
      detail.className = 'atlas-intensity-detail';
      intensity.append(label, detail);
      const render = () => {
        const current = lines[lineIndex % lines.length];
        label.textContent = current.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const next = lines[(lineIndex + 1) % lines.length];
        detail.textContent = next.eventId === current.eventId
          ? next.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : current.eventId;
        lineIndex += 1;
      };
      render();
      lineTimer = setInterval(render, 5000);
    }

    function applyAtlasSnapshot(snapshot) {
      const view = composeAtlasView(snapshot);
      if (clock) clock.textContent = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date());

      const eew = view.eew;
      const eewKey = eew ? `${eew.event.id}:${eew.event.serial}:${eew.event.publishedAt}` : '';
      let alphaDirty = false;
      if (eewKey !== lastEew) {
        if (eew?.payload?.render) {
          const input = eew.payload.render;
          if (lastEew && lastEew.startsWith(`${eew.event.id}:`) && typeof renderEEWUpdate === 'function') renderEEWUpdate(input);
          else renderEEW(input);
        } else if (eewElement) {
          eewElement.classList.remove('on');
        }
        lastEew = eewKey;
        alphaDirty = true;
      }

      const tsunamiJson = JSON.stringify(view.tsunami);
      if (tsunamiJson !== lastTsunami && typeof renderTsunamiMini === 'function') {
        renderTsunamiMini(view.tsunami);
        lastTsunami = tsunamiJson;
        alphaDirty = true;
      }
      const lineJson = JSON.stringify(view.intensityLines);
      if (lineJson !== lastLines) {
        showLines(view.intensityLines);
        lastLines = lineJson;
      }
      if (headline) headline.textContent = view.headline?.text || '';
      if (alphaDirty) syncAlpha();
    }

    root.applyAtlasSnapshot = applyAtlasSnapshot;
    if (initialSnapshot) applyAtlasSnapshot(initialSnapshot);
    async function poll() {
      try {
        const response = await fetch(`atlas-state.json?t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) applyAtlasSnapshot(await response.json());
      } catch (_) { /* Keep the last rendered snapshot while the state file is unavailable. */ }
      setTimeout(poll, 1000);
    }
    poll();
  }

  return { composeAtlasView, install };
});

if (typeof document !== 'undefined') AtlasLive.install(globalThis.ATLAS_INITIAL_STATE);
