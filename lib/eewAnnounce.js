"use strict";

// EEW の基準は「表示」と「投稿」で別 (2026-11-26 ユーザー決定で
// 分離。2026-11-24 の統一は廃止)。
//
// 表示基準 (オーバーレイ /bosai) は全件: 予想最大震度によらず出し、
// 予報級 (警報でない) EEW は地図を出さず、横型ボックスと同じ位置の
// 角丸・半透明ウィンドウに2行テキストで出し、警報級は地図つき
// ボックスで出す。表示側の判定は isEewDisplayableMaxInt /
// eewDisplayMode。
//
// 投稿基準 (Discord) は従来どおり: 予想最大震度が「不明・4・5弱・
// 5強・6弱・6強・7」のいずれかなら対象とする (3以下は対象外)。
// 警報級と取消は常に対象。投稿側の判定は isEewPostable /
// isEewAnnounceableMaxInt。状態側の「出た EEW」記録
// (eewOutputEvents) も投稿基準で付ける (lib/atlasData.js)。
//
// 基準は EEW レイヤーに適用する (情報源は問わない)。
// 震度は内部表記 ('5-' = 5弱、'5+' = 5強、'6-' = 6弱、'6+' = 6強) で、
// 「不明」は maxInt が null (解釈不能・未設定) で表す。
// ブラウザ側 (telop/atlas-live.js) はページへ埋め込まれるため require
// できず、表示基準の判定 (eewDisplayMode) をそちらにも持つ。変更時は
// 両方を揃えること。

const { normalizeIntensity } = require('./parsers/eewJson');

// 投稿基準 (bot) の震度集合。表示基準では使わない。
const EEW_ANNOUNCE_MAX_INTENSITIES = new Set(['4', '5-', '5+', '6-', '6+', '7']);

// 内部表記の大小順 (最大値の導出用)。eewJson の数値コード順と一致する。
const EEW_INTENSITY_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];

// EEW の予想最大震度を bulletin から決める。通常は intensity.maxInt
// (JSON 源は変換時に設定済み) をそのまま使う。JMA XML の EEW
// (VXSE43/44) では intensity.maxInt が Observation 由来のため常に
// null になり、予想は区域別 ForecastInt.To (eewForecastAreas の
// scaleTo) にしか無いので、その最大値を導出する。正規化は
// lib/parsers/eewJson.js の normalizeIntensity が正本 ('5弱'→'5-'、
// 数値コード等)。区域が無い・全て解釈不能なら null (不明) のまま。
function deriveEewMaxInt(bulletin) {
  const direct = bulletin?.intensity?.maxInt;
  if (direct != null) return direct;
  let derived = null;
  for (const area of bulletin?.eewForecastAreas || []) {
    const normalized = normalizeIntensity(area?.scaleTo);
    if (normalized && (derived == null
      || EEW_INTENSITY_ORDER.indexOf(normalized) > EEW_INTENSITY_ORDER.indexOf(derived))) {
      derived = normalized;
    }
  }
  return derived;
}

// 予想最大震度が投稿基準 (bot) の対象か (不明 = null は対象に含む)。
// 表示基準では使わない。
function isEewAnnounceableMaxInt(maxInt) {
  return maxInt == null || EEW_ANNOUNCE_MAX_INTENSITIES.has(maxInt);
}

// 予想最大震度が表示基準 (オーバーレイ) の対象か。表示は全件
// (2026-11-26 ユーザー決定) のため、震度によらず常に対象とする。
function isEewDisplayableMaxInt(maxInt) {
  return true;
}

// オーバーレイでの EEW の出し方。
// 'box' = 警報級 (地図つきボックス)、'window' = 予報級
// (角丸・半透明ウィンドウの2行テキストのみ)。
// isWarning が記録されていない旧形式の render は従来どおり 'box' とする。
function eewDisplayMode({ isWarning, maxInt } = {}) {
  if (isWarning !== false) return 'box';
  return isEewDisplayableMaxInt(maxInt) ? 'window' : 'none';
}

// Discord bot の投稿対象か。警報級と取消は常に対象、予報級は予想最大
// 震度が通知集合に入る場合だけ対象にする (従来は警報級と取消のみ)。
function isEewPostable(parsed) {
  if (!parsed) return false;
  return Boolean(parsed.isWarning)
    || parsed.infoType === '取消'
    || isEewAnnounceableMaxInt(parsed.intensity?.maxInt);
}

module.exports = { EEW_ANNOUNCE_MAX_INTENSITIES, isEewAnnounceableMaxInt, isEewDisplayableMaxInt, eewDisplayMode, isEewPostable, deriveEewMaxInt };
