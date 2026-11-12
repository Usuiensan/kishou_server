const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ingestTestEvents } = require('../tools/atlas_ingest');
const { createAtlasData, createAtlasSnapshot } = require('../lib/atlasData');
const tsunamiZones = require('../protocol/atlas-ii-tsunami-areas-v1.json').zones;
const eewZones = require('../protocol/atlas-ii-eew-areas-v1.json').zones;

test('状態更新中も適用前のレイアウト選択を保持する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const element = (id) => elements[id] ||= {
    value: '', innerHTML: '', textContent: '', classList: { toggle() {} }, append() {},
  };
  const context = { document: { getElementById: element, createTextNode() {}, createElement: () => ({}) },
    fetch: () => new Promise(() => {}), setInterval() {} };
  vm.runInNewContext(script, context);
  const status = { ingest: { atlasIIConfig: { activeLayout: 'full', layouts: { full: [], reverseL: [] } } } };
  context.updateControls(status);
  element('layout').value = 'reverseL';
  context.updateControls(status);
  assert.equal(element('layout').value, 'reverseL');
});

test('自由設定EEWをJMA細分区域と独立した警報・予測集合から生成する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const element = () => ({ value: '' });
  const context = { document: { getElementById: element, createTextNode() {}, createElement: () => ({}) }, fetch: () => new Promise(() => {}), setInterval() {}, TextEncoder };
  vm.runInNewContext(script, context);
  const bulletin = context.buildCustomEEWBulletin({ eventId: 'free-eew', serial: 2, infoType: '続報', hypocenterName: '試験震源', latitude: 35.25, longitude: 140.75, maxScale: 50, isWarning: true, warningSetComplete: true, predictionSetComplete: true }, [
    { name: '茨城県南部', pref: '茨城', warning: true, prediction: true, scaleFrom: 40, scaleTo: 45, arrivalKind: 10, arrivalOffsetSeconds: 30 },
    { name: '千葉県北西部', pref: '千葉', warning: false, prediction: true, scaleFrom: 30, scaleTo: '以上', arrivalKind: 19, arrivalOffsetSeconds: null },
  ], new Date('2026-11-12T00:00:00Z'));
  assert.equal(bulletin.earthquake.hypocenter.coordinate, '+35.25+140.75');
  assert.equal(bulletin.eewForecastAreas.length, 2);
  assert.equal(bulletin.eewAreaDetails.length, 1);
  assert.equal(bulletin.eewForecastAreas[0].arrivalTime, '2026-11-12T00:00:30.000Z');
  assert.equal(bulletin.eewForecastAreas[1].kindCode, 19);
  assert.equal(bulletin.warningSetComplete, true);
  const event = createAtlasData('eew', bulletin).payload.atlasII;
  assert.equal(event.eventFlags & 6, 6);
  assert.equal(event.areas.length, 2);
  assert.equal(event.areas[0].areaFlags & 4, 4);
  assert.equal(event.areas[0].arrivalOffsetSeconds, 30);
  assert.equal(event.areas[1].scalePair >> 4, 11);
  const incompleteWarning = createAtlasData('eew', { ...bulletin, warningSetComplete:false, isWarning:false }).payload.atlasII;
  assert.equal(incompleteWarning.eventFlags & 2, 0);
  assert.equal(incompleteWarning.areas[0].areaFlags & 4, 0);
  const cancel = context.buildCustomEEWBulletin({ eventId: 'free-eew', serial: 3, infoType: '取消', hypocenterName: '試験震源', latitude: 35, longitude: 140, maxScale: 50, warningSetComplete: true, predictionSetComplete: true }, [], new Date('2026-11-12T00:01:00Z'));
  assert.equal(createAtlasData('eew', cancel).payload.atlasII.eventFlags & 7, 1);
  assert.throws(() => context.buildCustomEEWBulletin({ ...bulletin, eventId: '' }, [], new Date()), /地震ID/);
});

