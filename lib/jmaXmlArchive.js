"use strict";

// 受信した気象庁XML電文を生バイトのまま保存するアーカイブ。
// - 保存は単一の非同期キューで直列化し、呼び出し元（/jma 応答）を待たせない
// - ファイル名は受信時刻(UTC・ミリ秒)と本文の SHA-256 だけで作る（外部入力をパスに使わない）
// - 同一内容は1件だけ残す。上限を超えたら最古（＝名前順の先頭）から削除する
// - 保存の失敗はすべてここで吸収し、欠落として数える。本処理へ例外を伝播させない

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_PATTERN = /^(\d{8}T\d{9}Z)-([0-9a-f]{64})\.xml$/;
const DEFAULT_MAX_BYTES = 500_000_000;
const DEFAULT_MIN_FREE_BYTES = 1_000_000_000;
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function createJmaXmlArchive({ dir, maxBytes = DEFAULT_MAX_BYTES, minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  logger = console, statfsImpl = null } = {}) {
  if (!dir) throw new TypeError('jma xml archive dir is required');
  const counters = { saved: 0, duplicates: 0, droppedQueue: 0, droppedOversize: 0,
    droppedLowSpace: 0, droppedError: 0, evicted: 0 };
  let entries = []; // { name, size, hash } 名前順＝受信順（最古が先頭）
  let hashes = new Set();
  let totalBytes = 0;
  let broken = false;

  const evictSync = () => {
    while (totalBytes > maxBytes && entries.length > 0) {
      const oldest = entries.shift();
      try { fs.unlinkSync(path.join(dir, oldest.name)); } catch { /* 既に無い場合も集計だけ進める */ }
      totalBytes -= oldest.size;
      hashes.delete(oldest.hash);
      counters.evicted++;
    }
  };

  // 起動時走査: 残留した一時ファイルの回収、既存ファイルからの集計と重複判定の再構築、超過分の解消
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.tmp')) {
        try { fs.unlinkSync(full); } catch { /* 回収できなくても起動は続ける */ }
        continue;
      }
      const match = FILE_PATTERN.exec(name);
      if (!match) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      entries.push({ name, size: stat.size, hash: match[2] });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      hashes.add(entry.hash);
      totalBytes += entry.size;
    }
    evictSync();
  } catch (error) {
    broken = true;
    logger.error(`jma xml archive unavailable at startup: ${error.message}`);
  }

  const evict = async () => {
    while (totalBytes > maxBytes && entries.length > 0) {
      const oldest = entries.shift();
      try { await fs.promises.unlink(path.join(dir, oldest.name)); } catch { /* 集計だけ進める */ }
      totalBytes -= oldest.size;
      hashes.delete(oldest.hash);
      counters.evicted++;
    }
  };

  const processOne = async (buffer, receivedAt) => {
    try {
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hashes.has(hash)) { counters.duplicates++; return; }
      if (buffer.length > maxBytes) {
        counters.droppedOversize++;
        logger.error(`jma xml archive dropped oversize bulletin: ${buffer.length} bytes > max ${maxBytes}`);
        return;
      }
      if (minFreeBytes > 0) {
        try {
          const stat = statfsImpl ? await statfsImpl(dir) : await fs.promises.statfs(dir);
          if (stat.bavail * stat.bsize < minFreeBytes + buffer.length) {
            counters.droppedLowSpace++;
            logger.error('jma xml archive dropped bulletin: free space below reserve');
            return;
          }
        } catch { /* 空き容量を取得できない環境では保存を続ける */ }
      }
      const name = `${formatTimestamp(receivedAt)}-${hash}.xml`;
      const temporary = path.join(dir, `.${name}.${process.pid}.tmp`);
      await fs.promises.writeFile(temporary, buffer);
      await fs.promises.rename(temporary, path.join(dir, name));
      entries.push({ name, size: buffer.length, hash });
      hashes.add(hash);
      totalBytes += buffer.length;
      counters.saved++;
      await evict();
    } catch (error) {
      counters.droppedError++;
      logger.error(`jma xml archive write failed: ${error.message}`);
    }
  };

  let chain = Promise.resolve();
  let queuedBytes = 0;

  const enqueue = (buffer, receivedAt = new Date()) => {
    if (broken) { counters.droppedError++; return false; }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) { counters.droppedError++; return false; }
    if (queuedBytes + buffer.length > MAX_QUEUE_BYTES) {
      counters.droppedQueue++;
      logger.error('jma xml archive queue full; dropping bulletin');
      return false;
    }
    queuedBytes += buffer.length;
    chain = chain.then(() => processOne(buffer, receivedAt))
      .finally(() => { queuedBytes -= buffer.length; });
    return true;
  };

  return {
    enqueue,
    drain: () => chain,
    stats: () => ({ ...counters, totalBytes, files: entries.length, dir }),
  };
}

module.exports = { createJmaXmlArchive, FILE_PATTERN, formatTimestamp, DEFAULT_MAX_BYTES, DEFAULT_MIN_FREE_BYTES };
