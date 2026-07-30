const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // IPv6が利用できない環境（IPv4のみ）でENETUNREACHエラーを回避するため、IPv4を優先
const https = require('https'); // 追加
const fs = require('fs'); // 追加
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const { sendDiscordDebugMessage } = require('./lib/discordWebhook');
const { createDiscordBot } = require('./lib/discordBot');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');
const { fetchNervStatuses, isNervRelevantStatus, normalizeStatus } = require('./lib/nervSource');
const { createNervStreamMonitor } = require('./lib/nervStream');
const { toLegacyApiResponse } = require('./lib/apiResponse');
const { jmaDownloadMetrics } = require('./lib/jmaDownloadMetrics');

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
const NERV_ENABLED = process.env.NERV_ENABLED !== 'false';
const NERV_POLL_INTERVAL_MS = Number(process.env.NERV_POLL_INTERVAL_MS || 60 * 1000);
const NERV_STREAM_ENABLED = NERV_ENABLED && process.env.NERV_STREAM_ENABLED !== 'false';
const NERV_STREAM_URL = process.env.NERV_STREAM_URL
  || 'wss://streaming.unnerv.jp/api/v1/streaming?stream=public:local';
const NERV_STREAM_ACCOUNT_ID = process.env.NERV_STREAM_ACCOUNT_ID || '1';
const NERV_STREAM_STATS_INTERVAL_MS = Number(process.env.NERV_STREAM_STATS_INTERVAL_MS || 60 * 1000);
let nervLastUpdate = 0;
let nervSinceId = null;
let nervInitialized = false;
const nervSeenIds = new Set();
let nervPollInFlight = null;
let nervStreamMonitor = null;

const DEBUG_DISCORD_WEBHOOK_URL = process.env.DEBUG_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '';
const discordBot = createDiscordBot();
let discordBotNotificationsReady = false;

if (DEBUG_DISCORD_WEBHOOK_URL) {
  console.log(`✅ Discord webhook 通知: 有効 (${process.env.DEBUG_DISCORD_WEBHOOK_URL ? 'DEBUG_DISCORD_WEBHOOK_URL' : 'DISCORD_WEBHOOK_URL'})`);
} else {
  console.warn('⚠️ Discord webhook 通知: 無効（DEBUG_DISCORD_WEBHOOK_URL または DISCORD_WEBHOOK_URL が未設定）');
}

// 処理済みURLおよびイベントの記録
const processedUrls = new Set();
const processedXmlFingerprints = new Set();
const processedEvents = new Set(); // {eventId} or {originTime:hypocenter}
const eewSeenAreas = new Map();

const MAX_PROCESSED = 1000;
const RETAIN_MS = 3 * 60 * 60 * 1000; 
const EEW_PRIORITY_MS = 30 * 1000;
let eewPriorityUntil = 0;

// WebSocket 状態管理
let isWsConnected = false;
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 5000;
let wsHeartbeatTimer = null;

function scheduleWebSocketReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000);
}

