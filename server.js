/*
 * JPM-DBS shared storage server  (no npm packages needed - Node.js 14+ only)
 *
 * Run:   node server.js
 * Open:  http://<this-machine>:3000/        (serves JPM-DBS.html)
 *
 * Every user who opens that URL reads/writes the SAME plan, stored in
 * ./data/plan.json. Changes are applied as small operations on the latest
 * saved copy, so two people editing different feature lines at the same time
 * do not overwrite each other.
 *
 * Optional environment variables:  PORT (default 3000), DATA_DIR (default ./data)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "plan.json");
const HTML_FILE = path.join(__dirname, "JPM-DBS.html");

fs.mkdirSync(DATA_DIR, { recursive: true });

let doc = { initialized: false, version: 0, features: [], personas: [], components: [], updatedAt: null };

try {
  if (fs.existsSync(DATA_FILE)) {
    doc = Object.assign(doc, JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  }
} catch (e) {
  console.error("Could not read " + DATA_FILE + ":", e.message);
  process.exit(1);
}

function persist() {
  doc.updatedAt = new Date().toISOString();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic replace
  // rolling daily backup
  try {
    const day = doc.updatedAt.slice(0, 10);
    const bak = path.join(DATA_DIR, "plan-backup-" + day + ".json");
    fs.copyFileSync(DATA_FILE, bak);
  } catch (e) { /* backup is best effort */ }
}

function applyOp(op) {
  switch (op && op.type) {
    case "seed":
      if (!doc.initialized) {
        doc.features = Array.isArray(op.features) ? op.features : [];
        doc.personas = Array.isArray(op.personas) ? op.personas : [];
        doc.components = Array.isArray(op.components) ? op.components : [];
        doc.initialized = true;
      }
      break;
    case "upsertFeature": {
      if (!op.feature || !op.feature.id) break;
      const i = doc.features.findIndex(f => f.id === op.feature.id);
      if (i !== -1) doc.features[i] = op.feature; else doc.features.push(op.feature);
      break;
    }
    case "deleteFeature":
      doc.features = doc.features.filter(f => f.id !== op.id);
      break;
    case "addPersona":
      if (op.value && !doc.personas.includes(op.value)) doc.personas.push(op.value);
      break;
    case "addComponent":
      if (op.value && !doc.components.includes(op.value)) doc.components.push(op.value);
      break;
    case "replaceAll":
      doc.features = Array.isArray(op.features) ? op.features : [];
      doc.personas = Array.isArray(op.personas) ? op.personas : [];
      doc.components = Array.isArray(op.components) ? op.components : [];
      break;
  }
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > 20 * 1024 * 1024) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (p === "/" || p === "/JPM-DBS.html") {
    try { return send(res, 200, fs.readFileSync(HTML_FILE), "text/html; charset=utf-8"); }
    catch (e) { return send(res, 500, { error: "JPM-DBS.html not found next to server.js" }); }
  }

  if (p === "/api/plan" && req.method === "GET") {
    const since = parseInt(url.searchParams.get("since") || "-1", 10);
    if (doc.initialized && since === doc.version) return send(res, 200, { unchanged: true, version: doc.version });
    return send(res, 200, doc);
  }

  if (p === "/api/plan/ops" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const ops = Array.isArray(body.ops) ? body.ops : [];
      const before = doc.version;
      ops.forEach(applyOp);
      if (ops.length) { doc.version = before + 1; persist(); }
      return send(res, 200, doc);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("JPM-DBS running on http://localhost:" + PORT + "  (data: " + DATA_FILE + ")");
});
