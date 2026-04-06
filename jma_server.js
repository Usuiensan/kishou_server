const https = require('https'); // 追加
const fs = require('fs'); // 追加
const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');

const WebSocket = require('ws');
const { mapP2PQuakeToEarthquake, mapP2PQuakeToEEW } = require('./lib/parsers/p2pquake');

const app = express();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

const POLL_INTERVALS = {
  NORMAL: 30 * 1000,
};

// JMA Atom Feeds
const FEEDS = {
  EQVOL: { url: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', interval: POLL_INTERVALS.NORMAL, lastUpdate: 0 },
};

// ... existing TARGET_CODES ...

// キャッシュ
const cache = {
  formatted: [],
};

// 処理済みURLおよびイベントの記録
const processedUrls = new Set();
const processedEvents = new Set(); // {eventId} or {originTime:hypocenter}

const MAX_PROCESSED = 1000;
const RETAIN_MS = 3 * 60 * 60 * 1000; 

// WebSocket 状態管理
let isWsConnected = false;
let ws = null;

function connectWebSocket() {
  const wsUrl = 'wss://api.p2pquake.net/v2/ws';
  console.log(`📡 WebSocket 接続試行: ${wsUrl}`);
  
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('✅ WebSocket 接続成功 (Project KAKUSHIN)');
    isWsConnected = true;
  });

  ws.on('message', (data) => {
    try {
      const json = JSON.parse(data);
      handleP2PQuakeData(json);
    } catch (err) {
      console.error('❌ WebSocket メッセージパースエラー:', err);
    }
  });

  ws.on('close', () => {
    console.log('⚠️ WebSocket 切断されました');
    isWsConnected = false;
    setTimeout(connectWebSocket, 5000); // 5秒後に再接続
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket エラー:', err.message);
  });
}

function handleP2PQuakeData(json) {
  let parsed = null;
  // 緊急地震速報 (556) のみ P2P から採用する
  if (json.code === 556) {
    parsed = mapP2PQuakeToEEW(json);
  } else {
    return; // 地震情報 (551) 等は無視
  }

  if (!parsed || isProcessed(parsed)) return;

  console.log(`🚀 WebSocket から新規データ受信: ${parsed.isEEW ? 'EEW' : 'Earthquake'}`);
  const formatted = formatEarthquake(parsed);
  if (formatted) {
    addToCache({ ...formatted, timestamp: new Date().toISOString() });
    markAsProcessed(parsed);
  }
}

function isProcessed(parsed) {
  if (parsed.isEEW && parsed.eventId) {
    return processedEvents.has(`${parsed.eventId}_${parsed.infoType}`);
  }
  // 地震情報は 発生時刻+震源地 をキーにする
  const eventKey = `${parsed.originTime}_${parsed.hypocenter}`;
  return processedEvents.has(eventKey);
}

function markAsProcessed(parsed) {
  if (parsed.isEEW && parsed.eventId) {
    processedEvents.add(`${parsed.eventId}_${parsed.infoType}`);
  } else {
    const eventKey = `${parsed.originTime}_${parsed.hypocenter}`;
    processedEvents.add(eventKey);
  }
  
  if (processedEvents.size > MAX_PROCESSED) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }
}

function addToCache(formatted) {
  const now = Date.now();
  const top = cache.formatted[0];
  
  // 現在のキャッシュのトップが「有効な緊急地震速報（60秒以内）」か判定
  const isEEWActive = top && top.type === 'eew' && (now - new Date(top.timestamp).getTime() < 60000);

  if (isEEWActive) {
    if (formatted.type === 'eew') {
      // 新しい緊急地震速報（続報含む）が届いた場合は、トップを差し替え
      cache.formatted = [formatted, ...cache.formatted.filter(item => item.id !== formatted.id)].slice(0, 10);
      console.log(`🚀 緊急地震速報の更新または新規受信（TOP更新）`);
    } else {
      // 緊急地震速報の表示継続中に通常の地震情報や津波報が届いた場合、2番目に挿入
      cache.formatted = [top, formatted, ...cache.formatted.slice(1)].slice(0, 10);
      console.log(`📝 緊急地震速報の継続表示中のため、新着データを 2 番目に挿入しました (${formatted.type})`);
    }
  } else {
    // 通常通りの追加（新しい情報が先頭）
    const filtered = cache.formatted.filter(item => item.id !== formatted.id);
    cache.formatted = [formatted, ...filtered].slice(0, 10);
    console.log(`📝 キャッシュを更新しました (Type: ${formatted.type})`);
  }
}

// 監視対象コード
const TARGET_CODES = {
  EARTHQUAKE: ['VXSE42', 'VXSE43', 'VXSE44', 'VXSE45', 'VXSE51', 'VXSE52', 'VXSE53', 'VXSE62', 'VPOA50'],
  TSUNAMI: ['VTSE41', 'VTSE51', 'VTSE52'],
  WEATHER: [],
};

// キャッシュスタンピード対策用のロック変数
let fetchPromise = null;

