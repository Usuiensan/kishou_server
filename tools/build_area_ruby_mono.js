#!/usr/bin/env node
// ルビマスター (data/area_ruby_mono.json) の生成ツール。
//
// 使い方: node tools/build_area_ruby_mono.js
//   data/area_ruby.json (名前 → ルビグループ配列) の全エントリについて、
//   グループ単位で漢字1字ごとのモノルビ分割を生成し、
//   data/area_ruby_mono.json (名前 → [[対象文字列, 読み], ...]) を書き出す。
//
// 方針 (protocol/overlay-fixed.md 参照):
//   - 分割はこのツールの生成時にだけ行い、結果をマスターに確定データとして
//     収録する。描画側 (lib/areaRuby.js の getAreaRubyMono) はマスターを
//     そのまま使うだけで、実行時に分割を推測しない。
//   - セグメントの対象文字列を連結すると名前と一致し、読みを連結すると
//     area_ruby.json のグループ読みの連結と一致する (連結検証は
//     tests/area_ruby_mono.test.js が全件で行う)。
//   - 漢字1字に分割できない熟語だけ、複数文字のセグメント (熟語グループ)
//     として収録する。
//
// 読み候補の出典:
//   - tools/kanji_readings.json: KANJIDIC2 (EDRDG、CC BY-SA 3.0) から、
//     area_ruby.json に現れる漢字について音読み・訓読み・名乗りを抽出し、
//     訓読みは語幹・連用形 (例: 添える→そえ) も候補に加えたもの。
//     連濁・促音のゆれは生成時に候補へ展開する。
//   - EXTRA_READINGS: 地名固有の読み (例: 城=き/ぎ、潟は kanjidic 収録済み)
//     で、KANJIDIC2 に無いものを、実在の地名での用例に基づき明示した表。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const areaRuby = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'area_ruby.json'), 'utf8'));
const kanjiReadings = JSON.parse(fs.readFileSync(path.join(__dirname, 'kanji_readings.json'), 'utf8'));

// 地名固有の読み候補 (KANJIDIC2 に無いもの)。各項目は実在地名の分割に必要で、
// 一般の読みで連結できる名前では先に一般の読みが選ばれる (候補順序)。
const EXTRA_READINGS = {
  良: ['ら'], // 奈良・姶良・富良野
  谷: ['や', 'がや'], // 渋谷・世田谷
  城: ['き', 'ぎ', 'ぐすく'], // 茨城・宮城・中城 (沖縄)
  飯: ['いい'], // 飯野・飯舘
  分: ['いた'], // 大分
  渡: ['お'], // 渡島
  愛: ['え'], // 愛媛
  原: ['わら', 'ら'], // 小笠原・川原
  日: ['に'], // 日本
  戸: ['べ'], // 神戸
  鳥: ['とっ', 'と'], // 鳥取・鳥羽
  賀: ['か'], // 横須賀・須賀川
  米: ['め'], // 久米島
  釧: ['くし'], // 釧路
  神: ['か'], // 神奈川
  能: ['の'], // 能登
  安: ['あ'], // 安土・安平
  濃: ['の'], // 美濃
  清: ['し'], // 清水 (水=みず と組み合わせる)
  勢: ['せ'], // 伊勢
  利: ['と'], // 利根・利島
  隠: ['お'], // 隠岐
  越: ['えち', 'こし'], // 越前・越谷
  奄: ['あま'], // 奄美
  秩: ['ちち'], // 秩父
  春: ['かす'], // 春日
  標: ['しべ'], // 標津・標茶
  比: ['い'], // 由比・阿久比
  波: ['わ'], // 阿波・紫波
  万: ['ま'], // 伊万里・久万
  壱: ['い'], // 壱岐
  訪: ['わ'], // 諏訪
  球: ['く'], // 球磨
  珠: ['す'], // 珠洲
  最: ['も'], // 最上
  柳: ['やな'], // 柳井・柳川
  種: ['くさ'], // 千種
  好: ['よし'], // 三好
  砺: ['と'], // 砺波・南砺
  女: ['おな'], // 女川
  豆: ['ど'], // 小豆島
  礼: ['れ'], // 礼文
  科: ['しな'], // 山科・立科
  泊: ['どまり'], // 中泊・和泊
  甚: ['じ'], // 甚目寺
  粟: ['あ'], // 粟国
  平: ['へ'], // 伊平屋
  杵: ['き'], // 臼杵
  合: ['こう'], // 合志
  蔵: ['さし'], // 武蔵
  辺: ['なべ'], // 田辺
  水: ['み'], // 水戸・和水
  太: ['おお'], // 太田
  幡: ['わた'], // 八幡
  曇: ['づみ'], // 安曇野
  曳: ['びき'], // 羽曳野
  牧: ['もく'], // 南牧
  葛: ['かつら'], // 葛城・葛尾
  刈: ['かり'], // 刈谷・刈羽
  羽: ['わ'], // 刈羽
  苅: ['かん'], // 苅田
  茅: ['ち'], // 茅ヶ崎・茅野 (KANJIDIC2 は ちがや のみ)
  宅: ['やけ'], // 三宅 (KANJIDIC2 未収録)
  浅: ['あざ'], // 浅井 (あさ の連濁形)
  豊: ['と'], // 豊島・豊見城
};

