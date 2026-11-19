'use strict';
/* ==========================================================================
   SERVICE BD — BACKEND  (Node.js + Express + Firebase Admin + Realtime DB)
   Vercel এ সরাসরি চলে:  export = Express app
   লোকালি চালাতে:  node api/server.js   (http://localhost:3000)

   Vercel Environment Variables:
     FIREBASE_SERVICE_ACCOUNT  → Service Account JSON (পুরো JSON, অথবা base64)
     ADMIN_PASSWORD            → অ্যাডমিন প্যানেলের পাসওয়ার্ড (বাধ্যতামূলক)
     ADMIN_SECRET              → (ঐচ্ছিক) টোকেন সাইন করার সিক্রেট
     FIREBASE_DATABASE_URL     → (ঐচ্ছিক) নিচের databaseURL ওভাররাইড করতে
   ========================================================================== */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const admin = require('firebase-admin');

/* ==========================================================================
   FIREBASE WEB CONFIG  (CDN / ক্লায়েন্ট কনফিগ — এখানে বসান)
   Firebase Console → Project settings → Your apps → Web app → firebaseConfig
   এটা পাবলিক তথ্য; /api/config দিয়ে ফ্রন্টএন্ডে যায়, তাই backend ছাড়া সাইট চলবে না।
   ========================================================================== */
const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyCxFw8-qUbJ5i7BWwh46GL7Tf5JCl3M_cU",
  authDomain: "social-service-panel.firebaseapp.com",
  databaseURL: "https://social-service-panel-default-rtdb.firebaseio.com",
  projectId: "social-service-panel",
  storageBucket: "social-service-panel.firebasestorage.app",
  messagingSenderId: "1011326650302",
  appId: "1:1011326650302:web:451dd843a6ac7e3b251bef",
  measurementId: "G-L9029CR6SN"
};


/* ==========================================================================
   HELPERS
   ========================================================================== */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round2 = (n) => Math.round(n * 100) / 100;
const slug = (v) => str(v, 60).toLowerCase().replace(/[^a-z0-9_-]/g, '');
const cssIcon = (v, d) => { const s = str(v, 60).replace(/[^a-z0-9\- ]/gi, '').trim(); return s || d; };
const hexColor = (v, d) => (/^#[0-9a-f]{3,8}$/i.test(str(v, 9)) ? str(v, 9) : d);
const pad = (n) => String(n).padStart(8, '0');

const REFILLS = ['none', 'nodrop', '7', '15', '30', '60', '90', 'lifetime'];
const BADGES = ['', 'starter', 'popular', 'pro', 'vip'];
const STATUSES = ['Pending', 'Processing', 'In Progress', 'Completed', 'Partial', 'Cancelled'];
const METHODS = ['bkash', 'nagad', 'rocket'];

/* ---------- Firebase Admin (lazy) ---------- */
let _db = null;
function loadServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpError(500, 'সার্ভার কনফিগার করা নেই: FIREBASE_SERVICE_ACCOUNT env সেট করুন');
  raw = raw.trim();
  if (raw[0] !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT সঠিক JSON নয়'); }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}
function db() {
  if (_db) return _db;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount()),
      databaseURL: process.env.FIREBASE_DATABASE_URL || FIREBASE_WEB_CONFIG.databaseURL
    });
  }
  _db = admin.database();
  return _db;
}

/* ---------- Simple in-memory rate limit ---------- */
const hits = new Map();
function rl(name, max, windowMs) {
  return (req, res, next) => {
    const ip = str((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 60);
    const key = name + '|' + ip;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return next(new HttpError(429, 'অনেক বেশি অনুরোধ। একটু পরে চেষ্টা করুন।')); }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) { for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k); }
    next();
  };
}

/* ==========================================================================
   DEFAULT DATA (প্রথমবার চালালে অটো সিড হয়; পরে অ্যাডমিন প্যানেল থেকে এডিট করুন)
   ========================================================================== */
const DEFAULT_SETTINGS = {
  brand: 'Service BD',
  whatsapp: '', telegram: '', group: '', youtube: '', email: '',
  notice: '📢 স্বাগতম! সকল সার্ভিসে সেরা রেট। যেকোনো সমস্যায় সাপোর্টে যোগাযোগ করুন।',
  minDeposit: 10,
  maintenance: false,
  payments: { bkash: '', nagad: '', rocket: '' },
  payNote: 'Send Money করে নিচের ফর্মে Transaction ID ও আপনার নম্বর দিন। এডমিন যাচাই করে ব্যালেন্স যোগ করে দিবে।',
  covers: [
    { title: 'Fast & Cheap<br>Social Services', sub: 'Facebook • Instagram • TikTok', icon: 'fas fa-rocket', src: '' },
    { title: 'Grow Your<br>Social Presence', sub: 'পাসওয়ার্ড ছাড়াই নিরাপদ সার্ভিস', icon: 'fab fa-instagram', src: '' },
    { title: '24/7 Live<br>Support', sub: 'যেকোনো সমস্যায় WhatsApp / Telegram', icon: 'fas fa-headset', src: '' }
  ],
  pages: { about: '', terms: '', privacy: '', refund: '' }
};

