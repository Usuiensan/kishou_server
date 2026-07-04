const COLORS = {
  MAJOR_TSUNAMI: '#ff00ff',
  TSUNAMI_WARNING: '#FF2800',
  TSUNAMI_ADVISORY: '#FAF500',
};

const { getFormattedMaxIntensityRegion } = require('./utils/regions');

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

const INTENSITY_RANK = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  '5-': 5,
  '5+': 6,
  '6-': 7,
  '6+': 8,
  7: 9,
};

function createLineObjects(lines, firstLineDuration = 7.5) {
  return lines.map((line, index) => {
    // 最初の行は指定された時間、それ以外は一律 7.5 秒
    const duration = index === 0 ? firstLineDuration : 7.5;
    return { text: line, duration: duration };
  });
}

function formatEarthquake(eq) {
  // EEW (緊急地震速報) の特殊処理
  if (eq.isEEW) {
    // 予報は送出しない（警報または取消のみ）
    if (!eq.isWarning && eq.infoType !== '取消') {
      return null;
    }

    let title = '<color=#FF2800>【緊急地震速報】</color>';
    if (eq.headTitle?.includes('警報') || eq.title?.includes('警報')) {
      title = '<color=#FF2800>【緊急地震速報（警報）】</color>';
    } else if (eq.headTitle?.includes('予報') || eq.title?.includes('予報')) {
      title = '<color=#FF2800>【緊急地震速報（予報）】</color>';
    }

    if (eq.infoType === '取消') {
      return {
        type: 'eew',
        id: eq.eventId,
        isEEW: true,
        lines: createLineObjects([`<align="center">${title}（取消）\n<align="left">先ほどの緊急地震速報は取り消されました。`], 60.0),
      };
    }

    // 通常のEEW（発表・更新）
    // ユーザー要望に合わせてタイトルに全角スペースを付与
    const displayTitle = `${title}　`;
    const headline = eq.headline.replace(/地震\s+/, '地震 ').replace(/。$/, '');
    const areas = eq.eewAreas && eq.eewAreas.length > 0 ? eq.eewAreas.map((a) => `<nobr>${a}</nobr>`).join('  ') : '';
    const packedText = `<align="center" vspace=0.5em>${displayTitle}\n<align="left" vspace=0.5em>${headline}\n${areas}`;

    return {
      type: 'eew',
      id: eq.eventId,
      isEEW: true,
      lines: createLineObjects([packedText], 60.0),
    };
  }

  const lines = [];
  lines.push('<align="center">地震情報');
  const timeStr = eq.originTimeFormatted ? `${eq.originTimeFormatted}ごろ ` : '';
  // 1. 発生時刻と発生通知 (最も震度の大きい地方名で)
  const maxInt = eq.intensity?.maxInt;
  if (maxInt && !isIntensityAtLeast(maxInt, '4') && !eq.lgIntensity?.maxLgInt) {
    return null;
  }
  const maxAreas = eq.intensity?.groups?.[maxInt] || [];
  const regionStr = getFormattedMaxIntensityRegion(maxAreas);
  const regionPrefix = regionStr ? `${regionStr}で` : '';
  lines.push(`${timeStr}${regionPrefix}\n地震がありました`);

  // 2. 津波情報 (最優先)
  let comment = (eq.comment || '')
    .replace('この地震について、緊急地震速報を発表しています。', '')
    .replace('を発表中です。', 'が発表されています ')
    .replace('。', '\n');

  if (eq.infoKind === '震度速報') {
    comment = '揺れの強かった沿岸部では\n念のため津波に注意してください';
  }
  if (comment) lines.push(comment);

  // 3. 震源情報
  const eqInfo = eq.earthquake;
  if (eqInfo && eqInfo.hypocenter) {
    const magNum = parseFloat(eqInfo.magnitude);
    const magStr = isNaN(magNum) ? eqInfo.magnitudeDescription || '不明' : `マグニチュード${magNum.toFixed(1)}`;

    // 震源の深さの抽出
    let depth = '不明';
    const desc = eqInfo.hypocenter.description || '';
    if (desc.includes('ごく浅い')) {
      depth = 'ごく浅い';
    } else if (desc.includes('深さ不明') || desc.includes('震源要素不明')) {
      depth = '不明';
    } else if (desc.includes('深さ')) {
      const descMatch = desc.match(/深さ(?:は)?\s*([0-9０-９]+)ｋｍ(以上)?/);
      if (descMatch) {
        const kmBase = descMatch[1].replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
        depth = `${kmBase}キロ${descMatch[2] || ''}`;
      }
    }

    if (depth === '不明') {
      const depthMatch = eqInfo.hypocenter?.coordinate?.match(/[+-](\d+)\/$/);
      if (depthMatch) {
        const depthVal = parseInt(depthMatch[1]);
        depth = depthVal === 0 ? 'ごく浅い' : `${depthVal / 1000}キロ`;
      }
    }

    // すべて「不明」の場合はこの行を表示しない
    const isNameUnknown = !eqInfo.hypocenter.name || eqInfo.hypocenter.name === '不明';
    const isDepthUnknown = depth === '不明';
    const isMagUnknown = magStr === '不明' || magStr === 'Ｍ不明' || magStr === 'マグニチュード不明';

    if (!(isNameUnknown && isDepthUnknown && isMagUnknown)) {
      lines.push(`震源は${eqInfo.hypocenter.name}\n深さ${depth}  ${magStr}`);
    }
  }

  // 4. 震度情報
  if (eq.intensity && eq.intensity.maxInt) {
    const targetGroups = eq.intensity.cityGroups && Object.keys(eq.intensity.cityGroups).length > 0 ? eq.intensity.cityGroups : eq.intensity.groups;

    const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
    intensityOrder.forEach((int) => {
      const areas = targetGroups?.[int];
      if (areas && areas.length > 0) {
        const intStr = INTENSITY_MAP[int] || int;
        const label = `<u>震度${intStr}</u>`;
        const indent = '5em';
        lines.push(...splitAreasHelper(label, areas, 6, indent));
      }
    });
  }

  // 4b. 長周期地震動情報
  if (eq.lgIntensity && eq.lgIntensity.maxLgInt) {
    const timeBase = eq.originTimeFormatted || '';
    lines.push(`${timeBase}の地震により\n長周期地震動を観測しました`);
    lines.push('高層のビルやタワーで大きな揺れが\n長く続いた可能性があります');

    const lgIntensityOrder = ['4', '3', '2', '1'];
    lgIntensityOrder.forEach((lgInt) => {
      const areas = eq.lgIntensity.groups?.[lgInt];
      if (areas && areas.length > 0) {
        const label = `【長周期地震動　階級${lgInt}】`;
        lines.push(...splitAreasWithLineBreakHelper(label, areas, 6, '12em'));
      }
    });
  }

  let type = 'earthquake';
  if (maxInt) {
    const maxIntStr = String(maxInt);
    if (maxIntStr === '1') type = 'earthquake_1';
    else if (maxIntStr === '2') type = 'earthquake_2';
    else if (maxIntStr === '3') type = 'earthquake_3';
    else if (maxIntStr === '4') type = 'earthquake_4';
    else if (maxIntStr === '5-') type = 'earthquake_5l';
    else if (maxIntStr === '5+') type = 'earthquake_5h';
    else if (maxIntStr === '6-') type = 'earthquake_6l';
    else if (maxIntStr === '6+') type = 'earthquake_6h';
    else if (maxIntStr === '7') type = 'earthquake_7';
  }

  return {
    type: type,
    id: eq.eventId,
    lines: createLineObjects(lines, 3.5),
  };
}

