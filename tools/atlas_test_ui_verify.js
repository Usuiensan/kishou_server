// === ATLAS VERIFY BEGIN ===
const ATLAS_PALETTE = Array.from({length:32}, (_, s) => [85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)]);
const ATLAS_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function atlasCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = ATLAS_CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function atlasSymbolsToBytes(symbols, byteLength, strictPad = true) {
  const count = Math.ceil(byteLength * 8 / 5);
  if (symbols.length !== count) throw new Error('シンボル数が一致しません');
  const data = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength * 8; i++)
    data[i >> 3] |= ((symbols[i / 5 | 0] >> (i % 5)) & 1) << (i % 8);
  if (strictPad) for (let i = byteLength * 8; i < symbols.length * 5; i++)
    if (((symbols[i / 5 | 0] >> (i % 5)) & 1) !== 0) throw new Error('末尾パディングビットが0ではありません');
  return data;
}
function decodeAtlasPacket(rgba, width, height) {
  const checks = [];
  const check = (name, ok, detail='') => { checks.push({name, ok, detail}); if (!ok) throw new Error(name + (detail ? ': ' + detail : '')); };
  const columns = Math.floor(width / 8), rows = Math.floor(height / 8);
  const readSymbol = i => {
    const cx = (i % columns) * 8, cyTop = height - (Math.floor(i / columns) + 1) * 8;
    let r = 0, g = 0, b = 0;
    for (let dy = 2; dy <= 5; dy++) for (let dx = 2; dx <= 5; dx++) {
      const o = ((cyTop + dy) * width + cx + dx) * 4;
      r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2];
    }
    r /= 16; g /= 16; b /= 16;
    let best = 0, bestDist = Infinity;
    for (let s = 0; s < 32; s++) {
      const p = ATLAS_PALETTE[s], d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  };
  const readSymbols = n => Array.from({length: n}, (_, i) => readSymbol(i));
  check('画像サイズが8px単位', width % 8 === 0 && height % 8 === 0, `${width}x${height}`);
  const headerSymbols = readSymbols(45);
  const header = atlasSymbolsToBytes(headerSymbols, 28, false);
  const u16 = (a, o) => a[o] | (a[o + 1] << 8);
  const u32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
  const magic = String.fromCharCode(header[0], header[1]);
  check('マジック A2 / version 2', magic === 'A2' && header[2] === 2, `magic=${magic} version=${header[2]}`);
  const mask = header[3], totalLength = u16(header, 4), sequence = u32(header, 6);
  const timestampMs = Number(BigInt(u32(header, 10)) | (BigInt(u32(header, 14)) << 32n));
  const atlasW = u16(header, 18), atlasH = u16(header, 20), outW = u16(header, 22), outH = u16(header, 24);
  const rectCount = header[26];
  check('ヘッダのAtlas寸法と画像寸法が一致', atlasW === width && atlasH === height, `header=${atlasW}x${atlasH} image=${width}x${height}`);
  check('sectionMask / reserved が有効範囲', (mask & ~7) === 0 && header[27] === 0, `mask=${mask} reserved=${header[27]}`);
  check('全長が32..65535', totalLength >= 32 && totalLength <= 65535, `${totalLength}B`);
  check('Rect数が0..15', rectCount <= 15, `${rectCount}`);
  const cellCount = Math.ceil(totalLength * 8 / 5);
  const usedRows = Math.ceil(cellCount / columns);
  check('データセルが画像内に収まる', cellCount <= columns * rows, `cells=${cellCount} rows=${usedRows}/${rows}`);
  const symbols = readSymbols(cellCount);
  const packet = atlasSymbolsToBytes(symbols, totalLength);
  check('末尾パディングビットが0', true);
  const receivedCrc = u32(packet, totalLength - 4);
  const computedCrc = atlasCrc32(packet.subarray(0, totalLength - 4));
  check('CRC32', receivedCrc === computedCrc, receivedCrc === computedCrc
    ? `一致 (${receivedCrc.toString(16)})`
    : `CRC不一致 (packet=${receivedCrc.toString(16)} / computed=${computedCrc.toString(16)})`);
  const limit = totalLength - 4;
  let pos = 28;
  const need = n => { if (pos + n > limit) throw new Error('セクションが途中で切れています'); };
  const strips = [];
  for (let row = 0; row < usedRows; row++) {
    const cellsInRow = Math.min(columns, cellCount - row * columns);
    strips.push([0, height - (row + 1) * 8, cellsInRow * 8, 8]);
  }
  const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const rects = [];
  for (let i = 0; i < rectCount; i++) {
    need(18);
    const ctl = packet[pos], opacity = packet[pos + 1];
    if ((ctl & ~7) !== 0) throw new Error(`Rect ${i} のcontrolに未定義ビットがあります`);
    const size = (ctl & 2) ? 26 : 18;
    need(size);
    const vals = Array.from({length: 8}, (_, k) => u16(packet, pos + 2 + k * 2));
    const src = vals.slice(0, 4), dst = vals.slice(4, 8);
    const alpha = (ctl & 2) ? Array.from({length: 4}, (_, k) => u16(packet, pos + 18 + k * 2)) : null;
    if (!(dst[2] > 0 && dst[3] > 0 && dst[0] + dst[2] <= outW && dst[1] + dst[3] <= outH))
      throw new Error(`Rect ${i} のdstが出力範囲外です`);
    const dims = (ctl & 1) ? null : [width, height];
    for (const [label, region] of [['src', src], ['alphaSrc', alpha]]) {
      if (!region) continue;
      if (!(region[2] > 0 && region[3] > 0)) throw new Error(`Rect ${i} の${label}寸法が0です`);
      if (dims && !(region[0] + region[2] <= dims[0] && region[1] + region[3] <= dims[1]))
        throw new Error(`Rect ${i} の${label}がAtlas範囲外です`);
      if ((ctl & 1) === 0 && strips.some(strip => intersects(region, strip)))
        throw new Error(`Rect ${i} の${label}がデータセル帯と重なります`);
    }
    rects.push({control: ctl, source: (ctl & 1) ? 'MAIN_VIDEO' : 'ATLAS', mode: (ctl & 2) ? 'ALPHA_PAIR' : 'COPY',
                visible: !!(ctl & 4), opacity, src, dst, alphaSrc: alpha});
    pos += size;
  }
  check('Rect配列の範囲・データ帯非重複', true, `${rectCount}件`);
  let displayFlags = null;
  if (mask & 1) {
    need(2);
    displayFlags = u16(packet, pos); pos += 2;
    if ((displayFlags & ~31) !== 0) throw new Error('display flagsに未定義ビットがあります');
  }
  let tsunami = null;
  if (mask & 2) {
    need(17);
    if ((packet[pos + 16] & 0xF0) !== 0) throw new Error('津波セクションの末尾パディングが0ではありません');
    tsunami = Array.from({length: 66}, (_, i) => (packet[pos + (i >> 2)] >> ((i % 4) * 2)) & 3);
    pos += 17;
  }
  let eewEvents = null;
  if (mask & 4) {
    eewEvents = [];
    need(3);
    const ver = packet[pos], mapping = packet[pos + 1], count = packet[pos + 2]; pos += 3;
    if (ver !== 1 || mapping !== 1) throw new Error('EEWセクションの版が一致しません');
    const ids = new Set();
    for (let e = 0; e < count; e++) {
      need(11);
      const flags = packet[pos], issue = u32(packet, pos + 1), serial = u16(packet, pos + 5);
      const scalePair = packet[pos + 7], areaCount = u16(packet, pos + 8), idLength = packet[pos + 10];
      pos += 11;
      if ((flags & ~15) !== 0) throw new Error('EEWイベントflagsに未定義ビットがあります');
      need(idLength);
      const eventId = new TextDecoder('utf-8', {fatal: true}).decode(packet.subarray(pos, pos + idLength));
      pos += idLength;
      if (!idLength || ids.has(eventId)) throw new Error('EEWイベントIDが空または重複しています');
      ids.add(eventId);
      if ((flags & 1) && areaCount !== 0) throw new Error('取消イベントに区域が含まれています');
      let previousId = -1;
      const areas = [];
      for (let a = 0; a < areaCount; a++) {
        need(6);
        const areaId = u16(packet, pos), scaleByte = packet[pos + 2], aflags = packet[pos + 3];
        const arrival = (packet[pos + 4] | (packet[pos + 5] << 8)) << 16 >> 16;
        pos += 6;
        if (areaId <= previousId) throw new Error('EEW区域IDが昇順・一意ではありません');
        previousId = areaId;
        if ((aflags & ~15) !== 0) throw new Error('EEW区域flagsに未定義ビットがあります');
        if ((aflags & 8) && !(aflags & 4)) throw new Error('newlyAddedなのにwarningTargetではありません');
        if (!(flags & 8) && (aflags & 8)) throw new Error('比較履歴がないのにnewlyAddedが立っています');
        areas.push({areaId, scalePair: scaleByte, areaFlags: aflags, arrivalOffsetSeconds: arrival});
      }
      eewEvents.push({eventId, eventFlags: flags, issueUnixSeconds: issue, serial, maxScalePair: scalePair, areas});
    }
  }
  check('セクションが全長と一致', pos === limit, `consumed=${pos} limit=${limit}`);
  return { ok: true, checks, sequence, timestampMs, totalLength, cellCount, usedRows,
           headerSymbols, rowCellCounts: Array.from({length: usedRows}, (_, row) => Math.min(columns, cellCount - row * columns)),
           atlas: [atlasW, atlasH], output: [outW, outH], rects, displayFlags, tsunami, eewEvents };
}
// === ATLAS VERIFY END ===

