// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// Middleware
// --------------------
app.use(express.urlencoded({ extended: true })); // for HTML form posts
app.use(express.json()); // for fetch JSON
app.use(express.static(path.join(__dirname, "public"))); // serve /public

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/room", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

// --------------------
// Waitlist -> waitlist.csv
// --------------------
app.post("/waitlist", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    const filePath = path.join(__dirname, "waitlist.csv");

    // Create header if file doesn't exist
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "timestamp,email\n");
    }

    fs.appendFileSync(filePath, `${new Date().toISOString()},${email}\n`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("waitlist error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// --------------------
// Room Engine (V1)
// Formula-driven scores -> reflection score -> priority
// --------------------
function getStarterRecommendation(inputs) {
  // Normalize inputs
  const lengthFt = Number(inputs.lengthFt) || 0;
  const widthFt = Number(inputs.widthFt) || 0;
  const heightFt = Number(inputs.heightFt) || 0;

  const listeningDistanceFt = Number(inputs.listeningDistanceFt) || 0;
  const speakerDistanceFt = Number(inputs.speakerDistanceFt) || 0;

  const windows = String(inputs.windows || "").toLowerCase(); // "yes" / "no"
  const surface = String(inputs.surface || "").toLowerCase(); // "hard" / "mixed" / "soft"
  const treatment = String(inputs.treatment || "").toLowerCase(); // "none" / "partial" / "full"
  const goal = String(inputs.goal || "").toLowerCase(); // "mixing" etc.

  // Basic validation (keep it permissive for beta)
  const hasDims = lengthFt > 0 && widthFt > 0 && heightFt > 0;

  // Reflection score (0-5) — aligned with your sheet idea:
  // hard surface +2, windows yes +1, treatment none +2 (max 5)
  let reflectionScore = 0;
  if (surface === "hard") reflectionScore += 2;
  if (windows === "yes") reflectionScore += 1;
  if (treatment === "none") reflectionScore += 2;
  reflectionScore = Math.min(reflectionScore, 5);

  // Bass score (simple/placeholder, still physics-first)
  // Small rooms + short speaker distance => more risk
  let bassScore = 0;
  if (hasDims) {
    const volume = lengthFt * widthFt * heightFt; // ft^3
    if (volume > 0 && volume < 900) bassScore += 2;      // very small
    if (volume >= 900 && volume < 1400) bassScore += 1;  // small
  }
  if (speakerDistanceFt > 0 && speakerDistanceFt < 2) bassScore += 1;
  bassScore = Math.min(bassScore, 5);

  // Decide top priority from scores
  let topPriority = "Balanced — evaluate both";
  if (reflectionScore >= bassScore + 2) topPriority = "Early Reflection Control";
  else if (bassScore >= reflectionScore + 2) topPriority = "Focus on Bass Treatment";

  // Severity from max score (like your sheet)
  const maxScore = Math.max(reflectionScore, bassScore);
  let severity = "Low";
  if (maxScore >= 4) severity = "High";
  else if (maxScore >= 2) severity = "Medium";

  // Recommendation text (mentor tone, physics-first)
  let title = "Starter recommendation";
  let message =
    "Start with simple physics wins: placement symmetry, avoid corners, and control early reflections first.";

  if (topPriority === "Early Reflection Control") {
    title = "Early reflections are your main issue";
    message =
      "Install broadband panels at first reflection points before adding bass traps. Treat side walls and ceiling first. Prioritize symmetry and a stable stereo image for mixing.";
  } else if (topPriority === "Focus on Bass Treatment") {
    title = "Low-frequency buildup is your main issue";
    message =
      "Start with bass control: treat corners first and avoid placing speakers too close to the front wall. Then refine early reflections once low-end is steadier.";
  } else {
    title = "Balanced starting point";
    message =
      "You’re in a balanced zone. Start with first reflection points + basic bass control, then refine once you hear the change.";
  }

  const note = "Based on limited inputs. Upgrade later for full physics depth + diagrams.";

  return {
    ok: true,
    title,
    message,
    severity,
    topPriority,
    scores: {
      reflection: reflectionScore,
      bass: bassScore,
    },
    note,
    debug: {
      lengthFt,
      widthFt,
      heightFt,
      listeningDistanceFt,
      speakerDistanceFt,
      windows,
      surface,
      treatment,
      goal,
    },
  };
}

// --------------------
// API Route (JSON only)
// IMPORTANT: room.html must fetch this endpoint and parse JSON.
// --------------------
app.post("/api/recommend", (req, res) => {
  try {
    const inputs = req.body || {};
    const recommendation = getStarterRecommendation(inputs);

    // Log beta session
    const session = {
      ts: new Date().toISOString(),
      sessionId: crypto.randomUUID(),
      inputs,
      output: recommendation,
    };

    const filePath = path.join(__dirname, "beta_sessions.jsonl");
    fs.appendFileSync(filePath, JSON.stringify(session) + "\n");

    return res.json(recommendation);
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// --------------------
// ADMIN DASHBOARD (reads beta_sessions.jsonl)
// --------------------
const BETA_FILE = path.join(__dirname, "beta_sessions.jsonl");

function readSessions() {
  if (!fs.existsSync(BETA_FILE)) return [];
  const raw = fs.readFileSync(BETA_FILE, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function mode(arr) {
  const counts = {};
  arr.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
  let max = 0;
  let value = null;
  for (const k in counts) {
    if (counts[k] > max) {
      max = counts[k];
      value = k;
    }
  }
  return { value, count: max };
}

app.get("/admin", (req, res) => {
  const sessions = readSessions();

  const severities = sessions.map((s) => s.output?.severity).filter(Boolean);
  const priorities = sessions.map((s) => s.output?.topPriority).filter(Boolean);
  const reflectionScores = sessions
    .map((s) => s.output?.scores?.reflection)
    .filter((n) => typeof n === "number");
  const bassScores = sessions
    .map((s) => s.output?.scores?.bass)
    .filter((n) => typeof n === "number");

  const sevMode = mode(severities);
  const prioMode = mode(priorities);

  const html = `
  <html>
  <head>
    <title>Roomify Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Arial, sans-serif; background:#0f0f10; color:#eee; padding:24px; }
      h1 { margin:0 0 16px; }
      .card { background:#1b1b1e; padding:16px; border-radius:10px; margin-bottom:16px; border:1px solid #2a2a2f; }
      table { width:100%; border-collapse:collapse; margin-top:12px; }
      th, td { border:1px solid #2a2a2f; padding:8px; font-size:12px; }
      th { background:#18181b; text-align:left; }
      .muted { color:#aaa; font-size:12px; }
      a { color:#9ad; }
    </style>
  </head>
  <body>
    <h1>Roomify Admin Dashboard</h1>
    <div class="card">
      <div><strong>Total Sessions:</strong> ${sessions.length}</div>
      <div><strong>Most Common Severity:</strong> ${sevMode.value || "-"} (${sevMode.count || 0})</div>
      <div><strong>Most Common Priority:</strong> ${prioMode.value || "-"} (${prioMode.count || 0})</div>
      <div><strong>Avg Reflection Score:</strong> ${avg(reflectionScores).toFixed(2)}</div>
      <div><strong>Avg Bass Score:</strong> ${avg(bassScores).toFixed(2)}</div>
      <div class="muted" style="margin-top:10px;">Showing latest 25 sessions.</div>
    </div>

    <div class="card">
      <table>
        <tr>
          <th>Time</th>
          <th>Dims (ft)</th>
          <th>Severity</th>
          <th>Priority</th>
          <th>Reflection</th>
          <th>Bass</th>
        </tr>
        ${sessions
          .slice(-25)
          .reverse()
          .map(
            (s) => `
          <tr>
            <td>${new Date(s.ts).toLocaleString()}</td>
            <td>${s.inputs.lengthFt || "-"}×${s.inputs.widthFt || "-"}×${s.inputs.heightFt || "-"}</td>
            <td>${s.output?.severity || "-"}</td>
            <td>${s.output?.topPriority || "-"}</td>
            <td>${s.output?.scores?.reflection ?? "-"}</td>
            <td>${s.output?.scores?.bass ?? "-"}</td>
          </tr>`
          )
          .join("")}
      </table>
    </div>
  </body>
  </html>
  `;

  res.send(html);
});

// --------------------
// Start server
// --------------------
// =========================
// Admin Dashboard
// =========================
app.get("/admin", (req, res) => {
  try {
    const filePath = path.join(__dirname, "beta_sessions.jsonl");

    if (!fs.existsSync(filePath)) {
      return res.send("<h1>No sessions yet.</h1>");
    }

    const raw = fs.readFileSync(filePath, "utf-8");

    const sessions = raw
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const rows = sessions.reverse().map(s => {
      return `
        <tr>
          <td>${s.ts}</td>
          <td>${s.inputs.lengthFt}x${s.inputs.widthFt}x${s.inputs.heightFt}</td>
          <td>${s.inputs.goal}</td>
          <td>${s.output.severity}</td>
          <td>${s.output.topPriority}</td>
          <td>${s.output.scores.reflection}</td>
          <td>${s.output.scores.bass}</td>
        </tr>
      `;
    }).join("");

    res.send(`
      <html>
      <head>
        <title>Roomify Admin</title>
        <style>
          body { font-family: Arial; padding: 40px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; }
          th { background: #f3f4f6; text-align: left; }
        </style>
      </head>
      <body>
        <h1>Roomify Beta Sessions</h1>
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Room</th>
              <th>Goal</th>
              <th>Severity</th>
              <th>Top Priority</th>
              <th>Reflection</th>
              <th>Bass</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
      </html>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send("Admin error");
  }
});
app.listen(PORT, () => {
  console.log(`Roomify running at http://localhost:${PORT}`);
});