test('自由設定の震度情報は最大震度・地域/市町村・津波見通しを保持する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { document:{getElementById:()=>({value:''}),createTextNode(){},createElement:()=>({})},fetch:()=>new Promise(()=>{}),setInterval(){},TextEncoder };
  vm.runInNewContext(script, context);
  const bulletin = context.buildCustomIntensityBulletin({eventId:'intensity-free',serial:2,infoType:'続報',infoKind:'震源・震度情報',maxInt:'5+',originTime:'10時30分',hypocenterName:'能登半島沖',coordinate:'+37.0+137.0',depth:'深さ10ｋｍ',magnitude:'5.2',tsunamiWorry:'published'},
    {regions:{'5+':['石川県能登'],'4':['富山県東部']},cities:{'6-':['輪島市']},prefectures:[{name:'石川県',maxInt:'5+'}]},new Date('2026-11-12T00:00:00Z'));
  assert.equal(bulletin.eventId,'intensity-free');
  assert.equal(bulletin.intensity.maxInt,'5+');
  assert.deepEqual(Object.keys(bulletin.intensity.groups),['4','5+']);
  assert.deepEqual(bulletin.intensity.cityGroups['6-'],['輪島市']);
  assert.equal(bulletin.tsunamiWorry,true);
  const payload=createAtlasData('intensity',bulletin).payload;
  assert.ok(payload.lines.some(line=>line.includes('津波情報が発表されています')));
  assert.ok(payload.lines.some(line=>line.includes('輪島市')));
  assert.equal(payload.summaryFrames.length,2);
  assert.ok(payload.summaryFrames[0].lines[0].includes('北陸地方'));
  assert.ok(payload.summaryFrames[1].lines.some(line=>line.includes('能登半島沖')));
  assert.equal(context.buildCustomIntensityBulletin({eventId:'x',serial:1,infoType:'発表',infoKind:'震度速報',maxInt:'4',tsunamiWorry:'none'},{}).tsunamiWorry,false);
  assert.equal(context.buildCustomIntensityBulletin({eventId:'x',serial:1,infoType:'発表',infoKind:'震度速報',maxInt:'4',tsunamiWorry:'caution'},{}).tsunamiWorry,null);
  assert.throws(()=>context.buildCustomIntensityBulletin({eventId:'x',serial:1,infoType:'発表',infoKind:'震度速報',maxInt:'8'},{}),/最大震度/);
});

test('震度自由生成は続報・同内容再送・旧報・取消を同一イベントで遷移する', () => {
  const page=fs.readFileSync('tools/atlas_test_ui.html','utf8'), script=page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context={document:{getElementById:()=>({value:''}),createTextNode(){},createElement:()=>({})},fetch:()=>new Promise(()=>{}),setInterval(){},TextEncoder};vm.runInNewContext(script,context);
  const at=new Date('2026-11-12T00:00:00Z'), areas={prefectures:[{name:'宮城県',maxInt:'5+'}],regions:{'5+':['宮城県北部']},cities:{'5+':['石巻市']}};
  const build=(serial,infoType,maxInt='5+',data=areas)=>context.buildCustomIntensityBulletin({eventId:'series-intensity',serial,infoType,infoKind:'震源・震度情報',maxInt,originTime:'10時00分',hypocenterName:'試験震源',depth:'深さ10ｋｍ',magnitude:'5.0',tsunamiWorry:'caution'},data,new Date(at.getTime()+serial*1000));
  let state=ingestTestEvents(createAtlasSnapshot(),{events:[{kind:'intensity',bulletin:build(1,'発表')},{kind:'vertical',bulletin:build(1,'発表')}]},at.getTime()).state;
  state=ingestTestEvents(state,{events:[{kind:'intensity',bulletin:build(2,'続報','6-',{prefectures:[{name:'宮城県',maxInt:'6-'}],regions:{'6-':['宮城県北部']},cities:{'6-':['石巻市','東松島市']}})},{kind:'vertical',bulletin:build(2,'続報','6-',{prefectures:[{name:'宮城県',maxInt:'6-'}],regions:{'6-':['宮城県北部']},cities:{'6-':['石巻市','東松島市']}})}]},at.getTime()+2000).state;
  const resend=build(3,'続報','6-',{prefectures:[{name:'宮城県',maxInt:'6-'}],regions:{'6-':['宮城県北部']},cities:{'6-':['石巻市','東松島市']}});
  state=ingestTestEvents(state,{kind:'intensity',bulletin:resend},at.getTime()+3000).state;
  state=ingestTestEvents(state,{kind:'intensity',bulletin:build(1,'発表')},at.getTime()+4000).state;
  assert.equal(state.layers.intensity.length,1);assert.equal(state.layers.intensity[0].event.serial,3);
  assert.deepEqual(state.layers.intensity[0].payload.render.cityGroups['6-'],['石巻市','東松島市']);
  state=ingestTestEvents(state,{events:[{kind:'intensity',bulletin:build(4,'取消')},{kind:'vertical',bulletin:build(4,'取消')}]},at.getTime()+5000).state;
  assert.equal(state.layers.intensity[0].action,'cancel');assert.equal(state.layers.vertical[0].action,'cancel');
});

