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

  function intensityAtLeastOne(intensity) {
    return Number.parseInt(intensity?.maxInt, 10) >= 1;
  }

  function earthquakeDelta(current, previous) {
    if (!previous) return current;
    const groupsOf = (data) => data?.cityGroups && Object.keys(data.cityGroups).length ? data.cityGroups : data?.groups || {};
    const points = new Map(Object.entries(groupsOf(previous.intensity)).flatMap(([level, names]) => names.map((name) => [name, level])));
    const groups = Object.fromEntries(Object.entries(groupsOf(current.intensity)).map(([level, names]) =>
      [level, names.filter((name) => points.get(name) !== level)]));
    const oldLines = new Set(previous.summaryFrames.flatMap((frame) => frame.lines || []));
    return {
      ...current,
      intensity: { ...current.intensity, cityGroups: groups, groups },
      summaryFrames: current.summaryFrames.map((frame) => ({ ...frame, lines: (frame.lines || []).filter((line) => !oldLines.has(line)) }))
        .filter((frame) => frame.lines.length),
    };
  }

  function staleSources(health, now = Date.now()) {
    // 任意源 (axis/wolfx/projectbs) は、直近10分以内に状態報告があった場合だけ鮮度判定の対象にする
    // （無効化されている源を恒常的に未更新と表示しない）。
    const names = ['jma', 'p2p'];
    for (const name of ['axis', 'wolfx', 'projectbs']) {
      const at = Date.parse(health?.[name]?.at);
      if (Number.isFinite(at) && now - at <= 600_000) names.push(name);
    }
    return names.filter((name) => {
      const source = health?.[name];
      const updatedAt = Date.parse(source?.at);
      return !source || source.ok !== true || !Number.isFinite(updatedAt) || now - updatedAt > 120_000;
    });
  }

  function eewVisibility(display, lEnabled, keepHorizontalForVertical) {
    return {
      horizontal: lEnabled ? keepHorizontalForVertical : display.eewHorizontal !== false,
      vertical: lEnabled && (keepHorizontalForVertical || display.eewVertical !== false),
    };
  }

  function composeAtlasView(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !kinds.every((kind) => Array.isArray(snapshot.layers[kind]))) {
      throw new TypeError('invalid atlas snapshot');
    }
    const eew = newestFirst(snapshot.layers.eew.filter((entry) => entry.action !== 'cancel'))[0] || null;
    const tsunami = { major: new Set(), warning: new Set(), advisory: new Set() };
    const tsunamiFrames = (snapshot.notices || []).filter((notice) => notice.kind === 'tsunami').map((notice) => ({ level: 'notice', label: notice.payload.notice }));
    tsunamiFrames.push(...newestFirst(snapshot.layers.tsunami).flatMap((entry) => (entry.payload?.tsunamiFrames || []).map((frame) => ({
      ...frame, updateKey: `${entry.event.id}:${entry.event.serial || 0}:${entry.event.publishedAt || ''}:${frame.level}:${frame.area}:${frame.height}:${frame.arrival}`,
    }))));
    for (const entry of snapshot.layers.tsunami) {
      for (const key of Object.keys(tsunami)) for (const area of entry.payload?.render?.[key] || []) tsunami[key].add(area);
    }
    const intensityEvents = newestFirst(snapshot.layers.intensity.filter((entry) => intensityAtLeastOne(entry.payload?.render))).slice(0, 1);
    const intensityLines = intensityEvents.flatMap((entry) =>
      (entry.payload?.lines || []).map((text) => ({ eventId: entry.event.id, text })));
    const intensityIds = new Set(intensityEvents.map((entry) => entry.event.id));
    const headlines = newestFirst(snapshot.layers.vertical).filter((entry) => intensityIds.has(entry.event.id))
      .map((entry) => ({ eventId: entry.event.id, ...entry.payload })).filter((item) => item.text);
    return {
      eew,
      tsunami: Object.fromEntries(Object.entries(tsunami).map(([key, areas]) => [key, [...areas]])),
      tsunamiFrames,
      display: { ...snapshot.display },
      testMode: snapshot.testMode === true,
      intensityLines,
      intensity: intensityEvents[0]?.payload?.render || null,
      intensityEvent: intensityEvents[0]?.event || null,
      summaryFrames: intensityEvents[0]?.payload?.summaryFrames || [],
      headline: headlines[0] || null,
      staleSources: staleSources(snapshot.sourceHealth),
    };
  }

  // All tsunami map copies (main, left, and alpha mirror) share one wall-clock
  // phase. CSS animations run on .tm-zone descendants, not on their <svg> parents.
  // Reading document.getAnimations() includes them even after an SVG is rebuilt.
  function syncTsunamiBlinkClock(unixMs) {
    if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return 0;
    const now = Number(unixMs);
    if (!Number.isFinite(now)) throw new TypeError('blink clock requires Unix milliseconds');
    let synchronized = 0;
    for (const animation of document.getAnimations()) {
      if (animation.animationName !== 'tmblink') continue;
      const duration = Number(animation.effect?.getTiming?.().duration);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      animation.pause();
      // Do not advance by the nominal capture interval: missed/slow frames
      // should skip to the current phase, never accumulate a timing deficit.
      animation.currentTime = ((now % duration) + duration) % duration;
      synchronized++;
    }
    return synchronized;
  }

  function install(initialSnapshot) {
    if (typeof document === 'undefined') return;
    const clock = document.getElementById('atlas-clock');
    const intensity = document.getElementById('atlas-intensity');
    const headline = document.getElementById('atlas-headline');
    const alpha = document.getElementById('atlas-alpha-mirror');
    const sourceStatus = document.getElementById('atlas-source-status');
    const testNotice = document.getElementById('atlas-test-notice');
    const eewElement = document.getElementById('eew-box');
    const verticalEewElement = document.getElementById('eew-v');
    const tsunamiElement = document.getElementById('tsunami-mini');
    const tsunamiLeftElement = document.getElementById('tsunami-mini-left');
    const tsunamiSuperElement = document.getElementById('tsunami-super');
    let lastEew = null;
    let lastEewHorizontal = null;
    let lastEewVertical = null;
    let lastTsunami = null;
    let lastTsunamiLeft = null;
    let tsunamiVisible = false;
    let tsunamiLeftVisible = false;
    let lEnabled = false;
    let keepHorizontalForVertical = false;
    let lTransitionTimer = null;
    let lastIntensity = '';
    let lineIndex = 0;
    let lineTimer = null;
    let earthquakePages = 0;
    let earthquakeInterruptedByTsunami = false;
    let previousEarthquake = null;
    let latestEarthquakeTime = -Infinity;
    let tsunamiSuperFrames = [];
    let tsunamiSuperPage = 0;
    let tsunamiSuperCycle = 0;
    let tsunamiSuperTimer = null;
    let tsunamiSuperActive = false;
    const seenTsunamiUpdates = new Set();
    let eewLeft = 574.5;

    function drawTsunamiSuper() {
      if (!tsunamiSuperElement) return;
      tsunamiSuperElement.replaceChildren();
      const pageCount = Math.ceil(tsunamiSuperFrames.length / 6);
      let previousLevel = '';
      for (const frame of tsunamiSuperFrames.slice(tsunamiSuperPage * 6, tsunamiSuperPage * 6 + 6)) {
        if (frame.level !== previousLevel) {
          const head = document.createElement('div');
          head.className = `tsunami-super-head tsunami-super-${frame.level}`;
          for (const [className, text] of [
            ['tsunami-super-kind', `${frame.label}${tsunamiSuperFrames.some((item) => item.level === frame.level && item.additional) ? ' 追加' : ''}`],
            ['', '▼第1波予想'], ['', '▼最大予想'],
          ]) {
            const cell = document.createElement('span');
            cell.className = className;
            cell.textContent = text;
            head.appendChild(cell);
          }
          tsunamiSuperElement.appendChild(head);
          previousLevel = frame.level;
        }
        const row = document.createElement('div');
        row.className = `tsunami-super-row tsunami-super-${frame.level}`;
        for (const [className, value] of [
          ['tsunami-super-area', frame.area],
          ['tsunami-super-arrival', frame.arrival],
          ['tsunami-super-height', frame.height],
        ]) {
          const cell = document.createElement('span');
          cell.className = className;
          cell.textContent = value;
          row.appendChild(cell);
        }
        tsunamiSuperElement.appendChild(row);
      }
      tsunamiSuperElement.style.display = tsunamiSuperActive ? 'block' : 'none';
    }

    function stopTsunamiSuper() {
      if (tsunamiSuperTimer) clearTimeout(tsunamiSuperTimer);
      tsunamiSuperTimer = null;
      tsunamiSuperActive = false;
      tsunamiSuperFrames = [];
      if (tsunamiSuperElement) {
        tsunamiSuperElement.style.display = 'none';
        tsunamiSuperElement.replaceChildren();
      }
    }

    function advanceTsunamiSuper() {
      const pageCount = Math.ceil(tsunamiSuperFrames.length / 6);
      tsunamiSuperPage += 1;
      if (tsunamiSuperPage >= pageCount) {
        tsunamiSuperPage = 0;
        tsunamiSuperCycle += 1;
      }
      if (tsunamiSuperCycle >= 2) {
        stopTsunamiSuper();
        return;
      }
      drawTsunamiSuper();
      tsunamiSuperTimer = setTimeout(advanceTsunamiSuper, 7500);
    }

    function updateTsunamiSuper(frames) {
      const warnings = frames.filter((frame) => frame.level === 'major' || frame.level === 'warning');
      if (!warnings.length) {
        stopTsunamiSuper();
        return;
      }
      const fresh = warnings.some((frame) => !seenTsunamiUpdates.has(frame.updateKey));
      for (const frame of warnings) seenTsunamiUpdates.add(frame.updateKey);
      if (fresh) {
        if (tsunamiSuperTimer) clearTimeout(tsunamiSuperTimer);
        tsunamiSuperFrames = warnings;
        tsunamiSuperPage = 0;
        tsunamiSuperCycle = 0;
        tsunamiSuperActive = true;
        drawTsunamiSuper();
        tsunamiSuperTimer = setTimeout(advanceTsunamiSuper, 7500);
      } else if (tsunamiSuperActive) {
        tsunamiSuperFrames = warnings;
        tsunamiSuperPage %= Math.ceil(warnings.length / 6);
        drawTsunamiSuper();
      }
    }

    function applyControls(controls) {
      const lActive = (Number(controls?.flags) & 1) !== 0;
      const left = lActive ? 297 + (1920 - 803) / 2 - 281 : 297 + (1639 - 803) / 2;
      if (left !== eewLeft) {
        eewLeft = left;
        if (eewElement) eewElement.style.left = `${left}px`;
        if (alpha) {
          const mask = alpha.querySelector('.atlas-alpha-eew');
          if (mask) mask.style.left = `${left}px`;
        }
      }
      if (lActive !== lEnabled) {
        lEnabled = lActive;
        if (lTransitionTimer) clearTimeout(lTransitionTimer);
        keepHorizontalForVertical = lActive;
        if (lActive) {
          lTransitionTimer = setTimeout(() => {
            keepHorizontalForVertical = false;
            if (root.ATLAS_LAST_SNAPSHOT) applyAtlasSnapshot(root.ATLAS_LAST_SNAPSHOT);
          }, 1000);
        } else {
          lTransitionTimer = null;
        }
        if (root.ATLAS_LAST_SNAPSHOT) applyAtlasSnapshot(root.ATLAS_LAST_SNAPSHOT);
      }
    }

    function syncAlpha() {
      if (!alpha) return;
      alpha.replaceChildren();
      if (eewElement?.classList.contains('on')) {
        const mask = document.createElement('div');
        mask.className = 'atlas-alpha-eew';
        mask.setAttribute('aria-hidden', 'true');
        Object.assign(mask.style, { left: `${eewLeft}px`, top: '270px', width: '803px', height: '268px' });
        alpha.appendChild(mask);
      }
      if (tsunamiVisible && tsunamiElement) {
        const mirror = tsunamiElement.cloneNode(true);
        mirror.classList.add('atlas-alpha-tsunami');
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.top = '174px';
        mirror.style.left = '1357px';
        mirror.style.backgroundColor = '#999';
        const force = (selector, properties) => mirror.querySelectorAll(selector).forEach((element) => {
          for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
        });
        force('.tm-land', { fill: '#fff', stroke: '#fff' });
        force('.tm-coast', { fill: 'none', stroke: '#fff' });
        force('.tm-zone', { fill: '#fff', stroke: 'none' });
        force('.tm-label, .tm-legend-label, text, rect', { fill: '#fff', stroke: '#fff' });
        alpha.appendChild(mirror);
      }
    }

    function showIntensity(data, summaryFrames = [], tsunamiFrames = []) {
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
      const earthquakeFrames = tsunamiFrames.length ? [] : summaryFrames;
      const rowPages = tsunamiFrames.length ? 0 : Math.ceil(rows.length / 2);
      const pageCount = tsunamiFrames.length || earthquakeFrames.length + rowPages;
      if (!pageCount) return;
      const render = () => {
        intensity.replaceChildren();
        if (!tsunamiFrames.length && earthquakePages >= pageCount * 2) {
          clearInterval(lineTimer);
          lineTimer = null;
          return;
        }
        if (!tsunamiFrames.length) earthquakePages += 1;
        if (tsunamiFrames.length) {
          const frame = tsunamiFrames[lineIndex];
          if (frame.level === 'notice') {
            const notice = document.createElement('div');
            notice.className = 'atlas-summary-line';
            notice.textContent = frame.label;
            intensity.appendChild(notice);
            lineIndex = (lineIndex + 1) % pageCount;
            return;
          }
          const category = document.createElement('div');
          category.className = `atlas-tsunami-line atlas-tsunami-${frame.level}`;
          const badge = document.createElement('span');
          badge.className = 'atlas-tsunami-badge';
          badge.textContent = frame.label;
          const style = { major: '#c800ff', warning: '#ff2800', advisory: '#faf500' };
          badge.style.backgroundColor = style[frame.level] || '#ff2800';
          category.appendChild(badge);
          if (frame.additional) {
            const addition = document.createElement('span');
            addition.className = 'atlas-tsunami-additional';
            addition.textContent = '追加';
            category.appendChild(addition);
          }
          const area = document.createElement('span');
          area.className = 'atlas-tsunami-text';
          area.textContent = frame.area;
          category.appendChild(area);
          intensity.appendChild(category);
          if (frame.level !== 'advisory' || frame.height !== '不明') {
            const detail = document.createElement('div');
            detail.className = 'atlas-tsunami-line atlas-tsunami-detail';
            const forecast = document.createElement('span');
            forecast.className = 'atlas-tsunami-forecast-badge';
            forecast.textContent = '予想';
            const values = document.createElement('span');
            values.className = 'atlas-tsunami-text';
            const heightLabel = frame.height === '不明' ? '高さ不明' : frame.height;
            values.textContent = `${heightLabel}　${frame.arrival}`;
            detail.append(forecast, values);
            intensity.appendChild(detail);
          }
        } else if (lineIndex < earthquakeFrames.length) {
          for (const text of earthquakeFrames[lineIndex].lines || []) {
            if (!text) continue;
            const line = document.createElement('div');
            line.className = 'atlas-summary-line';
            line.textContent = text;
            intensity.appendChild(line);
          }
        } else {
          const page = lineIndex - earthquakeFrames.length;
          const start = page * 2;
          for (let offset = 0; offset < 2 && start + offset < rows.length; offset += 1) {
            const row = rows[start + offset];
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
        }
        lineIndex = (lineIndex + 1) % pageCount;
      };
      render();
      if (pageCount > 1 || !tsunamiFrames.length) lineTimer = setInterval(render, 7500);
    }

    function applyAtlasSnapshot(snapshot) {
      const view = composeAtlasView(snapshot);
      root.ATLAS_LAST_SNAPSHOT = snapshot;
      updateTsunamiSuper(view.tsunamiFrames);
      if (clock) clock.textContent = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date());
      if (sourceStatus) {
        const stale = view.staleSources;
        sourceStatus.textContent = stale.length ? `情報源未更新: ${stale.join(' / ').toUpperCase()}` : '';
        sourceStatus.style.display = stale.length ? 'block' : 'none';
      }
      if (testNotice) testNotice.style.display = view.testMode ? 'flex' : 'none';

      const eew = view.eew;
      const eewKey = eew ? `${eew.event.id}:${eew.event.serial}:${eew.event.publishedAt}` : '';
      const { horizontal: eewHorizontal, vertical: eewVertical } = eewVisibility(view.display, lEnabled, keepHorizontalForVertical);
      let alphaDirty = false;
      if (eewKey !== lastEew || eewHorizontal !== lastEewHorizontal || eewVertical !== lastEewVertical) {
        if (eew?.payload?.render) {
          const input = eew.payload.render;
          if (eewHorizontal) {
            if (eewKey !== lastEew && lastEewHorizontal && lastEew?.startsWith(`${eew.event.id}:`) && typeof renderEEWUpdate === 'function') renderEEWUpdate(input);
            else renderEEW(input);
          } else eewElement?.classList.remove('on');
          if (eewVertical) renderEEWVertical(input);
          else verticalEewElement?.classList.remove('on');
        } else {
          eewElement?.classList.remove('on');
          verticalEewElement?.classList.remove('on');
        }
        lastEew = eewKey;
        lastEewHorizontal = eewHorizontal;
        lastEewVertical = eewVertical;
        alphaDirty = true;
      }

      const tsunamiJson = JSON.stringify(view.tsunami);
      const hasTsunamiAreas = view.tsunami.warning.length > 0 || view.tsunami.major.length > 0;
      const advisoryOnly = view.tsunami.advisory.length > 0 && !hasTsunamiAreas;
      const nextTsunamiVisible = view.display.tsunamiMap !== false && hasTsunamiAreas;
      const tsunamiRenderKey = `${tsunamiJson}:${view.display.tsunamiLines !== false}:${advisoryOnly}`;
      if (tsunamiRenderKey !== lastTsunami || nextTsunamiVisible !== tsunamiVisible) {
        tsunamiVisible = nextTsunamiVisible;
        if (tsunamiElement) {
          tsunamiElement.className = advisoryOnly ? 'advisory-only' : '';
          tsunamiElement.style.display = tsunamiVisible ? '' : 'none';
          if (tsunamiVisible && typeof renderTsunamiMini === 'function') renderTsunamiMini({ ...view.tsunami, linesVisible: view.display.tsunamiLines !== false });
          else if (!tsunamiVisible) tsunamiElement.replaceChildren();
        }
        lastTsunami = tsunamiRenderKey;
        alphaDirty = true;
      }
      const verticalEewVisible = verticalEewElement?.classList.contains('on') === true;
      const leftMapEnabled = view.display.tsunamiLeftMap !== false;
      const leftMapKey = `${tsunamiJson}:${view.display.tsunamiLines !== false}:${leftMapEnabled}:${verticalEewVisible}`;
      const nextTsunamiLeftVisible = leftMapEnabled && !verticalEewVisible && hasTsunamiAreas;
      if (leftMapKey !== lastTsunamiLeft || nextTsunamiLeftVisible !== tsunamiLeftVisible) {
        tsunamiLeftVisible = nextTsunamiLeftVisible;
        if (tsunamiLeftElement) {
          tsunamiLeftElement.style.display = tsunamiLeftVisible ? 'block' : 'none';
          if (tsunamiLeftVisible && typeof renderTsunamiMini === 'function') {
            renderTsunamiMini({ ...view.tsunami, linesVisible: view.display.tsunamiLines !== false }, tsunamiLeftElement);
          } else if (!tsunamiLeftVisible) tsunamiLeftElement.replaceChildren();
        }
        lastTsunamiLeft = leftMapKey;
      }
      const intensityJson = `${view.intensityEvent?.id}:${JSON.stringify(view.intensity)}:${JSON.stringify(view.summaryFrames)}:${JSON.stringify(view.tsunamiFrames)}:${view.display.earthquakeTelop !== false}`;
      if (intensityJson !== lastIntensity) {
        let next = { intensity: null, summaryFrames: [] };
        if (view.tsunamiFrames.length) earthquakeInterruptedByTsunami = true;
        if (!view.tsunamiFrames.length && view.display.earthquakeTelop !== false && view.intensityEvent) {
          const time = Date.parse(view.intensityEvent.publishedAt || '') || 0;
          if (time >= latestEarthquakeTime) {
            next = earthquakeInterruptedByTsunami
              ? { intensity: view.intensity, summaryFrames: view.summaryFrames }
              : earthquakeDelta(view, previousEarthquake?.intensityEvent.id === view.intensityEvent.id ? previousEarthquake : null);
            latestEarthquakeTime = time;
            previousEarthquake = JSON.parse(JSON.stringify(view));
            earthquakeInterruptedByTsunami = false;
          }
        }
        earthquakePages = 0;
        showIntensity(next.intensity, next.summaryFrames, view.tsunamiFrames);
        lastIntensity = intensityJson;
      }
      if (headline) {
        headline.replaceChildren();
        const noTsunamiWorry = view.summaryFrames.some((frame) => frame.lines?.includes('津波の心配はありません'));
        if (lEnabled && noTsunamiWorry && view.display.earthquakeTelop !== false) {
          headline.textContent = '津波の心配なし';
          headline.style.display = 'block';
          headline.style.color = '#fff';
        } else if (view.display.earthquakeTelop === false) {
          headline.style.display = 'none';
          headline.textContent = '';
        } else {
          headline.style.display = 'none';
          headline.style.color = '';
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
      }
      if (alphaDirty) syncAlpha();
      root.ATLAS_RENDER_READY = true;
    }

    root.applyAtlasSnapshot = applyAtlasSnapshot;
    root.applyAtlasControls = applyControls;
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

  return { composeAtlasView, staleSources, install, syncTsunamiBlinkClock, eewVisibility, earthquakeDelta };
});

if (typeof document !== 'undefined') AtlasLive.install(globalThis.ATLAS_INITIAL_STATE);
