# 実装担当のハーネス選択

Jevはモデルと推論量だけでなく、**明示された実装担当の起動境界**で実行ハーネスも選びます。新しい管理システムや別の判断エンジンは作りません。既存の起動ラッパー（`orca-launch/launch.cjs`）、既存の難度・実影響の判断（`src/core/work.ts`）、既存のログを使い、選べる状態が確認できない候補は無効のまま既存のPi/Claude経路へ戻ります。

- 対象: 実装・テスト修正の作業者起動だけ。
- 対象外: PM、最終設計判断、重要な独立レビュー、作業途中の既存Pi/Claudeセッション、別モデル・有料Zen・従量課金API。役割名やプロンプトから推測しません。

## 人が切り替える候補集合

デスクトップの「Jev 候補切り替え」小窓で3択を選びます。モデル・残枠の入力は不要です。変更は次の実装境界から有効になり、実行中の会話を停止しません。

| 表示 | mode | 候補 |
|---|---|---|
| OpenCode Freeあり | `free-with-go` | 無料2候補 → Go → Pi |
| OpenCode Go枠 | `go-only` | Go → Pi |
| OpenCodeなし | `none` | Piのみ |

`scripts/harness-mode.cjs get` / `set <mode>` はデスクトップ・deep-dev2・deep-devを操作し、各台の再読結果をJSONで返します。`--local` は当該機械のみ。保存先は各利用者の `~/.jev-router/orca-launch/harness-mode.json`。自動のhealth記録とは別に保持し、部分失敗を全台成功と表示しません。

## 優先順位（2026-10-22 長倉さん指示・4候補）

**第1群（無料枠）**
1. `opencode/deepseek-v4.1-flash-free`（既存の基本。記録に `model` が無くても動く）
2. `opencode/glm-5.3-flash-free`（**実ID・無料経路・実動作が未確認のあいだは無効**）

**第2群（OpenCode Go契約枠。検証済み実ID・契約経路を使い、残枠数値は起動条件にしない）**
3. `opencode-go/deepseek-v4.1-flash`
4. `opencode-go/glm-5.3-flash`

**第3群**
5. Pi（既存経路。`JEV_HARNESS_FALLBACK=pi|claude` でClaudeも選べる）

- 同じ群の中は上の順。無料枠が残っている候補があれば、課金枠より先に必ずそれを使う。
- 候補ごとに健全性・失敗・残枠・モデルを**独立**に持ちます。片方の無料候補が枠切れでも、もう片方は使えます。
- 第2群へ移るのは第1群が**容量**で使えなくなったとき（枠切れ・429・混雑、またはその作業の品質不足）。認証・通信の失敗や未確認では移りません。
- 未確認のモデルIDを推測で選びません。`model` が無い、または候補自身の許可リスト（`family`）に無い記録は、その候補の許可になりません。
- **難しい実装は無料もGoも使わずPiへ直行。** 既存の作業文脈（`updateWorkContext`）の工程がdesign/review、認証・決済・移行を伴う設計、または既存policyの難度しきい値（`>= 2.6`）以上を「難しい」とします。健全という理由だけで難しい作業を安いモデルへ渡しません。
- 認証エラー・通信障害は容量問題ではないのでGoを解禁しません（`go_withheld_operational`）。

## 呼び方（担当③＝PM側）

```sh
node <home>/.jev-router/orca-launch/launch.cjs implementation [-- 引数]
```

`implementation` という**明示的な第1引数**が唯一の境界です。`pi` / `claude` の既存の呼び方は今までどおりで、ハーネス選択は働きません。

### 形は2つだけ

1. **対話**（Orca端末・人が見る）: 引数はOpenCodeのTUI引数。
   - Jevが `--agent build --auto` を補い、呼び出し側の `--model` / `-m` / `--thinking` は子へ渡しません。
