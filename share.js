// =====================================================================
//  2台共有（思い出カレンダー・旅の本）
//  - 保存先：Firebase の Firestore（config.js の SHARE_FIREBASE）
//  - 中身は端末の中で暗号化してから送る。鍵は「共有コード」から作るので、
//    コードを持っている2台のスマホだけが読める（Google 側にも中身は見えない）
//  - 共有するもの：思い出（memories）、旅の本のあとから足したページ（extras）、
//    旅の回答（done）、写真（ステップの写真・足したページ・思い出）
//  - しくみ：前回送った内容（synced）と今の内容を比べて、変わったものだけ送る。
//    相手の変更はリアルタイムで受け取り、この端末の保存に反映する。
// =====================================================================
import { SHARE_FIREBASE, PUSH_URL } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
// 手元（localhost）で ?sharemock を付けたときだけ、偽物の保存先でテストする（share-mock.js は公開しない）
const useMock = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("sharemock");
export const pushReady = typeof PUSH_URL === "string" && /^https:\/\//.test(PUSH_URL);
export const shareReady = useMock || !!(SHARE_FIREBASE && SHARE_FIREBASE.apiKey && !SHARE_FIREBASE.apiKey.startsWith("YOUR"));

const enc8 = new TextEncoder(), dec8 = new TextDecoder();
const B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // まぎらわしい文字（I L O 0 1）を除いた31文字

// 共有コード：ランダム 20 文字（約 99 ビット）。表示は 4 文字ずつ区切る
export function newCode() {
    const r = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(r, (b) => B32[b % B32.length]).join("");
}
export const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const showCode = (c) => c.match(/.{1,4}/g).join("-");
const validCode = (c) => c.length === 20 && [...c].every((ch) => B32.includes(ch));

async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc8.encode(s))); }
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

