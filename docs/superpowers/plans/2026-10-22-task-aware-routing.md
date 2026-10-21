# Task別モデル選択の見直し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 必要な品質を保ち、手戻り込みの完了時間と契約枠の消費を減らす。安いモデルの比率は目標にしない。
**Architecture:** 既存の採点・policy・SessionState・判定ログだけを拡張する。Taskの短い情報は既存メッセージ/実行状態から決定的に抽出して保持し、別AIやPM全体の要約は作らない。
**Tech Stack:** TypeScript、既存Bunテスト、Nodeランチャー、既存JSON policy。
**Spec:** 長倉さんの2026-10-22の依頼（難度/影響の再定義、能力と推論量の分離、戻す条件、短いTask情報、実読込・実Taskの検証、最小変更）。

## Global Constraints
- ファイル数、通常のローカル実装、PMの役職だけで昇格しない。認証/権限/決済/移行の重要な設計・レビューは能力を落とさない。
- 通常実装はSonnet/medium・Sol/medium、明確な限定処理はHaiku/low・Luna/mediumを候補とする。上位でも推論量は別判定。
- 同じツール処理の途中では選択を保つ。Task変更、解決、工程移行で再判定し、低確信度や通信不良の持越しをTask越しに無期限延長しない。
- 429・通信・認証切れ・依存サービス停止と、コード/推論上の失敗を区別。Astra/Fableは除外のまま。起動指示にモデル指定を足さない。
- 秘密は表示/保存しない。配布前に控え、作業中の端末・共有中継は止めない。GitHub Actionsは使わない。

## Review Focus
- 「続けて」や再開後でも既存Taskの目的を失わない。長い前置きで最新の要求を切らない。
- 新Task/確定済み実装では旧hold・失敗回数をリセット。同じTaskのJev障害では現選択を維持。
- 本番の不可逆変更の設計レビューと、手順確定済みのローカル変更を混同しない。
- キャッシュ維持の判断は実usageで確認し、API換算額を契約枠の実測と称さない。
- 配布ファイルの一致だけで、動いているプロセスも新版を読んだと判断しない。

### Task 1: 基準と再現例
**Files:** `src/core/questions.ts`、`examples/task-aware-policy-patch.json`、`test/core/task-aware.test.ts`。
- [ ] 既存ログから採点・選択理由・モデル/推論量・usageだけを抽出し、変更前の例を保存。元文がないログでは作業内容を推測しない。
- [ ] 小修正の影響2だけでは最上位にしない、難しい設計は上位、上位/mediumも可能、のREDテストを書く。
- [ ] 採点文と既存policyルールで基準を実装し、対象テストをGREENにする。

### Task 2: 短いTask状態と戻す条件
**Files:** `src/core/work.ts`、`types.ts`、`dossier.ts`、`session.ts`、`decide.ts`、`src/adapters/pi/{index,router}.ts`、`src/daemon/{service,dialects/anthropic,dialects/types}.ts`。
**Interfaces:** `WorkContext` と `updateWorkContext(previous, request)`。目的/工程/次の操作/完了条件/対象/直近失敗を上限付きで保持。入力にない値は不明のまま。
- [ ] 続行時の目的保持、最新要求の保持、工程/Task変更での据え置き解除、同じツールチェーンの安定をREDで確認。
- [ ] メッセージの既存見出し・Task ID・直近状態を抽出してSessionStateへ保持。Pi再開/Claude履歴から直近の実Taskを復元する。
- [ ] 新Task/工程境界でholdと失敗回数を解除して再判定。通常の不確実時は中位/mediumへ戻し、重要設計の能力は保護。同Taskの失敗時は現選択を保つ。
- [ ] キャッシュ判断と能力フィルターを維持し、関連テストをGREENにする。

### Task 3: 障害分類と読込の識別
**Files:** `src/core/signals/{failure,stage}.ts`、`src/runtime/policy-identity.ts`、`src/daemon/server.ts`、`src/core/record.ts`。
- [ ] インフラ障害を繰り返しても昇格しない、実装上の行き詰まりは昇格する、圧縮だけでは昇格しない、をREDで確認。
- [ ] 同じ分類をスコアと連続失敗に使い、ログに内容を残さず分類/境界だけを残す。
- [ ] 既存health/status/判定ログへ読み込んだpolicyの指紋と選択ロジック版を加える。共有中継は処理中リクエスト数も確認できるようにする。
- [ ] 型・lint・全件テスト・build・Node切断試験をサーバーで実行し、差分を確認する。

### Task 4: 適用と少数実作業
**Files:** `scripts/apply-task-aware-policy.cjs`、実施報告 `~/.deep-os-briefs/2026-10-22/`。
- [ ] 日時付き控えを作り、3台のpolicy/runtimeへ同じ修正を配置。稼働プロセスの指紋と旧版を列挙する。
- [ ] 入力待ちの区切りでだけ更新。共有中継は関連Claudeの状態と処理中0を確かめ、順に更新する。保留は未適用として残す。
- [ ] 少数の実作業で選択・推論量・理由・修正往復・完了時間・usageを測る。採点再生は実作業の成功と分ける。
- [ ] 観測できた契約枠と照合。観測できなければ不明と記録し、節約成功とは断定しない。
- [ ] PRを統合し、前後ルール・代表結果・適用済み/未適用と検証ログを報告する。