async function fetchAndParseFeed() {
  console.log('🔄 フィード取得開始 (VRChat用形式生成)...');
  try {
    const formattedList = [];

    const now = Date.now();
    for (const feedKey of Object.keys(FEEDS)) {
      const feed = FEEDS[feedKey];

      // 更新間隔に達していない場合はスキップ
      if (now - feed.lastUpdate < feed.interval) {
        // console.log(`⏭️ 更新間隔内につきスキップ: ${feedKey}`);
        continue;
      }

      console.log(`📡 フィード取得: ${feed.url} (${feedKey})`);
      const response = await fetch(feed.url);
      const xmlText = await response.text();
      const feedObj = parser.parse(xmlText);
      feed.lastUpdate = now; // 取得時刻を更新

      const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];

      for (const entry of entries) {
        const link = entry.link?.href || entry.link || '';
        if (!link) continue;

        // フィードのエントリ自体が古い場合は、それ以降も古いのでスキップ（ループを抜ける）
        const updated = entry.updated;
        if (updated && Date.now() - new Date(updated).getTime() > RETAIN_MS) {
          break;
        }

        // すでに処理済みのURLに到達したら、それ以降は古いデータなのでループを抜ける
        if (processedUrls.has(link)) {
          break;
        }

        const isEarthquake = TARGET_CODES.EARTHQUAKE.some((code) => link.includes(code)) && !link.match(/VXSE4[2-5]/);
        const isTsunami = TARGET_CODES.TSUNAMI.some((code) => link.includes(code));
        const isWeather = TARGET_CODES.WEATHER.some((code) => link.includes(code));

        if (isEarthquake || isTsunami || isWeather) {
          console.log(`📥 詳細データ取得: ${link}`);
          const res = await fetch(link);
          const xmlContent = await res.text();

          if (isEarthquake) {
            const parsed = parseEarthquake(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            if (!isProcessed(parsed)) {
              const formatted = formatEarthquake(parsed);
              if (formatted) {
                formattedList.push({ ...formatted, timestamp: new Date().toISOString() });
                markAsProcessed(parsed);
              }
            } else {
              console.log(`⏭️ すでに処理済みのためスキップ: ${parsed.eventId || parsed.originTime}`);
            }
          } else if (isTsunami) {
            const parsed = parseTsunami(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            formattedList.push({ ...formatTsunami(parsed), timestamp: new Date().toISOString() });
          } else if (isWeather) {
            const parsed = parseWeather(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            formattedList.push({ ...formatWeather(parsed), timestamp: new Date().toISOString() });
          }
          processedUrls.add(link);
          // メモリリーク対策：最大保持数を超えた場合は古いものから削除
          if (processedUrls.size > MAX_PROCESSED_URLS) {
            const firstEntry = processedUrls.values().next().value;
            processedUrls.delete(firstEntry);
          }
        }
      }
    }

    if (formattedList.length > 0) {
      // 新しい順（インデックスが小さいほど新しい）に処理
      // 複数件ある場合は古い方から順に addToCache する
      for (const item of formattedList.reverse()) {
        addToCache(item);
      }
    }
    return cache.formatted;
  } catch (err) {
    console.error('❌ フィード解析エラー:', err);
    return cache.formatted;
  }
}

// データ取得の仲介関数（排他制御）
async function getLatestData() {
  const now = Date.now();

  // 設定された保持期間（RETAIN_MS）以上経過したキャッシュアイテムを削除
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

  // いずれかの有効なフィードが更新間隔を超えている、またはキャッシュがない場合
  const anyStale = Object.values(FEEDS).some((feed) => now - feed.lastUpdate > feed.interval);

  if (anyStale || !cache.formatted || cache.formatted.length === 0) {
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

// テスト用エンドポイント: tests/results/ 内のファイルを指定して取得できる
app.get('/jma/test/:code', (req, res) => {
  const code = req.params.code;
  const filePath = `./tests/results/test_result_${code}.json`;

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // フロントエンドの期待に合わせて配列形式にし、最新の時刻を付与して返却
      res.json([
        {
          ...data,
          isTest: true, // テストデータであることを明示
          // 各行の先頭にテストデータである旨を追記（ユーザー要望）
          lines: data.lines.map((line) => ({
            ...line,
            text: `<align="center"><color=#FFFF00>【テストデータ】</color>\n<align="left">${typeof line === 'object' ? line.text : line}`
          })),
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      res.status(500).json({ error: 'テストデータの読み取りに失敗しました。' });
    }
  } else {
    res.status(404).json({ error: `テストデータ (${code}) が見つかりません。先に npm test を実行してください。` });
  }
});

app.get('/jma/latest', async (req, res) => {
  const data = await getLatestData();

  // 古いクライアントとの互換性のため、データが空の場合は stable を返す
  if (!data || data.length === 0) {
    res.json([
      {
        type: 'stable',
        timestamp: new Date().toISOString(),
        id: 'none',
        lines: [{ text: '現在、発表されている地震・津波情報はありません。', duration: 10 }],
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
  // サーバー起動後に WebSocket 接続を開始
  connectWebSocket();
});
