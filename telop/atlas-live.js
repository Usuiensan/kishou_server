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
    const oldLongPeriod = new Set((previous.longPeriodFrames || []).map((frame) => JSON.stringify(frame)));
    return {
      ...current,
      intensity: { ...current.intensity, cityGroups: groups, groups },
      summaryFrames: current.summaryFrames.map((frame) => ({ ...frame, lines: (frame.lines || []).filter((line) => !oldLines.has(line)) }))
        .filter((frame) => frame.lines.length),
      longPeriodFrames: (current.longPeriodFrames || []).filter((frame) => !oldLongPeriod.has(JSON.stringify(frame))),
    };
  }

  // 津波の差分表示 (earthquakeDelta の津波版): 更新データが入ったとき、
  // 最初から出し直さず、更新された区域だけを次のローテーションで流す。
  // 判定単位は区域 = 詳細フレームの内容 (レベル・区域・ラベル・追加・
  // 高さ・到達・実データフラグ) の変化。一覧フレームは、種別ごとの
  // 区域集合 (一覧の並び) が変わった種別についてまとめて差し込む
  // (区域の追加・削除は一覧の変化として現れる)。解除通知は常に出す。
  // イベントが新規の場合はそのイベントの全フレームが「新規」になる。
  function tsunamiDelta(current, previous) {
    if (!previous) return current;
    const eventOf = (frame) => String(frame.updateKey || '').split(':')[0];
    const detailContent = (frame) => [frame.level, frame.area, frame.label, frame.additional ? 1 : 0,
      frame.height, frame.arrival, frame.hasHeight, frame.hasArrival].join('|');
    const previousDetails = new Map();
    const previousOverviews = new Map();
    for (const frame of previous) {
      if (frame.overview) {
        const key = `${eventOf(frame)}:${frame.level}`;
        previousOverviews.set(key, `${previousOverviews.get(key) || ''}${frame.area}\n`);
      } else if (frame.level !== 'notice' && frame.area) {
        previousDetails.set(`${eventOf(frame)}:${frame.level}:${frame.area}`, detailContent(frame));
      }
    }
    const changedOverviewKeys = new Set();
    const currentOverviews = new Map();
    for (const frame of current) {
      if (!frame.overview) continue;
      const key = `${eventOf(frame)}:${frame.level}`;
      currentOverviews.set(key, `${currentOverviews.get(key) || ''}${frame.area}\n`);
    }
    for (const [key, content] of currentOverviews) {
      if (previousOverviews.get(key) !== content) changedOverviewKeys.add(key);
    }
    return current.filter((frame) => {
      if (frame.level === 'notice') return true;
      if (frame.overview) return changedOverviewKeys.has(`${eventOf(frame)}:${frame.level}`);
      if (!frame.area) return true;
      return previousDetails.get(`${eventOf(frame)}:${frame.level}:${frame.area}`) !== detailContent(frame);
    });
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

  // EEW の発表基準 (2026-11-14 ユーザー決定)。予想最大震度が
  // 「不明・4・5弱・5強・6弱・6強・7」なら全体通知し、予報級は地図を
  // 出さず角丸・半透明ウィンドウの2行テキスト、警報級は地図つき
  // ボックスで出す。震度は内部表記 ('5-' = 5弱など)、「不明」は
  // maxInt が null。Node 側の正本は lib/eewAnnounce.js で、ページへ
  // 埋め込まれるこのファイルは require できないため同じ集合をここ
  // にも持つ (変更時は両方揃える)。
  const EEW_ANNOUNCE_MAX_INTENSITIES = new Set(['4', '5-', '5+', '6-', '6+', '7']);

  // render の出し方: 'box' = 警報級 (地図つきボックス)、'window' =
  // 予報級かつ通知対象 (ウィンドウの2行テキストのみ)、'none' = 出さない。
  // isWarning が記録されていない旧形式の render は従来どおり 'box'。
  function eewDisplayMode(render) {
    if (!render || render.isWarning !== false) return 'box';
    return render.maxInt == null || EEW_ANNOUNCE_MAX_INTENSITIES.has(render.maxInt) ? 'window' : 'none';
  }

  // 予報級ウィンドウの2行テキスト (2026-11-14 ユーザー指定の書式)。
  // 1行目は「緊急地震速報(予報)[第N報]」(報数が取れなければ [第N報]
  // なし)、2行目はデータ行 (eewForecastDataLine)。データ行は警報級の
  // ストリップでも使うが、そちらは震源地名を省いた形にする。
  const EEW_MAX_INT_LABELS = { '4': '4', '5-': '5弱', '5+': '5強', '6-': '6弱', '6+': '6強', '7': '7' };

  // データ行: 震源地名 (電文のまま、短縮しない) に「で地震」を続け、
  // 最大震度・マグニチュード・深さを全角スペース1つで並べる。取れない
  // 要素は省く。最大震度が不明 (maxInt が null) のときは「最大震度不明」
  // とする。警報級のストリップ (omitHypocenter) では、ボックスの
  // 見出しに震源地名が書かれているため、地名要素ごと省く。
  function eewForecastDataLine(render, { omitHypocenter = false } = {}) {
    if (!render) return null;
    const parts = [];
    if (!omitHypocenter && render.hypocenterName) parts.push(`${render.hypocenterName}で地震`);
    parts.push(render.maxInt == null
      ? '最大震度不明' : `最大震度${EEW_MAX_INT_LABELS[render.maxInt] || render.maxInt}`);
    const magnitude = render.magnitude == null || render.magnitude === '' ? NaN : Number(render.magnitude);
    if (Number.isFinite(magnitude)) parts.push(`M${magnitude.toFixed(1)}`);
    if (render.depthKm != null && Number.isFinite(Number(render.depthKm))) {
      const depthKm = Number(render.depthKm);
      parts.push(depthKm === 0 ? '深さごく浅い' : `深さ${depthKm}km`);
    }
    return parts.join('　');
  }

  function eewForecastWindowLines(render) {
    if (!render) return null;
    const serial = render.serial == null ? null : Number(render.serial);
    const title = Number.isFinite(serial) && serial > 0
      ? `緊急地震速報(予報)[第${serial}報]` : '緊急地震速報(予報)';
    return [title, eewForecastDataLine(render)];
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
    // EEW は級で出し分ける: 警報級はボックス用 (eew)、予報級のうち
    // 通知対象はウィンドウ用 (eewWindow)。同時にある場合は両方を返す。
    const eewEntries = newestFirst(snapshot.layers.eew.filter((entry) => entry.action !== 'cancel'));
    const eew = eewEntries.find((entry) => eewDisplayMode(entry.payload?.render) === 'box') || null;
    const eewWindowEntry = eewEntries.find((entry) => eewDisplayMode(entry.payload?.render) === 'window') || null;
    const eewWindow = eewWindowEntry ? { lines: eewForecastWindowLines(eewWindowEntry.payload?.render) } : null;
    const tsunami = { major: new Set(), warning: new Set(), advisory: new Set() };
    const tsunamiFrames = (snapshot.notices || []).filter((notice) => notice.kind === 'tsunami').map((notice) => ({ level: 'notice', label: notice.payload.notice }));
    // 提示順序はイベントごとに「地名一覧 (overview) → 各地域の詳細」。
    tsunamiFrames.push(...newestFirst(snapshot.layers.tsunami).flatMap((entry) => [
      ...(entry.payload?.tsunamiOverviewFrames || []),
      ...(entry.payload?.tsunamiFrames || []),
    ].map((frame) => ({
      ...frame, updateKey: `${entry.event.id}:${entry.event.serial || 0}:${entry.event.publishedAt || ''}:${frame.level}:${frame.area}:${frame.height || ''}:${frame.arrival || ''}`,
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
      eewWindow,
      tsunami: Object.fromEntries(Object.entries(tsunami).map(([key, areas]) => [key, [...areas]])),
      tsunamiFrames,
      display: { ...snapshot.display },
      testMode: snapshot.testMode === true,
      intensityLines,
      intensity: intensityEvents[0]?.payload?.render || null,
      intensityEvent: intensityEvents[0]?.event || null,
      summaryFrames: intensityEvents[0]?.payload?.summaryFrames || [],
      longPeriodFrames: intensityEvents[0]?.payload?.longPeriodFrames || [],
      headline: headlines[0] || null,
      staleSources: staleSources(snapshot.sourceHealth),
    };
  }

  // 長周期の階級フレームのページ割り。地名列は1行22字まで (区切り含む)
  // で割り、2行ずつページ送りする。本文は40px、ルビは20px (モノルビ)。
  // バッジ2個 (「長周期地震動」6字＋「階級N」3字、いずれも31px、
  // padding/border 込みで218px＋125px、gap 22px×2＝44px、計387px)
  // を除いた地名列は 1382.4−387＝995.4px。本文だけなら
  // 995.4÷40≒24.9字分あるが、読みは漢字より長く (例: 大崎市古川大崎
  // 7字→読み13字)、ルビ側が幅を決めることがある。実データ (公式
  // サンプル全件＋実電文コーパス) の観測点名プール全件について、
  // 上限字数に収まる全ての組み合わせ (部分集合) の行幅を Chromium
  // 実レイアウトの実測幅から構成して検証し、23字では最悪の組み合わせ
  // が行幅1382.4pxを約4.6px超えたため、はみ出し0件になる22字を
  // 上限とする。地名の途中で切らず地名単位で改行する。単一の
  // 地名が22字を超える場合は、その地名だけで1行にする。
  // 見出し・説明行フレームはそのまま1ページにする。
  const LONG_PERIOD_LINE_CHARACTERS = 22;

  function longPeriodPages(lpFrames) {
    const pages = [];
    for (const frame of lpFrames || []) {
      if (frame.type === 'heading' || frame.type === 'note') {
        pages.push({ type: frame.type, lines: frame.lines || [] });
        continue;
      }
      const chunks = [];
      let chunk = [];
      let characters = 0;
      for (const name of frame.names || []) {
        const length = [...name].length + (chunk.length ? 1 : 0);
        if (chunk.length && characters + length > LONG_PERIOD_LINE_CHARACTERS) {
          chunks.push(chunk);
          chunk = [];
          characters = 0;
        }
        chunk.push(name);
        characters += [...name].length + (chunk.length > 1 ? 1 : 0);
      }
      if (chunk.length) chunks.push(chunk);
      if (!chunks.length) chunks.push([]);
      for (let start = 0; start < chunks.length; start += 2) {
        pages.push({
          type: 'class',
          level: frame.level,
          rows: chunks.slice(start, start + 2)
            .map((names, offset) => ({ names, first: start + offset === 0 })),
        });
      }
    }
    return pages;
  }

  // 津波予想行のデータ有無は、フォールバック文言 ('不明' / '到達時刻不明')
  // ではなく実データで判定する。lib/atlasData.js が frame.hasHeight /
  // frame.hasArrival を付ける。フラグが無いフレームでは文字列から復元する。
  // 注意報では警報級の高さ文言 (巨大・高い) は高さデータとして扱わない。
  function tsunamiHeightData(frame) {
    if (frame.level === 'advisory') {
      return !['巨大', '高い', '不明', ''].includes(String(frame.height ?? '').trim());
    }
    if (typeof frame.hasHeight === 'boolean') return frame.hasHeight;
    return Boolean(frame.height) && frame.height !== '不明';
  }

  function tsunamiArrivalData(frame) {
    if (typeof frame.hasArrival === 'boolean') return frame.hasArrival;
    return Boolean(frame.arrival) && frame.arrival !== '到達時刻不明';
  }

  // 予想行の [高さ, 到達] ラベル。高さ・予想時刻のどちらか片方でもデータが
  // あれば行を出し、データのない側は文言で埋めず全角スペースで埋める。
  // 高さ文言はカテゴリ対応 (巨大=大津波警報専用、高い=津波警報用) を
  // 描画側でそろえる。
  function tsunamiForecastValues(frame) {
    let heightLabel;
    if (!tsunamiHeightData(frame)) heightLabel = '　';
    else if (frame.level === 'warning' && frame.height === '巨大') heightLabel = '高い';
    else if (frame.level === 'major' && frame.height === '高い') heightLabel = '巨大';
    else heightLabel = frame.height;
    return [heightLabel, tsunamiArrivalData(frame) ? frame.arrival : '　'];
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
    const forecastWindowElement = document.getElementById('eew-forecast-window');
    const verticalEewElement = document.getElementById('eew-v');
    const tsunamiElement = document.getElementById('tsunami-mini');
    const tsunamiLeftElement = document.getElementById('tsunami-mini-left');
    const tsunamiSuperElement = document.getElementById('tsunami-super');
    let lastEew = null;
    let lastEewHorizontal = null;
    let lastEewVertical = null;
    let lastEewWindow = '';
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
    let previousTsunamiFrames = null;
    let previousTsunamiJson = '';
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
      // 一覧フレームは区域行ではないので、拡大表示の対象から外す。
      const warnings = frames.filter((frame) => !frame.overview && (frame.level === 'major' || frame.level === 'warning'));
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
        if (forecastWindowElement) forecastWindowElement.style.left = `${left}px`;
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

    // 総ルビ: 地名に読みがあればルビ付きで描く共通ヘルパー。ルビマスター
    // のモノルビセグメントがあればそれをそのまま使い (通常は漢字1字
    // ごと、困難な熟語だけ複数文字のセグメント)、無い名前は従来の
    // グループルビ (読みのひらがな部分を本文のひらがな並びと対応付け、
    // ルビは漢字部分にだけ付ける) にフォールバックする。読みが無い
    // 名前はそのまま出す。
    function appendNameWithRuby(parent, name, reading, monoSegments) {
      if (!name) {
        parent.append(name || '');
        return;
      }
      const appendRuby = (base, rubyReading) => {
        if (!base) return;
        if (!rubyReading) {
          parent.append(base);
          return;
        }
        const ruby = document.createElement('ruby');
        ruby.textContent = base;
        const rt = document.createElement('rt');
        rt.textContent = rubyReading;
        ruby.appendChild(rt);
        parent.appendChild(ruby);
      };
      if (Array.isArray(monoSegments) && monoSegments.length) {
        for (const [base, segmentReading] of monoSegments) {
          if (!segmentReading || segmentReading === base) parent.append(base);
          else appendRuby(base, segmentReading);
        }
        return;
      }
      if (!reading) {
        parent.append(name);
        return;
      }
      let baseIndex = 0;
      let readingIndex = 0;
      for (const match of name.matchAll(/[ぁ-ゖ]+/gu)) {
        const readingMatch = reading.indexOf(match[0], readingIndex);
        if (readingMatch < readingIndex) {
          parent.append(name.slice(baseIndex));
          baseIndex = name.length;
          break;
        }
        appendRuby(name.slice(baseIndex, match.index), reading.slice(readingIndex, readingMatch));
        parent.append(match[0]);
        baseIndex = match.index + match[0].length;
        readingIndex = readingMatch + match[0].length;
      }
      appendRuby(name.slice(baseIndex), reading.slice(readingIndex));
    }

    // 札の読み (文言は固定なので固定マップでよい)。札は行の高さ60pxに
    // 余白込みで一致させ、中身 (ルビ15px+漢字31px) は下寄せで出す
    // (寸法は build_atlas.py の CSS が正本)。読みの無い文言はそのまま出す。
    const BADGE_READINGS = {
      '大津波警報': 'おおつなみけいほう',
      '津波警報': 'つなみけいほう',
      '津波注意報': 'つなみちゅういほう',
      '予想': 'よそう',
      '長周期地震動': 'ちょうしゅうきじしんどう',
      '階級': 'かいきゅう',
      '震度': 'しんど',
    };

    function setBadgeLabel(badge, text, suffix = '') {
      const reading = BADGE_READINGS[text];
      if (reading) {
        const ruby = document.createElement('ruby');
        ruby.textContent = text;
        const rt = document.createElement('rt');
        rt.textContent = reading;
        ruby.appendChild(rt);
        badge.appendChild(ruby);
      } else {
        badge.append(text);
      }
      if (suffix) badge.append(suffix);
    }

    function showIntensity(data, summaryFrames = [], tsunamiFrames = [], longPeriodFrames = []) {
      if (!intensity) return;
      if (lineTimer) clearInterval(lineTimer);
      lineTimer = null;
      lineIndex = 0;
      intensity.replaceChildren();
      const groups = data?.cityGroups && Object.keys(data.cityGroups).length ? data.cityGroups : data?.groups;
      const levels = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
      const labels = { '6+': '6強', '6-': '6弱', '5+': '5強', '5-': '5弱' };
      // 震度行の地名列は1行24字まで (区切り含む)。本文は40px、ルビは
      // 20px (モノルビ)。札列 248px (札自体は「震度5弱」3字×31px＋
      // padding 24px＋border 8px＝125px で、列幅は従来どおり余裕を
      // 持たせた幅) と gap 22px を除いた地名列は 1382.4−270＝
      // 1112.4px。本文だけなら 1112.4÷40≒27.8字分あるが、読みは
      // 漢字より長くルビ側が幅を決める。実データ (公式サンプル全件＋
      // 実電文コーパス) の全行 (21字割りで2,233行) を新寸法の CSS で
      // Chromium 実レイアウト検証し、25字では1行が列幅を約7.6px
      // 超えたため、はみ出し0件になる24字を上限とする。
      const rows = [];
      for (const level of levels) {
        let names = [];
        let characters = 0;
        for (const name of groups?.[level] || []) {
          const length = [...name].length + (names.length ? 1 : 0);
          if (names.length && characters + length > 24) {
            rows.push({ level, names, first: !rows.some((row) => row.level === level) });
            names = [];
            characters = 0;
          }
          names.push(name);
          characters += [...name].length + (names.length > 1 ? 1 : 0);
        }
        if (names.length) rows.push({ level, names, first: !rows.some((row) => row.level === level) });
      }
      // 提示順序は「地名一覧 → 各地域の詳細」。一覧 (overview) は全区域を
      // 種別ごとにまとめて先に並べる。詳細側は、高さ・到達のどちらか
      // 片方でもデータのある区域だけにし、両方ない区域は一覧のみに
      // 現れる (PR #51 の注意報集約は一覧へ置き換えた)。データ有無は
      // フォールバック文言ではなく実データで判定する。
      const tsunamiDisplayFrames = [];
      for (const frame of tsunamiFrames) {
        if (frame.level === 'notice' || frame.overview || frame.grouped
          || tsunamiHeightData(frame) || tsunamiArrivalData(frame)) {
          tsunamiDisplayFrames.push(frame);
        }
      }
      // 一覧を持たない旧形式の入力では、詳細を落とさず従来どおり出す。
      if (tsunamiFrames.length && !tsunamiDisplayFrames.length) tsunamiDisplayFrames.push(...tsunamiFrames);
      const earthquakeFrames = tsunamiFrames.length ? [] : summaryFrames;
      const lpFrames = tsunamiFrames.length ? [] : longPeriodFrames;
      // 長周期の階級フレームのページ割り (地名列22字まで、バッジ幅と
      // ルビ幅を含めた行全体がレイアウト幅に収まる上限。longPeriodPages 参照)。
      const lpPages = longPeriodPages(lpFrames);
      const rowPages = tsunamiFrames.length ? 0 : Math.ceil(rows.length / 2);
      const pageCount = tsunamiDisplayFrames.length || earthquakeFrames.length + lpPages.length + rowPages;
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
          const frame = tsunamiDisplayFrames[lineIndex];
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
          setBadgeLabel(badge, frame.label);
          // 札の色はカラーユニバーサルデザイン推奨配色 (CUD) + WCAG AAA
          // 判定済みの組み合わせ (protocol/overlay-fixed.md の色対応表)。
          const style = {
            major: { background: '#990099', color: '#fff' },
            warning: { background: '#ff4b00', color: '#000' },
            advisory: { background: '#fff100', color: '#000' },
          };
          const badgeStyle = style[frame.level] || style.warning;
          badge.style.backgroundColor = badgeStyle.background;
          badge.style.color = badgeStyle.color;
          category.appendChild(badge);
          if (frame.additional) {
            const addition = document.createElement('span');
            addition.className = 'atlas-tsunami-additional';
            addition.textContent = '追加';
            category.appendChild(addition);
          }
          const area = document.createElement('span');
          area.className = 'atlas-tsunami-text';
          // 総ルビ: 一覧は区域ごとに、詳細は区域名にルビを付ける。
          const areaNames = frame.areas?.length ? frame.areas : [frame.area];
          areaNames.forEach((name, index) => {
            if (index) area.append('　');
            appendNameWithRuby(area, name, frame.readings?.[name], frame.monoReadings?.[name]);
          });
          category.appendChild(area);
          intensity.appendChild(category);
          if (!frame.grouped && !frame.overview) {
            const detail = document.createElement('div');
            detail.className = 'atlas-tsunami-line atlas-tsunami-detail';
            const forecast = document.createElement('span');
            forecast.className = 'atlas-tsunami-forecast-badge';
            setBadgeLabel(forecast, '予想');
            const values = document.createElement('span');
            values.className = 'atlas-tsunami-text';
            // 予想行は、高さ・予想時刻のどちらか片方でもデータがあれば
            // 出す。データのない側は「高さ不明」「到達時刻不明」のような
            // 文言で埋めず、全角スペースで埋める (気象庁が言っていない
            // 文言を載せない)。文言のカテゴリ対応と空白化は
            // tsunamiForecastValues が担う。
            const [heightLabel, arrivalLabel] = tsunamiForecastValues(frame);
            values.textContent = `${heightLabel}　${arrivalLabel}`;
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
        } else if (lineIndex < earthquakeFrames.length + lpPages.length) {
          const page = lpPages[lineIndex - earthquakeFrames.length];
          if (page.type === 'heading' || page.type === 'note') {
            for (const text of page.lines || []) {
              if (!text) continue;
              const line = document.createElement('div');
              line.className = 'atlas-summary-line';
              line.textContent = text;
              intensity.appendChild(line);
            }
          } else {
            // 階級フレーム: 1ページ2行まで。各ページの先頭行に
            // 「長周期地震動」バッジ+「階級N」バッジを付け、継続行は
            // バッジを不可視にして地名の開始位置をそろえる (震度行の
            // 継続バッジと同じ流儀)。
            page.rows.forEach((row, offset) => {
              const line = document.createElement('div');
              line.className = 'atlas-longperiod-line';
              const showBadges = row.first || offset === 0;
              const badge = document.createElement('span');
              badge.className = 'atlas-longperiod-badge';
              setBadgeLabel(badge, '長周期地震動');
              const classBadge = document.createElement('span');
              classBadge.className = 'atlas-longperiod-class-badge';
              setBadgeLabel(classBadge, '階級', String(page.level));
              if (!showBadges) {
                badge.classList.add('atlas-longperiod-continuation');
                classBadge.classList.add('atlas-longperiod-continuation');
              }
              const names = document.createElement('span');
              names.className = 'atlas-longperiod-names';
              // 総ルビ: 観測点名にも震度行と同じルビを付ける (行割りの
              // 文字数カウントは従来どおり地名の文字数で行う)。
              row.names.forEach((name, index) => {
                if (index) names.append('　');
                appendNameWithRuby(names, name, data.cityReadings?.[name], data.cityMonoReadings?.[name]);
              });
              line.append(badge, classBadge, names);
              intensity.appendChild(line);
            });
          }
        } else {
          const page = lineIndex - earthquakeFrames.length - lpPages.length;
          const start = page * 2;
          for (let offset = 0; offset < 2 && start + offset < rows.length; offset += 1) {
            const row = rows[start + offset];
            const line = document.createElement('div');
            line.className = `atlas-intensity-row ${offset === 0 ? 'top' : 'bottom'}`;
            const badge = document.createElement('span');
            const showBadge = row.first || offset === 0;
            badge.className = showBadge ? 'atlas-intensity-badge' : 'atlas-intensity-continuation';
            if (showBadge) setBadgeLabel(badge, '震度', String(labels[row.level] || row.level));
            else badge.textContent = '';
            const areas = document.createElement('span');
            areas.className = 'atlas-intensity-areas';
            row.names.forEach((name, index) => {
              if (index) areas.append('　');
              appendNameWithRuby(areas, name, data.cityReadings?.[name], data.cityMonoReadings?.[name]);
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

      // 予報級 EEW (通知対象) はボックスも地図も出さず、横型ボックスと
      // 同じ位置の角丸・半透明ウィンドウに2行テキストだけを出す。
      // 警報級ボックスが出ている間は、同じ要素をデータ行1行だけの
      // コンパクト形 (ストリップ) にして画面上部へ移し、警報級自身の
      // データ行を出す (ボックスは従来どおり表示する)。ストリップの
      // データ行は、ボックスの見出しに震源地名が書かれているため
      // 震源地名を省く。ストリップは
      // 上部テロップと同じ上マージン・ウィンドウと同じ左端に置き
      // (クラス strip)、上部テロップのサマリーが同時表示されている
      // ときはその帯 (予約高さ分) の下へずらす (クラス below-summary)。
      // サマリーの表示状態は #atlas-intensity の中身で判定し、次の
      // スナップショット適用で位置が追随する。
      const eewBoxOn = Boolean(eew?.payload?.render) && eewHorizontal;
      const summaryOn = Boolean(intensity && intensity.children.length > 0);
      let eewWindowMode = null;
      let eewWindowLines = null;
      if (eewBoxOn) {
        eewWindowMode = 'strip';
        eewWindowLines = [eewForecastDataLine(eew.payload.render, { omitHypocenter: true })];
      } else if (view.eewWindow && eewHorizontal) {
        eewWindowMode = 'window';
        eewWindowLines = view.eewWindow.lines;
      }
      const eewWindowKey = eewWindowMode
        ? `${eewWindowMode}:${eewWindowMode === 'strip' && summaryOn ? 'below' : 'top'}:${eewWindowLines.join('\n')}`
        : '';
      if (eewWindowKey !== lastEewWindow) {
        lastEewWindow = eewWindowKey;
        if (forecastWindowElement) {
          forecastWindowElement.replaceChildren();
          forecastWindowElement.className = eewWindowMode === 'strip'
            ? (summaryOn ? 'strip below-summary' : 'strip') : '';
          if (eewWindowMode) {
            eewWindowLines.forEach((text, index) => {
              const line = document.createElement('div');
              line.className = eewWindowMode === 'window' && index === 0 ? 'eew-forecast-line1' : 'eew-forecast-line2';
              line.textContent = text;
              forecastWindowElement.appendChild(line);
            });
            forecastWindowElement.style.display = 'block';
          } else {
            forecastWindowElement.style.display = 'none';
          }
        }
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
      const intensityJson = `${view.intensityEvent?.id}:${JSON.stringify(view.intensity)}:${JSON.stringify(view.summaryFrames)}:${JSON.stringify(view.longPeriodFrames)}:${JSON.stringify(view.tsunamiFrames)}:${view.display.earthquakeTelop !== false}`;
      if (intensityJson !== lastIntensity) {
        let next = { intensity: null, summaryFrames: [], longPeriodFrames: [] };
        if (view.tsunamiFrames.length) earthquakeInterruptedByTsunami = true;
        if (!view.tsunamiFrames.length && view.display.earthquakeTelop !== false && view.intensityEvent) {
          const time = Date.parse(view.intensityEvent.publishedAt || '') || 0;
          if (time >= latestEarthquakeTime) {
            next = earthquakeInterruptedByTsunami
              ? { intensity: view.intensity, summaryFrames: view.summaryFrames, longPeriodFrames: view.longPeriodFrames }
              : earthquakeDelta(view, previousEarthquake?.intensityEvent.id === view.intensityEvent.id ? previousEarthquake : null);
            latestEarthquakeTime = time;
            previousEarthquake = JSON.parse(JSON.stringify(view));
            earthquakeInterruptedByTsunami = false;
          }
        }
        earthquakePages = 0;
        // 津波の更新では最初から出し直さず、更新された区域だけを
        // 次のローテーションで流す (tsunamiDelta)。初回提示と、
        // 差分が空になる場合 (表示内容が変わらない更新) は全件出す。
        let tsunamiToShow = view.tsunamiFrames;
        if (view.tsunamiFrames.length) {
          const framesJson = JSON.stringify(view.tsunamiFrames);
          if (previousTsunamiFrames && framesJson !== previousTsunamiJson) {
            const delta = tsunamiDelta(view.tsunamiFrames, previousTsunamiFrames);
            if (delta.length) tsunamiToShow = delta;
          }
          previousTsunamiFrames = view.tsunamiFrames;
          previousTsunamiJson = framesJson;
        } else {
          previousTsunamiFrames = null;
          previousTsunamiJson = '';
        }
        showIntensity(next.intensity, next.summaryFrames, tsunamiToShow, next.longPeriodFrames);
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

  return { composeAtlasView, staleSources, install, syncTsunamiBlinkClock, eewVisibility, eewDisplayMode, eewForecastWindowLines, eewForecastDataLine, earthquakeDelta, tsunamiDelta, tsunamiHeightData, tsunamiArrivalData, tsunamiForecastValues, longPeriodPages };
});

if (typeof document !== 'undefined') AtlasLive.install(globalThis.ATLAS_INITIAL_STATE);
