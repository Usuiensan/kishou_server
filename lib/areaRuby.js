const areaRubyGroups = require('../data/area_ruby.json');

const RUBY_SIZE = '50%';
const RUBY_VOFFSET = '0.7em';
const RUBY_WIDTH_RATIO = 0.5;
const areaNames = Object.keys(areaRubyGroups).sort((a, b) => b.length - a.length);
const prefectureNames = areaNames.filter((name) => /[都道府県]$/u.test(name));
const cityNames = areaNames.filter((name) => /市$/u.test(name));
const AREA_READING_OVERRIDES = {
  '熊本西区': 'くまもと にしく',
  '熊本県天草・芦北': 'くまもとけん あまくさ・あしきた',
  '鹿児島県薩摩': 'かごしまけん さつま',
};
const prefectureReadingPrefixes = [...new Set(prefectureNames.flatMap((name) => {
  const prefixes = [name];
  const shortened = name.replace(/[都道府県]$/u, '');
  if (shortened && areaRubyGroups[shortened]) prefixes.push(shortened);
  return prefixes;
}))].sort((a, b) => b.length - a.length);
const KATAKANA_TO_HALFWIDTH = {
  '。': '｡', '、': '､', '「': '｢', '」': '｣', '・': '･', 'ー': 'ｰ',
  'ァ': 'ｧ', 'ア': 'ｱ', 'ィ': 'ｨ', 'イ': 'ｲ', 'ゥ': 'ｩ', 'ウ': 'ｳ', 'ェ': 'ｪ', 'エ': 'ｴ', 'ォ': 'ｫ', 'オ': 'ｵ',
  'カ': 'ｶ', 'ガ': 'ｶﾞ', 'キ': 'ｷ', 'ギ': 'ｷﾞ', 'ク': 'ｸ', 'グ': 'ｸﾞ', 'ケ': 'ｹ', 'ゲ': 'ｹﾞ', 'コ': 'ｺ', 'ゴ': 'ｺﾞ',
  'サ': 'ｻ', 'ザ': 'ｻﾞ', 'シ': 'ｼ', 'ジ': 'ｼﾞ', 'ス': 'ｽ', 'ズ': 'ｽﾞ', 'セ': 'ｾ', 'ゼ': 'ｾﾞ', 'ソ': 'ｿ', 'ゾ': 'ｿﾞ',
  'タ': 'ﾀ', 'ダ': 'ﾀﾞ', 'チ': 'ﾁ', 'ヂ': 'ﾁﾞ', 'ッ': 'ｯ', 'ツ': 'ﾂ', 'ヅ': 'ﾂﾞ', 'テ': 'ﾃ', 'デ': 'ﾃﾞ', 'ト': 'ﾄ', 'ド': 'ﾄﾞ',
  'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ',
  'ハ': 'ﾊ', 'バ': 'ﾊﾞ', 'パ': 'ﾊﾟ', 'ヒ': 'ﾋ', 'ビ': 'ﾋﾞ', 'ピ': 'ﾋﾟ', 'フ': 'ﾌ', 'ブ': 'ﾌﾞ', 'プ': 'ﾌﾟ', 'ヘ': 'ﾍ', 'ベ': 'ﾍﾞ', 'ペ': 'ﾍﾟ', 'ホ': 'ﾎ', 'ボ': 'ﾎﾞ', 'ポ': 'ﾎﾟ',
  'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ',
  'ャ': 'ｬ', 'ヤ': 'ﾔ', 'ュ': 'ｭ', 'ユ': 'ﾕ', 'ョ': 'ｮ', 'ヨ': 'ﾖ',
  'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ', 'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
  'ヴ': 'ｳﾞ', 'ヵ': 'ｶ', 'ヶ': 'ｹ', 'ヮ': 'ﾜ', 'ヷ': 'ﾜﾞ', 'ヸ': 'ｲﾞ', 'ヹ': 'ｴﾞ', 'ヺ': 'ｦﾞ',
  '゛': 'ﾞ', '゜': 'ﾟ',
};

function toHalfwidthKatakana(value) {
  const katakana = String(value ?? '').replace(/[ぁ-ゖ]/g, (character) => (
    String.fromCodePoint(character.codePointAt(0) + 0x60)
  ));
  return [...katakana].map((character) => KATAKANA_TO_HALFWIDTH[character] || character).join('');
}

function getAreaReading(area) {
  const groups = areaRubyGroups[area];
  if (!groups) return null;
  if (AREA_READING_OVERRIDES[area]) return AREA_READING_OVERRIDES[area];
  const reading = groups.map(([, value]) => value).join('');
  if (prefectureNames.includes(area)) return reading;
  const prefecture = prefectureReadingPrefixes.find((name) => name !== area && area.startsWith(name));
  if (prefecture) {
    const prefectureReading = areaRubyGroups[prefecture].map(([, value]) => value).join('');
    if (reading.startsWith(prefectureReading) && reading.length > prefectureReading.length) {
      return `${prefectureReading} ${reading.slice(prefectureReading.length)}`;
    }
  }

  const city = cityNames.find((name) => name !== area && area.startsWith(name));
  if (city) {
    const cityReading = areaRubyGroups[city].map(([, value]) => value).join('');
    if (reading.startsWith(cityReading) && reading.length > cityReading.length) {
      return `${cityReading} ${reading.slice(cityReading.length)}`;
    }
  }
  return reading;
}

function formatEm(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return `${rounded}em`;
}

function rubyGroup(base, reading) {
  const rubyWidth = reading.length * RUBY_WIDTH_RATIO;
  const baseWidth = base.length;
  const centerOffset = (baseWidth - rubyWidth) / 2;
  const rewind = centerOffset + rubyWidth;
  return `<space=${formatEm(centerOffset)}><size=${RUBY_SIZE}><voffset=${RUBY_VOFFSET}>${reading}</voffset></size><space=${formatEm(-rewind)}>${base}`;
}

function applyAreaRuby(value) {
  const text = String(value ?? '');
  return text.split(/(<[^>]*>)/g).map((part) => {
    if (!part || part.startsWith('<')) return part;
    let result = '';
    for (let index = 0; index < part.length;) {
      const name = areaNames.find((candidate) => part.startsWith(candidate, index));
      if (!name) {
        result += part[index++];
        continue;
      }
      result += areaRubyGroups[name].map(([base, reading]) => rubyGroup(base, reading)).join('');
      index += name.length;
    }
    return result;
  }).join('');
}

module.exports = {
  RUBY_SIZE,
  RUBY_VOFFSET,
  RUBY_WIDTH_RATIO,
  areaRubyGroups,
  getAreaReading,
  toHalfwidthKatakana,
  applyAreaRuby,
};
