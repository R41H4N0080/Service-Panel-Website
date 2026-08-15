const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

/*
 * Firebase project configuration
 * --------------------------------
 * Replace databaseURL with your Firebase Realtime Database URL.
 * Keep the service-account JSON out of this file. Vercel must provide it
 * through the FIREBASE_SERVICE_ACCOUNT_JSON environment variable.
 *
 * FIREBASE_DATABASE_URL is still supported as an optional Vercel override.
 */
const FIREBASE_CONFIG = Object.freeze({
  databaseURL: "https://payment-verify-c82a1-default-rtdb.firebaseio.com",
});

let firebaseConfig;
let accessTokenCache = { token: "", expiresAt: 0 };

function getFirebase() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL || FIREBASE_CONFIG.databaseURL;
  const hasPlaceholderDatabaseURL = !databaseURL || databaseURL.includes("YOUR_PROJECT_ID");
  if (!serviceAccountRaw || hasPlaceholderDatabaseURL) {
    const error = new Error("Firebase server configuration is missing.");
    error.statusCode = 503;
    error.code = "FIREBASE_NOT_CONFIGURED";
    throw error;
  }

  if (!firebaseConfig) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
    } catch {
      try {
        serviceAccount = JSON.parse(Buffer.from(serviceAccountRaw, "base64").toString("utf8"));
      } catch {
        const error = new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
        error.statusCode = 503;
        error.code = "FIREBASE_NOT_CONFIGURED";
        throw error;
      }
    }

    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      const error = new Error("Firebase service account is missing client_email or private_key.");
      error.statusCode = 503;
      error.code = "FIREBASE_NOT_CONFIGURED";
      throw error;
    }
    firebaseConfig = { serviceAccount, databaseURL: databaseURL.replace(/\/+$/, "") };
  }

  const ref = (databasePath = "") => ({
    async once() {
      const response = await firebaseRequest(databasePath, { method: "GET" });
      return { val: () => response, exists: () => response !== null && response !== undefined };
    },
    async set(value) {
      await firebaseRequest(databasePath, { method: "PUT", body: value });
    },
    async update(value) {
      await firebaseRequest(databasePath, { method: "PATCH", body: value });
    },
  });
  return { db: { ref } };
}

async function getFirebaseAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 60) return accessTokenCache.token;

  if (!firebaseConfig) getFirebase();
  const { serviceAccount } = firebaseConfig;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3_600,
  })).toString("base64url");
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key, "base64url");
  const assertion = `${unsigned}.${signature}`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenResponse.ok) {
    const error = new Error("Firebase service-account authentication failed.");
    error.statusCode = 503;
    error.code = "FIREBASE_AUTH_FAILED";
    throw error;
  }
  const payload = await tokenResponse.json();
  accessTokenCache = { token: payload.access_token, expiresAt: now + Number(payload.expires_in || 3600) };
  return accessTokenCache.token;
}

async function firebaseRequest(databasePath, options = {}) {
  if (!firebaseConfig) getFirebase();
  const token = await getFirebaseAccessToken();
  const encodedPath = String(databasePath)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${firebaseConfig.databaseURL}/${encodedPath}.json?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const error = new Error("Firebase Realtime Database request failed.");
    error.statusCode = 503;
    error.code = "FIREBASE_REQUEST_FAILED";
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error("[api]", error);
  }
  const publicMessage = error.code === "FIREBASE_NOT_CONFIGURED"
    ? "Firebase server configuration has not been connected yet."
    : error.code === "FIREBASE_AUTH_FAILED"
      ? "Firebase service-account authentication failed. Check the server credentials."
      : statusCode >= 500
        ? "The server could not complete this request."
        : error.message;
  sendJson(res, statusCode, {
    error: error.code || "REQUEST_FAILED",
    message: publicMessage,
  });
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error("Request body must be valid JSON.");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function requireText(value, field, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim().slice(0, maxLength);
}

function requireAdminEmail(value) {
  const email = requireText(value, "Email", 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("Enter a valid admin email.");
    error.statusCode = 400;
    throw error;
  }
  return email;
}

function extractConstFromHtml(name) {
  const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const marker = `const ${name} =`;
  const markerStart = html.indexOf(marker);
  if (markerStart < 0) return null;
  const start = html.indexOf("[", markerStart);
  if (start < 0) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        const source = html.slice(start, index + 1);
        return Function(`"use strict"; return (${source});`)();
      }
    }
  }
  return null;
}

