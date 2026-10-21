# 起動ごとの実モデル選択記録

`launches.jsonl` の `claude-code/auto` は入口の名前で、実際の選択モデルではありません。新しい記録は、起動後に最初の主リクエストが成功した時点で `~/.jev-router/orca-launch/selections/<起動ID>.jsonl` に1行だけ保存します。入力前・失敗したリクエスト・補助リクエストでは実モデルを記録しません。判定されなかった重さや、確認できない推論量は `null` のままです。

行には起動時刻・選択時刻（UTC）、機械、作業場所、端末名とhandle、Pi/Claude、難度と影響の判定値、実モデル、推論量、候補、起動時policyのSHA-256、選択元と理由が入ります。難度・影響は既存judgeの0〜3の尺度です。cascade時は最後に実際に応答したモデルを記録します。本文・ツール引数・認証情報・環境変数・policy全体は記録しません。

## 配置と確認

既存のWindows/Linux用 `orca-launch/launch.cjs` と配布済みruntimeを使います。ビルド済みruntimeへこの版を配置した後、次で起動スクリプトに共通の小さな追記を行います。元ファイルは日時付きで保存され、二重実行では追記しません。

```sh
node scripts/enable-launch-audit.cjs
```

`scripts/recent-launch-selections.cjs` を `~/.jev-router/orca-launch/` に置くと、各機械・作業場所の最新の実選択を1行ずつ表示できます。

実装担当の起動では、同じ `launches.jsonl` に `event:"harness"`（選んだハーネス・候補・**予定**モデル `plannedModel`・理由・残枠・フォールバック）、`event:"harness_launch"`（起動できたか `launchOk`・終了コード・失敗の種類）、`event:"harness_handoff"`（変更が残ったため再実行しなかった）も増えます。実際に適用されたモデルはこの経路では観測しないため `appliedModel` は常に `null` です。詳しくは [HARNESS_SELECTION](HARNESS_SELECTION.md)。```sh
node "$HOME/.jev-router/orca-launch/recent-launch-selections.cjs"
```

Piは次の起動から有効です。Claudeは次の起動に加え、共有relayもこの版で動いている必要があります。既存の作業を中断せず、そのrelayを使うClaudeが入力待ちになってから個別に切り替えます。端末や共有relayの一括停止はしません。起動IDの専用ヘッダーはrelay内部だけで使い、上流へは送りません。

## エラーと戻し方

- `jev-router: launch selection audit write failed`：選択記録の保存に失敗しました。既存の判定ログとモデル応答は続きます。`orca-launch/sessions` と `selections` の所有者・書込権限を確認してください。秘密を含むファイルを診断ログへ貼らないでください。
- 記録がない：入力前、応答未完了、起動前の旧セッション、または旧relayの可能性があります。`launches.jsonl` の起動IDと対応する `sessions/launch-<起動ID>.json` を確認してください。過去の判定やpolicyハッシュは推測で補いません。
- 戻すときは日時付きの `launch.cjs.bak-audit-*` とruntimeの控えを、対象の作業の区切りで戻します。新旧runtimeのファイルを消し込まず配置すれば、旧プロセスの遅延読込みも壊しません。

## 開発時の検証

`bun run check`（型、lint、全件テスト、build、Nodeの切断試験）。実接続の確認はこれとは別です。mockの成功を本物のログインによる推論成功とは扱いません。
