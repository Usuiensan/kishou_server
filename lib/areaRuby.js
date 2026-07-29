const areaRubyGroups = require('../data/area_ruby.json');

const RUBY_SIZE = '50%';
const RUBY_VOFFSET = '0.7em';
const RUBY_WIDTH_RATIO = 0.5;
const areaNames = Object.keys(areaRubyGroups).sort((a, b) => b.length - a.length);

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
  applyAreaRuby,
};
