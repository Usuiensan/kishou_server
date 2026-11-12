const $ = id => document.getElementById(id);
const displayState = { tsunamiMap:true, tsunamiLeftMap:true, tsunamiLines:true, eewHorizontal:true, eewVertical:true, earthquakeTelop:true };
const displayButtons = { tsunamiMap:'津波ミニマップ・右下', tsunamiLeftMap:'津波ミニマップ・左帯', tsunamiLines:'津波線', eewHorizontal:'緊急地震速報・横型', eewVertical:'緊急地震速報・縦型', earthquakeTelop:'地震テロップ' };
let scenarioSteps = [];
let tsunamiAreaDefinitions = [], eewAreaDefinitions = [];
let layoutConfig = null, editorLayoutName = null;
const pendingRequests = new Map();
const operationHistoryKey='atlas-test-operation-history-v1';
function getOperationHistory(){try{const history=JSON.parse(localStorage.getItem(operationHistoryKey)||'[]');return Array.isArray(history)?history:[];}catch{return [];}}
function refreshOperationHistory(){if(typeof localStorage==='undefined')return;try{const history=getOperationHistory();$('operationHistory').textContent=history.map(item=>`${item.at} ${item.operation}`).join('\n')||'履歴なし';}catch{$('operationHistory').textContent='履歴を読み込めません';}}
function recordOperationHistory(operation){try{const history=getOperationHistory();history.unshift({at:new Date().toISOString(),operation});localStorage.setItem(operationHistoryKey,JSON.stringify(history.slice(0,100)));refreshOperationHistory();}catch{$('operationHistory').textContent='履歴を保存できません';}}
async function api(path, body, type='application/json') {
  const requestBody=typeof body==='string'?body:JSON.stringify(body), key=path+'\n'+type+'\n'+requestBody;
  if(pendingRequests.has(key))return pendingRequests.get(key);
  const request=(async()=>{const response=await fetch(path,{method:'POST',headers:{'content-type':type},body:requestBody});const data=await response.json();if(!response.ok)throw new Error(data.error||response.statusText);return data;})();
  pendingRequests.set(key,request);
  try{const data=await request;recordOperationHistory(path);return data;}finally{pendingRequests.delete(key);}
}
async function act(fn) { $('result').textContent='通信待機中...'; try { const data=await fn(); $('result').textContent=JSON.stringify(data,null,2); refreshStatus(); } catch(e) { $('result').textContent='エラー: '+e.message; } }
function runNetworkDiagnostic(){return act(()=>api('/test/network-diagnostic',{routerWanIPv4:$('routerWanIPv4').value.trim()}));}
function buildCustomEEWBulletin(form, selectedAreas, now = new Date()) {
  const eventId = String(form.eventId || '').trim();
  if (!eventId || new TextEncoder().encode(eventId).length > 255) throw new Error('地震IDはUTF-8で1〜255byteにしてください');
  if (!String(form.hypocenterName || '').trim()) throw new Error('震源名を入力してください');
  const latitude = Number(form.latitude), longitude = Number(form.longitude), serial = Number(form.serial);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('緯度・経度が範囲外です');
  if (!Number.isInteger(serial) || serial < 1 || serial > 65534) throw new Error('報番号は1〜65534の整数にしてください');
  if (!['発表','続報','最終報','取消'].includes(form.infoType)) throw new Error('報種別が不正です');
  const cancelled = form.infoType === '取消';
  if (!cancelled && !selectedAreas.some(area => area.warning || area.prediction)) throw new Error('警報対象または予測対象を選択してください');
  const reportDateTime = now.toISOString();
  const eewForecastAreas = cancelled ? [] : selectedAreas.filter(area => area.prediction).map(area => {
    const offset = area.arrivalOffsetSeconds;
    if (offset !== null && (!Number.isInteger(offset) || offset < -32767 || offset > 32767)) throw new Error(`${area.name}: 到達予想秒が範囲外です`);
    return { name:area.name, pref:area.pref, scaleFrom:area.scaleFrom, scaleTo:area.scaleTo,
      kindCode:area.arrivalKind, arrivalTime:offset === null || area.arrivalKind == null || area.arrivalKind === 19 ? null : new Date(now.getTime() + offset * 1000).toISOString() };
  });
  return { eventId, serial, infoType:form.infoType, reportDateTime, isWarning:!!form.isWarning,
    warningSetComplete:!!form.warningSetComplete, predictionSetComplete:!!form.predictionSetComplete,
    earthquake:{ time:reportDateTime, maxScale:Number(form.maxScale), hypocenter:{name:String(form.hypocenterName).trim(), coordinate:`${latitude >= 0 ? '+' : ''}${latitude.toFixed(2)}${longitude >= 0 ? '+' : ''}${longitude.toFixed(2)}`} },
    eewForecastAreas, eewAreaDetails:cancelled ? [] : selectedAreas.filter(area => area.warning).map(area => ({name:area.name,pref:area.pref})) };
}
const EEW_SCALE_OPTIONS = [['不明',''],['1','10'],['2','20'],['3','30'],['4','40'],['5弱','45'],['5強','50'],['6弱','55'],['6強','60'],['7','70'],['7以上','以上']];
function loadEEWAreas() {
  fetch('/test/eew-areas').then(response => { if (!response.ok) throw new Error('HTTP '+response.status); return response.json(); }).then(({areas}) => {
    eewAreaDefinitions=areas;
    $('eewAreaRows').innerHTML=areas.map(area=>`<tr data-eew-area-row data-name="${area.name}"><td>${area.pref} / ${area.name}</td><td><input type="checkbox" data-warning aria-label="${area.name} 警報対象"></td><td><input type="checkbox" data-prediction aria-label="${area.name} 予測対象"></td><td>${['from','to'].map(bound=>`<select data-scale-${bound} aria-label="${area.name} 震度${bound}">${EEW_SCALE_OPTIONS.filter(([,value])=>bound==='to'||value!=='以上').map(([label,value])=>`<option value="${value}"${value==='30'?' selected':''}>${label}</option>`).join('')}</select>`).join('')}</td><td><select data-arrival aria-label="${area.name} 到達状態"><option value="">不明</option><option value="10">未到達</option><option value="11">到達済</option><option value="19">PLUM・時刻なし</option></select></td><td><input type="number" data-arrival-offset value="0" min="-32767" max="32767" aria-label="${area.name} 到達予想秒"></td></tr>`).join('');
  }).catch(error => { $('eewAreaRows').innerHTML=`<tr><td colspan="6">区域表を取得できません: ${error.message}</td></tr>`; });
}
function filterEEWAreas() {
  const query=$('eewAreaSearch').value.trim();
  for(const row of $('eewAreaRows').querySelectorAll('[data-eew-area-row]')) row.hidden=!row.dataset.name.includes(query);
}
function submitCustomEEW() {
  const selectedAreas=[...$('eewAreaRows').querySelectorAll('[data-eew-area-row]')].map(row=>({
    name:row.dataset.name, pref:row.children[0].textContent.split(' / ')[0], warning:row.querySelector('[data-warning]').checked,
    prediction:row.querySelector('[data-prediction]').checked, scaleFrom:row.querySelector('[data-scale-from]').value,
    scaleTo:row.querySelector('[data-scale-to]').value, arrivalKind:row.querySelector('[data-arrival]').value ? Number(row.querySelector('[data-arrival]').value) : null,
    arrivalOffsetSeconds:row.querySelector('[data-arrival-offset]').value === '' ? null : Number(row.querySelector('[data-arrival-offset]').value),
  }));
  const form={eventId:$('eewEventId').value, serial:$('eewSerial').value, infoType:$('eewInfoType').value, hypocenterName:$('eewHypocenter').value,
    latitude:$('eewLatitude').value, longitude:$('eewLongitude').value, maxScale:$('eewMaxScale').value,
    isWarning:$('eewIsWarning').checked, warningSetComplete:$('eewWarningComplete').checked, predictionSetComplete:$('eewPredictionComplete').checked};
  let bulletin;
  try { bulletin=buildCustomEEWBulletin(form,selectedAreas); } catch(error) { $('result').textContent='EEW入力エラー: '+error.message; return; }
  act(()=>api('/test/events',{events:[{kind:'eew',bulletin}]}));
}
function buildCustomIntensityBulletin(form, areas, now = new Date()) {
  const eventId = String(form.eventId || '').trim();
  const serial = Number(form.serial);
  const scales = ['', '1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
  if (!eventId || new TextEncoder().encode(eventId).length > 255) throw new Error('イベントIDはUTF-8で1〜255byteにしてください');
  if (!Number.isInteger(serial) || serial < 1 || serial > 65534) throw new Error('報番号は1〜65534の整数にしてください');
  if (!['発表', '更新', '続報', '最終報', '取消'].includes(form.infoType)) throw new Error('報種別が不正です');
  if (!['震度速報', '震源・震度情報'].includes(form.infoKind)) throw new Error('情報種別が不正です');
  if (!scales.includes(String(form.maxInt ?? ''))) throw new Error('最大震度が不正です');
  if (!areas || typeof areas !== 'object' || Array.isArray(areas)) throw new Error('区域JSONはオブジェクトにしてください');
  const readGroups = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('地域/市町村は震度別のJSONオブジェクトにしてください');
    for (const [scale, names] of Object.entries(value)) {
      if (!scales.slice(1).includes(scale) || !Array.isArray(names) || names.length > 300 ||
          names.some((name) => typeof name !== 'string' || !name.trim() || new TextEncoder().encode(name).length > 192)) {
        throw new Error('地域/市町村または震度階級が不正です');
      }
    }
    return value;
  };
  const prefectures = areas.prefectures || [];
  if (!Array.isArray(prefectures) || prefectures.length > 47 || prefectures.some((pref) => !pref ||
      typeof pref.name !== 'string' || !pref.name.trim() || pref.name.length > 64 || !scales.includes(String(pref.maxInt ?? '')))) {
    throw new Error('都道府県震度JSONが不正です');
  }
  const groups = readGroups(areas.regions || {});
  const cityGroups = readGroups(areas.cities || {});
  if ([...Object.values(groups), ...Object.values(cityGroups)].reduce((total, names) => total + names.length, 0) > 600) {
    throw new Error('地域と市町村は合計600件以内にしてください');
  }
  const worry = form.tsunamiWorry === 'published' ? true : form.tsunamiWorry === 'none' ? false : null;
  return {
    eventId, serial, infoType: form.infoType, infoKind: form.infoKind, reportDateTime: now.toISOString(),
    originTimeFormatted: String(form.originTime || '').slice(0, 32), tsunamiWorry: worry,
    comment: worry === false ? 'この地震による津波の心配はありません。'
      : worry === true ? '津波情報が発表されています。' : '揺れの強かった沿岸部では念のため津波に注意してください。',
    earthquake: { originTime: now.toISOString(), hypocenter: {
      name: String(form.hypocenterName || '').slice(0, 80), description: String(form.depth || '').slice(0, 80),
    }, magnitude: String(form.magnitude || '不明') },
    intensity: {
      maxInt: String(form.maxInt || ''), prefs: prefectures.map((pref) => ({ name: pref.name, maxInt: String(pref.maxInt || '') })),
      groups, cityGroups,
    },
  };
}
function submitCustomIntensity() {
  let areas;
  try { areas = JSON.parse($('intensityAreas').value); }
  catch (error) { $('result').textContent = '地域JSONエラー: ' + error.message; return; }
  const form = Object.fromEntries(['EventId', 'Serial', 'InfoType', 'InfoKind', 'Max', 'OriginTime', 'Hypocenter', 'Depth', 'Magnitude', 'TsunamiWorry']
    .map((name) => [name[0].toLowerCase() + name.slice(1), $('intensity' + name).value]));
  try {
    const bulletin = buildCustomIntensityBulletin({ ...form, eventId: form.eventId, infoType: form.infoType, infoKind: form.infoKind,
      maxInt: form.max, originTime: form.originTime, hypocenterName: form.hypocenter, depth: form.depth, tsunamiWorry: form.tsunamiWorry }, areas);
    act(() => api('/test/events', { events: [{ kind: 'intensity', bulletin }, { kind: 'vertical', bulletin }] }));
  } catch (error) { $('result').textContent = '入力エラー: ' + error.message; }
}
function compareP2PAndJMA() {
  let p2p;
  try { p2p=JSON.parse($('compareP2P').value); } catch(error) { $('result').textContent='P2P JSONエラー: '+error.message; return; }
  const xml=$('compareJMA').value.trim();
  if(p2p?.code!==556) { $('result').textContent='P2P入力のcodeは556にしてください'; return; }
  if(!xml.includes('<Report')) { $('result').textContent='JMA VXSE43 XMLを入力してください'; return; }
  act(()=>api('/test/events',{events:[{p2p},{xml}]}));
}
function submitEvent() {
  const value=$('event').value.trim();
  if (!value) { $('result').textContent='XMLまたはJSONを入力してください'; return; }
  let body=value, type='application/xml';
  try { body=JSON.stringify(JSON.parse(value)); type='application/json'; } catch {}
  act(()=>api('/test/events',body,type));
}
function updateControls(status) {
  const data=status.ingest?.display;
  if(data) for(const key of Object.keys(displayState)) if(typeof data[key]==='boolean') displayState[key]=data[key];
  for(const [key,label] of Object.entries(displayButtons)) {
    const button=$(key+'Toggle');
    button.innerHTML='';
    button.append(document.createTextNode(label));
    const badge=document.createElement('span');
    badge.className='state';
    badge.textContent=displayState[key]?'許可ON':'許可OFF';
    button.append(badge);
    button.classList.toggle('on', !!displayState[key]);
    button.classList.toggle('off', !displayState[key]);
  }
  const config=status.ingest?.atlasIIConfig;
  if(config?.layouts) {
    const selected=Object.hasOwn(config.layouts,$('layout').value) ? $('layout').value : config.activeLayout||'';
    $('layout').innerHTML=Object.keys(config.layouts).map(name=>`<option value="${name}">${name}</option>`).join('');
    $('layout').value=selected;
    layoutConfig=config;
    $('activeLayout').textContent='現在のレイアウト: '+(config.activeLayout||'不明');
    if(editorLayoutName!==selected) loadRectEditor();
  }
  const layers=status.ingest?.activeLayers||{};
  $('feedStatus').textContent=`受信データ: EEW ${layers.eew||0}件 / 津波 ${layers.tsunami||0}件 / 地震 ${layers.intensity||0}件`;
}
function loadRectEditor() {
  if(!layoutConfig)return;
  const name=$('layout').value, rects=layoutConfig.layouts[name];
  if(!Array.isArray(rects))return;
  editorLayoutName=name;
  $('rectLayoutJson').value=JSON.stringify(rects,null,2);
  const [atlasWidth,atlasHeight]=layoutConfig.atlasSize||[1936,1168];
  const [mainVideoWidth,mainVideoHeight]=layoutConfig.mainVideoSize||[1920,1080];
  const [outputWidth,outputHeight]=layoutConfig.outputSize||[1920,1080];
  for(const [id,value] of Object.entries({atlasWidth,atlasHeight,mainVideoWidth,mainVideoHeight,outputWidth,outputHeight}))$(id).value=value;
  updateRectIndex(0);
}
function readRectEditor() {
  const rects=JSON.parse($('rectLayoutJson').value);
  if(!Array.isArray(rects)||rects.length>15)throw new Error('Rectは0〜15件のJSON配列にしてください');
  if(rects.some(rect=>!rect||typeof rect!=='object'||Array.isArray(rect)))throw new Error('各RectはJSON objectにしてください');
  return rects;
}
function updateRectIndex(selected) {
  const rects=readRectEditor(),select=$('rectIndex'),index=Math.max(0,Math.min(selected,rects.length-1));
  select.innerHTML=rects.map((_,i)=>`<option value="${i}">Rect ${i}</option>`).join('');
  select.value=rects.length?String(index):'';
}
function changeRect(action) {
  try {
    const rects=readRectEditor(),index=Number($('rectIndex').value)||0;
    if(action==='add') {
      if(rects.length>=15)throw new Error('Rectは最大15件です');
      rects.push({source:1,mode:0,visible:true,opacity:255,srcX:0,srcY:0,srcW:Number($('mainVideoWidth').value),srcH:Number($('mainVideoHeight').value),dstX:0,dstY:0,dstW:Number($('outputWidth').value),dstH:Number($('outputHeight').value)});
      $('rectLayoutJson').value=JSON.stringify(rects,null,2);updateRectIndex(rects.length-1);return;
    }
    if(action==='remove')rects.splice(index,1);
    else if(action==='up'&&index>0)[rects[index-1],rects[index]]=[rects[index],rects[index-1]];
    else if(action==='down'&&index<rects.length-1)[rects[index+1],rects[index]]=[rects[index],rects[index+1]];
    else return;
    $('rectLayoutJson').value=JSON.stringify(rects,null,2);updateRectIndex(action==='up'?index-1:action==='down'?index+1:index);
  } catch(error) {$('result').textContent='Rect編集エラー: '+error.message;}
}
function applyRectLayout() {
  try {
    if(!layoutConfig)throw new Error('Atlas II構成を取得できません');
    const pair=(a,b,label,min=1)=>{const values=[$(a).value,$(b).value].map(Number);if(values.some(v=>!Number.isInteger(v)||v<min||v>65535))throw new Error(`${label}は${min}〜65535の整数にしてください`);return values;};
    const name=$('layout').value,next={...layoutConfig,activeLayout:name,
      atlasSize:pair('atlasWidth','atlasHeight','Atlas寸法'),
      mainVideoSize:pair('mainVideoWidth','mainVideoHeight','MAIN_VIDEO寸法'),
      outputSize:pair('outputWidth','outputHeight','出力寸法'),
      layouts:{...layoutConfig.layouts,[name]:readRectEditor()}};
    if(next.atlasSize[0]<640||next.atlasSize[1]<32||next.atlasSize.some(value=>value%16))throw new Error('Atlas寸法は幅640以上・高さ32以上の16px倍数にしてください');
    return act(async()=>{const result=await api('/test/layout',{activeLayout:name,atlasIIConfig:next});layoutConfig=next;editorLayoutName=name;return result;});
  } catch(error) {$('result').textContent='Rect設定エラー: '+error.message;}
}
function preset(name) { act(()=>api('/test/presets/'+name,{})); }
function buildCustomTsunamiBulletin(form, selectedAreas, now = new Date()) {
  const eventId=String(form.eventId||'').trim(), serial=Number(form.serial);
  if(!eventId || new TextEncoder().encode(eventId).length>255) throw new Error('地震イベントIDはUTF-8で1〜255byteにしてください');
  if(!Number.isInteger(serial)||serial<1||serial>65534) throw new Error('報番号は1〜65534の整数にしてください');
  if(!['発表','更新','取消'].includes(form.infoType)) throw new Error('報種別が不正です');
  const cancelled=form.infoType==='取消';
  if(!cancelled&&!selectedAreas.some(area=>area.severity>0)) throw new Error('注意報以上の区域を選択してください');
  const groups={majorTsunami:[],warning:[],advisory:[]}, forecasts=[];
  if(!cancelled) for(const area of selectedAreas) {
    const severity=Number(area.severity); if(!severity) continue;
    if(![1,2,3].includes(severity)) throw new Error(`${area.name}: 危険度が不正です`);
    const code=severity===3?'53':severity===2?'51':'62', level=severity===3?'majorTsunami':severity===2?'warning':'advisory';
    groups[level].push(area.name);
    const firstHeight={condition:area.arrivalMode==='soon'?'ただちに津波来襲と予測':area.arrivalMode==='arrived'?'既に津波到達と推測':''};
    let formattedArrivalTime='';
    if(area.arrivalMode==='time') {
      const date=new Date(area.arrivalTime); if(!Number.isFinite(date.getTime())) throw new Error(`${area.name}: 到達時刻が不正です`);
      firstHeight.arrivalTime=date.toISOString();
      formattedArrivalTime=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
    }
    forecasts.push({area:{code:Number(area.code),name:area.name},category:{code,kind:(severity===3?'大津波警報':severity===2?'津波警報':'津波注意報')+(area.additional?'：追加':'：発表')},maxHeight:String(area.height||'不明').trim()||'不明',firstHeight,formattedArrivalTime});
  }
  return {eventId,serial,infoType:form.infoType,infoKind:'津波警報・注意報',reportDateTime:now.toISOString(),
    tsunami:{groups,forecasts}};
}
function tsunamiRows(){return [...$('tsunamiZoneRows').querySelectorAll('[data-tsunami-zone]')];}
let tsunamiSequenceTimer=null, tsunamiSequenceIndex=0;
function updateTsunamiSelectionStatus(){
  const rows=tsunamiRows(), selected=rows.filter(row=>row.querySelector('[data-zone-select]').checked), counts=[0,0,0,0];
  for(const row of rows) counts[Number(row.querySelector('[data-zone-severity]').value)]++;
  $('tsunamiSelectionStatus').textContent=`選択 ${selected.length}/66区域 / なし ${counts[0]}・注意報 ${counts[1]}・警報 ${counts[2]}・大津波警報 ${counts[3]}`;
  previewTsunamiMap();
}
function previewTsunamiMap(){
  const frame=$('tsunamiMapPreview'); if(!frame?.contentWindow) return;
  frame.contentWindow.postMessage({type:'atlas-tsunami-preview-options',blink:$('tsunamiPreviewBlink').checked,legend:$('tsunamiPreviewLegend').checked,linesVisible:$('tsunamiPreviewLines').checked},location.origin);
  const groups={major:[],warning:[],advisory:[]}, key={1:'advisory',2:'warning',3:'major'};
  for(const row of tsunamiRows()){const category=key[Number(row.querySelector('[data-zone-severity]').value)];if(category)groups[category].push(row.dataset.name);}
  frame.contentWindow.postMessage({type:'atlas-tsunami-preview',groups},location.origin);
}
function showTsunamiSequenceZone(){
  const rows=tsunamiRows(); if(!rows.length)return;
  const row=rows[tsunamiSequenceIndex%rows.length];
  $('tsunamiMapPreview').contentWindow.postMessage({type:'atlas-tsunami-zone',name:row.dataset.name},location.origin);
  $('tsunamiSequenceStatus').textContent=`順次表示 ${tsunamiSequenceIndex+1}/${rows.length}区域: ${row.dataset.name}`;
  tsunamiSequenceIndex=(tsunamiSequenceIndex+1)%rows.length;
}
function toggleTsunamiSequence(){
  if(tsunamiSequenceTimer){clearInterval(tsunamiSequenceTimer);tsunamiSequenceTimer=null;$('tsunamiSequenceToggle').textContent='66区域を順次表示';$('tsunamiSequenceStatus').textContent='停止中';previewTsunamiMap();return;}
  tsunamiSequenceIndex=0;$('tsunamiSequenceToggle').textContent='順次表示を停止';showTsunamiSequenceZone();tsunamiSequenceTimer=setInterval(showTsunamiSequenceZone,1000);
}
async function saveTsunamiContactSheet(){
  const rows=tsunamiRows(), mapWindow=$('tsunamiMapPreview').contentWindow;
  if(rows.length!==66||!mapWindow?.renderTsunamiMini)throw new Error('津波地図の区域一覧が準備できていません');
  const columns=6,tileWidth=220,tileHeight=185,canvas=document.createElement('canvas');
  canvas.width=columns*tileWidth;canvas.height=Math.ceil(rows.length/columns)*tileHeight;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#111827';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font='14px sans-serif';ctx.fillStyle='#fff';
  const style=mapWindow.document.querySelector('style')?.textContent||'';
  for(let i=0;i<rows.length;i++){
    const name=rows[i].dataset.name;mapWindow.renderTsunamiMini({advisory:[name],legend:false,blink:false},'tsunami-mini');
    const svg=mapWindow.document.querySelector('#tsunami-mini svg');if(!svg)throw new Error(`${name}: 地図SVGを生成できません`);
    const imageSvg=svg.cloneNode(true),sheetStyle=mapWindow.document.createElement('style');sheetStyle.textContent=style;imageSvg.insertBefore(sheetStyle,imageSvg.firstChild);
    imageSvg.setAttribute('width','200');imageSvg.setAttribute('height','159');
    const url=URL.createObjectURL(new Blob([imageSvg.outerHTML],{type:'image/svg+xml'})),image=new Image();image.src=url;
    try{await image.decode();const x=(i%columns)*tileWidth,y=Math.floor(i/columns)*tileHeight;ctx.drawImage(image,x+10,y+22,200,159);ctx.fillText(`${i+1}. ${name}`,x+10,y+17);}finally{URL.revokeObjectURL(url);}
  }
  previewTsunamiMap();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('コンタクトシートPNGを生成できません');
  downloadBlob(blob,'tsunami-66-area-contact-sheet.png');
}
function filterTsunamiAreas(){const q=$('tsunamiAreaSearch').value.trim();for(const row of tsunamiRows())row.hidden=!row.dataset.name.includes(q);}
function selectAllTsunamiZones(checked){for(const row of tsunamiRows())row.querySelector('[data-zone-select]').checked=checked;updateTsunamiSelectionStatus();}
function invertTsunamiZoneSelection(){for(const row of tsunamiRows()){const box=row.querySelector('[data-zone-select]');box.checked=!box.checked;}updateTsunamiSelectionStatus();}
function applyTsunamiBulkSeverity(){for(const row of tsunamiRows())if(row.querySelector('[data-zone-select]').checked)row.querySelector('[data-zone-severity]').value=$('tsunamiBulkSeverity').value;updateTsunamiSelectionStatus();}
function applyTsunamiPreset(name){
  const presets={adjacent:[[100,2],[101,2],[102,2]],narrow:[[312,1],[330,1],[391,1]],islands:[[320,1],[321,1],[772,1],[802,1]],bays:[[202,1],[312,2],[391,3]]};
  const levels=new Map(presets[name]||[]);if(!levels.size)throw new Error('津波形状プリセットがありません: '+name);
  for(const row of tsunamiRows()){row.querySelector('[data-zone-select]').checked=false;row.querySelector('[data-zone-severity]').value=levels.get(Number(row.dataset.code))||0;}
  updateTsunamiSelectionStatus();
}
function submitCustomTsunami(){
  const selectedAreas=tsunamiRows().map(row=>({code:row.dataset.code,name:row.dataset.name,severity:Number(row.querySelector('[data-zone-severity]').value),height:row.querySelector('[data-zone-height]').value,
    arrivalMode:row.querySelector('[data-zone-arrival]').value,arrivalTime:row.querySelector('[data-zone-time]').value,additional:row.querySelector('[data-zone-additional]').checked}));
  let bulletin;
  try{bulletin=buildCustomTsunamiBulletin({eventId:$('tsunamiEventId').value,serial:$('tsunamiSerial').value,infoType:$('tsunamiInfoType').value},selectedAreas);}catch(error){$('result').textContent='津波入力エラー: '+error.message;return;}
  act(()=>api('/test/events',{events:[{kind:'tsunami',bulletin}]}));
}
function presetTsunamiLevel(code) {
  const labels = { '62':'津波注意報', '51':'津波警報', '53':'大津波警報' };
  const area = $('tsunamiArea').selectedOptions[0];
  const groups = { majorTsunami: [], warning: [], advisory: [] };
  groups[code === '53' ? 'majorTsunami' : code === '51' ? 'warning' : 'advisory'].push(area.textContent);
  const bulletin = { eventId:'test-tsunami-single', infoType:'発表', infoKind:'津波警報・注意報', reportDateTime:new Date().toISOString(), serial:1,
    tsunami:{ groups, forecasts:[{ category:{ code, kind:labels[code]+'：発表' }, area:{ code:Number(area.value), name:area.textContent }, maxHeight:'1m', firstHeight:{ condition:'到達予想' } }] } };
  act(()=>api('/test/events',{events:[{kind:'tsunami', bulletin}]}));
}
function cancelTsunamiPreset() {
  const bulletin = { eventId:'test-tsunami-single', infoType:'取消', infoKind:'津波警報・注意報', reportDateTime:new Date().toISOString(), serial:2,
    tsunami:{ groups:{ majorTsunami:[], warning:[], advisory:[] }, forecasts:[] } };
  act(()=>api('/test/events',{events:[{kind:'tsunami', bulletin}]}));
}
async function loadTsunamiAreas() {
  try {
    const response=await fetch('/test/tsunami-areas');if(!response.ok)throw new Error('HTTP '+response.status);
    const data=await response.json();
    tsunamiAreaDefinitions=data.areas;
    $('tsunamiArea').innerHTML = data.areas.map(a => `<option value="${a.code}">${a.name}</option>`).join('');
    $('tsunamiZoneRows').innerHTML=data.areas.map(a=>`<tr data-tsunami-zone data-code="${a.code}" data-name="${a.name}"><td><input type="checkbox" data-zone-select aria-label="${a.name} 一括変更対象"></td><td>${a.name}</td><td><select data-zone-severity aria-label="${a.name} 危険度" onchange="updateTsunamiSelectionStatus()"><option value="0">なし</option><option value="1">注意報</option><option value="2">警報</option><option value="3">大津波警報</option></select></td><td><input data-zone-height value="1m" aria-label="${a.name} 最大予想高さ"></td><td><select data-zone-arrival aria-label="${a.name} 第一波"><option value="unknown">到達時刻不明</option><option value="soon">すぐ来る</option><option value="arrived">到達か</option><option value="time">時刻指定</option></select></td><td><input type="datetime-local" data-zone-time aria-label="${a.name} 到達時刻"></td><td><input type="checkbox" data-zone-additional aria-label="${a.name} 追加"></td></tr>`).join('');
    updateTsunamiSelectionStatus();
  }
  catch (e) { $('result').textContent = '予報区一覧の取得失敗: '+e.message; }
}
async function testLowerRgbTsunamiMap() {
  try {
    if (!displayState.tsunamiMap) {
      const display = await api('/test/display',{key:'tsunamiMap',visible:true});
      Object.assign(displayState,display.display);
    }
    const result = await api('/test/presets/tsunami',{});
    $('result').textContent=JSON.stringify(result,null,2);
    await refreshStatus();
  } catch(e) { $('result').textContent='エラー: '+e.message; }
}
async function toggleDisplay(key) {
  try { const data=await api('/test/display',{key,visible:!displayState[key]}); Object.assign(displayState,data.display); $('result').textContent=JSON.stringify(data,null,2); await refreshStatus(); }
  catch(e) { $('result').textContent='エラー: '+e.message; }
}
function syncScenarioJson() { $('scenario').value=JSON.stringify({steps:scenarioSteps},null,2); }
function renderScenarioSteps() {
  const host=$('scenarioSteps'); host.replaceChildren();
  scenarioSteps.forEach((step,index)=>{
    const row=document.createElement('div'); row.dataset.scenarioStep=String(index);
    const time=document.createElement('input'); time.type='number'; time.min='0'; time.step='0.1'; time.value=step.atSeconds; time.setAttribute('aria-label',`ステップ${index+1} 時刻`);
    time.onchange=()=>{step.atSeconds=Number(time.value);syncScenarioJson();}; row.append('時刻(秒) ',time,' 操作 ');
    const action=document.createElement('select'); action.setAttribute('aria-label',`ステップ${index+1} 操作`);
    for(const value of ['events','display','layout','reset','fault','clock']){const option=document.createElement('option');option.value=value;option.textContent=value;action.appendChild(option);}
    action.value=step.action; action.onchange=()=>{step.action=action.value;syncScenarioJson();}; row.append(action,' 内容 ');
    const payload=document.createElement('textarea'); payload.setAttribute('aria-label',`ステップ${index+1} 内容`);
    payload.value=JSON.stringify(Object.fromEntries(Object.entries(step).filter(([key])=>!['atSeconds','action'].includes(key))));
    payload.onchange=()=>{try{const value=JSON.parse(payload.value);if(!value||typeof value!=='object'||Array.isArray(value)||'atSeconds' in value||'action' in value)throw new Error('内容は時刻・操作以外のJSON objectで入力してください');scenarioSteps[index]={atSeconds:Number(time.value),action:action.value,...value};syncScenarioJson();}catch(error){$('result').textContent='シナリオ内容エラー: '+error.message;}};
    row.append(payload); const remove=document.createElement('button');remove.textContent='削除';remove.onclick=()=>{scenarioSteps.splice(index,1);renderScenarioSteps();syncScenarioJson();};row.append(remove);host.appendChild(row);
  });
}
function loadScenarioEditor() { try {const value=JSON.parse($('scenario').value);if(!value||!Array.isArray(value.steps))throw new Error('steps配列が必要です');scenarioSteps=value.steps.map(step=>({...step}));renderScenarioSteps();}catch(error){$('result').textContent='シナリオJSONエラー: '+error.message;} }
function addScenarioStep() { scenarioSteps.push({atSeconds:0,action:'events',events:[]});renderScenarioSteps();syncScenarioJson(); }
function runScenario() { try { act(()=>api('/test/scenarios/run',JSON.parse($('scenario').value))); } catch(e) { $('result').textContent='JSONエラー: '+e.message; } }
const savedScenarioKey='atlas-test-scenarios-v1';
function readSavedScenarios() { try { const value=JSON.parse(localStorage.getItem(savedScenarioKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}; } catch { return {}; } }
function refreshSavedScenarios() { const select=$('savedScenario'),selected=select.value,items=readSavedScenarios();select.replaceChildren?.();for(const name of Object.keys(items).sort()){const option=document.createElement('option');option.value=name;option.textContent=name;select.appendChild(option);}if(items[selected])select.value=selected; }
function saveScenario() { try { const name=$('scenarioName').value.trim(),value=JSON.parse($('scenario').value);if(!name||!Array.isArray(value.steps))throw new Error('保存名とsteps配列が必要です');const items=readSavedScenarios();items[name]=value;localStorage.setItem(savedScenarioKey,JSON.stringify(items));refreshSavedScenarios();$('savedScenario').value=name;$('result').textContent=`シナリオ「${name}」を保存しました`;recordOperationHistory(`シナリオ保存: ${name}`);}catch(error){$('result').textContent='保存失敗: '+error.message;} }
function loadSavedScenario() { const value=readSavedScenarios()[$('savedScenario').value];if(!value){$('result').textContent='保存済みシナリオがありません';return;} $('scenario').value=JSON.stringify(value,null,2);loadScenarioEditor(); }
function deleteSavedScenario() { const name=$('savedScenario').value,items=readSavedScenarios();if(!name||!items[name])return;delete items[name];localStorage.setItem(savedScenarioKey,JSON.stringify(items));refreshSavedScenarios();$('result').textContent=`シナリオ「${name}」を削除しました`;recordOperationHistory(`シナリオ削除: ${name}`); }
function loadScenarioPreset() { const presets={reverseL:{steps:[{atSeconds:0,action:'layout',activeLayout:'reverseL'},{atSeconds:5,action:'layout',activeLayout:'full'}]},earthquakeDisplay:{steps:[{atSeconds:0,action:'display',key:'earthquakeTelop',visible:false},{atSeconds:5,action:'display',key:'earthquakeTelop',visible:true}]},reset:{steps:[{atSeconds:0,action:'reset'}]}};$('scenario').value=JSON.stringify(presets[$('scenarioPreset').value],null,2);loadScenarioEditor();recordOperationHistory(`シナリオプリセット: ${$('scenarioPreset').value}`); }
function exportScenario() { try {const value=JSON.parse($('scenario').value);if(!Array.isArray(value.steps))throw new Error('steps配列が必要です');const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=($('scenarioName').value.trim().replace(/[^a-zA-Z0-9_-]+/g,'_')||'atlas-scenario')+'.json';link.click();URL.revokeObjectURL(url);}catch(error){$('result').textContent='エクスポート失敗: '+error.message;} }
function scenarioControl(action) { act(()=>api('/test/scenarios/'+action,{})); }
function setLiveInputs(enabled) { act(()=>api('/test/live-inputs',{enabled})); }
function fault() { act(()=>api('/test/fault',{child:$('faultChild').value,action:$('faultAction').value})); }
function resetState() { act(()=>api('/test/reset',{})); }
function advanceVirtualClock() { act(()=>api('/test/clock',{advanceMs:Number($('clockAdvanceMs').value)})); }
async function loadLogs() {
  const component=$('logComponent').value,query=$('logQuery').value;
  try {
    const response=await fetch(`/test/logs?${new URLSearchParams({component,query})}`),data=await response.json();
    if(!response.ok)throw new Error(data.error||response.statusText);
    $('logResult').textContent=`${data.lineCount}行${data.truncated?'（末尾1000行を表示）':''}\n${data.content||'該当ログなし'}`;
  } catch(error) {$('logResult').textContent='ログ取得失敗: '+error.message;}
}
function searchLogs(){loadLogs();}
function saveLogs(){const params=new URLSearchParams({component:$('logComponent').value,query:$('logQuery').value,download:'1'}),link=document.createElement('a');link.href=`/test/logs?${params}`;link.download=`atlas-${$('logComponent').value}-logs.txt`;link.click();}
function sourceHealthSummary(health, now=Date.now()) {
  const ageText=timestamp=>{const seconds=Math.max(0,Math.floor((now-Date.parse(timestamp))/1000));return seconds<60?`${seconds}秒`:seconds<3600?`${Math.floor(seconds/60)}分`:`${Math.floor(seconds/3600)}時間${Math.floor(seconds%3600/60)}分`;};
  return [['JMA','jma'],['P2P','p2p']].map(([label,key])=>{
    const item=health?.[key];if(!item)return `${label}: 状態未取得 / 最終受信なし`;
    const updateAge=Number.isFinite(Date.parse(item.at))?Math.max(0,now-Date.parse(item.at)):Infinity;
    const stale=updateAge>120000,status=!item.ok?`接続異常${stale?'・状態更新が古い':''}`:stale?'状態更新が古い':'接続正常';
    const received=item.lastReceivedAt&&Number.isFinite(Date.parse(item.lastReceivedAt))?`${ageText(item.lastReceivedAt)}前`:'なし';
    return `${label}: ${status} / 状態更新 ${Number.isFinite(updateAge)?ageText(item.at)+'前':'不明'} / 最終受信 ${received}${item.error?' / '+item.error:''}`;
  }).join('\n');
}
function renderActiveEvents(events){const host=$('activeEvents');host.replaceChildren();if(!Array.isArray(events)){host.textContent='試験イベント一覧を取得できません';return;}if(!events.length){host.textContent='有効な試験イベントはありません';return;}for(const event of events){const row=document.createElement('p');row.dataset.eventId=event.eventId;row.textContent=`${event.kind} / ${event.eventId} / 第${event.serial??'不明'}報 / ${event.publishedAt||'発表時刻不明'} / ${event.areas?.join('、')||'対象区域なし'} `;const button=document.createElement('button');button.type='button';button.textContent='この試験イベントを個別削除';button.onclick=()=>act(()=>api('/test/events/remove',{kind:event.kind,eventId:event.eventId}));row.append(button);host.append(row);}}
function renderDisplayConflict(ingest){const events=(ingest?.testEvents||[]).filter(event=>event.infoType!=='取消'),display=ingest?.display||{},hasEEW=events.some(event=>event.kind==='eew'),hasTsunami=events.some(event=>event.kind==='tsunami');if(display.tsunamiLeftMap===false){$('displayConflict').textContent='津波左帯マップは表示許可OFFのため非表示です。';return;}if(hasEEW&&hasTsunami&&display.eewVertical!==false){$('displayConflict').textContent='津波とEEWが同時にあります。Rendererは縦型EEWが実表示される間、競合を避けるため津波左帯マップを隠します（telop/atlas-live.js）。試験UIではL字表示の実状態を取得できないため、実際の競合発生は受信映像で確認してください。';return;}$('displayConflict').textContent='現在の試験イベントと表示許可から、津波左帯と縦型EEWの競合条件は確認されていません。';}
async function refreshStatus() { try { const r=await fetch('/test/status'); const data=await r.json(); $('status').textContent=JSON.stringify(data,null,2); const env=data.environment; $('environment').textContent=env?`実行環境: ${env.platform} / Python ${env.python} / Git ${env.gitSha} / A2 v${env.protocolVersion}`:'実行環境情報を取得できません'; $('sourceHealth').textContent=sourceHealthSummary(data.ingest?.sourceHealth); renderActiveEvents(data.ingest?.testEvents); renderDisplayConflict(data.ingest); updateControls(data); } catch(e) { $('status').textContent='状態取得失敗: '+e.message; $('environment').textContent='実行環境情報を取得できません'; } }
function filterSections(){const query=$('sectionSearch').value.trim().toLocaleLowerCase('ja'),category=$('sectionCategory').value;for(const section of document.querySelectorAll('body>section'))section.hidden=(category!=='all'&&section.dataset.category!==category)||(query&&!section.textContent.toLocaleLowerCase('ja').includes(query));}
function initSectionTools(){if(typeof document.querySelectorAll!=='function')return;for(const section of document.querySelectorAll('body>section')){const heading=section.querySelector('h2');if(!heading)continue;const title=heading.textContent;section.dataset.category=title==='表示切替'?'表示':/配信ストリーム|Rectレイアウト/.test(title)?'配信・構成':/サンプル投入|津波66区域|イベント投入|自由生成|比較投入/.test(title)?'情報投入':/シナリオ/.test(title)?'シナリオ':'運用診断';const button=document.createElement('button');button.type='button';button.textContent='折り畳む';button.setAttribute('aria-expanded','true');button.onclick=()=>{const collapse=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!collapse));button.textContent=collapse?'展開':'折り畳む';for(const child of section.children)if(child!==heading)child.hidden=collapse;};heading.append(' ',button);}}
loadScenarioEditor(); refreshSavedScenarios(); loadTsunamiAreas(); loadEEWAreas(); refreshStatus(); refreshOperationHistory(); initSectionTools(); setInterval(refreshStatus,2000);
