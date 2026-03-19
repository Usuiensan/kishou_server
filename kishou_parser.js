const { XMLParser } = require('fast-xml-parser');
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

// キャッシュ管理
const cache = {
  data: null,
  timestamp: 0,
  ttl: 60 * 1000, // 60秒
};

// Atom Feed解析関数
async function parseAtomFeed(url) {
  const response = await fetch(url);
  const xml = await response.text();
  
  const feedObj = parser.parse(xml);
  const entryData = feedObj.feed.entry;
  const entries = Array.isArray(entryData) ? entryData : (entryData ? [entryData] : []);
  
  const result = entries.slice(0, 10).map(entry => ({
    id: entry.id,
    title: entry.title,
    link: entry.link?.href || entry.link,
    published: entry.published,
    summary: entry.summary,
  }));
  
  return result;
}

// ポーリングロジック
async function pollFeed() {
  const now = Date.now();
  
  // 60秒キャッシュ有効か確認
  if (cache.data && now - cache.timestamp < cache.ttl) {
    console.log('📦 キャッシュから返却');
    return cache.data;
  }
  
  console.log('🔄 フィード取得開始');
  
  try {
    const entries = await parseAtomFeed(
      'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml'
    );
    
    // キャッシュ更新
    cache.data = entries;
    cache.timestamp = now;
    
    console.log(`✅ ${entries.length}件取得`);
    return entries;
  } catch (error) {
    console.error('❌ フィード取得エラー:', error);
    return cache.data || [];
  }
}

// API エンドポイント
app.get('/weather', async (req, res) => {
  const entries = await pollFeed();
  
  // VRChat向けJSON生成
  const result = {
    type: 'earthquake_feed',
    entries: entries,
    cached: Date.now() - cache.timestamp < 5000,
    timestamp: new Date().toISOString(),
  };
  
  // Cloudflareキャッシング用ヘッダ
  res.set('Cache-Control', 'public, max-age=60');
  res.json(result);
});

// サーバー起動
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📝 Visit http://localhost:${PORT}/weather`);
});