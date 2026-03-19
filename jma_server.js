const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');

const app = express();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

// JMA Atom Feeds
const FEEDS = {
  EQVOL: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
  EXTRA: 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml',
  OTHER: 'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml',
};

const TARGET_CODES = {
  EARTHQUAKE: ['VXSE51', 'VXSE52', 'VXSE53', 'VXSE62'],
  TSUNAMI: ['VTSE41', 'VTSE51', 'VTSE52'],
  WEATHER: ['VPWW53', 'VPUW50', 'VPTW60', 'VPFW40', 'VPOA50'],
};

// キャッシュ
const cache = {
  formatted: [],
  lastUpdate: 0,
  ttl: 60 * 1000,
};

// 処理済みURLを記録して重複取得を防止
const processedUrls = new Set();
const MAX_PROCESSED_URLS = 1000; // メモリリーク対策：最大保持数を設定

// キャッシュスタンピード対策用のロック変数
let fetchPromise = null;

async function fetchAndParseFeed() {
  console.log('🔄 フィード取得開始 (VRChat用形式生成)...');
  try {
    const formattedList = [];

    for (const feedKey of Object.keys(FEEDS)) {
      const response = await fetch(FEEDS[feedKey]);
      const xmlText = await response.text();
      const feedObj = parser.parse(xmlText);

      const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];

      let latestFound = { earthquake: false, tsunami: false, weather: false };

      for (const entry of entries) {
        const link = entry.link?.href || entry.link || '';
        if (!link) continue;

        const isEarthquake = !latestFound.earthquake && TARGET_CODES.EARTHQUAKE.some((code) => link.includes(code));
        const isTsunami = !latestFound.tsunami && TARGET_CODES.TSUNAMI.some((code) => link.includes(code));
        const isWeather = !latestFound.weather && TARGET_CODES.WEATHER.some((code) => link.includes(code));

        // メモリリーク対策：Setのサイズが上限を超えたらクリアする
        if (processedUrls.size > MAX_PROCESSED_URLS) {
          console.log('🧹 processedUrlsのキャッシュをクリアしました');
          processedUrls.clear();
        }

        if (processedUrls.has(link)) {
          if (isEarthquake) latestFound.earthquake = true;
          if (isTsunami) latestFound.tsunami = true;
          if (isWeather) latestFound.weather = true;
          continue;
        }

        if (isEarthquake || isTsunami || isWeather) {
          const res = await fetch(link);
          const xmlContent = await res.text();

          if (isEarthquake) {
            const parsed = parseEarthquake(xmlContent);
            formattedList.push({ ...formatEarthquake(parsed), timestamp: new Date().toISOString() });
            latestFound.earthquake = true;
          } else if (isTsunami) {
            const parsed = parseTsunami(xmlContent);
            formattedList.push({ ...formatTsunami(parsed), timestamp: new Date().toISOString() });
            latestFound.tsunami = true;
          } else if (isWeather) {
            const parsed = parseWeather(xmlContent);
            formattedList.push({ ...formatWeather(parsed), timestamp: new Date().toISOString() });
            latestFound.weather = true;
          }
          processedUrls.add(link);
        }

        if (latestFound.earthquake && latestFound.tsunami && latestFound.weather) break;
      }
    }

    if (formattedList.length > 0) {
      cache.formatted = formattedList;
    }
    cache.lastUpdate = Date.now();
    return cache.formatted;
  } catch (err) {
    console.error('❌ フィード解析エラー:', err);
    return cache.formatted;
  }
}

// データ取得の仲介関数（排他制御）
async function getLatestData() {
  const now = Date.now();
  // キャッシュが古い、またはデータがない場合
  if (now - cache.lastUpdate > cache.ttl || !cache.formatted || cache.formatted.length === 0) {
    // 既に別のリクエストがフェッチ処理中の場合は、その完了を待つ
    if (!fetchPromise) {
      fetchPromise = fetchAndParseFeed().finally(() => {
        fetchPromise = null; // 処理完了後にロックを解除
      });
    }
    return fetchPromise;
  }
  // キャッシュが有効な場合は即座に返す
  return cache.formatted;
}

app.get('/jma/latest', async (req, res) => {
  const data = await getLatestData();

  const latest =
    data && data.length > 0
      ? data[0]
      : {
          type: 'stable',
          timestamp: new Date().toISOString(),
          id: 'none',
          lines: ['現在、発表されている地震・津波情報はありません。'],
        };

  // Cloudflareエッジキャッシュ用のヘッダを追加
  res.set('Cache-Control', 'public, max-age=60');
  res.json(latest);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 JMA API Server running on port ${PORT}`);
});
