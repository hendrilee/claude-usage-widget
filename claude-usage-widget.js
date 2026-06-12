// Claude Usage Widget for Scriptable (iOS) — v2 (polished)
// -----------------------------------------------------------------------
// Dark card UI with color-coded progress bars, pace markers, reset
// countdowns and projected-pace labels. Adapts to small/medium/large.
//
// SETUP
//   1. On a DESKTOP browser, log in to claude.ai, open dev tools:
//      Application/Storage -> Cookies -> https://claude.ai -> sessionKey
//      Copy the value (starts with sk-ant-sid01-...).
//   2. Run this script once inside the Scriptable app and paste the key.
//   3. Add a Scriptable widget to your home screen, pick this script.
//      Edit the widget and set "When Interacting -> Run Script" if you
//      want tapping it to refresh in-app.
//
// When the key expires, run in-app and choose "Reset session key".

const KEY_SESSION = "claude_session_key";
const KEY_ORG = "claude_org_id";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// ---- credential handling -------------------------------------------------

async function promptForSessionKey() {
  const a = new Alert();
  a.title = "Claude Session Key";
  a.message = "Paste your claude.ai sessionKey cookie (starts with sk-ant-sid01-).";
  a.addTextField("sk-ant-sid01-...");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  const idx = await a.present();
  if (idx === -1) return null;
  const key = a.textFieldValue(0).trim();
  if (!key) return null;
  Keychain.set(KEY_SESSION, key);
  if (Keychain.contains(KEY_ORG)) Keychain.remove(KEY_ORG);
  return key;
}

async function getSessionKey() {
  if (Keychain.contains(KEY_SESSION)) return Keychain.get(KEY_SESSION);
  return await promptForSessionKey();
}

function headers(sessionKey) {
  return {
    "Cookie": `sessionKey=${sessionKey}`,
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/605.1.15",
    "Accept": "application/json",
    "Referer": "https://claude.ai/",
    "Origin": "https://claude.ai",
  };
}

// ---- API calls -----------------------------------------------------------

async function jsonRequest(url, sessionKey) {
  const req = new Request(url);
  req.headers = headers(sessionKey);
  req.timeoutInterval = 20;
  const raw = await req.loadString();
  if (raw.trim().startsWith("<")) {
    throw new Error("Blocked (HTML, likely Cloudflare).");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Bad response: " + raw.slice(0, 100));
  }
}

async function getOrgId(sessionKey) {
  if (Keychain.contains(KEY_ORG)) return Keychain.get(KEY_ORG);
  const orgs = await jsonRequest("https://claude.ai/api/organizations", sessionKey);
  const list = Array.isArray(orgs) ? orgs : (orgs.organizations || []);
  if (!list.length) throw new Error("No organizations on this account.");
  const chosen = list.find((o) => (o.capabilities || []).includes("chat")) || list[0];
  const id = chosen.uuid || chosen.id;
  if (!id) throw new Error("Could not read org id.");
  Keychain.set(KEY_ORG, id);
  return id;
}

async function getUsage(sessionKey, orgId) {
  return await jsonRequest(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    sessionKey
  );
}

// ---- data helpers --------------------------------------------------------

function pct(node) {
  if (!node) return null;
  const v = node.utilization_pct ?? node.utilization ?? node.used_pct;
  return typeof v === "number" ? Math.round(v) : null;
}

function resetAtOf(node) {
  if (!node) return null;
  return node.reset_at ?? node.resets_at ?? node.reset_time ?? node.resetAt ?? null;
}

// ---- usage history (for sparkline) ----------------------------------------

const HISTORY_FILE = "claude_usage_history.json";

function historyPath() {
  const fm = FileManager.local();
  return [fm, fm.joinPath(fm.documentsDirectory(), HISTORY_FILE)];
}

function loadHistory() {
  const [fm, p] = historyPath();
  if (!fm.fileExists(p)) return [];
  try {
    const h = JSON.parse(fm.readString(p));
    return Array.isArray(h) ? h : [];
  } catch (e) {
    return [];
  }
}

