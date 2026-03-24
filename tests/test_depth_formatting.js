const { formatEarthquake } = require('../lib/formatter');

const testCases = [
  {
    name: '通常の深さ (Description優先)',
    input: {
      earthquake: {
        hypocenter: {
          name: '石川県能登地方',
          coordinate: '+37.5+138.6-10000/',
          description: '北緯３７．５度　東経１３８．６度　深さ　１０ｋｍ'
        },
        magnitude: '5.0'
      }
    },
    expected: '深さ10キロ'
  },
  {
    name: 'ごく浅い (Descriptionに含まれる)',
    input: {
      earthquake: {
        hypocenter: {
          name: '千葉県北東部',
          coordinate: '+35.7+140.6+0/',
          description: '北緯３５．７度　東経１４０．６度　ごく浅い'
        },
        magnitude: '3.0'
      }
    },
    expected: '深さごく浅い'
  },
  {
    name: '深さ不明 (Descriptionに含まれる)',
    input: {
      earthquake: {
        hypocenter: {
          name: '伊豆大島近海',
          coordinate: '+34.7+139.4/',
          description: '北緯３４．７度　東経１３９．４度　深さ不明'
        },
        magnitude: '4.0'
      }
    },
    expected: '深さ不明'
  },
  {
    name: '震源要素不明 (Description)',
    input: {
      earthquake: {
        hypocenter: {
          name: '不明',
          coordinate: '',
          description: '震源要素不明'
        },
        magnitude: 'NaN',
        magnitudeDescription: 'Ｍ不明'
      }
    },
    expected: '深さ不明'
  },
  {
    name: '600km以上 (Description)',
    input: {
      earthquake: {
        hypocenter: {
          name: 'オホーツク海中南部',
          coordinate: '+46.0+144.0-670000/',
          description: '北緯４６．０度　東経１４４．０度　深さは６００ｋｍ以上'
        },
        magnitude: '6.0'
      }
    },
    expected: '深さ600キロ以上'
  },
  {
    name: '座標からのフォールバック (+0/ -> ごく浅い)',
    input: {
      earthquake: {
        hypocenter: {
          name: 'テスト地域',
          coordinate: '+35.0+135.0+0/',
          description: 'テスト地域'
        },
        magnitude: '1.0'
      }
    },
    expected: '深さごく浅い'
  },
  {
    name: '座標からのフォールバック (-10000/ -> 10キロ)',
    input: {
      earthquake: {
        hypocenter: {
          name: 'テスト地域',
          coordinate: '+35.0+135.0-10000/',
          description: ''
        },
        magnitude: '1.0'
      }
    },
    expected: '深さ10キロ'
  }
];

let failed = 0;
testCases.forEach((tc) => {
  const result = formatEarthquake(tc.input);
  const depthLine = result.lines.find(l => l.includes('深さ'));
  if (depthLine && depthLine.includes(tc.expected)) {
    console.log(`✅ PASS: ${tc.name}`);
  } else {
    console.log(`❌ FAIL: ${tc.name}`);
    console.log(`   Expected to contain: ${tc.expected}`);
    console.log(`   Actual: ${depthLine}`);
    failed++;
  }
});

if (failed > 0) {
  console.log(`\nTests failed: ${failed}`);
  process.exit(1);
} else {
  console.log('\nAll tests passed! 🎉');
}