const SEED_CATEGORIES = [
  { id: 'facebook', name: 'Facebook', icon: 'fab fa-facebook', color: '#1877F2', order: 1,
    linkPh: 'https://facebook.com/yourpage', linkHint: 'Page / Profile / Post এর সম্পূর্ণ লিংক দিন। অ্যাকাউন্ট অবশ্যই Public রাখতে হবে।',
    rules: ['অ্যাকাউন্ট / পোস্ট অবশ্যই Public থাকতে হবে।', 'অর্ডার চলাকালীন একই লিংকে দ্বিতীয় অর্ডার দিবেন না।', 'ভুল লিংক দিলে রিফান্ড পাওয়া যাবে না।', 'Drop হলে Refill সার্ভিসে সাপোর্ট দেওয়া হবে।'] },
  { id: 'instagram', name: 'Instagram', icon: 'fab fa-instagram', color: '#E4405F', order: 2,
    linkPh: 'https://instagram.com/username', linkHint: 'Profile বা Post/Reel এর লিংক দিন। অ্যাকাউন্ট অবশ্যই Public রাখতে হবে।',
    rules: ['অ্যাকাউন্ট অবশ্যই Public থাকতে হবে।', 'Private অ্যাকাউন্টে অর্ডার করলে রিফান্ড হবে না।', 'অর্ডার চলাকালীন Username বদলাবেন না।', 'সঠিক লিংক / Username দিন।'] },
  { id: 'tiktok', name: 'TikTok', icon: 'fab fa-tiktok', color: '#111827', order: 3,
    linkPh: 'https://tiktok.com/@username', linkHint: 'Profile বা Video এর লিংক দিন। অ্যাকাউন্ট Public রাখুন।',
    rules: ['অ্যাকাউন্ট ও ভিডিও Public থাকতে হবে।', 'ভিডিও ডিলিট করলে অর্ডার বাতিল হবে।', 'একই লিংকে একসাথে একাধিক অর্ডার দিবেন না।', 'ডেলিভারি স্পিড লোড অনুযায়ী কম-বেশি হতে পারে।'] },
  { id: 'other', name: 'Other', icon: 'fas fa-globe', color: '#FF6B00', order: 4,
    linkPh: 'https://...', linkHint: 'সার্ভিসের জন্য প্রযোজ্য লিংক দিন (YouTube / Telegram / Twitter ইত্যাদি)।',
    rules: ['লিংক Public / Accessible হতে হবে।', 'Telegram চ্যানেল অবশ্যই Public হতে হবে।', 'ভুল লিংকের জন্য রিফান্ড হবে না।', 'সমস্যায় সাপোর্টে যোগাযোগ করুন।'] }
];