function splitAreasHelper(label, areas, limit = 6, indent = '6em') {
  const lines = [];
  if (!areas || areas.length === 0) return lines;

  const wrappedAreas = areas.map((a) => `<nobr>${a}</nobr>`);

  for (let i = 0; i < wrappedAreas.length; i += limit) {
    const chunk = wrappedAreas.slice(i, i + limit);
    const joined = chunk.join('    ');
    lines.push(`${label} <indent=${indent}>${joined}</indent>`);
  }
  return lines;
}

function splitAreasWithLineBreakHelper(label, areas, limit = 6, indent = '6em') {
  const lines = [];
  if (!areas || areas.length === 0) return lines;

  const wrappedAreas = areas.map((a) => `<nobr>${a}</nobr>`);

  for (let i = 0; i < wrappedAreas.length; i += limit) {
    const chunk = wrappedAreas.slice(i, i + limit);
    const joined = chunk.join('    ');
    lines.push(`${label}\n<indent=${indent}>${joined}</indent>`);
  }
  return lines;
}

function formatTsunami(ts) {
  const lines = [];
  const groups = ts.tsunami.groups;

  if (ts.title?.includes('沖合の津波観測') || ts.tsunami.offshoreObservations?.length > 0) {
    const headline = (ts.headline || '').replace(/＊+これは訓練です＊+\n?/g, '').trim();
    lines.push(`<color=${COLORS.TSUNAMI_WARNING}>【沖合で津波観測】</color>\n${headline || '沖合で津波を観測しました'}`);

    ts.tsunami.offshoreObservations.forEach((observation) => {
      const height = observation.maxHeight?.description || formatMeterHeight(observation.maxHeight?.value) || '不明';
      const time = observation.maxHeight?.formattedDateTime || '時刻不明';
      lines.push(`【観測】<nobr>${observation.name}</nobr>\n最大 ${height}  ${time}`);
    });

    const warningComment = ts.warningComment || ts.comment;
    if (ts.tsunami.estimations?.length > 0) {
      lines.push(warningComment || '沖合での観測値です\n沿岸では津波がさらに高くなるおそれがあります');
      ts.tsunami.estimations.forEach((estimation) => {
        const height = estimation.maxHeight?.description || formatMeterHeight(estimation.maxHeight?.value) || '不明';
        const time = estimation.firstHeight?.condition || estimation.firstHeight?.formattedArrivalTime || '不明';
        lines.push(`【推定】<nobr>${estimation.area.name}</nobr>\n高さ ${height}  ${time}`);
      });
    } else if (warningComment) {
      lines.push(warningComment);
    }

    return {
      type: 'tsunami_warning',
      id: ts.eventId,
      lines: createLineObjects(lines, 10.0),
    };
  }

  if (groups.majorTsunami.length > 0) {
    const label = `<color=${COLORS.MAJOR_TSUNAMI}>【大津波警報】</color>`;
    lines.push(...splitAreasHelper(label, groups.majorTsunami, 6, '7em'));
  }
  if (groups.warning.length > 0) {
    const label = `<color=${COLORS.TSUNAMI_WARNING}>【津波警報】</color>`;
    lines.push(...splitAreasHelper(label, groups.warning, 6, '7em'));
  }
  if (groups.advisory.length > 0) {
    const label = `<color=${COLORS.TSUNAMI_ADVISORY}>【津波注意報】</color>`;
    lines.push(...splitAreasHelper(label, groups.advisory, 6, '7em'));
  }

  lines.push('');

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
      const kind = f.category.kind.replace(/[：:](発表|引き上げ)$/, '  追加');
      let time = f.formattedArrivalTime || '不明';
      if (f.firstHeight?.condition) {
        if (['ただちに津波来襲と予測', '津波到達中と推測', '第１波の到達を確認'].includes(f.firstHeight.condition) || time === '不明') {
          time = f.firstHeight.condition;
        }
      }
      time = time.replace('ただちに津波来襲と予測', 'すぐ来る').replace('津波到達中と推測', '到達か');
      lines.push(`<color=${color}>【${kind}】</color><nobr>${f.area.name}</nobr>\n【予想】  ${f.maxHeight}  ${time}`);
    }
  });

  if (ts.intensity && ts.intensity.maxInt && isIntensityAtLeast(ts.intensity.maxInt, '4')) {
    lines.push('');
    lines.push('この地震による各地の震度は次のとおりです');

    const targetGroups = ts.intensity.cityGroups && Object.keys(ts.intensity.cityGroups).length > 0 ? ts.intensity.cityGroups : ts.intensity.groups;

    const intensityOrder = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
    intensityOrder.forEach((int) => {
      const areas = targetGroups?.[int];
      if (areas && areas.length > 0) {
        const intStr = INTENSITY_MAP[int] || int;
        const label = `<u>震度${intStr}</u>`;
        const indent = '5em';
        lines.push(...splitAreasHelper(label, areas, 6, indent));
      }
    });
  }

  let type = 'tsunami_advisory';
  if (groups && (groups.majorTsunami?.length > 0 || groups.warning?.length > 0)) {
    type = 'tsunami_warning';
  }

  return {
    type: type,
    id: ts.eventId,
    lines: createLineObjects(lines, 10.0),
  };
}

