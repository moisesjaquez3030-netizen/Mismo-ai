import "dotenv/config";
import express from "express";
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import multer from "multer";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import { fal } from "@fal-ai/client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const db = new Database(process.env.DB_PATH || path.join(__dirname, "mismo.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 plan TEXT NOT NULL DEFAULT 'Free',
 stripe_customer_id TEXT,
 stripe_subscription_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS generations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 video_url TEXT
);
`);
// Upgrade databases created by earlier Mismo AI versions.
for (const [column, definition] of [["duration_seconds", "INTEGER"], ["resolution", "TEXT"]]) {
  try { db.exec(`ALTER TABLE generations ADD COLUMN ${column} ${definition}`); } catch {}
}
const getUser = db.prepare("SELECT id,email,plan,stripe_customer_id,stripe_subscription_id FROM users WHERE id=?");
const countRecent = db.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id=? AND created_at > ?");
const addGeneration = db.prepare("INSERT INTO generations(user_id,created_at,status) VALUES(?,?,'pending')");
const deleteGeneration = db.prepare("DELETE FROM generations WHERE id=?");
const finishGeneration = db.prepare("UPDATE generations SET status='complete', video_url=?, duration_seconds=?, resolution=? WHERE id=?");

if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SQLiteStore = SQLiteStoreFactory(session);

app.set("trust proxy", isProduction ? 1 : 0);
app.use(session({
 store: new SQLiteStore({ db: "sessions.sqlite", dir: __dirname }),
 name: "mismo.sid",
 secret: process.env.SESSION_SECRET || (isProduction ? (() => { throw new Error("Configura SESSION_SECRET en producción.") })() : "local-development-secret-change-me"),
 resave: false, saveUninitialized: false,
 cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

// Stripe webhooks need the raw request body, so this route comes before express.json().
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook not configured");
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook signature error: ${err.message}`); }
  try {
    if (event.type === "checkout.session.completed") {
      const checkout = event.data.object;
      const userId = Number(checkout.metadata?.userId);
      if (checkout.mode === "subscription" && userId && checkout.subscription) {
        const subscription = await stripe.subscriptions.retrieve(String(checkout.subscription));
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const tier = (priceId && priceId === process.env.STRIPE_ULTRA_PRICE_ID) || checkout.metadata?.plan === "Ultra" ? "Ultra" : "Pro";
        db.prepare("UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?")
          .run(tier, String(checkout.customer || ""), String(checkout.subscription), userId);
      }
    } else if (["customer.subscription.deleted", "customer.subscription.paused"].includes(event.type)) {
      const sub = event.data.object;
      db.prepare("UPDATE users SET plan='Free', stripe_subscription_id=NULL WHERE stripe_subscription_id=?")
        .run(String(sub.id));
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      if (["active", "trialing"].includes(sub.status)) {
        const priceId = sub.items?.data?.[0]?.price?.id;
        const tier = (priceId && priceId === process.env.STRIPE_ULTRA_PRICE_ID) || sub.metadata?.plan === "Ultra" ? "Ultra" : "Pro";
        db.prepare("UPDATE users SET plan=? WHERE stripe_subscription_id=?").run(tier, String(sub.id));
      } else {
        db.prepare("UPDATE users SET plan='Free' WHERE stripe_subscription_id=?").run(String(sub.id));
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handling failed", err);
    res.status(500).send("Webhook handling failed");
  }
});

app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
// Anti-abuse throttle, not a daily quota. Ultra has no daily generation cap.
app.use("/api/generate", rateLimit({
  windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false
}));

function safeUser(user) {
  if (!user) return null;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const used = countRecent.get(user.id, since).count;
  const limit = user.plan === "Ultra" ? null : user.plan === "Pro" ? 20 : 3;
  return { id: user.id, email: user.email, plan: user.plan, used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Inicia sesión para continuar." });
  const user = getUser.get(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: "La sesión ha caducado. Inicia sesión otra vez." }); }
  req.user = user; next();
}
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Solo se aceptan imágenes JPG, PNG o WEBP."), ok);
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, videoProviderConfigured: Boolean(process.env.FAL_KEY), billingConfigured: Boolean(stripe && (process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_PRICE_ID) && process.env.STRIPE_ULTRA_PRICE_ID) }));

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null, resetInHours: 24 });
  const user = getUser.get(req.session.userId);
  if (!user) return res.json({ user: null, resetInHours: 24 });
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const oldest = db.prepare("SELECT MIN(created_at) AS t FROM generations WHERE user_id=? AND created_at>?").get(user.id, since).t;
  const resetInHours = oldest ? Math.max(1, Math.ceil((oldest + 24 * 60 * 60 * 1000 - Date.now()) / 3600000)) : 24;
  res.json({ user: safeUser(user), resetInHours });
});

app.get("/api/history", requireAuth, (req, res) => {
  const items = db.prepare("SELECT id,created_at,video_url,duration_seconds,resolution FROM generations WHERE user_id=? AND status='complete' ORDER BY created_at DESC LIMIT 30").all(req.user.id);
  res.json({ items });
});

