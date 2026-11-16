// =====================================================================
//  回答の送信・受信
//  方式は config.js の設定で自動的に決まります：
//    firebase … FIREBASE_CONFIG が設定されている（ログインあり・永続保存）
//    relay    … RELAY が設定されている（ログイン不要・暗号化して ntfy.sh で中継）
//    demo     … どちらもない（この端末の中だけ。手元テスト用）
//  ゲスト側は、回答をまず端末の「送信待ち箱」に入れ、送れたら箱から出します。
//  電波がないときは、電波が戻ったとき・アプリを開き直したときに自動で再送します。
// =====================================================================
import { FIREBASE_CONFIG, TRIP_ID, RELAY } from "./config.js";

const OUTBOX_KEY = "ajc-outbox";
const SENT_KEY = "ajc-sent";
const DEMO_KEY = "ajc-demo-answers";
const HOST_KEY = "ajc-host-key";
const HOST_STORE = "ajc-host-answers";
const HOST_CLEARED = "ajc-host-cleared";

const hasFirebase = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("YOUR"));
const hasRelay = !!(RELAY && RELAY.topic && RELAY.publicKey);
export const mode = hasFirebase ? "firebase" : hasRelay ? "relay" : "demo";
export const isDemo = mode === "demo";
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

const load = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));

// =====================================================================
//  暗号化（ECDH P-256 + AES-GCM）— 彼女の端末で暗号化、ホストの鍵でだけ開ける
// =====================================================================
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const EC = { name: "ECDH", namedCurve: "P-256" };

async function encryptFor(publicKeyB64, obj) {
  const pub = await crypto.subtle.importKey("raw", unb64(publicKeyB64), EC, false, []);
  const eph = await crypto.subtle.generateKey(EC, true, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, epk: b64(await crypto.subtle.exportKey("raw", eph.publicKey)), iv: b64(iv), ct: b64(ct) });
}

async function decryptWith(privateKey, text) {
  const m = JSON.parse(text);
  if (m.v !== 1) throw new Error("unknown format");
  const epk = await crypto.subtle.importKey("raw", unb64(m.epk), EC, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: epk }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(m.iv) }, key, unb64(m.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// 手元（localhost）でのテストは別の中継先を使う（本番のホスト画面にテスト回答が混ざらないように）
const relayUrl = (path = "") => `${RELAY.server}/${RELAY.topic}${isLocal ? "-localtest" : ""}${path}`;

// =====================================================================
//  Firebase（設定されている場合だけ読み込む）
// =====================================================================
const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
let fbPromise = null;
function firebase() {
  if (!fbPromise) {
    fbPromise = (async () => {
      const [appMod, A, F] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]);
      const app = appMod.initializeApp(FIREBASE_CONFIG);
      return { A, F, auth: A.getAuth(app), db: F.getFirestore(app) };
    })().catch((e) => {
      fbPromise = null;
      throw e;
    });
  }
  return fbPromise;
}
const answersCol = ({ F, db }) => F.collection(db, "trips", TRIP_ID, "answers");

// =====================================================================
//  ゲスト側：送信
// =====================================================================
const readBox = () => load(OUTBOX_KEY, []);
const writeBox = (box) => store(OUTBOX_KEY, box);
const emit = () => window.dispatchEvent(new CustomEvent("ajc-sync", { detail: { pending: readBox().length } }));

export const pendingCount = () => readBox().length;

/** 回答を送信待ち箱に入れて、すぐ送信を試みる */
export function sendAnswer(answer) {
  const box = readBox();
  box.push({ ...answer, id: `${TRIP_ID}-s${answer.step}-${Date.now().toString(36)}`, tries: 0 });
  writeBox(box);
  emit();
  return flush();
}

function strip(a) {
  const { tries, ...rest } = a;
  return rest;
}
const removeFromBox = (id) => writeBox(readBox().filter((x) => x.id !== id));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function relayPublish(answer) {
  const body = await encryptFor(RELAY.publicKey, answer);
  const res = await withTimeout(fetch(relayUrl(), { method: "POST", body }), 15000);
  if (!res.ok) throw new Error(`relay ${res.status}`);
}

