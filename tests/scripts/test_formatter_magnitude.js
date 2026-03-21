const { formatEarthquake } = require('../../lib/formatter');
const assert = require('assert');

function test() {
    console.log('--- マグニチュード表示形式のテスト ---');

    const testCases = [
        {
            name: 'マグニチュードが整数の場合 (7 -> 7.0)',
            eq: {
                originTimeFormatted: '午前0時0分',
                eventId: '123',
                earthquake: {
                    hypocenter: { name: 'テスト震源', coordinate: '2026-03-20T00:00:00+09:00/+35.0+135.0-10000/' },
                    magnitude: '7'
                }
            },
            expected: 'マグニチュード7.0'
        },
        {
            name: 'マグニチュードが小数第一位まである場合 (7.1 -> 7.1)',
            eq: {
                originTimeFormatted: '午前0時0分',
                eventId: '124',
                earthquake: {
                    hypocenter: { name: 'テスト震源', coordinate: '2026-03-20T00:00:00+09:00/+35.0+135.0-10000/' },
                    magnitude: '7.1'
                }
            },
            expected: 'マグニチュード7.1'
        },
        {
            name: 'マグニチュードが小数第二位まである場合 (7.12 -> 7.1)',
            eq: {
                originTimeFormatted: '午前0時0分',
                eventId: '125',
                earthquake: {
                    hypocenter: { name: 'テスト震源', coordinate: '2026-03-20T00:00:00+09:00/+35.0+135.0-10000/' },
                    magnitude: '7.12'
                }
            },
            expected: 'マグニチュード7.1'
        },
        {
            name: 'マグニチュードがNaNの場合 (説明文があればそれを使用)',
            eq: {
                originTimeFormatted: '午前0時0分',
                eventId: '126',
                earthquake: {
                    hypocenter: { name: 'テスト震源', coordinate: '2026-03-20T00:00:00+09:00/+35.0+135.0-10000/' },
                    magnitude: 'NaN',
                    magnitudeDescription: '不明'
                }
            },
            expected: '不明'
        }
    ];

    testCases.forEach(tc => {
        const result = formatEarthquake(tc.eq);
        const magLine = result.lines.find(line => line.includes('マグニチュード') || line.includes('不明'));
        console.log(`Test: ${tc.name}`);
        console.log(`Result line: ${magLine}`);
        assert(magLine.includes(tc.expected), `Expected ${tc.expected} in ${magLine}`);
    });

    console.log('\nすべてのテストが成功しました。');
}

try {
    test();
} catch (e) {
    console.error('テスト失敗:', e.message);
    process.exit(1);
}
