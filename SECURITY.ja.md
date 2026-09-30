# セキュリティとデータの取り扱い

[English](SECURITY.md) | **日本語**

## サマリー

本アプリは、開発者本人が localhost で使う会話処理の観察用ツールです。
ソースコードを公開しても、稼働中の HTTP / WebSocket サーバーはインターネットや LAN に公開しないでください。
ログイン機能、利用者別の認可、永続監査、利用料金の上限管理はありません。

## 接続と認証

- [app.py](app.py) の起動先は `127.0.0.1` です。Host 制限とセッション作成・WebSocket の Origin 検査がありますが、利用者認証の代わりではありません。
- API キーはルートの `.env` または環境変数に設定します。Azure はキーがなければ `AzureCliCredential` で Azure CLI のログイン済み ID を使います。Managed Identity などへの自動切り替えはしません。
- ブラウザーに渡すのはセッション ID と SDP answer です。API キー・Entra トークンはサーバー側で保持します。SDP 自体にも接続情報が含まれるため、共有しないでください。
- `GET /api/config` の設定済み表示は、サービスへの認証・モデルの利用権限・ネットワーク疎通の確認ではありません。
- 「天気検索を実行する」は初期状態で ON です。無料のリプレイは、先に OFF にしてから開始してください。ON の場合は合成の委譲でも判断 API を呼び出し得ます。
- リプレイは Client モード専用です。Responses モードでは検索 OFF でも音声セッションと委譲先モデルの料金が発生し得ます。OFF は天気関数の実行制限であり、モデルの呼び出し停止ではありません。

根拠：[サーバー](app.py)、[設定・認証](lab/provider.py)、[ブラウザーのリプレイ・実行制御](static/app.js)、
[Azure GPT-Live WebRTC](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-webrtc)。

## 外部へ送る情報

| 送信先 | 送信する主なデータ | 条件 |
| --- | --- | --- |
| Azure OpenAI または OpenAI の Live | セッション指示、SDP、マイク音声、委譲への返答 | ライブ接続時。音声はブラウザーとサービスの WebRTC で転送 |
| Azure OpenAI Responses API | 累積 SRT、判断指示、天気関数の JSON Schema、関数結果 | Client + Function Calling を選択して実行する場合 |
| Live に構成した Responses モデル（Azure OpenAI / OpenAI） | GPT-Live が供給する会話文脈、判断指示、天気関数の JSON Schema、アプリが返す関数結果 | Responses delegation の場合。Ledger は使用しない |
| TypeSafe API | 累積 SRT、今回分の SRT、17 候補と判断指示 | Client + Jev を選択して実行する場合 |
| Open-Meteo | 都市名による地名検索、取得した座標による天気要求 | 天気関数を実行する場合 |

SRT には USER / ASSISTANT の会話を含みます。Client 内で判断方式を切り替えても累積文脈は消えないため、
以前に別方式で処理した会話が、新しく選択したプロバイダーへ送信される場合があります。
Client / Responses の委譲モードを変更するとローカルの記録をリセットしますが、既に送信したデータの削除を意味しません。
本アプリのローカル保持方針は、外部サービスのデータ保持・利用条件を保証するものではありません。
Client の Responses 要求に設定する `store: false` も、すべてのサービスで一切保存しないことを意味しません。
Responses delegation の設定には本アプリから `store: false` を指定していません。

根拠：[実行管理](lab/execution.py)、[Responses 要求](lab/backend.py)、[Jev 要求](lab/jev.py)、
[天気取得](lab/weather.py)、[GPT-Live delegation](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation)、[TypeSafe API](https://docs.typesafe.ai/api)、[Open-Meteo](https://open-meteo.com/en/docs)。

## 保存と共有

会話とタイムラインはブラウザーおよび観察用 WebSocket に対応するサーバーのメモリで保持します。
会話の自動ファイル保存・生音声の録音はしません。波形は振幅の集計値です。
JSON の手動保存には会話本文、実際のモデル要求本文、関数結果、関連 ID と波形集計が含まれ得ます。
エクスポートは匿名化済みの公開資料ではありません。スクリーンショット・例外ログにも同じ注意が必要です。

`.gitignore` は秘密情報やエクスポートの誤登録を減らす補助です。既に追跡されたファイルや Git 履歴から情報を削除するものではありません。
`.env`、認証ヘッダー、SDP、会話のエクスポートを Issue・Pull Request・公開リポジトリに添付しないでください。
秘密情報を漏らした場合は、履歴の整理に先立ち対象の資格情報を失効・再発行してください。

テーマと表示言語の選択はブラウザーの `localStorage` に保存します。会話データは含みません。

根拠：[ブラウザーの記録処理](static/app.js)、[波形処理](static/audio-waveform.js)、[サーバーの状態管理](lab/state.py)。

## 実行上の限界

許可する操作は 12 都市の現在の天気検索のみです。モデルの引数や Jev の候補・確率・信頼度を検証しますが、
ユーザーの文意を別の検証器で再判定する仕組みはありません。confidence は正答やユーザー承認の証明ではありません。
Client モードでは新しい委譲が古い結果の返却を抑止しますが、既に開始された外部要求や課金を取り消す保証はありません。
Responses モードは委譲 ID ごとに処理し、新しい委譲の発生だけで古い要求を自動取消する制御はありません。
実行 OFF は天気取得の前に確認します。既に進行中の検索の取消や、Live に自動注入されるモデル出力の事前審査を保証しません。
本実装を決済・予約・削除などへ転用する場合は、別途、権限確認・明示的承認・重複実行防止が必要です。

根拠：[引数検証](lab/backend.py)、[Jev の検証](lab/jev.py)、[取消処理](lab/execution.py)、
[Client delegation の実行責任](https://developers.openai.com/api/docs/guides/live-delegation)。

## 問題の報告

秘密情報や実会話を含まない最小の再現手順を用意してください。
機微な情報を含む問題は公開 Issue に書かず、公開先の管理者が用意した非公開の報告経路を利用してください。
この配布物は専用の連絡先・対応期限・セキュリティ保証を定めていません。