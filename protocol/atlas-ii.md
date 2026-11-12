# Atlas II — colour32可変長wire仕様 v2（送受信共通）

状態: **送出側のA2実装と共通ベクトルあり**。旧Atlas v8（24B、4bit/セル、固定1936x1168）とは非互換。`/bosai`の現行プロトコルとし、受信側 `chan-room-1 #2` と同じ仕様・テストベクトルを使う。実配信・実機再生の確認状況は運用記録に分けて記載する。

## 1. フレーム・格納規則

- 1映像フレームは**完全状態パケット1件**。差分状態を要しない。複製なし。パケットは`[28B共通ヘッダ][Rect×N][display? 2B][tsunami? 17B][eew? 可変][CRC32 4B]`の順。
- Byte整数は全てlittle-endian。パケットの全bitを**LSB-first**で連続列として読み、5bitずつ0〜31のシンボルにする。セル=8×8px、`R=85*(symbol&3)`, `G=85*((symbol>>2)&3)`, `B=255*((symbol>>4)&1)`。最終セルの余剰bitは0で埋める。バイト境界でセルを区切らない。
- Atlas解像度: 幅>=640px、幅/高さとも16pxの倍数、高さ>=32px、物理デコード環境の制約内。左下端から余白0pxでセルを敷き詰め、`columns=W/8`、`rows=H/8`とする。セルindex `i` は `c=i%columns`, `r=floor(i/columns)`、画像左上原点の8×8領域は`x=8c`, `y=H-8(r+1)`。サンプル中心は左下UV `((4+8c)/W,(4+8r)/H)`。
- データセルの行は**左下から開始**、行内は左から右、行末でひとつ上の行へ。列`c`,行`r`（ともに0始まり）のUV中心`u=(4+8*c)/W`, `v=(4+8*r)/H`（左下UV原点、実装側でAVProの反転等を調整）。ヘッダ28B=224bitは45セルで、最小幅640pxの80セル/行でも1行目に収まる。
- 先にプレイヤー等から**実際にデコードされたアトラステクスチャW/H**を取得し、左下最初の45セルでヘッダを読む。ヘッダ内のW/Hと実値を照合し、不一致を拒否。その後`cellCount=ceil(totalLength*8/5)`、`requiredRows=ceil(cellCount/columns)`を求める。`cellCount<=columns*rows`が必須。最終行の残りセルは無視する。
- 左下UV原点のセル中心は`((4+8c)/W,(4+8r)/H)`。行0は画像最下段の8px、次の行はそのすぐ上に置く。矩形描画に使う左上原点の座標系は別途維持する。
- 末尾CRC32: CRC-32/ISO-HDLC（IEEE；reflected polynomial 0xEDB88320；init/xorout 0xFFFFFFFF）。対象は末尾4Bを除く全バイト、格納はu32LE。**全検証後のみ状態を原子的に採用**。プロトコルversion違い・未知bit・矛盾・範囲外は拒否。
- libx264 CRF 18/23/28/32・yuv420pの固定パケット単一フレームでcolour32を完全復元し、CRCを含むpacket bytes一致を確認する。RGB誤差は観測値として記録し、規格上の受理条件にはしない。実機AVPro（Windows/Quest）のCRC通過率は未確認。

## 2. 共通ヘッダ 28B

|offset|bytes|field|value|
|---:|---:|---|---|
|0|2|magic|ASCII `A2`|
|2|1|version|`2`|
|3|1|sectionMask|bit0 display, bit1 tsunami, bit2 eew、bit3..7=0|
|4|2|totalLength|u16LE、CRCを含め32..65535|
|6|4|sequence|u32LE、描画・防災**状態変更**時に増分|
|10|8|senderUnixMs|u64LE、各映像フレームで更新する生成時Unixミリ秒|
|18|2|atlasWidth|u16LE|
|20|2|atlasHeight|u16LE|
|22|2|outputWidth|u16LE|
|24|2|outputHeight|u16LE|
|26|1|rectCount|0..15|
|27|1|reserved|0固定|

`senderUnixMs`は**送出/受信経路の診断時刻**であって元の地震電文の発表時刻ではない。時計差・動画バッファを考慮し、送信時刻との差が5秒を超えたというだけで接続を切らない。sequenceはtimestampのみの更新で増やさない。表示更新判定と新規フレーム/受信停止判定は別々に管理する。

## 3. Rect records

`RectCount`件を連続配置。COPY=18B / ALPHA_PAIR=26B。各Rect:
- offset 0: control u8、bit0 source（0=ATLAS、1=MAIN_VIDEO）、bit1 mode（0=COPY、1=ALPHA_PAIR）、bit2 visible、bit3..7予約0。
- offset 1: opacity u8（0..255）。
- offset 2..9: src(x,y,w,h) 各u16LE。
- offset 10..17: dst(x,y,w,h) 各u16LE。
- mode=ALPHA_PAIRのみoffset 18..25: alphaSrc(x,y,w,h) 各u16LE（sourceと同じテクスチャ内の輝度マスク）。色・輝度を同じローカルUVで取得してopacityを乗算。
- Rect配列順に描画、後ろのものが手前。Main動画も普通のRectとして扱う。座標は左上原点のピクセル。w,h=0・オーバーフロー・dst論理範囲外・src実テクスチャ範囲外・未知modeは禁止。visible=0でも検証。
- ATLAS src及びalphaSrcはこのパケットの**データ帯使用セル**と重ならないこと。Rect数0は有効な空描画であり、動画切断とは区別。

## 4. display section (mask bit0, 2B uint16LE)

