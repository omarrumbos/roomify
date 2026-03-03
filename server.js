// server.js — Roomify (landing + room + scoring + stored sessions + recommendations + admin)
//
// Files used:
// - public/index.html
// - public/room.html
// - public/style.css
// - waitlist.csv
// - beta_sessions.jsonl
//
// ENV (optional but recommended):
// - PORT
// - ADMIN_TOKEN   (protects /admin endpoints)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Paths ----------
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const WAITLIST_CSV = path.join(ROOT, "waitlist.csv");
const SESSIONS_JSONL = path.join(ROOT, "beta_sessions.jsonl");

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true })); // form posts
app.use(express.json({ limit: "1mb" }));        // JSON posts

// Static LAST is fine, but we’ll also explicitly serve pages.
// (If you prefer, you can move this above routes—either works.)
app.use(express.static(PUBLIC_DIR));

// ---------- Helpers ----------
function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sha1(str) {
  return crypto.createHash("sha1").update(String(str)).digest("hex");
}

function ensureFileHeader(filePath, headerLine) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headerLine, "utf8");
  }
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line, "utf8");
}

// Minimal admin auth (token via query/header)
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    // If you haven't set ADMIN_TOKEN, allow access (useful in early dev).
    // For production: set ADMIN_TOKEN on Render to lock it.
    return next();
  }
  const provided =
    req.query.token ||
    req.get("x-admin-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (provided !== token) return res.status(401).send("Unauthorized");
  next();
}

// ---------- Scoring + Recommendations ----------
function scoreRoom(input) {
  // Expected inputs (numbers in feet):
  // length, width, height, listeningDistance, speakerDistanceFromWall
  // plus: windows ("yes"/"no"), surfaceType, currentTreatment, goal

  const length = safeNumber(input.length);
  const width = safeNumber(input.width);
  const height = safeNumber(input.height);
  const listeningDistance = safeNumber(input.listeningDistance);
  const speakerDistanceFromWall = safeNumber(input.speakerDistanceFromWall);

  // Basic validity score
  let validity = 100;
  if (!length || length <= 0) validity -= 25;
  if (!width || width <= 0) validity -= 25;
  if (!height || height <= 0) validity -= 15;
  if (!listeningDistance || listeningDistance <= 0) validity -= 15;
  if (speakerDistanceFromWall === null || speakerDistanceFromWall < 0) validity -= 20;
  validity = clamp(validity, 0, 100);

  // Simple “risk” heuristics (0 = low risk, 100 = high risk)
  let risk = 0;

  // Small rooms tend to have stronger modal issues
  if (length && width) {
    const area = length * width;
    if (area < 120) risk += 25;
    else if (area < 180) risk += 15;
    else risk += 5;
  } else {
    risk += 20;
  }

  // Very low speaker-to-wall distance increases boundary interference / bass buildup
  if (speakerDistanceFromWall !== null) {
    if (speakerDistanceFromWall < 1.0) risk += 25;
    else if (speakerDistanceFromWall < 2.0) risk += 15;
    else risk += 5;
  }

  // Hard surfaces + no treatment = more reflections
  const surface = String(input.surfaceType || "").toLowerCase();
  const treatment = String(input.currentTreatment || "").toLowerCase();

  const hardSurface =
    surface.includes("hard") ||
    surface.includes("tile") ||
    surface.includes("concrete") ||
    surface.includes("glass") ||
    surface.includes("wood");

  const noTreatment =
    treatment.includes("none") ||
    treatment.includes("no") ||
    treatment.includes("untreated") ||
    treatment.trim() === "";

  if (hardSurface) risk += 20;
  if (noTreatment) risk += 20;

  // Windows add reflections if present
  const windows = String(input.windows || "").toLowerCase();
  if (windows.includes("yes")) risk += 10;

  risk = clamp(risk, 0, 100);

  // Turn risk into score (higher score = better)
  const roomScore = clamp(100 - risk, 0, 100);

  // Optional “tone score” placeholder (v2 ready)
  // This can be replaced with your tone model later.
  const goal = String(input.goal || "").toLowerCase();
  let toneScore = 75;
  if (goal.includes("mix") || goal.includes("master")) toneScore = 80;
  if (goal.includes("listen") || goal.includes("hi-fi")) toneScore = 70;

  return {
    validity,
    roomScore,
    toneScore,
    risk,
  };
}

