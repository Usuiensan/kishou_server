const https = require('https'); // 追加
const fs = require('fs'); // 追加
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
// 気象情報の更新を一旦停止するためコメントアウト
const FEEDS = {
  EQVOL: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
  // EXTRA: 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml',
  // OTHER: 'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml',
};

const TARGET_CODES = {
  EARTHQUAKE: ['VXSE51', 'VXSE52', 'VXSE53', 'VXSE62'],
  TSUNAMI: ['VTSE41', 'VTSE51', 'VTSE52'],
  WEATHER: [], // 一旦停止中 ['VPWW53', 'VPUW50', 'VPTW60', 'VPFW40', 'VPOA50'],
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
      console.log(`📡 フィード取得: ${FEEDS[feedKey]}`);
      const response = await fetch(FEEDS[feedKey]);
      const xmlText = await response.text();
      const feedObj = parser.parse(xmlText);

      const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];

      for (const entry of entries) {
        const link = entry.link?.href || entry.link || '';
        if (!link) continue;

        // すでに処理済みのURLに到達したら、それ以降は古いデータなのでループを抜ける
        if (processedUrls.has(link)) {
          break;
        }

        const isEarthquake = TARGET_CODES.EARTHQUAKE.some((code) => link.includes(code));
        const isTsunami = TARGET_CODES.TSUNAMI.some((code) => link.includes(code));
        const isWeather = TARGET_CODES.WEATHER.some((code) => link.includes(code));

        if (isEarthquake || isTsunami || isWeather) {
          console.log(`📥 詳細データ取得: ${link}`);
          const res = await fetch(link);
          const xmlContent = await res.text();

          if (isEarthquake) {
            const parsed = parseEarthquake(xmlContent);
            formattedList.push({ ...formatEarthquake(parsed), timestamp: new Date().toISOString() });
          } else if (isTsunami) {
            const parsed = parseTsunami(xmlContent);
            formattedList.push({ ...formatTsunami(parsed), timestamp: new Date().toISOString() });
          } else if (isWeather) {
            const parsed = parseWeather(xmlContent);
            formattedList.push({ ...formatWeather(parsed), timestamp: new Date().toISOString() });
          }
          processedUrls.add(link);
        }
      }
    }

    if (formattedList.length > 0) {
      // 新しい順に並んでいるはずなので、既存のキャッシュの前に結合する
      cache.formatted = [...formattedList, ...cache.formatted].slice(0, 10);
      console.log(`📝 キャッシュを更新しました（現在の件数: ${cache.formatted.length}）`);
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

  // 10分以上経過したキャッシュアイテムを削除
  const RETAIN_MS = 10 * 60 * 1000;
  if (cache.formatted && cache.formatted.length > 0) {
    const originalCount = cache.formatted.length;
    cache.formatted = cache.formatted.filter((item) => {
      const itemTime = new Date(item.timestamp).getTime();
      return now - itemTime < RETAIN_MS;
    });
    if (cache.formatted.length !== originalCount) {
      console.log(`🧹 古いキャッシュを削除しました (${originalCount} -> ${cache.formatted.length})`);
    }
  }

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

  // 古いクライアントとの互換性のため、データが空の場合は stable を返す
  if (!data || data.length === 0) {
    res.json([
      {
        type: 'stable',
        timestamp: new Date().toISOString(),
        id: 'none',
        lines: ['現在、発表されている地震・津波情報はありません。'],
      },
    ]);
    return;
  }

  // Cloudflareエッジキャッシュ用のヘッダを追加
  res.set('Cache-Control', 'public, max-age=60');
  res.json(data);
});

const sslOptions = {
  key: fs.readFileSync('./ssl/cloudflare.key'),
  cert: fs.readFileSync('./ssl/cloudflare.crt'),
};

// ポートを 443 (HTTPS標準) に変更
const PORT = 443;
https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Full HTTPS JMA API Server running on port ${PORT}`);
});