2. **非対話**（PM受付）: `-p` / `--print` を含むPi互換の呼び方。
   - `-p <text>` はその文字列、`-p` だけなら **stdinをEOFまで読んで**プロンプトにします（TTYのまま渡さない）。
   - Jevが `opencode run --agent build --auto <prompt>` に変換します。
   - 子プロセスの標準入力は**閉じます**。`opencode run <prompt>` は標準入力が終端しないと1文字も出さずに待つため、呼び出し側が開いたパイプをそのまま渡すと、モデルに届かないまま無出力で止まります（2026-10-22、deep-dev2/deep-dev の実測）。
   - Pi専用のフラグ（`--no-session` `--no-extensions` `--no-mcp` `--no-skills` など）は落とし、**落とした名前を `droppedArgs` としてログに残します**。無言で消しません。

### 出力と終了コード

- 非対話の stdout は最終応答テキストだけ。途中の文章は stderr に進捗として流します（`--format json` で受け、最後の text パートだけ stdout へ）。
- 子は `--standalone` で専用サーバーを立てます。共有のバックグラウンドサービスは起動時に読んだ設定を保持し、後から渡した `OPENCODE_CONFIG_CONTENT` を無視するためです（deep-dev2 実測。この場合選んだモデルではなく `opencode-go/auto` が走ります）。
- 終了コードはOpenCodeの値（0=正常、非0=失敗）。Jevはタイムアウトを足しません（呼び出し側の責任）。
- **終了コード0でも本文が0バイトなら失敗**（`failureKind:"no_output"`、exit 1）。無出力を成功と読み替えません。
- `SIGINT` / `SIGTERM` は子へ転送し、`event:"harness_cancel"` を残して 130 / 143 で終わります（Linux）。Windowsの強制終了では子が残るため、取消は呼び出し側が変更の有無を確認してから行ってください。
- 起動確認だけなら `JEV_ORCA_PROBE=1`。選択結果と `args` / `droppedArgs` のJSONを出し、推論を始めません。

## 実行後の扱い

- 容量失敗（`quota` / `congestion`）で落ちた場合、**worktreeに変更が無く、非対話の形のときだけ**、同じプロセス内で次の候補へ切り替えます（`retryReason` を記録）。失敗した候補は `exclude` で外すので、第1群の別候補 → 第2群 → Pi の順に進みます。
- 4候補を各1回まで辿り、すべて失敗した後にもPiへの引継ぎを実行します。modeは境界内で固定し、途中の切替は次の境界から反映します。
- **変更が残っているときは再実行しません。** 変更とログをそのまま残し、`event:"harness_handoff"`（`handoff:"pi"`）を記録して非0で終わります。同じworktreeを2つのハーネスが並行編集しないためです。
- 認証・通信・無出力・その他の非容量失敗は、変更の無い非対話実行なら別のOpenCode候補へ広げずPiへ直行します。対話形は停止、変更が残れば確認付き引継ぎです。
- 状態へ書き戻すのは分類できた容量失敗だけです。新しい観測を上書きせず、確認済みmodel・quality等を保持します。Go容量失敗は次の別境界、Free容量失敗は既存24時間窓の経過後に再試行できます。非容量失敗を能力不足や架空の残枠に置き換えません。

## 判定（`src/runtime/harness.ts`）

| 状態 | 選ぶもの | 理由の語 |
|---|---|---|
| 第1群の1番目（DeepSeek Free）が検証済み `ok` | `opencode/deepseek-v4.1-flash-free` | `free_verified` |
| 1番目が使えず、2番目（GLM Free）が `ok` かつ自分の `family` の `model` を持つ | `opencode/glm-5.3-flash-free` | `free_verified` + `free_*`（1番目を外した理由） |
| 第1群が容量で使えない、または `go-only` で、第2群が検証済み・`model` 許可内 | 該当するGo候補 | `go_verified` + `free_quota_failure` など |
| 難しい作業（工程 design/review・重大設計・難度しきい値以上） | 既存の Pi / Claude | `hard_work_pi` |
| 第1群が認証/通信で失敗、未確認、未来日時 | 既存の Pi / Claude | `free_auth_failure` など + `go_withheld_operational` |
| Go候補の実IDが未確認・許可外 | そのGo候補を選ばない | `go_model_unverified` / `go_model_not_allowed`（GLM候補は `go_glm_*`） |
| Goの残枠が unknown・古い・0 | 数値だけでは拒否せず、許可されたGoを試行する | 実行結果で次候補・Pi復帰を判断 |
| 容量は尽きたが第2群に確認済みの候補が無い | 既存の Pi / Claude | `go_none_verified` |