const RENDAKU = {};
for (const [from, to] of [
  ['か', 'が'], ['き', 'ぎ'], ['く', 'ぐ'], ['け', 'げ'], ['こ', 'ご'],
  ['さ', 'ざ'], ['し', 'じ'], ['す', 'ず'], ['せ', 'ぜ'], ['そ', 'ぞ'],
  ['た', 'だ'], ['ち', 'ぢ'], ['つ', 'づ'], ['て', 'で'], ['と', 'ど'],
  ['は', 'ば'], ['ひ', 'び'], ['ふ', 'ぶ'], ['へ', 'べ'], ['ほ', 'ぼ'],
  ['は', 'ぱ'], ['ひ', 'ぴ'], ['ふ', 'ぷ'], ['へ', 'ぺ'], ['ほ', 'ぽ'],
]) {
  (RENDAKU[from] ||= []).push(to);
}
const rendakuOf = (reading) => (reading && RENDAKU[reading[0]])
  ? RENDAKU[reading[0]].map((head) => head + reading.slice(1)) : [];
const sokuonOf = (reading) => (reading.length >= 2 && 'つくきち'.includes(reading.at(-1)))
  ? [reading.slice(0, -1) + 'っ'] : [];

const DIGITS = {
  '０': ['れい', 'ぜろ'], '１': ['いち'], '２': ['に'], '３': ['さん'], '４': ['よん', 'し'],
  '５': ['ご'], '６': ['ろく'], '７': ['なな', 'しち'], '８': ['はち'], '９': ['きゅう', 'く'],
};
const HIRAGANA = new Set('ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろわゐゑをんー');
const kataToHira = (text) => [...text].map((ch) => {
  const code = ch.codePointAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
}).join('');

function baseReadingsOf(ch) {
  const list = [...(kanjiReadings[ch] || [])];
  for (const extra of EXTRA_READINGS[ch] || []) {
    if (!list.includes(extra)) list.push(extra);
  }
  return list;
}

// 1文字を消費する移動候補 [読み, ゆれコスト]。prev は直前セグメントの読み (々 用)。
function charMoves(ch, prev) {
  if (HIRAGANA.has(ch)) return [[ch, 0]];
  const code = ch.codePointAt(0);
  if (code >= 0x30a1 && code <= 0x30f6) { // カタカナ
    if (ch === 'ヶ' || ch === 'ケ') return [['か', 1], ['け', 1], ['が', 1], ['げ', 1]];
    if (ch === 'ヵ') return [['か', 1], ['が', 1]];
    return [[kataToHira(ch), 0]];
  }
  // '・' は読み側にも現れる (天草・芦北) が、伊勢・三河湾 のように読みに
  // 現れない電文表記もあるため、空読みも候補にする。
  if (ch === '・') return [['・', 0], ['', 1]];
  if (ch === '々') {
    if (!prev) return [];
    return [[prev, 1], ...rendakuOf(prev).map((v) => [v, 2])];
  }
  if (DIGITS[ch]) return DIGITS[ch].map((r) => [r, 1]);
  const bases = baseReadingsOf(ch);
  const moves = bases.map((r) => [r, 0]);
  for (const r of bases) {
    for (const v of rendakuOf(r)) moves.push([v, 1]);
    for (const v of sokuonOf(r)) moves.push([v, 1]);
  }
  return moves;
}

// 熟語フォールバック用の辞書: マスター内のグループとエントリ名そのもの。
const DICTIONARY = new Map();
for (const [name, groups] of Object.entries(areaRuby)) {
  DICTIONARY.set(name, groups.map((g) => g[1]).join(''));
  for (const g of groups) {
    if ([...g[0]].length >= 2) DICTIONARY.set(g[0], g[1]);
  }
}

