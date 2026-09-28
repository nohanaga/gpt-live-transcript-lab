const transcript = (speaker, id, delta, start_ms, end_ms) => ({
  type: `session.${speaker}_transcript.delta`,
  event_id: id,
  delta,
  start_ms,
  end_ms,
});
const delegation = (id, offset_ms) => ({
  type: 'session.delegation.created',
  event_id: `event_${id}`,
  offset_ms,
  delegation: { id, type: 'delegation', target: 'client' },
});
const start = { type: 'session.started', event_id: 'replay_started', session: { id: 'replay_local' } };
const closed = { type: 'session.closed', event_id: 'replay_closed', usage: { note: 'simulation — no API usage' } };
const at = (arrival_ms, event, note) => ({ arrival_ms, event, note });

export const scenarios = [
  {
    id: 'fragments',
    title: '01 · 基本のフラグメント',
    description: 'transcript delta の統合、segment.updated の全文置換、最終イベント前の待機中に発生する inactivity を検証します。',
    expect: 'Grouper は更新ごとに全文を置き換えます。閉鎖は音声の再生完了を意味しません。',
    events: [
      at(0, start, '録音も API 通信もない、模擬セッション開始'),
      at(100, transcript('input', 'u1', 'こんにちは。', 0, 500), '最初の断片 · 50 ms の settle'),
      at(350, transcript('input', 'u2', '今日の予定を教えて。', 500, 1100), '同じ話者の断片を追加'),
      at(800, transcript('output', 'a1', 'こんにちは。', 1700, 2200), '話者の切り替え'),
      at(1100, transcript('output', 'a2', '予定を一緒に確認しましょう。', 2200, 3300), 'assistant の全文スナップショットを更新'),
      at(3400, closed, '到着待機中に inactivity · 最後に session.closed'),
    ],
  },
  {
    id: 'backchannel',
    title: '02 · 重なる相づち mhm',
    description: 'user の発話に短い mhm が重なります。「相づち抑制」を OFF にしてリセットすると比較できます。',
    expect: '抑制 ON では mhm が表示から省かれ得ます。Ledger は相づちも保持します。表示整形と文脈保持は別の責務です。',
    events: [
      at(0, start, '模擬セッション開始'),
      at(100, transcript('input', 'u1', '今週の旅行は', 0, 700), 'user の発話'),
      at(250, transcript('output', 'a1', 'mhm', 350, 650), '重なった短い相づち · buffered を観察'),
      at(500, transcript('input', 'u2', '大阪にしようと思います。', 700, 1700), 'user が相づちの後も続く'),
      at(1100, transcript('output', 'a2', '大阪、いいですね。', 2500, 3400), '通常の assistant 発話'),
      at(1600, delegation('d_ack', 3000), 'Ledger の相づちも含めて模擬ハンドオフ'),
      at(2000, closed, '模擬セッション終了'),
    ],
  },
  {
    id: 'duplicates',
    title: '03 · 重複 event_id',
    description: '同じ event_id の断片を二度配信します。生ログでは二件、Grouper と Ledger では一度だけ反映されます。',
    expect: '重複排除のキーは event_id。異なる ID の繰り返しテキストは、そのまま別の入力です。',
    events: [
      at(0, start, '模擬セッション開始'),
      at(100, transcript('input', 'same_id', '一度だけ。', 0, 500), '最初の受信'),
      at(400, transcript('input', 'same_id', '一度だけ。', 0, 500), '同一 event_id を再受信'),
      at(700, transcript('input', 'new_id', '一度だけ。', 500, 1000), '異なる ID なら同じ文字列でも追加'),
      at(1100, delegation('d_duplicate', 1000), '重複を除いた Ledger を模擬消費'),
      at(1400, closed, '模擬セッション終了'),
    ],
  },
  {
    id: 'late-correction',
    title: '04 · 委譲の後に届く訂正',
    description: '「東京」の受信後に委譲、その後に「いえ、大阪」が届きます。ステップ実行で消費済みカーソルを観察してください。',
    expect: '最初の SRT は変更されません。遅れて届いた訂正は次のハンドオフへ。offset_ms は因果対応や締め切りを保証しません。',
    events: [
      at(0, start, '模擬セッション開始'),
      at(100, transcript('input', 'u1', '東京', 0, 300), '最初の行き先'),
      at(300, delegation('d_before_correction', 250), '訂正より先に委譲が到着 · 現在の未消費 SRT を取得'),
      at(800, transcript('input', 'u2', '、いえ、大阪で。', 320, 700), '遅れた訂正 · 次回用の未消費テキスト'),
      at(1300, delegation('d_after_correction', 700), '二度目のハンドオフで訂正のみ消費'),
      at(1700, closed, '模擬セッション終了'),
    ],
  },
  {
    id: 'timestamp-reset',
    title: '05 · ソース時刻の巻き戻り',
    description: '後から到着するイベントの start_ms が小さくなります。到着順とソース時刻は同じではありません。',
    expect: 'Grouper は timestamp_reset で表示セグメントを確定します。Ledger は独自の記録規則で保持します。',
    events: [
      at(0, start, '模擬セッション開始'),
      at(100, transcript('input', 'u1', '先に届いた発話。', 5000, 5600), 'ソース時刻 5 秒のイベント'),
      at(500, transcript('input', 'u2', '時刻が戻りました。', 100, 800), '到着は後、start_ms は前 · timestamp_reset'),
      at(1000, transcript('output', 'a1', '新しい区間として表示します。', 1500, 2200), '新しいソース時刻から進む'),
      at(1400, closed, '模擬セッション終了'),
    ],
  },
];