- 理由の語は候補ごとに接頭辞が付きます。`free_`（DeepSeek Free）、`free_glm_`（GLM Free）、`go_`（Go DeepSeek）、`go_glm_`（Go GLM）。
- 失敗の種類は `auth`（401/403・provider.auth）、`quota`（429・残量不足・無料枠の上限メッセージ）、`congestion`（503/529・混雑）、`network`（接続不能）、`quality_insufficient`（成果物の品質・速度不足）に分けます。`FreeUsageLimitError` / `provider.free-limit` / `Free usage limit reached` も `quota` として扱い、状態へ自動で書き戻します。
- **未来のhealth観測は有効として扱いません。** 現在より5分（`CLOCK_SKEW_MS`）を超えて先なら「未確認」に倒れます。残枠の値・時刻は参考情報で、候補を許可・拒否する根拠にしません。
- **品質不足は作業ごと・期限付きです。** `scope`（Task ID）が付いた記録は、同じ `scope` の起動にだけ効きます。無関係なTaskへ永久に効かせません。12時間（`QUALITY_MAX_AGE_MS`）で失効します。

## 担当②が置く情報

`~/.jev-router/orca-launch/harness-status.json`（`JEV_ROUTER_HARNESS_STATUS` で変更可、権限600）。候補ごとに**最後の観測1件**だけを持ちます。書式が壊れている・候補名が違う・時刻が読めない場合は「未確認」として無効側に倒れます。

```json
{
  "version": 2,
  "candidates": {
    "opencode-free": { "at": "2026-10-22T05:10:00.000Z", "ok": true, "latencyMs": 3632 },
    "opencode-free-glm": { "at": "2026-10-22T05:10:00.000Z", "ok": true, "model": "opencode/glm-5.3-flash-free" },
    "opencode-go": {
      "at": "2026-10-22T05:10:00.000Z",
      "ok": true,
      "model": "opencode-go/deepseek-v4.1-flash",
      "latencyMs": 4946,
      "quota": { "remaining": 40, "checkedAt": "2026-10-22T05:09:00.000Z", "source": "取得元の短い名前", "limit": 100 }
    },
    "opencode-go-glm": {
      "at": "2026-10-22T05:10:00.000Z",
      "ok": true,
      "model": "opencode-go/glm-5.3-flash",
      "quota": { "remaining": 40, "checkedAt": "2026-10-22T05:09:00.000Z", "source": "取得元の短い名前" }
    }
  }
}
```

- `at` … 観測時刻（ISO）。正常な検証済みアクセスは時間だけで失効させません。Free容量失敗の再試行には24時間窓を使います。未来は無効。
- `ok:false` のときは `failure` を付けます。
- **`model` … その候補で実際に確認した `provider/model`。** 候補ごとの `family`（`HARNESS_CANDIDATES`）に一致しない記録は、その候補の許可になりません。GLM Free・Go GLM・Go DeepSeek は `model` が必須で、無い記録は未確認として無効です。既存の `opencode-free`（DeepSeek Free）だけは、古い記録（`model` 無し）でも動きます。
- `quota.remaining` … 取得元が返した参考残量（任意）。`checkedAt` と `source` は実観測を記録し、未取得・古い・0でもGoの起動条件にはしません。数値を捏造・定期更新して有効化する運用は不要です。
- `quality: [{"at":"ISO","scope":"APP-G1-T02","evidence":"短い説明"}]` … 品質不足の記録。`scope` が無い記録は全作業に効きますが、期限で失効します。
- 書き込みは同梱の `writeHarnessStatus`（配置済みruntime）を使うと原子的に1候補だけ更新できます。資格情報・URL・環境変数はこのファイルへ入れません。

## 記録（既存ログ）

