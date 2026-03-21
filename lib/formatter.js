const COLORS = {
  MAJOR_TSUNAMI: '#ff00ff',
  TSUNAMI_WARNING: '#FF2800',
  TSUNAMI_ADVISORY: '#FAF500',
};

const INTENSITY_MAP = {
  7: '7',
  '6+': '6強',
  '6-': '6弱',
  '5+': '5強',
  '5-': '5弱',
  4: '4',
  3: '3',
  2: '2',
  1: '1',
};

function splitAreasHelper(label, areas, limit = 6, indent = '65px') {
  const lines = [];
  if (!areas || areas.length === 0) return lines;
  for (let i = 0; i < areas.length; i += limit) {
    const chunk = areas.slice(i, i + limit);
    if (chunk.length > 3) {
      // 3件目以降を <indent=...> で囲って改行
      const firstPart = chunk.slice(0, 3).join('\u00A0');
      const secondPart = chunk.slice(3).join('\u00A0');
      lines.push(`${label}\u00A0${firstPart}\n<indent=${indent}>${secondPart}</indent>`);
    } else {
      lines.push(`${label}\u00A0${chunk.join('\u00A0')}`);
    }
  }
  return lines;
}

function formatEarthquake(eq) {
  const lines = [];
  lines.push('<align="center">地震情報');
  const timeStr = eq.originTimeFormatted ? `${eq.originTimeFormatted}ごろ ` : '';

  // 1. 発生時刻と発生通知
  lines.push(`${timeStr}地震がありました`);

  // 2. 津波情報 (最優先)
  let comment = (eq.comment || '')
    .replace('この地震について、緊急地震速報を発表しています。', '')
    .replace('を発表中です。', 'が発表されています ')
    .replace('。', '\n');

  if (eq.infoKind === '震度速報') {
    comment = '揺れが強かった沿岸部では\n念のため津波に注意してください';
  }
  if (comment) lines.push(comment);

  // 3. 震源情報
  const eqInfo = eq.earthquake;
  if (eqInfo && eqInfo.hypocenter) {
    const magNum = parseFloat(eqInfo.magnitude);
    const magStr = isNaN(magNum) ? eqInfo.magnitudeDescription || '不明' : `マグニチュード${magNum.toFixed(1)}`;

    const depthMatch = eqInfo.hypocenter?.coordinate?.match(/-(\d+)\/$/);
    const depth = depthMatch ? `${parseInt(depthMatch[1]) / 1000}キロ` : '不明';
    lines.push(`震源は${eqInfo.hypocenter.name}\n深さ${depth}  ${magStr}`);
  }

  // 4. 震度情報
  if (eq.intensity && eq.intensity.maxInt) {
    // 市町村レベルの表示を優先する
    const targetGroups = eq.intensity.cityGroups && Object.keys(eq.intensity.cityGroups).length > 0 ? eq.intensity.cityGroups : eq.intensity.groups;

    const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
    intensityOrder.forEach((int) => {
      const areas = targetGroups?.[int];
      if (areas && areas.length > 0) {
        const intStr = INTENSITY_MAP[int] || int;
        const label = `<u>震度${intStr}</u>`;
        const indent = intStr.includes('弱') || intStr.includes('強') ? '65px' : '50px';
        lines.push(...splitAreasHelper(label, areas, 6, indent));
      }
    });
  }

  let type = 'emergency';
  const maxInt = eq.intensity?.maxInt;
  if (maxInt) {
    const maxIntStr = String(maxInt);
    if (maxIntStr === '1') type = 'earthquake_1';
    else if (maxIntStr === '2') type = 'earthquake_2';
    else if (maxIntStr === '3') type = 'earthquake_3';
    else if (maxIntStr === '4') type = 'earthquake_4';
    // 5-, 5+, 6-, 6+, 7 は "emergency" のまま
  } else {
    // 震源情報のみなどの場合を考慮
    type = 'earthquake';
  }

  return {
    type: type,
    id: eq.eventId,
    lines: lines,
  };
}

