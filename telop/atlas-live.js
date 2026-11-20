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
    const oldLongPeriod = new Set((previous.longPeriodFrames || []).map((frame) => JSON.stringify(frame)));
    return {
      ...current,
      intensity: { ...current.intensity, cityGroups: groups, groups },
      summaryFrames: current.summaryFrames.flatMap((frame, index) => {
        const lines = frame.lines || [];
        const previousLines = (previous.summaryFrames[index] || {}).lines || [];
        const previousSet = new Set(previousLines);
        const added = lines.filter((line) => !previousSet.has(line));
        if (!added.length) return [];
        // 行が純粋に追加されただけなら追加行だけを流す。行が差し替わった
        // フレームを一部だけ出すと文脈のない断片になるので、丸ごと出す。
        const pureAppend = previousLines.every((line) => lines.includes(line));
        return [{ ...frame, lines: pureAppend ? added : lines }];
      }),
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

  // EEW の表示基準 (2026-11-15 本番運用モード。ユーザー決定)。予想
  // 最大震度を問わず全件表示する: 予報級は地図を出さず角丸・半透明
  // ウィンドウの2行テキスト、警報級は地図つきボックスで出す。震度は
  // 内部表記 ('5-' = 5弱など)、「不明」は maxInt が null。Node 側の
  // 正本は lib/eewAnnounce.js の eewDisplayMode で、ページへ埋め込ま
  // れるこのファイルは require できないため同じ判定をここにも持つ
  // (変更時は両方揃える)。Discord bot の投稿基準 (予想最大震度が
  // 不明・4以上のときだけ投稿) は lib/eewAnnounce.js 側だけの判定で、
  // こちらの表示基準とは別物なので混同しないこと。

  // render の出し方: 'box' = 警報級 (地図つきボックス)、'window' =
  // 予報級 (ウィンドウの2行テキストのみ)。
  // isWarning が記録されていない旧形式の render は従来どおり 'box'。
  function eewDisplayMode(render) {
    if (!render || render.isWarning !== false) return 'box';
    return 'window';
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
    const title = render.isFinal
      ? '緊急地震速報(予報)[最終報]'
      : Number.isFinite(serial) && serial > 0
      ? `緊急地震速報(予報)[第${serial}報]` : '緊急地震速報(予報)';
    return [`${render.training ? '【訓練】' : ''}${title}`, eewForecastDataLine(render)];
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
    // EEW は級で出し分ける: 警報級はボックス用 (eew)、予報級は
    // ウィンドウ用 (eewWindow)。同時にある場合は両方を返す。
    const eewEntries = newestFirst(snapshot.layers.eew.filter((entry) => entry.action !== 'cancel'));
    const eew = eewEntries.find((entry) => eewDisplayMode(entry.payload?.render) === 'box') || null;
    const eewWindowEntry = eewEntries.find((entry) => eewDisplayMode(entry.payload?.render) === 'window') || null;
    const eewWindowRender = eewWindowEntry ? { ...eewWindowEntry.payload?.render, training: eewWindowEntry.event.training === true || eewWindowEntry.payload?.render?.training === true } : null;
    const eewWindow = eewWindowRender ? { lines: eewForecastWindowLines(eewWindowRender), hypocenterName: eewWindowRender.hypocenterName || '', hypocenterReading: eewWindowRender.hypocenterReading || '' } : null;
    const tsunami = { major: new Set(), warning: new Set(), advisory: new Set() };
    const tsunamiFrames = (snapshot.notices || []).filter((notice) => notice.kind === 'tsunami').map((notice) => ({ level: 'notice', label: notice.payload.notice, ...(notice.event?.training ? { training: true } : {}) }));
    // 提示順序はイベントごとに「地名一覧 → 変更 → 津波観測 → 各地域の詳細」。
    tsunamiFrames.push(...newestFirst(snapshot.layers.tsunami).flatMap((entry) => [
      ...(entry.payload?.tsunamiOverviewFrames || []),
      ...(entry.payload?.tsunamiChangeFrames || []),
      ...(entry.payload?.tsunamiObservationFrames || []),
      ...(entry.payload?.tsunamiFrames || []),
    ].map((frame) => ({
      ...frame, ...(entry.event.training ? { training: true } : {}), updateKey: `${entry.event.id}:${entry.event.serial || 0}:${entry.event.publishedAt || ''}:${frame.change ? `change:${frame.oldLevel}:${frame.newLevel}` : frame.level}:${frame.area || frame.station || ''}:${frame.height || frame.heightLabel || ''}:${frame.arrival || frame.timeLabel || ''}`,
    }))));
    for (const entry of snapshot.layers.tsunami) {
      for (const key of Object.keys(tsunami)) for (const area of entry.payload?.render?.[key] || []) tsunami[key].add(area);
    }
    const intensityEvents = newestFirst(snapshot.layers.intensity.filter((entry) => intensityAtLeastOne(entry.payload?.render))).slice(0, 1);
    const training = intensityEvents[0]?.event.training === true;
    const trainingData = training ? { training: true } : {};
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
      intensity: intensityEvents[0] ? { ...intensityEvents[0].payload?.render, ...trainingData } : null,
      intensityEvent: intensityEvents[0]?.event || null,
      summaryFrames: (intensityEvents[0]?.payload?.summaryFrames || []).map((frame) => ({ ...frame, ...trainingData })),
      longPeriodFrames: (intensityEvents[0]?.payload?.longPeriodFrames || []).map((frame) => ({ ...frame, ...trainingData })),
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
  // 訓練時は先頭バッジが【訓練】分だけ広がり、22字では右端が切れる
  // (2026-11-19 実レイアウト計測)。訓練時は20字に狭める。
  const LONG_PERIOD_LINE_CHARACTERS = 20;
  const LONG_PERIOD_LINE_CHARACTERS_TRAINING = 18;

  function longPeriodPages(lpFrames) {
    const pages = [];
    for (const frame of lpFrames || []) {
      if (frame.type === 'heading' || frame.type === 'note') {
        pages.push({ type: frame.type, lines: frame.lines || [], ...(frame.training ? { training: true } : {}) });
        continue;
      }
      const maxCharacters = frame.training
        ? LONG_PERIOD_LINE_CHARACTERS_TRAINING : LONG_PERIOD_LINE_CHARACTERS;
      const chunks = [];
      let chunk = [];
      let characters = 0;
      for (const name of frame.names || []) {
        const length = [...name].length + (chunk.length ? 1 : 0);
        if (chunk.length && characters + length > maxCharacters) {
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
          ...(frame.training ? { training: true } : {}),
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
    let rotationCycles = 0;
    let rotationKey = null;
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

    function labelTrainingEew(training) {
      if (!training) return;
      const boxHeadline = document.getElementById('headline');
      const verticalHeadline = document.getElementById('v-headline');
      for (const element of [boxHeadline, verticalHeadline]) {
        if (element && element.textContent && !element.textContent.startsWith('【訓練】')) {
          element.textContent = `【訓練】${element.textContent}`;
          if (typeof root.fitHeadline === 'function' && element === boxHeadline) root.fitHeadline(element);
        }
      }
    }

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
        // 予報級ウィンドウは EEW ボックスの中央寄せに追随しない。震度情報
        // テロップと同じ左端・同じ幅で固定する (CSS の #eew-forecast-window)。
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

    // 札にはルビを振らない (ルビは地域を表す固有名詞にだけ付ける)。
    // 札の中身は CSS 側で上下中央に置く (build_atlas.py が正本)。
    function setBadgeLabel(badge, text, suffix = '') {
      const label = document.createElement('span');
      label.className = 'atlas-badge-text';
      label.textContent = text + suffix;
      badge.append(label);
    }

    // 震度札の色は気象庁「気象情報の配色に関する設定指針」(令和2年改訂)
    // 表2-2の震度階級色で、背景色が震度ごとに決まる動的仕様。札自体に
    // 枠は付けず、明るい背景の札は黒文字にする (ユーザー決定)。文字の
    // 縁取りは CSS 側で付ける (2026-11-19 ユーザー決定)。
    // CSS 側に固定色は持たず、ここからインラインで付ける。
    const INTENSITY_BADGE_STYLES = {
      '1': { background: '#f2f2ff', color: '#111' },
      '2': { background: '#00aaff', color: '#fff' },
      '3': { background: '#0041ff', color: '#fff' },
      '4': { background: '#fae696', color: '#111' },
      '5-': { background: '#ffe600', color: '#111' },
      '5+': { background: '#ff9900', color: '#fff' },
      '6-': { background: '#ff2800', color: '#fff' },
      '6+': { background: '#a50021', color: '#fff' },
      '7': { background: '#b40068', color: '#fff' },
    };

    // 長周期の階級札の色 (気象庁検討会資料の素案カラー)。背景色は
    // 階級ごとに決まる。札自体に枠は付けず、明るい背景の札 (階級1, 2) は
    // 黒文字・縁取りなしにする (ユーザー決定)。現象札「長周期地震動」の色は CSS 側。
    const LONG_PERIOD_CLASS_STYLES = {
      '1': { background: '#faf500', color: '#111' },
      '2': { background: '#ff9900', color: '#111' },
      '3': { background: '#ff4b00', color: '#fff' },
      '4': { background: '#ff2800', color: '#fff' },
    };

    function showIntensity(data, summaryFrames = [], tsunamiFrames = [], longPeriodFrames = [], nextRotationKey = '') {
      if (!intensity) return;
      if (nextRotationKey === rotationKey) return;
      if (lineTimer) clearInterval(lineTimer);
      lineTimer = null;
      lineIndex = 0;
      rotationCycles = 0;
      rotationKey = nextRotationKey;
      intensity.replaceChildren();
      const usingCityGroups = Boolean(data?.cityGroups && Object.keys(data.cityGroups).length);
      const groups = usingCityGroups ? data.cityGroups : data?.groups;
      const levels = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
      const labels = { '6+': '6強', '6-': '6弱', '5+': '5強', '5-': '5弱' };
      // 震度行の地名列は1行22字まで (区切り含む)。丸縁・字間 (0.06em /
      // 0.08em) 適用後のレイアウト幅 1459.2px に対する実データ検証で
      // はみ出し 0 件になる上限。
      const rows = [];
      for (const level of levels) {
        let names = [];
        let characters = 0;
        for (const name of groups?.[level] || []) {
          const length = [...name].length + (names.length ? 1 : 0);
          if (names.length && characters + length > 22) {
            rows.push({ level, names, first: !rows.some((row) => row.level === level) });
            names = [];
            characters = 0;
          }
          names.push(name);
          characters += [...name].length + (names.length > 1 ? 1 : 0);
        }
        if (names.length) rows.push({ level, names, first: !rows.some((row) => row.level === level) });
      }
      // 提示順序は「地名一覧 → 変更 → 津波観測 → 各地域の詳細」。一覧 (overview) は全区域を
      // 種別ごとにまとめて先に並べる。詳細側は、高さ・到達のどちらか
      // 片方でもデータのある区域だけにし、両方ない区域は一覧のみに
      // 現れる (PR #51 の注意報集約は一覧へ置き換えた)。データ有無は
      // フォールバック文言ではなく実データで判定する。
      const tsunamiDisplayFrames = [];
      for (const frame of tsunamiFrames) {
        if (frame.level === 'notice' || frame.overview || frame.change || frame.grouped || frame.observation
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
        if (rotationCycles >= 2) {
          clearInterval(lineTimer);
          lineTimer = null;
          return;
        }
        if (tsunamiFrames.length) {
          const frame = tsunamiDisplayFrames[lineIndex];
          if (frame.level === 'notice') {
            const notice = document.createElement('div');
            notice.className = 'atlas-summary-line';
            notice.textContent = frame.label;
            intensity.appendChild(notice);
            lineIndex = (lineIndex + 1) % pageCount;
            if (lineIndex === 0) rotationCycles += 1;
            return;
          }
          if (frame.observation) {
            // 津波観測: 1行目が紫札「津波観測」+観測点名、2行目が
            // 時刻+高さ (最大波の実測、無い間は第1波の到達)。
            // 2行目は不可視の札で桁位置を1行目の地点名に揃える。
            const line1 = document.createElement('div');
            line1.className = 'atlas-tsunami-line atlas-tsunami-observation';
            const badge = document.createElement('span');
            badge.className = 'atlas-tsunami-badge atlas-tsunami-observation-badge';
            setBadgeLabel(badge, '津波観測');
            const name = document.createElement('span');
            name.className = 'atlas-tsunami-text';
            appendNameWithRuby(name, frame.station, frame.readings?.[frame.station], frame.monoReadings?.[frame.station]);
            line1.append(badge, name);
            const line2 = document.createElement('div');
            line2.className = 'atlas-tsunami-line atlas-tsunami-observation';
            const spacer = document.createElement('span');
            spacer.className = 'atlas-tsunami-badge atlas-tsunami-observation-badge atlas-tsunami-observation-spacer';
            setBadgeLabel(spacer, '津波観測');
            const values = document.createElement('span');
            values.className = 'atlas-tsunami-text';
            values.textContent = `${frame.timeLabel}　${frame.heightLabel}`;
            line2.append(spacer, values);
            intensity.append(line1, line2);
            lineIndex = (lineIndex + 1) % pageCount;
            if (lineIndex === 0) rotationCycles += 1;
            return;
          }
          if (frame.change) {
            const heading = document.createElement('div');
            heading.className = 'atlas-summary-line';
            heading.textContent = frame.headline;
            const areas = document.createElement('div');
            areas.className = 'atlas-tsunami-line atlas-tsunami-change';
            for (const [index, name] of (frame.areas?.length ? frame.areas : [frame.area]).entries()) {
              if (index) areas.append('　');
              appendNameWithRuby(areas, name, frame.readings?.[name], frame.monoReadings?.[name]);
            }
            intensity.append(heading, areas);
            lineIndex = (lineIndex + 1) % pageCount;
            if (lineIndex === 0) rotationCycles += 1;
            return;
          }
          const category = document.createElement('div');
          category.className = `atlas-tsunami-line atlas-tsunami-${frame.level}`;
          const badge = document.createElement('span');
          badge.className = 'atlas-tsunami-badge';
          setBadgeLabel(badge, `${frame.training ? '【訓練】' : ''}${frame.label}`);
          // 札の色は気象庁「気象情報の配色に関する設定指針」(令和2年
          // 改訂) 表1-2 (台風・津波・噴火等の情報) の津波警報等の色
          // (protocol/overlay-fixed.md の色対応表)。札自体に枠は
          // 付けず、明るい背景の注意報札は黒文字にする。
          const style = {
            major: { background: '#c800ff', color: '#fff' },
            warning: { background: '#ff2800', color: '#fff' },
            advisory: { background: '#faf500', color: '#111' },
          };
          const badgeStyle = style[frame.level] || style.warning;
          badge.style.backgroundColor = badgeStyle.background;
          badge.style.color = badgeStyle.color;
          if (badgeStyle.color === '#111') badge.className += ' atlas-badge-no-outline';
          category.appendChild(badge);
          if (frame.additional) {
            const addition = document.createElement('span');
            addition.className = 'atlas-tsunami-additional';
            addition.textContent = '追加';
            category.appendChild(addition);
          }
          const area = document.createElement('span');
          area.className = 'atlas-tsunami-text';
          // 地域を表す固有名詞は全てルビを付ける (津波の区域名も対象)。
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
          for (const [index, text] of (earthquakeFrames[lineIndex].lines || []).entries()) {
            if (!text) continue;
            const line = document.createElement('div');
            line.className = 'atlas-summary-line';
            const frame = earthquakeFrames[lineIndex];
            const trainingPrefix = frame.training && index === 0 ? '【訓練】' : '';
            if (index === 0 && frame.hypocenterName && frame.hypocenterReading
              && text === `震源は${frame.hypocenterName}`) {
              line.append(trainingPrefix, '震源は');
              appendNameWithRuby(line, frame.hypocenterName, frame.hypocenterReading);
            } else line.textContent = `${trainingPrefix}${text}`;
            intensity.appendChild(line);
          }
        } else if (lineIndex < earthquakeFrames.length + lpPages.length) {
          const page = lpPages[lineIndex - earthquakeFrames.length];
          if (page.type === 'heading' || page.type === 'note') {
            for (const [index, text] of (page.lines || []).entries()) {
              if (!text) continue;
              const line = document.createElement('div');
              line.className = 'atlas-summary-line';
              line.textContent = `${page.training && index === 0 ? '【訓練】' : ''}${text}`;
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
              setBadgeLabel(badge, `${page.training && offset === 0 ? '【訓練】' : ''}長周期地震動`);
              const classBadge = document.createElement('span');
              classBadge.className = 'atlas-longperiod-class-badge';
              setBadgeLabel(classBadge, '階級', String(page.level));
              const classStyle = LONG_PERIOD_CLASS_STYLES[page.level];
              if (classStyle) {
                classBadge.style.backgroundColor = classStyle.background;
                classBadge.style.color = classStyle.color;
                if (classStyle.color === '#111') classBadge.className += ' atlas-badge-no-outline';
              }
              if (!showBadges) {
                badge.classList.add('atlas-longperiod-continuation');
                classBadge.classList.add('atlas-longperiod-continuation');
              }
              const names = document.createElement('span');
              names.className = 'atlas-longperiod-names';
              // 地域を表す固有名詞は全てルビを付ける (観測点名も対象。
              // 行割りの文字数カウントは従来どおり地名の文字数で行う)。
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
            if (showBadge) {
              setBadgeLabel(badge, `${data?.training && showBadge ? '【訓練】' : ''}震度`, String(labels[row.level] || row.level));
              const badgeStyle = INTENSITY_BADGE_STYLES[row.level];
              if (badgeStyle) {
                badge.style.backgroundColor = badgeStyle.background;
                badge.style.color = badgeStyle.color;
                if (badgeStyle.color === '#111') badge.className += ' atlas-badge-no-outline';
              }
            } else badge.textContent = '';
            const areas = document.createElement('span');
            areas.className = 'atlas-intensity-areas';
            // 地域を表す固有名詞は全てルビを付ける。市区町村名
            // (cityGroups) でも細分区域名 (groups へのフォールバック)
            // でも同じに扱う。
            row.names.forEach((name, index) => {
              if (index) areas.append('　');
              appendNameWithRuby(areas, name, data.cityReadings?.[name], data.cityMonoReadings?.[name]);
            });
            line.append(badge, areas);
            intensity.appendChild(line);
          }
        }
        lineIndex = (lineIndex + 1) % pageCount;
        if (lineIndex === 0) rotationCycles += 1;
      };
      render();
      lineTimer = setInterval(render, 7500);
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
          const renderInput = { ...input, training: eew.event.training === true || input.training === true };
          if (eewHorizontal) {
            if (eewKey !== lastEew && lastEewHorizontal && lastEew?.startsWith(`${eew.event.id}:`) && typeof renderEEWUpdate === 'function') renderEEWUpdate(renderInput);
            else renderEEW(renderInput);
            labelTrainingEew(renderInput.training);
          } else eewElement?.classList.remove('on');
          if (eewVertical) {
            renderEEWVertical(renderInput);
            labelTrainingEew(renderInput.training);
          }
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
        const frameKey = (frame) => frame.updateKey || JSON.stringify(frame);
        const nextRotationKey = JSON.stringify({
          intensity: next.intensity,
          summaryFrames: next.summaryFrames,
          tsunamiFrames: tsunamiToShow.map(frameKey),
          longPeriodFrames: next.longPeriodFrames,
        });
        showIntensity(next.intensity, next.summaryFrames, tsunamiToShow, next.longPeriodFrames, nextRotationKey);
        lastIntensity = intensityJson;
      }

      // 予報級 EEW はボックスも地図も出さず、角丸・半透明
      // ウィンドウに2行テキストだけを出す。ウィンドウは画面上部に
      // 置く (クラス top)。警報級ボックスが出ている間は予報側の
      // データ (最大震度などのデータ行) を画面に描かないため、
      // ウィンドウ要素は隠す (ボックスは従来どおり表示する)。
      // ウィンドウは上部テロップと同じ上マージン・同じ左端に置き、
      // 上部テロップのサマリーが同時表示されているときはその帯の
      // 下へずらす (クラス below-summary)。サマリーの表示状態は
      // #atlas-intensity の中身で判定する。判定は帯の描き直し
      // (上の showIntensity) の後に行う。前のテロップが終了して
      // 帯が空の状態で続報が帯を再開させる適用では、描き直し前に
      // 判定すると「帯なし」となり、再開した帯の上にウィンドウが
      // 重なってしまうため。
      const eewBoxOn = Boolean(eew?.payload?.render) && eewHorizontal;
      const summaryOn = Boolean(intensity && intensity.children.length > 0);
      let eewWindowMode = null;
      let eewWindowLines = null;
      if (!eewBoxOn && view.eewWindow && eewHorizontal) {
        eewWindowMode = 'window';
        eewWindowLines = view.eewWindow.lines;
      }
      const eewWindowKey = eewWindowMode
        ? `${eewWindowMode}:${summaryOn ? 'below' : 'top'}:${eewWindowLines.join('\n')}`
        : '';
      if (eewWindowKey !== lastEewWindow) {
        lastEewWindow = eewWindowKey;
        if (forecastWindowElement) {
          forecastWindowElement.replaceChildren();
          const belowSummary = summaryOn ? ' below-summary' : '';
          forecastWindowElement.className = eewWindowMode === 'window' ? `top${belowSummary}` : '';
          if (eewWindowMode) {
            eewWindowLines.forEach((text, index) => {
              const line = document.createElement('div');
              line.className = eewWindowMode === 'window' && index === 0 ? 'eew-forecast-line1' : 'eew-forecast-line2';
              if (index === 1 && view.eewWindow.hypocenterName && view.eewWindow.hypocenterReading
                && text.startsWith(`${view.eewWindow.hypocenterName}で地震`)) {
                appendNameWithRuby(line, view.eewWindow.hypocenterName, view.eewWindow.hypocenterReading);
                line.append(text.slice(view.eewWindow.hypocenterName.length));
              } else line.textContent = text;
              forecastWindowElement.appendChild(line);
            });
            forecastWindowElement.style.display = 'block';
          } else {
            forecastWindowElement.style.display = 'none';
          }
        }
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
      root.ATLAS_RENDERED_SEQ = Number.isInteger(snapshot.seq) ? snapshot.seq : null;
      // 描画済みではなく「描き出された」seq。DOM更新だけでは画面は
      // 変わらないため、2回の rAF（= 描画フレームが実際に作られた後）
      // で確定する。capture 側はこの値を待って撮影する。
      root.ATLAS_PAINTED_SEQ = null;
      if (typeof root.requestAnimationFrame === 'function') {
        const paintedSeq = root.ATLAS_RENDERED_SEQ;
        root.requestAnimationFrame(() => {
          root.requestAnimationFrame(() => {
            if (root.ATLAS_RENDERED_SEQ === paintedSeq) root.ATLAS_PAINTED_SEQ = paintedSeq;
          });
        });
      } else {
        root.ATLAS_PAINTED_SEQ = root.ATLAS_RENDERED_SEQ;
      }
      return root.ATLAS_RENDERED_SEQ;
    }

    root.applyAtlasSnapshot = applyAtlasSnapshot;
    root.applyAtlasControls = applyControls;
    if (initialSnapshot) applyAtlasSnapshot(initialSnapshot);
    let renderQueue = Promise.resolve();
    const enqueueSnapshot = (snapshot) => {
      renderQueue = renderQueue.then(async () => {
        try {
          // capture 側が撮影中の間は適用を待つ。撮影と適用が重なると
          // 撮影した絵と seq の紐付けがずれる。500ms で打ち切り。
          if (root.ATLAS_CAPTURE_BUSY) {
            const busyDeadline = Date.now() + 500;
            while (root.ATLAS_CAPTURE_BUSY && Date.now() < busyDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          const renderedSeq = applyAtlasSnapshot(snapshot);
          root.ATLAS_SNAPSHOT_RECEIVED = true;
          if (typeof root.ATLAS_ON_RENDER === 'function') await root.ATLAS_ON_RENDER(renderedSeq);
        } catch (_) { /* Keep rendering later snapshots even if one snapshot fails. */ }
      });
      return renderQueue;
    };
    async function poll() {
      try {
        const response = await fetch(`atlas-state.json?t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) await enqueueSnapshot(await response.json());
      } catch (_) { /* Keep the last rendered snapshot while the state file is unavailable. */ }
      setTimeout(poll, 1000);
    }
    if (typeof EventSource !== 'undefined') {
      let eventSource;
      let reconnectTimer;
      const connectEvents = () => {
        eventSource = new EventSource('/atlas-state-events');
        eventSource.onmessage = (event) => {
          try {
            void enqueueSnapshot(JSON.parse(event.data));
          } catch (_) { /* Keep the last rendered snapshot for malformed events. */ }
        };
        eventSource.onerror = () => {
          eventSource.close();
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectEvents, 5000);
        };
      };
      connectEvents();
    }
    poll();
  }

  return { composeAtlasView, staleSources, install, syncTsunamiBlinkClock, eewVisibility, eewDisplayMode, eewForecastWindowLines, eewForecastDataLine, earthquakeDelta, tsunamiDelta, tsunamiHeightData, tsunamiArrivalData, tsunamiForecastValues, longPeriodPages };
});

if (typeof document !== 'undefined') AtlasLive.install(globalThis.ATLAS_INITIAL_STATE);