test('同じEEW IDの区域追加・削除・取消で比較フラグを更新する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { document: { getElementById: () => ({ value: '' }), createTextNode() {}, createElement: () => ({}) }, fetch: () => new Promise(() => {}), setInterval() {}, TextEncoder };
  vm.runInNewContext(script, context);
  const form = { eventId:'series-1', serial:1, infoType:'発表', hypocenterName:'試験', latitude:35, longitude:140, maxScale:45, isWarning:true, warningSetComplete:true, predictionSetComplete:true };
  const at = new Date('2026-11-12T00:00:00Z');
  let state = ingestTestEvents(createAtlasSnapshot(), { kind:'eew', bulletin:context.buildCustomEEWBulletin(form,[{name:'茨城県南部',pref:'茨城県',warning:true,prediction:true,scaleFrom:40,scaleTo:45,arrivalKind:10,arrivalOffsetSeconds:20}],at) }, at.getTime()).state;
  const next = context.buildCustomEEWBulletin({ ...form, serial:2, infoType:'最終報' },[{name:'千葉県北西部',pref:'千葉県',warning:true,prediction:true,scaleFrom:30,scaleTo:40,arrivalKind:19,arrivalOffsetSeconds:null}],new Date(at.getTime()+5000));
  state = ingestTestEvents(state, { kind:'eew', bulletin:next }, at.getTime()+5000).state;
  let event = state.layers.eew[0].payload.atlasII;
  assert.equal(state.layers.eew.length, 1);
  assert.equal(event.eventFlags & 8, 8);
  assert.equal(event.areas.length, 1);
  assert.equal(event.areas[0].areaFlags & 8, 8);
  const cancel = context.buildCustomEEWBulletin({ ...form, serial:3, infoType:'取消' },[],new Date(at.getTime()+10000));
  state = ingestTestEvents(state, { kind:'eew', bulletin:cancel }, at.getTime()+10000).state;
  event = state.layers.eew[0].payload.atlasII;
  assert.equal(event.eventFlags & 7, 1);
  assert.deepEqual(event.areas, []);
});