// [id, cat, name, rate, min, max, speed, refill, badge, icon, type, tags]
const SEED_SERVICES_RAW = [
  ['fb-follower', 'facebook', 'Facebook Page / Profile Followers | Real Looking | Max 1M | 50k/day', 150, 1000, 1000000, 'Instant', '30', 'vip', 'fas fa-users'],
  ['fb-like', 'facebook', 'Facebook Post React - LIKE 👍 | High Quality | Max 100k | 20k/day', 150, 100, 100000, 'Instant', '30', 'popular', 'fas fa-thumbs-up'],
  ['fb-care', 'facebook', 'Facebook Post React - CARE 🥰 | High Quality | Max 100k | 20k/day', 150, 100, 100000, 'Instant', '30', 'popular', 'fas fa-heart'],
  ['fb-wow', 'facebook', 'Facebook Post React - WOW 😮 | High Quality | Max 100k | 20k/day', 150, 100, 100000, 'Instant', '30', 'popular', 'fas fa-surprise'],
  ['fb-haha', 'facebook', 'Facebook Post React - HAHA 😂 | High Quality | Max 100k | 20k/day', 150, 100, 100000, 'Instant', '30', 'popular', 'fas fa-laugh'],
  ['fb-angry', 'facebook', 'Facebook Post React - ANGRY 😡 | High Quality | Max 100k | 20k/day', 150, 100, 100000, 'Instant', '30', 'popular', 'fas fa-angry'],
  ['fb-comment', 'facebook', 'Facebook BD 🇧🇩 Custom Comments | Real BD ID | Max 10k | 1k/day', 1200, 100, 10000, '1-3 Hours', 'none', 'popular', 'fas fa-comments'],
  ['fb-view', 'facebook', 'Facebook Video Views | High Retention | Max 500k | 100k/day', 30, 1000, 500000, 'Instant', 'none', 'starter', 'fas fa-eye'],
  ['fb-share', 'facebook', 'Facebook Post Share | Big Public Group | Max 10k | 2k/day', 60, 100, 10000, '1-3 Hours', 'none', 'popular', 'fas fa-share'],
  ['fb-monthly-basic', 'facebook', 'Basic Monthly Page Reach Package | 70-100 React + 10-15 Comment Per Post | 20 Posts / Month', 500, 1, 1, 'Monthly', 'none', 'pro', 'fas fa-rocket', 'fixed', ['Full Support']],
  ['ig-follower-real', 'instagram', 'Instagram Followers | Real | Max 100k | 20k/day', 210, 100, 100000, '1-3 Hours', 'nodrop', 'popular', 'fas fa-user-plus'],
  ['ig-follower-mix', 'instagram', 'Instagram Followers | Bot Mix | Max 100k | 30k/day', 160, 100, 100000, 'Instant', 'nodrop', 'starter', 'fas fa-users'],
  ['ig-like', 'instagram', 'Instagram Post Likes | Real Mix | Max 100k | 20k/day', 50, 100, 100000, 'Instant', 'nodrop', 'starter', 'fas fa-heart'],
  ['ig-view', 'instagram', 'Instagram Reel Views | Real Mix | Max 1M | 100k/day', 20, 500, 1000000, 'Instant', 'nodrop', '', 'fas fa-play-circle'],
  ['tt-follower', 'tiktok', 'TikTok Followers | Real Mix | Max 100k | 20k/day', 200, 100, 100000, '1-6 Hours', 'nodrop', 'vip', 'fas fa-user-plus'],
  ['tt-view', 'tiktok', 'TikTok Video Views | Real Mix | Max 5M | 500k/day', 6, 1000, 5000000, 'Instant', 'nodrop', 'starter', 'fas fa-eye'],
  ['tt-saved', 'tiktok', 'TikTok Video Saved | Real Mix | Max 100k | 20k/day', 35, 100, 100000, 'Instant', 'nodrop', 'popular', 'fas fa-bookmark'],
  ['tt-share', 'tiktok', 'TikTok Share / Copy Link | Real Mix | Max 50k | 10k/day', 120, 100, 50000, 'Instant', 'nodrop', '', 'fas fa-share'],
  ['ot-yt-view', 'other', 'YouTube Views | Real Mix | Max 100k | 20k/day', 200, 500, 100000, '1-24 Hours', 'none', 'popular', 'fab fa-youtube'],
  ['ot-yt-sub', 'other', 'YouTube Subscribers | Real Mix | Max 10k | 1k/day', 900, 50, 10000, '1-3 Days', '30', 'pro', 'fab fa-youtube'],
  ['ot-tg-member', 'other', 'Telegram Channel Members | Real Mix | Max 50k | 10k/day', 150, 100, 50000, '1-2 Hours', '30', 'starter', 'fab fa-telegram'],
  ['ot-x-follower', 'other', 'Twitter (X) Followers | Real Mix | Max 20k | 5k/day', 350, 100, 20000, '1-6 Hours', 'none', '', 'fab fa-x-twitter']
];

async function ensureSeed() {
  const flag = await db().ref('meta/seeded').once('value');
  if (flag.val()) return;
  const updates = { 'meta/seeded': true };
  SEED_CATEGORIES.forEach((c) => { updates['categories/' + c.id] = c; });
  SEED_SERVICES_RAW.forEach((r, i) => {
    updates['services/' + r[0]] = {
      id: r[0], cat: r[1], name: r[2], desc: '', type: r[10] || 'per1000', rate: r[3], min: r[4], max: r[5],
      speed: r[6], refill: r[7], badge: r[8], icon: r[9], tags: r[11] || [], stock: true, hidden: false, order: i + 1
    };
  });
  await db().ref().update(updates);
}

/* ==========================================================================
   SETTINGS / CATALOG
   ========================================================================== */
async function getSettings() {
  const v = (await db().ref('settings').once('value')).val() || {};
  return {
    ...DEFAULT_SETTINGS, ...v,
    payments: { ...DEFAULT_SETTINGS.payments, ...(v.payments || {}) },
    pages: { ...DEFAULT_SETTINGS.pages, ...(v.pages || {}) },
    covers: Array.isArray(v.covers) && v.covers.length ? v.covers : DEFAULT_SETTINGS.covers
  };
}
const byOrder = (a, b) => (num(a.order, 999) - num(b.order, 999)) || String(a.name).localeCompare(String(b.name));
async function getCatalog(includeHidden) {
  const [c, s] = await Promise.all([db().ref('categories').once('value'), db().ref('services').once('value')]);
  let cats = Object.values(c.val() || {}).sort(byOrder);
  let svcs = Object.values(s.val() || {}).sort(byOrder);
  if (!includeHidden) { cats = cats.filter((x) => !x.hidden); svcs = svcs.filter((x) => !x.hidden); }
  cats.forEach((x) => { x.rules = x.rules || []; });
  svcs.forEach((x) => { x.tags = x.tags || []; });
  return { categories: cats, services: svcs };
}