bit0 地震テロップ表示中、bit1 横型EEW表示中、bit2 縦型EEW表示中、bit3 津波ミニマップ表示中、bit4 津波情報テロップ表示中、bit5..15=0。独立した「EEW発表中」bitは廃止。Rectが描画の権威を持ち、フラグはUdon向けの状態通知に限る。

## 5. tsunami section (mask bit1, 17B)

66区域×2bit=132bit。00=なし、01=注意報、10=警報、11=大津波警報。index `i` は `byte=i//4`、`shift=2*(i%4)`。最後のbyte16上位4bit=0。正本`protocol/atlas-ii-tsunami-areas-v1.json`にあるJMA津波予報区コード数値昇順の66区域を固定のindex 0..65に割り付ける。写像の変更には仕様version更新が必要。mask=0は完全状態として全地域0であり、取得不能を「警報なし」と誤変換してはならない。

## 6. eew section (mask bit2, 可変長)

EEW対象府県50bit・EEW新規追加50bitの**2つのbitmapsを完全廃止**し、すべて以下のAreaRecordへ包含する。

Section header（3B）: schemaVersion=u8(1)、areaMapVersion=u8(1)、eventCount=u8。その後eventCount件のEventレコードを並べる。

**Event**: `eventFlags u8`、`issueUnixSeconds u32LE`、`serial u16LE`、`maxScalePair u8`、`areaCount u16LE`、`eventIdLength u8`、`eventId UTF-8 bytes [eventIdLength]`、`AreaRecord[areaCount]`。固定部分11B、IDは最大255 UTF-8 bytes。serial=65535は不明。EventIDは一意で非空（取消イベントも）。Eventは同時地震を別々に保持する。

EventFlags: bit0 cancelled、bit1 warningSetComplete、bit2 predictionSetComplete、bit3 priorWarningComparable、bit4..7予約0。キャンセルイベントはareaCount=0。bit3=0ならすべてのAreaRecordでnewlyAdded=0とし、追加なしと断定しない。

maxScalePair: 下位4bit予想最大震度下限、上位4bit上限。区域予測から導出する補助値であり、predictionSetComplete=0なら**全国全体の最大とは保証しない**。上限コード99=「以上」は数値99の震度ではない。

**AreaRecord 6B**：
|relative offset|bytes|field|
|---:|---:|---|
|0|2|areaId u16LE: 権威ある対応表で`pref+name`から対応付けるJMA細分区域コード|
|2|1|scalePair: 下位4bit=scaleFrom、上位4bit=scaleTo|
|3|1|areaFlags: bit0..1 arrivalKind、bit2 warningTarget、bit3 newlyAdded、bit4..7=0|
|4|2|arrivalOffsetSeconds i16LE（issueUnixSeconds基準）|

震度nibble: 0→-1(不明), 1→0, 2→10, 3→20, 4→30, 5→40, 6→45, 7→50, 8→55, 9→60, 10→70, 11→99（scaleTo専用）。12..15は禁止。

arrivalKind: 00 未提供、01 kindCode=10（未到達）、10 kindCode=11（到達済）、11 kindCode=19（PLUM・時刻なし）。arrivalOffsetSecondsの-32768は不明/nullの予約値。他は-32767..32767秒で、EEW発表時刻からの差（負も許可）。地震要素側`earthquake.arrivalTime`を混同しない。

**warningTarget**=当該EEWの警報対象として発表された区域。単なる予測震度の閾値判定では作らない。警報対象だが予測項目がない区域も、areaIdを付与して震度不明としAreaRecordへ含める。警報対象集合が完全なときEventFlags bit1=1。

**newlyAdded**=同じEventIDの前回警報と比較して今回新規に警報対象となった区域。初回警報は0、比較履歴なしでは0（EventFlags bit3=0）、同一報を繰り返す映像フレームでは同じ値を保持。`newlyAdded=1⇒warningTarget=1`は必須。比較履歴あり/なしは取り違えない。

AreaRecordはareaId昇順、重複禁止。eventId/serialをもとに前報と比較する。P2P code 556の`areas[]`には`pref`,`name`,`scaleFrom`,`scaleTo`,`kindCode`,`arrivalTime`があるが、**数値areaIdやnewlyAddedは提供されない**。この版のareaMapVersion=1を運用するには、実際の`pref+name`⇔JMA細分区域コード表を検証し固定する必要がある。未確認のIDを推測して作成しない。入力資料だけでwarningTargetが確定できないときはbit1=0として不完全性を残す。

mask bit2=0はEEWイベント空集合。前のフレームから保持しない。

## 7. CRC・受信検証・容量

ヘッダを仮解析→全長が1フレームの物理セル容量内か確認→全セル読出→CRCを検証→header、Rect、セクション順に厳密解析→過不足・不正予約bit・不正領域・不正ID・新規追加矛盾を拒否→一括採用。再接続直後も完全状態を復元する。

最小0Rect/0section: 32B=52セル。COPY×1:50B=80セル。典型的逆L（COPY×3 + ALPHA_PAIR×1）:112B=180セル。同構成＋display＋津波:131B=210セル。これにEEW event 1件（ID14B、Area×50）を加えると459B=735セル。15件すべてALPHA_PAIR＋display＋津波＋同EventでArea255なら1999B=3199セル。1280幅は160セル/行、1936幅は242セル/行。送信前に高さ収容・Rect非重複をチェック。

固定テストベクトルは`protocol/atlas-ii-vectors.json`で両repo共有。バイナリ完全一致・CRC不一致・未知version・異なる実寸・areaFlags矛盾・不正mapVersionをテスト。静止PNGの成功だけでは圧縮映像やUnity/Udon上の復元を保証しない。