test('津波自由生成は選択した66区域の危険度・高さ・第一波を正本データへ変換する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { document:{getElementById:()=>({value:''}),createTextNode(){},createElement:()=>({})},fetch:()=>new Promise(()=>{}),setInterval(){},TextEncoder };
  vm.runInNewContext(script,context);
  const bulletin=context.buildCustomTsunamiBulletin({eventId:'tsunami-free',serial:2,infoType:'更新'},[
    {code:100,name:'北海道太平洋沿岸東部',severity:1,height:'1m',arrivalMode:'unknown'},
    {code:101,name:'北海道太平洋沿岸中部',severity:2,height:'3m',arrivalMode:'soon'},
    {code:360,name:'石川県能登',severity:3,height:'5m',arrivalMode:'arrived'},
    {code:102,name:'北海道太平洋沿岸西部',severity:1,height:'2m',arrivalMode:'time',arrivalTime:'2026-11-12T00:15:00Z'},
  ],new Date('2026-11-12T00:00:00Z'));
  const data=createAtlasData('tsunami',bulletin);
  assert.equal(data.payload.atlasII[0],1);
  assert.equal(data.payload.atlasII[1],2);
  assert.equal(data.payload.atlasII[24],3);
  assert.equal(data.payload.tsunamiFrames[0].arrival,'到達時刻不明');
  assert.equal(data.payload.tsunamiFrames[1].arrival,'すぐ来る');
  assert.equal(data.payload.tsunamiFrames[2].arrival,'到達か');
  assert.equal(data.payload.tsunamiFrames[2].height,'5m');
  assert.equal(data.payload.tsunamiFrames[3].arrival,'09:15');
  const zones=require('../protocol/atlas-ii-tsunami-areas-v1.json').zones;
  const allZones=context.buildCustomTsunamiBulletin({eventId:'all-66',serial:1,infoType:'発表'},zones.map((zone,index)=>({code:zone.code,name:zone.name,severity:index%4,height:'不明',arrivalMode:'unknown'})),new Date());
  const allLevels=createAtlasData('tsunami',allZones).payload.atlasII;
  assert.equal(allLevels.length,66);
  assert.deepEqual([...allLevels],zones.map((_,index)=>index%4));
  assert.equal(createAtlasData('tsunami',context.buildCustomTsunamiBulletin({eventId:'tsunami-free',serial:3,infoType:'取消'},[],new Date())).action,'cancel');
});

test('津波の同一イベント更新で危険度と区域追加を置換し、別イベントは併存する', () => {
  const page=fs.readFileSync('tools/atlas_test_ui.html','utf8'), script=page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context={document:{getElementById:()=>({value:''}),createTextNode(){},createElement:()=>({})},fetch:()=>new Promise(()=>{}),setInterval(){},TextEncoder};
  vm.runInNewContext(script,context);
  const now=new Date('2026-11-12T00:00:00Z');
  const build=(eventId,serial,infoType,areas)=>context.buildCustomTsunamiBulletin({eventId,serial,infoType},areas,now);
  let state=ingestTestEvents(createAtlasSnapshot(),{kind:'tsunami',bulletin:build('tsunami-series',1,'発表',[
    {code:360,name:'石川県能登',severity:3,height:'5m',arrivalMode:'soon'},
  ])},now.getTime()).state;
  state=ingestTestEvents(state,{kind:'tsunami',bulletin:build('tsunami-series',2,'更新',[
    {code:360,name:'石川県能登',severity:2,height:'3m',arrivalMode:'arrived'},
    {code:100,name:'北海道太平洋沿岸東部',severity:1,height:'1m',arrivalMode:'unknown',additional:true},
  ])},now.getTime()+1000).state;
  assert.equal(state.layers.tsunami.length,1);
  assert.equal(state.layers.tsunami[0].payload.atlasII[24],2);
  assert.equal(state.layers.tsunami[0].payload.atlasII[0],1);
  assert.equal(state.layers.tsunami[0].payload.tsunamiFrames[1].additional,true);
  state=ingestTestEvents(state,{kind:'tsunami',bulletin:build('tsunami-series',3,'更新',[
    {code:360,name:'石川県能登',severity:1,height:'1m',arrivalMode:'unknown'},
  ])},now.getTime()+1500).state;
  assert.equal(state.layers.tsunami[0].payload.atlasII[24],1);
  state=ingestTestEvents(state,{kind:'tsunami',bulletin:build('other-tsunami',1,'発表',[
    {code:101,name:'北海道太平洋沿岸中部',severity:1,height:'1m',arrivalMode:'unknown'},
  ])},now.getTime()+2000).state;
  assert.equal(state.layers.tsunami.length,2);
  assert.equal(state.layers.tsunami.find(item=>item.event.id==='tsunami-series').payload.atlasII[24],1);
  state=ingestTestEvents(state,{kind:'tsunami',bulletin:build('tsunami-series',4,'取消',[])},now.getTime()+3000).state;
  const cancelled=state.layers.tsunami.find(item=>item.event.id==='tsunami-series');
  assert.equal(cancelled.action,'cancel');
  assert.deepEqual(cancelled.payload.tsunamiFrames,[]);
});