/* ==========================================================================
   USER AUTH (Firebase ID token)
   ========================================================================== */
async function auth(req, res, next) {
  try {
    const hd = req.headers.authorization || '';
    const token = hd.startsWith('Bearer ') ? hd.slice(7) : '';
    if (!token) throw new HttpError(401, 'লগইন করুন');
    db();
    try { req.fb = await admin.auth().verifyIdToken(token); }
    catch (e) { throw new HttpError(401, 'সেশন শেষ হয়েছে, আবার লগইন করুন'); }
    next();
  } catch (e) { next(e); }
}

async function loadUser(req, res, next) {
  try {
    const uid = req.fb.uid;
    const ref = db().ref('users/' + uid);
    const name = str((req.body && req.body.name) || req.fb.name || (req.fb.email || '').split('@')[0] || 'User', 40);
    const fresh = {
      uid, name, email: str(req.fb.email, 120), photo: str(req.fb.picture, 300),
      balance: 0, banned: false, createdAt: Date.now()
    };
    const r = await ref.transaction((cur) => cur || fresh);
    req.user = r.snapshot.val();
    if (req.user.banned) throw new HttpError(403, 'আপনার অ্যাকাউন্ট ব্লক করা হয়েছে। সাপোর্টে যোগাযোগ করুন।');
    next();
  } catch (e) { next(e); }
}

const publicUser = (u) => ({ uid: u.uid, name: u.name, email: u.email, photo: u.photo || '', balance: round2(num(u.balance)) });

async function addTxn(uid, data) {
  await db().ref('txns/' + uid).push({ ts: Date.now(), ...data });
}
async function creditUser(uid, amount) {
  const r = await db().ref('users/' + uid + '/balance').transaction((b) => round2(num(b) + amount));
  return r.snapshot.val();
}

/* ==========================================================================
   ADMIN AUTH (পাসওয়ার্ড → সাইন করা টোকেন)
   ========================================================================== */
function adminSecret() {
  return process.env.ADMIN_SECRET ||
    crypto.createHash('sha256').update('adm|' + (process.env.ADMIN_PASSWORD || '') + '|' + (process.env.FIREBASE_SERVICE_ACCOUNT || '')).digest('hex');
}
const sign = (p) => crypto.createHmac('sha256', adminSecret()).update(p).digest('base64url');
function makeAdminToken() {
  const p = Buffer.from(JSON.stringify({ r: 'admin', exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return p + '.' + sign(p);
}
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function adminAuth(req, res, next) {
  try {
    if (!process.env.ADMIN_PASSWORD) throw new HttpError(500, 'ADMIN_PASSWORD env সেট করা নেই');
    const hd = req.headers.authorization || '';
    const t = hd.startsWith('Bearer ') ? hd.slice(7) : '';
    const [p, s] = t.split('.');
    if (!p || !s || !safeEq(sign(p), s)) throw new HttpError(401, 'অ্যাডমিন লগইন করুন');
    const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (data.r !== 'admin' || data.exp < Date.now()) throw new HttpError(401, 'সেশন শেষ, আবার লগইন করুন');
    db();
    next();
  } catch (e) { next(e instanceof HttpError ? e : new HttpError(401, 'অ্যাডমিন লগইন করুন')); }
}

/* ==========================================================================
   APP
   ========================================================================== */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------------- PUBLIC ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ firebase: { ...FIREBASE_WEB_CONFIG, databaseURL: process.env.FIREBASE_DATABASE_URL || FIREBASE_WEB_CONFIG.databaseURL } });
});

app.get('/api/bootstrap', h(async (req, res) => {
  db(); await ensureSeed();
  const [settings, cat] = await Promise.all([getSettings(), getCatalog(false)]);
  const okCats = new Set(cat.categories.map((c) => c.id));
  res.json({ settings, categories: cat.categories, services: cat.services.filter((s) => okCats.has(s.cat)) });
}));

/* ---------------- USER ---------------- */
app.post('/api/me', rl('me', 60, 60e3), auth, loadUser, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/orders', auth, loadUser, h(async (req, res) => {
  const snap = await db().ref('orders').orderByChild('uid').equalTo(req.user.uid).limitToLast(100).once('value');
  const list = Object.values(snap.val() || {}).sort((a, b) => b.ts - a.ts).map((o) => ({
    id: o.id, no: o.no, service: o.service, serviceId: o.serviceId, cat: o.cat, link: o.link, qty: o.qty, total: o.total,
    status: o.status, startCount: o.startCount || '', note: o.note || '', ts: o.ts, refill: o.refill || 'none',
    refillRequest: o.refillRequest || null, refundAmount: o.refundAmount || 0
  }));
  res.json({ orders: list });
}));