app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Introduce un correo válido." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "La contraseña debe tener entre 8 y 128 caracteres." });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "Ya existe una cuenta con ese correo. Inicia sesión." });
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)").run(email, hash, Date.now());
  req.session.userId = Number(result.lastInsertRowid);
  res.json({ user: safeUser(getUser.get(req.session.userId)) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Correo o contraseña incorrectos." });
  req.session.userId = user.id;
  res.json({ user: safeUser(getUser.get(user.id)) });
});
app.post("/api/auth/logout", (req, res) => req.session.destroy(err => {
  if (err) return res.status(500).json({ error: "No se pudo cerrar la sesión." });
  res.clearCookie("mismo.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
  res.json({ ok: true });
}));

app.post("/api/generate", requireAuth, upload.single("image"), async (req, res) => {
  let usageId;
  try {
    const user = getUser.get(req.user.id);
    const plan = user.plan;
    const isFree = plan === "Free";
    const isPro = plan === "Pro";
    const isUltra = plan === "Ultra";
    if (!process.env.FAL_KEY) return res.status(503).json({ error: "El motor de video no está configurado en el servidor." });
    if (!req.file) return res.status(400).json({ error: "Sube una imagen JPG, PNG o WEBP." });
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt || prompt.length > 2000) return res.status(400).json({ error: "Escribe una descripción de hasta 2.000 caracteres." });
    const duration = Number(req.body.duration_seconds || 4);
    if (isFree && duration !== 4) return res.status(403).json({ error: "El plan Free permite videos de 4 segundos." });
    if (isPro && (!Number.isInteger(duration) || duration < 4 || duration > 10)) return res.status(400).json({ error: "El plan Pro permite videos de 4 a 10 segundos." });
    if (isUltra && (!Number.isInteger(duration) || duration < 4 || duration > 15)) return res.status(400).json({ error: "El plan Ultra permite videos de 4 a 15 segundos." });
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const limit = isUltra ? Infinity : isPro ? 20 : 3;
    const used = countRecent.get(user.id, since).count;
    if (used >= limit) return res.status(429).json({ error: `Has alcanzado el límite de ${limit} videos de tu plan ${user.plan} en las últimas 24 horas.` });

    // Count the job before contacting the provider to prevent parallel requests bypassing the quota.
    const insert = addGeneration.run(user.id, Date.now());
    usageId = Number(insert.lastInsertRowid);
    const imageUrl = await fal.storage.upload(new Blob([req.file.buffer], { type: req.file.mimetype }));
    const ratio = ["16:9", "9:16", "1:1"].includes(req.body.aspect_ratio) ? req.body.aspect_ratio : "16:9";
    const resolution = isFree ? "720p" : "1080p";
    const camera = String(req.body.camera_motion || "auto");
    const strength = Math.max(1, Math.min(10, Number(req.body.motion_strength || 5)));
    const finalPrompt = `${prompt}\nCamera motion: ${camera}. Motion strength: ${strength}/10. Preserve subject identity, facial features and composition. Coherent natural movement.`;
    const result = await fal.subscribe("fal-ai/wan/v2.7/image-to-video", {
      input: { image_url: imageUrl, prompt: finalPrompt, aspect_ratio: ratio, resolution, duration: String(duration) },
      logs: false
    });
    const videoUrl = result?.data?.video?.url || result?.video?.url;
    if (!videoUrl) throw new Error("El proveedor no devolvió una URL de video.");
    finishGeneration.run(videoUrl, duration, resolution, usageId);
    res.json({ video_url: videoUrl, resolution, duration_seconds: duration, plan: user.plan });
  } catch (err) {
    if (usageId) deleteGeneration.run(usageId);
    console.error("Video generation failed:", err);
    res.status(500).json({ error: err.message?.includes("fal") ? "El proveedor de video no pudo completar la solicitud. Inténtalo de nuevo." : "No se pudo generar el video. Revisa la configuración del motor de IA." });
  }
});

app.post("/api/create-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Los pagos todavía no están configurados." });
    const plan = req.body.plan === "Ultra" ? "Ultra" : "Pro";
    const priceId = plan === "Ultra" ? process.env.STRIPE_ULTRA_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: `Configura el precio mensual de ${plan} en Stripe.` });
    const user = getUser.get(req.session.userId);
    if (user.plan === plan) return res.status(409).json({ error: `Tu cuenta ya tiene el plan ${plan}.` });
    if (user.plan !== "Free") return res.status(409).json({ error: "Cancela tu plan actual antes de cambiar de nivel. La gestión de cambios de plan se habilitará en el portal de facturación." });
    const origin = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      client_reference_id: String(user.id),
      metadata: { userId: String(user.id), plan },
      subscription_data: { metadata: { userId: String(user.id), plan } },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?subscription=success`,
      cancel_url: `${origin}/?subscription=cancelled`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout failed:", err);
    res.status(500).json({ error: "No se pudo iniciar el pago." });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "La imagen no puede superar 15 MB." });
  res.status(400).json({ error: err.message || "Solicitud inválida." });
});
app.listen(port, () => console.log(`Mismo AI listo en http://localhost:${port}`));
