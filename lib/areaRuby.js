const areaRubyMono = require('../data/area_ruby_mono.json');

const RUBY_SIZE = '50%';
const RUBY_VOFFSET = '0.7em';
const RUBY_WIDTH_RATIO = 0.5;
const areaNames = Object.keys(areaRubyMono).sort((a, b) => b.length - a.length);
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

function matchAreaSegments(area) {
  const text = String(area || '');
  if (Object.hasOwn(areaRubyMono, text)) return [areaRubyMono[text]];

  const matches = [];
  for (let index = 0; index < text.length;) {
    const name = areaNames.find((candidate) => text.startsWith(candidate, index));
    if (!name) return null;
    matches.push(areaRubyMono[name]);
    index += name.length;
  }
  return matches.length ? matches : null;
}

function getAreaReading(area) {
  const matches = matchAreaSegments(area);
  return matches?.map((segments) => segments.map(([, reading]) => reading).join('')).join(' ') ?? null;
}

// 単語の区切りは全体の読みに使い、各文字の上に載せるルビからは除く。
function getAreaRubyMono(area) {
  const matches = matchAreaSegments(area);
  return matches?.flat().map(([base, reading]) => [base, reading.replaceAll(' ', '')]) ?? null;
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
      result += getAreaRubyMono(name).map(([base, reading]) => reading ? rubyGroup(base, reading) : base).join('');
      index += name.length;
    }
    return result;
  }).join('');
}

module.exports = {
  RUBY_SIZE,
  RUBY_VOFFSET,
  RUBY_WIDTH_RATIO,
  areaRubyMono,
  getAreaReading,
  getAreaRubyMono,
  toHalfwidthKatakana,
  applyAreaRuby,
};