test('受信フレーム計測はFPS・間隔分布・提示落ちを表示する', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const vector = JSON.parse(fs.readFileSync('protocol/atlas-ii-vectors.json', 'utf8')).vectors[0];
  const palette = Array.from({ length: 32 }, (_, s) => [85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)]);
  const rgba = new Uint8ClampedArray(360 * 8 * 4);
  for (let i = 0; i < 45; i++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 360 + i * 8 + x) * 4, color = palette[vector.symbols[i]];
    rgba.set([...color, 255], offset);
  }
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', requestVideoFrameCallback(callback) { this.callback = callback; }, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  class PeerConnection {
    iceGatheringState = 'complete';
    addTransceiver() {}
    async createOffer() { return { type: 'offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {}
  }
  const context = {
    document: { getElementById: element, createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }) }) },
    $: element,
    RTCPeerConnection: PeerConnection,
    fetch: async () => ({ ok: true, text: async () => 'answer' }),
    location: { hostname: 'localhost' },
    setInterval() {},
    performance: { now: () => 200 },
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  const video = element('streamVideo');
  video.videoWidth = 1280; video.videoHeight = 720;
  video.callback(100, { presentedFrames: 1 });
  video.callback(133, { presentedFrames: 2 });
  video.callback(166, { presentedFrames: 4 });
  assert.match(element('receiveMetrics').textContent, /30\.3 FPS/);
  assert.match(element('receiveMetrics').textContent, /平均 33\.0 ms・最大 33\.0 ms・p95 33\.0 ms/);
  assert.match(element('receiveMetrics').textContent, /Chromium drop 1/);
  assert.match(element('receiveMetrics').textContent, /A2重複 2/);
  assert.match(element('receiveMetrics').textContent, /header異常 0/);
});

test('受信映像のA2検証率とセクション内容をベクトルで表示する', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const vector = JSON.parse(fs.readFileSync('protocol/atlas-ii-vectors.json', 'utf8')).vectors[1];
  const palette = Array.from({ length: 32 }, (_, s) => [85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)]);
  const rgba = new Uint8ClampedArray(1280 * 720 * 4);
  vector.symbols.forEach((symbol, i) => {
    const x0 = i % 160 * 8, y0 = 720 - (Math.floor(i / 160) + 1) * 8;
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) rgba.set([...palette[symbol], 255], ((y0 + y) * 1280 + x0 + x) * 4);
  });
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', value: '', videoWidth: 1280, videoHeight: 720, readyState: 2, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  const context = { document: { getElementById: element, createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }) }) },
    $: element, fetch: async (url) => url === '/test/tsunami-areas' ? { ok: true, json: async () => ({ areas: tsunamiZones }) }
      : url === '/test/eew-areas' ? { ok: true, json: async () => ({ areas: eewZones }) } : { ok: true, text: async () => 'answer' }, RTCPeerConnection: class {},
    location: { hostname: 'localhost' }, setInterval() {}, performance: { now: () => 0 }, Date, TextDecoder,
    tsunamiAreaDefinitions: tsunamiZones, eewAreaDefinitions: eewZones };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  context.verifyStreamFrame();
  context.verifyStreamFrame();
  assert.match(element('verifySummary').textContent, /A2検証成功率 2\/2 \(100\.0%\)/, element('verifyResult').textContent);
  assert.match(element('verifyResult').textContent, /地震テロップ・EEW横型・津波ミニマップ/);
  assert.match(element('verifyResult').textContent, /津波: 100: 北海道太平洋沿岸東部 注意報/);
  assert.match(element('verifyResult').textContent, /津波:.*警報.*大津波警報/);
  assert.equal(element('verifyResult').textContent.split('\n').find(line => line.startsWith('津波: ')).split(' / ').length, 66);
  assert.match(element('verifyResult').textContent, /EEW: 20261110000123 .* flags=.*291 区域名未取得 震度/);
  assert.match(element('verifyResult').textContent, /291 区域名未取得 震度.*新規追加/);
  assert.match(element('verifySummary').textContent, /Rect 1件/);
});

