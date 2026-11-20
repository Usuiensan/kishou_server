(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EewAudio = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const PREF_NAMES = [
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
    '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
    '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
    '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
  ];

  const REGION_OF = {
    '青森県': '東北', '岩手県': '東北', '宮城県': '東北', '秋田県': '東北', '山形県': '東北', '福島県': '東北',
    '茨城県': '関東', '栃木県': '関東', '群馬県': '関東', '埼玉県': '関東', '千葉県': '関東', '東京都': '関東', '神奈川県': '関東',
    '富山県': '北陸', '石川県': '北陸', '福井県': '北陸',
    '岐阜県': '東海', '静岡県': '東海', '愛知県': '東海', '三重県': '東海',
    '滋賀県': '近畿', '京都府': '近畿', '大阪府': '近畿', '兵庫県': '近畿', '奈良県': '近畿', '和歌山県': '近畿',
    '鳥取県': '中国', '島根県': '中国', '岡山県': '中国', '広島県': '中国', '山口県': '中国',
    '徳島県': '四国', '香川県': '四国', '愛媛県': '四国', '高知県': '四国',
    '福岡県': '九州', '佐賀県': '九州', '長崎県': '九州', '熊本県': '九州', '大分県': '九州', '宮崎県': '九州', '鹿児島県': '九州',
    '沖縄県': '沖縄',
  };

  const HK_ZONE_OF = [
    ['石狩地方', '北海道道央'], ['空知地方', '北海道道央'], ['後志地方', '北海道道央'],
    ['渡島地方', '北海道道南'], ['檜山地方', '北海道道南'], ['胆振地方', '北海道道南'],
    ['日高地方', '北海道道南'], ['奥尻島', '北海道道南'],
    ['上川地方', '北海道道北'], ['留萌地方', '北海道道北'], ['宗谷地方', '北海道道北'],
    ['利尻礼文', '北海道道北'],
    ['網走地方', '北海道道東'], ['北見地方', '北海道道東'], ['紋別地方', '北海道道東'],
    ['十勝地方', '北海道道東'], ['釧路地方', '北海道道東'], ['根室地方', '北海道道東'],
  ];

  const HK4 = ['北海道道央', '北海道道南', '北海道道北', '北海道道東'];

  const PREF_RE = new RegExp(
    '^(' + PREF_NAMES.slice().sort((a, b) => b.length - a.length).join('|') + ')(.*)$'
  );

  function shortName(pref) {
    return pref.replace(/[都府県]$/, '');
  }

  function areaToPref(area) {
    const s = String(area || '');
    for (const n of PREF_NAMES) {
      if (s === n || s.startsWith(n)) return n;
    }
    return null;
  }

  function hokkaidoZones(areas) {
    const found = [];
    for (const a of areas || []) {
      const s = String(a || '');
      for (const z of HK4) if (s.includes(z) && !found.includes(z)) found.push(z);
      for (const [key, z] of HK_ZONE_OF) {
        if (s.includes(key) && !found.includes(z)) found.push(z);
      }
    }
    return HK4.filter((z) => found.includes(z));
  }

  function resolvePrefs(areas) {
    const prefs = [];
    for (const a of areas || []) {
      const p = areaToPref(a) || (hokkaidoZones([a]).length ? '北海道' : null);
      if (p && !prefs.includes(p)) prefs.push(p);
    }
    return prefs;
  }

  function wrapTokens(tokens, cap) {
    const lines = [];
    let cur = '';
    let curU = 0;
    for (const t of tokens) {
      const u = [...t].length;
      const add = cur ? u + 1 : u;
      if (cur && curU + add > cap) {
        lines.push(cur);
        cur = t;
        curU = u;
      } else {
        cur = cur ? cur + '　' + t : t;
        curU += add;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function horizontalTokens(prefs, areas, grouped, fullNames) {
    const hk = hokkaidoZones(areas);
    const koshin = prefs.includes('山梨県') && prefs.includes('長野県');
    const counts = new Map();
    for (const p of prefs) {
      const r = REGION_OF[p];
      if (r && p !== '新潟県') counts.set(r, (counts.get(r) || 0) + 1);
    }
    const out = [];
    const emitted = new Set();
    for (const p of prefs) {
      if (p === '北海道') {
        out.push(...(hk.length ? hk : ['北海道']));
        continue;
      }
      if (p === '新潟県') {
        out.push(fullNames ? '新潟県' : '新潟');
        continue;
      }
      if (p === '山梨県' || p === '長野県') {
        if (grouped && koshin) {
          if (!emitted.has('甲信')) {
            out.push(fullNames ? '甲信地方' : '甲信');
            emitted.add('甲信');
          }
        } else {
          out.push(fullNames ? p : shortName(p));
        }
        continue;
      }
      const r = REGION_OF[p];
      if (grouped && r && counts.get(r) > 1) {
        if (!emitted.has(r)) {
          out.push(fullNames ? (r === '沖縄' ? '沖縄県' : `${r}地方`) : r);
          emitted.add(r);
        }
      } else {
        out.push(fullNames ? p : shortName(p));
      }
    }
    return out;
  }

  /**
   * 下部スーパーインポーズの表示規則 (2行14文字超で地方まとめ) に従い、
   * 音声パーツ用のフルネーム地域一覧 (例: "石川県", "北陸地方", "北海道道央") を返す。
   */
  function resolveAreaAudioNames(areas) {
    const prefs = resolvePrefs(areas);
    const displayTokens = horizontalTokens(prefs, areas, false, false);
    const grouped = wrapTokens(displayTokens, 14).length > 2;
    return horizontalTokens(prefs, areas, grouped, true);
  }

  /**
   * 震央地名をテロップ見出しと同じ丸め規則で正規化する。
   */
  function headlinePlace(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    const m = s.match(PREF_RE);
    if (m && m[2] && !m[2].includes('沖') && !m[2].includes('近海')) {
      return m[1];
    }
    return s.replace(/(?:中北部|中南部|中東部|中西部|北西部|北東部|南西部|南東部|東部|西部|南部|北部|中部)$/, '');
  }

  /**
   * EEW データから再生すべき音声パーツキューを構築する。
   * 返り値: Array<{ file: string, label: string, pauseAfterMs?: number }>
   */
  function buildEewAudioPlaylist(eewData, options = {}) {
    const {
      isUpdate = false,
      repeatCount = 2,
      basePath = 'audio/eew',
    } = options;

    if (!eewData) return [];

    const part = (rel, label, pauseAfterMs = 0) => ({
      file: `${basePath}/${rel}`,
      label,
      pauseAfterMs,
    });

    if (eewData.isCancel) {
      return options.playCancel === false
        ? []
        : [part('phrases/alert_cancel.mp3', '先ほどの緊急地震速報は取り消されました。', 0)];
    }

    const place = headlinePlace(eewData.hypocenterName || '');
    const areaNames = resolveAreaAudioNames(eewData.areas || []);

    const queue = [];
    for (let i = 0; i < Math.max(1, repeatCount); i++) {
      const isFirstUpdatePass = isUpdate && i === 0;
      queue.push(
        isFirstUpdatePass
          ? part('phrases/alert_update.mp3', '緊急地震速報、続報です', 120)
          : part('phrases/alert_start.mp3', '緊急地震速報です', 120)
      );
      if (place) {
        queue.push(part(`epicenters/${place}で地震.mp3`, `${place}で地震`, 150));
      }
      queue.push(part('phrases/alert_warn.mp3', '次の地域は強い揺れに警戒してください', 120));
      for (let a = 0; a < areaNames.length; a++) {
        const area = areaNames[a];
        const isLastArea = a === areaNames.length - 1;
        queue.push(part(`areas/${area}.mp3`, area, isLastArea ? 250 : 120));
      }
    }

    queue.push(part('phrases/alert_end.mp3', '緊急地震速報でした', 180));
    queue.push(part('phrases/alert_action1.mp3', '該当する地域の方がたは、倒れやすい家具などから離れ、テーブルの下などに入って身を守ってください', 120));
    queue.push(part('phrases/alert_action2.mp3', 'うえから落ちてくるもの、倒れてくるものに気をつけてください。', 0));

    return queue;
  }

  return {
    headlinePlace,
    resolveAreaAudioNames,
    buildEewAudioPlaylist,
  };
});
