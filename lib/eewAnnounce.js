"use strict";

// EEW の発表基準 (2026-11-14 ユーザー決定)。
// 予想最大震度が「不明・4・5弱・5強・6弱・6強・7」のいずれかなら全体通知
// する (3以下は通知しない)。出し先はオーバーレイ (/bosai・/bosai-overlay)
// と Discord 情報 bot の両方。予報級 (警報でない) EEW は地図を出さず
// 上部の文字テロップでのみ出し、警報級は地図つきボックスで出す。
// 基準は EEW レイヤーに適用する (情報源は問わない)。
// 震度は内部表記 ('5-' = 5弱、'5+' = 5強、'6-' = 6弱、'6+' = 6強) で、
// 「不明」は maxInt が null (解釈不能・未設定) で表す。
// ブラウザ側 (telop/atlas-live.js) はページへ埋め込まれるため require
// できず、同じ集合をそちらにも持つ。変更時は両方を揃えること。

const EEW_ANNOUNCE_MAX_INTENSITIES = new Set(['4', '5-', '5+', '6-', '6+', '7']);

// 予想最大震度が全体通知の対象か (不明 = null は対象に含む)。
function isEewAnnounceableMaxInt(maxInt) {
  return maxInt == null || EEW_ANNOUNCE_MAX_INTENSITIES.has(maxInt);
}

// オーバーレイでの EEW の出し方。
// 'box' = 警報級 (地図つきボックス)、'telop' = 予報級かつ通知対象
// (上部テロップのみ)、'none' = 出さない。
// isWarning が記録されていない旧形式の render は従来どおり 'box' とする。
function eewDisplayMode({ isWarning, maxInt } = {}) {
  if (isWarning !== false) return 'box';
  return isEewAnnounceableMaxInt(maxInt) ? 'telop' : 'none';
}

// Discord bot の投稿対象か。警報級と取消は常に対象、予報級は予想最大
// 震度が通知集合に入る場合だけ対象にする (従来は警報級と取消のみ)。
function isEewPostable(parsed) {
  if (!parsed) return false;
  return Boolean(parsed.isWarning)
    || parsed.infoType === '取消'
    || isEewAnnounceableMaxInt(parsed.intensity?.maxInt);
}

module.exports = { EEW_ANNOUNCE_MAX_INTENSITIES, isEewAnnounceableMaxInt, eewDisplayMode, isEewPostable };
