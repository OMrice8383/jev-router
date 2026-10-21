# 実装担当のハーネス選択

Jevはモデルと推論量だけでなく、**明示された実装担当の起動境界**で実行ハーネスも選びます。新しい管理システムや別の判断エンジンは作りません。既存の起動ラッパー（`orca-launch/launch.cjs`）、既存のpolicy、既存のログを使い、選べる状態が確認できない候補は無効のまま既存のPi/Claude経路へ戻ります。

- 対象: 実装・テスト修正の作業者起動だけ。
- 対象外: PM、最終設計判断、重要な独立レビュー、作業途中の既存Pi/Claudeセッション。役割名やプロンプトから推測しません。

## 呼び方（担当③＝PM側）

```sh
node <home>/.jev-router/orca-launch/launch.cjs implementation [-- CLIの引数]
```

- `implementation` という**明示的な第1引数**が唯一の境界です。`pi` / `claude` の既存の呼び方は今までどおりで、ハーネス選択は働きません。
- 既存経路へ戻すときの行き先は環境変数 `JEV_HARNESS_FALLBACK=pi|claude`（既定 `pi`）。
- 呼び出し側は `--model` / `-m` / `--thinking` を付けません。付いていても子プロセスへは渡しません（モデルは選択結果だけが決めます）。
- OpenCodeへは `--agent build --auto` を付けて起動します（担当②の実測どおり）。作業者が権限確認で止まらないためで、呼び出し側が `--agent` / `--auto` を指定していればそれを尊重します。`permission:` は書かず、既存の `permissions` 設定をそのまま使います。
- 起動確認だけなら `JEV_ORCA_PROBE=1` を付けると、選択結果のJSONを出して推論を始めません。

## 判定（`src/runtime/harness.ts`）

| 状態 | 選ぶもの | 理由の語 |
|---|---|---|
| Free が24時間以内に `ok` | `opencode/deepseek-v4.1-flash-free` | `free_verified` |
| Free が明示的に品質不足、かつGoの残枠が1時間以内に数値で確認でき余りあり | `opencode-go/glm-5.3-flash` | `free_quality_insufficient`, `go_quota_verified` |
| Free の認証/枠/通信の失敗、または未確認・古い | 既存の Pi / Claude | `free_auth_failure` など + `go_withheld_operational` |
| Go の残枠が unknown・期限切れ・0 | Goを選ばない | `go_quota_unknown` / `go_quota_stale` / `go_quota_exhausted` |

- 失敗の種類は `auth`（401/403・provider.auth）、`quota`（429・残量不足）、`network`（接続不能）、`quality_insufficient`（成果物の品質・速度不足）に分けます。運用障害を「推論能力が足りない」と読み替えません。
- **Goは品質・速度不足の記録があるときだけ**解禁します。Freeの認証切れや障害では既存経路へ戻り、追加の消費をしません。
- 残枠は1回の成功やローカルtoken統計から推定しません。通常Zen・有料API・別モデルへの無断フォールバックはしません。

## 担当②が置く情報

`~/.jev-router/orca-launch/harness-status.json`（`JEV_ROUTER_HARNESS_STATUS` で変更可、権限600）。候補ごとに**最後の観測1件**だけを持ちます。書式が壊れている・候補名が違う・時刻が読めない場合は「未確認」として無効側に倒れます。

```json
{
  "candidates": {
    "opencode-free": { "at": "2026-10-22T05:10:00.000Z", "ok": true, "latencyMs": 3632 },
    "opencode-go": {
      "at": "2026-10-22T05:10:00.000Z",
      "ok": true,
      "latencyMs": 4946,
      "quota": { "remaining": 40, "checkedAt": "2026-10-22T05:09:00.000Z", "source": "取得元の短い名前", "limit": 100 }
    }
  }
}
```

- `at` … 観測時刻（ISO）。24時間を超えると未確認へ戻ります。
- `ok:false` のときは `failure` を付けます。
- `quota.remaining` … 取得元が返した残量（数値）。`checkedAt` が1時間を超えると未確認へ戻ります。`source` は秘密を含まない短い名前。`limit` は任意。
- 書き込みは同梱の `writeHarnessStatus`（配置済みruntime）を使うと原子的に1候補だけ更新できます。資格情報・URL・環境変数はこのファイルへ入れません。

## 記録（既存ログ）

`~/.jev-router/orca-launch/launches.jsonl` に、起動ごとに次の2行が増えます。

- `event:"harness"` … `selected`（`opencode` / `pi` / `claude`）、`candidate`、`requestedModel`、`appliedModel`、`effort`、`reasons`、`rejected`、`quota`、`fallback`。
- `event:"harness_outcome"` … OpenCodeの終了コードだけ。0以外は起動側の失敗で、内容（プロンプト・出力）は記録しません。

Pi/Claudeへ戻った場合は、そのあと既存の `event:"launch"` が続きます。起動後に最初の主リクエストが成功した時点の実モデルは、従来どおり `selections/<起動ID>.jsonl`（[LAUNCH_AUDIT](LAUNCH_AUDIT.md)）に出ます。

`effort` はこの経路では設定しないため常に `null` です（当てた値と要求値を混同しないため）。

## 配置と有効化

```sh
bun run build
node scripts/enable-harness-selection.cjs        # ~/.jev-router/orca-launch/launch.cjs を追記（二重実行しない）
```

- `JEV_ROUTER_HOME` を読むので、対象の機械でそのまま実行します。既存ファイルは `launch.cjs.bak-harness-<日時>` に控えます。
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
- 起動直後の失敗を自動で状態ファイルへ書き戻しはしません（対話TUIの標準エラーを奪わないため）。`harness_outcome` の終了コードと、担当②の再確認で更新します。
- 対象環境（デスクトップ・deep-dev2・deep-dev）ごとに、認証とprovider設定はその機械のままです。