const DISPLAY_FLAG_NAMES = ['地震テロップ', 'EEW横型', 'EEW縦型', '津波ミニマップ', 'bit4（仕様: 津波情報テロップ／現行送出: 津波線）'];
const TSUNAMI_NAMES = ['発表なし', '注意報', '警報', '大津波警報'];
const EEW_SCALE_NAMES = ['不明', '0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7', '7以上'];
const EEW_ARRIVAL_NAMES = ['未提供', '未到達', '到達済', 'PLUM・時刻なし'];
const receivedFrames = [];
let lastPresentedFrames = null, droppedFrames = 0, lastReceivedAt = 0, receiveStartedAt = performance.now();
let crcChecks = 0, crcSuccesses = 0;
let headerCanvas, headerContext, lastSenderTimestamp = null, lastReceiverFrameUnixMs = null, lastSequence = null, duplicateFrames = 0, outOfOrderFrames = 0, duplicateSequences = 0, outOfOrderSequences = 0, headerErrors = 0;
const senderAgeSamples = [];
let streamPeerConnection = null, streamConnecting = false, streamOutageAt = null;
let streamRecorder = null, streamRecordingChunks = [];
let lastVerifiedPacket = null;
let deviceComparison = null;
function updateDeviceCompareButton(){$('compareDeviceImages').disabled=!$('deviceReferenceFile').files.length||!$('deviceResultFile').files.length;}
async function compareDeviceImages() {
  const referenceFile=$('deviceReferenceFile').files[0], resultFile=$('deviceResultFile').files[0];
  if(!referenceFile||!resultFile) throw new Error('参照PNGと実機出力PNGを選択してください');
  for(const file of [referenceFile,resultFile]) if(file.type!=='image/png'||file.size>25*1024*1024) throw new Error('PNG形式かつ25MiB以下の画像を選択してください');
  const images=await Promise.all([referenceFile,resultFile].map(file=>createImageBitmap(file)));
  try {
    if(images.some(image=>image.width!==1920||image.height!==1080)) throw new Error('比較画像は1920×1080が必要です');
    const imageData=images.map(image=>{const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);return context.getImageData(0,0,1920,1080);});
    const diff=document.createElement('canvas');diff.width=1920;diff.height=1080;const diffContext=diff.getContext('2d');
    const pixels=diffContext.createImageData(1920,1080);let absoluteError=0,changedPixels=0;
    for(let i=0;i<pixels.data.length;i+=4){let changed=false;for(let channel=0;channel<3;channel++){const delta=Math.abs(imageData[0].data[i+channel]-imageData[1].data[i+channel]);absoluteError+=delta;pixels.data[i+channel]=Math.min(255,delta*4);changed ||= delta!==0;}pixels.data[i+3]=255;if(changed)changedPixels++;}
    diffContext.putImageData(pixels,0,0);
    for(const [id,image] of [['deviceReferencePreview',images[0]],['deviceResultPreview',images[1]],['deviceDiffPreview',diff]]){const canvas=$(id),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);}
    deviceComparison={savedAt:new Date().toISOString(),platform:$('devicePlatform').value,player:$('devicePlayer').value,details:$('deviceDetails').value.trim(),referenceFile:referenceFile.name,resultFile:resultFile.name,width:1920,height:1080,changedPixels,meanAbsoluteError:Number((absoluteError/(1920*1080*3)).toFixed(4)),differenceScale:4};
    $('deviceComparisonStatus').textContent=`比較完了: 変更pixel ${changedPixels.toLocaleString()} / 2,073,600、平均絶対差 ${deviceComparison.meanAbsoluteError}/255（${deviceComparison.platform} / ${deviceComparison.player}）`;
    $('saveDeviceComparison').disabled=false;
  } finally {images.forEach(image=>image.close());}
}
function saveDeviceComparison(){if(!deviceComparison)throw new Error('先に画像を比較してください');downloadBlob(new Blob([JSON.stringify(deviceComparison,null,2)+'\n'],{type:'application/json'}),'atlas-device-comparison.json');}
function updateRectPreview() {
  const select = $('rectPreviewSelect'), color = $('rectColorPreview'), alpha = $('rectAlphaPreview'), destination = $('rectDestinationPreview');
  if (!lastVerifiedPacket || !select || !select.options || !color || !alpha || !destination?.getContext) return;
  if (select.options.length !== lastVerifiedPacket.rects.length + 1) {
    const selected = select.value;
    select.innerHTML = '<option value="">Rectを選択</option>' + lastVerifiedPacket.rects.map((rect, i) => `<option value="${i}">Rect ${i}: ${rect.source} ${rect.mode}</option>`).join('');
    if (selected < lastVerifiedPacket.rects.length) select.value = selected;
  }
  const rect = lastVerifiedPacket.rects[Number(select.value)];
  const clear = canvas => { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); };
  if (!rect) { clear(color); clear(alpha); clear(destination); $('rectDestinationInfo').textContent='Rectを選択'; return; }
  const drawRegion = (canvas, source, region) => {
    const [x, y, width, height] = region;
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(source, x, (source.videoHeight || source.naturalHeight) - y - height, width, height, 0, 0, width, height);
  };
  const source = rect.source === 'ATLAS' ? $('atlasPreview') : $('streamVideo');
  if ((rect.source === 'ATLAS' && source.naturalWidth) || (rect.source === 'MAIN_VIDEO' && source.videoWidth)) drawRegion(color, source, rect.src);
  else clear(color);
  if (rect.alphaSrc && ((rect.source === 'ATLAS' && source.naturalWidth) || (rect.source === 'MAIN_VIDEO' && source.videoWidth))) {
    drawRegion(alpha, source, rect.alphaSrc);
    const ctx = alpha.getContext('2d'), pixels = ctx.getImageData(0, 0, alpha.width, alpha.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luma = Math.round(.2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2]);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = luma; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  } else clear(alpha);
  const output=lastVerifiedPacket.output, scale=Math.min(destination.width/output[0],destination.height/output[1]);
  const left=(destination.width-output[0]*scale)/2, top=(destination.height-output[1]*scale)/2;
  const [dx,dy,dw,dh]=rect.dst, x=left+dx*scale, y=top+dy*scale, w=dw*scale, h=dh*scale;
  const ctx=destination.getContext('2d');ctx.fillStyle='#111827';ctx.fillRect(0,0,destination.width,destination.height);
  ctx.fillStyle='#374151';ctx.fillRect(left,top,output[0]*scale,output[1]*scale);
  const sourceReady=(rect.source==='ATLAS'&&source.naturalWidth)||(rect.source==='MAIN_VIDEO'&&source.videoWidth);
  if(rect.visible&&sourceReady&&color.width&&color.height){ctx.globalAlpha=rect.opacity/255;ctx.drawImage(color,0,0,color.width,color.height,x,y,w,h);ctx.globalAlpha=1;}
  ctx.strokeStyle='#facc15';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(x,y,w,h);ctx.setLineDash([]);
  $('rectDestinationInfo').textContent=`出力${output[0]}×${output[1]} / dst=(${dx},${dy},${dw},${dh}) / ${rect.visible?'表示':'非表示'} opacity=${rect.opacity}`;
}
function runUiAction(action) { Promise.resolve().then(action).catch(error => { $('verifyResult').textContent = '操作失敗: ' + error.message; }); }
function downloadBlob(blob, filename) {
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename;
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
async function saveAtlasPng() {
  const response = await fetch('/test/atlas.png');
  if (!response.ok) throw new Error('Atlas PNG取得 HTTP ' + response.status);
  downloadBlob(await response.blob(), 'atlas-renderer.png');
}
function saveVideoFrame() {
  const video = $('streamVideo');
  if (!video.videoWidth || video.readyState < 2) throw new Error('受信フレームがありません');
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => { if (blob) downloadBlob(blob, 'atlas-received-frame.png'); }, 'image/png');
}
function toggleStreamRecording() {
  const button = $('recordStream');
  if (streamRecorder?.state === 'recording') { streamRecorder.stop(); button.textContent = '受信動画を録画'; return; }
  const video = $('streamVideo');
  if (!video.captureStream || !window.MediaRecorder) throw new Error('このブラウザは動画録画に対応していません');
  streamRecordingChunks = [];
  streamRecorder = new MediaRecorder(video.captureStream());
  streamRecorder.ondataavailable = event => { if (event.data.size) streamRecordingChunks.push(event.data); };
  streamRecorder.onstop = () => { downloadBlob(new Blob(streamRecordingChunks, {type:streamRecorder.mimeType || 'video/webm'}), 'atlas-received-stream.webm'); streamRecordingChunks = []; };
  streamRecorder.start(); button.textContent = '録画を停止';
}
function saveValidationLog() {
  const log = Object.fromEntries(['streamState','verifyVerdict','verifySummary','verifyResult','receiveMetrics','stageMetrics'].map(id => [id, $(id).textContent]));
  log.savedAt = new Date().toISOString();
  log.operationHistory = getOperationHistory();
  downloadBlob(new Blob([JSON.stringify(log, null, 2)], {type:'application/json'}), 'atlas-validation-log.json');
}
function readPresentedAtlasHeader(rgba, width, height) {
  if (width < 360 || width % 8 || height < 8 || height % 8) throw new Error('Atlas dimensions cannot contain the A2 header');
  const symbols = [];
  for (let i = 0; i < 45; i++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 2; dy <= 5; dy++) for (let dx = 2; dx <= 5; dx++) {
      const offset = (dy * 360 + i * 8 + dx) * 4;
      r += rgba[offset]; g += rgba[offset + 1]; b += rgba[offset + 2];
    }
    r /= 16; g /= 16; b /= 16;
    let best = 0, distance = Infinity;
    for (let s = 0; s < ATLAS_PALETTE.length; s++) {
      const p = ATLAS_PALETTE[s], d = (r-p[0])**2 + (g-p[1])**2 + (b-p[2])**2;
      if (d < distance) { best = s; distance = d; }
    }
    symbols.push(best);
  }
  const bytes = atlasSymbolsToBytes(symbols, 28, false);
  const u16 = (o) => bytes[o] | (bytes[o+1] << 8);
  const u32 = (o) => (bytes[o] | (bytes[o+1] << 8) | (bytes[o+2] << 16) | (bytes[o+3] << 24)) >>> 0;
  if (bytes[0] !== 65 || bytes[1] !== 50 || bytes[2] !== 2) throw new Error('A2 header magic/version mismatch');
  if (u16(18) !== width || u16(20) !== height) throw new Error('A2 header dimensions mismatch');
  const timestampMs = BigInt(u32(10)) | (BigInt(u32(14)) << 32n);
  return {sequence:u32(6), timestampMs};
}
function sampleReceivedFrame(now, metadata) {
  markStreamRecovered(now);
  lastReceivedAt = now;
  const receiverFrameUnixMs = Date.now();
  receivedFrames.push(now);
  while (receivedFrames.length > 300 || (receivedFrames.length > 1 && now - receivedFrames[0] > 10000)) receivedFrames.shift();
  if (lastPresentedFrames !== null && metadata.presentedFrames > lastPresentedFrames + 1) droppedFrames += metadata.presentedFrames - lastPresentedFrames - 1;
  lastPresentedFrames = metadata.presentedFrames;
  const video = $('streamVideo');
  try {
    if (!headerCanvas) {
      headerCanvas = document.createElement('canvas'); headerCanvas.width = 360; headerCanvas.height = 8;
      headerContext = headerCanvas.getContext('2d', {willReadFrequently:true});
    }
    headerContext.drawImage(video, 0, video.videoHeight - 8, 360, 8, 0, 0, 360, 8);
    const header = readPresentedAtlasHeader(headerContext.getImageData(0, 0, 360, 8).data, video.videoWidth, video.videoHeight);
    if (header.timestampMs === lastSenderTimestamp) duplicateFrames++;
    else if (lastSenderTimestamp !== null && header.timestampMs < lastSenderTimestamp) outOfOrderFrames++;
    if (header.sequence === lastSequence) duplicateSequences++;
    else if (lastSequence !== null && ((header.sequence - lastSequence) >>> 0) >= 0x80000000) outOfOrderSequences++;
    lastSenderTimestamp = header.timestampMs;
    lastReceiverFrameUnixMs = receiverFrameUnixMs;
    lastSequence = header.sequence;
    senderAgeSamples.push(receiverFrameUnixMs - Number(header.timestampMs));
    if (senderAgeSamples.length > 300) senderAgeSamples.shift();
  } catch { headerErrors++; }
  const intervals = receivedFrames.slice(1).map((time, i) => time - receivedFrames[i]).sort((a,b) => a-b);
  const span = receivedFrames.length > 1 ? receivedFrames.at(-1) - receivedFrames[0] : 0;
  const fps = span > 0 ? (receivedFrames.length - 1) * 1000 / span : 0;
  const p95 = intervals.length ? intervals[Math.min(intervals.length - 1, Math.ceil(intervals.length * .95) - 1)] : 0;
  const average = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0;
  const maximum = intervals.length ? intervals[intervals.length - 1] : 0;
  const senderAges = [...senderAgeSamples].sort((a,b) => a-b);
  const ageAverage = senderAges.length ? senderAges.reduce((sum,value) => sum + value, 0) / senderAges.length : null;
  const ageP95 = senderAges.length ? senderAges[Math.ceil(senderAges.length * .95)-1] : null;
  const ageMaximum = senderAges.length ? senderAges[senderAges.length-1] : null;
  $('receiveMetrics').textContent = `受信実測: ${fps.toFixed(1)} FPS / 間隔 平均 ${average.toFixed(1)} ms・最大 ${maximum.toFixed(1)} ms・p95 ${p95.toFixed(1)} ms / Chromium drop ${droppedFrames} / A2 timestamp重複 ${duplicateFrames}・逆行 ${outOfOrderFrames} / sequence重複 ${duplicateSequences}・逆行 ${outOfOrderSequences}・header異常 ${headerErrors} / 送信時刻age 平均 ${ageAverage?.toFixed(0) ?? '—'} ms・最大 ${ageMaximum ?? '—'} ms・p95 ${ageP95 ?? '—'} ms`;
  video.requestVideoFrameCallback(sampleReceivedFrame);
}
function refreshAtlasPreview() { const image = $('atlasPreview'); image.src = '/test/atlas.png?t=' + Date.now(); }
function showReceiveStall() {
  const reference = lastReceivedAt || receiveStartedAt, age = performance.now() - reference;
  if (age > 2000) $('receiveMetrics').textContent = `${lastReceivedAt ? '受信停止' : '未受信'}: ${lastReceivedAt ? '最終フレームから' : '接続開始から'} ${(age / 1000).toFixed(1)} 秒`;
}
async function refreshStageMetrics() {
  try {
    const response = await fetch('/test/metrics');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const metrics = await response.json();
    const labels = {chromiumCapture:'Chromium capture',pngConversion:'PNG→RGB変換（変更frame出力率）',a2Encode:'A2 encode',atlasPaint:'Atlas cell描画',ffmpegPipe:'FFmpeg入力pipe待ち',ffmpeg:'FFmpeg encoder'};
    const lines = Object.entries(labels).map(([key,label]) => {
      const value = metrics[key];
      if (!value) return `${label}: 未取得`;
      const at = value.lastAtUnixMs ?? value.measuredAtUnixMs;
      const age = Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 1000) : null;
      if (key === 'ffmpeg') return `${label}: ${value.fps ?? '—'} FPS / ${value.bitrate ?? '—'} / speed ${value.speed ?? '—'} / frame ${value.frame ?? '—'} / ${age?.toFixed(1) ?? '—'}秒前 / ${value.source || ''}`;
      const d = value.durationMs || {};
      const i = value.intervalMs || {};
      return `${label}: ${value.fps ?? '—'} FPS / 処理 平均 ${d.average ?? '—'} ms・最大 ${d.max ?? '—'} ms・p95 ${d.p95 ?? '—'} ms / 間隔 p95 ${i.p95 ?? '—'} ms / ${value.sampleCount} samples / ${age?.toFixed(1) ?? '—'}秒前 / ${value.source || value.stage || ''}`;
    });
    const processes = metrics.processes || {};
    lines.push('プロセス負荷（CPUはサンプル間のプロセスCPU時間差、メモリはWorking Set/RSS）: ' + Object.entries(processes).map(([name, value]) =>
      !value.available ? `${name}: 未取得` : `${name}(PID ${value.pid}): CPU ${value.cpuPercent ?? '測定中'}% / メモリ ${(value.memoryBytes / 1048576).toFixed(1)} MiB`).join(' / '));
    const pcNow = Date.now();
    const rendererAt = metrics.chromiumCapture?.lastAtUnixMs;
    const senderAt = lastSenderTimestamp === null ? null : Number(lastSenderTimestamp);
    const receiverAt = lastReceiverFrameUnixMs;
    const clock = (value) => Number.isFinite(value) ? `${new Date(value).toISOString()} (PCとの差 ${pcNow - value} ms)` : '未取得';
    const senderReceiverDelta = Number.isFinite(senderAt) && Number.isFinite(receiverAt) ? `${receiverAt - senderAt} ms` : '未取得';
    lines.push(`時刻比較 (Unix clock; PC now ${new Date(pcNow).toISOString()}): Renderer ${clock(rendererAt)} / Sender A2 ${clock(senderAt)} / Receiver frame ${clock(receiverAt)} / Sender→receiver ${senderReceiverDelta} (clock offsetとbufferingを含み、片道ネットワーク遅延ではない)`);
    const blink = metrics.chromiumCapture?.blink;
    if (!blink) lines.push('津波点滅: capture側の計測なし');
    else if (!blink.animationCount) lines.push('津波点滅: 有効なtmblinkアニメーションなし');
    else lines.push(`津波点滅: 周期 ${blink.periodMs} ms・ON ${blink.onMs.toFixed(0)} ms・OFF ${blink.offMs.toFixed(0)} ms / 位相 ${blink.phaseMs.toFixed(0)} ms・expected ${blink.expectedVisible ? 'ON' : 'OFF'}・実DOM ${blink.visibleCount}/${blink.animationCount}表示 / 位相ドリフト avg/max/p95 ${blink.phaseDriftMs.average}/${blink.phaseDriftMs.max}/${blink.phaseDriftMs.p95} ms / コピー差 ${blink.phaseSpreadMs.average}/${blink.phaseSpreadMs.max}/${blink.phaseSpreadMs.p95} ms / ${JSON.stringify(blink.groups)}`);
    $('stageMetrics').textContent = lines.join('\n');
  } catch (error) {
    $('stageMetrics').textContent = '処理段階の計測を取得できません: ' + error.message;
  }
}
async function connectStream() {
  const video = $('streamVideo');
  if (streamConnecting) return;
  const url = $('streamUrl').value.trim();
  if (!url) { $('streamState').textContent = '接続状態: URLを入力してください'; return; }
  streamConnecting = true;
  $('streamConnect').disabled = true;
  if (streamPeerConnection) {
    markStreamDisconnected();
    const previous = streamPeerConnection;
    streamPeerConnection = null;
    previous.onconnectionstatechange = null;
    previous.close();
  }
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  receivedFrames.length = 0; senderAgeSamples.length = 0;
  crcChecks = 0; crcSuccesses = 0;
  lastPresentedFrames = null; droppedFrames = 0; lastReceivedAt = 0;
  lastSenderTimestamp = null; lastReceiverFrameUnixMs = null; lastSequence = null; duplicateFrames = 0; outOfOrderFrames = 0; duplicateSequences = 0; outOfOrderSequences = 0; headerErrors = 0;
  receiveStartedAt = performance.now();
  $('receiveMetrics').textContent = '受信フレーム計測: 接続待機中';
  try {
    if ($('streamMethod').value === 'media') {
      $('streamState').textContent = '接続状態: 動画URLを読込中';
      video.src = url;
      video.onerror = () => { $('streamState').textContent = '接続状態: 動画URLの読込失敗'; };
      await video.play();
      $('streamState').textContent = '接続状態: 動画再生中';
      video.requestVideoFrameCallback(sampleReceivedFrame);
    } else {
      $('streamState').textContent = '接続状態: WHEP接続中';
      const pc = streamPeerConnection = new RTCPeerConnection();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = event => { video.srcObject = event.streams[0]; };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') markStreamDisconnected();
        else $('streamState').textContent = '接続状態: ' + pc.connectionState;
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const onChange = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', onChange);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', onChange);
      });
      const response = await fetch(url, {method:'POST', headers:{'content-type':'application/sdp'}, body:pc.localDescription.sdp});
      if (!response.ok) throw new Error('WHEP応答 HTTP ' + response.status);
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      video.requestVideoFrameCallback(sampleReceivedFrame);
      video.play().catch(() => {});
    }
  } catch (e) {
    $('streamState').textContent = '接続状態: 失敗';
    $('verifyVerdict').textContent = '異常';
    $('verifyVerdict').className = 'verdict ng';
    $('verifyResult').textContent = 'ストリーム接続エラー: ' + e.message;
  } finally {
    streamConnecting = false;
    $('streamConnect').disabled = false;
  }
}
function markStreamDisconnected(now=performance.now()) {
  if(streamOutageAt===null)streamOutageAt=now;
  const video=$('streamVideo'), frame=$('lastValidFrame');
  if(video.videoWidth&&video.readyState>=2){frame.width=video.videoWidth;frame.height=video.videoHeight;frame.getContext('2d').drawImage(video,0,0);frame.hidden=false;}
  $('streamState').textContent='接続状態: 切断 / 接続・再接続を押してください。最後の有効なA2表示は保持中';
}
function markStreamRecovered(now=performance.now()) {
  if(streamOutageAt===null)return;
  const duration=Math.max(0,now-streamOutageAt);
  streamOutageAt=null;
  $('lastValidFrame').hidden=true;
  $('streamState').textContent=`接続状態: 復旧 / 映像再受信まで ${duration.toFixed(0)} ms`;
}
function verifyStreamFrame() {
  const video = $('streamVideo');
  if (!video.videoWidth || video.readyState < 2) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = decodeAtlasPacket(pixels, canvas.width, canvas.height);
    crcChecks++; crcSuccesses++;
    lastVerifiedPacket = result;
    const ageSeconds = Math.max(0, (Date.now() - result.timestampMs) / 1000);
    const flags = result.displayFlags === null ? '（セクションなし）'
      : DISPLAY_FLAG_NAMES.filter((_, i) => result.displayFlags & (1 << i)).join('・') || 'なし';
    const tsunamiText = result.tsunami === null ? '（セクションなし）'
      : result.tsunami.map((level, i) => `${tsunamiAreaDefinitions[i]?.code ?? i}: ${tsunamiAreaDefinitions[i]?.name || '区域名未取得'} ${TSUNAMI_NAMES[level]}`).join(' / ');
    const eewText = result.eewEvents === null || result.eewEvents === undefined ? '（セクションなし）'
      : result.eewEvents.map(e => {
        const flags = ['取消','警報対象集合完全','予測区域集合完全','前報比較可能'].filter((_, i) => e.eventFlags & (1 << i)).join('・') || 'なし';
        const areas = e.areas.map(area => {
          const scale = `${EEW_SCALE_NAMES[area.scalePair & 15] || '不正'}〜${EEW_SCALE_NAMES[area.scalePair >> 4] || '不正'}`;
          const areaFlags = ['警報対象','新規追加'].filter((_, i) => area.areaFlags & (1 << (i + 2))).join('・') || 'なし';
          return `${area.areaId} ${eewAreaDefinitions.find(item => item.areaId === area.areaId)?.name || '区域名未取得'} 震度${scale} ${areaFlags} ${EEW_ARRIVAL_NAMES[area.areaFlags & 3]} ${area.arrivalOffsetSeconds}s`;
        }).join(' / ') || '区域なし';
        return `${e.eventId} 発表秒${e.issueUnixSeconds} 第${e.serial}報 最大震度${EEW_SCALE_NAMES[e.maxScalePair & 15] || '不正'}〜${EEW_SCALE_NAMES[e.maxScalePair >> 4] || '不正'} flags=${flags} / ${areas}`;
      }).join(' | ') || 'なし';
    $('verifyVerdict').textContent = '正常';
    $('verifyVerdict').className = 'verdict ok';
    $('verifySummary').textContent = `seq=${result.sequence} / ${result.totalLength}B / Rect ${result.rects.length}件 / A2検証成功率 ${crcSuccesses}/${crcChecks} (${(100*crcSuccesses/crcChecks).toFixed(1)}%) / ${new Date(result.timestampMs).toLocaleTimeString('ja-JP')} 時点 (${ageSeconds.toFixed(1)}秒前)`;
    $('verifyResult').textContent = [
      `チェック: ${result.checks.map(c => '✓ ' + c.name).join(' / ')}`,
      `Atlas: ${result.atlas[0]}x${result.atlas[1]} / 出力: ${result.output[0]}x${result.output[1]} / セル: ${result.cellCount}（${result.usedRows}行）`,
      `colour32セル: ${result.cellCount}個 / 行ごと: ${result.rowCellCounts.join(',')}個`,
      `45セルheader: ${result.headerSymbols.map(symbol => `s${symbol}`).join(' ')}`,
      `A2実表示フラグ（送信映像の実値）: ${flags}`,
      `津波: ${tsunamiText}`,
      `EEW: ${eewText}`,
      'Rect:',
      ...result.rects.map((r, i) => `  ${i}: ${r.source} ${r.mode} ${r.visible ? '表示' : '非表示'} opacity=${r.opacity} src=(${r.src.join(',')}) dst=(${r.dst.join(',')})` + (r.alphaSrc ? ` alpha=(${r.alphaSrc.join(',')})` : '')),
    ].join('\n');
    updateRectPreview();
  } catch (e) {
    crcChecks++;
    $('verifyVerdict').textContent = '異常';
    $('verifyVerdict').className = 'verdict ng';
    $('verifySummary').textContent = `A2検証成功率 ${crcSuccesses}/${crcChecks} (${(100*crcSuccesses/crcChecks).toFixed(1)}%)`;
    $('verifyResult').textContent = '検証エラー: ' + e.message;
  }
}
$('streamUrl').value = `http://${location.hostname}:8889/bosai/whep`;
connectStream(); refreshStageMetrics(); setInterval(verifyStreamFrame, 2000); setInterval(refreshAtlasPreview, 500); setInterval(showReceiveStall, 1000); setInterval(refreshStageMetrics, 2000);