// グループ (base, reading) を分割する。目的関数は辞書式の
// (モノルビでないセグメントで覆った文字数, そのうち任意チャンクの文字数,
// ゆれコスト) で、小さいものを優先する。複数文字セグメントは辞書
// (マスター内の既存グループ・エントリ名) を優先し、辞書にも無い場合だけ
// 任意チャンクにする。1文字の割り当ては読み候補で裏付けられたものだけに
// 限る (チャンクは2文字以上)。
// 戻り値は [[text, reading, kind], ...]。
function segmentGroup(base, reading) {
  const B = [...base];
  const R = reading;
  const n = B.length;
  const m = R.length;
  const memo = new Map();
  const dp = (i, j, prev) => {
    const key = `${i}|${j}|${prev}`;
    if (memo.has(key)) return memo.get(key);
    let best = null;
    // 比較は (非モノ文字数, チャンク文字数, ゆれコスト, 非モノ開始位置の和)
    const consider = (val) => {
      if (!val) return;
      if (!best || val[0] < best[0] || (val[0] === best[0]
        && (val[1] < best[1] || (val[1] === best[1]
        && (val[2] < best[2] || (val[2] === best[2] && val[3] < best[3])))))) best = val;
    };
    if (i === n) {
      best = j === m ? [0, 0, 0, 0, []] : null;
    } else {
      for (const [cand, cost] of charMoves(B[i], prev)) {
        if (R.startsWith(cand, j)) {
          const sub = dp(i + 1, j + cand.length, cand);
          consider(sub && [sub[0], sub[1], sub[2] + cost, sub[3], [[B[i], cand, 'mono'], ...sub[4]]]);
        }
      }
      // 複数文字セグメントは、グループ全体を覆う場合を除き、行政接尾辞
      // (町・市・区・村) で終わらないものだけを候補にする (「戸町」のような
      // 接尾辞を巻き込んだ区切りを避け、「一戸」+「町」の形を優先する)。
      const segmentAllowed = (len) => !(i === 0 && len === n)
        ? !'町村市区'.includes(B[i + len - 1]) : true;
      for (let len = 2; len <= n - i; len += 1) {
        if (!segmentAllowed(len)) continue;
        const word = B.slice(i, i + len).join('');
        const wordReading = DICTIONARY.get(word);
        if (wordReading !== undefined && R.startsWith(wordReading, j)) {
          const sub = dp(i + len, j + wordReading.length, wordReading);
          consider(sub && [sub[0] + len, sub[1], sub[2], sub[3] + i, [[word, wordReading, 'dict'], ...sub[4]]]);
        }
      }
      for (let len = 2; len <= n - i; len += 1) {
        if (!segmentAllowed(len)) continue;
        const word = B.slice(i, i + len).join('');
        for (let rlen = 0; rlen <= m - j; rlen += 1) {
          const chunk = R.slice(j, j + rlen);
          const sub = dp(i + len, j + rlen, chunk);
          consider(sub && [sub[0] + len, sub[1] + len, sub[2], sub[3] + i, [[word, chunk, 'chunk'], ...sub[4]]]);
        }
      }
    }
    memo.set(key, best);
    return best;
  };
  const result = dp(0, 0, '');
  return result ? result[4] : [[base, reading, 'chunk']];
}

function main() {
  const mono = {};
  let groupSegments = 0;
  const groupSegmentKinds = { dict: 0, chunk: 0 };
  const groupSegmentList = new Map();
  let fullMonoEntries = 0;
  for (const [name, groups] of Object.entries(areaRuby)) {
    const segments = [];
    let entryFullMono = true;
    for (const group of groups) {
      const [base, reading] = group;
      if ([...base].length === 1) {
        segments.push([base, reading]);
        continue;
      }
      for (const [text, segReading, kind] of segmentGroup(base, reading)) {
        segments.push([text, segReading]);
        if (kind !== 'mono') {
          entryFullMono = false;
          groupSegments += 1;
          groupSegmentKinds[kind] += 1;
          const label = `${text}=${segReading}`;
          groupSegmentList.set(label, (groupSegmentList.get(label) || 0) + 1);
        }
      }
    }
    if (entryFullMono) fullMonoEntries += 1;
    mono[name] = segments;
  }
  // 連結検証 (生成物が壊れていたら書き出さない)
  for (const [name, groups] of Object.entries(areaRuby)) {
    const segments = mono[name];
    if (segments.map((s) => s[0]).join('') !== name) throw new Error(`text mismatch: ${name}`);
    const expected = groups.map((g) => g[1]).join('');
    if (segments.map((s) => s[1]).join('') !== expected) throw new Error(`reading mismatch: ${name}`);
  }
  const out = `${JSON.stringify(mono, null, 1)}\n`;
  fs.writeFileSync(path.join(ROOT, 'data', 'area_ruby_mono.json'), out);
  console.log(`entries: ${Object.keys(mono).length}`);
  console.log(`full mono entries: ${fullMonoEntries}`);
  console.log(`group segments: ${groupSegments} (dict ${groupSegmentKinds.dict}, chunk ${groupSegmentKinds.chunk}), distinct ${groupSegmentList.size}`);
  for (const [label, count] of [...groupSegmentList.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} ${label}`);
  }
}

if (require.main === module) main();
module.exports = { segmentGroup };
