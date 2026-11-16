import { createSign, randomBytes } from "node:crypto";

// Vercel এ fs দিয়ে index.html পড়া যাবে না। তাই seed বাদ দিলাম
const FIREBASE_PUBLIC_CONFIG = {
  apiKey: "AIzaSyCxFw8-qUbJ5i7BWwh46GL7Tf5JCl3M_cU",
  authDomain: "social-service-panel.firebaseapp.com",
  databaseURL: "https://social-service-panel-default-rtdb.firebaseio.com",
  projectId: "social-service-panel",
  storageBucket: "social-service-panel.firebasestorage.app",
  messagingSenderId: "1011326650302",
  appId: "1:1011326650302:web:451dd843a6ac7e3b251bef",
  measurementId: "G-L9029CR6SN"
};

const sessions = new Map(); // ⚠️ Vercel এ এটা প্রতিবার রিসেট হবে। Production এর জন্য Redis লাগবে
const loginAttempts = new Map();
let firebaseTokenCache = null;

function json(res, status, payload) {
  res.status(status).json(payload);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return [part.trim(), ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `smm_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `smm_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
}

function getSession(req) {
  const token = parseCookies(req)["smm_admin_session"];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { token,...session };
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Authentication required" });
    return null;
  }
  return session;
}

function base64url(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function signJwt(header, payload, privateKey) {
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64url(signer.sign(privateKey))}`;
}

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required");
  return JSON.parse(raw);
}

function getWebConfig() {
  return {...FIREBASE_PUBLIC_CONFIG };
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (firebaseTokenCache && firebaseTokenCache.expiresAt > now + 60) return firebaseTokenCache.accessToken;
  const account = serviceAccount();
  const assertion = signJwt({ alg: "RS256", typ: "JWT" },{ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, account.private_key);
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const payload = await response.json();
  if (!response.ok ||!payload.access_token) throw new Error(payload.error_description || "Could not get Firebase access token");
  firebaseTokenCache = { accessToken: payload.access_token, expiresAt: now + Number(payload.expires_in || 3600) };
  return payload.access_token;
}

async function getFirebaseCustomToken(uid = "smm-boost-pro-admin", email = "") {
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ alg: "RS256", typ: "JWT" },{ iss: account.client_email, sub: account.client_email, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 3600, uid, claims: { admin: true, role: "admin", email } }, account.private_key);
}

async function firebaseRequest(path, options = {}) {
  const config = getWebConfig();
  const safePath = path.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
  const url = `${config.databaseURL.replace(/\/$/, "")}/${safePath}.json`;
  const token = await getGoogleAccessToken();
  const response = await fetch(url, {...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",...(options.headers || {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `Firebase request failed with ${response.status}`);
  return payload;
}

async function firebaseAuthRequest(endpoint, payload) {
  const url = `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(FIREBASE_PUBLIC_CONFIG.apiKey)}`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data?.error?.message;
    const error = new Error(code === "EMAIL_NOT_FOUND" || code === "INVALID_PASSWORD"? "Invalid email or password" : code || "Firebase Authentication failed");
    error.code = code;
    throw error;
  }
  return data;
}

async function signInWithFirebase(email, password) {
  return firebaseAuthRequest("accounts:signInWithPassword", { email, password, returnSecureToken: true });
}

function collectionAsArray(value) {
  if (Array.isArray(value)) return value;
  return Object.entries(value || {}).map(([id, item]) => ({ id,...(item || {}) }));
}

function normalizeOrderIdentifier(value) {
  return String(value || "").trim().toLowerCase().replace(/^#/, "");
}

function orderIdentifiers(order) {
  return [order?.id, order?.orderId, order?.firebaseKey].filter(Boolean).map(normalizeOrderIdentifier);
}

function orderMatchesIdentifier(order, query, contains = false) {
  const normalizedQuery = normalizeOrderIdentifier(query);
  if (!normalizedQuery) return false;
  return [...orderIdentifiers(order), normalizeOrderIdentifier(order?.trxId), normalizeOrderIdentifier(order?.customerPhone) ].some((value) => value === normalizedQuery || value.replace(/^ex-/, "") === normalizedQuery.replace(/^ex-/, "") || (contains && value.includes(normalizedQuery)));
}

async function getCatalog() {
  try {
    const [categories, services, settings, announcements] = await Promise.all([ firebaseRequest("categories"), firebaseRequest("services"), firebaseRequest("siteSettings"), firebaseRequest("announcements") ]);
    return { categories: categories && Object.keys(categories).length? collectionAsArray(categories) : [], services: services && Object.keys(services).length? collectionAsArray(services) : [], settings: {...(settings || {}) }, announcements: announcements && Object.keys(announcements).length? collectionAsArray(announcements) : [] };
  } catch {
    return { categories: [], services: [], settings: {}, announcements: [] };
  }
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => { resolve(body? JSON.parse(body) : {}); });
  });
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function loginAllowed(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (record.resetAt < now) { record.count = 0; record.resetAt = now + 15 * 60 * 1000; }
  if (record.count >= 8) return false;
  record.count += 1;
  loginAttempts.set(ip, record);
  return true;
}

const ADMIN_DATA_ROOTS = new Set(["services", "categories", "orders", "announcements", "siteSettings"]);

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/server/catalog" && req.method === "GET") {
      return json(res, 200, await getCatalog());
    }

    if (url.pathname === "/api/server/orders" && req.method === "POST") {
      const order = await readBody(req);
      if (!order ||!order.id ||!order.serviceName ||!order.targetLink) { return json(res, 400, { error: "Order is missing required fields" }); }
      const amount = Number(order.amount?? order.priceBDT?? order.price?? order.total?? 0);
      const record = {...order, orderId: order.orderId || order.id, amount, price: Number(order.price?? amount), createdAt: Date.now(), updatedAt: Date.now(), status: order.status || "Pending Verification" };
      const result = await firebaseRequest("orders", { method: "POST", body: JSON.stringify(record) });
      return json(res, 201, { order: {...record, firebaseKey: result?.name || "" } });
    }

    if (url.pathname === "/api/server/orders/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!query) return json(res, 200, { orders: [] });
      const orders = collectionAsArray(await firebaseRequest("orders"));
      const matches = orders.filter((order) => orderMatchesIdentifier(order, query, true));
      return json(res, 200, { orders: matches.slice(0, 50) });
    }

    if (url.pathname === "/api/server/orders/track" && req.method === "GET") {
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!query) return json(res, 200, { order: null });
      const orders = collectionAsArray(await firebaseRequest("orders"));
      const order = orders.find((item) => orderMatchesIdentifier(item, query));
      return json(res, 200, { order: order || null });
    }

    const adminDataMatch = url.pathname.match(/^\/api\/admin\/data\/(.+)$/);
    if (adminDataMatch && ["GET", "PATCH", "PUT", "DELETE"].includes(req.method)) {
      if (!requireSession(req, res)) return;
      const dataPath = decodeURIComponent(adminDataMatch[1]).split("/").filter(Boolean);
      if (!dataPath.length ||!ADMIN_DATA_ROOTS.has(dataPath[0]) || dataPath.some((part) => part === "." || part === "..")) { return json(res, 400, { error: "Invalid admin data path" }); }
      const firebasePath = dataPath.join("/");
      const body = req.method === "GET" || req.method === "DELETE"? undefined : JSON.stringify(await readBody(req));
      const payload = await firebaseRequest(firebasePath, { method: req.method,...(body === undefined? {} : { body }) });
      return json(res, 200, { data: payload });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const session = getSession(req);
      return json(res, 200, { authenticated: Boolean(session), mustChange: false, email: session?.email || null });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      if (!loginAllowed(clientIp(req))) return json(res, 429, { error: "Too many attempts. Try again in a few minutes." });
      const body = await readBody(req);
      if (typeof body.email!== "string" || typeof body.password!== "string") { return json(res, 400, { error: "Email and password are required" }); }
      try {
        const firebaseUser = await signInWithFirebase(body.email.trim(), body.password);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + 8 * 60 * 60 * 1000, uid: firebaseUser.localId, email: firebaseUser.email || body.email.trim(), idToken: firebaseUser.idToken });
        setSessionCookie(res, token);
        return json(res, 200, { ok: true, mustChange: false, email: firebaseUser.email || body.email.trim() });
      } catch (error) { return json(res, 401, { error: error.message || "Invalid email or password" }); }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = parseCookies(req)["smm_admin_session"];
      if (token) sessions.delete(token);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/firebase-config") {
      return json(res, 200, getWebConfig());
    }

    if (req.method === "GET" && url.pathname === "/api/firebase-token") {
      const session = requireSession(req, res);
      if (!session) return;
      try { return json(res, 200, { token: await getFirebaseCustomToken(session.uid, session.email) }); }
      catch (error) { return json(res, 503, { error: error.message }); }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      const session = requireSession(req, res);
      if (!session) return;
      const body = await readBody(req);
      if (typeof body.currentPassword!== "string" || typeof body.newPassword!== "string" || body.newPassword.length < 6) { return json(res, 400, { error: "New password must be at least 6 characters." }); }
      try {
        const refreshedUser = await signInWithFirebase(session.email, body.currentPassword);
        await firebaseAuthRequest("accounts:update", { idToken: refreshedUser.idToken, password: body.newPassword, returnSecureToken: true });
        sessions.clear();
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 401, { error: error.message || "Could not update password" }); }
    }

    if (req.method === "GET" && url.pathname === "/api/firebase-health") {
      if (!requireSession(req, res)) return;
      try { const data = await firebaseRequest("siteSettings"); return json(res, 200, { ok: true, connected: true, hasSettings: Boolean(data) }); }
      catch (error) { return json(res, 503, { ok: false, connected: false, error: error.message }); }
    }

    return json(res, 404, { error: "API route not found" });

  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
           }