app.get('/api/wallet', auth, loadUser, h(async (req, res) => {
  const [t, d] = await Promise.all([
    db().ref('txns/' + req.user.uid).limitToLast(50).once('value'),
    db().ref('deposits').orderByChild('uid').equalTo(req.user.uid).limitToLast(50).once('value')
  ]);
  res.json({
    user: publicUser(req.user),
    txns: Object.values(t.val() || {}).sort((a, b) => b.ts - a.ts),
    deposits: Object.values(d.val() || {}).sort((a, b) => b.ts - a.ts).map((x) => ({
      amount: x.amount, method: x.method, trxId: x.trxId, status: x.status, note: x.note || '', ts: x.ts
    }))
  });
}));

app.post('/api/order', rl('order', 20, 60e3), auth, loadUser, h(async (req, res) => {
  const settings = await getSettings();
  if (settings.maintenance) throw new HttpError(503, 'সাইট এখন মেইনটেনেন্স মোডে আছে। একটু পরে চেষ্টা করুন।');
  const s = (await db().ref('services/' + slug(req.body.serviceId)).once('value')).val();
  if (!s || s.hidden) throw bad('সার্ভিসটি পাওয়া যায়নি');
  if (s.stock === false) throw bad('সার্ভিসটি এখন Stock Out');
  const link = str(req.body.link, 500);
  if (link.length < 3) throw bad('সঠিক লিংক / Username দিন');
  const fixed = s.type === 'fixed';
  const qty = fixed ? 1 : parseInt(req.body.qty, 10);
  if (!qty || qty < s.min || qty > s.max) throw bad('Quantity অবশ্যই ' + s.min + ' থেকে ' + s.max + ' এর মধ্যে হতে হবে');
  const total = round2(fixed ? num(s.rate) : (qty / 1000) * num(s.rate));
  if (!(total > 0)) throw bad('মূল্য নির্ধারণে সমস্যা হয়েছে');

  const uid = req.user.uid;
  const bal = await db().ref('users/' + uid + '/balance').transaction((b) => {
    b = num(b); if (b < total) return; return round2(b - total);
  });
  if (!bal.committed) throw new HttpError(402, 'ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই। আগে Add Money করুন।');

  try {
    const c = await db().ref('meta/orderCounter').transaction((n) => (n || 1000) + 1);
    const no = c.snapshot.val();
    const id = pad(no);
    const order = {
      id, no, uid, userName: req.user.name, userEmail: req.user.email,
      serviceId: s.id, service: s.name, cat: s.cat, link, qty, total, rate: s.rate, type: s.type || 'per1000',
      refill: s.refill || 'none', status: 'Pending', startCount: '', note: '', refunded: false, ts: Date.now()
    };
    await db().ref('orders/' + id).set(order);
    await addTxn(uid, { type: 'debit', amt: total, note: 'Order #' + no + ' — ' + s.name.split('|')[0].trim(), ref: id });
    res.json({ order: { id, no, service: s.name, link, qty, total, status: 'Pending' }, balance: bal.snapshot.val() });
  } catch (e) {
    await creditUser(uid, total).catch(() => {});
    throw new HttpError(500, 'অর্ডার সম্পন্ন হয়নি, টাকা ফেরত দেওয়া হয়েছে। আবার চেষ্টা করুন।');
  }
}));

app.post('/api/order/:id/refill', rl('refill', 10, 60e3), auth, loadUser, h(async (req, res) => {
  const ref = db().ref('orders/' + slug(req.params.id));
  const o = (await ref.once('value')).val();
  if (!o || o.uid !== req.user.uid) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
  if (o.status !== 'Completed') throw bad('শুধু Completed অর্ডারে Refill চাওয়া যায়');
  if (!['7', '15', '30', '60', '90', 'lifetime'].includes(o.refill)) throw bad('এই সার্ভিসে Refill নেই');
  if (o.refillRequest && o.refillRequest.status === 'requested') throw bad('Refill রিকোয়েস্ট আগেই পাঠানো হয়েছে');
  if (o.refill !== 'lifetime' && Date.now() - o.ts > Number(o.refill) * 86400000) throw bad('Refill সময়সীমা শেষ হয়ে গেছে');
  await ref.child('refillRequest').set({ status: 'requested', ts: Date.now() });
  res.json({ ok: true });
}));