function formatMeterHeight(value) {
  const height = parseFloat(value);
  if (isNaN(height)) return '';
  return `${height.toFixed(1)}m`;
}

function isIntensityAtLeast(value, threshold) {
  return (INTENSITY_RANK[String(value)] || 0) >= (INTENSITY_RANK[String(threshold)] || 0);
}

function formatWeather(weather) {
  const lines = [];

  let title = weather.title || '気象情報';
  const hl = weather.headline || '';
  let baseColor = '#FFFFFF';
  const hasDisasterLevel5 = weather.groups?.some((group) => isDisasterLevel5(group.kind)) || isDisasterLevel5(hl) || isDisasterLevel5(title);
  const hasDisasterLevel4 = weather.groups?.some((group) => isDisasterLevel4(group.kind)) || isDisasterLevel4(hl) || isDisasterLevel4(title);

  const isSpecial = title.includes('特別警報') || hl.includes('特別警報');
  const isLinearRainband = title.includes('顕著な大雨') || hl.includes('線状降水帯');

  if (hasDisasterLevel5) {
    baseColor = '#ff00ff';
    title = title.includes('警戒レベル') || title.includes('防災レベル') ? title : `【警戒レベル5】${title}`;
  } else if (hasDisasterLevel4) {
    baseColor = '#FF2800';
    title = title.includes('警戒レベル') || title.includes('防災レベル') ? title : `【警戒レベル4】${title}`;
  } else if (isSpecial) {
    baseColor = '#ff00ff';
    if (!title.includes('特別警報')) title = `【特別警報】${title}`;
  } else if (isLinearRainband) {
    baseColor = '#FF2800';
    title = `【線状降水帯】${title}`;
  }

  lines.push(`<color=${baseColor}>${title}</color>`);

  if (weather.groups && weather.groups.length > 0) {
    for (const group of weather.groups) {
      let color = '#FFFFFF';
      if (isDisasterLevel5(group.kind)) color = '#ff00ff';
      else if (isDisasterLevel4(group.kind)) color = '#FF2800';
      else if (group.kind.includes('特別警報')) color = '#ff00ff';
      else if (group.kind.includes('警報') || group.kind.includes('土砂災害')) color = '#FF2800';
      else if (group.kind.includes('注意報')) color = '#FFFF00';
      else if (group.kind.includes('記録的短時間大雨')) color = '#FFFF00';

      const prefix = `<u><color=${color}>【${group.kind}】</color></u>`;

      const areaLines = splitAreasHelper('', group.areas || [], 6);
      areaLines.forEach((areaLine, idx) => {
        if (idx === 0) {
          lines.push(prefix + areaLine);
        } else {
          lines.push('    '.repeat(prefix.length + 1) + areaLine.trimStart());
        }
      });
    }
  } else if (hl) {
    let displayHl = hl;
    if (displayHl.includes('線状降水帯')) {
      displayHl = displayHl.replace('線状降水帯', '<color=#FF2800>線状降水帯</color>');
    }
    displayHl = highlightDisasterLevels(displayHl);
    lines.push(displayHl);
  }

  return {
    type: 'weather',
    id: Date.now(),
    lines: createLineObjects(lines, 3.5),
  };
}

function isDisasterLevel5(text) {
  return /(?:警戒|防災)?レベル[5５]/.test(text || '');
}

function isDisasterLevel4(text) {
  return /(?:警戒|防災)?レベル[4４]/.test(text || '');
}

function highlightDisasterLevels(text) {
  return (text || '')
    .replace(/((?:警戒|防災)?レベル[5５][^】\s]*)/g, '<color=#ff00ff>$1</color>')
    .replace(/((?:警戒|防災)?レベル[4４][^】\s]*)/g, '<color=#FF2800>$1</color>');
}

module.exports = {
  formatEarthquake,
  formatTsunami,
  formatWeather,
};
