// =====================================================================
//  回答の送信・受信（Firebase Firestore）
//  - ゲスト側：回答はまず端末に保存（送信待ち箱）→ 電波があれば Firestore へ送る
//    電波がない場所で回答しても、次に電波が戻ったとき / アプリを開いたときに自動送信
//  - ホスト側：Firestore をリアルタイム購読して、届いた瞬間に画面へ反映
//  - config.js が未設定なら「デモモード」：この端末の localStorage だけで動く
// =====================================================================
import { FIREBASE_CONFIG, TRIP_ID } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
const OUTBOX_KEY = "ajc-outbox";
const DEMO_KEY = "ajc-demo-answers";

export const isDemo =
  !FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey.startsWith("YOUR");

// ---------- Firebase 読み込み（必要になったときだけ） ----------
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
      fbPromise = null; // オフラインで読めなかったら次回やり直す
      throw e;
    });
  }
  return fbPromise;
}
const answersCol = ({ F, db }) => F.collection(db, "trips", TRIP_ID, "answers");

// ---------- ゲスト側：送信 ----------
const readBox = () => JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
const writeBox = (box) => localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
const emit = () =>
  window.dispatchEvent(new CustomEvent("ajc-sync", { detail: { pending: readBox().length } }));

export function pendingCount() {
  return readBox().length;
}

/** 回答を送信待ち箱に入れて、すぐ送信を試みる */
export function sendAnswer(answer) {
  const box = readBox();
  box.push({ ...answer, id: `${TRIP_ID}-s${answer.step}-${Date.now().toString(36)}`, tries: 0 });
  writeBox(box);
  emit();
  return flush();
}

let flushing = null;
/** 送信待ちの回答をすべて送る（失敗したものは箱に残る） */
export function flush() {
  if (flushing) return flushing;
  // 注意：後片付けは .finally で行う（同期的に終わった場合でもフラグが残らないように）
  flushing = (async () => {
    try {
      if (!readBox().length) return;
      if (isDemo) {
        // 公開URLで Firebase 未設定のときは、送らずに彼女の端末に貯めておく
        // （あとで config.js を設定して公開し直すと、貯まっていた回答が自動で届く）
        if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
        const store = JSON.parse(localStorage.getItem(DEMO_KEY) || "[]");
        for (const a of readBox()) store.push({ ...strip(a), receivedAt: new Date().toISOString() });
        localStorage.setItem(DEMO_KEY, JSON.stringify(store));
        writeBox([]);
        return;
      }
      if (!navigator.onLine) return;
      const fb = await firebase();
      if (!fb.auth.currentUser) await fb.A.signInAnonymously(fb.auth);
      for (const a of readBox()) {
        // 送信回数を先に記録（送信中にアプリを閉じても重複判定できるように）
        writeBox(readBox().map((x) => (x.id === a.id ? { ...x, tries: x.tries + 1 } : x)));
        try {
          await withTimeout(
            fb.F.setDoc(fb.F.doc(answersCol(fb), a.id), {
              ...strip(a),
              receivedAt: fb.F.serverTimestamp(),
            }),
            15000
          );
          removeFromBox(a.id);
        } catch (e) {
          // 前回の送信が実は届いていた場合、上書きは拒否される → 届いた扱いで箱から消す
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

function strip(a) {
  const { id, tries, ...rest } = a;
  return rest;
}
function removeFromBox(id) {
  writeBox(readBox().filter((x) => x.id !== id));
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/** 電波復帰・アプリ復帰のたびに自動で再送する */
export function startAutoFlush() {
  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  setInterval(() => readBox().length && flush(), 30000);
  flush();
}

// ---------- ホスト側：ログインと購読 ----------
/** ログイン状態の変化を受け取る。cb(user|null) */
export async function onHostAuth(cb) {
  if (isDemo) return cb({ email: "demo", uid: "demo" });
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
  if (isDemo) return;
  const fb = await firebase();
  return fb.A.signOut(fb.auth);
}

/** 回答をリアルタイム購読。cb(answers[], error?) ・新しい順 */
export async function watchAnswers(cb) {
  if (isDemo) {
    const read = () => {
      const list = JSON.parse(localStorage.getItem(DEMO_KEY) || "[]");
      cb(list.map((a, i) => ({ ...a, _id: String(i) })).reverse());
    };
    addEventListener("storage", (e) => e.key === DEMO_KEY && read());
    read();
    return () => {};
  }
  const fb = await firebase();
  const q = fb.F.query(answersCol(fb), fb.F.orderBy("clientTime", "desc"));
  return fb.F.onSnapshot(
    q,
    (snap) =>
      cb(
        snap.docs.map((d) => {
          const v = d.data();
          return { ...v, _id: d.id, receivedAt: v.receivedAt ? v.receivedAt.toDate().toISOString() : null };
        })
      ),
    (err) => cb([], err)
  );
}

/** 回答をすべて削除（テスト後のお掃除用） */
export async function deleteAllAnswers() {
  if (isDemo) {
    localStorage.removeItem(DEMO_KEY);
    dispatchEvent(new StorageEvent("storage", { key: DEMO_KEY }));
    return;
  }
  const fb = await firebase();
  const snap = await fb.F.getDocs(answersCol(fb));
  const batch = fb.F.writeBatch(fb.db);
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}
