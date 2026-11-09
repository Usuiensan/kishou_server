#!/usr/bin/env python3
"""EEW 続報アニメーション: 過去の警報事例 (+3.11 PLUM仮定) を 7.5 秒間隔の
続報ステップで自動再生する単一ファイルページを生成する。"""
import re, pathlib
d = pathlib.Path(__file__).parent
html = (d / "eew.html").read_text(encoding="utf-8")
gj = (d / "geojson.js").read_text(encoding="utf-8")
hk = (d / "hkzones.js").read_text(encoding="utf-8")
html = html.replace('<script src="geojson.js"></script>', "<script>\n" + gj + "\n</script>")
html = html.replace('<script src="hkzones.js"></script>', "<script>\n" + hk + "\n</script>")

player = r"""
<style>
  body { background:#2b2b30; }
  /* 横型: ボックス (y374〜) の上に収まる横長パネル。縦型: 帯 (左端) を避けて右上パネル */
  #anim-ui { position:fixed; z-index:10; font-family:sans-serif; color:#ddd; }
  #anim-ui.h { left:10px; top:10px; width:760px; }
  #anim-ui.v { right:10px; top:10px; width:340px; }
  #anim-ui button { font-size:12px; margin:0 4px 6px 0; padding:5px 8px; }
  #anim-list { display:grid; gap:4px; }
  #anim-ui.h #anim-list { grid-template-columns:1fr 1fr; }
  #anim-ui.v #anim-list { grid-template-columns:1fr; }
  #anim-ui .case { text-align:left; margin:0; white-space:nowrap; overflow:hidden; }
  #anim-ui .case.on { background:#296cc7; color:#fff; }
  #anim-status { font-size:14px; margin:6px 0 3px; color:#fff; }
  #anim-note { font-size:11px; color:#aaa; line-height:1.45; }
</style>
<div id="anim-ui" class="h">
  <div id="anim-list"></div>
  <div>
    <button id="anim-replay">最初から再生</button>
    <button id="anim-layout">縦型に切替</button>
    <label style="font-size:12px"><input type="checkbox" id="anim-textblink"> 追加地域のテキストも点滅</label>
  </div>
  <div id="anim-status"></div>
  <div id="anim-note"></div>
</div>
<script>
const CASES = [
  { title: "2011.3.11 東北地方太平洋沖地震 — PLUM法があったら (仮定)",
    note: "仮定シミュレーション。第1報は従来型 (P波推定)、第2報以降は PLUM 法で実際に揺れた地域へ警報が広がった場合の想像図。実発表ではない",
    stages: [
      { hypocenterName: "三陸沖", latitude: 38.1, longitude: 142.9,
        areas: ["宮城県北部","宮城県南部","岩手県沿岸南部","岩手県内陸南部","福島県浜通り","福島県中通り"] },
      { hypocenterName: "三陸沖", latitude: 38.1, longitude: 142.9,
        areas: ["宮城県北部","宮城県南部","岩手県沿岸南部","岩手県内陸南部","福島県浜通り","福島県中通り",
                "岩手県沿岸北部","岩手県内陸北部","山形県村山","山形県置賜","福島県会津","茨城県北部","茨城県南部","栃木県北部","栃木県南部"] },
      { hypocenterName: "三陸沖", latitude: 38.1, longitude: 142.9,
        areas: ["宮城県北部","宮城県南部","岩手県沿岸南部","岩手県内陸南部","福島県浜通り","福島県中通り",
                "岩手県沿岸北部","岩手県内陸北部","山形県村山","山形県置賜","福島県会津","茨城県北部","茨城県南部","栃木県北部","栃木県南部",
                "群馬県北部","群馬県南部","埼玉県北部","埼玉県南部","千葉県東方海上","千葉県北東部","千葉県北西部","千葉県南部",
                "東京都２３区","東京都多摩東部","神奈川県東部","神奈川県西部","新潟県中越","新潟県下越","山梨県中・西部","長野県中部","静岡県東部"] },
    ] },
  { title: "2024.1.1 能登半島地震 (警報3回・実データ)",
    note: "気象庁の発表状況ページに基づく実データ (既存デモ noto_first/mid/final)",
    stages: [DEMOS.noto_first, DEMOS.noto_mid, DEMOS.noto_final] },
  { title: "2022.3.16 福島県沖地震",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "福島県沖", latitude: 37.7, longitude: 141.6,
        areas: ["宮城県南部","宮城県中部","福島県浜通り","福島県中通り"] },
      { hypocenterName: "福島県沖", latitude: 37.7, longitude: 141.6,
        areas: ["宮城県南部","宮城県中部","福島県浜通り","福島県中通り",
                "宮城県北部","岩手県内陸南部","山形県村山","山形県置賜","茨城県北部","栃木県北部"] },
      { hypocenterName: "福島県沖", latitude: 37.7, longitude: 141.6,
        areas: ["宮城県南部","宮城県中部","福島県浜通り","福島県中通り",
                "宮城県北部","岩手県内陸南部","山形県村山","山形県置賜","茨城県北部","栃木県北部",
                "岩手県沿岸北部","岩手県内陸北部","秋田県沿岸南部","茨城県南部","栃木県南部","群馬県南部","埼玉県北部","千葉県北東部","新潟県下越"] },
    ] },
  { title: "2021.2.13 福島県沖地震",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "福島県沖", latitude: 37.7, longitude: 141.7,
        areas: ["宮城県南部","福島県浜通り","福島県中通り"] },
      { hypocenterName: "福島県沖", latitude: 37.7, longitude: 141.7,
        areas: ["宮城県南部","福島県浜通り","福島県中通り",
                "宮城県北部","宮城県中部","山形県置賜","山形県村山","茨城県北部","栃木県北部","福島県会津"] },
    ] },
  { title: "2016.4.14 熊本地震 (前震)",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "熊本県熊本地方", latitude: 32.7, longitude: 130.8,
        areas: ["熊本県熊本","熊本県阿蘇"] },
      { hypocenterName: "熊本県熊本地方", latitude: 32.7, longitude: 130.8,
        areas: ["熊本県熊本","熊本県阿蘇",
                "熊本県天草・芦北","熊本県球磨","大分県中部","大分県西部","宮崎県北部山沿い","福岡県南部","佐賀県南部"] },
    ] },
  { title: "2016.4.16 熊本地震 (本震)",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "熊本県熊本地方", latitude: 32.8, longitude: 130.8,
        areas: ["熊本県熊本","熊本県阿蘇","大分県中部"] },
      { hypocenterName: "熊本県熊本地方", latitude: 32.8, longitude: 130.8,
        areas: ["熊本県熊本","熊本県阿蘇","大分県中部",
                "熊本県天草・芦北","熊本県球磨","大分県北部","大分県西部","大分県南部","宮崎県北部山沿い","宮崎県北部平野部",
                "福岡県南部","福岡県北部","佐賀県南部","佐賀県北部","長崎県南部","長崎県北部"] },
      { hypocenterName: "熊本県熊本地方", latitude: 32.8, longitude: 130.8,
        areas: ["熊本県熊本","熊本県阿蘇","大分県中部",
                "熊本県天草・芦北","熊本県球磨","大分県北部","大分県西部","大分県南部","宮崎県北部山沿い","宮崎県北部平野部",
                "福岡県南部","福岡県北部","佐賀県南部","佐賀県北部","長崎県南部","長崎県北部",
                "宮崎県南部山沿い","宮崎県南部平野部","鹿児島県薩摩","愛媛県南予","愛媛県東予","山口県西部","山口県中部"] },
    ] },
  { title: "2018.9.6 北海道胆振東部地震",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "胆振地方中東部", latitude: 42.7, longitude: 142.0,
        areas: ["胆振地方中東部","日高地方西部","石狩地方中部","空知地方南部"] },
      { hypocenterName: "胆振地方中東部", latitude: 42.7, longitude: 142.0,
        areas: ["胆振地方中東部","日高地方西部","石狩地方中部","空知地方南部",
                "渡島地方東部","檜山地方","後志地方東部","上川地方南部","十勝地方北部"] },
    ] },
  { title: "2018.6.18 大阪府北部地震",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "大阪府北部", latitude: 34.8, longitude: 135.6,
        areas: ["大阪府北部","京都府南部","兵庫県南部","奈良県"] },
      { hypocenterName: "大阪府北部", latitude: 34.8, longitude: 135.6,
        areas: ["大阪府北部","京都府南部","兵庫県南部","奈良県",
                "大阪府南部","京都府北部","兵庫県北部","滋賀県南部","和歌山県北部","三重県中部","福井県嶺南"] },
    ] },
  { title: "2024.8.8 日向灘地震",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "日向灘", latitude: 31.7, longitude: 131.7,
        areas: ["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅"] },
      { hypocenterName: "日向灘", latitude: 31.7, longitude: 131.7,
        areas: ["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅",
                "宮崎県北部山沿い","宮崎県南部山沿い","鹿児島県薩摩","大分県南部","熊本県天草・芦北"] },
    ] },
  { title: "2023.5.5 能登半島地震 (奥能登)",
    note: "実発表に基づく近似",
    stages: [
      { hypocenterName: "石川県能登地方", latitude: 37.5, longitude: 137.3,
        areas: ["石川県能登"] },
      { hypocenterName: "石川県能登地方", latitude: 37.5, longitude: 137.3,
        areas: ["石川県能登","石川県加賀","富山県東部","富山県西部","新潟県上越","新潟県佐渡"] },
    ] },
];
let curCase = 0, curStage = 0, timer = null, vertical = false;
const STEP_MS = 7500;
function renderStage() {
  const c = CASES[curCase], d = c.stages[curStage];
  if (curStage === 0) { if (vertical) renderEEWVertical(d); else renderEEW(d); }
  else { if (vertical) renderEEWVerticalUpdate(d); else renderEEWUpdate(d); }
  document.getElementById("anim-status").textContent =
    c.title + " — 第" + (curStage + 1) + "報 / 全" + c.stages.length + "報 (経過 " + (curStage * 7.5) + " 秒)";
  document.getElementById("anim-note").textContent = c.note;
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function playCase(i) {
  curCase = i; curStage = 0; stopTimer();
  document.querySelectorAll("#anim-list .case").forEach((b, j) => b.classList.toggle("on", j === i));
  renderStage();
  if (CASES[i].stages.length > 1) {
    timer = setInterval(() => {
      if (curStage >= CASES[curCase].stages.length - 1) { stopTimer(); return; }
      curStage++; renderStage();
    }, STEP_MS);
  }
}
const list = document.getElementById("anim-list");
CASES.forEach((c, i) => {
  const b = document.createElement("button");
  b.className = "case"; b.textContent = (i + 1) + ". " + c.title;
  b.onclick = () => playCase(i);
  list.appendChild(b);
});
document.getElementById("anim-replay").onclick = () => playCase(curCase);
document.getElementById("anim-textblink").onchange = (e) => { window.setEEWTextBlink(e.target.checked); playCase(curCase); };
document.getElementById("anim-layout").onclick = (e) => {
  vertical = !vertical;
  e.target.textContent = vertical ? "横型に切替" : "縦型に切替";
  document.getElementById("anim-ui").className = vertical ? "v" : "h";
  document.getElementById("eew-box").classList.remove("on");
  document.getElementById("eew-v").classList.remove("on");
  playCase(curCase);
};
window.__anim = { CASES, playCase, step: () => { if (curStage < CASES[curCase].stages.length - 1) { curStage++; renderStage(); } return curStage; }, state: () => [curCase, curStage] };
playCase(0);
</script>
"""
html = re.sub(r'const q = new URLSearchParams\(location\.search\);.*?(?=\</script\>)',
              '/* entry replaced by animation player */', html, flags=re.S)
html = html.replace("</body>", player + "\n</body>")
(d / "eew-animations.html").write_text(html, encoding="utf-8")
print("eew-animations.html written", len(html.encode()) // 1024, "KB")
