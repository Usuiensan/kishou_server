const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createJmaXmlArchive } = require('../lib/jmaXmlArchive');
const { start } = require('../tools/atlas_ingest');

const quiet = { log() {}, error() {} };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jma-xml-archive-'));
const listXml = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.xml')).sort() : [];

test('受信した電文をそのままのバイトで保存する', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, minFreeBytes: 0, logger: quiet });
  const body = Buffer.from('<Report>気象庁電文</Report>', 'utf8');
  assert.equal(archive.enqueue(body, new Date('2026-11-23T09:24:15.123Z')), true);
  await archive.drain();
  const names = listXml(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^20261123T092415123Z-[0-9a-f]{64}\.xml$/);
  assert.deepEqual(fs.readFileSync(path.join(dir, names[0])), body);
  assert.equal(archive.stats().saved, 1);
});

test('パースできない本文や不正なUTF-8でもバイト列を保持する', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, minFreeBytes: 0, logger: quiet });
  const body = Buffer.from([0x3c, 0xff, 0xfe, 0x00, 0x3e]);
  archive.enqueue(body, new Date('2026-11-23T00:00:00.000Z'));
  await archive.drain();
  const names = listXml(dir);
  assert.equal(names.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, names[0])), body);
});

test('同一内容の再送は重複として保存しない', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, minFreeBytes: 0, logger: quiet });
  const body = Buffer.from('<Report>same</Report>');
  archive.enqueue(body, new Date('2026-11-23T00:00:00.000Z'));
  archive.enqueue(body, new Date('2026-11-23T01:00:00.000Z'));
  await archive.drain();
  assert.equal(listXml(dir).length, 1);
  assert.equal(archive.stats().duplicates, 1);
});

test('上限を超えたら最古から削除して合計を上限以内に保つ', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, maxBytes: 100, minFreeBytes: 0, logger: quiet });
  for (let i = 0; i < 5; i++) {
    archive.enqueue(Buffer.from(`<Report>${String(i).padStart(30, 'x')}</Report>`), new Date(Date.UTC(2026, 10, 23, 0, 0, i)));
  }
  await archive.drain();
  const names = listXml(dir);
  const total = names.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert.ok(total <= 100, `total=${total}`);
  assert.ok(archive.stats().evicted >= 3);
  assert.ok(!names.some((name) => name.startsWith('20261123T000000')));
});

test('単体で上限を超える電文は保存しない', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, maxBytes: 10, minFreeBytes: 0, logger: quiet });
  archive.enqueue(Buffer.from('<Report>0123456789abc</Report>'), new Date());
  await archive.drain();
  assert.equal(listXml(dir).length, 0);
  assert.equal(archive.stats().droppedOversize, 1);
});

test('空き容量が下限を割ったら保存を打ち切る', async () => {
  const dir = tempDir();
  const archive = createJmaXmlArchive({ dir, logger: quiet,
    statfsImpl: async () => ({ bavail: 0, bsize: 4096 }) });
  archive.enqueue(Buffer.from('<Report>x</Report>'), new Date());
  await archive.drain();
  assert.equal(listXml(dir).length, 0);
  assert.equal(archive.stats().droppedLowSpace, 1);
});

test('保存先が使えなくても enqueue は例外を投げず欠落として数える', async () => {
  const file = path.join(tempDir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const archive = createJmaXmlArchive({ dir: path.join(file, 'sub'), logger: quiet });
  assert.equal(archive.enqueue(Buffer.from('<Report>x</Report>'), new Date()), false);
  await archive.drain();
  assert.equal(archive.stats().saved, 0);
  assert.ok(archive.stats().droppedError >= 1);
});

test('起動時に残留した一時ファイルを回収し、既存ファイルから集計と重複判定を引き継ぐ', async () => {
  const dir = tempDir();
  const body = Buffer.from('<Report>persist</Report>');
  const first = createJmaXmlArchive({ dir, minFreeBytes: 0, logger: quiet });
  first.enqueue(body, new Date('2026-11-23T00:00:00.000Z'));
  await first.drain();
  fs.writeFileSync(path.join(dir, '.leftover.123.tmp'), 'junk');
  const second = createJmaXmlArchive({ dir, minFreeBytes: 0, logger: quiet });
  assert.equal(fs.existsSync(path.join(dir, '.leftover.123.tmp')), false);
  assert.equal(second.stats().totalBytes, body.length);
  second.enqueue(body, new Date('2026-11-23T02:00:00.000Z'));
  await second.drain();
  assert.equal(listXml(dir).length, 1);
  assert.equal(second.stats().duplicates, 1);
});

test('起動時点で上限を超えていたら最古から削って上限以内にする', async () => {
  const dir = tempDir();
  const first = createJmaXmlArchive({ dir, maxBytes: 10_000, minFreeBytes: 0, logger: quiet });
  for (let i = 0; i < 3; i++) {
    first.enqueue(Buffer.from(`<Report>${String(i).padStart(30, 'y')}</Report>`), new Date(Date.UTC(2026, 10, 23, 0, 0, i)));
  }
  await first.drain();
  assert.equal(listXml(dir).length, 3);
  const second = createJmaXmlArchive({ dir, maxBytes: 60, minFreeBytes: 0, logger: quiet });
  assert.ok(second.stats().totalBytes <= 60);
  assert.equal(listXml(dir).length, 1);
});

test('ingest の /jma は受理・却下にかかわらず受信した XML を保存する', async () => {
  const folder = tempDir();
  const archiveDir = path.join(folder, 'jma-xml');
  const service = start({ statePath: path.join(folder, 'state.json'), port: 0, logger: quiet, xmlArchiveDir: archiveDir, xmlArchiveMinFreeBytes: 0 });
  await once(service.server, 'listening');
  const port = service.server.address().port;
  const post = (body) => fetch(`http://127.0.0.1:${port}/jma`, { method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8' }, body });
  const sample = fs.readFileSync(path.join(__dirname, 'samples', '32-35_06_01_240613_VXSE52.xml'), 'utf8');
  await post(sample);
  await post('<not-a-bulletin/>');
  await service.xmlArchive.drain();
  service.close();
  const names = listXml(archiveDir);
  assert.equal(names.length, 2);
  const contents = names.map((name) => fs.readFileSync(path.join(archiveDir, name), 'utf8'));
  assert.ok(contents.includes(sample));
  assert.ok(contents.includes('<not-a-bulletin/>'));
});

test('ingest の /jma-archive は状態を変えずに XML だけを保存する', async () => {
  const folder = tempDir();
  const archiveDir = path.join(folder, 'jma-xml');
  const service = start({ statePath: path.join(folder, 'state.json'), port: 0, logger: quiet,
    xmlArchiveDir: archiveDir, xmlArchiveMinFreeBytes: 0 });
  await once(service.server, 'listening');
  const port = service.server.address().port;
  const before = service.getState().seq;
  const body = '<Report><Head><InfoKind>火山の状況に関する解説情報</InfoKind></Head></Report>';
  const response = await fetch(`http://127.0.0.1:${port}/jma-archive`, { method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8' }, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { archived: true });
  await service.xmlArchive.drain();
  service.close();
  assert.equal(service.getState().seq, before);
  const names = listXml(archiveDir);
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(archiveDir, names[0]), 'utf8'), body);
});