function getSeedData() {
  return {
    categories: extractConstFromHtml("HARDCODED_CATEGORIES") || [],
    services: extractConstFromHtml("HARDCODED_SERVICES") || [],
    settings: {
      siteName: "SMM BOOST PRO Marketplace",
      siteTagline: "Instant Growth Marketplace",
      telegramSupport: "https://t.me/smmboost00",
      usdRate: 120,
      paymentMethods: {
        bkash: { name: "bKash", number: "" },
        nagad: { name: "Nagad", number: "" },
        rocket: { name: "Rocket", number: "" },
        binance: { name: "Binance Pay", number: "" },
      },
      announcement: "Welcome! Complete your order with secure payment verification.",
      averageDelivery: "—",
      satisfactionRate: "—",
    },
  };
}

async function getSiteData() {
  const { db } = getFirebase();
  const seed = getSeedData();
  const refs = {
    categories: db.ref("site/categories"),
    services: db.ref("site/services"),
    settings: db.ref("site/settings"),
  };
  const [categoriesSnap, servicesSnap, settingsSnap] = await Promise.all(
    Object.values(refs).map((ref) => ref.once("value")),
  );
  const values = {
    categories: categoriesSnap.val(),
    services: servicesSnap.val(),
    settings: settingsSnap.val(),
  };

  const writes = {};
  if (!Array.isArray(values.categories) || values.categories.length === 0) {
    values.categories = seed.categories;
    writes["site/categories"] = values.categories;
  }
  if (!Array.isArray(values.services) || values.services.length === 0) {
    values.services = seed.services;
    writes["site/services"] = values.services;
  }
  if (!values.settings || typeof values.settings !== "object") {
    values.settings = seed.settings;
    writes["site/settings"] = values.settings;
  } else {
    values.settings = { ...seed.settings, ...values.settings };
  }
  if (Object.keys(writes).length) await db.ref().update(writes);

  const ordersSnap = await db.ref("orders").once("value");
  const orders = Object.values(ordersSnap.val() || {});
  const completed = orders.filter((order) => order.status === "Completed").length;
  const uniqueCustomers = new Set(orders.map((order) => normalizePhone(order.customerPhone)).filter(Boolean)).size;
  return {
    ...values,
    stats: {
      totalOrders: orders.length,
      totalCustomers: uniqueCustomers,
      completedOrders: completed,
      activeOrders: orders.filter((order) => !["Completed", "Cancelled"].includes(order.status)).length,
    },
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string" || !storedHash.includes(":")) return false;
  const [salt, expected] = storedHash.split(":");
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || "development-only-session-secret";
}

function createSession(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 1000 * 60 * 60 * 12 })).toString("base64url");
  const signature = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  const entry = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : "";
}

function requireAdmin(req) {
  const token = getCookie(req, "admin_session");
  if (!token || !token.includes(".")) {
    const error = new Error("Admin login is required.");
    error.statusCode = 401;
    error.code = "ADMIN_UNAUTHORIZED";
    throw error;
  }
  const [payload, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    const error = new Error("Admin session is invalid.");
    error.statusCode = 401;
    error.code = "ADMIN_UNAUTHORIZED";
    throw error;
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.exp || data.exp < Date.now()) {
    const error = new Error("Admin session has expired.");
    error.statusCode = 401;
    error.code = "ADMIN_UNAUTHORIZED";
    throw error;
  }
  return data.email;
}

function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    serviceId: order.serviceId,
    serviceName: order.serviceName,
    quantity: order.quantity,
    priceBDT: order.priceBDT,
    paymentMethod: order.paymentMethod,
    trxId: order.trxId,
    targetLink: order.targetLink,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    targetCountry: order.targetCountry,
    selectedReactions: order.selectedReactions,
    customComments: order.customComments,
    status: order.status,
    progress: order.progress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function calculateOrderPrice(service, quantity) {
  const numericQuantity = Number(quantity);
  if (!Number.isInteger(numericQuantity) || numericQuantity < Number(service.minQuantity || 1) || numericQuantity > Number(service.maxQuantity || 10_000_000)) {
    const error = new Error("Quantity is outside this service's allowed range.");
    error.statusCode = 400;
    throw error;
  }
  const packageMatch = Array.isArray(service.packages)
    ? service.packages.find((item) => Number(item.quantity) === numericQuantity)
    : null;
  const price = packageMatch ? Number(packageMatch.price) : (numericQuantity / 1000) * Number(service.ratePer1k || 0);
  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error("This service is not currently available for ordering.");
    error.statusCode = 400;
    throw error;
  }
  return { quantity: numericQuantity, priceBDT: Math.round(price * 100) / 100 };
}

