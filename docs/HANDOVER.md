# 開発引き継ぎ：Twitch Video Stabilizer

- 更新日: 2026-08-14
- リポジトリ: `azumag/video_stabilizer`
- 親Issue: [#1 計画・設計](https://github.com/azumag/video_stabilizer/issues/1)
- 基準コード: [`de7a5a7`](https://github.com/azumag/video_stabilizer/commit/de7a5a788b7751b052162695c85b862d61d22d86)
- 現在の段階: **Phase 0（成立性確認＋初期実装）**

## 1. 現在地

Phase 0のコード実装、自動テスト、GitHub Actionsでのビルドまでは完了している。未完了なのは、実際のChromeでTwitchのライブ配信・VODを再生して行う実機確認である。

現時点では、次の3点を最優先で判定する。

1. Twitchの`HTMLVideoElement`をCanvasへ描画し、`getImageData()`で画素を継続取得できるか
2. Twitchページ上のContent ScriptからDedicated Module Workerを起動できるか
3. Workerから拡張内のWASMを取得・インスタンス化できるか

この判定が終わるまでは、OpenCV.jsの導入、高度な補正アルゴリズム、Chrome Web Store向け作業を先行させない。

## 2. 採用している方式

OBS版のように完成フレームを毎回WASMで変形するのではなく、解析と表示を分離している。

```text
Twitchの元video要素
  ├─ 通常どおり映像・音声・プレイヤーUIを再生
  └─ 低解像度Canvasへフレームをコピー
       └─ Workerでカメラ移動を推定
            └─ 補正値だけContent Scriptへ返す
                 └─ 元video要素へCSS transformを適用
```

重要な前提は次のとおり。

- 解析画像は最大辺320pxが既定値で、設定上は160〜640px
- 解析頻度は15fpsが既定値で、設定上は5〜30fps
- Worker処理中は次の解析フレームを捨て、キューを積まない
- 映像フレームは外部送信せず、ブラウザ内だけで処理する
- 補正の画面適用は安全のため既定でOFF
- 失敗時は元のTwitch再生を維持する

## 3. 実装済みの経路

```text
requestVideoFrameCallback()
  -> Canvas.drawImage(video)
  -> Canvas.getImageData()
  -> RGBA ArrayBufferをTransferableとしてWorkerへ送信
  -> グレースケール化
  -> 特徴点検出
  -> パッチ追跡
  -> forward-backward check
  -> RANSAC Similarity Transform
  -> 累積軌跡の移動平均
  -> 補正値を返却
  -> 任意でCSS translate/rotate/scaleを適用
```

WASMについては、現時点で映像処理には使っていない。`extension/wasm/probe.wasm`が公開する`add(i32, i32)`をWorkerから呼び、`add(20, 22) === 42`となることで、WASMファイルの取得と実行経路だけを検証している。

現在の映像解析エンジンは、`extension/lib/motion-estimator.js`にある依存なしの純JavaScript実装である。これは最終品質を目指したものではなく、Worker負荷、フレーム転送、補正座標、状態遷移を試すためのブートストラップである。

## 4. 主要ファイル

| パス | 役割 |
|---|---|
| `extension/manifest.json` | Manifest V3、権限、Content Script、Worker/WASM公開、CSP |
| `extension/content.js` | Twitchのvideo検出、フレーム取得、Worker管理、診断表示、CSS補正 |
| `extension/worker.js` | WASMプローブ、モーション推定器の保持、フレーム処理 |
| `extension/lib/motion-estimator.js` | 純JSの特徴点検出・追跡・RANSAC・軌跡平滑化 |
| `extension/background.js` | 初期設定と拡張バッジ管理 |
| `extension/popup.*` | ON/OFF、各種設定、診断状態の表示 |
| `extension/wasm/probe.wasm` | WorkerからのWASM取得・実行確認 |
| `scripts/validate.mjs` | Manifest、参照ファイル、JS構文、WASM検証 |
| `scripts/build.mjs` | `dist/video-stabilizer`の生成 |
| `tests/manifest.test.mjs` | ManifestとWASM経路のテスト |
| `tests/motion-estimator.test.mjs` | グレースケール、追跡、RANSAC、補正方向のテスト |
| `docs/ARCHITECTURE.md` | Phase 0の構成と設計意図 |
| `docs/PHASE0_TESTING.md` | Twitch実機確認の手順と記録形式 |

## 5. 現在の既定設定

| 設定 | 既定値 | 備考 |
|---|---:|---|
| `enabled` | `true` | 拡張と解析を有効化 |
| `applyStabilization` | `false` | CSS補正は既定OFF |
| `showDiagnostics` | `true` | Twitch画面右下に診断表示 |
| `analysisMaxDimension` | `320` | 設定範囲160〜640px |
| `analysisFps` | `15` | 設定範囲5〜30fps |
| `smoothingRadius` | `12` | 設定範囲2〜60フレーム |
| `cropZoom` | `1.03` | 設定範囲1.00〜1.15 |
| `minConfidence` | `0.3` | 設定範囲0〜1 |

Worker内部の追跡画像は、`Math.min(240, analysisMaxDimension)`までさらに縮小される。

設定は`chrome.storage.sync`の`videoStabilizerSettings`へ保存する。映像フレーム、特徴点、軌跡は保存しない。

## 6. 開発環境の再現

Node.js 20以上を使用する。CIはNode.js 22で動作している。外部npm依存はない。

```bash
git clone https://github.com/azumag/video_stabilizer.git
cd video_stabilizer
npm ci
npm run check
```

個別コマンドは次のとおり。

```bash
npm run validate  # Manifest、参照ファイル、JS構文、WASM
npm test          # Node組み込みテストランナー
npm run build     # dist/video-stabilizerを生成
npm run check     # validate -> test -> build
```

`dist/`は生成物であり、リポジトリへコミットしない。

GitHub Actionsはpushとpull requestで`npm run check`を実行し、未パック拡張のZIPを`video-stabilizer-phase0`というArtifactとして14日間保存する。古いArtifactへ依存せず、必要な場合は最新のCIから取得する。

## 7. 最初に行う実機確認

詳しい手順は[`PHASE0_TESTING.md`](PHASE0_TESTING.md)を参照する。最低限、次の順で確認する。

1. `npm run check`を成功させる
2. `dist/video-stabilizer`を`chrome://extensions`から「パッケージ化されていない拡張機能」として読み込む
3. Twitchのライブ配信を開き、10秒以上再生する
4. VODを開き、再生、一時停止、シークを試す
5. 通常表示、シアターモード、フルスクリーンを切り替える
6. 画質を変更する
7. まず補正OFFのまま、Canvas・Worker・WASM・解析フレーム数を確認する
8. すべて成功した後だけ、補正をONにして見た目と負荷を確認する

期待する診断表示は次のような状態である。

```text
映像     1920×1080 → 320×180
Canvas   OK
Worker   OK
WASM     OK（42）
解析     15 fps / xx.x ms / フレーム数
追跡     ok / xx点 / 信頼度xx%
補正     計測のみ（適用OFF）
```

結果はIssue #1へ、少なくとも以下を記録する。

```markdown
### Phase 0 実機結果

- 日時:
- OS / Chrome:
- Twitch URLまたは種別: ライブ / VOD / 広告
- ログイン: 有 / 無
- 画質:
- 表示モード: 通常 / シアター / フルスクリーン
- Canvas: OK / SecurityError / その他
- Worker: OK / NG
- WASM: OK(42) / NG
- 平均処理時間:
- 補正ON時の見た目:
- Consoleエラー:
- 補足:
```

## 8. Phase 0の分岐

### A: 主方式を継続

ライブまたはVODでCanvas画素取得が継続成功し、WorkerとWASMも成功する。

次に行うことは、実機結果の固定、自動ブラウザテストの追加、解析エンジン候補の比較、補正品質の評価である。

### B: 条件付き継続

ライブとVOD、ログイン有無、広告中などで結果が分かれる。

成功条件と失敗条件をIssueへ明記し、対応範囲を限定してPhase 1へ進む。失敗ケースを無理に隠さず、UI上でも非対応理由を表示する。

### C: 方式変更

通常のライブとVODの双方でCanvas画素を取得できない。

`chrome.tabCapture`を使う別表示方式へ切り替える。同じタブへ補正映像を重ねると再帰キャプチャが起こり得るため、拡張ページまたは別ウィンドウへの出力を前提に再設計する。Cの判定前に`tabCapture`実装を並行して増やさない。

## 9. 実装上の注意点と既知のリスク

### Twitch DOMとvideo選択

`content.js`は、表示中の`video`要素のうち面積が最大のものを対象にする。広告、プレビュー、Twitch側のDOM変更などで意図しない要素を選ぶ可能性がある。実機確認時は、対象`currentSrc`と表示サイズも確認する。

### Canvas制約

`drawImage()`が成功しても、`getImageData()`で`SecurityError`になる場合がある。ライブ、VOD、広告、画質、ログイン状態を分けて記録する。エラー時に同じ診断通知が高頻度で繰り返される可能性があるため、本実装化時には再試行間隔やログのレート制限を検討する。

### Worker停止

Worker処理中は`busy=true`となり、次のフレームを捨てる。Workerが応答せずエラーイベントも発生しない場合、解析が停止したままになる可能性がある。Phase 1ではフレーム単位のタイムアウトまたはheartbeatを追加候補とする。

### CSS transform

現在はvideo要素自体へ`translate3d`、`rotate`、`scale`を`!important`で設定する。Twitch側のtransform、`object-fit`、プレイヤーのクリッピングとの競合は実機未確認である。

停止時には元のinline style値を戻すが、現在の実装は元のCSS priority（`!important`）を保存していない。Twitch側のinline styleと競合する場合は、値とpriorityの両方を保存・復元する。

信頼度が閾値未満の`ok`結果では新しい変換を適用せず、直前の変換が残る。実機で静止や引っ掛かりが見える場合は、直前補正を減衰させるか、一定時間後にidentityへ戻す。

### 現在の解析エンジン

純JavaScriptのパッチ探索は、ゲーム画面、字幕、UIアニメーション、独立して動く被写体が多い映像でカメラ移動を誤推定し得る。現在の数値を最終品質の基準にしない。

`probe.wasm`は能力確認用であり、OpenCVや安定化処理本体ではない。「WASM OK」は、最終エンジンが動作したという意味ではない。

### 対応URL

Manifestは現在`https://www.twitch.tv/*`だけを対象にしている。`player.twitch.tv`、クリップ専用ページ、埋め込みプレイヤー、モバイル版はPhase 0の対象外である。

## 10. Phase 1へ進む場合の優先順位

AまたはBと判定できた場合は、次の順序を推奨する。

1. 実機結果をIssue #1へ記録し、Phase 0の結論をA/B/Cで明示する
2. 実機で発見したクラッシュ、DOM追従、style復元の不具合を先に直す
3. 合成動画またはローカルテストページを使うブラウザE2Eを追加する
4. OBS版と同じ評価用揺れ動画・測定指標を用意する
5. 純JS、OpenCV.js最小ビルド、専用C++/Rust WASMを同じ入力で比較する
6. 選定したエンジンをWorker境界の内側だけで置き換える
7. 移動平均とカルマンフィルター、プリセット、シーンチェンジを評価する
8. UI、アイコン、配布、Chrome Web Store対応は品質が固まった後に行う

エンジン選定では、少なくとも以下を比較する。

- 320px・15fpsおよび640px・30fpsの処理時間
- 特徴点不足率とRANSACインライア率
- 意図的なパンへの追従
- 高周波の微振動低減率
- シーンチェンジ後の復帰時間
- WASMサイズと初期化時間
- メモリ解放と長時間安定性

## 11. 変更時に守ること

- 実行コードとWASMを拡張パッケージへ同梱し、CDNから読み込まない
- 映像フレームを外部API、解析サーバー、ログへ送信しない
- 例外時にも元のTwitch再生を停止しない
- 補正の既定値をOFFのまま維持する
- Workerが処理中のときにフレームキューを積まない
- アルゴリズム変更には合成データの単体テストを追加する
- Twitch DOM依存を追加する場合、通常・シアター・フルスクリーンを確認する
- `npm run check`を通してからコミットする
- `dist/`、CI Artifact、取得した映像をコミットしない
- GPL-2.0-onlyと参考元`azumag/obs-stabilizer`のライセンス方針を維持する

## 12. Phase 0完了条件

次をすべて満たし、Issue #1へ結果を記録した時点でPhase 0完了とする。

- 通常のライブまたはVODの少なくとも一方でCanvas画素取得が継続成功する、または双方で失敗してCと判断できる
- Workerが3秒以内にreadyを返す
- WASMプローブが42を返す
- 30秒以上解析してWorkerが停止しない
- 320px・15fpsで平均処理時間が66ms未満を目安に動く
- Twitchの映像、音声、操作UIを壊さない
- OFF、ページ遷移、video差し替え後に補正styleが残らない
- A/B/Cのどれで進むかが決まっている

## 13. 関連資料

- [Issue #1：計画・設計](https://github.com/azumag/video_stabilizer/issues/1)
- [Phase 0初期実装コミット](https://github.com/azumag/video_stabilizer/commit/de7a5a788b7751b052162695c85b862d61d22d86)
- [Phase 0アーキテクチャ](ARCHITECTURE.md)
- [Phase 0実機確認手順](PHASE0_TESTING.md)
- [参考実装：azumag/obs-stabilizer](https://github.com/azumag/obs-stabilizer)