let flushing = null;
/** 送信待ちの回答をすべて送る（失敗したものは箱に残る） */
export function flush() {
  if (flushing) return flushing;
  // 後片付けは .finally で行う（同期的に終わった場合でもフラグが残らないように）
  flushing = (async () => {
    try {
      if (!readBox().length) return;

      if (mode === "demo") {
        if (!isLocal) return; // 公開URLで未設定なら端末に貯めておく
        const list = load(DEMO_KEY, []);
        for (const a of readBox()) list.push({ ...strip(a), receivedAt: new Date().toISOString() });
        store(DEMO_KEY, list);
        writeBox([]);
        return;
      }

      if (!navigator.onLine) return;

      if (mode === "relay") {
        for (const a of readBox()) {
          await relayPublish(strip(a));
          removeFromBox(a.id);
          const sent = load(SENT_KEY, []);
          if (!sent.some((x) => x.id === a.id)) sent.push(strip(a));
          store(SENT_KEY, sent);
        }
        return;
      }

      // firebase
      const fb = await firebase();
      if (!fb.auth.currentUser) await fb.A.signInAnonymously(fb.auth);
      for (const a of readBox()) {
        writeBox(readBox().map((x) => (x.id === a.id ? { ...x, tries: x.tries + 1 } : x)));
        try {
          const { id, ...data } = strip(a);
          await withTimeout(fb.F.setDoc(fb.F.doc(answersCol(fb), id), { ...data, receivedAt: fb.F.serverTimestamp() }), 15000);
          removeFromBox(a.id);
        } catch (e) {
          // 前回の送信が実は届いていた場合、上書きは拒否される → 届いた扱い
          if (e && e.code === "permission-denied" && a.tries > 0) removeFromBox(a.id);
          else throw e;
        }
      }
    } catch (e) {
      console.warn("[sync] 送信を保留しました:", e);
    }
  })().finally(() => {
    flushing = null;
    emit();
  });
  return flushing;
}

/** 中継サービスは約12時間で消えるので、送信済みの回答をときどき送り直す（ホスト側で重複は除く） */
async function relayResendSent() {
  if (mode !== "relay" || !navigator.onLine) return;
  const last = Number(localStorage.getItem("ajc-resent-at") || 0);
  if (Date.now() - last < 30 * 60 * 1000) return;
  localStorage.setItem("ajc-resent-at", String(Date.now()));
  for (const a of load(SENT_KEY, [])) {
    try { await relayPublish(a); } catch (_) { return; }
  }
}

/** 電波復帰・アプリ復帰のたびに自動で再送する */
export function startAutoFlush() {
  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush().then(relayResendSent);
  });
  setInterval(() => readBox().length && flush(), 30000);
  flush().then(relayResendSent);
}

// =====================================================================
//  ホスト側
// =====================================================================

/** relay 方式：URL の #key=... で渡された鍵を保存して、URL から消す */
function captureKeyFromUrl() {
  const m = location.hash.match(/key=([A-Za-z0-9_-]+)/);
  if (!m) return;
  localStorage.setItem(HOST_KEY, m[1]);
  history.replaceState(null, "", location.pathname + location.search);
}

async function importHostKey(str) {
  const b = str.replace(/-/g, "+").replace(/_/g, "/");
  const jwk = JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
  return crypto.subtle.importKey("jwk", jwk, EC, false, ["deriveKey"]);
}

/** relay 方式：鍵を手で貼り付けて保存（ホーム画面アプリ用）。正しい鍵か確かめてから保存 */
export async function setHostKey(str) {
  // スマホでコピーしたときに混ざる改行・空白は取り除く。URL ごと貼っても鍵だけ取り出す
  const s = str.replace(/\s+/g, "").replace(/^.*key=/, "");
  await importHostKey(s);
  localStorage.setItem(HOST_KEY, s);
  location.reload();
}
export const getHostKeyString = () => localStorage.getItem(HOST_KEY) || "";

/** ログイン状態の変化を受け取る。cb(user|null) */
export async function onHostAuth(cb) {
  if (mode === "demo") return cb({ uid: "demo" });
  if (mode === "relay") {
    captureKeyFromUrl();
    const k = localStorage.getItem(HOST_KEY);
    if (!k) return cb(null);
    try { await importHostKey(k); return cb({ uid: "relay" }); } catch (_) { return cb(null); }
  }
  const fb = await firebase();
  fb.A.onAuthStateChanged(fb.auth, (u) => cb(u && !u.isAnonymous ? u : null));
}

