// ==UserScript==
// @name         FASIH Koreksi Gaji + R.27 (gaji / 27.a / 27.b)
// @namespace    hanif-bps-hst
// @version      1.3
// @description  Baca Excel koreksi upah/gaji, buka tiap dokumen, ganti gaji = kolom "Gaji", 27.a (nilai_pendapatan) = R.27a dan 27.b (pendapatan_lain) = R.27b di kartu usaha yang tepat (nama usaha wajib cocok), lalu Kirim & Approve. Link salah/Forbidden: dicari lewat filter desa/SLS (BKU lalu keluarga). Yang gagal bisa dikerjakan manual lewat panel bantu.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Excel dibaca di browser ini saja; datanya tidak dikirim ke mana pun selain isian FASIH.
  const QUEUE_KEY = "kgj_queue";
  const CONF_KEY = "kgj_conf";
  const RUN_KEY = "kgj_run";
  const AREA_KEY = "kgj_area_titles";
  const LIST_KEY = "kgj_list_url"; // halaman daftar assignment terakhir yang dibuka (untuk cari lewat filter)
  const HELPER_KEY = "kgj_helper_hidden";
  const RATE_KEY = "fasih_rate_limit"; // sama dengan skrip FASIH lain: jeda 429 berlaku bersama

  // ===== KONFIGURASI =====
  // Satu-satunya bagian yang beda antara skrip Koreksi R.27 dan Koreksi Gaji; sisanya sama persis.
  const APP = {
    name: "Koreksi Gaji",
    version: "1.3",
    title: "Koreksi Upah / Gaji",
    badge: "Rp",
    launch: "Koreksi Gaji",
    hotkey: "6",
    launchBottom: 160,
    file: "koreksi-gaji",
  };
  // Isian yang diganti di kartu usaha:
  // [kunci, id isian FASIH, label, kolom Excel nilai lama, kolom Excel nilai baru, nama kolom baru di Excel, nama di CSV]
  // Kolom Excel ditulis tanpa spasi/titik/huruf besar ("R.27a" = "R27A").
  // Excel gaji punya dua kolom "gaji": yang lama di depan, yang baru ("Gaji") tepat sebelum R.27a.
  const FIELDS = [
    ["g", "gaji", "Gaji", ["GAJI", "UPAHGAJI"], ["GAJI", "UPAHGAJI"], "Gaji", "gaji"],
    ["a", "nilai_pendapatan", "27.a", ["NILAIPENDAPATAN"], ["R27A"], "R.27a", "27a"],
    ["b", "pendapatan_lain", "27.b", ["PENDAPATANLAIN", "PENDAPATANLAINNYA"], ["R27B"], "R.27b", "27b"],
  ];
  // Kartu juga boleh dikenali dari jumlah isian ini (nama usaha tetap wajib cocok). Kosong = tidak dipakai:
  // gaji ikut mengubah 27.a, jadi jumlahnya tidak bisa jadi patokan.
  const SUM_KEYS = [];
  // ===== akhir KONFIGURASI =====

  const DEFAULT_CONF = {
    speed: 1, // indeks SPEEDS
    checkFirst: true, // cek dulu di halaman Review: kalau sudah benar, tidak perlu revoke
    approve: true,
    forceOnGalat: false, // galat -> Submit Paksa (default: berhenti, perlu cek)
  };

  const SPEEDS = [
    { name: "Turbo", scale: 0.35, gap: [0, 200], poll: 60 },
    { name: "Kilat", scale: 0.5, gap: [300, 900], poll: 100 },
    { name: "Cepat", scale: 0.75, gap: [1000, 2500], poll: 150 },
    { name: "Normal", scale: 1, gap: [3000, 7000], poll: 250 },
  ];
  const T = () => SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, Number(loadConf().speed) || 0))];
  const W = (ms) => Math.max(100, Math.round(ms * (T().scale || 1)));

  const STATUS = {
    pending: { label: "Belum", color: "#6366f1" },
    done: { label: "Selesai", color: "#16a34a" },
    already: { label: "Sudah sesuai", color: "#0d9488" },
    tested: { label: "Terisi (uji)", color: "#0891b2" },
    yellow: { label: "Perlu cek", color: "#d97706" },
    red: { label: "Gagal", color: "#dc2626" },
    manual: { label: "Selesai manual", color: "#7c3aed" },
    forbidden: { label: "Forbidden", color: "#64748b" },
  };
  const FINISHED = ["done", "already", "manual"];

  const STATUS_HINT = {
    pending: "kembali ke antrean, dikerjakan otomatis lagi",
    done: "sudah dikoreksi, dikirim & approve",
    already: "nilai di FASIH memang sudah sesuai Excel",
    tested: "terisi tapi belum dikirim",
    yellow: "perlu dicek lagi",
    red: "tidak bisa dikerjakan",
    manual: "dikoreksi sendiri di FASIH",
    forbidden: "halaman Forbidden (akun tidak punya akses), dilewati",
  };

  // =========================================================================
  // UTILITAS
  // =========================================================================
  const loadJson = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (e) {
      return fallback;
    }
  };
  const saveJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error(`[${APP.name}] Gagal menyimpan.`, e);
    }
  };
  const loadQueue = () => loadJson(QUEUE_KEY, []);
  const saveQueue = (q) => saveJson(QUEUE_KEY, q);
  const loadConf = () => ({ ...DEFAULT_CONF, ...loadJson(CONF_KEY, {}) });
  const saveConf = (c) => saveJson(CONF_KEY, c);
  const loadRun = () => loadJson(RUN_KEY, { running: false });
  const saveRun = (r) => saveJson(RUN_KEY, r);

  function updateItem(id, changes) {
    const queue = loadQueue();
    const item = queue.find((q) => q.id === id);
    if (item) Object.assign(item, changes);
    saveQueue(queue);
    return item;
  }

  const rateInfo = () => loadJson(RATE_KEY, {});
  const rateLimited = () => Date.now() < (rateInfo().until || 0);
  function noteRateLimit(url) {
    const prev = rateInfo();
    if (Date.now() < (prev.until || 0)) return;
    const count = Date.now() - (prev.at || 0) < 2 * 3600000 ? (prev.count || 0) + 1 : 1;
    const minutes = Math.min(60, 15 * Math.pow(2, count - 1));
    saveJson(RATE_KEY, { at: Date.now(), until: Date.now() + minutes * 60000, count, url: String(url || "").slice(0, 200) });
    const cf = loadConf();
    cf.speed = Math.min(SPEEDS.length - 1, (Number(cf.speed) || 0) + 1);
    saveConf(cf);
    console.warn(`[${APP.name}] 429 dari server. Berhenti ${minutes} menit, kecepatan turun ke ${SPEEDS[cf.speed].name}.`);
  }
  (function watch429() {
    const origFetch = window.fetch;
    if (origFetch && !origFetch.__kgj) {
      const wrapped = function (input) {
        return origFetch.apply(this, arguments).then((res) => {
          if (res && res.status === 429) noteRateLimit(typeof input === "string" ? input : input && input.url);
          return res;
        });
      };
      wrapped.__kgj = true;
      window.fetch = wrapped;
    }
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && !XHR.__kgj) {
      const origOpen = XHR.open;
      const origSend = XHR.send;
      XHR.open = function (method, url) {
        this.__kgjUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.send = function () {
        this.addEventListener("loadend", () => {
          if (this.status === 429) noteRateLimit(this.__kgjUrl);
        });
        return origSend.apply(this, arguments);
      };
      XHR.__kgj = true;
    }
  })();

  let stopRequested = false;
  const onHold = () => !!loadRun().hold; // tombol Jeda
  // Hasil: lama tertahan (jeda / 429), supaya batas waktu tunggu tidak ikut termakan
  async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while ((rateLimited() || onHold()) && !stopRequested) {
      updateHud();
      await new Promise((r) => setTimeout(r, 1000));
    }
    return Date.now() - t0;
  }
  let forbiddenAt = 0;
  let forbiddenLast = false;
  function forbiddenPage() {
    if (Date.now() - forbiddenAt < 1000) return forbiddenLast;
    forbiddenAt = Date.now();
    if (!document.body || document.querySelector(".fasih-form-sidebar")) return (forbiddenLast = false);
    const text = Array.from(document.body.children)
      .filter((el) => !/^kgj-/.test(el.id || "") && !/^(SCRIPT|STYLE)$/.test(el.tagName))
      .map((el) => el.innerText || "")
      .join(" ");
    return (forbiddenLast = /\b403\b.{0,20}(forbidden|akses)|forbidden|akses ditolak|access denied|tidak (memiliki|punya) (hak )?akses/i.test(text));
  }
  const forbiddenError = () => Object.assign(new Error("halaman Forbidden (tidak ada akses)"), { forbidden: true });

  async function waitFor(check, timeoutMs) {
    let start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return null;
      if (forbiddenPage()) throw forbiddenError();
      const result = check();
      if (result) return result;
      start += await sleep(T().poll);
    }
    return null;
  }

  const OWN = "#kgj-panel, #kgj-hud, #kgj-launch";
  const normalize = (text) =>
    String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  const squash = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const visible = (el) =>
    !!el && (el.offsetParent !== null || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"));
  const rupiah = (n) => (n === null || n === undefined || n === "" ? "—" : `Rp ${Number(n).toLocaleString("id-ID")}`);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  function triggerClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    });
  }
  function pressKey(key) {
    const code = key === "Enter" ? 13 : 27;
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, keyCode: code, bubbles: true }),
    );
  }

  // Isi kotak teks seperti diketik sungguhan agar FASIH mencatatnya
  function setFieldValue(el, value) {
    value = String(value);
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    let typed = false;
    try {
      if (typeof el.select === "function") el.select();
      typed = value === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, value);
    } catch (e) {
      typed = false;
    }
    if (!typed || el.value.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function commitField(el) {
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent("blur"));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  // "Rp 5.700.000" / "5,700,000.00" / "5700000" -> 5700000 ; kosong -> null
  function parseNum(text) {
    let s = String(text ?? "").trim();
    if (!s) return null;
    // "400.000" = empat ratus ribu (titik ribuan), bukan 400 desimal
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return Math.round(Number(s)); // angka mentah dari Excel
    s = s.replace(/[.,]\d{1,2}$/, ""); // buang desimal ",00"
    const d = s.replace(/[^\d-]/g, "");
    return d === "" || d === "-" ? null : Number(d);
  }

  function levenshteinRatio(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }
  // Nama kartu vs nama Excel "KEBUN GETAH (SAIPUL RAHMAN)": dibanding utuh & bagian sebelum kurung
  function nameSim(card, excel) {
    const c = normalize(card);
    if (!c) return 0;
    const variants = [normalize(excel), normalize(String(excel || "").split("(")[0])].filter(Boolean);
    let best = 0;
    for (const v of variants) {
      const ct = new Set(c.split(" "));
      const vt = v.split(" ");
      const common = vt.filter((w) => ct.has(w)).length;
      const overlap = common / Math.max(1, Math.min(ct.size, vt.length));
      best = Math.max(best, levenshteinRatio(c, v), overlap * 0.95);
    }
    return best;
  }

  // Nama usaha di dokumen harus sesuai nama_usaha Excel (bukan cuma nilainya yang cocok).
  // Dibanding tanpa bagian (PEMILIK); nomor harus sama (SDN 1 ≠ SDN 2), jenjang sekolah harus sama
  // (SD ≠ SMP), dan kalau keduanya mencantumkan pemilik, pemiliknya harus sama ("SAIPUL" = "SAIPUL RAHMAN").
  const ABBR = [
    [/\bSDN\b/g, "SD NEGERI"],
    [/\bSMPN\b/g, "SMP NEGERI"],
    [/\bSMAN\b/g, "SMA NEGERI"],
    [/\bSMKN\b/g, "SMK NEGERI"],
    [/\bSEKOLAH DASAR\b/g, "SD"],
    [/\bSEKOLAH MENENGAH PERTAMA\b/g, "SMP"],
    [/\bSEKOLAH MENENGAH ATAS\b/g, "SMA"],
    [/\bSEKOLAH MENENGAH KEJURUAN\b/g, "SMK"],
    [/\bTAMAN KANAK KANAK\b/g, "TK"],
    [/\bMADRASAH IBTIDAIYAH\b/g, "MI"],
    [/\bNEGERI\b/g, "N"],
  ];
  const LEVELS = ["TK", "PAUD", "SD", "MI", "SMP", "MTS", "SMA", "MA", "SMK"];
  const baseName = (t) => {
    let s = normalize(String(t || "").replace(/\([^)]*\)/g, " "));
    for (const [re, to] of ABBR) s = s.replace(re, to);
    return s.replace(/\bN\b/g, "").replace(/\s+/g, " ").trim();
  };
  const digitsOf = (s) => (s.match(/\d+/g) || []).map(Number).join(",");
  const ownerOf = (t) => normalize((String(t || "").match(/\(([^)]+)\)/) || [])[1]);
  const levelOf = (s) => s.split(" ").find((w) => LEVELS.includes(w)) || "";
  function sameOwner(a, b) {
    if (levenshteinRatio(a, b) >= 0.8) return true;
    const [x, y] = a.length <= b.length ? [a, b] : [b, a];
    const yt = new Set(y.split(" "));
    return x.split(" ").every((w) => yt.has(w));
  }
  function nameMatch(doc, excel) {
    const c = baseName(doc) || normalize(doc);
    const e = baseName(excel) || normalize(excel);
    if (!c || !e) return 0;
    if (digitsOf(c) !== digitsOf(e)) return 0;
    const lc = levelOf(c);
    const le = levelOf(e);
    if (lc && le && lc !== le) return 0;
    const oc = ownerOf(doc);
    const oe = ownerOf(excel);
    if (oc && oe && !sameOwner(oc, oe)) return 0;
    const ct = new Set(c.split(" "));
    const et = e.split(" ");
    const common = et.filter((w) => ct.has(w)).length;
    const overlap = common / Math.max(1, Math.min(ct.size, et.length));
    return Math.max(levenshteinRatio(c, e), overlap * 0.95);
  }
  const NAME_OK = 0.6;

  // =========================================================================
  // MEMBACA EXCEL (.xlsx = zip berisi XML; tanpa pustaka luar)
  // =========================================================================
  async function openZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Bukan file .xlsx yang valid");
    const files = {};
    let ptr = view.getUint32(eocd + 16, true);
    for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
      const nameLen = view.getUint16(ptr + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      files[name] = {
        method: view.getUint16(ptr + 10, true),
        size: view.getUint32(ptr + 20, true),
        offset: view.getUint32(ptr + 42, true),
      };
      ptr += 46 + nameLen + view.getUint16(ptr + 30, true) + view.getUint16(ptr + 32, true);
    }
    return async (name) => {
      const f = files[name];
      if (!f) return null;
      const start = f.offset + 30 + view.getUint16(f.offset + 26, true) + view.getUint16(f.offset + 28, true);
      const data = bytes.subarray(start, start + f.size);
      if (f.method === 0) return new TextDecoder().decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    };
  }

  async function readXlsx(arrayBuffer) {
    const read = await openZip(arrayBuffer);
    const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
    const tags = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
    const sharedXml = await read("xl/sharedStrings.xml");
    const shared = sharedXml ? tags(xml(sharedXml), "si").map((si) => tags(si, "t").map((t) => t.textContent).join("")) : [];
    const rels = {};
    tags(xml(await read("xl/_rels/workbook.xml.rels")), "Relationship").forEach((r) => {
      rels[r.getAttribute("Id")] = r.getAttribute("Target");
    });
    const colIndex = (ref) =>
      ref
        .replace(/\d+/g, "")
        .split("")
        .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const sheets = [];
    for (const s of tags(xml(await read("xl/workbook.xml")), "sheet")) {
      const relId =
        s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || s.getAttribute("r:id");
      let target = rels[relId].replace(/^\//, "");
      if (!target.startsWith("xl/")) target = "xl/" + target;
      const rows = tags(xml(await read(target)), "row").map((row) => {
        const out = [];
        tags(row, "c").forEach((c) => {
          const type = c.getAttribute("t");
          const v = tags(c, "v")[0];
          let value = "";
          if (type === "inlineStr") value = tags(c, "t").map((t) => t.textContent).join("");
          else if (!v) value = "";
          else if (type === "s") value = shared[Number(v.textContent)];
          else value = v.textContent;
          out[colIndex(c.getAttribute("r"))] = String(value);
        });
        return Array.from(out, (x) => (x === undefined ? "" : x));
      });
      sheets.push({ name: s.getAttribute("name"), rows });
    }
    return sheets;
  }

  // Kolom dicocokkan tanpa spasi/titik/huruf besar: "R.27a" = "r27a" = "R 27 A".
  // Baris judul = baris yang memuat kolom R.27a. Kolom nilai (lama/baru) diambil dari FIELDS.
  const ANCHOR = "R27A";
  const COLS = {
    link: ["LINK", "URL", "LINKFASIH"],
    nama: ["NAMAUSAHA"],
    idsbr: ["IDSBR"],
    kec: ["KEC", "KECAMATAN", "NMKEC"],
    desa: ["DESA", "NMDESA"],
    sls: ["NMSLS", "SLS"],
    status: ["ASSIGNMENTSTATUSALIAS", "STATUS"],
    no: ["NO"],
  };

  async function parseWorkbook(arrayBuffer) {
    const sheets = await readXlsx(arrayBuffer);
    for (const sheet of sheets) {
      const hi = sheet.rows.findIndex((r) => r.some((h) => squash(h) === ANCHOR));
      if (hi < 0) continue;
      const headers = sheet.rows[hi].map(squash);
      const anchor = headers.indexOf(ANCHOR);
      const col = {};
      for (const [k, names] of Object.entries(COLS)) col[k] = headers.findIndex((h) => names.includes(h));
      const missing = col.link < 0 ? ["link"] : [];
      // Nilai baru = kolom yang paling dekat dengan R.27a; nilai lama = kolom bernama sama yang lain
      // (contoh Excel gaji: "gaji" lama di depan, "Gaji" baru tepat sebelum R.27a)
      for (const [k, , label, oldNames, newNames] of FIELDS) {
        const at = (names) => headers.map((h, i) => (names.includes(h) ? i : -1)).filter((i) => i >= 0);
        col[`new_${k}`] = at(newNames).sort((x, y) => Math.abs(x - anchor) - Math.abs(y - anchor))[0] ?? -1;
        col[`old_${k}`] = at(oldNames).find((i) => i !== col[`new_${k}`]) ?? -1;
        if (col[`old_${k}`] < 0) missing.push(`${label} lama (${oldNames[0]})`);
        if (col[`new_${k}`] < 0) missing.push(`${label} baru (${newNames[0]})`);
      }
      if (missing.length) throw new Error(`kolom tidak ada di sheet "${sheet.name}": ${missing.join(", ")}`);
      const byDoc = new Map();
      let skipped = 0;
      sheet.rows.slice(hi + 1).forEach((r, i) => {
        const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
        const rawLink = get("link");
        const url = (rawLink.match(/https?:\/\/[^"'\s<>]+/) || [""])[0];
        const ids = (url || rawLink).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        if (!ids.length) {
          if (r.some((x) => String(x).trim())) skipped++;
          return;
        }
        const id = ids[ids.length - 1].toLowerCase();
        const target = {
          row: hi + i + 2,
          no: get("no"),
          nama: get("nama"),
          idsbr: get("idsbr"),
          old: Object.fromEntries(FIELDS.map(([k]) => [k, parseNum(get(`old_${k}`)) || 0])),
          neu: Object.fromEntries(FIELDS.map(([k]) => [k, parseNum(get(`new_${k}`)) || 0])),
        };
        if (!byDoc.has(id))
          byDoc.set(id, {
            id,
            url: url || "",
            prefix: ids.length > 1 ? ids[ids.length - 2].toLowerCase() : "",
            kec: get("kec"),
            desa: get("desa"),
            sls: get("sls"),
            statusAwal: get("status"),
            targets: [],
            status: "pending",
            reason: "",
          });
        byDoc.get(id).targets.push(target);
      });
      return { items: Array.from(byDoc.values()), sheet: sheet.name, rows: sheet.rows.slice(hi + 1).filter((r) => r.some((x) => String(x).trim())).length, skipped };
    }
    throw new Error('tidak ada sheet dengan kolom "R.27a"');
  }

  // =========================================================================
  // FORM ASSIGNMENT
  // =========================================================================
  const box = (id, inst) => document.getElementById(inst === undefined ? id : `${id}#${inst}`);
  async function waitBox(id, inst, ms) {
    return waitFor(() => {
      const b = box(id, inst);
      return visible(b) ? b : null;
    }, ms);
  }
  const fresh = (el) => (el && el.id && document.getElementById(el.id)) || el;
  const readBox = (container) => {
    const input = container && container.querySelector("input:not([type=radio]):not([type=checkbox]), textarea");
    return input ? parseNum(input.value) : null;
  };

  function buttonByText(text) {
    return Array.from(document.querySelectorAll("button")).find(
      (b) => visible(b) && !b.disabled && b.innerText.trim().toUpperCase() === text.toUpperCase() && !b.closest(OWN),
    );
  }
  function buttonByIcon(icon) {
    const svg = Array.from(document.querySelectorAll(`svg.tabler-icon-${icon}`)).find(
      (s) => s.closest("button") && visible(s.closest("button")) && !s.closest(OWN),
    );
    return svg ? svg.closest("button") : null;
  }

  // ---------- Navigasi sidebar ----------
  const sidebarItems = () => Array.from(document.querySelectorAll(".fasih-form-sidebar > div[title], .fasih-form-sidebar [title]"));
  function sidebarItem(title) {
    const want = squash(title);
    const items = sidebarItems();
    return (
      items.find((el) => squash(el.getAttribute("title")) === want) ||
      items.find((el) => squash(el.getAttribute("title")).startsWith(want)) ||
      null
    );
  }
  async function goSection(title, readyCheck, force) {
    if (!force && readyCheck()) return true;
    const item = await waitFor(() => sidebarItem(title), 30000);
    if (!item) throw new Error(`menu "${title}" tidak ada di sidebar`);
    triggerClick(item);
    if (!(await waitFor(readyCheck, 20000))) throw new Error(`halaman "${title}" tidak terbuka`);
    await sleep(W(700));
    return true;
  }

  const onCardList = () => visible(box("se2026_nested")) && !document.querySelector('[id^="keberadaan_usaha#"]');
  const visiblePend = () =>
    Array.from(document.querySelectorAll('[id^="nilai_pendapatan#"], #nilai_pendapatan')).find(visible) || null;
  const instOf = (el) => (el.id.includes("#") ? el.id.split("#")[1] : undefined);

  function usahaCards() {
    const list = box("se2026_nested");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-nested-view]")).map((card) => {
      const span = card.querySelector("span");
      return { card, name: (span ? span.innerText : card.innerText).trim().toUpperCase() };
    });
  }

  // Cari halaman yang memuat kartu usaha (Blok II keluarga) atau langsung isian 27.a (form usaha tunggal).
  // Judul halaman yang berhasil diingat supaya dokumen berikutnya langsung ke sana.
  async function gotoArea() {
    if (!(await waitFor(() => sidebarItems().length, 30000))) throw new Error("sidebar form belum termuat");
    const state = () => (onCardList() ? "cards" : visiblePend() ? "direct" : null);
    const titles = Array.from(new Set(sidebarItems().map((el) => el.getAttribute("title")).filter(Boolean)));
    const known = loadJson(AREA_KEY, []).filter((t) => titles.includes(t));
    const blok2 = titles.filter((t) => /BLOK\s*(II|2)(?![I\d])/i.test(t));
    const order = Array.from(new Set([...known, ...blok2, ...titles]));
    for (const title of order) {
      const el = sidebarItem(title);
      if (!el) continue;
      triggerClick(el);
      const likely = known.includes(title) || blok2.includes(title);
      if (await waitFor(state, likely ? 7000 : 1500)) {
        await sleep(W(600));
        const kind = state();
        if (!kind) continue;
        saveJson(AREA_KEY, [title, ...known.filter((t) => t !== title)].slice(0, 6));
        return { kind, title };
      }
    }
    throw new Error("halaman kartu usaha / isian 27.a tidak ditemukan di sidebar");
  }

  async function openCard(card) {
    triggerClick(card.card);
    const el = await waitFor(() => {
      const kb = document.querySelector('[id^="keberadaan_usaha#"]');
      if (visible(kb)) return kb;
      return visiblePend();
    }, 20000);
    if (!el) throw new Error(`kartu usaha "${card.name}" tidak terbuka`);
    await sleep(W(700));
    return instOf(el);
  }

  async function writeNum(id, inst, n) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = box(id, inst);
      if (!c) throw new Error(`isian ${id} tidak ada`);
      if (readBox(c) === n) return;
      const input = c.querySelector("input:not([type=radio]):not([type=checkbox]):not([disabled])");
      if (!input) throw new Error(`isian ${id} terkunci`);
      setFieldValue(input, String(n));
      commitField(input);
      await sleep(W(500));
    }
    const now = readBox(box(id, inst));
    if (now !== n) throw new Error(`isian ${id} tidak mau berubah (sekarang ${rupiah(now)}, seharusnya ${rupiah(n)})`);
  }

  const norm0 = (v) => (v === null || v === undefined ? 0 : v);
  const eqAll = (x, y) => FIELDS.every(([k]) => x[k] === y[k]);
  // Tiap isian bernilai lama atau baru (bisa campur kalau sebelumnya sempat terisi sebagian)
  const oldOrNew = (cur, t) => FIELDS.every(([k]) => cur[k] === t.old[k] || cur[k] === t.neu[k]);
  const sumOf = (x) => SUM_KEYS.reduce((n, k) => n + (x[k] || 0), 0);
  const fmtCur = (cur) => FIELDS.map(([k, , l]) => `${l} ${rupiah(cur[k])}`).join(" / ");
  const fmtChange = (cur, t) =>
    FIELDS.filter(([k]) => cur[k] !== t.neu[k])
      .map(([k, , l]) => `${l} ${rupiah(cur[k])} → ${rupiah(t.neu[k])}`)
      .join(", ");
  const readFields = (inst) => Object.fromEntries(FIELDS.map(([k, id]) => [k, norm0(readBox(box(id, inst)))]));

  // Ganti semua isian di kartu yang sedang terbuka. Yang turun dulu baru yang naik,
  // supaya total sementara tidak melonjak
  async function writeCard(inst, t, cur) {
    const steps = FIELDS.map(([k, id]) => [id, t.neu[k], cur[k]]);
    steps.sort((x, y) => x[1] - x[2] - (y[1] - y[2]));
    for (const [id, n] of steps) await writeNum(id, inst, n);
  }

  // Telusuri kartu usaha dokumen ini & cocokkan ke baris Excel.
  // write=false: cuma baca (aman di halaman Review). write=true: ganti nilainya.
  // Kartu dikenali dari nilainya (lama / baru / jumlahnya sama) DAN nama usahanya harus sesuai Excel.
  async function scanDoc(item, write) {
    const area = await gotoArea();
    const targets = item.targets;
    const results = targets.map(() => null);
    const notes = [];

    // Nama-nama usaha yang terbaca di kartu/isian yang sedang terbuka
    const namesAt = (inst, cardName) =>
      Array.from(
        new Set(
          [cardName, ...["nama_komersial", "nama_usaha_edit", "nama_usaha"].map((id) => {
            const b = box(id, inst);
            const i = b && b.querySelector("input, textarea");
            return i ? i.value : "";
          })]
            .map((x) => String(x || "").trim())
            .filter(Boolean),
        ),
      );

    // Kartu cocok = nilainya cocok (lama / baru / jumlahnya sama) DAN nama usahanya sesuai Excel
    const decide = (cur, names) => {
      const sim = targets.map((t) => Math.max(0, ...names.map((n) => nameMatch(n, t.nama))));
      const nameOk = (i) => sim[i] >= NAME_OK;
      const open = (i) => !results[i];
      for (let i = 0; i < targets.length; i++) if (open(i) && nameOk(i) && eqAll(cur, targets[i].neu)) return { i, kind: "new" };
      for (let i = 0; i < targets.length; i++) if (open(i) && nameOk(i) && oldOrNew(cur, targets[i])) return { i, kind: "old" };
      let best = null;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!SUM_KEYS.length || !open(i) || !nameOk(i) || sumOf(cur) !== sumOf(t.neu)) continue;
        if (!best || sim[i] > best.sim) best = { i, kind: "sum", sim: sim[i] };
      }
      if (best) return best;
      // Nilainya cocok tapi namanya beda -> jangan disentuh, beri tahu kenapa
      const byValue = targets.findIndex((t, i) => open(i) && oldOrNew(cur, t));
      return byValue >= 0 ? { mismatch: targets[byValue].nama } : null;
    };

    const handle = async (inst, cardName) => {
      const pend = await waitBox("nilai_pendapatan", inst, 5000);
      if (!pend) return notes.push(`kartu "${cardName || "-"}": isian 27.a tidak muncul`);
      await waitFor(() => namesAt(inst, cardName).length, 2000);
      const names = namesAt(inst, cardName);
      const name = cardName || names[0] || "";
      if (!names.length) return notes.push(`kartu "${name || "-"}": nama usaha tidak terbaca, tidak bisa dipastikan`);
      await waitFor(() => FIELDS.every(([, id]) => box(id, inst)), 3000);
      const cur = readFields(inst);
      const d = decide(cur, names);
      if (d && d.mismatch)
        return notes.push(`kartu "${name}": nilainya cocok, tapi nama usahanya beda dengan Excel "${d.mismatch}"`);
      if (!d) return notes.push(`kartu "${name}": ${fmtCur(cur)} tidak cocok dengan Excel`);
      const t = targets[d.i];
      if (d.kind === "new") {
        results[d.i] = { state: "already", card: name, cur };
        return log(`✓ "${name}" sudah sesuai`);
      }
      if (!write) {
        results[d.i] = { state: "todo", card: name, cur };
        return log(`"${name}" perlu diganti: ${fmtChange(cur, t)}`);
      }
      log(`Ganti "${name}" (= Excel "${t.nama}"): ${fmtChange(cur, t)}`);
      await writeCard(inst, t, cur);
      results[d.i] = { state: "set", card: name, cur };
    };

    if (area.kind === "direct") {
      const el = visiblePend();
      await handle(instOf(el), "");
    } else {
      const cards = usahaCards();
      if (!cards.length) throw new Error("tidak ada kartu usaha di Blok II");
      const hints = (item.cardHints || []).map(normalize);
      const order = cards
        .map((c, idx) => ({
          idx,
          score: Math.max(...targets.map((t) => Math.max(nameMatch(c.name, t.nama), nameSim(c.name, t.nama) / 2))) + (hints.includes(normalize(c.name)) ? 10 : 0),
        }))
        .sort((x, y) => y.score - x.score);
      log(`${cards.length} kartu usaha di "${area.title}"`);
      let first = true;
      for (const o of order) {
        if (results.every(Boolean)) break;
        if (!first) await goSection(area.title, onCardList, true);
        first = false;
        const card = usahaCards()[o.idx];
        if (!card) continue;
        const inst = await openCard(card);
        await handle(inst, card.name);
      }
    }
    return { results, notes };
  }

  // =========================================================================
  // CARI LEWAT FILTER di halaman daftar assignment (kalau link Excel tidak membuka dokumen yang benar)
  // =========================================================================
  const REVIEW_HREF = /\/app\/assignment\/[0-9a-f-]{36}\/[0-9a-f-]{36}/i;
  const searchInput = () => document.querySelector('input[placeholder^="Cari"]:not([cmdk-input])');
  const tableText = () => (document.querySelector("table tbody") || {}).innerText || "";
  const isListPage = () =>
    !REVIEW_HREF.test(location.pathname) &&
    !/\/app\/assignment-detail\//i.test(location.pathname) &&
    !!searchInput() &&
    !!document.querySelector("table thead");
  function setInputValue(input, value) {
    input.focus();
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function isLoading() {
    const spin = Array.from(document.querySelectorAll('[class*="animate-spin"], [class*="skeleton"], [aria-busy="true"]')).some(
      (el) => visible(el) && !el.closest(OWN),
    );
    return spin || /loading|memuat/i.test(tableText());
  }
  async function waitTableSettled(before) {
    if (before !== undefined) await waitFor(() => tableText() !== before || isLoading(), 6000);
    let start = Date.now();
    let last = tableText();
    let stableSince = Date.now();
    while (Date.now() - start < 30000 && !stopRequested) {
      const held = await sleep(250);
      start += held;
      stableSince += held;
      const now = tableText();
      if (now !== last || isLoading()) {
        last = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= W(1200)) break;
    }
    await sleep(W(300));
  }

  // "[040] HARUYAN" -> { code: "040", name: "HARUYAN" }
  function parseOption(text) {
    const m = String(text || "").trim().match(/^\[?(\d+)\]?\s*(.*)$/);
    return m ? { code: m[1], name: m[2].trim() } : { code: "", name: String(text || "").trim() };
  }
  const filterButton = () =>
    Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]')).find(
      (b) => b.querySelector(".tabler-icon-filter") && !b.closest("th"),
    );
  function fieldButton(label) {
    const lab = Array.from(document.querySelectorAll("label")).find((l) => squash(l.innerText) === squash(label) && !l.closest(OWN));
    return lab ? lab.parentElement.querySelector('button[role="combobox"]') : null;
  }
  const visibleOptions = () =>
    Array.from(document.querySelectorAll('[cmdk-item], [role="option"]')).filter((el) => visible(el) && !el.closest(OWN) && el.innerText.trim());
  const optionText = (el) => el.getAttribute("data-value") || el.innerText;
  const shownText = (btn) => ((btn && (btn.querySelector("span") || btn).innerText) || "").trim();

  // Pilih opsi filter berdasarkan NAMA (Excel berisi nama kecamatan/desa/SLS, bukan kode)
  async function pickByName(getBtn, name, label) {
    if (!name) return false;
    const btn = getBtn() || (await waitFor(getBtn, 8000));
    if (!btn) return false;
    const want = normalize(name);
    const same = (t) => normalize(parseOption(t).name) === want || normalize(t) === want;
    if (same(shownText(btn))) return true;
    triggerClick(btn);
    await waitFor(() => visibleOptions().length, 6000);
    let count = -1;
    for (let i = 0; i < 8 && visibleOptions().length !== count; i++) {
      count = visibleOptions().length; // tunggu daftar selesai dimuat
      await sleep(W(200));
    }
    const find = () => visibleOptions().find((el) => same(optionText(el)) || same(el.innerText));
    let target = find();
    const input = document.querySelector("input[cmdk-input]");
    if (!target && input) {
      setInputValue(input, name);
      target = await waitFor(find, 4000);
    }
    if (!target) {
      pressKey("Escape");
      await sleep(300);
      log(`⚠ filter ${label} "${name}" tidak ada di pilihan, dilewati`);
      return false;
    }
    triggerClick(target);
    await waitFor(() => same(shownText(getBtn())), 5000);
    await sleep(W(500)); // isian di bawahnya dimuat ulang
    return true;
  }

  // Kosongkan pilihan combobox (filter SLS) kalau ada opsi "Semua"/kosong; kalau tidak ada, biarkan
  async function clearCombo(getBtn) {
    const btn = getBtn();
    if (!btn || !parseOption(shownText(btn)).code) return;
    triggerClick(btn);
    await waitFor(() => visibleOptions().length, 4000);
    const all = visibleOptions().find((el) => !parseOption(el.innerText).code || /^(SEMUA|ALL|-+)$/i.test(el.innerText.trim()));
    if (all) triggerClick(all);
    else pressKey("Escape");
    await sleep(W(400));
  }

  async function applyFilterNames(item, withSls) {
    const btn = filterButton();
    if (!btn) return log("⚠ tombol Filter tidak ada, langsung cari nama");
    const before = tableText();
    if (!fieldButton("KECAMATAN")) {
      triggerClick(btn);
      if (!(await waitFor(() => fieldButton("KECAMATAN"), 6000))) return log("⚠ isian Filter tidak muncul, langsung cari nama");
    }
    if (await pickByName(() => fieldButton("KECAMATAN"), item.kec, "Kecamatan"))
      if (await pickByName(() => fieldButton("DESA"), item.desa, "Desa"))
        if (fieldButton("SLS")) {
          if (withSls) await pickByName(() => fieldButton("SLS"), item.sls, "SLS");
          else await clearCombo(() => fieldButton("SLS"));
        }
    const field = fieldButton("KECAMATAN");
    const scope = (field && field.closest('[role="dialog"]')) || document;
    const apply = Array.from(scope.querySelectorAll("button")).find((b) => /^(TERAPKAN|APPLY|SIMPAN|TAMPILKAN|OK)$/i.test(b.innerText.trim()));
    if (apply) triggerClick(apply);
    else pressKey("Escape");
    await sleep(400);
    if (fieldButton("KECAMATAN") && filterButton()) triggerClick(filterButton());
    await waitTableSettled(before);
  }

  async function searchList(query) {
    const input = searchInput();
    if (!input) throw new Error('kotak "Cari..." tidak ditemukan');
    if (input.value.trim().toUpperCase() !== query.toUpperCase()) {
      const before = tableText();
      setInputValue(input, query);
      await sleep(W(300));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      await waitTableSettled(before);
    }
    return Array.from(document.querySelectorAll("table tbody tr")).filter((tr) => tr.querySelectorAll("td").length > 2);
  }

  // Link Review dokumen pada satu baris tabel (langsung di baris, atau muncul setelah kodenya diklik)
  async function rowLink(tr) {
    const direct = Array.from(tr.querySelectorAll("a[href]")).find((a) => REVIEW_HREF.test(a.href));
    if (direct) return direct.href;
    const links = () => Array.from(document.querySelectorAll("a[href]")).filter((a) => REVIEW_HREF.test(a.href) && !a.closest(OWN));
    const before = new Set(links().map((a) => a.href));
    const kodeBtn = tr.querySelector("td button:not([title]):not([aria-haspopup])");
    if (!kodeBtn) return null;
    triggerClick(kodeBtn);
    const a = await waitFor(() => links().find((x) => visible(x) && !before.has(x.href)), 4000);
    return a ? a.href : null;
  }

  // Nama yang dicari: nama usaha utuh, bagian sebelum kurung, dan nama di dalam kurung (biasanya KRT)
  // Yang dicari: BKU (nama usaha utuh / tanpa kurung) dulu, lalu dokumen keluarga (nama pemilik di dalam kurung)
  function nameQueries(item) {
    const bku = [];
    const kel = [];
    for (const t of item.targets) {
      const nm = String(t.nama || "").trim();
      bku.push(nm, nm.split("(")[0]);
      kel.push((nm.match(/\(([^)]+)\)/) || [])[1]);
    }
    const clean = (a) => a.map((x) => String(x || "").replace(/\s+/g, " ").trim()).filter((x) => x.length >= 3);
    const seen = new Set();
    return [...clean(bku).map((q) => ({ q, kind: "BKU" })), ...clean(kel).map((q) => ({ q, kind: "keluarga" }))].filter(
      (x) => !seen.has(normalize(x.q)) && seen.add(normalize(x.q)),
    );
  }

  // Hasil: daftar kandidat [{ href, q, kind }] berurutan (BKU dulu, lalu keluarga), maks 6
  async function findInList(item) {
    await waitTableSettled();
    const queries = nameQueries(item);
    const cands = [];
    for (const withSls of item.sls ? [true, false] : [false]) {
      log(`Cari lewat filter: ${[item.kec, item.desa, withSls ? item.sls : ""].filter(Boolean).join(" › ") || "(tanpa wilayah)"}`);
      await applyFilterNames(item, withSls);
      for (const { q, kind } of queries) {
        const want = normalize(q);
        const rows = await searchList(q);
        const exact = rows.filter((tr) => Array.from(tr.querySelectorAll("td")).some((td) => normalize(td.innerText) === want));
        for (const tr of exact.slice(0, 4)) {
          const href = await rowLink(tr);
          pressKey("Escape");
          if (href && !cands.some((c) => c.href === href)) cands.push({ href, q, kind });
        }
        if (exact.length) log(`"${q}" (${kind}): ${exact.length} dokumen di daftar`);
      }
      if (cands.length) break;
      if (withSls) log(`Tidak ada di ${item.sls}, cari di seluruh desa ${item.desa}`);
    }
    if (!cands.length)
      throw Object.assign(new Error(`tidak ketemu di daftar (BKU maupun keluarga; cari: ${queries.map((x) => x.q).join(" / ")})`), { soft: true });
    return cands.slice(0, 6);
  }

  const hasNextCand = (item) => !!item.findCands && (item.findIdx || 0) + 1 < item.findCands.length;
  // Buka kandidat ke-idx hasil pencarian filter
  function openCandidate(item, idx) {
    const c = item.findCands[idx];
    const m = c.href.match(/\/app\/assignment\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i);
    updateItem(item.id, { findIdx: idx, docId: m[2].toLowerCase(), prefix: m[1].toLowerCase(), url: c.href, foundBy: "filter", foundAs: `${c.kind} "${c.q}"` });
    log(`Buka ${c.kind} "${c.q}" (kandidat ${idx + 1}/${item.findCands.length})`);
    setStage("open");
    const r = loadRun();
    r.navAt = Date.now();
    saveRun(r);
    location.href = c.href;
  }

  const needFind = (why) => Object.assign(new Error(why), { needFind: true });

  // ---------- Review -> Edit (revoke bila perlu) ----------
  async function reviewToEdit() {
    await waitFor(() => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"), 20000);
    await sleep(W(600));
    let revoked = false;
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      const revoke = buttonByIcon("rotate-clockwise");
      if (!revoke || revoke.disabled) throw new Error("tombol Edit & Revoke tidak aktif");
      log("Revoke dokumen");
      triggerClick(revoke);
      const ok = await waitFor(() => buttonByText("Konfirmasi"), 8000);
      if (!ok) throw new Error("konfirmasi revoke tidak muncul");
      triggerClick(ok);
      revoked = true;
      edit = await waitFor(() => {
        const b = buttonByIcon("edit");
        return b && !b.disabled ? b : null;
      }, 20000);
      if (!edit) throw new Error("tombol Edit belum aktif setelah revoke");
      await sleep(W(600));
    }
    triggerClick(edit);
    if (!(await waitFor(() => /\/edit/.test(location.pathname) && document.querySelector(".fasih-form-sidebar"), 30000)))
      throw new Error("halaman edit tidak terbuka");
    await sleep(W(1500));
    return revoked;
  }

  // ---------- Kirim + Approve ----------
  function findAnomaliSwitch() {
    const direct = document.querySelector('#cek_anomali_button input[role="switch"]');
    if (direct) return direct;
    return (
      Array.from(document.querySelectorAll('input[role="switch"]')).find((sw) => {
        let el = sw;
        for (let i = 0; i < 7 && el; i++, el = el.parentElement) if (/anomali/i.test(el.innerText || "")) return true;
        return false;
      }) || null
    );
  }
  async function openCatatan() {
    closeDialogs();
    try {
      await goSection("CATATAN", () => !!findAnomaliSwitch());
    } catch (e) {
      log(`⚠ halaman CATATAN tidak dibuka (${e.message})`);
      return;
    }
    const control = () => {
      const s = findAnomaliSwitch();
      return s && s.parentElement.querySelector('[id$="-control"]');
    };
    const isOn = () => {
      const s = findAnomaliSwitch();
      const c = control();
      return !!s && (s.checked || s.getAttribute("aria-checked") === "true" || (c && c.hasAttribute("data-checked")));
    };
    for (const attempt of [() => triggerClick(control() || findAnomaliSwitch()), () => findAnomaliSwitch().click()]) {
      if (isOn()) break;
      attempt();
      await waitFor(isOn, 2500);
    }
    if (isOn()) await sleep(W(1200));
  }

  const isKirimText = (b) => b.innerText.trim().toUpperCase() === "KIRIM";
  const inDialog = (b) => !!b.closest('[role="dialog"], [role="alertdialog"]');
  const hasSendIcon = (b) => !!b.querySelector('svg path[d^="M10 14l11 -11"], svg.tabler-icon-send');
  function findNavKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !inDialog(b) && !b.closest(OWN),
    );
    return buttons.find(hasSendIcon) || buttons.find((b) => b.id === "fasih-form-nav-submit-button") || buttons[0] || null;
  }
  function findDialogKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !b.closest(OWN),
    );
    return buttons.find(inDialog) || buttons.find((b) => !hasSendIcon(b) && b.id !== "fasih-form-nav-submit-button") || null;
  }
  function summaryCount(label) {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => {
      const s = b.querySelector("span");
      return visible(b) && s && s.innerText.trim().toUpperCase() === label;
    });
    if (!btn) return null;
    const spans = btn.querySelectorAll("span");
    return { btn, n: parseInt((spans[1] || {}).innerText, 10) || 0 };
  }
  function readGalatList() {
    return Array.from(document.querySelectorAll('button[title="Lihat"]'))
      .filter(visible)
      .map((lihat) => {
        const card = lihat.closest('div[class*="rounded-lg"]') || lihat.parentElement.parentElement;
        const titleEl = card.querySelector("div[title]");
        return `${titleEl ? titleEl.getAttribute("title").trim() : "?"} (${Array.from(card.querySelectorAll("li"))
          .map((li) => li.innerText.trim())
          .join(", ")})`;
      });
  }
  function closeDialogs() {
    Array.from(document.querySelectorAll('button[aria-label="Dismiss"]')).filter(visible).forEach((b) => triggerClick(b));
    if (Array.from(document.querySelectorAll('[role="dialog"]')).some(visible)) pressKey("Escape");
  }
  function dialogText() {
    const d = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible).pop();
    return d ? d.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  }

  const backButton = () =>
    Array.from(document.querySelectorAll("button")).find((b) => /KEMBALI KE REVIEW/i.test(b.innerText) && b.getClientRects().length > 0);
  const leftEdit = () => !/\/edit/.test(location.pathname);
  async function backToReview(timeoutMs) {
    const sign = await waitFor(() => backButton() || (leftEdit() ? "left" : null), timeoutMs);
    if (!sign) throw new Error(`tidak ada tanda terkirim setelah Konfirmasi: ${dialogText() || "cek manual"}`);
    if (sign !== "left") {
      await sleep(W(400));
      triggerClick(sign);
      if (!(await waitFor(leftEdit, 15000))) {
        sign.click();
        await waitFor(leftEdit, 15000);
      }
    }
    await sleep(W(1200));
  }

  const markSubmitClicked = () => {
    const r = loadRun();
    if (r.cur) r.cur.submitClicked = true;
    saveRun(r);
  };

  // Kirim biasa. Galat -> error (atau Submit Paksa kalau diaktifkan)
  async function submitCurrent() {
    await openCatatan();
    const nav = await waitFor(findNavKirim, 10000);
    if (!nav) throw new Error("tombol Kirim tidak ditemukan / tidak aktif");
    log("Klik Kirim");
    triggerClick(nav);
    await waitFor(() => summaryCount("GALAT") || findDialogKirim() || readGalatList().length, 15000);
    await sleep(W(1200));
    const galat = summaryCount("GALAT");
    const list = readGalatList();
    if ((galat && galat.n > 0) || (list.length && !galat)) {
      if (galat && galat.btn && !list.length) {
        triggerClick(galat.btn);
        await waitFor(() => readGalatList().length, 6000);
      }
      const detail = readGalatList().join("; ");
      const n = galat ? galat.n : list.length;
      if (loadConf().forceOnGalat) {
        log(`Galat ${n} → Submit Paksa`);
        return forceSubmit(n);
      }
      closeDialogs();
      throw Object.assign(new Error(`galat ${n}: ${detail || "lihat di FASIH"}`), { soft: true });
    }
    const dialogKirim = findDialogKirim();
    if (!dialogKirim) throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    markSubmitClicked();
    triggerClick(dialogKirim);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi) throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }

  const isDotsButton = (b) => !!b.querySelector('svg path[d^="M12 12m-1 0"]');
  function findForceTrigger() {
    const cands = Array.from(
      document.querySelectorAll('button[id^="dropdownmenu-"][id$="-trigger"], button[aria-haspopup="true"], button[aria-haspopup="menu"]'),
    ).filter((b) => visible(b) && isDotsButton(b) && !b.closest(OWN));
    return cands.find(inDialog) || cands[0] || null;
  }
  async function forceSubmit(galatN) {
    const trigger = await waitFor(findForceTrigger, 8000);
    if (!trigger) throw new Error(`galat ${galatN}, tombol ⋮ (Submit Paksa) tidak muncul`);
    triggerClick(trigger);
    const menu = await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => visible(el) && /SUBMIT\s+PAKSA/i.test(el.innerText)),
      6000,
    );
    if (!menu) {
      pressKey("Escape");
      throw new Error(`galat ${galatN}, menu "Submit Paksa" tidak ada`);
    }
    triggerClick(menu);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi) throw new Error(`tombol Konfirmasi Submit Paksa tidak muncul: ${dialogText()}`);
    markSubmitClicked();
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }

  async function approveDocument() {
    const findCheck = () => {
      const buttons = Array.from(document.querySelectorAll("svg.tabler-icon-check"))
        .map((s) => s.closest("button"))
        .filter((b) => b && visible(b) && !b.disabled && !b.closest(OWN));
      return buttons.find((b) => /bg-success/.test(b.className)) || buttons[0] || null;
    };
    const check = await waitFor(findCheck, 25000);
    if (!check) throw new Error("tombol Approve (✔) tidak aktif");
    await sleep(W(600));
    triggerClick(check);
    const ok = await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter(
        (b) => visible(b) && !b.disabled && b.innerText.trim().toUpperCase() === "KONFIRMASI" && !b.closest(OWN),
      );
      return buttons.find((b) => /bg-success/.test(b.className)) || buttons[0] || null;
    }, 10000);
    if (!ok) throw new Error("konfirmasi approve tidak muncul");
    await sleep(W(400));
    triggerClick(ok);
    await sleep(W(2500));
  }

  // =========================================================================
  // MESIN: per dokumen, bertahap lintas halaman (aman kalau halaman dimuat ulang)
  // =========================================================================
  const STEPS = [
    ["open", "Buka"],
    ["check", "Cek Review"],
    ["edit", "Edit / Revoke"],
    ["fill", "Ganti nilai"],
    ["submit", "Kirim"],
    ["approve", "Approve"],
  ];
  const STEP_LABEL = { ...Object.fromEntries(STEPS), find: "Cari via filter" };
  const STAGE_TIMEOUT_MS = 4 * 60 * 1000;
  let busy = false;

  function log(msg) {
    console.log(`[${APP.name}] ${msg}`);
    const r = loadRun();
    r.lastLog = msg;
    r.logs = [...(r.logs || []), `${new Date().toLocaleTimeString("id-ID")} ${msg}`].slice(-6);
    saveRun(r);
    updateHud();
  }
  function setStage(stage, extra) {
    const r = loadRun();
    r.cur = Object.assign(r.cur || {}, { navTries: 0 }, extra || {}, { stage });
    r.phaseAt = Date.now();
    saveRun(r);
    updateHud();
  }

  const did = (item) => item.docId || item.id;
  const docUrl = (item) => item.url || `${location.origin}/app/assignment/${item.prefix}/${item.id}`;
  const onReviewOf = (id) => new RegExp(`/app/assignment/[^/]+/${id}/?$`, "i").test(location.pathname);
  const onEditOf = (id) => new RegExp(`/app/assignment/[^/]+/${id}/edit`, "i").test(location.pathname);

  // Hasil true jika sudah di halaman Review dokumen ini (kalau belum: pindah halaman, tick berikutnya lanjut)
  function ensureReview(item) {
    if (onReviewOf(did(item))) return true;
    const r = loadRun();
    if (Date.now() - (r.navAt || 0) < 4000) return false;
    const tries = (r.cur && r.cur.navTries) || 0;
    if (tries >= 4) {
      if (!item.searched || hasNextCand(item)) throw needFind("link tidak membuka dokumen");
      throw new Error("dokumen tidak bisa dibuka (cek link / akses akun)");
    }
    r.cur.navTries = tries + 1;
    r.navAt = Date.now();
    saveRun(r);
    log(`Membuka dokumen${tries ? ` (percobaan ${tries + 1})` : ""}`);
    location.href = tries % 2 === 0 ? docUrl(item) : `${location.origin}/app/assignment-detail/${did(item)}`;
    return false;
  }
  // Dari halaman assignment-detail: ikuti link Review-nya
  function followDetailLink(item) {
    if (!new RegExp(`/app/assignment-detail/${did(item)}`, "i").test(location.pathname)) return false;
    const a = Array.from(document.querySelectorAll('a[href*="/app/assignment/"]')).find((x) =>
      x.getAttribute("href").toLowerCase().includes(did(item)),
    );
    if (!a) return false;
    const r = loadRun();
    r.navAt = Date.now();
    saveRun(r);
    location.href = a.href;
    return true;
  }

  const summary = (item, results) =>
    item.targets
      .map((t, i) => {
        const res = results && results[i];
        const nm = (t.nama || res?.card || "usaha").split("(")[0].trim();
        if (!res) return `${nm}: kartu tidak ketemu`;
        if (res.state === "already") return `${nm}: sudah sesuai`;
        return `${nm}: ${fmtChange(res.cur, t) || "sudah sesuai"}`;
      })
      .join(" · ");

  function finishItem(id, status, reason) {
    const it = loadQueue().find((q) => q.id === id);
    if (it && it.foundBy === "filter") reason += ` · dokumen dicari lewat filter (${it.foundAs || "-"})`;
    updateItem(id, { status, reason, doneAt: new Date().toISOString() });
    const r = loadRun();
    r.cur = null;
    r.paused = null;
    r.processed = (r.processed || 0) + 1;
    const gap = T().gap;
    r.nextAt = Date.now() + gap[0] + Math.random() * (gap[1] - gap[0]);
    saveRun(r);
    log(`${FINISHED.includes(status) ? "✅" : status === "tested" ? "🧪" : "⚠️"} ${reason}`);
    refreshPanel();
  }

  function nextItem(run) {
    const only = run.onlyIds ? new Set(run.onlyIds) : null;
    return loadQueue().find((q) => q.status === "pending" && (!only || only.has(q.id)));
  }

  async function tick() {
    const run = loadRun();
    if (!run.running || busy || rateLimited() || run.paused || run.hold) return;
    busy = true;
    stopRequested = false;
    try {
      if (!run.cur) {
        if (Date.now() < (run.nextAt || 0)) return;
        const item = nextItem(run);
        if (!item || (run.limit && run.processed >= run.limit)) return stopRun("Selesai ✓");
        setStage("open", { id: item.id, submitClicked: false });
        log(`▶ ${item.targets.map((t) => t.nama).join(" + ")}`);
        return;
      }
      const cur = run.cur;
      const item = loadQueue().find((q) => q.id === cur.id);
      if (!item) return finishItem(cur.id, "red", "dokumen hilang dari antrean");
      if (Date.now() - (run.phaseAt || 0) > STAGE_TIMEOUT_MS)
        return finishItem(item.id, "red", `macet di tahap "${STEP_LABEL[cur.stage] || cur.stage}"`);
      try {
        if (cur.stage !== "find" && forbiddenPage()) throw forbiddenError();
        await runStage(run, cur, item);
      } catch (e) {
        console.error(`[${APP.name}]`, e);
        const untouched = !cur.revoked && ["open", "check", "edit"].includes(cur.stage);
        if ((e.needFind || e.forbidden) && untouched && !item.searched) {
          log(`⚠ ${e.forbidden ? "halaman Forbidden" : e.message} → cari dokumen lewat filter`);
          return setStage("find");
        }
        if ((e.needFind || e.forbidden) && untouched && hasNextCand(item)) {
          log(`⚠ ${e.forbidden ? "halaman Forbidden" : e.message} → coba kandidat berikutnya`);
          return openCandidate(item, (item.findIdx || 0) + 1);
        }
        if (e.forbidden) {
          const edited = cur.revoked || ["fill", "submit"].includes(cur.stage) ? " (dokumen sempat dibuka edit, cek manual)" : "";
          return finishItem(item.id, "forbidden", `halaman Forbidden (tidak ada akses), dilewati${edited}`);
        }
        pressKey("Escape");
        const where = STEP_LABEL[cur.stage] || cur.stage;
        const after = cur.revoked || cur.stage === "fill" || cur.stage === "submit" ? " — dokumen sudah dibuka edit, cek manual" : "";
        finishItem(item.id, e.soft ? "yellow" : "red", `[${where}] ${e.message}${after}`);
      }
    } finally {
      busy = false;
    }
  }

  async function runStage(run, cur, item) {
    const conf = loadConf();
    switch (cur.stage) {
      case "open": {
        if (onEditOf(did(item))) return setStage("fill", { revoked: true });
        if (followDetailLink(item)) return;
        if (!ensureReview(item)) return;
        return setStage(conf.checkFirst ? "check" : "edit");
      }
      case "find": {
        const listUrl = loadJson(LIST_KEY, "");
        if (!isListPage()) {
          if (!listUrl)
            throw Object.assign(
              new Error("link Excel tidak membuka dokumen yang benar & halaman daftar assignment belum dikenal — buka halaman daftar assignment sekali, lalu ulangi"),
              { soft: true },
            );
          if (location.pathname !== new URL(listUrl).pathname) {
            const r = loadRun();
            if (Date.now() - (r.navAt || 0) < 8000) return;
            r.navAt = Date.now();
            saveRun(r);
            log("Buka halaman daftar assignment");
            location.href = listUrl;
            return;
          }
          if (!(await waitFor(isListPage, 20000))) throw new Error("halaman daftar assignment tidak termuat");
        }
        updateItem(item.id, { searched: true, findCands: null, findIdx: 0 });
        const cands = await findInList(item);
        const fresh = updateItem(item.id, { findCands: cands });
        return openCandidate(fresh, 0);
      }
      case "check": {
        // Baca di halaman Review (tanpa Edit/revoke). Kalau semua sudah benar -> selesai tanpa menyentuh dokumen
        if (!ensureReview(item)) return;
        try {
          const { results, notes } = await scanDoc(item, false);
          if (results.every((r) => r && r.state === "already"))
            return finishItem(item.id, "already", `tidak diubah, sudah sesuai · ${summary(item, results)}`);
          // Tidak ada satu kartu pun yang cocok: kemungkinan link membuka dokumen lain -> cari dulu, jangan revoke
          if (results.every((r) => !r)) {
            const why = `tidak ada kartu yang sesuai nama_usaha & nilai Excel (${notes.join("; ") || "-"})`;
            if (!item.searched || hasNextCand(item)) throw needFind(why);
            throw Object.assign(new Error(`${why} — tidak di-revoke, cek manual`), { soft: true });
          }
          // Hasil filter yang cuma memuat sebagian usaha (mis. BKU satu usaha): coba kandidat berikutnya (keluarga)
          if (results.some((r) => !r) && item.foundBy === "filter" && hasNextCand(item))
            throw needFind(`sebagian usaha tidak ada di dokumen ini (${notes.join("; ") || "-"})`);
          if (results.some((r) => !r))
            log(`⚠ cek Review: ${notes.join("; ") || "sebagian kartu belum ketemu"}, lanjut ke Edit`);
          updateItem(item.id, { cardHints: results.filter(Boolean).map((r) => r.card) });
        } catch (e) {
          if (e.needFind || e.forbidden || e.soft) throw e;
          log(`⚠ cek Review gagal (${e.message}), lanjut ke Edit`);
        }
        return setStage("edit");
      }
      case "edit": {
        if (onEditOf(did(item))) return setStage("fill");
        if (!ensureReview(item)) return;
        const revoked = await reviewToEdit();
        return setStage("fill", { revoked });
      }
      case "fill": {
        if (!onEditOf(did(item))) return setStage("edit");
        const { results, notes } = await scanDoc(item, true);
        updateItem(item.id, { result: summary(item, results) });
        if (results.some((r) => !r))
          throw Object.assign(new Error(`${summary(item, results)}${notes.length ? ` (${notes.join("; ")})` : ""}`), { soft: true });
        return setStage("submit", { submitClicked: false, changed: results.some((r) => r.state === "set") });
      }
      case "submit": {
        if (!onEditOf(did(item))) {
          if (cur.submitClicked && onReviewOf(did(item))) return setStage("approve");
          throw new Error("halaman edit tertutup sebelum dikirim");
        }
        if (cur.submitClicked) {
          await backToReview(20000); // halaman dimuat ulang setelah Kirim: jangan kirim dua kali
          return setStage("approve");
        }
        if (run.testMode && cur.confirmed !== "submit") {
          if (!run.paused) {
            run.paused = { stage: "submit" };
            saveRun(run);
            log('MODE UJI: nilai sudah diganti. Periksa, lalu "Kirim sekarang" atau "Lewati"');
          }
          return;
        }
        await submitCurrent();
        return setStage("approve");
      }
      case "approve": {
        if (!ensureReview(item)) return;
        let note = "";
        if (conf.approve) {
          try {
            log("Approve");
            await approveDocument();
          } catch (e) {
            note = ` (approve gagal: ${e.message})`;
          }
          closeDialogs();
        }
        const q = loadQueue().find((x) => x.id === item.id) || item;
        return finishItem(item.id, "done", `${q.result || "terkirim"} · terkirim${conf.approve && !note ? " & approve" : ""}${note}`);
      }
      default:
        throw new Error(`tahap tidak dikenal: ${cur.stage}`);
    }
  }

  function startRun(opts) {
    let onlyIds = opts.onlyIds || null;
    if (!onlyIds && opts.limit)
      onlyIds = loadQueue()
        .filter((q) => q.status === "pending")
        .slice(0, opts.limit)
        .map((q) => q.id);
    if (onlyIds && !onlyIds.length) return toast("Tidak ada dokumen berstatus Belum untuk dijalankan.");
    if (!onlyIds && !loadQueue().some((q) => q.status === "pending")) return toast("Semua dokumen sudah diproses.");
    saveRun({
      running: true,
      testMode: !!opts.testMode,
      onlyIds,
      total: onlyIds ? onlyIds.length : loadQueue().filter((q) => q.status === "pending").length,
      processed: 0,
      cur: null,
      logs: [],
    });
    closePanel();
    log(`Mulai${opts.testMode ? " · MODE UJI" : ""}`);
  }

  // Jeda: berhenti di titik tunggu berikutnya (langkah yang sedang jalan ditahan, bukan dibatalkan)
  function setHold(on) {
    const r = loadRun();
    if (!r.running) return;
    if (on && !r.hold) r.hold = { at: Date.now() };
    if (!on && r.hold) {
      if (r.phaseAt) r.phaseAt += Date.now() - r.hold.at; // lama jeda tidak dihitung ke batas macet
      if (r.nextAt) r.nextAt += Date.now() - r.hold.at;
      r.hold = null;
    }
    saveRun(r);
    log(on ? "⏸ Dijeda — klik Lanjut untuk meneruskan" : "▶ Dilanjutkan");
  }

  function stopRun(msg) {
    const r = loadRun();
    r.running = false;
    r.paused = null;
    r.hold = null;
    saveRun(r);
    stopRequested = true;
    log(msg || "Dihentikan.");
    updateHud();
    if (/Selesai/.test(msg || "")) toast(`Selesai — ${r.processed || 0} dokumen diproses.`);
  }

  // =========================================================================
  // TAMPILAN
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById("kgj-style")) return;
    const style = document.createElement("style");
    style.id = "kgj-style";
    style.textContent = `
      .kgj, .kgj * { box-sizing:border-box; font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .kgj { --bg:#ffffff; --bg2:#f6f7fb; --line:#e7e8ef; --tx:#0f1222; --mut:#6b7186; --acc:#4f46e5; --acc2:#7c3aed; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; color:var(--tx); }
      .kgj button { font:inherit; }
      .kgj-overlay { position:fixed; inset:0; z-index:1000001; background:rgba(15,18,34,.38); backdrop-filter:blur(3px); display:flex; justify-content:flex-end; animation:kgjfade .18s ease; }
      @keyframes kgjfade { from{opacity:0} to{opacity:1} }
      @keyframes kgjslide { from{transform:translateX(24px);opacity:.4} to{transform:none;opacity:1} }
      @keyframes kgjspin { to{transform:rotate(360deg)} }
      @keyframes kgjpulse { 0%,100%{opacity:1} 50%{opacity:.45} }
      .kgj-sheet { background:var(--bg2); width:min(820px,100vw); height:100vh; display:flex; flex-direction:column; box-shadow:-20px 0 60px rgba(15,18,34,.25); animation:kgjslide .22s ease; }
      .kgj-head { position:relative; padding:20px 24px 18px; color:#fff; background:linear-gradient(120deg,#4338ca,#7c3aed 55%,#c026d3); overflow:hidden; }
      .kgj-head:after { content:""; position:absolute; right:-60px; top:-80px; width:240px; height:240px; border-radius:50%; background:rgba(255,255,255,.09); }
      .kgj-head .row1 { display:flex; align-items:center; gap:14px; position:relative; z-index:1; }
      .kgj-logo { width:44px; height:44px; border-radius:12px; background:rgba(255,255,255,.18); display:grid; place-items:center; font-weight:800; font-size:17px; letter-spacing:-.5px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.25); }
      .kgj-title { font-size:18px; font-weight:750; letter-spacing:-.2px; }
      .kgj-sub { font-size:12.5px; opacity:.85; margin-top:2px; }
      .kgj-sub code { background:rgba(255,255,255,.16); padding:1px 6px; border-radius:6px; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
      .kgj-x { margin-left:auto; width:34px; height:34px; border-radius:10px; border:none; background:rgba(255,255,255,.16); color:#fff; font-size:18px; cursor:pointer; }
      .kgj-x:hover { background:rgba(255,255,255,.28); }
      .kgj-prog { position:relative; z-index:1; margin-top:16px; }
      .kgj-prog .track { height:8px; border-radius:99px; background:rgba(255,255,255,.2); overflow:hidden; display:flex; }
      .kgj-prog .seg { height:100%; transition:width .4s ease; }
      .kgj-prog .lbl { display:flex; justify-content:space-between; font-size:12px; margin-top:6px; opacity:.9; }
      .kgj-body { flex:1; overflow:auto; padding:18px 24px 28px; display:flex; flex-direction:column; gap:14px; }
      .kgj-card { background:var(--bg); border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow:0 1px 2px rgba(15,18,34,.04); }
      .kgj-sec { display:flex; align-items:center; gap:8px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--mut); margin-bottom:12px; }
      .kgj-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      @media (max-width:720px){ .kgj-grid2{grid-template-columns:1fr} .kgj-stats{grid-template-columns:repeat(4,1fr)!important} }
      .kgj-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .kgj-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--bg); color:var(--tx); border-radius:10px; padding:8px 13px; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; }
      .kgj-btn:hover { border-color:#c7c9d9; background:#fafaff; transform:translateY(-1px); }
      .kgj-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }
      .kgj-btn.primary { background:linear-gradient(120deg,var(--acc),var(--acc2)); border-color:transparent; color:#fff; box-shadow:0 6px 16px rgba(79,70,229,.3); }
      .kgj-btn.primary:hover { box-shadow:0 8px 22px rgba(79,70,229,.4); }
      .kgj-btn.soft { background:#eef0ff; border-color:#e0e3ff; color:var(--acc); }
      .kgj-btn.ghost { border-color:transparent; background:transparent; color:var(--mut); }
      .kgj-btn.ghost:hover { background:#f0f1f6; color:var(--tx); }
      .kgj-btn.danger { color:var(--bad); }
      .kgj-btn.sm { padding:5px 9px; font-size:12px; border-radius:8px; }
      .kgj-drop { border:1.5px dashed #c9cbe0; border-radius:14px; padding:16px; display:flex; align-items:center; gap:14px; cursor:pointer; transition:all .15s; background:#fbfbfe; }
      .kgj-drop:hover, .kgj-drop.over { border-color:var(--acc); background:#f4f4ff; }
      .kgj-drop .ic { width:42px; height:42px; border-radius:12px; display:grid; place-items:center; background:#e9fbe9; font-size:20px; flex:none; }
      .kgj-drop b { font-size:13.5px; }
      .kgj-hint { font-size:12px; color:var(--mut); line-height:1.5; }
      .kgj-seg { display:inline-flex; background:#f0f1f6; border-radius:10px; padding:3px; gap:2px; }
      .kgj-seg button { border:none; background:transparent; padding:6px 12px; border-radius:8px; font-size:12.5px; font-weight:600; color:var(--mut); cursor:pointer; }
      .kgj-seg button.on { background:var(--bg); color:var(--acc); box-shadow:0 1px 3px rgba(15,18,34,.12); }
      .kgj-tog { display:flex; align-items:flex-start; gap:10px; padding:7px 0; cursor:pointer; font-size:13px; }
      .kgj-tog input { display:none; }
      .kgj-tog .sw { flex:none; width:36px; height:21px; border-radius:99px; background:#d5d7e3; position:relative; transition:background .15s; margin-top:1px; }
      .kgj-tog .sw:after { content:""; position:absolute; top:2.5px; left:2.5px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.2); transition:transform .15s; }
      .kgj-tog input:checked + .sw { background:var(--acc); }
      .kgj-tog input:checked + .sw:after { transform:translateX(15px); }
      .kgj-tog small { display:block; color:var(--mut); font-size:11.5px; margin-top:1px; }
      .kgj-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(82px,1fr)); gap:8px; }
      .kgj-stat { border:1px solid var(--line); border-radius:12px; padding:10px 11px; cursor:pointer; background:var(--bg); text-align:left; transition:all .15s; }
      .kgj-stat:hover { transform:translateY(-1px); }
      .kgj-stat.on { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 16%,transparent); }
      .kgj-stat .n { font-size:21px; font-weight:780; color:var(--c); letter-spacing:-.5px; }
      .kgj-stat .l { font-size:11.5px; color:var(--mut); margin-top:1px; white-space:nowrap; }
      .kgj-search { flex:1; min-width:200px; border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:13px; background:var(--bg); outline:none; }
      .kgj-search:focus { border-color:var(--acc); box-shadow:0 0 0 3px rgba(79,70,229,.12); }
      .kgj-list { display:flex; flex-direction:column; gap:8px; }
      .kgj-item { display:grid; grid-template-columns:22px 1fr auto; gap:12px; align-items:start; background:var(--bg); border:1px solid var(--line); border-left:3px solid var(--c); border-radius:12px; padding:12px 14px; font-size:12.5px; }
      .kgj-item input[type=checkbox] { width:16px; height:16px; margin-top:2px; accent-color:var(--acc); }
      .kgj-item .nm { font-size:13.5px; font-weight:650; }
      .kgj-item .meta { color:var(--mut); margin-top:3px; }
      .kgj-pill { display:inline-block; font-size:11px; font-weight:650; padding:2px 8px; border-radius:99px; color:var(--c); background:color-mix(in srgb,var(--c) 11%,#fff); margin-left:6px; vertical-align:1px; }
      .kgj-diff { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .kgj-chg { display:inline-flex; align-items:center; gap:6px; background:var(--bg2); border:1px solid var(--line); border-radius:8px; padding:3px 8px; font-variant-numeric:tabular-nums; }
      .kgj-chg .k { font-weight:700; color:var(--acc); font-size:11px; }
      .kgj-chg .o { color:var(--mut); text-decoration:line-through; text-decoration-color:rgba(220,38,38,.5); }
      .kgj-chg .a { color:var(--tx); font-weight:650; }
      .kgj-chg .u { color:var(--mut); font-size:11px; }
      .kgj-item .why { margin-top:7px; color:var(--c); line-height:1.45; }
      .kgj-item .acts { display:flex; gap:4px; }
      .kgj-empty { text-align:center; padding:36px 10px; color:var(--mut); font-size:13px; }
      .kgj-more { text-align:center; font-size:12px; color:var(--mut); padding:6px; }
      .kgj-launch { position:fixed; left:16px; bottom:112px; z-index:999999; display:flex; align-items:center; gap:8px; border:none; border-radius:999px; padding:10px 16px 10px 12px; background:linear-gradient(120deg,#4f46e5,#7c3aed); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 28px rgba(79,70,229,.4); transition:transform .15s; }
      .kgj-launch:hover { transform:translateY(-2px); }
      .kgj-launch .b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 6px; font-size:11.5px; font-weight:800; }
      .kgj-hud { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:1000002; width:min(640px,94vw); background:rgba(17,19,36,.92); backdrop-filter:blur(12px); color:#eef0ff; border-radius:18px; padding:14px 16px; box-shadow:0 20px 50px rgba(10,10,30,.45), inset 0 0 0 1px rgba(255,255,255,.07); font-size:13px; }
      .kgj-hud .top { display:flex; align-items:center; gap:10px; }
      .kgj-hud .spin { width:16px; height:16px; border-radius:50%; border:2.5px solid rgba(255,255,255,.2); border-top-color:#a5b4fc; animation:kgjspin .8s linear infinite; flex:none; }
      .kgj-hud .spin.wait { animation:none; border-color:#fbbf24; }
      .kgj-hud .ttl { font-weight:700; }
      .kgj-hud .dim { color:#9aa0c3; font-size:12px; }
      .kgj-hud .doc { margin-top:9px; font-weight:650; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .kgj-hud .steps { display:flex; gap:4px; margin-top:9px; }
      .kgj-hud .st { flex:1; text-align:center; font-size:10.5px; padding:4px 2px; border-radius:7px; background:rgba(255,255,255,.06); color:#7d83a8; white-space:nowrap; }
      .kgj-hud .st.done { color:#86efac; background:rgba(34,197,94,.1); }
      .kgj-hud .st.now { color:#fff; background:linear-gradient(120deg,#4f46e5,#7c3aed); font-weight:650; }
      .kgj-hud .log { margin-top:9px; color:#c7cbf0; font-size:12px; font-family:ui-monospace,Consolas,monospace; background:rgba(0,0,0,.25); border-radius:8px; padding:6px 9px; max-height:74px; overflow:hidden; line-height:1.5; }
      .kgj-hud .log div:last-child { color:#fde68a; }
      .kgj-hud .bar { height:4px; border-radius:99px; background:rgba(255,255,255,.1); margin-top:10px; overflow:hidden; }
      .kgj-hud .bar i { display:block; height:100%; background:linear-gradient(90deg,#818cf8,#c084fc); transition:width .4s; }
      .kgj-hud .kgj-btn { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.12); color:#eef0ff; padding:6px 11px; font-size:12.5px; }
      .kgj-hud .kgj-btn:hover { background:rgba(255,255,255,.16); }
      .kgj-hud .kgj-btn.go { background:#16a34a; border-color:#16a34a; }
      .kgj-hud .kgj-btn.stop { background:transparent; border-color:rgba(248,113,113,.45); color:#fca5a5; }
      .kgj-hud .wait { color:#fbbf24; animation:kgjpulse 1.6s infinite; }
      .kgj-help { left:auto; right:16px; transform:none; width:min(400px,94vw); z-index:1000001; }
      .kgj-help .kgj-pill { background:color-mix(in srgb,var(--c) 30%,transparent); color:#fff; }
      .kgj-help .tb { width:100%; border-collapse:collapse; margin-top:4px; font-size:12px; font-variant-numeric:tabular-nums; }
      .kgj-help .tb td { padding:2px 4px; }
      .kgj-help .tb td:first-child { color:#a5b4fc; font-weight:700; width:40px; }
      .kgj-help .tb .o { color:#9aa0c3; text-decoration:line-through; }
      .kgj-help .tb .n { color:#fff; font-weight:650; }
      .kgj-help .tb .ok { color:#86efac; text-align:right; }
      .kgj-help .tb .now { color:#fde68a; text-align:right; }
      .kgj-help .kgj-btn:disabled { opacity:.4; }
      .kgj-toast { position:fixed; left:50%; top:20px; transform:translateX(-50%); z-index:1000003; background:#111324; color:#fff; padding:10px 16px; border-radius:12px; font:600 13px "Inter",ui-sans-serif,system-ui,sans-serif; box-shadow:0 12px 30px rgba(0,0,0,.3); animation:kgjfade .2s; }
    `;
    document.head.appendChild(style);
  }

  function toast(msg) {
    ensureStyles();
    const t = document.createElement("div");
    t.className = "kgj-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function counts() {
    const c = { all: 0 };
    Object.keys(STATUS).forEach((k) => (c[k] = 0));
    loadQueue().forEach((q) => {
      c.all++;
      c[q.status] = (c[q.status] || 0) + 1;
    });
    return c;
  }

  // ---------- Panel ----------
  const ui = { filter: "all", search: "", selected: new Set(), limit: 60, file: "" };

  function closePanel() {
    document.getElementById("kgj-panel")?.remove();
  }

  function itemHtml(q) {
    const st = STATUS[q.status] || STATUS.pending;
    const names = q.targets.map((t) => esc(t.nama || "(tanpa nama)")).join(" <span style='color:#a0a4bb'>+</span> ");
    const diff = q.targets
      .map((t) => {
        const ch = (k, o, n) =>
          o === n
            ? `<span class="kgj-chg"><span class="k">${k}</span><span class="u">${rupiah(n)} (tetap)</span></span>`
            : `<span class="kgj-chg"><span class="k">${k}</span><span class="o">${rupiah(o)}</span>→<span class="a">${rupiah(n)}</span></span>`;
        return `${q.targets.length > 1 ? `<span class="kgj-chg"><span class="u">${esc((t.nama || "").split("(")[0].trim())}</span></span>` : ""}${FIELDS.map(([k, , l]) => ch(l, t.old[k], t.neu[k])).join("")}`;
      })
      .join("");
    const meta = [q.kec, q.desa, q.sls, q.targets.length > 1 ? `${q.targets.length} usaha` : "", q.statusAwal].filter(Boolean).map(esc).join(" · ");
    return `<div class="kgj-item" style="--c:${st.color}">
      <input type="checkbox" data-sel="${q.id}" ${ui.selected.has(q.id) ? "checked" : ""}>
      <div style="min-width:0">
        <div class="nm">${names}<span class="kgj-pill">${st.label}</span></div>
        <div class="meta">${meta}</div>
        <div class="kgj-diff">${diff}</div>
        ${q.reason ? `<div class="why">${esc(q.reason)}</div>` : ""}
      </div>
      <div class="acts">
        <a class="kgj-btn sm ghost" href="${esc(docUrl(q))}" target="_blank" title="Buka dokumen di tab baru">↗</a>
        <a class="kgj-btn sm ghost" href="${esc(docUrl(q))}" data-manual="${q.id}" title="Kerjakan manual: buka dokumen di tab ini, panel bantu muncul di kanan bawah">✍</a>
        <button class="kgj-btn sm soft" data-one="${q.id}" title="Jalankan dokumen ini saja">▶</button>
      </div>
    </div>`;
  }

  function filteredItems() {
    const s = normalize(ui.search);
    return loadQueue().filter(
      (q) =>
        (ui.filter === "all" || q.status === ui.filter) &&
        (!s || normalize([q.kec, q.desa, q.sls, ...q.targets.map((t) => `${t.nama} ${t.idsbr}`)].join(" ")).includes(s)),
    );
  }

  function renderDynamic(root) {
    const c = counts();
    const doneN = c.done + c.already + c.manual;
    const pct = (n) => (c.all ? (100 * n) / c.all : 0);
    root.querySelector("[data-prog]").innerHTML = `
      <div class="track">
        <div class="seg" style="width:${pct(c.done)}%;background:#86efac"></div>
        <div class="seg" style="width:${pct(c.already)}%;background:#5eead4"></div>
        <div class="seg" style="width:${pct(c.manual)}%;background:#c4b5fd"></div>
        <div class="seg" style="width:${pct(c.yellow + c.red + c.tested)}%;background:#fcd34d"></div>
      </div>
      <div class="lbl"><span>${doneN} dari ${c.all} dokumen beres${c.forbidden ? ` · ${c.forbidden} forbidden dilewati` : ""}</span><span>${c.all ? Math.round(pct(doneN)) : 0}%</span></div>`;
    root.querySelector("[data-stats]").innerHTML = [["all", "Semua", "#4f46e5"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label, v.color])]
      .map(
        ([k, l, col]) =>
          `<button class="kgj-stat ${ui.filter === k ? "on" : ""}" style="--c:${col}" data-filter="${k}"><div class="n">${c[k] || 0}</div><div class="l">${l}</div></button>`,
      )
      .join("");
    const items = filteredItems();
    root.querySelector("[data-list]").innerHTML = items.length
      ? items.slice(0, ui.limit).map(itemHtml).join("") +
        (items.length > ui.limit ? `<div class="kgj-more"><button class="kgj-btn sm" data-more>Tampilkan ${Math.min(60, items.length - ui.limit)} lagi (sisa ${items.length - ui.limit})</button></div>` : "")
      : `<div class="kgj-empty">${c.all ? "Tidak ada dokumen di filter ini." : "📄 Muat file Excel koreksi dulu."}</div>`;
    root.querySelector("[data-selinfo]").textContent = ui.selected.size ? `${ui.selected.size} dicentang` : "";
    const pend = c.pending;
    root.querySelectorAll("[data-needpend]").forEach((b) => (b.disabled = !pend));
    root.querySelectorAll("[data-runsel]").forEach((b) => (b.disabled = !ui.selected.size));
  }

  function refreshPanel() {
    const root = document.getElementById("kgj-panel");
    if (!root) return;
    const a = document.activeElement;
    if (a && root.contains(a) && a.matches("input.kgj-search")) {
      renderDynamic(root); // pencarian tidak kehilangan fokus karena input-nya tidak digambar ulang
      return;
    }
    const body = root.querySelector(".kgj-body");
    const top = body ? body.scrollTop : 0;
    renderDynamic(root);
    if (body) body.scrollTop = top;
  }

  function openPanel() {
    ensureStyles();
    closePanel();
    const conf = loadConf();
    const overlay = document.createElement("div");
    overlay.id = "kgj-panel";
    overlay.className = "kgj kgj-overlay";
    overlay.innerHTML = `
      <div class="kgj-sheet">
        <div class="kgj-head">
          <div class="row1">
            <div class="kgj-logo">${esc(APP.badge)}</div>
            <div>
              <div class="kgj-title">${esc(APP.title)}</div>
              <div class="kgj-sub">${FIELDS.map(([, , l, , , x]) => `<code>${esc(l)} ← ${esc(x)}</code>`).join(" &nbsp; ")} &nbsp;· buka → ganti → kirim → approve</div>
            </div>
            <button class="kgj-x" data-act="close" title="Tutup (Esc)">×</button>
          </div>
          <div class="kgj-prog" data-prog></div>
        </div>
        <div class="kgj-body">
          <div class="kgj-grid2">
            <div class="kgj-card">
              <div class="kgj-sec">① Data Excel</div>
              <label class="kgj-drop" data-drop>
                <div class="ic">📊</div>
                <div style="min-width:0">
                  <b>${esc(ui.file || (loadQueue().length ? "Antrean tersimpan di browser" : "Pilih / seret file .xlsx"))}</b>
                  <div class="kgj-hint">Kolom: <i>link, nama_usaha, ${FIELDS.map(([, id, , , , x]) => `${id} → ${x}`).join(", ")}</i>. Muat ulang file yang sama tidak menghapus progres.</div>
                </div>
                <input type="file" accept=".xlsx" data-file hidden>
              </label>
              <div class="kgj-row" style="margin-top:12px">
                <button class="kgj-btn sm" data-act="csv">⬇ Laporan CSV</button>
                <button class="kgj-btn sm" data-act="export">💾 Ekspor</button>
                <button class="kgj-btn sm" data-act="import">📂 Impor</button>
                <button class="kgj-btn sm ghost danger" data-act="clear">Hapus antrean</button>
                <input type="file" accept=".json" data-importfile hidden>
              </div>
            </div>
            <div class="kgj-card">
              <div class="kgj-sec">② Pengaturan</div>
              <div class="kgj-seg" data-speed>${SPEEDS.map((s, i) => `<button data-speed="${i}" class="${Number(conf.speed) === i ? "on" : ""}">${s.name}</button>`).join("")}</div>
              <div style="margin-top:8px">
                <label class="kgj-tog"><input type="checkbox" data-conf="checkFirst" ${conf.checkFirst ? "checked" : ""}><span class="sw"></span><span>Cek dulu di Review<small>Kalau nilainya sudah benar, dokumen tidak di-revoke</small></span></label>
                <label class="kgj-tog"><input type="checkbox" data-conf="approve" ${conf.approve ? "checked" : ""}><span class="sw"></span><span>Approve setelah kirim</span></label>
                <label class="kgj-tog"><input type="checkbox" data-conf="forceOnGalat" ${conf.forceOnGalat ? "checked" : ""}><span class="sw"></span><span>Submit Paksa kalau ada galat<small>Mati: dokumen bergalat ditandai "Perlu cek"</small></span></label>
              </div>
            </div>
          </div>

          <div class="kgj-card">
            <div class="kgj-sec">③ Jalankan</div>
            <div class="kgj-row">
              <button class="kgj-btn soft" data-act="test" data-needpend>🧪 Uji 1 dokumen</button>
              <button class="kgj-btn" data-act="n5" data-needpend>▶ 5</button>
              <button class="kgj-btn" data-act="n20" data-needpend>▶ 20</button>
              <button class="kgj-btn" data-act="runsel" data-runsel>▶ Yang dicentang</button>
              <button class="kgj-btn primary" data-act="all" data-needpend>⚡ Jalankan semua</button>
              <span style="flex:1"></span>
              <button class="kgj-btn sm ghost" data-act="retry" title="Perlu cek, Gagal & Terisi (uji) dikembalikan ke Belum">↻ Ulangi yang bermasalah</button>
            </div>
            <div class="kgj-hint" style="margin-top:10px">Bisa dimulai dari halaman FASIH mana saja — tiap dokumen dibuka lewat link di Excel. Kalau link-nya tidak membuka dokumen yang benar, dokumen dicari lewat Filter desa/SLS di halaman daftar assignment: BKU dulu, kalau tidak ada dokumen keluarganya (buka halaman daftar itu sekali dulu). Mode uji berhenti tepat sebelum Kirim. Gagal terus? Kerjakan manual lewat tombol ✍ di tiap baris. Pintasan panel: <b>Alt+${APP.hotkey}</b>.</div>
          </div>

          <div class="kgj-stats" data-stats></div>

          <div class="kgj-row">
            <input class="kgj-search" placeholder="Cari nama usaha, desa, kecamatan, idsbr…" value="${esc(ui.search)}">
            <button class="kgj-btn sm" data-act="selall">☑ Centang yang tampil</button>
            <button class="kgj-btn sm ghost" data-act="selnone">Kosongkan</button>
            <button class="kgj-btn sm" data-act="setstatus" data-runsel title="Hasil cek manual: tentukan status dokumen yang dicentang (ikut ke Laporan CSV)">🏷 Atur status</button>
            <span class="kgj-hint" data-selinfo></span>
          </div>
          <div class="kgj-list" data-list></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    renderDynamic(overlay);

    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closePanel();
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closePanel();
    });
    const fileInput = overlay.querySelector("[data-file]");
    fileInput.addEventListener("change", () => fileInput.files[0] && loadExcel(fileInput.files[0]));
    const drop = overlay.querySelector("[data-drop]");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) loadExcel(f);
    });
    const imp = overlay.querySelector("[data-importfile]");
    imp.addEventListener("change", () => imp.files[0] && importJson(imp.files[0]));
    overlay.querySelector(".kgj-search").addEventListener("input", (e) => {
      ui.search = e.target.value;
      ui.limit = 60;
      renderDynamic(overlay);
    });
    overlay.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-sel]");
      if (sel) {
        sel.checked ? ui.selected.add(sel.dataset.sel) : ui.selected.delete(sel.dataset.sel);
        renderDynamic(overlay);
      }
      const cf = e.target.closest("[data-conf]");
      if (cf) {
        const c = loadConf();
        c[cf.dataset.conf] = cf.checked;
        saveConf(c);
      }
    });
    overlay.addEventListener("click", (e) => {
      const sp = e.target.closest("button[data-speed]");
      if (sp) {
        const c = loadConf();
        c.speed = Number(sp.dataset.speed);
        saveConf(c);
        overlay.querySelectorAll("button[data-speed]").forEach((b) => b.classList.toggle("on", b === sp));
        return;
      }
      const f = e.target.closest("[data-filter]");
      if (f) {
        ui.filter = f.dataset.filter;
        ui.limit = 60;
        return renderDynamic(overlay);
      }
      if (e.target.closest("[data-more]")) {
        ui.limit += 60;
        return renderDynamic(overlay);
      }
      const man = e.target.closest("[data-manual]");
      if (man) {
        e.preventDefault();
        if (loadRun().running) stopRun("Dihentikan untuk dikerjakan manual.");
        try {
          localStorage.removeItem(HELPER_KEY);
        } catch (err) {}
        location.href = man.getAttribute("href");
        return;
      }
      const one = e.target.closest("[data-one]");
      if (one) {
        updateItem(one.dataset.one, { status: "pending", reason: "" });
        return startRun({ onlyIds: [one.dataset.one] });
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "close") closePanel();
      if (act === "test") startRun({ limit: 1, testMode: true });
      if (act === "n5") startRun({ limit: 5 });
      if (act === "n20") startRun({ limit: 20 });
      if (act === "all") {
        if (confirm(`Jalankan ${counts().pending} dokumen sekarang (Kirim${loadConf().approve ? " + Approve" : ""} otomatis)?`)) startRun({});
      }
      if (act === "runsel") {
        const ids = Array.from(ui.selected);
        const q = loadQueue();
        q.forEach((x) => ids.includes(x.id) && !FINISHED.includes(x.status) && Object.assign(x, { status: "pending", reason: "" }));
        saveQueue(q);
        startRun({ onlyIds: ids.filter((id) => q.find((x) => x.id === id && x.status === "pending")) });
      }
      if (act === "retry") {
        // Forbidden tidak ikut diulang (aksesnya tetap tidak ada); kalau mau, pakai 🏷 Atur status → Belum
        const q = loadQueue();
        let n = 0;
        q.forEach((x) => {
          if (/yellow|red|tested/.test(x.status)) {
            x.status = "pending";
            x.reason = "";
            x.searched = false;
            x.findCands = null;
            n++;
          }
        });
        saveQueue(q);
        toast(`${n} dokumen dikembalikan ke "Belum".`);
        renderDynamic(overlay);
      }
      if (act === "selall") {
        filteredItems().forEach((q) => ui.selected.add(q.id));
        renderDynamic(overlay);
      }
      if (act === "setstatus" && ui.selected.size)
        openStatusPicker(Array.from(ui.selected), () => {
          ui.selected.clear();
          renderDynamic(overlay);
        });
      if (act === "selnone") {
        ui.selected.clear();
        renderDynamic(overlay);
      }
      if (act === "csv") exportCsv();
      if (act === "export") exportJson();
      if (act === "import") overlay.querySelector("[data-importfile]").click();
      if (act === "clear" && confirm("Hapus seluruh antrean & progres di browser ini?")) {
        saveQueue([]);
        ui.selected.clear();
        ui.file = "";
        openPanel();
      }
    });
  }

  // Atur status dokumen secara manual (hasil cek manual); alasannya dicatat & ikut ke Laporan CSV
  function applyStatus(ids, status, note) {
    const q = loadQueue();
    q.filter((x) => ids.includes(x.id)).forEach((x) => {
      const before = (STATUS[x.status] || {}).label || x.status;
      x.status = status;
      if (status === "pending") {
        x.reason = note ? `diatur manual: ${note}` : "";
        delete x.doneAt;
      } else {
        x.reason = `diatur manual → ${STATUS[status].label}${note ? `: ${note}` : ""} (sebelumnya: ${before})`;
        x.doneAt = new Date().toISOString();
      }
    });
    saveQueue(q);
  }
  function openStatusPicker(ids, onDone) {
    document.getElementById("kgj-status")?.remove();
    ensureStyles();
    const modal = document.createElement("div");
    modal.id = "kgj-status";
    modal.className = "kgj kgj-overlay";
    modal.style.cssText = "align-items:center;justify-content:center;z-index:1000003;";
    const options = Object.entries(STATUS)
      .map(
        ([k, v]) =>
          `<button class="kgj-btn" data-status="${k}" style="justify-content:flex-start;text-align:left;border-left:4px solid ${v.color}"><span><b>${v.label}</b><br><span class="kgj-hint">${STATUS_HINT[k] || ""}</span></span></button>`,
      )
      .join("");
    modal.innerHTML = `<div class="kgj-card" style="width:min(440px,92vw);max-height:90vh;overflow:auto">
      <div class="kgj-sec">🏷 Atur status · ${ids.length} dokumen</div>
      <textarea class="kgj-search" data-note rows="2" placeholder="Catatan (opsional), mis. sudah dikoreksi manual di FASIH" style="width:100%;resize:vertical"></textarea>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">${options}<button class="kgj-btn ghost" data-status="">Batal</button></div>
    </div>`;
    modal.addEventListener("keydown", (e) => e.stopPropagation());
    modal.addEventListener("click", (e) => {
      if (e.target === modal) return modal.remove();
      const b = e.target.closest("[data-status]");
      if (!b) return;
      const note = modal.querySelector("[data-note]").value.trim();
      modal.remove();
      if (!b.dataset.status) return;
      applyStatus(ids, b.dataset.status, note);
      if (onDone) onDone();
    });
    document.body.appendChild(modal);
    modal.querySelector("[data-note]").focus();
  }

  async function loadExcel(file) {
    try {
      const { items, sheet, rows, skipped } = await parseWorkbook(await file.arrayBuffer());
      // Pertahankan progres dokumen yang sudah pernah diproses (id sama)
      const old = new Map(loadQueue().map((q) => [q.id, q]));
      let kept = 0;
      const merged = items.map((it) => {
        const o = old.get(it.id);
        if (o && o.status !== "pending") {
          kept++;
          return { ...it, status: o.status, reason: o.reason, result: o.result, doneAt: o.doneAt, cardHints: o.cardHints };
        }
        return it;
      });
      saveQueue(merged);
      ui.file = file.name;
      ui.selected.clear();
      openPanel();
      toast(`${rows - skipped} baris → ${merged.length} dokumen dari sheet "${sheet}"${kept ? ` · ${kept} progres lama dipertahankan` : ""}${skipped ? ` · ${skipped} baris tanpa link dilewati` : ""}`);
    } catch (e) {
      alert(`Gagal membaca Excel: ${e.message}`);
    }
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  // Nama wilayah untuk nama file ekspor, dari kecamatan/desa yang ada di antrean
  function wilayahTag() {
    const queue = loadQueue();
    const kecs = [...new Set(queue.map((q) => q.kec).filter(Boolean))];
    const desas = [...new Set(queue.map((q) => q.desa).filter(Boolean))];
    let tag = "semua-wilayah";
    if (desas.length === 1) tag = kecs.length === 1 ? `${kecs[0]}-${desas[0]}` : desas[0];
    else if (kecs.length === 1) tag = kecs[0];
    else if (kecs.length > 1) tag = `${kecs.length}-kecamatan`;
    return tag.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").slice(0, 80);
  }

  function exportCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      [
        "no", "baris_excel", "nama_usaha", "idsbr", "kec", "desa", "sls",
        ...FIELDS.map((f) => `${f[6]}_lama`), ...FIELDS.map((f) => `${f[6]}_baru`),
        "status", "keterangan", "hasil", "waktu", "link",
      ].join(","),
    ];
    loadQueue().forEach((q) =>
      q.targets.forEach((t) =>
        lines.push(
          [
            t.no, t.row, t.nama, t.idsbr, q.kec, q.desa, q.sls,
            ...FIELDS.map(([k]) => t.old[k]), ...FIELDS.map(([k]) => t.neu[k]),
            (STATUS[q.status] || {}).label, q.reason, q.result, q.doneAt, docUrl(q),
          ]
            .map(cell)
            .join(","),
        ),
      ),
    );
    download(`laporan-${APP.file}-${wilayahTag()}-${stamp()}.csv`, "﻿" + lines.join("\n"), "text/csv");
  }
  function exportJson() {
    download(`antrean-${APP.file}-${wilayahTag()}-${stamp()}.json`, JSON.stringify({ v: 1, queue: loadQueue(), conf: loadConf() }), "application/json");
  }
  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.queue) || data.queue.some((q) => !q.targets || q.targets.some((t) => !t.neu || FIELDS.some(([k]) => !(k in t.neu)))))
        throw new Error(`bukan file ekspor skrip ${APP.name}`);
      if (loadQueue().length && !confirm(`Timpa antrean sekarang (${loadQueue().length} dokumen) dengan isi file (${data.queue.length} dokumen)?`)) return;
      saveQueue(data.queue);
      if (data.conf) saveConf({ ...loadConf(), ...data.conf });
      ui.file = file.name;
      openPanel();
      toast(`${data.queue.length} dokumen diimpor.`);
    } catch (e) {
      alert(`Gagal impor: ${e.message}`);
    }
  }

  // ---------- Kerjakan manual: panel bantu di halaman dokumen ----------
  function markManual(id) {
    const q = loadQueue().find((x) => x.id === id);
    if (!q) return;
    const before = (STATUS[q.status] || {}).label || q.status;
    updateItem(id, {
      status: "manual",
      reason: `dikerjakan manual (sebelumnya: ${before}${q.reason ? ` — ${q.reason}` : ""})`,
      doneAt: new Date().toISOString(),
    });
  }
  const docIdHere = () => {
    const m = location.pathname.match(/\/app\/assignment\/[^/]+\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  };
  // Kartu usaha yang sedang terbuka di halaman (isian 27.a kelihatan) + nama usahanya
  function openCardNow() {
    const pend = visiblePend();
    if (!pend) return null;
    const inst = instOf(pend);
    const name = ["nama_komersial", "nama_usaha_edit", "nama_usaha"]
      .map((id) => {
        const b = box(id, inst);
        const i = b && b.querySelector("input, textarea");
        return i ? i.value.trim() : "";
      })
      .find(Boolean);
    return { inst, cur: readFields(inst), name: name || "" };
  }
  // Kartu terbuka dicocokkan ke target: nama usaha dulu, lalu nilai baru / lama, lalu satu-satunya target
  function targetFor(q, card) {
    const t = q.targets;
    const byName = card.name ? t.filter((x) => nameMatch(card.name, x.nama) >= NAME_OK) : [];
    if (byName.length === 1) return byName[0];
    const pool = byName.length ? byName : t;
    return pool.find((x) => eqAll(card.cur, x.neu)) || pool.find((x) => oldOrNew(card.cur, x)) || (t.length === 1 ? t[0] : null);
  }

  let helpSig = "";
  let helpBusy = false;
  function updateHelper() {
    let el = document.getElementById("kgj-help");
    const id = docIdHere();
    const q = id && !loadRun().running ? loadQueue().find((x) => did(x) === id || x.id === id) : null;
    if (!q || loadJson(HELPER_KEY, null) === id) {
      if (el) el.remove();
      helpSig = "";
      return;
    }
    if (!document.body) return;
    ensureStyles();
    if (!el) {
      el = document.createElement("div");
      el.id = "kgj-help";
      el.className = "kgj kgj-hud kgj-help";
      el.addEventListener("click", onHelperClick);
      document.body.appendChild(el);
    }
    const card = openCardNow();
    const editing = onEditOf(id);
    const sig = JSON.stringify([q.status, q.reason, card && card.cur, card && card.name, editing, helpBusy]);
    if (sig === helpSig) return;
    helpSig = sig;
    const st = STATUS[q.status] || STATUS.pending;
    const t = card ? targetFor(q, card) : null;
    const rows = q.targets
      .map(
        (x) => `<div class="doc" style="margin-top:8px">${esc(x.nama)}</div>
        <table class="tb">${FIELDS.map(([k, , l]) => {
          const now = card && t === x ? card.cur[k] : null;
          const ok = now !== null && now === x.neu[k];
          return `<tr><td>${l}</td><td class="o">${rupiah(x.old[k])}</td><td>→</td><td class="n">${rupiah(x.neu[k])}</td><td class="${ok ? "ok" : "now"}">${now === null ? "" : ok ? "✓" : rupiah(now)}</td></tr>`;
        }).join("")}</table>`,
      )
      .join("");
    const nameWarn = card && t && card.name && nameMatch(card.name, t.nama) < NAME_OK ? ` ⚠ nama di kartu "${esc(card.name)}" beda dengan Excel` : "";
    const hint = !editing
      ? "Klik Edit (revoke kalau perlu), lalu buka kartu usahanya."
      : card
        ? `Kartu terbuka${t ? ` → ${esc(t.nama)}` : " (tidak cocok dengan Excel)"}${nameWarn}. Kolom kanan = isi sekarang.`
        : "Buka kartu usaha yang mau dikoreksi.";
    el.innerHTML = `
      <div class="top">
        <div class="ttl">✍ ${esc(APP.name)} — manual</div>
        <span class="kgj-pill" style="--c:${st.color}">${st.label}</span>
        <span style="flex:1"></span>
        <button class="kgj-btn" data-help="hide" title="Sembunyikan untuk dokumen ini">×</button>
      </div>
      ${q.reason ? `<div class="dim" style="margin-top:6px">${esc(q.reason)}</div>` : ""}
      ${rows}
      <div class="dim" style="margin-top:8px">${hint}</div>
      <div class="kgj-row" style="margin-top:10px">
        <button class="kgj-btn go" data-help="fill" ${editing && card && !helpBusy ? "" : "disabled"}>✏ Isi ke kartu ini</button>
        <button class="kgj-btn" data-help="done">✓ Tandai selesai manual</button>
        <button class="kgj-btn" data-help="status" title="Pilih status lain (Perlu cek, Gagal, Sudah sesuai, …)">🏷 Status…</button>
        <button class="kgj-btn" data-help="auto" title="Kembalikan ke Belum & jalankan otomatis dokumen ini">↻ Otomatis</button>
      </div>`;
  }
  async function onHelperClick(e) {
    const act = e.target.closest("[data-help]")?.dataset.help;
    const here = docIdHere();
    const q = here && loadQueue().find((x) => did(x) === here || x.id === here);
    if (!act || !q) return;
    if (act === "hide") {
      saveJson(HELPER_KEY, here);
      return updateHelper();
    }
    if (act === "done") {
      markManual(q.id);
      toast("Ditandai Selesai manual.");
      return updateHelper();
    }
    if (act === "status")
      return openStatusPicker([q.id], () => {
        helpSig = "";
        updateHelper();
      });
    if (act === "auto") {
      updateItem(q.id, { status: "pending", reason: "" });
      return startRun({ onlyIds: [q.id] });
    }
    if (act === "fill" && !helpBusy) {
      const card = openCardNow();
      let t = card && targetFor(q, card);
      if (!t && card && q.targets.length > 1) {
        const pick = prompt(`Kartu ini untuk usaha yang mana?\n${q.targets.map((x, i) => `${i + 1}. ${x.nama}`).join("\n")}`, "1");
        t = q.targets[Number(pick) - 1];
      }
      if (!t) return toast("Kartu yang terbuka tidak cocok dengan baris Excel dokumen ini.");
      const warn = [];
      if (card.name && nameMatch(card.name, t.nama) < NAME_OK) warn.push(`nama usaha di kartu "${card.name}" beda dengan Excel "${t.nama}"`);
      if (!eqAll(card.cur, t.neu) && !oldOrNew(card.cur, t)) warn.push(`nilai di kartu (${fmtCur(card.cur)}) beda dari Excel`);
      if (warn.length && !confirm(`Perhatian: ${warn.join("; ")}.\n\nTetap ganti ke nilai baru?`)) return;
      helpBusy = true;
      updateHelper();
      try {
        await writeCard(card.inst, t, card.cur);
        updateItem(q.id, { result: `${t.nama.split("(")[0].trim()}: ${fmtChange(card.cur, t) || "sudah sesuai"} (manual)` });
        toast("Nilai sudah diganti. Kirim & Approve di FASIH, lalu klik “Tandai selesai manual”.");
      } catch (err) {
        alert(`Gagal mengisi: ${err.message}`);
      } finally {
        helpBusy = false;
        helpSig = "";
        updateHelper();
      }
    }
  }

  // ---------- HUD saat berjalan ----------
  let hudSig = "";
  function updateHud() {
    const run = loadRun();
    let hud = document.getElementById("kgj-hud");
    if (!run.running) {
      if (hud) hud.remove();
      hudSig = "";
      return;
    }
    if (!document.body) return;
    ensureStyles();
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "kgj-hud";
      hud.className = "kgj kgj-hud";
      hud.addEventListener("click", (e) => {
        const act = e.target.closest("[data-hud]")?.dataset.hud;
        if (act === "stop") stopRun("Dihentikan.");
        if (act === "hold") setHold(true);
        if (act === "resume") setHold(false);
        if (act === "panel") openPanel();
        if (act === "go") {
          const r = loadRun();
          if (r.cur) r.cur.confirmed = r.cur.stage;
          r.paused = null;
          r.phaseAt = Date.now();
          saveRun(r);
          updateHud();
        }
        if (act === "pass") {
          const r = loadRun();
          if (r.cur) finishItem(r.cur.id, "tested", "MODE UJI: nilai diganti tapi TIDAK dikirim (dokumen masih terbuka edit)");
        }
      });
      document.body.appendChild(hud);
    }
    const it = run.cur ? loadQueue().find((q) => q.id === run.cur.id) : null;
    const iNow = run.cur ? STEPS.findIndex(([k]) => k === run.cur.stage) : -1;
    const limited = rateLimited();
    const total = run.total || 0;
    const done = run.processed || 0;
    const sig = JSON.stringify([run.cur, run.paused, run.logs, limited, done, run.testMode, run.hold]);
    if (sig === hudSig) return;
    hudSig = sig;
    hud.innerHTML = `
      <div class="top">
        <div class="spin ${run.paused || run.hold || limited ? "wait" : ""}"></div>
        <div class="ttl">${esc(APP.name)}</div>
        <div class="dim">${run.hold ? "⏸ DIJEDA · " : ""}${T().name}${run.testMode ? " · Mode uji" : ""} · ${done}/${total} dokumen</div>
        <span style="flex:1"></span>
        ${run.paused ? `<button class="kgj-btn go" data-hud="go">✓ Kirim sekarang</button><button class="kgj-btn" data-hud="pass">Lewati</button>` : ""}
        ${run.hold ? `<button class="kgj-btn go" data-hud="resume">▶ Lanjut</button>` : `<button class="kgj-btn" data-hud="hold" title="Tahan sementara; langkah yang sedang jalan dilanjutkan dari titik yang sama">⏸ Jeda</button>`}
        <button class="kgj-btn" data-hud="panel" title="Buka panel">☰</button>
        <button class="kgj-btn stop" data-hud="stop">■ Stop</button>
      </div>
      ${run.hold ? `<div class="doc wait">⏸ Dijeda sejak ${new Date(run.hold.at).toLocaleTimeString("id-ID")} — jangan pindah halaman / klik isian supaya bisa dilanjutkan dengan aman</div>` : ""}
      ${limited ? `<div class="doc wait">⛔ Server membatasi (429) — lanjut otomatis ${new Date(rateInfo().until).toLocaleTimeString("id-ID")}</div>` : ""}
      ${it ? `<div class="doc">▶ ${esc(it.targets.map((t) => t.nama).join(" + "))} <span class="dim">· ${esc([it.desa, it.sls].filter(Boolean).join(" · "))}</span></div>` : ""}
      ${it ? `<div class="steps">${STEPS.map(([k, l], i) => `<div class="st ${i < iNow ? "done" : i === iNow ? "now" : ""}">${i < iNow ? "✓ " : ""}${l}</div>`).join("")}</div>` : ""}
      <div class="log">${(run.logs || []).map((l) => `<div>${esc(l)}</div>`).join("") || "<div>…</div>"}</div>
      <div class="bar"><i style="width:${total ? Math.min(100, (100 * done) / total) : 0}%"></i></div>`;
  }

  function ensureLauncher() {
    if (!document.body || document.getElementById("kgj-launch")) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "kgj-launch";
    btn.className = "kgj-launch";
    btn.innerHTML = `<span class="b">${esc(APP.badge)}</span> ${esc(APP.launch)}`;
    btn.title = `Buka panel (Alt+${APP.hotkey})`;
    btn.style.bottom = `${APP.launchBottom}px`;
    btn.onclick = openPanel;
    document.body.appendChild(btn);
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === APP.hotkey) {
      e.preventDefault();
      document.getElementById("kgj-panel") ? closePanel() : openPanel();
    }
  });

  // Halaman dimuat ulang saat berjalan -> lanjut dari tahap terakhir
  let lastPanelRefresh = 0;
  setInterval(() => {
    ensureLauncher();
    if (isListPage() && loadJson(LIST_KEY, "") !== location.href) saveJson(LIST_KEY, location.href);
    const run = loadRun();
    if (run.running && !busy) tick();
    if (run.running) updateHud();
    updateHelper();
    if (Date.now() - lastPanelRefresh > 1500) {
      lastPanelRefresh = Date.now();
      refreshPanel();
    }
  }, 700);

  console.log(`[${APP.name} v${APP.version}] Aktif. Tombol di kiri bawah (Alt+${APP.hotkey}).`);
})();