test('処理段階の計測は実測値と未取得を区別して表示する', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', requestVideoFrameCallback(callback) { this.callback = callback; }, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  class PeerConnection { addTransceiver() {} async createOffer() { return {}; } async setLocalDescription() { this.localDescription = {}; } async setRemoteDescription() {} }
  let perfNow = 0;
  const context = {
    document: { getElementById: element }, $: element,
    RTCPeerConnection: PeerConnection,
    fetch: async (url) => url === '/test/metrics'
      ? { ok: true, json: async () => ({ chromiumCapture: { fps: 29.5, sampleCount: 10, durationMs: { average: 4, max: 8, p95: 7 }, intervalMs: { p95: 34 }, lastAtUnixMs: Date.now(), blink: { animationCount: 3, periodMs: 3000, onMs: 2253, offMs: 747, phaseMs: 500, expectedVisible: true, visibleCount: 3, phaseDriftMs: { average: 1, max: 2, p95: 2 }, phaseSpreadMs: { average: 0, max: 0, p95: 0 }, groups: { 'tsunami-mini': 1, 'tsunami-mini-left': 1, 'atlas-alpha-mirror': 1 } } }, processes: { renderer: { available: true, pid: 42, cpuPercent: 25, memoryBytes: 10485760 } } }) }
      : { ok: true, text: async () => 'answer' },
    location: { hostname: 'localhost' }, setInterval() {}, performance: { now: () => perfNow }, Date,
  };
  vm.runInNewContext(script, context);
  await context.refreshStageMetrics();
  assert.match(element('stageMetrics').textContent, /Chromium capture: 29\.5 FPS/);
  assert.match(element('stageMetrics').textContent, /津波点滅: 周期 3000 ms・ON 2253 ms・OFF 747 ms/);
  assert.match(element('stageMetrics').textContent, /PNG→RGB変換: 未取得/);
  assert.match(element('stageMetrics').textContent, /FFmpeg encoder: 未取得/);
  assert.match(element('stageMetrics').textContent, /renderer\(PID 42\): CPU 25% \/ メモリ 10\.0 MiB/);
  perfNow = 2100; context.showReceiveStall();
  assert.match(element('receiveMetrics').textContent, /未受信: 接続開始から 2\.1 秒/);
});

test('津波レベルボタンは実際のbulletinを送信し、ingestTestEventsで置換できる', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const element = (id) => elements[id] ||= {
    value: '', innerHTML: '', textContent: '', selectedOptions: [{ value: '100', textContent: '北海道太平洋沿岸東部' }],
    classList: { toggle() {} }, append() {},
  };
  const requests = [];
  const context = { document: { getElementById: element, createTextNode() {}, createElement: () => ({}) },
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ingest: { display: {}, atlasIIConfig: { layouts: {} }, activeLayers: {} } }) };
    }, setInterval() {}, Date };
  vm.runInNewContext(script, context);
  context.presetTsunamiLevel('62');
  context.presetTsunamiLevel('53');
  context.cancelTsunamiPreset();
  const events = requests.filter((request) => request.url === '/test/events');
  assert.equal(events.length, 3);
  let state = createAtlasSnapshot();
  for (const request of events.slice(0, 2)) state = ingestTestEvents(state, request.body).state;
  assert.equal(state.layers.tsunami.length, 1);
  assert.deepEqual(state.layers.tsunami[0].payload.render.major, ['北海道太平洋沿岸東部']);
  assert.equal(state.layers.tsunami[0].payload.atlasII[0], 3);
  state = ingestTestEvents(state, events[2].body).state;
  assert.equal(state.layers.tsunami.length, 1);
  assert.equal(state.layers.tsunami[0].action, 'cancel');
});
