// 計算・判定用の数値とは分離し、人に表示する本文だけを全角数字化する。
// Unityリッチテキストのタグ属性（色コード、indent値など）は変更しない。
function toFullwidthDigits(value) {
  return String(value ?? '').replace(/(<[^>]*>)|([0-9])/g, (match, tag, digit) => {
    if (tag) return tag;
    return String.fromCharCode(digit.charCodeAt(0) + 0xfee0);
  });
}

module.exports = { toFullwidthDigits };
