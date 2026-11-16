// =====================================================================
//  設定ファイル（ここだけ書き換えればOK）
//  セットアップ手順は README.md を見てください。
// =====================================================================

// Firebase コンソール →「プロジェクトの設定」→「マイアプリ」→ ウェブアプリの
// firebaseConfig をそのまま貼り付けます。
// apiKey が "YOUR_..." のままだと「デモモード」（この端末の中だけで動く）になります。
export const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000",
};

// 回答をまとめる箱の名前。テストと本番で分けたいときに変えます。
// （例：テスト中は "journey-test"、彼女に渡す前に "journey-2026" に戻す）
export const TRIP_ID = "journey-2026";

// Step 1 の答えのあとに行き先を見せる日時。それまでは「CLASSIFIED」表示。
export const DESTINATION_REVEAL_AT = "2026-11-21T00:00:00+09:00";

// 各Stepが開く日時（日本時間）。この時刻までは、質問の中身も見えない「封印」状態になります。
// Step 1 はいつでも回答できます。前のStepに答えていて、かつこの時刻を過ぎたら開きます。
// テストしたいときは URL の末尾に ?now=2026-11-21T09:00 のように付けると、その時刻として動きます。
export const STEP_OPEN_AT = {
  2: "2026-11-21T00:00:00+09:00", // 1日目：移動
  3: "2026-11-21T00:00:00+09:00", // 1日目：到着
  4: "2026-11-22T05:00:00+09:00", // 2日目の朝
};