function connectWebSocket() {
  const wsUrl = 'wss://api.p2pquake.net/v2/ws';
  console.log(`📡 WebSocket 接続試行: ${wsUrl}`);
  
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('✅ WebSocket 接続成功 (Project KAKUSHIN)');
    isWsConnected = true;
    wsReconnectDelay = 5000;
    if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      const socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.isAlive = false;
      socket.ping();
      socket.once('pong', () => { socket.isAlive = true; });
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN && socket.isAlive === false) socket.terminate();
      }, 10000);
    }, 30000);
  });

  ws.on('message', (data) => {
    try {
      const json = JSON.parse(data);
      handleP2PQuakeData(json);
    } catch (err) {
      console.error('❌ WebSocket メッセージパースエラー:', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`⚠️ WebSocket 切断されました (code=${code}, reason=${reason || '不明'})`);
    isWsConnected = false;
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
    scheduleWebSocketReconnect();
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket エラー:', err);
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

  if (parsed.isEEW && parsed.eventId) {
    const previousAreas = eewSeenAreas.get(parsed.eventId) || new Set();
    const currentAreas = parsed.eewAreas || [];
    parsed.eewAdditionalAreas = previousAreas.size > 0
      ? currentAreas.filter((area) => !previousAreas.has(area))
      : [];
    eewSeenAreas.set(parsed.eventId, new Set([...previousAreas, ...currentAreas]));
    if (eewSeenAreas.size > MAX_PROCESSED) eewSeenAreas.delete(eewSeenAreas.keys().next().value);
  }

  console.log(`🚀 WebSocket から新規データ受信: ${parsed.isEEW ? 'EEW' : 'Earthquake'}`);
  const formatted = formatEarthquake(parsed);
  if (formatted) {
    addToCache({
      ...formatted,
      originTime: parsed.earthquake?.originTime || parsed.originTime || null,
      sourceTimestamp: parsed.reportTime || null,
      timestamp: new Date().toISOString(),
    });
    markAsProcessed(parsed);
  }
}

function isProcessed(parsed) {
  if (parsed.isEEW && parsed.eventId) {
    const reportKey = parsed.reportId || parsed.serial || parsed.reportTime || 'unknown-report';
    return processedEvents.has(`${parsed.eventId}_${parsed.infoType}_${reportKey}`);
  }
  // 地震情報は 発生時刻+震源地 をキーにする
  const eventKey = `${parsed.originTime}_${parsed.hypocenter}`;
  return processedEvents.has(eventKey);
}

function markAsProcessed(parsed) {
  if (parsed.isEEW && parsed.eventId) {
    const reportKey = parsed.reportId || parsed.serial || parsed.reportTime || 'unknown-report';
    processedEvents.add(`${parsed.eventId}_${parsed.infoType}_${reportKey}`);
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
  const notified = { ...formatted, sentTimestamp: new Date().toISOString() };
  // すでにある同じIDのアイテム（更新前のデータなど）を削除
  const filtered = cache.formatted.filter(item => item.id !== notified.id);
  
  // 新しいデータを追加
  const updatedList = [notified, ...filtered];

  // 優先順位に基づいてソート
  // 1. EEW (緊急地震速報)
  // 2. 津波情報 (tsunami_*)
  // 3. 地震情報 (earthquake_*)
  // 4. その他 (weather, stable等)
  // 同じ階層内では timestamp が新しい順
  updatedList.sort((a, b) => {
    const getPriority = (item) => {
      if (item.type === 'eew') return 0;
      if (item.type.startsWith('tsunami')) return 1;
      if (item.type.startsWith('earthquake')) return 2;
      return 3;
    };

    const pA = getPriority(a);
    const pB = getPriority(b);

    if (pA !== pB) return pA - pB;
    
    // 同じ優先度の場合は時刻の降順（新しい順）
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  cache.formatted = updatedList.slice(0, 10);
  if (notified.type === 'eew') {
    eewPriorityUntil = Date.now() + EEW_PRIORITY_MS;
    console.log(`🚨 EEW優先送出を開始しました（30秒間）`);
  }
  console.log(`📝 キャッシュを更新し、優先順位に基づいてソートしました (Type: ${notified.type})`);
  void sendDiscordDebugMessage(notified, {
    webhookUrl: DEBUG_DISCORD_WEBHOOK_URL,
    fetchImpl: fetch,
  });
  if (discordBot && discordBotNotificationsReady) {
    void discordBot.send(notified).catch((error) => console.error(`❌ Discord Bot 通知エラー: ${error.message}`));
  }
}

async function pollNerv(formattedList = null) {
  if (!NERV_ENABLED) return;
  if (nervPollInFlight) return nervPollInFlight;
  nervPollInFlight = (async () => {
    nervLastUpdate = Date.now();
    try {
      let nervItems = await fetchNervStatuses({ fetchImpl: fetch, sinceId: nervSinceId });
      const latestNervId = nervItems.latestId;
      nervItems.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
      nervItems = nervItems.filter((item) => !nervSeenIds.has(item.id));
      if (!nervInitialized) nervItems = nervItems.slice(-1);
      for (const item of nervItems) {
        const formatted = { ...item, timestamp: item.publishedAt || new Date().toISOString() };
        acceptNervItem(formatted, formattedList);
      }
      if (latestNervId) nervSinceId = latestNervId;
      nervInitialized = true;
      while (nervSeenIds.size > MAX_PROCESSED) nervSeenIds.delete(nervSeenIds.values().next().value);
    } catch (error) {
      console.warn(`⚠️ NERV情報取得をスキップしました: ${error.message}`);
    }
  })().finally(() => { nervPollInFlight = null; });
  return nervPollInFlight;
}

function acceptNervItem(formatted, formattedList = null) {
  if (!formatted?.id || nervSeenIds.has(formatted.id)) return false;
  nervSeenIds.add(formatted.id);
  if (formattedList) formattedList.push(formatted);
  else addToCache(formatted);
  while (nervSeenIds.size > MAX_PROCESSED) {
    nervSeenIds.delete(nervSeenIds.values().next().value);
  }
  return true;
}

function handleNervStreamStatus(status) {
  if (!status || !isNervRelevantStatus(status)) return false;
  const formatted = {
    ...normalizeStatus(status, 'UN_NERV'),
    timestamp: status.created_at || new Date().toISOString(),
  };
  return acceptNervItem(formatted);
}

function rememberProcessed(set, key) {
  set.add(key);
  if (set.size > MAX_PROCESSED) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function getXmlFingerprint(xmlContent) {
  return crypto.createHash('sha256').update(xmlContent).digest('hex');
}

function getReportCacheId(parsed, link) {
  const baseId = parsed.eventId || `${parsed.originTime}_${parsed.hypocenter}` || link;
  const reportKey = [
    parsed.infoKind,
    parsed.infoType,
    parsed.reportDateTime,
    parsed.targetDateTime,
  ].filter(Boolean).join('_');
  return reportKey ? `${baseId}_${reportKey}` : `${baseId}_${link}`;
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
      const feedBuffer = await response.buffer();
      jmaDownloadMetrics.record('feed', feedBuffer.length);
      const xmlText = feedBuffer.toString('utf8');
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
          const xmlBuffer = await res.buffer();
          jmaDownloadMetrics.record('detail', xmlBuffer.length);
          const xmlContent = xmlBuffer.toString('utf8');
          const xmlFingerprint = getXmlFingerprint(xmlContent);

          if (processedXmlFingerprints.has(xmlFingerprint)) {
            console.log(`⏭️ 同一XML本文を処理済みのためスキップ: ${link}`);
            rememberProcessed(processedUrls, link);
            continue;
          }

          if (isEarthquake) {
            const parsed = parseEarthquake(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            const formatted = formatEarthquake(parsed);
            if (formatted) {
              formattedList.push({
                ...formatted,
                id: getReportCacheId(parsed, link),
                eventId: parsed.eventId,
                originTime: parsed.earthquake?.originTime || parsed.originTime || null,
                sourceTimestamp: parsed.reportDateTime || null,
                timestamp: new Date().toISOString()
              });
            }
          } else if (isTsunami) {
            const parsed = parseTsunami(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            formattedList.push({ ...formatTsunami(parsed), sourceTimestamp: parsed.reportDateTime || null, timestamp: new Date().toISOString() });
          } else if (isWeather) {
            const parsed = parseWeather(xmlContent);
            if (parsed.status !== '通常') {
              console.log(`⚠️ 訓練・試験データをスキップ: ${parsed.status} (${link})`);
              continue;
            }
            formattedList.push({ ...formatWeather(parsed), sourceTimestamp: parsed.reportDateTime || null, timestamp: new Date().toISOString() });
          }
          rememberProcessed(processedUrls, link);
          rememberProcessed(processedXmlFingerprints, xmlFingerprint);
        }
      }
    }

    jmaDownloadMetrics.logIfDue();

    if (NERV_ENABLED && now - nervLastUpdate >= NERV_POLL_INTERVAL_MS) {
      await pollNerv(formattedList);
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

// APIへのアクセスがなくてもJMAフィードを監視し、通知を発火させる。
// APIリクエストと同じロックを使うため、同時に複数回フェッチしない。
async function refreshLatestData() {
  if (!fetchPromise) {
    fetchPromise = fetchAndParseFeed().finally(() => {
      fetchPromise = null;
    });
  }
  return fetchPromise;
}

// データ取得の仲介関数（排他制御）
async function getLatestData() {
  const now = Date.now();

  // 設定された保持期間（RETAIN_MS）以上経過したキャッシュアイテムを削除
  if (cache.formatted && cache.formatted.length > 0) {
    const originalCount = cache.formatted.length;
    cache.formatted = cache.formatted.filter((item) => {
      const itemTime = new Date(item.timestamp).getTime();
      // 緊急地震速報 (EEW) は 60 秒経過したら削除
      if (item.type === 'eew') {
        const isExpired = now - itemTime >= 60000;
        if (isExpired) console.log(`⏱️ EEW が 60 秒経過したため削除しました (${item.id})`);
        return !isExpired;
      }
      return now - itemTime < RETAIN_MS;
    });
    if (cache.formatted.length !== originalCount) {
      console.log(`🧹 古いキャッシュを削除しました (${originalCount} -> ${cache.formatted.length})`);
    }
  }

  // いずれかの有効なフィードが更新間隔を超えている、またはキャッシュがない場合
  const anyStale = Object.values(FEEDS).some((feed) => now - feed.lastUpdate > feed.interval)
    || (NERV_ENABLED && now - nervLastUpdate > NERV_POLL_INTERVAL_MS);

  if (anyStale || !cache.formatted || cache.formatted.length === 0) {
    // 既に別のリクエストがフェッチ処理中の場合は、その完了を待つ
    return refreshLatestData();
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
      res.json(toLegacyApiResponse([
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
      ]));
    } catch (err) {
      res.status(500).json({ error: 'テストデータの読み取りに失敗しました。' });
    }
  } else {
    res.status(404).json({ error: `テストデータ (${code}) が見つかりません。先に npm test を実行してください。` });
  }
});

app.get('/jma/latest', async (req, res) => {
  const data = await getLatestData();

  if (Date.now() < eewPriorityUntil) {
    const eewOnly = data.filter((item) => item.type === 'eew');
    if (eewOnly.length > 0) {
      res.json(toLegacyApiResponse(eewOnly));
      return;
    }
  }

  // 地震情報は最新1件だけ返し、津波・気象など他の情報は維持する。
  const earthquakeItems = data.filter((item) => item.type === 'eew' || item.type.startsWith('earthquake'));
  const latestEarthquake = earthquakeItems
    .slice()
    .sort((a, b) => {
      const originDiff = new Date(b.originTime || 0).getTime() - new Date(a.originTime || 0).getTime();
      if (originDiff !== 0) return originDiff;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    })[0];
  const responseData = [
    ...(latestEarthquake ? [latestEarthquake] : []),
    ...data.filter((item) => item.type !== 'eew' && !item.type.startsWith('earthquake')),
  ];

  // 古いクライアントとの互換性のため、データが空の場合は stable を返す
  if (!responseData || responseData.length === 0) {
    res.json(toLegacyApiResponse([
      {
        type: 'stable',
        timestamp: new Date().toISOString(),
        id: 'none',
        lines: [{ text: '現在、発表されている地震・津波情報はありません。', duration: 10 }],
      },
    ]));
    return;
  }

  // Cloudflareエッジキャッシュ用のヘッダを追加
  res.set('Cache-Control', 'public, max-age=60');
  res.json(toLegacyApiResponse(responseData));
});

const sslOptions = {
  key: fs.readFileSync('./ssl/cloudflare.key'),
  cert: fs.readFileSync('./ssl/cloudflare.crt'),
};

// ポートを 443 (HTTPS標準) に変更
const PORT = 443;
https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Full HTTPS JMA API Server running on port ${PORT}`);
  // JSON APIを誰も参照していない場合でも、JMA情報を取り込み通知する。
  // 初回取得は既存情報の基準取り込みとし、Webhookだけ送信してBotの再起動重複を防ぐ。
  await refreshLatestData();
  discordBotNotificationsReady = true;
  console.log('✅ Discord Bot 通知準備完了（初回取得済み）');
  const jmaFeedTimer = setInterval(() => void refreshLatestData(), POLL_INTERVALS.NORMAL);
  jmaFeedTimer.unref?.();
  console.log(`📡 JMA Atom Feed監視を開始しました（${POLL_INTERVALS.NORMAL}ms間隔）`);
  // サーバー起動後に WebSocket 接続を開始
  connectWebSocket();
  if (NERV_ENABLED) {
    console.log(`📡 NERV RESTバックアップ監視を開始しました（${NERV_POLL_INTERVAL_MS}ms間隔）`);
    void pollNerv();
    const nervTimer = setInterval(() => void pollNerv(), NERV_POLL_INTERVAL_MS);
    nervTimer.unref?.();
    if (NERV_STREAM_ENABLED) {
      nervStreamMonitor = createNervStreamMonitor({
        url: NERV_STREAM_URL,
        accountId: NERV_STREAM_ACCOUNT_ID,
        statsIntervalMs: NERV_STREAM_STATS_INTERVAL_MS,
        onStatus: handleNervStreamStatus,
        onReconnect: () => pollNerv(),
      });
      nervStreamMonitor.connect();
      console.log(`📡 NERV Mastodon Streaming監視を開始しました（${NERV_STREAM_URL}）`);
    } else {
      console.log('⏸️ NERV Mastodon Streaming監視は無効です（NERV_STREAM_ENABLED=false）');
    }
  }
});