function formatTsunami(ts) {
  const lines = [];
  const groups = ts.tsunami.groups;

  if (groups.majorTsunami.length > 0) {
    const label = `<color=${COLORS.MAJOR_TSUNAMI}>【大津波警報】</color>`;
    lines.push(...splitAreasHelper(label, groups.majorTsunami));
  }
  if (groups.warning.length > 0) {
    const label = `<color=${COLORS.TSUNAMI_WARNING}>【津波警報】</color>`;
    lines.push(...splitAreasHelper(label, groups.warning));
  }
  if (groups.advisory.length > 0) {
    const label = `<color=${COLORS.TSUNAMI_ADVISORY}>【津波注意報】</color>`;
    lines.push(...splitAreasHelper(label, groups.advisory));
  }

  lines.push('');

  // 津波タイトルの動的変更
  let tsunamiTitle = '津波注意報';
  if (groups.majorTsunami.length > 0) {
    tsunamiTitle = '大津波警報';
  } else if (groups.warning.length > 0) {
    tsunamiTitle = '津波警報';
  }

  lines.push(`${tsunamiTitle}が出ている各沿岸の\n津波到達予想は次のとおりです`);

  ts.tsunami.forecasts.forEach((f) => {
    let color = '';
    const kindCode = String(f.category.code);
    if (['52', '53'].includes(kindCode)) color = COLORS.MAJOR_TSUNAMI;
    else if (['51'].includes(kindCode)) color = COLORS.TSUNAMI_WARNING;
    else if (['62'].includes(kindCode)) color = COLORS.TSUNAMI_ADVISORY;

    if (color) {
      const time = f.formattedArrivalTime || f.firstHeight?.condition || '不明';
      lines.push(`<color=${color}>【${f.category.kind}】</color>${f.area.name}\n【予想】 ${f.maxHeight} ${time}`);
    }
  });

  // 震度情報の追加 (VTSEに含まれる場合)
  if (ts.intensity && ts.intensity.maxInt) {
    lines.push('');
    lines.push('この地震による各地の震度は次のとおりです');

    const targetGroups = ts.intensity.cityGroups && Object.keys(ts.intensity.cityGroups).length > 0 ? ts.intensity.cityGroups : ts.intensity.groups;

    const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
    intensityOrder.forEach((int) => {
      const areas = targetGroups?.[int];
      if (areas && areas.length > 0) {
        const intStr = INTENSITY_MAP[int] || int;
        const label = `<u>震度${intStr}</u>`;
        const indent = intStr.includes('弱') || intStr.includes('強') ? '65px' : '50px';
        lines.push(...splitAreasHelper(label, areas, 6, indent));
      }
    });
  }

  return {
    type: 'emergency',
    id: ts.eventId,
    lines: lines,
  };
}

function formatWeather(weather) {
  const lines = [];

  let title = weather.title || '気象情報';
  const hl = weather.headline || '';
  let baseColor = '#FFFFFF';

  // 重要キーワードを抽出
  const isSpecial = title.includes('特別警報') || hl.includes('特別警報');
  const isLinearRainband = title.includes('顕著な大雨') || hl.includes('線状降水帯');

  if (isSpecial) {
    baseColor = '#ff00ff'; // マゼンタ
    if (!title.includes('特別警報')) title = `【特別警報】${title}`;
  } else if (isLinearRainband) {
    baseColor = '#FF2800'; // 赤
    title = `【線状降水帯】${title}`;
  }

  lines.push(`<color=${baseColor}>${title}</color>`);

  // グループごとの詳細表示 (【警報名】 市町村名 市町村名...)
  if (weather.groups && weather.groups.length > 0) {
    for (const group of weather.groups) {
      let color = '#FFFFFF';
      if (group.kind.includes('特別警報')) color = '#ff00ff';
      else if (group.kind.includes('警報') || group.kind.includes('土砂災害')) color = '#FF2800';
      else if (group.kind.includes('注意報')) color = '#FFFF00';
      else if (group.kind.includes('記録的短時間大雨')) color = '#FFFF00';

      const prefix = `<u><color=${color}>【${group.kind}】</color></u>`;

      // 市町村名を適切に改行しながら連結 (1行6件程度)
      const areaLines = splitAreasHelper('', group.areas || [], 6); // Pass empty string as label for splitAreasHelper
      areaLines.forEach((areaLine, idx) => {
        if (idx === 0) {
          lines.push(prefix + areaLine);
        } else {
          lines.push(' '.repeat(prefix.length + 1) + areaLine.trimStart()); // Indent to align with the first line's content
        }
      });
    }
  } else if (hl) {
    // 詳細グループがない場合は見出し文を表示
    let displayHl = hl;
    if (displayHl.includes('線状降水帯')) {
      displayHl = displayHl.replace('線状降水帯', '<color=#FF2800>線状降水帯</color>');
    }
    lines.push(displayHl);
  }

  return {
    type: 'weather',
    id: Date.now(),
    lines: lines,
  };
}

module.exports = {
  formatEarthquake,
  formatTsunami,
  formatWeather,
};