app.post('/api/deposit', rl('deposit', 10, 10 * 60e3), auth, loadUser, h(async (req, res) => {
  const settings = await getSettings();
  const method = str(req.body.method, 10).toLowerCase();
  if (!METHODS.includes(method)) throw bad('পেমেন্ট মেথড সিলেক্ট করুন');
  const amount = round2(num(req.body.amount));
  if (amount < num(settings.minDeposit, 10)) throw bad('সর্বনিম্ন ডিপোজিট ৳' + settings.minDeposit);
  if (amount > 500000) throw bad('এত বড় অ্যামাউন্ট সাপোর্ট করা হয় না');
  const sender = str(req.body.sender, 20).replace(/[^0-9+]/g, '');
  if (sender.length < 6) throw bad('যে নম্বর থেকে টাকা পাঠিয়েছেন সেটি দিন');
  const trxId = str(req.body.trxId, 30).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (trxId.length < 6) throw bad('সঠিক Transaction ID দিন');

  const dRef = db().ref('deposits').push();
  const lock = await db().ref('trxIndex/' + trxId).transaction((v) => (v ? undefined : dRef.key));
  if (!lock.committed) throw bad('এই Transaction ID আগেই ব্যবহার করা হয়েছে');
  try {
    await dRef.set({
      id: dRef.key, uid: req.user.uid, userName: req.user.name, userEmail: req.user.email,
      amount, method, sender, trxId, status: 'pending', note: '', ts: Date.now()
    });
  } catch (e) {
    await db().ref('trxIndex/' + trxId).remove().catch(() => {});
    throw e;
  }
  res.json({ ok: true });
}));

/* ---------------- ADMIN ---------------- */
app.post('/api/admin/login', rl('adminlogin', 8, 10 * 60e3), h(async (req, res) => {
  if (!process.env.ADMIN_PASSWORD) throw new HttpError(500, 'সার্ভারে ADMIN_PASSWORD সেট করা নেই');
  const pw = str(req.body.password, 200);
  if (!pw || !safeEq(pw, process.env.ADMIN_PASSWORD)) throw new HttpError(401, 'ভুল পাসওয়ার্ড');
  res.json({ token: makeAdminToken() });
}));

const A = [adminAuth];

app.get('/api/admin/stats', A, h(async (req, res) => {
  await ensureSeed();
  const [u, o, d] = await Promise.all([db().ref('users').once('value'), db().ref('orders').once('value'), db().ref('deposits').once('value')]);
  const orders = Object.values(o.val() || {});
  const deps = Object.values(d.val() || {});
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const billable = orders.filter((x) => x.status !== 'Cancelled');
  const revenue = billable.reduce((s, x) => s + num(x.total) - num(x.refundAmount), 0);
  res.json({
    users: u.numChildren(),
    orders: orders.length,
    ordersToday: orders.filter((x) => x.ts >= day0.getTime()).length,
    pendingOrders: orders.filter((x) => x.status === 'Pending' || x.status === 'Processing' || x.status === 'In Progress').length,
    refillRequests: orders.filter((x) => x.refillRequest && x.refillRequest.status === 'requested').length,
    pendingDeposits: deps.filter((x) => x.status === 'pending').length,
    revenue: round2(revenue),
    deposited: round2(deps.filter((x) => x.status === 'approved').reduce((s, x) => s + num(x.amount), 0)),
    recent: orders.sort((a, b) => b.ts - a.ts).slice(0, 6)
  });
}));

/* ----- services ----- */
app.get('/api/admin/catalog', A, h(async (req, res) => { await ensureSeed(); res.json(await getCatalog(true)); }));

app.post('/api/admin/service', A, h(async (req, res) => {
  const b = req.body || {};
  const cat = slug(b.cat);
  if (!(await db().ref('categories/' + cat).once('value')).exists()) throw bad('ক্যাটাগরি সিলেক্ট করুন');
  const name = str(b.name, 300);
  if (!name) throw bad('সার্ভিসের নাম দিন');
  const type = b.type === 'fixed' ? 'fixed' : 'per1000';
  const rate = round2(num(b.rate, -1));
  if (rate < 0) throw bad('সঠিক রেট দিন');
  let min = Math.max(1, parseInt(b.min, 10) || 1), max = Math.max(1, parseInt(b.max, 10) || 1);
  if (type === 'fixed') { min = 1; max = 1; }
  if (max < min) throw bad('Max, Min এর চেয়ে ছোট হতে পারবে না');
  const id = slug(b.id) || ('s' + Date.now().toString(36));
  const old = (await db().ref('services/' + id).once('value')).val();
  const data = {
    id, cat, name, desc: str(b.desc, 4000), type, rate, min, max,
    speed: str(b.speed, 40) || 'Instant',
    refill: REFILLS.includes(String(b.refill)) ? String(b.refill) : 'none',
    badge: BADGES.includes(b.badge) ? b.badge : '',
    icon: cssIcon(b.icon, 'fas fa-star'),
    tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t) => str(t, 30)).filter(Boolean).slice(0, 6),
    stock: b.stock !== false, hidden: !!b.hidden,
    order: num(b.order, old ? old.order : 999)
  };
  await db().ref('services/' + id).set(data);
  res.json({ service: data });
}));

app.post('/api/admin/service/:id/toggle', A, h(async (req, res) => {
  const field = req.body.field === 'hidden' ? 'hidden' : 'stock';
  await db().ref('services/' + slug(req.params.id) + '/' + field).set(!!req.body.value);
  res.json({ ok: true });
}));