function recordHistory(p5, p7) {
  let h = loadHistory();
  const now = Date.now();
  const last = h[h.length - 1];
  // avoid duplicate points when refreshes happen close together
  if (!last || now - last.t > 4 * 60 * 1000) {
    h.push({ t: now, p5, p7 });
  }
  const cutoff = now - 24 * 60 * 60 * 1000;
  h = h.filter((e) => e.t >= cutoff);
  if (h.length > 400) h = h.slice(h.length - 400);
  const [fm, p] = historyPath();
  try { fm.writeString(p, JSON.stringify(h)); } catch (e) {}
  return h;
}

function barColor(p) {
  if (p == null) return new Color("#6b7280");
  if (p >= 90) return new Color("#ef4444");
  if (p >= 70) return new Color("#f59e0b");
  if (p >= 40) return new Color("#eab308");
  return new Color("#22c55e");
}

function elapsedFraction(resetAt, windowMs) {
  if (!resetAt) return null;
  const t = new Date(resetAt).getTime();
  if (isNaN(t)) return null;
  const remaining = t - Date.now();
  const frac = 1 - remaining / windowMs;
  return Math.max(0, Math.min(1, frac));
}

function pace(p, elapsed) {
  if (p == null || elapsed == null || elapsed <= 0.02) {
    return { word: "", color: new Color("#6b7280") };
  }
  const projected = p / elapsed;
  if (projected < 50)  return { word: "comfortable", color: new Color("#22c55e") };
  if (projected < 75)  return { word: "on track",   color: new Color("#2dd4bf") };
  if (projected < 90)  return { word: "warming",    color: new Color("#eab308") };
  if (projected < 100) return { word: "pressing",   color: new Color("#f59e0b") };
  if (projected < 120) return { word: "critical",   color: new Color("#ef4444") };
  return { word: "runaway", color: new Color("#a855f7") };
}