export async function hostSignIn(email, password) {
  const fb = await firebase();
  await fb.A.setPersistence(fb.auth, fb.A.browserLocalPersistence);
  return fb.A.signInWithEmailAndPassword(fb.auth, email, password);
}

/** ホスト用アカウントの初回登録（パスワードは本人が host.html で決める） */
export async function hostSignUp(email, password) {
  const fb = await firebase();
  await fb.A.setPersistence(fb.auth, fb.A.browserLocalPersistence);
  return fb.A.createUserWithEmailAndPassword(fb.auth, email, password);
}

export async function hostSignOut() {
  if (mode !== "firebase") return;
  const fb = await firebase();
  return fb.A.signOut(fb.auth);
}

/** 回答をリアルタイム購読。cb(answers[], error?) ・新しい順 */
export async function watchAnswers(cb) {
  if (mode === "demo") {
    const read = () => cb(load(DEMO_KEY, []).map((a, i) => ({ ...a, _id: a.id || String(i) })).reverse());
    addEventListener("storage", (e) => e.key === DEMO_KEY && read());
    read();
    return () => {};
  }
  if (mode === "relay") return watchRelay(cb);

  const fb = await firebase();
  const q = fb.F.query(answersCol(fb), fb.F.orderBy("clientTime", "desc"));
  return fb.F.onSnapshot(
    q,
    (snap) =>
      cb(snap.docs.map((d) => {
        const v = d.data();
        return { ...v, _id: d.id, receivedAt: v.receivedAt ? v.receivedAt.toDate().toISOString() : null };
      })),
    (err) => cb([], err)
  );
}

async function watchRelay(cb) {
  const key = await importHostKey(localStorage.getItem(HOST_KEY));
  const saved = load(HOST_STORE, {});
  const cleared = Number(localStorage.getItem(HOST_CLEARED) || 0);
  const render = () =>
    cb(Object.values(saved).sort((a, b) => (a.clientTime < b.clientTime ? 1 : -1)).map((a) => ({ ...a, _id: a.id })));

  async function ingest(msg) {
    if (msg.event !== "message" || !msg.message) return false;
    if (msg.time * 1000 <= cleared) return false;
    try {
      const a = await decryptWith(key, msg.message);
      if (!a.id || saved[a.id]) return false;
      saved[a.id] = { ...a, receivedAt: new Date(msg.time * 1000).toISOString() };
      store(HOST_STORE, saved);
      return true;
    } catch (_) {
      return false; // 鍵が合わない・壊れたメッセージは無視
    }
  }

  render();
  let es = null, stopped = false, retry = null;

  async function catchUp() {
    // 中継に残っている分（約12時間）をまとめて取得
    const res = await fetch(relayUrl("/json?poll=1&since=all"), { cache: "no-store" });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    let changed = false;
    for (const line of (await res.text()).split("\n")) {
      if (line.trim() && (await ingest(JSON.parse(line)))) changed = true;
    }
    if (changed) render();
  }

  function connect() {
    if (stopped) return;
    es = new EventSource(relayUrl("/sse"));
    es.onmessage = async (e) => {
      if (await ingest(JSON.parse(e.data))) render();
    };
    es.onerror = () => {
      es.close();
      clearTimeout(retry);
      retry = setTimeout(() => catchUp().catch(() => {}).finally(connect), 5000);
    };
  }

  try {
    await catchUp();
  } catch (e) {
    cb(Object.values(saved).map((a) => ({ ...a, _id: a.id })), { code: "relay-unreachable" });
  }
  connect();
  const onVisible = () => document.visibilityState === "visible" && catchUp().catch(() => {});
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    es && es.close();
    clearTimeout(retry);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** 回答をすべて削除（テスト後のお掃除用） */
export async function deleteAllAnswers() {
  if (mode === "demo") {
    localStorage.removeItem(DEMO_KEY);
    dispatchEvent(new StorageEvent("storage", { key: DEMO_KEY }));
    return;
  }
  if (mode === "relay") {
    // 中継サービス上のデータは消せないので、ここまでの分を「無視する」印を付ける
    localStorage.setItem(HOST_CLEARED, String(Date.now()));
    localStorage.removeItem(HOST_STORE);
    location.reload();
    return;
  }
  const fb = await firebase();
  const snap = await fb.F.getDocs(answersCol(fb));
  const batch = fb.F.writeBatch(fb.db);
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}
