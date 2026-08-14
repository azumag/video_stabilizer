# Phase 0 アーキテクチャ

## 目的

Phase 0では、最終的な安定化品質を作り込む前に、Chrome拡張上で次の境界が成立することを確認する。

1. Twitchの`HTMLVideoElement`を検出できる
2. 動画をCanvasへ描画し、画素を読み取れる
3. Content Scriptから拡張内Module Workerを起動できる
4. Workerから拡張内WASMを読み込める
5. フレームをWorkerへ転送し、リアルタイム処理できる
6. 計算した補正値を元の映像表示へ反映できる

## ランタイム構成

```text
Twitch page
  │
  ├─ content.js
  │   ├─ PlayerLocator
  │   ├─ FrameScheduler
  │   ├─ CanvasSampler
  │   ├─ DiagnosticOverlay
  │   └─ CssTransformRenderer
  │
  ├─ worker.js (module worker)
  │   ├─ WASM capability probe
  │   └─ MotionStabilizer
  │       ├─ grayscale conversion
  │       ├─ bounded tracking resolution
  │       ├─ corner detection
  │       ├─ patch tracking
  │       ├─ forward-backward validation
  │       ├─ similarity RANSAC
  │       └─ trajectory smoothing
  │
  └─ original Twitch video/audio/player UI

Extension service worker
  └─ 初期設定とバッジ状態のみ管理

Popup
  ├─ 設定保存
  ├─ Content Scriptへの設定通知
  └─ 診断状態の表示
```

## Content Script

`content.js`はページ側コードとデータを共有せず、DOMだけを操作する。

主な責務は次のとおり。

- 画面上で最大の可視`video`要素を選ぶ
- TwitchのSPA更新と映像要素差し替えを監視する
- `requestVideoFrameCallback()`を優先し、未対応時だけ`requestAnimationFrame()`へフォールバックする
- 指定FPSへ間引き、Worker処理中は次の解析要求を捨てる
- Canvasがtaintedになった場合、変換を適用せず、後続フレームでも再試行しながら明示的なエラーを表示する
- `ImageData.data.buffer`をTransferableとしてWorkerへ渡す
- 補正値を解析Canvas座標からCSSピクセルへ換算する
- 元のinline styleとpriorityを保存し、停止時に復元する

## Worker

Service WorkerではなくDedicated Module Workerを使用する。映像処理は連続状態を持つため、ライフサイクルが停止し得るManifest V3 Service Workerには置かない。

Worker起動時に`wasm/probe.wasm`を`fetch()`し、`WebAssembly.instantiateStreaming()`を試す。MIME等で失敗した場合は`arrayBuffer()`＋`WebAssembly.instantiate()`へフォールバックする。

WASMプローブは次の関数だけを公開する41バイトの実ファイルである。

```text
add(i32, i32) -> i32
```

`add(20, 22) === 42`を確認することで、単に`WebAssembly`グローバルが存在するだけでなく、拡張パッケージからの取得とインスタンス化まで検証する。

## 初期モーション推定器

OpenCV.jsの導入前でもフレーム経路と補正適用を試せるよう、依存なしの推定器を実装している。

### 処理

1. RGBAを8bitグレースケールへ変換
2. 追跡画像の最大辺を192～240pxへ制限
3. 構造テンソル由来のコーナースコアで特徴点を選択
4. 小領域の平均絶対誤差を用いて探索
5. Forward-backward checkで不安定な対応を除外
6. 2点からSimilarity Transform候補を作る
7. RANSACで外れ値を除外
8. 全インライアで最小二乗再推定
9. 平行移動・回転・対数スケールを累積
10. 有界履歴の算術平均を平滑軌跡とする
11. 平滑軌跡と現在軌跡の差を補正値として返す

### 意図

この推定器は最終版ではなく、以下を確認するためのブートストラップである。

- Worker処理時間
- フレーム転送量
- CSS補正座標の符号とスケール
- Twitch映像内容に対する大まかな追跡可否
- シーンチェンジ、画質切替、追跡失敗時の状態遷移

Phase 1以降で、OpenCV.jsのカスタムビルドまたはC++/Rust製の専用WASMへ差し替えられるよう、Content Scriptとはメッセージ境界で分離している。

## 設定と状態

設定は`chrome.storage.sync`の`videoStabilizerSettings`へ保存する。

映像フレーム、特徴点、軌跡、Canvas画素は永続化しない。映像要素・映像ソース・追跡設定の変更時にWorker状態をリセットし、タブ非表示中は解析を停止する。

## 失敗時の動作

- Canvasの`SecurityError`: 画素取得不可と表示し、変換を適用しない
- Worker起動失敗: 診断へ理由を出し、元映像を維持する
- WASM初期化失敗: JS推定器は起動可能だがPhase 0を失敗として表示する
- 特徴点不足・低インライア率: 新しい補正を採用せず、直前補正を減衰する
- 特徴点不足・低インライア率: 新しい補正を採用せず、直前補正をフレームごとに減衰する
- シーンチェンジ: 現フレームを新しい基準として初期化する

すべての失敗で元のTwitch再生を止めないことを優先する。