export function createShare(h) {
    // h = { prefix, state, rawSave, photoGet, photoPutRaw, photoDelRaw, photoKeys, refresh, onStatus }
    const K = (name) => `${h.prefix}:share-${name}`;
    const load = (name, d) => { try { return JSON.parse(localStorage.getItem(K(name))) ?? d; } catch (e) { return d; } };
    const store = (name, v) => localStorage.setItem(K(name), JSON.stringify(v));

    let code = load("code", null);
    let synced = load("synced", {});   // { itemId: 送った JSON }
    let pv = load("pv", {});           // 写真のバージョン { key: 数字 }
    let fb = null, room = null, aes = null, unsub = null, ready = false;
    let status = { state: code ? "connecting" : "off", at: load("at", null), error: null };
    const setStatus = (s) => { status = { ...status, ...s }; h.onStatus && h.onStatus(status); };

    // ---------- 暗号化 ----------
    async function keysFor(c) {
        const r = hex(await sha(`ajc-room:${c}`)).slice(0, 32);
        const k = await crypto.subtle.importKey("raw", await sha(`ajc-key:${c}`), "AES-GCM", false, ["encrypt", "decrypt"]);
        return [r, k];
    }
    async function seal(bytes) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, bytes));
        const out = new Uint8Array(12 + ct.length);
        out.set(iv); out.set(ct, 12);
        return out;
    }
    async function open(u) {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, aes, u.slice(12)));
    }

    // ---------- Firebase ----------
    async function firebase() {
        if (fb) return fb;
        if (useMock) { fb = (await import("./share-mock.js")).default; return fb; }
        const [appMod, A, F] = await Promise.all([
            import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
        ]);
        const app = appMod.getApps().find((a) => a.name === "share") || appMod.initializeApp(SHARE_FIREBASE, "share");
        const auth = A.getAuth(app);
        if (!auth.currentUser) await A.signInAnonymously(auth);
        fb = { A, F, db: F.getFirestore(app) };
        return fb;
    }
    const itemsCol = () => fb.F.collection(fb.db, "rooms", room, "items");
    const itemDoc = (id) => fb.F.doc(fb.db, "rooms", room, "items", id);
    const photoDoc = (key) => fb.F.doc(fb.db, "rooms", room, "photos", key);

    // ---------- 今の中身を「アイテム」の一覧にする ----------
    function current() {
        const s = h.state, out = {};
        (s.memories || []).forEach((x) => { out[`m_${x.id}`] = JSON.stringify(x); });
        (s.extras || []).forEach((x) => { out[`x_${x.id}`] = JSON.stringify(x); });
        Object.entries(s.done || {}).forEach(([n, d]) => { out[`d_${n}`] = JSON.stringify(d); });
        Object.entries(pv).forEach(([k, v]) => { out[`p_${k}`] = JSON.stringify({ v }); });
        return out;
    }

    // 写真は 1 件 1MB 未満に（Firestore の 1 件の上限）
    async function photoBytes(blob) {
        let b = blob;
        for (let i = 0; i < 4; i++) {
            const u = new Uint8Array(await b.arrayBuffer());
            if (u.length < 900000) return u;
            b = await smaller(b, 0.75);
        }
        return new Uint8Array(await b.arrayBuffer());
    }
    async function smaller(blob, k) {
        const url = URL.createObjectURL(blob), img = new Image();
        await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.8));
    }

    // ---------- 送る（変わったものだけ） ----------
    let pushing = null, again = false, timer = null;
    function dirty() {
        if (!code) return;
        clearTimeout(timer);
        timer = setTimeout(push, 600);
    }
    function push() {
        if (!ready) return;
        if (pushing) { again = true; return pushing; }
        pushing = (async () => {
            const { F } = fb;
            const now = current();
            try {
                for (const [id, json] of Object.entries(now)) {
                    if (synced[id] === json) continue;
                    if (id.startsWith("p_")) {
                        const key = id.slice(2), blob = await h.photoGet(key);
                        if (!blob) { delete pv[key]; store("pv", pv); continue; }
                        await F.setDoc(photoDoc(key), { c: F.Bytes.fromUint8Array(await seal(await photoBytes(blob))) });
                    }
                    await F.setDoc(itemDoc(id), { c: F.Bytes.fromUint8Array(await seal(enc8.encode(json))), del: false, t: F.serverTimestamp() });
                    synced[id] = json; store("synced", synced);
                }
                for (const id of Object.keys(synced)) {
                    if (id in now) continue;
                    await F.setDoc(itemDoc(id), { del: true, t: F.serverTimestamp() });
                    if (id.startsWith("p_")) await F.deleteDoc(photoDoc(id.slice(2))).catch(() => {});
                    delete synced[id]; store("synced", synced);
                }
                const at = new Date().toISOString(); store("at", at);
                setStatus({ state: "on", at, error: null });
                await flushNotes();
            } catch (e) {
                setStatus({ state: "error", error: String(e && e.message || e) });
            }
        })().finally(() => { pushing = null; if (again) { again = false; push(); } });
        return pushing;
    }

    // ---------- 受け取る ----------
    async function apply(docs) {
        const s = h.state, kinds = new Set();
        for (const d of docs) {
            const id = d.id, v = d.data();
            const kind = id.slice(0, 2), key = id.slice(2);
            if (v.del) {
                if (!(id in synced) && !hasLocal(kind, key)) continue;
                if (kind === "m_") { s.memories = (s.memories || []).filter((x) => String(x.id) !== key); kinds.add("mem"); }
                if (kind === "x_") { s.extras = (s.extras || []).filter((x) => String(x.id) !== key); kinds.add("trip"); }
                if (kind === "p_") { await h.photoDelRaw(key); delete pv[key]; kinds.add(key.startsWith("m") ? "mem" : "trip"); }
                delete synced[id];
                continue;
            }
            if (!v.c) continue;
            let json;
            try { json = dec8.decode(await open(v.c.toUint8Array())); } catch (e) { continue; } // 鍵が違う
            if (synced[id] === json) continue;
            const obj = JSON.parse(json);
            if (kind === "m_") { s.memories = [...(s.memories || []).filter((x) => String(x.id) !== key), obj]; kinds.add("mem"); }
            if (kind === "x_") { s.extras = [...(s.extras || []).filter((x) => String(x.id) !== key), obj].sort((a, b) => a.id - b.id); kinds.add("trip"); }
            if (kind === "d_") { s.done = { ...(s.done || {}), [key]: obj }; kinds.add("answers"); }
            if (kind === "p_") {
                if (pv[key] !== obj.v) {
                    const snap = await fb.F.getDoc(photoDoc(key));
                    if (!snap.exists()) continue; // まだ届いていない：次の更新で取り直す
                    const bytes = await open(snap.data().c.toUint8Array());
                    await h.photoPutRaw(key, new Blob([bytes], { type: "image/jpeg" }));
                    pv[key] = obj.v;
                }
                kinds.add(key.startsWith("m") ? "mem" : "trip");
            }
            synced[id] = json;
        }
        store("synced", synced); store("pv", pv);
        if (kinds.size) { h.rawSave(); try { h.refresh(kinds); } catch (e) { console.warn(e); } }
    }
    function hasLocal(kind, key) {
        const s = h.state;
        if (kind === "m_") return (s.memories || []).some((x) => String(x.id) === key);
        if (kind === "x_") return (s.extras || []).some((x) => String(x.id) === key);
        if (kind === "p_") return key in pv;
        return false;
    }

    // ---------- つなぐ ----------
    async function connect() {
        if (!code || !shareReady) return;
        setStatus({ state: "connecting", error: null });
        try {
            [room, aes] = await keysFor(code);
            await firebase();
            if (unsub) unsub();
            // 最初に相手側の中身をまとめて取り込む（同じものは相手側を優先）→ そのあとこちらの分を送る
            const first = await fb.F.getDocs(itemsCol());
            await apply(first.docs);
            ready = true;
            if (notifyOn() && pushReady) subscribe().catch(() => {}); // 宛先が変わっていても届くように、つなぐたびに登録し直す
            await push();
            unsub = fb.F.onSnapshot(itemsCol(), (snap) => {
                const docs = snap.docChanges().filter((c) => !c.doc.metadata.hasPendingWrites).map((c) => c.doc);
                if (docs.length) apply(docs).then(() => setStatus({ state: "on", at: new Date().toISOString() }));
            }, (e) => setStatus({ state: "error", error: String(e && e.message || e) }));
        } catch (e) {
            setStatus({ state: "error", error: String(e && e.message || e) });
        }
    }

    async function begin(c) {
        c = cleanCode(c);
        if (!validCode(c)) throw new Error("コードが正しくありません");
        code = c; store("code", c);
        synced = {}; store("synced", synced);
        // この端末にある写真を、全部「送るもの」に入れる
        for (const key of await h.photoKeys()) if (!(key in pv)) pv[key] = 1;
        store("pv", pv);
        await connect();
    }
    // ---------- 通知（Cloudflare Worker 経由の Web Push） ----------
    const pushRoom = async () => hex(await sha(`ajc-push:${code}`)).slice(0, 32);
    function devId() {
        let d = load("dev", null);
        if (!d) { d = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join(""); store("dev", d); }
        return d;
    }
    const post = (path, body) => fetch(PUSH_URL.replace(/\/$/, "") + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }));
    const unb64u = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
    const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const notifyOn = () => load("notify", false) && canPush() && Notification.permission === "granted";

    async function subscribe() {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const { key } = await fetch(PUSH_URL.replace(/\/$/, "") + "/key").then((r) => r.json());
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
        }
        await post("/sub", { room: await pushRoom(), dev: devId(), name: load("name", ""), sub: sub.toJSON() });
    }
    async function enableNotify() {
        if (!pushReady || !code) throw new Error("先に共有をはじめてください");
        if (!canPush()) throw new Error("この画面では通知を使えません。iPhone は「ホーム画面に追加」したアプリから開いてください（iOS 16.4 以降）。");
        const p = await Notification.requestPermission();
        if (p !== "granted") throw new Error("通知が許可されませんでした。iPhone の「設定」→ 通知 → このアプリ で許可できます。");
        await subscribe();
        store("notify", true);
    }
    async function disableNotify() {
        store("notify", false);
        try {
            const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
            if (code) await post("/unsub", { room: await pushRoom(), dev: devId() });
        } catch (e) { /* 失敗しても、こちらでは受け取らない */ }
    }
    // 相手に送る通知（共有が送れたあとで送る：相手が開いたとき、もう写真が届いているように）
    function note(body) {
        if (!pushReady || !code) return;
        const list = load("notes", []);
        list.push({ body, at: Date.now() });
        store("notes", list.slice(-5));
        dirty();
    }
    async function flushNotes() {
        const list = load("notes", []);
        if (!list.length || !pushReady) return;
        store("notes", []);
        const fresh = list.filter((n) => Date.now() - n.at < 6 * 3600 * 1000); // 古すぎるものは送らない
        try {
            const room = await pushRoom();
            for (const n of fresh) await post("/notify", { room, dev: devId(), title: "ふたりの思い出", body: n.body });
        } catch (e) { store("notes", [...fresh, ...load("notes", [])].slice(-5)); }
    }

    function stop() {
        if (load("notify", false)) disableNotify();
        if (unsub) unsub();
        unsub = null; ready = false; code = null;
        ["code", "synced", "at"].forEach((n) => localStorage.removeItem(K(n)));
        synced = {};
        setStatus({ state: "off", at: null, error: null });
    }

    // 写真が増えた・変わった・消えた
    function photo(key, exists) {
        if (exists) pv[key] = Date.now(); else delete pv[key];
        store("pv", pv);
        dirty();
    }

    addEventListener("online", () => { if (code && !ready) connect(); else dirty(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && code) { if (!ready) connect(); else dirty(); } });

    return {
        get code() { return code; },
        get status() { return status; },
        connect, begin, stop, dirty, photo, note, enableNotify, disableNotify,
        get notifyOn() { return notifyOn(); },
        get canPush() { return canPush(); },
        get name() { return load("name", ""); },
        set name(v) { store("name", String(v || "").trim().slice(0, 20)); if (notifyOn()) subscribe().catch(() => {}); },
    };
}
