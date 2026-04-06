const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { mapP2PQuakeToEarthquake, mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// ログ設定
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
const logFile = path.join(logDir, `p2p_ws_${timestamp}.log`);

// console.log をオーバーライドしてファイルにも書き込む
const originalLog = console.log;
const originalError = console.error;

const writeToFile = (args) => {
    const message = util.format(...args) + '\n';
    fs.appendFileSync(logFile, message);
};

console.log = (...args) => {
    originalLog(...args);
    writeToFile(args);
};

console.error = (...args) => {
    originalError(...args);
    writeToFile(['[ERROR]', ...args]);
};

// サンドボックスの WebSocket URL
const wsUrl = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws';

console.log(`📡 P2P地震情報 サンドボックス WebSocket 接続中: ${wsUrl}`);
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
    console.log('✅ WebSocket 接続成功。データ受信を待機しています...');
    console.log('※サンドボックスは約30秒に1回データを配信します。');
});

ws.on('message', (data) => {
    try {
        const json = JSON.parse(data);
        console.log('\n--- 📥 Raw Data Received ---');
        console.log(JSON.stringify(json, null, 2));

        let parsed = null;
        let typeLabel = '';

        if (json.code === 551) {
            parsed = mapP2PQuakeToEarthquake(json);
            typeLabel = '地震情報 (551)';
        } else if (json.code === 556) {
            parsed = mapP2PQuakeToEEW(json);
            typeLabel = '緊急地震速報 (556)';
        } else {
            console.log(`ℹ️ 対応していないコードです: ${json.code}`);
            return;
        }

        if (parsed) {
            console.log(`\n--- 🔍 Parsed Result (${typeLabel}) ---`);
            const formatted = formatEarthquake(parsed);
            
            if (formatted) {
                console.log('--- 📤 Formatted Output (JSON) ---');
                console.log(JSON.stringify(formatted, null, 2));

                // console.log('\n--- 📺 Display Text ---');
                // formatted.lines.forEach((line, index) => {
                //     console.log(`Line ${index + 1} (${line.duration}s):`);
                //     console.log(line.text);
                // });
            } else {
                console.log('⏭️ フィルタリング（予報スキップ等）により出力なし');
            }
        }
    } catch (err) {
        console.error('❌ 解析エラー:', err);
    }
});

ws.on('close', () => {
    console.log('⚠️ WebSocket 接続が閉じられました。');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('❌ WebSocket エラー:', err.message);
});

// 10分後に自動終了
setTimeout(() => {
    console.log('⏰ テストを終了します。');
    ws.close();
}, 600000);
