import { SHEET_CSV_URL, FALLBACK_DATA_URL } from "./config.js";

const CARD_W = 168;
const CARD_H = 64;
const GAP_X = 28;
const GAP_Y = 110;
const PARTNER_GAP = 14;

/** @typedef {{
 *  id: string,
 *  display_name: string,
 *  nickname: string,
 *  birth_date: string,
 *  death_date: string,
 *  mother_id: string,
 *  father_id: string,
 *  partner_id: string,
 *  partner_status: string,
 *  notes: string,
 *  photo_url: string,
 *  bio: string,
 *  children: string[],
 *  gen: number,
 *  x: number,
 *  y: number,
 * }} Person */

function normalizeSheetUrl(url) {
  let u = url.trim();
  if (!u.includes("docs.google.com/spreadsheets")) return u;
  u = u.replace(/\/pubhtml\/?(\?.*)?$/, "/pub?output=csv");
  if (u.includes("/pub") && !u.includes("output=")) {
    u += u.includes("?") ? "&output=csv" : "?output=csv";
  }
  return u;
}

/** Cache-bust token that changes every 10 minutes (YYYYMMDDHHmm floored). */
function cacheBustToken(intervalMs = 10 * 60 * 1000) {
  const t = new Date(Math.floor(Date.now() / intervalMs) * intervalMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`
  );
}

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${cacheBustToken()}`;
}

async function loadPeople() {
  const sources = [];
  if (SHEET_CSV_URL.trim()) {
    const url = normalizeSheetUrl(SHEET_CSV_URL);
    sources.push({ url, label: "Google Sheet" });
  }
  sources.push({ url: FALLBACK_DATA_URL, label: "local file" });

  let lastError = null;
  for (const { url, label } of sources) {
    try {
      const res = await fetch(withCacheBust(url));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      if (text.trimStart().startsWith("<!") || text.includes("<html")) {
        throw new Error("Got HTML instead of CSV — check the publish URL");
      }
      console.info(`Loaded family data from ${label}`);
      return { people: parseSpreadsheet(text), source: { label, url } };
    } catch (err) {
      lastError = err;
      console.warn(`Could not load from ${label}:`, err);
    }
  }

  throw new Error(
    lastError?.message ||
      "Could not load family data. Set SHEET_CSV_URL in config.js or keep people.tsv.",
  );
}

function detectDelimiter(firstLine) {
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? "\t" : ",";
}

function parseRow(line, delimiter) {
  if (delimiter === "\t") return line.split("\t");

  const cols = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function parseSpreadsheet(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("Spreadsheet is empty");
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseRow(lines[0], delimiter).map((h) => h.trim());
  /** @type {Map<string, Person>} */
  const people = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i], delimiter);
    while (cols.length < headers.length) cols.push("");
    const row = Object.fromEntries(headers.map((h, j) => [h, (cols[j] ?? "").trim()]));
    if (!row.id) continue;
    people.set(row.id, {
      ...row,
      photo_url: row.photo_url ?? "",
      bio: row.bio ?? "",
      children: [],
      gen: 0,
      x: 0,
      y: 0,
    });
  }

  for (const p of people.values()) {
    for (const parentId of [p.mother_id, p.father_id]) {
      if (parentId && people.has(parentId)) {
        people.get(parentId).children.push(p.id);
      }
    }
  }

  assignGenerations(people);
  return people;
}

function parseTsv(text) {
  return parseSpreadsheet(text);
}

