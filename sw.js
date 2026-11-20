// オフライン対応のサービスワーカー
// - 自分のファイル：まずネットから最新を取り、ダメならキャッシュ（電波がなくても開ける）
// - フォント・Firebase SDK：キャッシュ優先（バージョン固定なので変わらない）
// ファイルを更新したら VERSION を上げると、古いキャッシュが消えます。
const VERSION = "ajc-v19";
const PRECACHE = [
  "./",
  "./index.html",
  "./host.html",
  "./config.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./manifest-host.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
];
const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const RUNTIME_CACHE_FIRST = [SDK, "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) =>
        Promise.all([
          c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))),
          // Firebase SDK も先に入れておく（初回からオフラインでも送信待ちに入れられるように）
          ...["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) =>
            c.add(new Request(SDK + f, { mode: "cors" })).catch(() => {})
          ),
        ])
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = req.url;

  // Firestore / Auth の通信には触らない
  if (/googleapis\.com\/(google\.firestore|identitytoolkit)|securetoken\.googleapis/.test(url)) return;
  if (url.includes("firestore.googleapis.com") || url.includes("identitytoolkit") || url.includes("securetoken")) return;

  if (RUNTIME_CACHE_FIRST.some((p) => url.startsWith(p))) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok || res.type === "opaque") {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    e.respondWith(
      // ブラウザのキャッシュ（GitHub Pages は10分）を使わず、毎回最新か確認する
      // （古いファイルと新しいファイルが混ざって動かなくなるのを防ぐ）
      fetch(url, { cache: "no-cache", credentials: "same-origin" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
    );
  }
});