function resetCountdown(isoStr) {
  if (!isoStr) return "";
  const t = new Date(isoStr).getTime();
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (mins < 60) return `resets ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `resets ${h}h ${mins % 60}m`;
  return `resets ${Math.floor(h / 24)}d ${h % 24}h`;
}

function nowLabel() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- drawing -------------------------------------------------------------

// iOS widgets are fixed-size per family, but the exact point width varies by
// device. Derive it from the screen so bars fill edge-to-edge anywhere.
function contentWidth(family) {
  const sw = Math.round(Device.screenSize().width);
  // [small, medium] widget point widths keyed by screen width
  const table = {
    320: [141, 292], // SE (1st gen)
    360: [155, 329], // 12/13 mini
    375: [153, 329], // X / XS / 11 Pro / SE 2-3
    390: [158, 338], // 12 / 13 / 14
    393: [158, 338], // 14 Pro / 15 / 15 Pro / 16
    402: [162, 348], // 16 Pro
    414: [169, 360], // 11 / XR / Plus (older)
    428: [170, 364], // 12-13 Pro Max / 14 Plus
    430: [170, 364], // 14 Pro Max / 15 Plus
    440: [172, 370], // 15 Pro Max / 16 Plus / 16 Pro Max
  };
  const keys = Object.keys(table).map(Number);
  const nearest = keys.reduce((a, b) => (Math.abs(b - sw) < Math.abs(a - sw) ? b : a), keys[0]);
  const [small, medium] = table[nearest];
  const full = family === "small" ? small : medium;
  return full - 30; // subtract the widget's 15pt horizontal padding x2
}

function drawBar(width, height, p, elapsedFrac, mono) {
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const r = height / 2;

  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), r, r);
  dc.addPath(track);
  // Lock screen renders in monochrome vibrancy: only luminance survives,
  // so mono mode uses translucent-white track + solid white fill.
  dc.setFillColor(mono ? new Color("#ffffff", 0.28) : new Color("#22252b"));
  dc.fillPath();

  const v = p == null ? 0 : p;
  if (v > 0) {
    const fw = Math.max(height, Math.min(width, width * (v / 100)));
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, fw, height), r, r);
    dc.addPath(fill);
    dc.setFillColor(mono ? Color.white() : barColor(v));
    dc.fillPath();
  }

  if (!mono && elapsedFrac != null) {
    const x = Math.max(1.5, Math.min(width - 2.5, width * elapsedFrac));
    dc.setFillColor(new Color("#ffffff", 0.9));
    dc.fillRect(new Rect(x - 1, -1, 2, height + 2));
  }
  return dc.getImage();
}

// ---- lock screen (accessory) layouts --------------------------------------
// Lock screen widgets are rendered by iOS in monochrome vibrancy tinted to
// the wallpaper — custom colors do not survive. Design purely by luminance.

function buildAccessory(usage, family, errorText) {
  const w = new ListWidget();
  // No background platter — float on the wallpaper like native lock screen
  // widgets (Fitness, Weather). iOS vibrancy keeps the text readable.
  w.addAccessoryWidgetBackground = false;
  w.setPadding(0, 0, 0, 0);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  const p5 = usage ? pct(usage.five_hour) : null;
  const p7 = usage ? pct(usage.seven_day) : null;

  if (family === "accessoryInline") {
    const t = w.addText(
      errorText ? "Claude: auth error" :
      `◆ ${p5 ?? "—"}% · wk ${p7 ?? "—"}%`
    );
    t.font = Font.mediumSystemFont(12);
    return w;
  }

  if (family === "accessoryCircular") {
    const v = w.addText(errorText ? "!" : `${p5 ?? "—"}`);
    v.font = Font.boldSystemFont(20);
    v.centerAlignText();
    v.lineLimit = 1;
    v.minimumScaleFactor = 0.5;
    const c = w.addText(errorText ? "auth" : "5H %");
    c.font = Font.systemFont(9);
    c.centerAlignText();
    return w;
  }

  // accessoryRectangular (~160 x 72 pt): two compact bar rows
  if (errorText) {
    const t = w.addText("Claude — auth error");
    t.font = Font.mediumSystemFont(12);
    t.lineLimit = 2;
    t.minimumScaleFactor = 0.7;
    return w;
  }

  const BAR_W = 150;
  const BAR_H = 5;

  function row(label, p) {
    const top = w.addStack();
    top.layoutHorizontally();
    top.centerAlignContent();
    const l = top.addText(label);
    l.font = Font.semiboldSystemFont(12);
    l.lineLimit = 1;
    top.addSpacer();
    const v = top.addText(p == null ? "—" : `${p}%`);
    v.font = Font.boldSystemFont(13);
    v.lineLimit = 1;
    w.addSpacer(3);
    const bar = w.addStack();
    bar.size = new Size(BAR_W, BAR_H);
    bar.cornerRadius = BAR_H / 2;
    bar.backgroundImage = drawBar(BAR_W, BAR_H, p, null, true);
  }

  row("Session", p5);
  w.addSpacer(7);
  row("Weekly", p7);
  return w;
}

// ---- widget UI (minimal) ---------------------------------------------------
// Design language: flat near-black field, light-weight numerals, hairline
// bars, micro uppercase labels, a single coral accent. Nothing decorative.

const PALETTE = {
  bg: "#0e0f11",
  text: "#f4f3f0",
  dim: "#8a8d93",
  micro: "#67696e",
  hair: "#232529",
  accent: "#d97757",
};

function minimalBar(width, p) {
  // 2pt hairline track, coral fill, square-ish ends for a drafted look
  const h = 2;
  const dc = new DrawContext();
  dc.size = new Size(width, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  dc.setFillColor(new Color(PALETTE.hair));
  dc.fillRect(new Rect(0, 0, width, h));
  const v = p == null ? 0 : Math.max(0, Math.min(100, p));
  if (v > 0) {
    dc.setFillColor(new Color(PALETTE.accent));
    dc.fillRect(new Rect(0, 0, Math.max(2, width * (v / 100)), h));
  }
  return dc.getImage();
}

function numeral(stack, p, size) {
  // big light number with a small trailing % on the baseline
  const row = stack.addStack();
  row.layoutHorizontally();
  row.bottomAlignContent();
  const n = row.addText(p == null ? "\u2014" : String(p));
  n.font = Font.lightSystemFont(size);
  n.textColor = new Color(p != null && p >= 90 ? PALETTE.accent : PALETTE.text);
  n.lineLimit = 1;
  n.minimumScaleFactor = 0.5;
  if (p != null) {
    row.addSpacer(2);
    const u = row.addText("%");
    u.font = Font.regularSystemFont(Math.round(size * 0.34));
    u.textColor = new Color(PALETTE.dim);
  }
}

function microLabel(stack, text) {
  const l = stack.addText(text.toUpperCase());
  l.font = Font.semiboldSystemFont(8);
  l.textColor = new Color(PALETTE.micro);
  l.lineLimit = 1;
}

function caption(stack, text) {
  const c = stack.addText(text);
  c.font = Font.regularSystemFont(8);
  c.textColor = new Color(PALETTE.micro);
  c.lineLimit = 1;
  c.minimumScaleFactor = 0.7;
}

function drawSparkline(width, height, series) {
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;

  // hairline baseline
  dc.setFillColor(new Color(PALETTE.hair));
  dc.fillRect(new Rect(0, height - 1, width, 1));

  if (series.length < 2) return dc.getImage();

  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const px = (t) => ((t - t0) / span) * (width - 2) + 1;
  const py = (v) => {
    const c = Math.max(0, Math.min(100, v == null ? 0 : v));
    return (1 - c / 100) * (height - 3) + 1;
  };

  // weekly: dim line underneath
  const wk = new Path();
  series.forEach((e, i) => {
    const pt = new Point(px(e.t), py(e.p7));
    i === 0 ? wk.move(pt) : wk.addLine(pt);
  });
  dc.addPath(wk);
  dc.setStrokeColor(new Color(PALETTE.micro, 0.7));
  dc.setLineWidth(1);
  dc.strokePath();

  // session: coral line on top (sawtooth across 5h resets)
  const ss = new Path();
  series.forEach((e, i) => {
    const pt = new Point(px(e.t), py(e.p5));
    i === 0 ? ss.move(pt) : ss.addLine(pt);
  });
  dc.addPath(ss);
  dc.setStrokeColor(new Color(PALETTE.accent));
  dc.setLineWidth(1.5);
  dc.strokePath();

  return dc.getImage();
}

function metricColumn(parent, width, label, p, resetAt, windowMs) {
  const col = parent.addStack();
  col.layoutVertically();
  col.size = new Size(width, 0);
  microLabel(col, label);
  col.addSpacer(7);
  numeral(col, p, 30);
  col.addSpacer(9);
  const bar = col.addStack();
  bar.size = new Size(width, 2);
  bar.backgroundImage = minimalBar(width, p);
  col.addSpacer(6);
  const elapsed = elapsedFraction(resetAt, windowMs);
  const pc = pace(p, elapsed);
  const parts = [resetCountdown(resetAt), pc.word].filter(Boolean);
  caption(col, parts.length ? parts.join(" \u00b7 ") : " ");
}

function buildWidget(usage, family, errorText) {
  const w = new ListWidget();
  w.backgroundColor = new Color(PALETTE.bg);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  if (errorText) {
    w.setPadding(16, 16, 16, 16);
    microLabel(w, "Claude");
    w.addSpacer();
    const e = w.addText(errorText);
    e.font = Font.regularSystemFont(11);
    e.textColor = new Color(PALETTE.accent);
    e.minimumScaleFactor = 0.7;
    w.addSpacer(4);
    caption(w, "open in app \u2192 reset session key");
    return w;
  }

  const five = usage.five_hour;
  const week = usage.seven_day;
  const opus = usage.seven_day_opus;
  const p5 = pct(five), p7 = pct(week), pO = pct(opus);
  const hist = usage.__history || [];

  if (family === "small") {
    // one hero metric: session
    w.setPadding(15, 15, 13, 15);
    microLabel(w, "Claude \u00b7 Session");
    w.addSpacer();
    numeral(w, p5, 44);
    w.addSpacer(10);
    const width = contentWidth("small");
    const bar = w.addStack();
    bar.size = new Size(width, 2);
    bar.backgroundImage = minimalBar(width, p5);
    w.addSpacer(7);
    const foot = w.addStack();
    foot.layoutHorizontally();
    caption(foot, resetCountdown(resetAtOf(five)));
    foot.addSpacer();
    caption(foot, p7 == null ? "" : `wk ${p7}%`);
    return w;
  }

  // medium / large: equal columns
  w.setPadding(17, 17, 15, 17);
  const cols = [["Session", p5, resetAtOf(five), FIVE_HOUR_MS],
                ["Weekly", p7, resetAtOf(week), SEVEN_DAY_MS]];
  if (opus) cols.push(["Opus", pO, resetAtOf(opus), SEVEN_DAY_MS]);

  const gap = 16;
  const total = contentWidth(family) + 30 - 34; // our padding is 17pt x2
  const colW = Math.floor((total - gap * (cols.length - 1)) / cols.length);

  const row = w.addStack();
  row.layoutHorizontally();
  row.topAlignContent();
  cols.forEach(([label, p, resetAt, windowMs], i) => {
    if (i > 0) row.addSpacer(gap);
    metricColumn(row, colW, label, p, resetAt, windowMs);
  });

  // ---- 24h trend ----
  w.addSpacer();
  const sparkW = total;
  const sparkH = family === "large" ? 56 : 26;
  const head2 = w.addStack();
  head2.layoutHorizontally();
  microLabel(head2, "Last 24h \u00b7 session");
  head2.addSpacer();
  caption(head2, "updated " + nowLabel());
  w.addSpacer(6);
  if (hist.length >= 2) {
    const sp = w.addStack();
    sp.size = new Size(sparkW, sparkH);
    sp.backgroundImage = drawSparkline(sparkW, sparkH, hist);
  } else {
    caption(w, "collecting history \u2014 trend appears after a few refreshes");
  }

  if (family === "large") {
    w.addSpacer();
    const extra = usage.extra_usage;
    if (extra && typeof extra.current_spending === "number") {
      const er = w.addStack();
      er.layoutHorizontally();
      microLabel(er, "Extra usage");
      er.addSpacer();
      const cap2 = typeof extra.budget_limit === "number" ? ` / $${extra.budget_limit}` : "";
      const e2 = er.addText(`$${extra.current_spending.toFixed(2)}${cap2}`);
      e2.font = Font.regularSystemFont(10);
      e2.textColor = new Color(PALETTE.dim);
    }
  }

  w.addSpacer();
  return w;
}


// ---- main ----------------------------------------------------------------

async function run() {
  const family = config.widgetFamily || "medium";
  let usage = null;
  let errorText = null;

  if (config.runsInApp) {
    const a = new Alert();
    a.title = "Claude Usage Widget";
    a.addAction("Refresh / Preview");
    a.addAction("Reset session key");
    a.addCancelAction("Cancel");
    const idx = await a.present();
    if (idx === 1) await promptForSessionKey();
  }

  try {
    const sessionKey = await getSessionKey();
    if (!sessionKey) throw new Error("No session key set. Run in app to add one.");
    const orgId = await getOrgId(sessionKey);
    usage = await getUsage(sessionKey, orgId);
    usage.__history = recordHistory(pct(usage.five_hour), pct(usage.seven_day));
  } catch (e) {
    errorText = String(e.message || e);
  }

  const isAccessory = family.startsWith("accessory");
  const widget = isAccessory
    ? buildAccessory(usage, family, errorText)
    : buildWidget(usage, family, errorText);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    if (family === "large") await widget.presentLarge();
    else if (family === "small") await widget.presentSmall();
    else await widget.presentMedium();
  }
  Script.complete();
}

await run();