async function createOrder(body) {
  const { db } = getFirebase();
  const site = await getSiteData();
  const serviceId = requireText(body.serviceId, "Service", 120);
  const service = site.services.find((item) => item.id === serviceId);
  if (!service) {
    const error = new Error("Selected service was not found.");
    error.statusCode = 400;
    throw error;
  }
  const pricing = calculateOrderPrice(service, body.quantity);
  const targetLink = requireText(body.targetLink, "Target link", 1_000);
  const customerName = requireText(body.customerName, "Name", 120);
  const customerPhone = requireText(body.customerPhone, "Phone", 40);
  const trxId = requireText(body.trxId, "Transaction ID", 120).toUpperCase();
  const paymentMethod = requireText(body.paymentMethod, "Payment method", 40).toUpperCase();
  const allowedPayments = Object.keys(site.settings.paymentMethods || {}).map((key) => key.toUpperCase());
  if (!allowedPayments.includes(paymentMethod)) {
    const error = new Error("Selected payment method is not enabled.");
    error.statusCode = 400;
    throw error;
  }
  const paymentKey = paymentMethod.toLowerCase();
  if (!site.settings.paymentMethods?.[paymentKey]?.number) {
    const error = new Error("This payment method is not configured by the administrator yet.");
    error.statusCode = 503;
    error.code = "PAYMENT_NOT_CONFIGURED";
    throw error;
  }

  const id = `#SMM-${crypto.randomInt(100000, 999999)}`;
  const now = new Date().toISOString();
  const order = {
    id,
    serviceId,
    serviceName: service.name,
    quantity: pricing.quantity,
    priceBDT: pricing.priceBDT,
    paymentMethod,
    trxId,
    targetLink,
    customerName,
    customerPhone,
    targetCountry: requireText(body.targetCountry || "Bangladesh", "Target country", 100),
    selectedReactions: String(body.selectedReactions || "Standard Likes / Hearts").slice(0, 500),
    customComments: String(body.customComments || "").slice(0, 5_000),
    status: "Pending Verification",
    progress: 15,
    createdAt: now,
    updatedAt: now,
  };
  await db.ref(`orders/${encodeURIComponent(id)}`).set(order);
  return publicOrder(order);
}

