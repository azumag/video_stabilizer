# Twitch Video Stabilizer

Twitchの視聴画面で、配信映像の揺れを視聴者側からリアルタイム補正するChrome拡張です。

現在は **Phase 0（成立性確認＋初期実装）** です。次の経路を実際に動かせるところまで実装しています。

```text
Twitch <video>
  └─ requestVideoFrameCallback
       └─ 低解像度Canvasへ描画
            └─ getImageData
                 └─ Module Workerへ転送
                      ├─ 同梱WASMをfetch・instantiate
                      ├─ グレースケール化
                      ├─ 特徴点検出
                      ├─ パッチ追跡
                      ├─ RANSAC Similarity Transform推定
                      └─ 軌跡平滑化・補正値計算
                           └─ 元の<video>へCSS transform（任意）
```

計画・詳細設計は [Issue #1](https://github.com/azumag/video_stabilizer/issues/1) を参照してください。

## 現在できること

- TwitchのSPA内から、画面上で最も大きい再生中の`video`要素を検出
- `requestVideoFrameCallback()`で映像フレームへ同期
- 最大240～640pxの解析Canvasへ縮小描画
- `getImageData()`の成功・`SecurityError`を明示
- Manifest V3のContent ScriptからModule Workerを起動
- 拡張へ同梱した実ファイル`probe.wasm`をWorker内で読み込み、`add(20, 22) === 42`を確認
- 依存ライブラリなしの簡易モーション推定
  - コーナー特徴点の抽出
  - 前後フレームのパッチ追跡
  - Forward-backward check
  - RANSACによる平行移動・回転・一様拡大の推定
  - 有界移動平均による軌跡平滑化
  - 追跡失敗時の補正減衰
- 元のTwitch映像へCSS補正を適用可能
- 通常は計測だけを行い、画面補正は既定でOFF
- Twitch画面右下の診断パネルと拡張ポップアップで状態確認
- 映像要素の差し替え、画質変更、タブ非表示、ページ遷移時のリセット
- すべての映像処理をブラウザ内で実行し、外部送信しない

## インストールと実機確認

### 1. ビルド

Node.js 20以降を使用します。外部npm依存はありません。

```bash
npm install
npm run check
```

`dist/video-stabilizer`に、Chromeへ読み込めるフォルダが作成されます。

### 2. Chromeへ読み込む

1. Chromeで`chrome://extensions`を開く
2. 「デベロッパーモード」を有効にする
3. 「パッケージ化されていない拡張機能を読み込む」を選択
4. `dist/video-stabilizer`を指定
5. Twitchのライブ配信またはVODページを開く
6. 必要ならTwitchページを一度再読み込みする

画面右下にPhase 0診断パネルが表示されます。

```text
映像     1920×1080 → 320×180
Canvas   OK
Worker   OK
WASM     OK（42）
解析     15 fps / xx.x ms
追跡     ok / xx点 / 信頼度xx%
補正     計測のみ（適用OFF）
```

### 3. 画面補正を試す

拡張アイコンを開き、「補正を画面へ適用」をONにします。

初期実装はOpenCV版より簡易な純JavaScript推定器です。映像内容によって誤推定する可能性があるため、既定ではOFFにしています。停止時、ページ離脱時、映像要素変更時には、拡張が変更したinline styleを復元します。

## Phase 0の判定

### 主方式を続行できる状態

- `Canvas: OK`
- `Worker: OK`
- `WASM: OK（42）`
- 解析フレーム数が増え続ける

この状態なら、OpenCV.js/WASMまたは専用WASMへの置き換えを進められます。

### Canvas取得が拒否された状態

```text
Canvas: 取得不可
Twitch映像のCanvas画素取得がSecurityErrorで拒否されました
```

ライブ、VOD、広告中、画質設定、ログイン状態などを記録してください。通常配信でも一貫して拒否される場合は、Issue #1の設計どおり`chrome.tabCapture`方式を検討します。

### WorkerまたはWASMが失敗した状態

診断パネルとポップアップに具体的な起動エラーを表示します。Chromeの拡張機能ページにある「エラー」と、TwitchタブのDevTools Consoleも確認してください。

詳しい確認項目は [`docs/PHASE0_TESTING.md`](docs/PHASE0_TESTING.md) にあります。

## 開発

```bash
npm run validate  # Manifest、参照ファイル、JS構文、WASMを検証
npm test          # モーション推定、RANSAC、Manifest、WASMの単体テスト
npm run build     # dist/video-stabilizerへコピー
npm run check     # 上記をすべて実行
```

## ディレクトリ構成

```text
extension/
  manifest.json
  background.js
  content.js
  worker.js
  popup.html
  popup.css
  popup.js
  lib/
    motion-estimator.js
  wasm/
    probe.wasm
scripts/
  validate.mjs
  build.mjs
tests/
docs/
```

アーキテクチャと責務は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。

## 既知の制約

- Twitch本番映像のCanvas取得可否は、実際のChromeで確認する必要があります
- 現在の推定器はOpenCVのLucas–Kanadeオプティカルフローではなく、純JavaScriptのパッチ追跡です
- ゲーム画面、字幕、画面全体のアニメーションなど、カメラ以外の動きが多数ある映像では誤推定し得ます
- CSS変換は元映像の画素を生成しないため、補正量がクロップ量を超えると端が見える可能性があります
- 広告、DRM、埋め込みプレイヤー、モバイルChromeは未対応です
- Chrome Web Store向けのパッケージング、アイコン、公開用説明文は未実装です

## プライバシー

- 映像フレームはTwitchタブ内のContent Scriptと拡張Workerの間だけで処理します
- 外部API、解析サーバー、CDNへフレームを送信しません
- 実行コードとWASMは拡張パッケージへ同梱します
- 保存するのは拡張の設定だけです

## ライセンス

GPL-2.0-only。参考実装の[`azumag/obs-stabilizer`](https://github.com/azumag/obs-stabilizer)と同じライセンス方針です。