app.delete('/api/admin/service/:id', A, h(async (req, res) => {
  await db().ref('services/' + slug(req.params.id)).remove();
  res.json({ ok: true });
}));

/* ----- categories ----- */
app.post('/api/admin/category', A, h(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 40);
  if (!name) throw bad('ক্যাটাগরির নাম দিন');
  const id = slug(b.id) || slug(name) || ('c' + Date.now().toString(36));
  const old = (await db().ref('categories/' + id).once('value')).val();
  const data = {
    id, name, icon: cssIcon(b.icon, 'fas fa-globe'), color: hexColor(b.color, '#FF6B00'),
    linkPh: str(b.linkPh, 200) || 'https://...', linkHint: str(b.linkHint, 300),
    rules: (Array.isArray(b.rules) ? b.rules : String(b.rules || '').split('\n')).map((r) => str(r, 200)).filter(Boolean).slice(0, 12),
    hidden: !!b.hidden, order: num(b.order, old ? old.order : 99)
  };
  await db().ref('categories/' + id).set(data);
  res.json({ category: data });
}));

app.delete('/api/admin/category/:id', A, h(async (req, res) => {
  const id = slug(req.params.id);
  const sv = await db().ref('services').orderByChild('cat').equalTo(id).limitToFirst(1).once('value');
  if (sv.exists()) throw bad('এই ক্যাটাগরিতে সার্ভিস আছে। আগে সার্ভিসগুলো সরান বা অন্য ক্যাটাগরিতে নিন।');
  await db().ref('categories/' + id).remove();
  res.json({ ok: true });
}));

/* ----- orders ----- */
app.get('/api/admin/orders', A, h(async (req, res) => {
  const snap = await db().ref('orders').orderByKey().limitToLast(400).once('value');
  let list = Object.values(snap.val() || {}).sort((a, b) => b.ts - a.ts);
  const st = str(req.query.status, 20);
  if (st === 'Refill') list = list.filter((o) => o.refillRequest && o.refillRequest.status === 'requested');
  else if (STATUSES.includes(st)) list = list.filter((o) => o.status === st);
  const q = str(req.query.q, 80).toLowerCase();
  if (q) list = list.filter((o) => [o.id, o.no, o.userName, o.userEmail, o.link, o.service].join(' ').toLowerCase().includes(q));
  res.json({ orders: list });
}));

app.post('/api/admin/order/:id', A, h(async (req, res) => {
  const ref = db().ref('orders/' + slug(req.params.id));
  const o = (await ref.once('value')).val();
  if (!o) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
  const b = req.body || {};
  const status = STATUSES.includes(b.status) ? b.status : o.status;
  const upd = { status, startCount: str(b.startCount, 20), note: str(b.note, 300) };

  if (o.refunded && !['Cancelled', 'Partial'].includes(status))
    throw bad('এই অর্ডারে আগেই রিফান্ড হয়েছে, স্ট্যাটাস ফেরানো যাবে না');

  if ((status === 'Cancelled' || status === 'Partial') && !o.refunded) {
    const amt = status === 'Cancelled' ? num(o.total) : Math.min(num(o.total), Math.max(0, round2(num(b.refundAmount))));
    if (status === 'Partial' && amt <= 0) throw bad('Partial এর জন্য রিফান্ড অ্যামাউন্ট দিন');
    const lock = await ref.child('refunded').transaction((v) => (v ? undefined : true));
    if (lock.committed) {
      await creditUser(o.uid, amt);
      await addTxn(o.uid, { type: 'refund', amt, note: 'Refund — Order #' + o.no + (status === 'Partial' ? ' (Partial)' : ''), ref: o.id });
      upd.refundAmount = amt;
    }
  }
  if (b.refillDone && o.refillRequest) upd.refillRequest = { ...o.refillRequest, status: 'done', doneAt: Date.now() };
  await ref.update(upd);
  res.json({ ok: true });
}));

/* ----- deposits ----- */
app.get('/api/admin/deposits', A, h(async (req, res) => {
  const snap = await db().ref('deposits').orderByChild('ts').limitToLast(300).once('value');
  let list = Object.values(snap.val() || {}).sort((a, b) => b.ts - a.ts);
  const st = str(req.query.status, 20);
  if (['pending', 'approved', 'rejected'].includes(st)) list = list.filter((d) => d.status === st);
  res.json({ deposits: list });
}));

