const areaRubyGroups = require('../data/area_ruby.json');

const RUBY_SIZE = '50%';
const RUBY_VOFFSET = '0.7em';
const areaNames = Object.keys(areaRubyGroups).sort((a, b) => b.length - a.length);

function rubyGroup(base, reading) {
  return `<size=${RUBY_SIZE}><voffset=${RUBY_VOFFSET}>${reading}</voffset></size>${base}`;
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
  areaRubyGroups,
  applyAreaRuby,
};