`~/.jev-router/orca-launch/launches.jsonl` に、起動ごとに次の行が増えます。

- `event:"harness"` … `selected`、`candidate`、`plannedModel`、`appliedModel`（**常に null**）、`effort`（常に null）、`reasons`、`rejected`、`quota`、`scope`、`hard`、`fallback`、`retryReason`（再試行のときだけ）。
- `event:"harness_launch"` … `attempt`、`shape`、`launchOk`（子を起動できたか）、`exitCode`、`failureKind`、`latencyMs`、`droppedArgs`。
- `event:"harness_handoff"` … 変更が残ったため再実行しなかったとき。`reason:"workspace_dirty"`、`handoff:"pi"`、`changedFiles`。

**選定値・起動成功・適用モデル・作業結果は別の欄です。** 計画したモデルは `plannedModel`、実際に適用されたモデルは観測できたときだけ `appliedModel`（この経路では常に null）、作業の成否は呼び出し側のテスト結果で判断します。`launchOk` は「子プロセスを起動できたか」で、作業の成功ではありません。

Pi/Claudeへ戻った場合は、そのあと既存の `event:"launch"` が続きます。起動後に最初の主リクエストが成功した時点の実モデルは、従来どおり `selections/<起動ID>.jsonl`（[LAUNCH_AUDIT](LAUNCH_AUDIT.md)）に出ます。

## 配置と有効化

```sh
bun run build
node scripts/enable-harness-selection.cjs        # ~/.jev-router/orca-launch/launch.cjs を追記/更新
```

- `JEV_ROUTER_HOME` を読むので、対象の機械でそのまま実行します。既存ファイルは `launch.cjs.bak-harness-<日時>` に控えます。二重実行すると「already up to date」で何もしません。
- `--modes build` を無条件に足している機械では、先に `node scripts/guard-pi-modes-flag.cjs` を実行します。PM受付のPi起動は `--no-extensions` を付けるため、そのままだと `Unknown option: --modes` で即終了します。
- runtimeの `dist` は**消さずに重ねて**配置します。稼働中のPi/Claude・relayを止めたり再起動したりしません。次の起動から有効です。
- 「機構が有効」と「OpenCodeが実際に選べる」は別です。`harness-status.json` に確認済みの記録が無い機械では、常に既存のPi/Claudeが選ばれます。

## 戻し方

1. `launch.cjs.bak-harness-<日時>` を `launch.cjs` に戻す（次の起動から従来どおり）。
2. 併せて `harness-status.json` を消すか、`ok:false` を書く。
3. runtimeは日時付きの控え（`runtime.bak-*`）を戻す。旧いchunkを消さないので、稼働中のプロセスは壊れません。

## 限界

- OpenCodeは本体CLI（`opencode`）をそのまま起動します。JevからモデルAPIへ直接はつなぎません。
- 起動後の推論量（thinking）は制御しません。記録も `null` です。
- 品質不足は自動判定しません。PM/確認者が `quality_insufficient` を記録したときだけGoが解禁されます。
- 対話（TUI）の形では標準エラーを奪わないため、失敗の分類ができません。分類できない失敗は再試行せず停止します。
- 対象環境（デスクトップ・deep-dev2・deep-dev）ごとに、認証とprovider設定はその機械のままです。
- **GLM Free（`opencode/glm-5.3-flash-free`）は実ID・無料経路・実動作が未確認のあいだ無効のままです。** 確認できた時点で `harness-status.json` の `opencode-free-glm` に `model` を書くと有効になります。推測のIDでは選びません。
- 無料枠の実切れとGo実実装成功は観測済みです。制限中に推論を繰り返さず、分類・各候補1回・Pi復帰は隔離回帰、配置後の3mode×3台×現行/fixture/hardは27境界probeで確認しました。候補集合だけのprobeを実モデルの新しい応答と混同しません。
- 非対話の子プロセスの標準入力は閉じます（`stdio:['ignore','pipe','pipe']`）。`opencode run` は標準入力のEOFを待つため、サーバーでstdinが開いたパイプのままだと無出力で止まります。