function buildRecommendations(input, scores) {
  const recs = [];

  const speakerDistanceFromWall = safeNumber(input.speakerDistanceFromWall, 0);
  const treatment = String(input.currentTreatment || "").toLowerCase();
  const noTreatment =
    treatment.includes("none") ||
    treatment.includes("no") ||
    treatment.includes("untreated") ||
    treatment.trim() === "";

  // Priority 1: placement
  if (speakerDistanceFromWall < 2) {
    recs.push({
      priority: 1,
      title: "Increase speaker distance from the front wall",
      why: "Reduces boundary bass buildup and improves low-end clarity.",
      action: "Try moving speakers forward in 6–12 inch steps until bass tightens.",
    });
  } else {
    recs.push({
      priority: 1,
      title: "Lock in triangle geometry",
      why: "Improves imaging and center focus.",
      action: "Aim for an equilateral triangle: speaker-to-speaker ≈ listening distance.",
    });
  }

  // Priority 2: early reflections
  if (noTreatment) {
    recs.push({
      priority: 2,
      title: "Treat first reflection points",
      why: "Cuts harshness and improves stereo imaging fast.",
      action: "Add panels at side reflection points + ceiling cloud if possible.",
    });
  } else {
    recs.push({
      priority: 2,
      title: "Verify your first reflection coverage",
      why: "Even treated rooms often miss key reflection zones.",
      action: "Do a quick mirror test on side walls and adjust panel placement.",
    });
  }

  // Priority 3: bass control
  if (scores.risk >= 60) {
    recs.push({
      priority: 3,
      title: "Add bass trapping",
      why: "High risk score suggests modal buildup and uneven bass response.",
      action: "Start with corner traps (front corners first), then rear corners.",
    });
  } else {
    recs.push({
      priority: 3,
      title: "Fine-tune low end with placement + light trapping",
      why: "You’re close—small changes will make the bass more consistent.",
      action: "Try small seat movements (6–12 inches) and add light corner treatment.",
    });
  }

  // Small optional note if windows exist
  const windows = String(input.windows || "").toLowerCase();
  if (windows.includes("yes")) {
    recs.push({
      priority: 4,
      title: "Control window reflections",
      why: "Glass reflections can brighten the room and smear imaging.",
      action: "Use thick curtains or movable absorption near the window area.",
    });
  }

  return recs;
}

// ---------- Pages ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Support both /room and /room.html (avoids “Not Found” surprises)
app.get("/room", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "room.html"));
});
app.get("/room.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "room.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "roomify", time: new Date().toISOString() });
});

// ---------- Waitlist ----------
app.post("/waitlist", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    ensureFileHeader(WAITLIST_CSV, "timestamp,email\n");
    appendLine(WAITLIST_CSV, `${new Date().toISOString()},${email}\n`);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Room -> Score + Recommendations + Session Storage ----------
app.post("/api/recommend", (req, res) => {
  try {
    const input = {
      // Accept either camelCase or form-like names
      length: req.body.length ?? req.body.lengthFt,
      width: req.body.width ?? req.body.widthFt,
      height: req.body.height ?? req.body.heightFt,
      listeningDistance: req.body.listeningDistance ?? req.body.listeningDistanceFt,
      speakerDistanceFromWall: req.body.speakerDistanceFromWall ?? req.body.speakerDistanceFromWallFt,
      windows: req.body.windows,
      surfaceType: req.body.surfaceType,
      currentTreatment: req.body.currentTreatment,
      goal: req.body.goal,
      // Optional “tone” input for v2
      tone: req.body.tone,
    };

    const scores = scoreRoom(input);
    const recommendations = buildRecommendations(input, scores);

    // Create session
    const sessionId = sha1(
      `${Date.now()}|${req.ip}|${req.get("user-agent") || ""}|${Math.random()}`
    ).slice(0, 12);

    const session = {
      id: sessionId,
      ts: new Date().toISOString(),
      ip: req.ip,
      ua: req.get("user-agent") || "",
      input,
      scores,
      recommendations,
    };

    appendLine(SESSIONS_JSONL, JSON.stringify(session) + "\n");

    return res.json({
      ok: true,
      sessionId,
      scores,
      recommendations,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Admin (sessions + waitlist download) ----------
app.get("/admin", requireAdmin, (req, res) => {
  res.type("text").send(
`Roomify Admin

Endpoints:
- /admin/sessions?limit=50
- /admin/waitlist (download csv)

Tip: set ADMIN_TOKEN on Render to lock these routes.`
  );
});

app.get("/admin/sessions", requireAdmin, (req, res) => {
  try {
    const limit = clamp(safeNumber(req.query.limit, 50), 1, 500);

    if (!fs.existsSync(SESSIONS_JSONL)) return res.json({ ok: true, sessions: [] });

    const lines = fs.readFileSync(SESSIONS_JSONL, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    const last = lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    res.json({ ok: true, sessions: last });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/admin/waitlist", requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(WAITLIST_CSV)) {
      return res.status(404).send("No waitlist.csv yet");
    }
    res.download(WAITLIST_CSV, "waitlist.csv");
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).send("Not Found");
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Roomify running on port ${PORT}`);
});