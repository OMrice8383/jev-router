# 実装担当のハーネス選択

Jevはモデルと推論量だけでなく、**明示された実装担当の起動境界**で実行ハーネスも選びます。新しい管理システムや別の判断エンジンは作りません。既存の起動ラッパー（`orca-launch/launch.cjs`）、既存の難度・実影響の判断（`src/core/work.ts`）、既存のログを使い、選べる状態が確認できない候補は無効のまま既存のPi/Claude経路へ戻ります。

- 対象: 実装・テスト修正の作業者起動だけ。
- 対象外: PM、最終設計判断、重要な独立レビュー、作業途中の既存Pi/Claudeセッション、GLM・別モデル・有料Zen・従量課金API。役割名やプロンプトから推測しません。

## 優先順位（2026-10-22 長倉さん指示）

1. `opencode/deepseek-v4.1-flash-free`（OpenCode無料枠）
2. `opencode-go/deepseek-v4.1-flash`（OpenCode Go契約枠。**実ID・認証・残枠が確認できたときだけ**）
3. Pi（既存経路。`JEV_HARNESS_FALLBACK=pi|claude` でClaudeも選べる）

- Freeが使える間はFree。
- Freeの**枠切れ・429・混雑**、またはその作業について記録された品質不足のときだけGoへ。
- Goが未確認・残枠不明/古い/不足ならPi。**古いGLMの記録をGoの許可として読まない。**
- **難しい実装はFreeもGoも使わずPiへ直行。** 既存の作業文脈（`updateWorkContext`）の工程がdesign/review、認証・決済・移行を伴う設計、または既存policyの難度しきい値（`>= 2.6`）以上を「難しい」とします。健全という理由だけで難しい作業を安いモデルへ渡しません。
- 認証エラー・通信障害はFreeの容量問題ではないのでGoを解禁しません（`go_withheld_operational`）。

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
   - Pi専用のフラグ（`--no-session` `--no-extensions` `--no-mcp` `--no-skills` など）は落とし、**落とした名前を `droppedArgs` としてログに残します**。無言で消しません。

### 出力と終了コード

- 非対話の stdout は最終応答テキストだけ。進捗・警告は stderr。
- 終了コードはOpenCodeの値（0=正常、非0=失敗）。Jevはタイムアウトを足しません（呼び出し側の責任）。
- 起動確認だけなら `JEV_ORCA_PROBE=1`。選択結果と `args` / `droppedArgs` のJSONを出し、推論を始めません。

## 実行後の扱い

- Freeが429・混雑で落ちた場合、**worktreeに変更が無く、非対話の形のときだけ**、同じプロセス内で1回だけ次候補（Go → Pi）へ切り替えます（`retryReason` を記録）。
- **変更が残っているときは再実行しません。** 変更とログをそのまま残し、`event:"harness_handoff"`（`handoff:"pi"`）を記録して非0で終わります。同じworktreeを2つのハーネスが並行編集しないためです。
- 認証・通信の失敗では切り替えません（`stop`）。人が中身を見て判断します。
- 起動直後の失敗を状態ファイルへ書き戻すのは、分類できた容量失敗（`quota` / `congestion`）だけです。新しい観測が既にあれば上書きしません。

## 判定（`src/runtime/harness.ts`）

| 状態 | 選ぶもの | 理由の語 |
|---|---|---|
| Free が24時間以内に `ok` | `opencode/deepseek-v4.1-flash-free` | `free_verified` |
| Free の枠切れ/混雑、または同じ作業の品質不足。かつGoの実ID・残枠が確認済み | `opencode-go/deepseek-v4.1-flash` | `free_quota_failure` / `free_congestion_failure` / `free_quality_insufficient`, `go_model_verified`, `go_quota_verified` |
| 難しい作業（工程 design/review・重大設計・難度しきい値以上） | 既存の Pi / Claude | `hard_work_pi` |
| Free の認証/通信の失敗、未確認、古い、未来日時 | 既存の Pi / Claude | `free_auth_failure` など + `go_withheld_operational` |
| Go の実IDが未確認・許可外、残枠が unknown・期限切れ・未来・0 | Goを選ばない | `go_model_unverified` / `go_model_not_allowed` / `go_quota_unknown` / `go_quota_stale` / `go_quota_future` / `go_quota_exhausted` |

- 失敗の種類は `auth`（401/403・provider.auth）、`quota`（429・残量不足）、`congestion`（503/529・混雑）、`network`（接続不能）、`quality_insufficient`（成果物の品質・速度不足）に分けます。
- **未来の時刻は有効として扱いません。** 観測時刻・残枠の観測時刻とも、現在より5分（`CLOCK_SKEW_MS`）を超えて先なら「未確認」に倒れます。
- **品質不足は作業ごと・期限付きです。** `scope`（Task ID）が付いた記録は、同じ `scope` の起動にだけ効きます。無関係なTaskへ永久に効かせません。12時間（`QUALITY_MAX_AGE_MS`）で失効します。

## 担当②が置く情報

`~/.jev-router/orca-launch/harness-status.json`（`JEV_ROUTER_HARNESS_STATUS` で変更可、権限600）。候補ごとに**最後の観測1件**だけを持ちます。書式が壊れている・候補名が違う・時刻が読めない場合は「未確認」として無効側に倒れます。

```json
{
  "version": 2,
  "candidates": {
    "opencode-free": { "at": "2026-10-22T05:10:00.000Z", "ok": true, "latencyMs": 3632 },
    "opencode-go": {
      "at": "2026-10-22T05:10:00.000Z",
      "ok": true,
      "model": "opencode-go/deepseek-v4.1-flash",
      "latencyMs": 4946,
      "quota": { "remaining": 40, "checkedAt": "2026-10-22T05:09:00.000Z", "source": "取得元の短い名前", "limit": 100 }
    }
  }
}
```

- `at` … 観測時刻（ISO）。24時間を超えると未確認へ戻ります。未来は無効。
- `ok:false` のときは `failure` を付けます。
- **`model` … Goで実際に確認した `provider/model`。これが無い、または `GO_MODEL_ALLOWLIST` に無い記録はGoの許可になりません**（旧GLM時代の記録を流用しないため）。
- `quota.remaining` … 取得元が返した残量（数値）。`checkedAt` が1時間を超えると未確認へ戻ります。`source` は秘密を含まない短い名前。`limit` は任意。
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
- 非対話の子プロセスの標準入力は閉じます（`stdio:['ignore','pipe','pipe']`）。`opencode run` は標準入力のEOFを待つため、サーバーでstdinが開いたパイプのままだと無出力で止まります。
