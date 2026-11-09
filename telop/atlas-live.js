(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AtlasLive = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (root) {
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
    const intensityEvents = newestFirst(snapshot.layers.intensity);
    const intensityLines = intensityEvents.flatMap((entry) =>
      (entry.payload?.lines || []).map((text) => ({ eventId: entry.event.id, text })));
    const headlines = newestFirst(snapshot.layers.vertical).map((entry) => ({ eventId: entry.event.id, ...entry.payload })).filter((item) => item.text);
    return {
      eew,
      tsunami: Object.fromEntries(Object.entries(tsunami).map(([key, areas]) => [key, [...areas]])),
      intensityLines,
      intensity: intensityEvents[0]?.payload?.render || null,
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
    const verticalEewElement = document.getElementById('eew-v');
    const tsunamiElement = document.getElementById('tsunami-mini');
    let lastEew = null;
    let lastTsunami = null;
    let lastIntensity = '';
    let lineIndex = 0;
    let lineTimer = null;

    function syncAlpha() {
      if (!alpha) return;
      alpha.replaceChildren();
      if (eewElement?.classList.contains('on')) {
        const mask = document.createElement('div');
        mask.className = 'atlas-alpha-eew';
        mask.setAttribute('aria-hidden', 'true');
        Object.assign(mask.style, { left: '417px', top: '270px', width: '803px', height: '268px' });
        alpha.appendChild(mask);
      }
      if (tsunamiElement) {
        const mirror = tsunamiElement.cloneNode(true);
        mirror.classList.add('atlas-alpha-tsunami');
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.top = '174px';
        mirror.style.left = '1236px';
        mirror.style.backgroundColor = '#999';
        const force = (selector, properties) => mirror.querySelectorAll(selector).forEach((element) => {
          for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
        });
        force('.tm-land', { fill: '#fff', stroke: '#fff' });
        force('.tm-coast, .tm-zone', { fill: 'none', stroke: '#fff' });
        force('.tm-label, .tm-legend-label, text, rect', { fill: '#fff', stroke: '#fff' });
        alpha.appendChild(mirror);
      }
    }

    function showIntensity(data) {
      if (!intensity) return;
      if (lineTimer) clearInterval(lineTimer);
      lineTimer = null;
      lineIndex = 0;
      intensity.replaceChildren();
      const groups = data?.cityGroups && Object.keys(data.cityGroups).length ? data.cityGroups : data?.groups;
      const levels = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
      const labels = { '6+': '6強', '6-': '6弱', '5+': '5強', '5-': '5弱' };
      const rows = [];
      for (const level of levels) {
        let names = [];
        let characters = 0;
        for (const name of groups?.[level] || []) {
          const length = [...name].length + (names.length ? 1 : 0);
          if (names.length && characters + length > 21) {
            rows.push({ level, names, first: !rows.some((row) => row.level === level) });
            names = [];
            characters = 0;
          }
          names.push(name);
          characters += [...name].length + (names.length > 1 ? 1 : 0);
        }
        if (names.length) rows.push({ level, names, first: !rows.some((row) => row.level === level) });
      }
      if (!rows.length) return;
      const render = () => {
        intensity.replaceChildren();
        for (let offset = 0; offset < 2 && offset < rows.length; offset += 1) {
          const row = rows[(lineIndex + offset) % rows.length];
          const line = document.createElement('div');
          line.className = `atlas-intensity-row ${offset === 0 ? 'top' : 'bottom'}`;
          const badge = document.createElement('span');
          const showBadge = row.first || offset === 0;
          badge.className = showBadge ? 'atlas-intensity-badge' : 'atlas-intensity-continuation';
          badge.textContent = showBadge ? `震度${labels[row.level] || row.level}` : '';
          const areas = document.createElement('span');
          areas.className = 'atlas-intensity-areas';
          row.names.forEach((name, index) => {
            if (index) areas.append('　');
            const appendRuby = (base, reading) => {
              if (!base) return;
              if (!reading) {
                areas.append(base);
                return;
              }
              const ruby = document.createElement('ruby');
              ruby.textContent = base;
              const rt = document.createElement('rt');
              rt.textContent = reading;
              ruby.appendChild(rt);
              areas.appendChild(ruby);
            };
            const reading = data.cityReadings?.[name];
            if (!reading) {
              areas.append(name);
              return;
            }
            let baseIndex = 0;
            let readingIndex = 0;
            for (const match of name.matchAll(/[ぁ-ゖ]+/gu)) {
              const readingMatch = reading.indexOf(match[0], readingIndex);
              if (readingMatch < readingIndex) {
                areas.append(name.slice(baseIndex));
                baseIndex = name.length;
                break;
              }
              appendRuby(name.slice(baseIndex, match.index), reading.slice(readingIndex, readingMatch));
              areas.append(match[0]);
              baseIndex = match.index + match[0].length;
              readingIndex = readingMatch + match[0].length;
            }
            appendRuby(name.slice(baseIndex), reading.slice(readingIndex));
          });
          line.append(badge, areas);
          intensity.appendChild(line);
        }
        lineIndex = (lineIndex + 2) % rows.length;
      };
      render();
      lineTimer = setInterval(render, 5000);
    }

    function applyAtlasSnapshot(snapshot) {
      const view = composeAtlasView(snapshot);
      root.ATLAS_LAST_SNAPSHOT = snapshot;
      if (clock) clock.textContent = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date());

      const eew = view.eew;
      const eewKey = eew ? `${eew.event.id}:${eew.event.serial}:${eew.event.publishedAt}` : '';
      let alphaDirty = false;
      if (eewKey !== lastEew) {
        if (eew?.payload?.render) {
          const input = eew.payload.render;
          if (lastEew && lastEew.startsWith(`${eew.event.id}:`) && typeof renderEEWUpdate === 'function') renderEEWUpdate(input);
          else renderEEW(input);
          if (typeof renderEEWVertical === 'function') renderEEWVertical(input);
        } else if (eewElement) {
          eewElement.classList.remove('on');
          if (verticalEewElement) verticalEewElement.classList.remove('on');
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
      const intensityJson = JSON.stringify(view.intensity);
      if (intensityJson !== lastIntensity) {
        showIntensity(view.intensity);
        lastIntensity = intensityJson;
      }
      if (headline) {
        headline.replaceChildren();
        if (view.headline?.place && view.headline.reading) {
          const ruby = document.createElement('ruby');
          ruby.textContent = view.headline.place;
          const reading = document.createElement('rt');
          reading.textContent = view.headline.reading;
          ruby.appendChild(reading);
          const number = document.createElement('span');
          number.className = 'atlas-headline-number';
          number.textContent = view.headline.intensity;
          headline.append(ruby, 'で震度', number);
        } else {
          headline.textContent = view.headline?.text || '';
        }
      }
      if (alphaDirty) syncAlpha();
      root.ATLAS_RENDER_READY = true;
    }

    root.applyAtlasSnapshot = applyAtlasSnapshot;
    if (initialSnapshot) applyAtlasSnapshot(initialSnapshot);
    async function poll() {
      try {
        const response = await fetch(`atlas-state.json?t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) {
          applyAtlasSnapshot(await response.json());
          root.ATLAS_SNAPSHOT_RECEIVED = true;
        }
      } catch (_) { /* Keep the last rendered snapshot while the state file is unavailable. */ }
      setTimeout(poll, 1000);
    }
    poll();
  }

  return { composeAtlasView, install };
});

if (typeof document !== 'undefined') AtlasLive.install(globalThis.ATLAS_INITIAL_STATE);