function assignGenerations(people) {
  /** Layout rows counted from the youngest generation back.
   *  height = generations of descendants below you (leaves = 0).
   *  Partners and siblings share height; parents sit strictly above;
   *  childless people are pulled up under their parents (not left on the leaf row). */
  const height = new Map();
  const memo = new Map();

  function heightOf(id, stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    const p = people.get(id);
    if (!p) return 0;
    stack.add(id);
    let h = 0;
    for (const cid of p.children) {
      h = Math.max(h, heightOf(cid, stack) + 1);
    }
    memo.set(id, h);
    stack.delete(id);
    return h;
  }

  for (const id of people.keys()) height.set(id, heightOf(id));

  function parentsOf(id) {
    const p = people.get(id);
    return [p.mother_id, p.father_id].filter((pid) => people.has(pid));
  }

  function siblingsOf(id) {
    const sibs = new Set();
    for (const pid of parentsOf(id)) {
      for (const cid of people.get(pid).children) sibs.add(cid);
    }
    sibs.delete(id);
    return sibs;
  }

  for (let i = 0; i < 40; i++) {
    let changed = false;

    // Partners share height
    for (const p of people.values()) {
      if (!p.partner_id || !people.has(p.partner_id)) continue;
      const shared = Math.max(height.get(p.id), height.get(p.partner_id));
      if (height.get(p.id) !== shared) {
        height.set(p.id, shared);
        changed = true;
      }
      if (height.get(p.partner_id) !== shared) {
        height.set(p.partner_id, shared);
        changed = true;
      }
    }

    // Siblings share height
    for (const p of people.values()) {
      const group = [p.id, ...siblingsOf(p.id)];
      if (group.length < 2) continue;
      const shared = Math.max(...group.map((id) => height.get(id)));
      for (const id of group) {
        if (height.get(id) !== shared) {
          height.set(id, shared);
          changed = true;
        }
      }
    }

    // Parents sit one (or more) above their tallest child
    for (const p of people.values()) {
      if (!p.children.length) continue;
      const need = Math.max(...p.children.map((cid) => height.get(cid))) + 1;
      if (height.get(p.id) < need) {
        height.set(p.id, need);
        changed = true;
      }
    }

    // Children sit just under their parents (lifts childless cousins/siblings
    // off the youngest row — e.g. Andrei/Ioana Stoica with Andrei/Irina)
    for (const p of people.values()) {
      const parents = parentsOf(p.id);
      if (!parents.length) continue;
      const under = Math.max(...parents.map((pid) => height.get(pid))) - 1;
      if (under >= 0 && height.get(p.id) < under) {
        height.set(p.id, under);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Contiguous rows from the top (drop empty height gaps)
  const used = [...new Set(height.values())].sort((a, b) => b - a);
  const rank = new Map(used.map((h, i) => [h, i]));
  for (const p of people.values()) {
    p.gen = rank.get(height.get(p.id)) ?? 0;
  }
}

function unionKey(a, b) {
  return [a, b].sort().join("|");
}

/**
 * Build layout units: a person alone, or a couple side-by-side.
 * @param {Map<string, Person>} people
 */
function buildUnits(people) {
  const placed = new Set();
  /** @type {{ids: string[], gen: number}[]} */
  const units = [];

  const byGen = new Map();
  for (const p of people.values()) {
    if (!byGen.has(p.gen)) byGen.set(p.gen, []);
    byGen.get(p.gen).push(p);
  }

  const gens = [...byGen.keys()].sort((a, b) => a - b);

  for (const g of gens) {
    const list = byGen.get(g);
    // Prefer couples who share children, then partners in same gen
    list.sort((a, b) => a.display_name.localeCompare(b.display_name, "ro"));

    for (const p of list) {
      if (placed.has(p.id)) continue;
      const partner = p.partner_id ? people.get(p.partner_id) : null;
      if (partner && partner.gen === p.gen && !placed.has(partner.id)) {
        // Order: typically mother left / keep alphabetical by id stability via birth
        const pair = [p, partner].sort((a, b) => {
          const ay = parseYear(a.birth_date) ?? 9999;
          const by = parseYear(b.birth_date) ?? 9999;
          if (ay !== by) return ay - by;
          return a.id.localeCompare(b.id);
        });
        units.push({ ids: pair.map((x) => x.id), gen: g });
        placed.add(pair[0].id);
        placed.add(pair[1].id);
      } else {
        units.push({ ids: [p.id], gen: g });
        placed.add(p.id);
      }
    }
  }

  return units;
}

function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function lifespan(p) {
  const b = p.birth_date || "?";
  if (p.death_date) return `${b} – ${p.death_date}`;
  if (p.birth_date) return b;
  return "";
}

/**
 * @param {Map<string, Person>} people
 * @param {{ids: string[], gen: number}[]} units
 */
function layout(people, units) {
  const unitsByGen = new Map();
  for (const u of units) {
    if (!unitsByGen.has(u.gen)) unitsByGen.set(u.gen, []);
    unitsByGen.get(u.gen).push(u);
  }

  // Rough topological order within generation: parents' midpoint proximity
  for (const [g, list] of unitsByGen) {
    list.sort((a, b) => scoreUnit(a, people) - scoreUnit(b, people));
    unitsByGen.set(g, list);
  }

  // First pass: pack left-to-right
  let maxRight = 0;
  for (const g of [...unitsByGen.keys()].sort((a, b) => a - b)) {
    let x = 0;
    const y = 40 + g * (CARD_H + GAP_Y);
    for (const unit of unitsByGen.get(g)) {
      const width = unitWidth(unit);
      placeUnit(unit, people, x, y);
      x += width + GAP_X;
    }
    maxRight = Math.max(maxRight, x);
  }

  // Second pass: pull children under parents (barycenter), a few iterations
  for (let iter = 0; iter < 8; iter++) {
    for (const g of [...unitsByGen.keys()].sort((a, b) => a - b)) {
      if (g === 0) continue;
      const list = unitsByGen.get(g);
      const targets = list.map((unit) => ({
        unit,
        target: parentMidX(unit, people),
        w: unitWidth(unit),
      }));

      targets.sort((a, b) => a.target - b.target);

      // Resolve overlaps left-to-right around targets
      let cursor = 0;
      const placed = [];
      for (const t of targets) {
        let x = Math.max(cursor, t.target - t.w / 2);
        placed.push({ unit: t.unit, x, w: t.w });
        cursor = x + t.w + GAP_X;
      }

      // Shift block to reduce drift from targets
      const drift =
        targets.reduce((s, t, i) => s + (t.target - (placed[i].x + t.w / 2)), 0) /
        targets.length;
      for (const p of placed) {
        p.x += drift;
      }

      // Re-pack if negative
      const minX = Math.min(...placed.map((p) => p.x));
      const shift = minX < 0 ? -minX : 0;
      const y = 40 + g * (CARD_H + GAP_Y);
      for (const p of placed) {
        placeUnit(p.unit, people, p.x + shift, y);
      }
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  for (const p of people.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + CARD_H);
  }

  // Normalize to origin padding
  const pad = 48;
  const dx = pad - minX;
  for (const p of people.values()) p.x += dx;

  return {
    width: maxX - minX + pad * 2,
    height: maxY + pad,
    maxGen: Math.max(...[...people.values()].map((p) => p.gen)),
  };
}

function unitWidth(unit) {
  if (unit.ids.length === 1) return CARD_W;
  return CARD_W * 2 + PARTNER_GAP;
}

function placeUnit(unit, people, x, y) {
  unit.ids.forEach((id, i) => {
    const p = people.get(id);
    p.x = x + i * (CARD_W + PARTNER_GAP);
    p.y = y;
  });
}

function scoreUnit(unit, people) {
  const xs = [];
  for (const id of unit.ids) {
    const p = people.get(id);
    for (const pid of [p.mother_id, p.father_id]) {
      if (pid && people.has(pid)) xs.push(people.get(pid).x + CARD_W / 2);
    }
  }
  if (!xs.length) return unit.ids[0].charCodeAt(0);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parentMidX(unit, people) {
  const xs = [];
  for (const id of unit.ids) {
    const p = people.get(id);
    for (const pid of [p.mother_id, p.father_id]) {
      if (pid && people.has(pid)) xs.push(people.get(pid).x + CARD_W / 2);
    }
  }
  if (!xs.length) return people.get(unit.ids[0]).x;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function shortName(name) {
  return name
    .replace(/^Dr\.\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function render(people, bounds) {
  const svg = document.getElementById("tree");
  const NS = "http://www.w3.org/2000/svg";

  const root = document.createElementNS(NS, "g");
  root.setAttribute("id", "viewport");

  const links = document.createElementNS(NS, "g");
  links.setAttribute("id", "links");
  const nodes = document.createElementNS(NS, "g");
  nodes.setAttribute("id", "nodes");

  // Partner links
  const drawnPartners = new Set();
  for (const p of people.values()) {
    if (!p.partner_id || !people.has(p.partner_id)) continue;
    const key = unionKey(p.id, p.partner_id);
    if (drawnPartners.has(key)) continue;
    drawnPartners.add(key);
    const q = people.get(p.partner_id);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "link link-partner");
    path.dataset.a = p.id;
    path.dataset.b = q.id;
    const y = p.y + CARD_H / 2;
    const x1 = Math.min(p.x, q.x) + CARD_W;
    const x2 = Math.max(p.x, q.x);
    path.setAttribute("d", `M ${x1} ${y} H ${x2}`);
    links.appendChild(path);
  }

  // Parent → child links
  for (const child of people.values()) {
    const parents = [child.mother_id, child.father_id]
      .filter((id) => id && people.has(id))
      .map((id) => people.get(id));
    if (!parents.length) continue;

    const childX = child.x + CARD_W / 2;
    const childY = child.y;
    const parentY = parents[0].y + CARD_H;
    const midY = parentY + (childY - parentY) / 2;

    let fromX;
    if (parents.length === 2) {
      fromX = (parents[0].x + CARD_W / 2 + parents[1].x + CARD_W / 2) / 2;
    } else {
      fromX = parents[0].x + CARD_W / 2;
    }

    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "link");
    path.dataset.child = child.id;
    path.dataset.parents = parents.map((p) => p.id).join(",");
    path.setAttribute(
      "d",
      `M ${fromX} ${parentY} V ${midY} H ${childX} V ${childY}`,
    );
    links.appendChild(path);
  }

  for (const p of people.values()) {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "person");
    g.dataset.id = p.id;
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", CARD_W);
    rect.setAttribute("height", CARD_H);
    rect.setAttribute("rx", 10);
    g.appendChild(rect);

    const name = document.createElementNS(NS, "text");
    name.setAttribute("class", "person-name");
    name.setAttribute("x", 12);
    name.setAttribute("y", 26);
    const label = shortName(p.display_name);
    name.textContent = label.length > 20 ? label.slice(0, 18) + "…" : label;
    g.appendChild(name);

    const meta = document.createElementNS(NS, "text");
    meta.setAttribute("class", "person-meta");
    meta.setAttribute("x", 12);
    meta.setAttribute("y", 46);
    const bits = [];
    if (p.nickname) bits.push(p.nickname);
    const life = lifespan(p);
    if (life) bits.push(life);
    meta.textContent = bits.join(" · ");
    g.appendChild(meta);

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPerson(p.id);
    });
    g.addEventListener("mouseenter", () => g.classList.add("is-hover"));
    g.addEventListener("mouseleave", () => g.classList.remove("is-hover"));

    nodes.appendChild(g);
  }

  svg.replaceChildren(root);
  root.append(links, nodes);

  return { root, bounds };
}

function pathIdsFor(focusId, people) {
  const ids = new Set([focusId]);
  const p = people.get(focusId);
  if (!p) return ids;

  // Ancestors
  const stack = [focusId];
  while (stack.length) {
    const id = stack.pop();
    const cur = people.get(id);
    for (const pid of [cur.mother_id, cur.father_id]) {
      if (pid && people.has(pid) && !ids.has(pid)) {
        ids.add(pid);
        stack.push(pid);
      }
    }
  }

  // Descendants
  const q = [focusId];
  while (q.length) {
    const id = q.shift();
    const cur = people.get(id);
    for (const cid of cur.children) {
      if (!ids.has(cid)) {
        ids.add(cid);
        q.push(cid);
      }
    }
  }

  // Include partners of people on the path
  for (const id of [...ids]) {
    const cur = people.get(id);
    if (cur.partner_id && people.has(cur.partner_id)) ids.add(cur.partner_id);
  }

  return ids;
}

function applyFocus(focusId, people) {
  const path = focusId ? pathIdsFor(focusId, people) : null;

  document.querySelectorAll(".person").forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle("is-focus", id === focusId);
    el.classList.toggle("is-path", Boolean(path && path.has(id)));
    el.classList.toggle("is-dim", Boolean(path && !path.has(id)));
  });

  document.querySelectorAll(".link").forEach((el) => {
    let onPath = false;
    if (path) {
      if (el.classList.contains("link-partner")) {
        onPath = path.has(el.dataset.a) && path.has(el.dataset.b);
      } else {
        const parents = (el.dataset.parents || "").split(",").filter(Boolean);
        onPath = path.has(el.dataset.child) && parents.some((pid) => path.has(pid));
      }
    }
    el.classList.toggle("is-path", Boolean(path && onPath));
    el.classList.toggle("is-dim", Boolean(path && !onPath));
  });
}

function showPanel(id, people) {
  const p = people.get(id);
  const panel = document.getElementById("panel");
  panel.hidden = false;

  document.getElementById("panel-name").textContent = p.display_name;
  const nick = document.getElementById("panel-nick");
  nick.textContent = p.nickname ? `„${p.nickname}”` : "";
  nick.hidden = !p.nickname;

  document.getElementById("panel-dates").textContent = lifespan(p) || "Dates unknown";

  const photo = document.getElementById("panel-photo");
  if (p.photo_url) {
    photo.alt = p.display_name;
    photo.hidden = false;
    photo.src = p.photo_url;
  } else {
    photo.hidden = true;
    photo.removeAttribute("src");
    photo.alt = "";
  }

  const bio = document.getElementById("panel-bio");
  bio.textContent = p.bio || "";
  bio.hidden = !p.bio;

  const meta = document.getElementById("panel-meta");
  meta.replaceChildren();

  const addRel = (label, ids) => {
    const list = ids.filter((x) => x && people.has(x));
    if (!list.length) return;
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    list.forEach((rid, i) => {
      if (i) dd.append(", ");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = people.get(rid).display_name;
      btn.addEventListener("click", () => selectPerson(rid));
      dd.append(btn);
    });
    wrap.append(dt, dd);
    meta.append(wrap);
  };

  addRel("Mother", [p.mother_id]);
  addRel("Father", [p.father_id]);
  addRel(
    p.partner_status === "separated" ? "Partner (separated)" : "Partner",
    [p.partner_id],
  );
  addRel("Children", p.children);

  const notes = document.getElementById("panel-notes");
  notes.textContent = p.notes || "";
  notes.hidden = !p.notes;
}

function hidePanel() {
  document.getElementById("panel").hidden = true;
}

/** @type {Map<string, Person>} */
let PEOPLE;
let focusId = null;
let selectPerson = () => {};

function setupCamera(root, bounds) {
  const stage = document.getElementById("stage");
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function apply() {
    root.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
  }

  function fit() {
    const rect = stage.getBoundingClientRect();
    const pad = 40;
    const sx = (rect.width - pad * 2) / bounds.width;
    const sy = (rect.height - pad * 2) / bounds.height;
    scale = Math.min(1.15, Math.max(0.35, Math.min(sx, sy)));
    tx = (rect.width - bounds.width * scale) / 2;
    ty = Math.max(24, (rect.height - bounds.height * scale) / 2);
    apply();
  }

  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".person")) return;
    dragging = true;
    stage.classList.add("dragging");
    lastX = e.clientX;
    lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  });

  stage.addEventListener("pointerup", () => {
    dragging = false;
    stage.classList.remove("dragging");
  });

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const beforeX = (mx - tx) / scale;
      const beforeY = (my - ty) / scale;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.min(2.5, Math.max(0.25, scale * delta));
      tx = mx - beforeX * scale;
      ty = my - beforeY * scale;
      apply();
    },
    { passive: false },
  );

  window.addEventListener("resize", fit);

  return { fit, apply };
}