async function findOrder(query) {
  const { db } = getFirebase();
  const snapshot = await db.ref("orders").once("value");
  const normalizedQuery = String(query || "").trim().toUpperCase();
  const orders = Object.values(snapshot.val() || {});
  return orders.find((order) =>
    String(order.id || "").toUpperCase() === normalizedQuery ||
    String(order.trxId || "").toUpperCase() === normalizedQuery ||
    normalizePhone(order.customerPhone) === normalizePhone(query),
  );
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "smm-boost-pro-api" });
    return;
  }
  if (url.pathname === "/api/bootstrap" && method === "GET") {
    sendJson(res, 200, await getSiteData());
    return;
  }
  if (url.pathname === "/api/orders" && method === "POST") {
    sendJson(res, 201, { order: await createOrder(await readBody(req)) });
    return;
  }
  if (url.pathname === "/api/orders/track" && method === "GET") {
    const order = await findOrder(url.searchParams.get("query"));
    sendJson(res, 200, { order: publicOrder(order) });
    return;
  }
  if (url.pathname === "/api/orders" && method === "GET") {
    const phone = normalizePhone(url.searchParams.get("phone"));
    if (!phone) {
      const error = new Error("A phone number is required.");
      error.statusCode = 400;
      throw error;
    }
    const { db } = getFirebase();
    const snapshot = await db.ref("orders").once("value");
    const orders = Object.values(snapshot.val() || {})
      .filter((order) => normalizePhone(order.customerPhone) === phone)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sendJson(res, 200, { orders: orders.map(publicOrder) });
    return;
  }
  if (url.pathname === "/api/admin/login" && method === "POST") {
    const body = await readBody(req);
    const email = requireAdminEmail(body.email);
    const password = requireText(body.password, "Password", 200);
    const { db } = getFirebase();
    const adminSnapshot = await db.ref("admin/auth").once("value");
    const stored = adminSnapshot.val();
    let valid = false;
    if (stored?.email && stored?.passwordHash) {
      valid = stored.email === email && verifyPassword(password, stored.passwordHash);
    } else {
      valid = email === String(process.env.ADMIN_INITIAL_EMAIL || "admin@gmail.com").toLowerCase() &&
        password === String(process.env.ADMIN_INITIAL_PASSWORD || "ChangeMe!12345");
      if (valid) {
        await db.ref("admin/auth").set({
          email,
          passwordHash: hashPassword(password),
          forcePasswordChange: true,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    if (!valid) {
      const error = new Error("Invalid admin email or password.");
      error.statusCode = 401;
      error.code = "ADMIN_INVALID_CREDENTIALS";
      throw error;
    }
    res.setHeader("Set-Cookie", `admin_session=${encodeURIComponent(createSession(email))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    sendJson(res, 200, { ok: true, email, forcePasswordChange: Boolean(stored?.forcePasswordChange ?? !stored) });
    return;
  }
  if (url.pathname === "/api/admin/logout" && method === "POST") {
    res.setHeader("Set-Cookie", "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    sendJson(res, 200, { ok: true });
    return;
  }

  const adminEmail = requireAdmin(req);
  if (url.pathname === "/api/admin/bootstrap" && method === "GET") {
    const site = await getSiteData();
    const { db } = getFirebase();
    const [ordersSnapshot, authSnapshot] = await Promise.all([
      db.ref("orders").once("value"),
      db.ref("admin/auth").once("value"),
    ]);
    const orders = Object.values(ordersSnapshot.val() || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sendJson(res, 200, {
      ...site,
      orders,
      admin: { email: authSnapshot.val()?.email || adminEmail, forcePasswordChange: Boolean(authSnapshot.val()?.forcePasswordChange) },
    });
    return;
  }
  if (url.pathname === "/api/admin/change-password" && method === "POST") {
    const body = await readBody(req);
    const currentPassword = requireText(body.currentPassword, "Current password", 200);
    const newPassword = requireText(body.newPassword, "New password", 200);
    if (newPassword.length < 10) {
      const error = new Error("New password must be at least 10 characters.");
      error.statusCode = 400;
      throw error;
    }
    const { db } = getFirebase();
    const snapshot = await db.ref("admin/auth").once("value");
    const stored = snapshot.val();
    if (!stored || stored.email !== adminEmail || !verifyPassword(currentPassword, stored.passwordHash)) {
      const error = new Error("Current password is incorrect.");
      error.statusCode = 401;
      throw error;
    }
    await db.ref("admin/auth").update({ passwordHash: hashPassword(newPassword), forcePasswordChange: false, updatedAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/admin/settings" && method === "PUT") {
    const body = await readBody(req);
    const { db } = getFirebase();
    const settings = {
      siteName: requireText(body.siteName, "Site name", 160),
      siteTagline: requireText(body.siteTagline || "Instant Growth Marketplace", "Site tagline", 160),
      telegramSupport: requireText(body.telegramSupport, "Telegram support URL", 300),
      announcement: requireText(body.announcement || "Welcome!", "Announcement", 500),
      usdRate: Number(body.usdRate) > 0 ? Number(body.usdRate) : 120,
      paymentMethods: {},
    };
    for (const key of ["bkash", "nagad", "rocket", "binance"]) {
      settings.paymentMethods[key] = {
        name: requireText(body.paymentMethods?.[key]?.name || key, `${key} name`, 60),
        number: requireText(body.paymentMethods?.[key]?.number, `${key} number`, 80),
      };
    }
    await db.ref("site/settings").set(settings);
    sendJson(res, 200, { settings });
    return;
  }
  if (url.pathname === "/api/admin/catalog" && method === "PUT") {
    const body = await readBody(req);
    if (!Array.isArray(body.categories) || !Array.isArray(body.services)) {
      const error = new Error("Categories and services must be arrays.");
      error.statusCode = 400;
      throw error;
    }
    const { db } = getFirebase();
    await db.ref().update({ "site/categories": body.categories, "site/services": body.services });
    sendJson(res, 200, { categories: body.categories, services: body.services });
    return;
  }
  const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/(.+)$/);
  if (orderMatch && method === "PATCH") {
    const orderId = decodeURIComponent(orderMatch[1]);
    const body = await readBody(req);
    const allowedStatuses = ["Pending Verification", "Processing", "In Progress", "Completed", "Cancelled", "Refunded", "On Hold"];
    const status = requireText(body.status, "Status", 60);
    if (!allowedStatuses.includes(status)) {
      const error = new Error("Invalid order status.");
      error.statusCode = 400;
      throw error;
    }
    const progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (!Number.isFinite(progress)) {
      const error = new Error("Progress must be a number from 0 to 100.");
      error.statusCode = 400;
      throw error;
    }
    const { db } = getFirebase();
    const ref = db.ref(`orders/${encodeURIComponent(orderId)}`);
    const snapshot = await ref.once("value");
    if (!snapshot.exists()) {
      const error = new Error("Order was not found.");
      error.statusCode = 404;
      throw error;
    }
    await ref.update({ status, progress, adminNote: String(body.adminNote || "").slice(0, 1_000), updatedAt: new Date().toISOString() });
    sendJson(res, 200, { order: (await ref.once("value")).val() });
    return;
  }
  const error = new Error("API route not found.");
  error.statusCode = 404;
  throw error;
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : (url.pathname === "/admin" ? "/admin.html" : url.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(process.cwd(), safePath);
  if (!filePath.startsWith(process.cwd()) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const extension = path.extname(filePath);
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.end(fs.readFileSync(filePath));
}

async function handler(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  setCors(req, res);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET") serveStatic(req, res, url);
    else sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "Method not allowed." });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = handler;

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  http.createServer(handler).listen(port, "0.0.0.0", () => {
    process.stdout.write(`SMM Boost Pro server listening on ${port}\n`);
  });
      }