app.post('/api/admin/deposit/:id', A, h(async (req, res) => {
  const ref = db().ref('deposits/' + str(req.params.id, 40).replace(/[^A-Za-z0-9_-]/g, ''));
  const d = (await ref.once('value')).val();
  if (!d) throw new HttpError(404, 'ডিপোজিট পাওয়া যায়নি');
  const action = req.body.action === 'approve' ? 'approved' : req.body.action === 'reject' ? 'rejected' : null;
  if (!action) throw bad('অ্যাকশন ভুল');
  const lock = await ref.child('status').transaction((v) => (v === 'pending' ? action : undefined));
  if (!lock.committed) throw bad('এই ডিপোজিট আগেই প্রসেস করা হয়েছে');
  await ref.update({ note: str(req.body.note, 200), processedAt: Date.now() });
  if (action === 'approved') {
    const bonus = Math.max(0, round2(num(req.body.bonus)));
    const total = round2(num(d.amount) + bonus);
    await creditUser(d.uid, total);
    await addTxn(d.uid, { type: 'credit', amt: total, note: 'Add Money (' + d.method + ')' + (bonus ? ' + Bonus ৳' + bonus : ''), ref: d.id });
  } else {
    await db().ref('trxIndex/' + d.trxId).remove().catch(() => {});
  }
  res.json({ ok: true });
}));

/* ----- users ----- */
app.get('/api/admin/users', A, h(async (req, res) => {
  const snap = await db().ref('users').once('value');
  let list = Object.values(snap.val() || {}).sort((a, b) => num(b.createdAt) - num(a.createdAt));
  const q = str(req.query.q, 80).toLowerCase();
  if (q) list = list.filter((u) => [u.name, u.email, u.uid].join(' ').toLowerCase().includes(q));
  res.json({ users: list.slice(0, 300) });
}));

app.post('/api/admin/user/:uid/balance', A, h(async (req, res) => {
  const uid = str(req.params.uid, 128).replace(/[^A-Za-z0-9_-]/g, '');
  const amount = round2(num(req.body.amount));
  if (!(amount > 0)) throw bad('সঠিক অ্যামাউন্ট দিন');
  const u = (await db().ref('users/' + uid).once('value')).val();
  if (!u) throw new HttpError(404, 'ইউজার পাওয়া যায়নি');
  const sub = req.body.type === 'deduct';
  if (sub) {
    const r = await db().ref('users/' + uid + '/balance').transaction((b) => { b = num(b); if (b < amount) return; return round2(b - amount); });
    if (!r.committed) throw bad('ইউজারের ব্যালেন্স কম');
  } else {
    await creditUser(uid, amount);
  }
  await addTxn(uid, { type: sub ? 'debit' : 'credit', amt: amount, note: str(req.body.note, 100) || (sub ? 'Admin deduction' : 'Admin credit') });
  res.json({ ok: true });
}));

app.post('/api/admin/user/:uid/ban', A, h(async (req, res) => {
  const uid = str(req.params.uid, 128).replace(/[^A-Za-z0-9_-]/g, '');
  await db().ref('users/' + uid + '/banned').set(!!req.body.banned);
  res.json({ ok: true });
}));

/* ----- settings ----- */
app.get('/api/admin/settings', A, h(async (req, res) => { await ensureSeed(); res.json({ settings: await getSettings() }); }));

app.post('/api/admin/settings', A, h(async (req, res) => {
  const b = req.body || {};
  const pay = b.payments || {}, pg = b.pages || {};
  const covers = (Array.isArray(b.covers) ? b.covers : []).slice(0, 8).map((c) => ({
    title: str(c.title, 120), sub: str(c.sub, 160), icon: cssIcon(c.icon, 'fas fa-rocket'), src: str(c.src, 500)
  })).filter((c) => c.title || c.src);
  const data = {
    brand: str(b.brand, 40) || 'Service BD',
    whatsapp: str(b.whatsapp, 20).replace(/[^0-9]/g, ''),
    telegram: str(b.telegram, 60).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, ''),
    group: str(b.group, 300), youtube: str(b.youtube, 300), email: str(b.email, 120),
    notice: str(b.notice, 400),
    minDeposit: Math.max(1, num(b.minDeposit, 10)),
    maintenance: !!b.maintenance,
    payments: { bkash: str(pay.bkash, 20), nagad: str(pay.nagad, 20), rocket: str(pay.rocket, 20) },
    payNote: str(b.payNote, 400),
    covers: covers.length ? covers : DEFAULT_SETTINGS.covers,
    pages: { about: str(pg.about, 6000), terms: str(pg.terms, 6000), privacy: str(pg.privacy, 6000), refund: str(pg.refund, 6000) }
  };
  await db().ref('settings').set(data);
  res.json({ settings: data });
}));

/* ---------------- ERRORS ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line
  const status = err.status || 500;
  if (status >= 500) console.error('[server]', err && err.stack ? err.stack : err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'সার্ভারে সমস্যা হয়েছে' : err.message });
});

module.exports = app;

/* ---------------- LOCAL DEV ---------------- */
if (require.main === module) {
  const root = path.join(__dirname, '..');
  app.get('/admin', (req, res) => res.sendFile(path.join(root, 'admin.html')));
  app.use(express.static(root, { index: 'index.html', extensions: ['html'] }));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Running → http://localhost:' + port + '  (admin: /admin)'));
}