function showDataSource(source) {
  const el = document.getElementById("data-source");
  if (!source) {
    el.hidden = true;
    return;
  }

  const shortUrl =
    source.url.length > 48 ? `${source.url.slice(0, 45)}…` : source.url;
  el.replaceChildren();

  const prefix = document.createElement("span");
  prefix.textContent = "Source: ";
  el.append(prefix);

  if (source.url.startsWith("http")) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.label;
    link.title = source.url;
    el.append(link);
  } else {
    const name = document.createElement("span");
    name.textContent = `${source.label} (${shortUrl})`;
    name.title = source.url;
    el.append(name);
  }

  el.hidden = false;
}

async function main() {
  const { people, source } = await loadPeople();
  PEOPLE = people;
  showDataSource(source);
  const units = buildUnits(PEOPLE);
  const bounds = layout(PEOPLE, units);
  const { root } = render(PEOPLE, bounds);
  const camera = setupCamera(root, bounds);
  camera.fit();

  const select = document.getElementById("focus-select");
  const sorted = [...PEOPLE.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "ro"),
  );
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "Everyone";
  select.append(optAll);
  for (const p of sorted) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.display_name;
    select.append(opt);
  }

  selectPerson = (id) => {
    focusId = id;
    select.value = id;
    applyFocus(id, PEOPLE);
    showPanel(id, PEOPLE);
  };

  select.addEventListener("change", () => {
    if (!select.value) {
      focusId = null;
      applyFocus(null, PEOPLE);
      hidePanel();
      return;
    }
    selectPerson(select.value);
  });

  document.getElementById("btn-fit").addEventListener("click", () => camera.fit());
  document.getElementById("btn-reset").addEventListener("click", () => {
    focusId = null;
    select.value = "";
    applyFocus(null, PEOPLE);
    hidePanel();
    camera.fit();
  });
  document.getElementById("panel-close").addEventListener("click", hidePanel);
  document.getElementById("stage").addEventListener("click", (e) => {
    if (e.target.closest(".person")) return;
    // keep panel if focused via select; only clear dimming? leave as is
  });

  const hint = document.getElementById("hint");
  setTimeout(() => hint.classList.add("fade"), 4000);

  // Nice default: focus the junction couple's child generation
  selectPerson("andrei-oghina");
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:2rem;color:#f2efe6;font:14px/1.4 system-ui">${err.message}</pre>`;
  console.error(err);
});
