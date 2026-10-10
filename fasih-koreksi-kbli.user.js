// ==UserScript==
// @name         FASIH Koreksi KBLI & Anomali
// @namespace    hanif-bps-hst
// @version      1.4
// @description  Baca Excel "Pengecekan KBLI" (Edit KBLI = 1), buka tiap dokumen, ganti KBLI akhir ke KBLI Baru di kartu usaha yang tepat, sesuaikan produk & kegiatan utama kalau ada Produk Baru, tandai anomali KBLI "Ya, Sesuai Kondisi Lapangan" lalu Kirim & Approve.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Excel dibaca di browser ini saja; datanya tidak dikirim ke mana pun selain isian FASIH.
  const QUEUE_KEY = "kk_queue";
  const CONF_KEY = "kk_conf";
  const RUN_KEY = "kk_run";
  const AREA_KEY = "kk_area_titles";
  const LIST_KEY = "kk_list_url"; // halaman daftar assignment terakhir yang dibuka (untuk cari lewat filter)
  const HELPER_KEY = "kk_helper_hidden";
  const HELPER_POS_KEY = "kk_helper_pos"; // posisi panel bantu yang digeser
  const HELPER_MIN_KEY = "kk_helper_min"; // panel bantu diperkecil
  const HUD_POS_KEY = "kk_hud_pos"; // posisi bar progres yang digeser
  const HUD_MIN_KEY = "kk_hud_min"; // bar progres diperkecil
  const RATE_KEY = "fasih_rate_limit"; // sama dengan skrip FASIH lain: jeda 429 berlaku bersama

  const APP = {
    name: "Koreksi KBLI",
    version: "1.4",
    title: "Koreksi KBLI & Anomali",
    badge: "KBLI",
    launch: "Koreksi KBLI",
    hotkey: "5",
    launchBottom: 208,
    file: "koreksi-kbli",
  };

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
    done: "KBLI sudah dikoreksi, dikirim & approve",
    already: "KBLI (dan produk) di FASIH memang sudah sesuai Excel",
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
    if (origFetch && !origFetch.__kk) {
      const wrapped = function (input) {
        return origFetch.apply(this, arguments).then((res) => {
          if (res && res.status === 429) noteRateLimit(typeof input === "string" ? input : input && input.url);
          return res;
        });
      };
      wrapped.__kk = true;
      window.fetch = wrapped;
    }
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && !XHR.__kk) {
      const origOpen = XHR.open;
      const origSend = XHR.send;
      XHR.open = function (method, url) {
        this.__kkUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.send = function () {
        this.addEventListener("loadend", () => {
          if (this.status === 429) noteRateLimit(this.__kkUrl);
        });
        return origSend.apply(this, arguments);
      };
      XHR.__kk = true;
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
      .filter((el) => !/^kk-/.test(el.id || "") && !/^(SCRIPT|STYLE)$/.test(el.tagName))
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

  const OWN = "#kk-panel, #kk-hud, #kk-launch, #kk-help, #kk-status";
  const normalize = (text) =>
    String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  const squash = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const visible = (el) =>
    !!el && (el.offsetParent !== null || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"));
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
    if (!typed || el.value !== value) {
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

  // =========================================================================
  // KECOCOKAN NAMA USAHA (dokumen vs Excel)
  // =========================================================================
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
  const baseName = (t) => normalize(String(t || "").replace(/\([^)]*\)/g, " "));
  const digitsOf = (s) => (s.match(/\d+/g) || []).map(Number).join(",");
  const ownerOf = (t) => normalize((String(t || "").match(/\(([^)]+)\)/) || [])[1]);
  function sameOwner(a, b) {
    if (levenshteinRatio(a, b) >= 0.8) return true;
    const [x, y] = a.length <= b.length ? [a, b] : [b, a];
    const yt = new Set(y.split(" "));
    return x.split(" ").every((w) => yt.has(w));
  }
  // Nama usaha di dokumen harus sesuai nama_usaha Excel: dibanding tanpa bagian (PEMILIK), angka harus
  // sama (USAHA 1 ≠ USAHA 2), dan kalau keduanya mencantumkan pemilik, pemiliknya harus sama.
  function nameMatch(doc, excel) {
    const c = baseName(doc) || normalize(doc);
    const e = baseName(excel) || normalize(excel);
    if (!c || !e) return 0;
    if (digitsOf(c) !== digitsOf(e)) return 0;
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

  // Kolom dicocokkan tanpa spasi/titik/tanda baca/huruf besar: "Edit KBLI (1=Ya)" = "EDITKBLI1YA".
  const ANCHOR = "KBLIBARU";
  const COLS = {
    link: ["LINK", "URL"],
    nama: ["NAMAUSAHA"],
    kec: ["KEC", "KECAMATAN"],
    desa: ["DESA"],
    sls: ["NMSLS", "SLS"],
    status: ["ASSIGNMENTSTATUSALIAS", "STATUS"],
    no: ["NO"],
    codeIdentity: ["CODEIDENTITY", "KODEIDENTITAS"],
    kegUtama: ["KEGUTAMA"],
    kegUtamaBaru: ["KEGIATANUTAMA"],
    produk: ["PRODUK"],
    produkBaru: ["PRODUKBARU"],
    kbliAkhir: ["KBLIAKHIR"],
    editKbli: ["EDITKBLI1YA", "EDITKBLI"],
    kbliBaru: ["KBLIBARU"],
    catatan: ["CATATAN"],
  };
  // "1121" (Excel membuang nol di depan angka) -> "01121"
  const padKbli = (s) => {
    const d = String(s ?? "").trim();
    return /^\d{1,5}$/.test(d) ? d.padStart(5, "0") : d;
  };

  async function parseWorkbook(arrayBuffer) {
    const sheets = await readXlsx(arrayBuffer);
    for (const sheet of sheets) {
      const hi = sheet.rows.findIndex((r) => r.some((h) => squash(h) === ANCHOR));
      if (hi < 0) continue;
      const headers = sheet.rows[hi].map(squash);
      const col = {};
      for (const [k, names] of Object.entries(COLS)) col[k] = headers.findIndex((h) => names.includes(h));
      const missing = [];
      if (col.link < 0) missing.push("link");
      if (col.nama < 0) missing.push("nama_usaha");
      if (col.kbliAkhir < 0) missing.push("kbli_akhir");
      if (col.kbliBaru < 0) missing.push("KBLI Baru");
      if (missing.length) throw new Error(`kolom tidak ada di sheet "${sheet.name}": ${missing.join(", ")}`);
      const byDoc = new Map();
      let skipped = 0;
      let notFlagged = 0;
      const dataRows = sheet.rows.slice(hi + 1).filter((r) => r.some((x) => String(x ?? "").trim()));
      dataRows.forEach((r, i) => {
        const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
        const flag = get("editKbli");
        if (flag && flag !== "1") {
          notFlagged++;
          return;
        }
        const rawLink = get("link");
        const url = (rawLink.match(/https?:\/\/[^"'\s<>]+/) || [""])[0];
        const ids = (url || rawLink).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        // KBLI Baru kosong = KBLI tidak diubah (dibiarkan seperti sebelumnya); produk/kegiatan utama tetap diproses
        const kbliBaru = padKbli(get("kbliBaru"));
        if (!ids.length || (kbliBaru && !/^\d{5}$/.test(kbliBaru))) {
          skipped++;
          return;
        }
        const id = ids[ids.length - 1].toLowerCase();
        const target = {
          row: hi + i + 2,
          no: get("no"),
          nama: get("nama"),
          codeIdentity: get("codeIdentity"),
          kegUtamaLama: get("kegUtama"),
          kegUtamaBaru: get("kegUtamaBaru"),
          produkLama: get("produk"),
          produkBaru: get("produkBaru"),
          kbliLama: padKbli(get("kbliAkhir")),
          kbliBaru,
          catatan: get("catatan"),
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
      return { items: Array.from(byDoc.values()), sheet: sheet.name, rows: dataRows.length, skipped, notFlagged };
    }
    throw new Error('tidak ada sheet dengan kolom "KBLI Baru"');
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
  function dropdownValue(container) {
    const el = container.querySelector('textarea, input[type="text"]');
    return el ? el.value.trim() : "";
  }

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
  const visibleKbli = () =>
    Array.from(document.querySelectorAll('[id^="kbli#"], #kbli, [id^="kbli_genai#"], #kbli_genai')).find(visible) || null;
  const instOf = (el) => (el.id.includes("#") ? el.id.split("#")[1] : undefined);

  function usahaCards() {
    const list = box("se2026_nested");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-nested-view]")).map((card) => {
      const span = card.querySelector("span");
      return { card, name: (span ? span.innerText : card.innerText).trim().toUpperCase() };
    });
  }

  // Cari halaman yang memuat kartu usaha (Blok II keluarga) atau langsung isian KBLI (form usaha tunggal).
  async function gotoArea() {
    if (!(await waitFor(() => sidebarItems().length, 30000))) throw new Error("sidebar form belum termuat");
    const state = () => (onCardList() ? "cards" : visibleKbli() ? "direct" : null);
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
    throw new Error("halaman kartu usaha / isian KBLI tidak ditemukan di sidebar");
  }

  async function openCard(card) {
    triggerClick(card.card);
    const el = await waitFor(() => {
      const kb = document.querySelector('[id^="keberadaan_usaha#"]');
      return visible(kb) ? kb : null;
    }, 20000);
    if (!el) throw new Error(`kartu usaha "${card.name}" tidak terbuka`);
    await sleep(W(700));
    return instOf(el);
  }

  async function writeText(id, inst, value) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = box(id, inst);
      if (!c) throw new Error(`isian ${id} tidak ada`);
      const input = c.querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])');
      if (!input) throw new Error(`isian ${id} terkunci`);
      if (input.value.trim() === value) return;
      setFieldValue(input, value);
      commitField(input);
      await sleep(W(300));
      const again = fresh(c).querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])') || input;
      if (again.value.trim() === value) return;
    }
    const now = box(id, inst);
    const val = now ? (now.querySelector("input, textarea") || {}).value || "" : "";
    if (val.trim() !== value) throw new Error(`isian ${id} tidak mau berubah (sekarang "${val}", seharusnya "${value}")`);
  }

  // Dropdown pencarian Master KBLI. Modal ini berat (±1.559 kode) & pencariannya kadang belum siap saat
  // baru dibuka -> kalau gagal atau nilainya tidak lengket, ulangi sekali lagi sebelum menyerah.
  const OPTION_SELECTOR = '[role="option"], [cmdk-item], [data-reka-collection-item], [role="listbox"] li, [role="dialog"] li';
  function visibleOptions2() {
    return Array.from(document.querySelectorAll(OPTION_SELECTOR)).filter((el) => visible(el) && !el.closest(OWN) && el.innerText.trim());
  }
  async function chooseFromDropdown(container, searchText, pick) {
    const textarea = container.querySelector('textarea, input[type="text"]');
    const toggle = container.querySelector('button[aria-haspopup="dialog"]');
    triggerClick(toggle || textarea);
    await sleep(W(400));
    if (searchText) {
      const search = document.querySelector('[role="dialog"] input:not([type="radio"]):not([type="checkbox"])') || textarea;
      if (search) setFieldValue(search, searchText);
    }
    const target = await waitFor(() => pick(visibleOptions2()), 8000);
    if (!target) {
      pressKey("Escape");
      return false;
    }
    triggerClick(target);
    await sleep(W(500));
    return true;
  }
  async function selectKbli(kbliBox, code) {
    if (!code) return false;
    const pick = (opts) => opts.find((o) => o.innerText.includes(code));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        closeDialogs();
        await sleep(W(900 + attempt * 400));
      }
      const ok = await chooseFromDropdown(fresh(kbliBox), code, pick);
      if (ok && (await waitFor(() => dropdownValue(fresh(kbliBox)).includes(code) || fresh(kbliBox).innerText.includes(code), 3000)))
        return true;
    }
    return false;
  }

  function radioValue(container) {
    const checked = container.querySelector('input[type="radio"]:checked, input[type="radio"][data-checked]');
    return checked ? checked.value : "";
  }
  async function setRadio(container, value) {
    const input = container.querySelector(`input[type="radio"][value="${value}"]`);
    if (!input) return false;
    if (radioValue(container) === value) return true;
    if (input.disabled) return false;
    const group = input.closest('[role="group"]') || input.parentElement;
    triggerClick((group && group.querySelector('[role="radio"]')) || input);
    return !!(await waitFor(() => radioValue(fresh(container)) === value, 3000));
  }

  // 13.g "Kode KBLI" bukan langsung kotak pencarian: isinya radio beberapa saran GenAI ("[G] 47782 ...")
  // ditambah satu pilihan "Pilih dari Master KBLI" (value 999999). Kotak pencarian KBLI (Master KBLI)
  // cuma muncul SETELAH "Pilih dari Master KBLI" itu dipilih -> bukan cuma soal render telat.
  function genaiCode(inst) {
    const genai = box("kbli_genai", inst);
    if (!genai) return "";
    const checked = genai.querySelector('input[type="radio"]:checked, input[type="radio"][data-checked]');
    if (!checked || checked.value === "999999") return "";
    const label = genai.querySelector(`label[for="${checked.id}"]`) || checked.closest('[role="group"]');
    return ((label && label.innerText) || "").match(/\b(\d{5})\b/)?.[1] || "";
  }
  // Kode KBLI yang sedang berlaku di kartu ini: dari kotak Master KBLI kalau sudah dipilih,
  // kalau belum (masih di radio 13.g) dari saran GenAI yang sedang tercentang.
  function effectiveKbliCode(inst) {
    const kbliBox = box("kbli", inst);
    if (kbliBox) {
      const code = ((dropdownValue(kbliBox) || kbliBox.innerText).match(/\b(\d{5})\b/) || [])[1];
      if (code) return code;
    }
    return genaiCode(inst);
  }
  // Pastikan KBLI kartu ini = code. Kalau salah satu saran GenAI (13.g) sudah persis sama, dipakai saja
  // (tidak usah pindah ke Master KBLI, supaya perubahan ke form seminim mungkin). Kalau belum, radio
  // 13.g dipindah ke "Pilih dari Master KBLI" dulu agar kotak pencariannya muncul, baru dipilih di sana.
  async function setKbliCode(inst, code) {
    if (genaiCode(inst) === code) return true;
    let kbliBox = await waitBox("kbli", inst, 1500);
    if (!kbliBox) {
      const genai = await waitBox("kbli_genai", inst, 3000);
      if (!genai || !(await setRadio(genai, "999999"))) return false;
      kbliBox = await waitBox("kbli", inst, 5000);
      if (!kbliBox) return false;
    }
    if ((dropdownValue(kbliBox) || kbliBox.innerText).includes(code)) return true;
    return selectKbli(kbliBox, code);
  }

  // Pasangan kata yang disamakan di kegiatan utama saat produk berubah (mis. padi hibrida -> inbrida).
  // Tambah pasangan baru di sini kalau nanti ada kasus KBLI lain yang juga butuh penyesuaian kata.
  const WORD_PAIRS = [["HIBRIDA", "INBRIDA"]];
  function matchCase(sample, word) {
    if (sample === sample.toUpperCase()) return word.toUpperCase();
    if (sample[0] === sample[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1).toLowerCase();
    return word.toLowerCase();
  }
  // Hasil: teks kegiatan utama baru, atau null kalau tidak ada pasangan kata yang cocok (jangan disentuh)
  function kegUtamaSwap(produkLama, produkBaru, kegUtama) {
    for (const [a, b] of WORD_PAIRS) {
      const reA = new RegExp(`\\b${a}\\b`, "i");
      const reB = new RegExp(`\\b${b}\\b`, "i");
      let from = null;
      let to = null;
      if (reA.test(produkLama) && reB.test(produkBaru)) {
        from = reA;
        to = b;
      } else if (reB.test(produkLama) && reA.test(produkBaru)) {
        from = reB;
        to = a;
      }
      if (from) {
        // Sudah pakai kata yang baru (mis. kartu lama sempat diisi ulang manual) -> tidak perlu diganti,
        // jangan dikira "tidak ketemu pasangan kata" lalu disuruh cek manual padahal sudah benar.
        if (new RegExp(`\\b${to}\\b`, "i").test(kegUtama)) return kegUtama;
        const m = kegUtama.match(from);
        if (m) return kegUtama.replace(from, matchCase(m[0], to));
      }
    }
    return null;
  }

  // Rincian 20 (izin edar BPOM) & sertifikat halal BPJPH cuma ditanyakan untuk kategori usaha tertentu
  // (biasanya industri) -> bisa muncul atau hilang sendiri kalau KBLI diganti. Kalau muncul, diisi jawaban
  // aman yang sama dengan skrip utama: belum ada izin edar / sertifikat halal, 1 varian yang belum.
  const KBLI_FIXED_IF_SHOWN = [
    ["izin_edar", "radio", "3"],
    ["belum_bpom", "text", "1"],
    ["halal", "radio", "3"],
    ["belum_halal", "text", "1"],
  ];
  // Baca saja (dipakai di halaman Review): field yang sedang terlihat tapi belum sesuai jawaban aman itu
  function izinHalalGaps(inst) {
    const bits = [];
    for (const [id, kind, value] of KBLI_FIXED_IF_SHOWN) {
      const el = box(id, inst);
      if (!el) continue;
      const cur = kind === "radio" ? radioValue(el) : ((el.querySelector("input, textarea") || {}).value || "").trim();
      if (cur !== value) bits.push(`${id} "${cur || "-"}" → "${value}"`);
    }
    return bits;
  }
  // Isi field-field itu kalau ternyata muncul. Kode industri (10-33) lebih mungkin memunculkannya,
  // jadi ditunggu lebih lama; kode lain ditunggu sebentar saja supaya tidak memperlambat kartu yang
  // memang tidak ada field ini.
  async function fillIzinHalalIfShown(inst, kbliBaru) {
    const ms = /^(1\d|2\d|3[0-3])/.test(kbliBaru || "") ? 1200 : 300;
    const notes = [];
    for (const [id, kind, value] of KBLI_FIXED_IF_SHOWN) {
      const el = await waitBox(id, inst, ms);
      if (!el) continue;
      if (kind === "radio") {
        if (radioValue(el) === value) continue;
        if (await setRadio(el, value)) notes.push(`${id} → ${value}`);
      } else {
        const input = el.querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])');
        if (!input || input.value.trim() === value) continue;
        await writeText(id, inst, value);
        notes.push(`${id} → ${value}`);
      }
    }
    return notes;
  }

  // Nilai kegiatan utama yang diinginkan: kolom "Kegiatan utama" (baru) di Excel dipakai langsung kalau
  // ada isinya; kalau kosong, baru dicoba disesuaikan dari kata yang beda antara produk lama & baru
  // (sejauh ini cuma pasangan HIBRIDA/INBRIDA -> lihat WORD_PAIRS). null = tidak ada yang bisa dipastikan.
  function wantedKegUtama(t, kegCur) {
    if (t.kegUtamaBaru) return { value: t.kegUtamaBaru, guessed: false };
    if (t.produkBaru) {
      const swapped = kegUtamaSwap(t.produkLama, t.produkBaru, kegCur || t.kegUtamaLama || "");
      if (swapped) return { value: swapped, guessed: true };
    }
    return null;
  }

  // Baca saja (aman dipakai di halaman Review, tanpa revoke). Halaman Review tidak bisa diklik (bukan
  // mode edit), jadi KBLI dibaca dari mana pun dia sedang terlihat: kotak Master KBLI atau radio 13.g.
  async function readKbliCard(inst, t) {
    await waitFor(() => box("kbli", inst) || box("kbli_genai", inst), 3000);
    const code = effectiveKbliCode(inst);
    const produkBox = box("produk", inst);
    const produkInput = produkBox && produkBox.querySelector("input, textarea");
    const produkCur = produkInput ? produkInput.value.trim() : "";
    const kegBox = box("keg_utama", inst);
    const kegInput = kegBox && kegBox.querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])');
    const kegCur = kegInput ? kegInput.value.trim() : "";
    const want = wantedKegUtama(t, kegCur);
    const kbliOk = !t.kbliBaru || code === t.kbliBaru;
    const produkOk = !t.produkBaru || produkCur === t.produkBaru;
    const kegOk = !want || kegCur === want.value;
    const izinHalalBits = izinHalalGaps(inst);
    const umkmKosong = umkmBlank(inst);
    const already = kbliOk && produkOk && kegOk && !izinHalalBits.length && !umkmKosong;
    const bits = [...izinHalalBits];
    if (umkmKosong) bits.push('Pilih UMKM dalam satu SLS kosong → "TIDAK ADA"');
    if (!kbliOk) bits.push(`KBLI ${code || "-"} → ${t.kbliBaru}`);
    if (!produkOk) bits.push(`produk "${produkCur}" → "${t.produkBaru}"`);
    if (!kegOk) bits.push(`kegiatan utama "${kegCur}" → "${want.value}"`);
    return { changed: false, already, summary: already ? "sudah sesuai" : bits.join(", ") };
  }

  // Tag catatan yang dipasang di bagian KBLI (13.g) tiap kartu yang diproses skrip ini, sebagai jejak
  // bahwa kartu itu sudah dicek/dikoreksi lewat prosedur Pengecekan KBLI.
  const KBLI_CATATAN_TAG = "#DC_01";
  // Tombol "Catatan" ada di tiap rincian (desktop/mobile beda elemen, cuma satu yang kelihatan).
  // Kotak catatannya sendiri muncul sebagai popover terpisah (bukan anak dari kbli_genai/kbli), jadi
  // dicari dari seluruh halaman lewat placeholder-nya, bukan dibatasi ke dalam kontainer KBLI.
  // Catatan di FASIH itu thread chat (bukan satu kotak nilai): kotak "Tambah catatan di sini..." SELALU
  // kosong (itu kotak ketik pesan baru), catatan yang sudah ada muncul sebagai pesan-pesan di ATAS kotak
  // itu. Begitu terkirim, pesan tidak bisa dihapus. Pesan lain (dari petugas lain, soal hal lain) tidak
  // masalah dibiarkan apa adanya -> yang dicegah HANYA mengirim tag yang sama (#DC_01) dua kali.
  // Hasil: { found } = tombol Catatan tidak ketemu; { found: true, added, alreadyTagged }.
  async function addKbliCatatan(inst, text) {
    const containers = [box("kbli_genai", inst), box("kbli", inst)].filter(Boolean);
    let btn = null;
    for (const c of containers) {
      btn = Array.from(c.querySelectorAll('button[title="Catatan"]')).find(visible);
      if (btn) break;
    }
    if (!btn) return { found: false };
    triggerClick(btn);
    const ta = await waitFor(
      () => Array.from(document.querySelectorAll("textarea")).find((t2) => visible(t2) && /tambah catatan/i.test(t2.placeholder || "")),
      3000,
    );
    if (!ta) {
      pressKey("Escape");
      return { found: false };
    }
    await sleep(W(300)); // thread pesan lama (kalau ada) dimuat sesaat setelah popover terbuka
    const alreadyTagged = Array.from(document.querySelectorAll('[class*="wrap-break-word"]')).some(
      (el) => visible(el) && el.textContent.trim() === text,
    );
    let added = false;
    if (!alreadyTagged) {
      setFieldValue(ta, text);
      const simpan = await waitFor(
        () => Array.from(document.querySelectorAll('button[title="Simpan"]')).find((b) => visible(b) && !b.disabled),
        2000,
      );
      if (simpan) {
        triggerClick(simpan);
        await sleep(W(400));
        added = true;
      }
    }
    closeDialogs();
    return { found: true, added, alreadyTagged };
  }

  // "Pilih UMKM dalam satu SLS yang sama" yang dibiarkan kosong bikin galat saat Kirim. Kalau memang tidak ada
  // UMKM yang ditautkan (kosong), pilih "TIDAK ADA". Yang sudah terisi (UMKM lain / TIDAK ADA) atau terkunci dibiarkan.
  // Kotak instance kartu ini; kalau id-nya beda (kartu dibuka dengan nomor lain), pakai yang sedang tampil
  const umkmBox = (inst) =>
    box("pilih_umkm_sls", inst) || Array.from(document.querySelectorAll('[id^="pilih_umkm_sls"]')).find(visible) || null;
  // Belum dipilih = kosong, ATAU masih "Wajib diisi" (teks ketikan/sisa pencarian bukan pilihan)
  const umkmUnset = (c) => !dropdownValue(c) || /Wajib diisi/i.test(c.innerText || "");
  const umkmEmpty = (inst) => {
    const c = umkmBox(inst);
    const ta = c && c.querySelector('textarea, input[type="text"]');
    return !!(ta && !ta.disabled && !ta.hasAttribute("data-disabled") && umkmUnset(c));
  };
  // Sama, tapi tanpa syarat "tidak terkunci": di halaman Review semua isian memang terkunci
  const umkmBlank = (inst) => {
    const c = umkmBox(inst);
    return !!(c && c.querySelector('textarea, input[type="text"]') && umkmUnset(c));
  };
  async function fillUmkmTidakAda(inst) {
    await waitFor(() => umkmBox(inst), 1500);
    if (!umkmBox(inst) || !umkmEmpty(inst)) return null;
    const isTidak = (o) => /TIDAK\s+ADA/i.test(o.innerText);
    for (let attempt = 0; attempt < 2 && umkmEmpty(inst); attempt++) {
      const left = umkmBox(inst).querySelector('textarea, input[type="text"]');
      if (left && left.value.trim()) setFieldValue(left, ""); // teks sisa, bukan pilihan
      await chooseFromDropdown(umkmBox(inst), attempt ? "TIDAK ADA" : "", (opts) => opts.find(isTidak));
      if (await waitFor(() => !umkmEmpty(inst) && /TIDAK ADA/i.test(dropdownValue(umkmBox(inst))), 3000)) return 'Pilih UMKM dalam satu SLS → "TIDAK ADA"';
      // sisa teks pencarian jangan sampai tertinggal di kotaknya
      const ta = umkmBox(inst).querySelector('textarea, input[type="text"]');
      if (ta && /^TIDAK ADA$/i.test(ta.value.trim())) setFieldValue(ta, "");
      closeDialogs();
      await sleep(W(400));
    }
    throw Object.assign(new Error('isian "Pilih UMKM dalam satu SLS" kosong & pilihan "TIDAK ADA" tidak bisa dipilih — isi manual'), { soft: true });
  }
  // Semua kartu usaha di dokumen ini (bukan cuma yang KBLI-nya diganti): galat di kartu mana pun menahan Kirim
  async function sweepUmkmTidakAda() {
    const area = await gotoArea();
    const notes = [];
    const one = async (inst, name) => {
      try {
        const r = await fillUmkmTidakAda(inst);
        if (r) notes.push(`${name ? `"${name}": ` : ""}${r}`);
      } catch (e) {
        notes.push(`${name ? `"${name}": ` : ""}${e.message}`);
      }
    };
    if (area.kind === "direct") {
      await one(instOf(visibleKbli()), "");
      return notes;
    }
    const n = usahaCards().length;
    for (let idx = 0; idx < n; idx++) {
      if (idx) await goSection(area.title, onCardList, true);
      const card = usahaCards()[idx];
      if (!card) continue;
      await one(await openCard(card), card.name);
    }
    if (notes.length) log(notes.join("; "));
    return notes;
  }

  const parseRupiah = (v) => Number(String(v || "").replace(/[^\d]/g, "")) || 0;

  // Ganti KBLI di kartu yang sedang terbuka, lalu produk (kalau Produk Baru ada) & kegiatan utama
  // (kolom "Kegiatan utama" baru, atau penyesuaian kata kalau kolom itu kosong).
  async function ensureKbliCard(inst, t) {
    const notes = [];
    let changed = false;
    await waitFor(() => box("kbli", inst) || box("kbli_genai", inst), 5000);
    const code = effectiveKbliCode(inst);
    // 26.c "Biaya pembelian barang yang terjual" cuma ada untuk usaha dagang. Kalau KBLI dipindah ke
    // kategori yang tidak punya isian itu (paling sering dagang -> industri), nilai yang sudah terisi
    // hilang begitu saja dari form. Disimpan dulu sebelum KBLI diganti, supaya bisa dipindahkan ke 26.b
    // biaya produksi kalau 26.c memang sampai hilang setelah KBLI-nya diganti.
    const pembelianBox0 = box("biaya_pembelian", inst);
    const pembelianInput0 = pembelianBox0 && pembelianBox0.querySelector("input");
    const pembelianBefore = pembelianInput0 ? pembelianInput0.value.trim() : "";
    if (t.kbliBaru && code !== t.kbliBaru) {
      if (!(await setKbliCode(inst, t.kbliBaru)))
        throw new Error(`KBLI ${t.kbliBaru} tidak bisa dipilih (13.g / Master KBLI tidak muncul)`);
      notes.push(`KBLI ${code || "-"} → ${t.kbliBaru}`);
      changed = true;
      if (parseRupiah(pembelianBefore) > 0 || !pembelianBox0) {
        await sleep(W(500)); // rincian 26 dirender ulang sesuai KBLI baru
        const pembelianBoxNow = box("biaya_pembelian", inst);
        if (parseRupiah(pembelianBefore) > 0 && !pembelianBoxNow) {
          const produksiBox = box("biaya_produksi", inst);
          const produksiInput = produksiBox && produksiBox.querySelector("input");
          if (produksiInput) {
            const gabung = String(parseRupiah(produksiInput.value) + parseRupiah(pembelianBefore));
            await writeText("biaya_produksi", inst, gabung);
            notes.push(`26.c "Biaya pembelian barang" (Rp ${pembelianBefore}) hilang setelah KBLI diganti → digabung ke 26.b biaya produksi (jadi Rp ${gabung})`);
          } else {
            notes.push(`26.c "Biaya pembelian barang" (Rp ${pembelianBefore}) hilang setelah KBLI diganti, tapi 26.b juga tidak muncul — cek manual`);
          }
        } else if (!pembelianBox0 && pembelianBoxNow) {
          // KBLI pindah ke usaha dagang: 26.c baru muncul. Tidak ada angkanya di Excel (usaha ini
          // sebelumnya bukan dagang) -> jangan ditebak, berhenti & minta diisi manual.
          const pembelianInputNow = pembelianBoxNow.querySelector("input");
          const nowVal = pembelianInputNow ? pembelianInputNow.value.trim() : "";
          if (!nowVal)
            throw Object.assign(
              new Error(`26.c "Biaya pembelian barang yang terjual" baru muncul (kosong) setelah KBLI diganti ke usaha dagang — tidak ada nilainya di Excel, isi manual dulu lalu Kirim & Approve`),
              { soft: true },
            );
        }
      }
    }
    const izinHalalNotes = await fillIzinHalalIfShown(inst, t.kbliBaru || code);
    if (izinHalalNotes.length) {
      notes.push(...izinHalalNotes);
      changed = true;
    }
    const umkmNote = await fillUmkmTidakAda(inst);
    if (umkmNote) {
      notes.push(umkmNote);
      changed = true;
    }
    if (t.produkBaru) {
      const produkBox = box("produk", inst);
      const produkInput = produkBox && produkBox.querySelector("input, textarea");
      const produkCur = produkInput ? produkInput.value.trim() : "";
      if (produkCur !== t.produkBaru) {
        await writeText("produk", inst, t.produkBaru);
        notes.push(`produk "${produkCur}" → "${t.produkBaru}"`);
        changed = true;
      }
    }
    const kegBox = box("keg_utama", inst);
    const kegInput = kegBox && kegBox.querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])');
    const kegCur = kegInput ? kegInput.value.trim() : "";
    const want = wantedKegUtama(t, kegCur);
    if (want && want.value !== kegCur) {
      await writeText("keg_utama", inst, want.value);
      notes.push(`kegiatan utama → "${want.value}"${want.guessed ? " (disesuaikan otomatis)" : ""}`);
      changed = true;
    } else if (!want && t.produkBaru) {
      notes.push(`kegiatan utama belum disesuaikan (cek manual): produk lama "${t.produkLama}" → baru "${t.produkBaru}"`);
    }
    const catatan = await addKbliCatatan(inst, KBLI_CATATAN_TAG);
    if (catatan.added) notes.push(`catatan KBLI: ${KBLI_CATATAN_TAG}`);
    else if (catatan.found && catatan.alreadyTagged) notes.push(`catatan KBLI dibiarkan, tag ${KBLI_CATATAN_TAG} sudah ada di thread`);
    else if (!catatan.found) notes.push("tombol Catatan di bagian KBLI tidak ketemu, tag tidak ditambahkan (cek manual)");
    return { changed, already: !changed, summary: notes.join("; ") || "sudah sesuai" };
  }

  // Telusuri kartu usaha dokumen ini & cocokkan ke baris Excel lewat nama usaha.
  // write=false: cuma baca (aman di halaman Review). write=true: ganti KBLI/produk/kegiatan utama.
  async function scanDoc(item, write) {
    const area = await gotoArea();
    const targets = item.targets;
    const results = targets.map(() => null);
    const notes = [];

    if (area.kind === "direct") {
      const el = visibleKbli();
      const inst = instOf(el);
      const t = targets[0];
      if (targets.length > 1)
        notes.push(`halaman ini cuma 1 isian KBLI, tapi Excel punya ${targets.length} baris untuk dokumen ini — hanya baris pertama diproses`);
      try {
        results[0] = write ? await ensureKbliCard(inst, t) : await readKbliCard(inst, t);
      } catch (e) {
        notes.push(e.message);
      }
      return { results, notes };
    }

    const cards = usahaCards();
    if (!cards.length) throw new Error("tidak ada kartu usaha di Blok II");
    const order = cards
      .map((c, idx) => ({ idx, score: Math.max(...targets.map((t) => nameMatch(c.name, t.nama))) }))
      .sort((a, b) => b.score - a.score);
    log(`${cards.length} kartu usaha di "${area.title}", ${targets.length} target dari Excel`);
    const tried = new Set(); // target yang sudah ketemu kartunya (walau akhirnya gagal diisi -> bukan "tidak cocok")
    let first = true;
    for (const o of order) {
      if (results.every(Boolean)) break;
      if (o.score < NAME_OK) continue;
      if (!first) await goSection(area.title, onCardList, true);
      first = false;
      const card = usahaCards()[o.idx];
      if (!card) continue;
      const inst = await openCard(card);
      const scored = targets
        .map((t, i) => ({ i, s: nameMatch(card.name, t.nama) }))
        .filter((x) => !results[x.i])
        .sort((a, b) => b.s - a.s);
      const best = scored[0];
      if (!best || best.s < NAME_OK) continue;
      tried.add(best.i);
      const t = targets[best.i];
      try {
        const r = write ? await ensureKbliCard(inst, t) : await readKbliCard(inst, t);
        results[best.i] = { card: card.name, ...r };
        log(`"${card.name}": ${r.already ? "sudah sesuai" : r.summary}`);
      } catch (e) {
        notes.push(`kartu "${card.name}": ${e.message}`);
      }
    }
    const unmatched = targets.filter((t, i) => !results[i] && !tried.has(i)).map((t) => t.nama);
    if (unmatched.length) notes.push(`nama usaha tidak cocok dengan kartu manapun: ${unmatched.join(", ")}`);
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
      count = visibleOptions().length;
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
    await sleep(W(500));
    return true;
  }
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
  // Nama yang dicari: nama usaha utuh, bagian sebelum kurung, dan nama di dalam kurung (biasanya pemilik)
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

  // ---------- CATATAN: toggle Anomali ----------
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
  // Elemen geser (div "...-control" dengan data-checked); dicari langsung supaya tetap jalan walau
  // input[role=switch] tersembunyi tidak ada di dekatnya.
  function findAnomaliControl() {
    const direct = findAnomaliSwitch();
    const near = direct && direct.parentElement.querySelector('[id$="-control"]');
    if (near) return near;
    return (
      Array.from(document.querySelectorAll('[id$="-control"]')).find((el) => {
        if (!visible(el)) return false;
        let p = el;
        for (let i = 0; i < 7 && p; i++, p = p.parentElement) if (/anomali/i.test(p.innerText || "")) return true;
        return false;
      }) || null
    );
  }
  async function openCatatan() {
    closeDialogs();
    try {
      await goSection("CATATAN", () => !!findAnomaliControl());
    } catch (e) {
      log(`⚠ halaman CATATAN tidak dibuka (${e.message})`);
      return;
    }
    const isOn = () => {
      const s = findAnomaliSwitch();
      const c = findAnomaliControl();
      return (
        (!!s && (s.checked || s.getAttribute("aria-checked") === "true")) ||
        (!!c && (c.hasAttribute("data-checked") || c.getAttribute("aria-checked") === "true"))
      );
    };
    for (const attempt of [
      () => triggerClick(findAnomaliControl() || findAnomaliSwitch()),
      () => (findAnomaliControl() || findAnomaliSwitch()).click(),
    ]) {
      if (isOn()) break;
      attempt();
      await waitFor(isOn, 2500);
    }
    if (isOn()) await sleep(W(1200));
  }

  // ---------- ANOMALI USAHA: tandai anomali yang membahas KBLI ----------
  const KBLI_ANOMALI_EXPLANATION = "KBLI sudah sesuai dengan usaha yang dijalankan";
  async function handleKbliAnomali() {
    await openCatatan(); // nyalakan toggle anomali (idempotent, aman dipanggil berkali-kali)
    const target = sidebarItem("ANOMALI USAHA") || sidebarItem("ANOMALI");
    if (!target) {
      log("Tidak ada bagian ANOMALI USAHA di sidebar (dokumen ini mungkin tidak ada anomali)");
      return [];
    }
    triggerClick(target);
    await sleep(W(900));
    const blocks = Array.from(document.querySelectorAll('[id^="anomali_"][id$="_deskripsi"]')).filter(visible);
    const notes = [];
    for (const d of blocks) {
      const num = (d.id.match(/^anomali_(\d+)_deskripsi$/) || [])[1];
      if (!num || !/KBLI/i.test(d.innerText)) continue;
      const checkBox = box(`anomali_${num}_check`);
      const cb = checkBox && checkBox.querySelector('input[type="checkbox"]');
      if (!cb) {
        notes.push(`anomali #${num} (KBLI): kotak centang "Ya, Sesuai Kondisi Lapangan" tidak ditemukan`);
        continue;
      }
      if (!cb.checked) {
        const ctl = checkBox.querySelector('[id$="-control"]') || cb.closest("label") || cb;
        triggerClick(ctl);
        await waitFor(() => {
          const now = box(`anomali_${num}_check`);
          const input = now && now.querySelector('input[type="checkbox"]');
          return !!(input && input.checked);
        }, 3000);
      }
      const pj = await waitBox(`anomali_${num}_penjelasan`, undefined, 3000);
      const ta = pj && pj.querySelector("textarea, input[type='text']");
      if (ta && ta.value.trim() !== KBLI_ANOMALI_EXPLANATION) {
        setFieldValue(ta, KBLI_ANOMALI_EXPLANATION);
        commitField(ta);
        await sleep(W(300));
      }
      notes.push(`anomali #${num} (KBLI): ditandai "Ya, Sesuai Kondisi Lapangan"`);
    }
    return notes;
  }

  // ---------- Kirim + Approve ----------
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
    ["fill", "Ganti KBLI"],
    ["anomali", "Cek Anomali"],
    ["submit", "Kirim"],
    ["approve", "Approve"],
  ];
  const STEP_LABEL = { ...Object.fromEntries(STEPS), find: "Cari via filter" };
  const STAGE_TIMEOUT_MS = 4 * 60 * 1000;
  const HEARTBEAT_MS = 5 * 60 * 1000; // singgah ke halaman daftar tiap segini, jaga sesi SSO tetap aktif
  let busy = false;

  // Halaman login SSO (sesi berakhir) — beda dari forbiddenPage(): bukan "tidak punya akses",
  // tapi "tidak sedang login sama sekali" (form password / teks masuk & tidak ada shell aplikasi FASIH).
  let loginAt = 0;
  let loginLast = false;
  function loginPage() {
    if (Date.now() - loginAt < 1000) return loginLast;
    loginAt = Date.now();
    if (!document.body || document.querySelector(".fasih-form-sidebar")) return (loginLast = false);
    if (document.querySelector('input[type="password"]')) return (loginLast = true);
    const text = Array.from(document.body.children)
      .filter((el) => !/^kk-/.test(el.id || "") && !/^(SCRIPT|STYLE)$/.test(el.tagName))
      .map((el) => el.innerText || "")
      .join(" ");
    return (loginLast = /\b(masuk|login|sign in)\b/i.test(text) && /\b(sso|nip|kata sandi|password|single sign)\b/i.test(text));
  }
  function beepAlert() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.22, 0.44].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.18);
      });
    } catch (e) {
      /* abaikan kalau audio diblokir browser */
    }
  }
  function haltForLogout() {
    const r = loadRun();
    if (!r.running || r.hold) return;
    r.hold = { at: Date.now(), reason: "logout" };
    saveRun(r);
    log("⏸ Dijeda otomatis — sesi FASIH berakhir (logout). Login ulang, lalu klik ▶ Lanjut. Progres tidak hilang.");
    beepAlert();
  }

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
        const nm = (t.nama || (res && res.card) || "usaha").split("(")[0].trim();
        if (!res) return `${nm}: kartu tidak ketemu`;
        return `${nm}: ${res.summary}`;
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
    if (loginPage()) return haltForLogout();
    busy = true;
    stopRequested = false;
    try {
      if (!run.cur) {
        if (Date.now() < (run.nextAt || 0)) return;
        const listUrl = loadJson(LIST_KEY, "");
        if (listUrl && Date.now() - (run.hbAt || 0) > HEARTBEAT_MS && !isListPage()) {
          run.hbAt = Date.now();
          saveRun(run);
          log("↻ Singgah ke halaman daftar assignment (jaga sesi tetap aktif)");
          location.href = listUrl;
          return;
        }
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
          const edited = cur.revoked || ["fill", "anomali", "submit"].includes(cur.stage) ? " (dokumen sempat dibuka edit, cek manual)" : "";
          return finishItem(item.id, "forbidden", `halaman Forbidden (tidak ada akses), dilewati${edited}`);
        }
        pressKey("Escape");
        const where = STEP_LABEL[cur.stage] || cur.stage;
        const after = cur.revoked || ["fill", "anomali", "submit"].includes(cur.stage) ? " — dokumen sudah dibuka edit, cek manual" : "";
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
        if (!ensureReview(item)) return;
        try {
          const { results, notes } = await scanDoc(item, false);
          if (results.length && results.every((r) => r && r.already))
            return finishItem(item.id, "already", `tidak diubah, sudah sesuai · ${summary(item, results)}`);
          if (results.every((r) => !r)) {
            const why = `tidak ada kartu yang sesuai nama_usaha Excel (${notes.join("; ") || "-"})`;
            if (!item.searched || hasNextCand(item)) throw needFind(why);
            throw Object.assign(new Error(`${why} — tidak di-revoke, cek manual`), { soft: true });
          }
          if (results.some((r) => !r) && item.foundBy === "filter" && hasNextCand(item))
            throw needFind(`sebagian usaha tidak ada di dokumen ini (${notes.join("; ") || "-"})`);
          if (results.some((r) => !r)) log(`⚠ cek Review: ${notes.join("; ") || "sebagian kartu belum ketemu"}, lanjut ke Edit`);
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
        updateItem(item.id, { result: summary(item, results), kbliNotes: notes });
        if (results.some((r) => !r))
          throw Object.assign(new Error(`${summary(item, results)}${notes.length ? ` (${notes.join("; ")})` : ""}`), { soft: true });
        const umkmNotes = await sweepUmkmTidakAda();
        if (umkmNotes.length) updateItem(item.id, { kbliNotes: [...notes, ...umkmNotes] });
        return setStage("anomali", { submitClicked: false, changed: results.some((r) => r.changed) });
      }
      case "anomali": {
        if (!onEditOf(did(item))) return setStage("edit");
        const notes = await handleKbliAnomali();
        if (notes.length) {
          const q = loadQueue().find((x) => x.id === item.id);
          updateItem(item.id, { kbliNotes: [...((q && q.kbliNotes) || []), ...notes] });
        }
        return setStage("submit");
      }
      case "submit": {
        if (!onEditOf(did(item))) {
          if (cur.submitClicked && onReviewOf(did(item))) return setStage("approve");
          throw new Error("halaman edit tertutup sebelum dikirim");
        }
        if (cur.submitClicked) {
          await backToReview(20000);
          return setStage("approve");
        }
        if (run.testMode && cur.confirmed !== "submit") {
          if (!run.paused) {
            run.paused = { stage: "submit" };
            saveRun(run);
            log('MODE UJI: KBLI sudah diganti. Periksa, lalu "Kirim sekarang" atau "Lewati"');
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
        const anomaliNote = (q.kbliNotes || []).filter((n) => /anomali/i.test(n));
        return finishItem(
          item.id,
          "done",
          `${q.result || "terkirim"} · terkirim${conf.approve && !note ? " & approve" : ""}${note}${anomaliNote.length ? ` · ${anomaliNote.join("; ")}` : ""}`,
        );
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
      hbAt: Date.now(),
    });
    closePanel();
    log(`Mulai${opts.testMode ? " · MODE UJI" : ""}`);
  }
  function setHold(on) {
    const r = loadRun();
    if (!r.running) return;
    if (on && !r.hold) r.hold = { at: Date.now() };
    if (!on && r.hold) {
      if (r.phaseAt) r.phaseAt += Date.now() - r.hold.at;
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
    if (document.getElementById("kk-style")) return;
    const style = document.createElement("style");
    style.id = "kk-style";
    style.textContent = `
      .kk, .kk * { box-sizing:border-box; font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .kk { --bg:#ffffff; --bg2:#f6f7fb; --line:#e7e8ef; --tx:#0f1222; --mut:#6b7186; --acc:#4f46e5; --acc2:#7c3aed; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; color:var(--tx); }
      .kk button { font:inherit; }
      .kk-overlay { position:fixed; inset:0; z-index:1000001; background:rgba(15,18,34,.38); backdrop-filter:blur(3px); display:flex; justify-content:flex-end; animation:kkfade .18s ease; }
      @keyframes kkfade { from{opacity:0} to{opacity:1} }
      @keyframes kkslide { from{transform:translateX(24px);opacity:.4} to{transform:none;opacity:1} }
      @keyframes kkspin { to{transform:rotate(360deg)} }
      @keyframes kkpulse { 0%,100%{opacity:1} 50%{opacity:.45} }
      .kk-sheet { background:var(--bg2); width:min(820px,100vw); height:100vh; display:flex; flex-direction:column; box-shadow:-20px 0 60px rgba(15,18,34,.25); animation:kkslide .22s ease; }
      .kk-head { position:relative; padding:20px 24px 18px; color:#fff; background:linear-gradient(120deg,#4338ca,#7c3aed 55%,#c026d3); overflow:hidden; }
      .kk-head:after { content:""; position:absolute; right:-60px; top:-80px; width:240px; height:240px; border-radius:50%; background:rgba(255,255,255,.09); }
      .kk-head .row1 { display:flex; align-items:center; gap:14px; position:relative; z-index:1; }
      .kk-logo { width:44px; height:44px; border-radius:12px; background:rgba(255,255,255,.18); display:grid; place-items:center; font-weight:800; font-size:13px; letter-spacing:-.5px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.25); }
      .kk-title { font-size:18px; font-weight:750; letter-spacing:-.2px; }
      .kk-sub { font-size:12.5px; opacity:.85; margin-top:2px; }
      .kk-sub code { background:rgba(255,255,255,.16); padding:1px 6px; border-radius:6px; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
      .kk-x { margin-left:auto; width:34px; height:34px; border-radius:10px; border:none; background:rgba(255,255,255,.16); color:#fff; font-size:18px; cursor:pointer; }
      .kk-x:hover { background:rgba(255,255,255,.28); }
      .kk-prog { position:relative; z-index:1; margin-top:16px; }
      .kk-prog .track { height:8px; border-radius:99px; background:rgba(255,255,255,.2); overflow:hidden; display:flex; }
      .kk-prog .seg { height:100%; transition:width .4s ease; }
      .kk-prog .lbl { display:flex; justify-content:space-between; font-size:12px; margin-top:6px; opacity:.9; }
      .kk-body { flex:1; overflow:auto; padding:18px 24px 28px; display:flex; flex-direction:column; gap:14px; }
      .kk-card { background:var(--bg); border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow:0 1px 2px rgba(15,18,34,.04); }
      .kk-sec { display:flex; align-items:center; gap:8px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--mut); margin-bottom:12px; }
      .kk-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      @media (max-width:720px){ .kk-grid2{grid-template-columns:1fr} .kk-stats{grid-template-columns:repeat(4,1fr)!important} }
      .kk-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .kk-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--bg); color:var(--tx); border-radius:10px; padding:8px 13px; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; }
      .kk-btn:hover { border-color:#c7c9d9; background:#fafaff; transform:translateY(-1px); }
      .kk-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }
      .kk-btn.primary { background:linear-gradient(120deg,var(--acc),var(--acc2)); border-color:transparent; color:#fff; box-shadow:0 6px 16px rgba(79,70,229,.3); }
      .kk-btn.primary:hover { box-shadow:0 8px 22px rgba(79,70,229,.4); }
      .kk-btn.soft { background:#eef0ff; border-color:#e0e3ff; color:var(--acc); }
      .kk-btn.ghost { border-color:transparent; background:transparent; color:var(--mut); }
      .kk-btn.ghost:hover { background:#f0f1f6; color:var(--tx); }
      .kk-btn.danger { color:var(--bad); }
      .kk-btn.sm { padding:5px 9px; font-size:12px; border-radius:8px; }
      .kk-drop { border:1.5px dashed #c9cbe0; border-radius:14px; padding:16px; display:flex; align-items:center; gap:14px; cursor:pointer; transition:all .15s; background:#fbfbfe; }
      .kk-drop:hover, .kk-drop.over { border-color:var(--acc); background:#f4f4ff; }
      .kk-drop .ic { width:42px; height:42px; border-radius:12px; display:grid; place-items:center; background:#e9fbe9; font-size:20px; flex:none; }
      .kk-drop b { font-size:13.5px; }
      .kk-hint { font-size:12px; color:var(--mut); line-height:1.5; }
      .kk-seg { display:inline-flex; background:#f0f1f6; border-radius:10px; padding:3px; gap:2px; }
      .kk-seg button { border:none; background:transparent; padding:6px 12px; border-radius:8px; font-size:12.5px; font-weight:600; color:var(--mut); cursor:pointer; }
      .kk-seg button.on { background:var(--bg); color:var(--acc); box-shadow:0 1px 3px rgba(15,18,34,.12); }
      .kk-tog { display:flex; align-items:flex-start; gap:10px; padding:7px 0; cursor:pointer; font-size:13px; }
      .kk-tog input { display:none; }
      .kk-tog .sw { flex:none; width:36px; height:21px; border-radius:99px; background:#d5d7e3; position:relative; transition:background .15s; margin-top:1px; }
      .kk-tog .sw:after { content:""; position:absolute; top:2.5px; left:2.5px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.2); transition:transform .15s; }
      .kk-tog input:checked + .sw { background:var(--acc); }
      .kk-tog input:checked + .sw:after { transform:translateX(15px); }
      .kk-tog small { display:block; color:var(--mut); font-size:11.5px; margin-top:1px; }
      .kk-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(82px,1fr)); gap:8px; }
      .kk-stat { border:1px solid var(--line); border-radius:12px; padding:10px 11px; cursor:pointer; background:var(--bg); text-align:left; transition:all .15s; }
      .kk-stat:hover { transform:translateY(-1px); }
      .kk-stat.on { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 16%,transparent); }
      .kk-stat .n { font-size:21px; font-weight:780; color:var(--c); letter-spacing:-.5px; }
      .kk-stat .l { font-size:11.5px; color:var(--mut); margin-top:1px; white-space:nowrap; }
      .kk-search { flex:1; min-width:200px; border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:13px; background:var(--bg); outline:none; }
      .kk-search:focus { border-color:var(--acc); box-shadow:0 0 0 3px rgba(79,70,229,.12); }
      .kk-list { display:flex; flex-direction:column; gap:8px; }
      .kk-item { display:grid; grid-template-columns:22px 1fr auto; gap:12px; align-items:start; background:var(--bg); border:1px solid var(--line); border-left:3px solid var(--c); border-radius:12px; padding:12px 14px; font-size:12.5px; }
      .kk-item input[type=checkbox] { width:16px; height:16px; margin-top:2px; accent-color:var(--acc); }
      .kk-item .nm { font-size:13.5px; font-weight:650; }
      .kk-item .meta { color:var(--mut); margin-top:3px; }
      .kk-pill { display:inline-block; font-size:11px; font-weight:650; padding:2px 8px; border-radius:99px; color:var(--c); background:color-mix(in srgb,var(--c) 11%,#fff); margin-left:6px; vertical-align:1px; }
      .kk-diff { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .kk-chg { display:inline-flex; align-items:center; gap:6px; background:var(--bg2); border:1px solid var(--line); border-radius:8px; padding:3px 8px; }
      .kk-chg .k { font-weight:700; color:var(--acc); font-size:11px; }
      .kk-chg .o { color:var(--mut); text-decoration:line-through; text-decoration-color:rgba(220,38,38,.5); }
      .kk-chg .a { color:var(--tx); font-weight:650; }
      .kk-chg .u { color:var(--mut); font-size:11px; }
      .kk-item .why { margin-top:7px; color:var(--c); line-height:1.45; }
      .kk-item .acts { display:flex; gap:4px; }
      .kk-empty { text-align:center; padding:36px 10px; color:var(--mut); font-size:13px; }
      .kk-more { text-align:center; font-size:12px; color:var(--mut); padding:6px; }
      .kk-launch { position:fixed; left:16px; bottom:112px; z-index:999999; display:flex; align-items:center; gap:8px; border:none; border-radius:999px; padding:10px 16px 10px 12px; background:linear-gradient(120deg,#4f46e5,#7c3aed); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 28px rgba(79,70,229,.4); transition:transform .15s; }
      .kk-launch:hover { transform:translateY(-2px); }
      .kk-launch .b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 6px; font-size:11.5px; font-weight:800; }
      .kk-hud { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:1000002; width:min(640px,94vw); background:rgba(17,19,36,.92); backdrop-filter:blur(12px); color:#eef0ff; border-radius:18px; padding:14px 16px; box-shadow:0 20px 50px rgba(10,10,30,.45), inset 0 0 0 1px rgba(255,255,255,.07); font-size:13px; }
      .kk-hud .top { display:flex; align-items:center; gap:10px; }
      .kk-hud .spin { width:16px; height:16px; border-radius:50%; border:2.5px solid rgba(255,255,255,.2); border-top-color:#a5b4fc; animation:kkspin .8s linear infinite; flex:none; }
      .kk-hud .spin.wait { animation:none; border-color:#fbbf24; }
      .kk-hud .ttl { font-weight:700; }
      .kk-hud .dim { color:#9aa0c3; font-size:12px; }
      .kk-hud .doc { margin-top:9px; font-weight:650; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .kk-hud .steps { display:flex; gap:4px; margin-top:9px; }
      .kk-hud .st { flex:1; text-align:center; font-size:10.5px; padding:4px 2px; border-radius:7px; background:rgba(255,255,255,.06); color:#7d83a8; white-space:nowrap; }
      .kk-hud .st.done { color:#86efac; background:rgba(34,197,94,.1); }
      .kk-hud .st.now { color:#fff; background:linear-gradient(120deg,#4f46e5,#7c3aed); font-weight:650; }
      .kk-hud .log { margin-top:9px; color:#c7cbf0; font-size:12px; font-family:ui-monospace,Consolas,monospace; background:rgba(0,0,0,.25); border-radius:8px; padding:6px 9px; max-height:74px; overflow:hidden; line-height:1.5; }
      .kk-hud .log div:last-child { color:#fde68a; }
      .kk-hud .bar { height:4px; border-radius:99px; background:rgba(255,255,255,.1); margin-top:10px; overflow:hidden; }
      .kk-hud .bar i { display:block; height:100%; background:linear-gradient(90deg,#818cf8,#c084fc); transition:width .4s; }
      .kk-hud .kk-btn { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.12); color:#eef0ff; padding:6px 11px; font-size:12.5px; }
      .kk-hud .kk-btn:hover { background:rgba(255,255,255,.16); }
      .kk-hud .kk-btn.go { background:#16a34a; border-color:#16a34a; }
      .kk-hud .kk-btn.stop { background:transparent; border-color:rgba(248,113,113,.45); color:#fca5a5; }
      .kk-hud .wait { color:#fbbf24; animation:kkpulse 1.6s infinite; }
      .kk-help { left:auto; right:16px; transform:none; width:min(400px,94vw); z-index:1000001; }
      .kk-help .kk-pill { background:color-mix(in srgb,var(--c) 30%,transparent); color:#fff; }
      .kk-help .kk-row { margin-top:6px; }
      .kk-help .line { font-size:12px; margin-top:4px; }
      .kk-help .line .o { color:#9aa0c3; text-decoration:line-through; }
      .kk-help .line .n { color:#fff; font-weight:650; }
      .kk-help .kk-btn:disabled { opacity:.4; }
      .kk-hud .top { cursor:move; user-select:none; touch-action:none; }
      .kk-hud .top .grip { color:#7d83a8; font-size:14px; line-height:1; }
      .kk-hud.drag { opacity:.85; box-shadow:0 24px 60px rgba(10,10,30,.6); }
      .kk-hud.min { width:auto; max-width:94vw; padding:9px 12px; }
      .kk-hud.min > :not(.top) { display:none; }
      .kk-toast { position:fixed; left:50%; top:20px; transform:translateX(-50%); z-index:1000003; background:#111324; color:#fff; padding:10px 16px; border-radius:12px; font:600 13px "Inter",ui-sans-serif,system-ui,sans-serif; box-shadow:0 12px 30px rgba(0,0,0,.3); animation:kkfade .2s; }
    `;
    document.head.appendChild(style);
  }

  function toast(msg) {
    ensureStyles();
    const t = document.createElement("div");
    t.className = "kk-toast";
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
    document.getElementById("kk-panel")?.remove();
  }

  function itemHtml(q) {
    const st = STATUS[q.status] || STATUS.pending;
    const names = q.targets.map((t) => esc(t.nama || "(tanpa nama)")).join(" <span style='color:#a0a4bb'>+</span> ");
    const diff = q.targets
      .map((t) => {
        const kbli =
          !t.kbliBaru || t.kbliLama === t.kbliBaru
            ? `<span class="kk-chg"><span class="k">KBLI</span><span class="u">${esc(t.kbliBaru || t.kbliLama || "-")} (tetap)</span></span>`
            : `<span class="kk-chg"><span class="k">KBLI</span><span class="o">${esc(t.kbliLama || "-")}</span>→<span class="a">${esc(t.kbliBaru)}</span></span>`;
        const produk = t.produkBaru
          ? `<span class="kk-chg"><span class="k">Produk</span><span class="o">${esc(t.produkLama)}</span>→<span class="a">${esc(t.produkBaru)}</span></span>`
          : "";
        const keg = t.kegUtamaBaru
          ? `<span class="kk-chg"><span class="k">Keg. utama</span><span class="o">${esc(t.kegUtamaLama)}</span>→<span class="a">${esc(t.kegUtamaBaru)}</span></span>`
          : "";
        return `${q.targets.length > 1 ? `<span class="kk-chg"><span class="u">${esc((t.nama || "").split("(")[0].trim())}</span></span>` : ""}${kbli}${produk}${keg}`;
      })
      .join("");
    const meta = [q.kec, q.desa, q.sls, q.targets.length > 1 ? `${q.targets.length} usaha` : "", q.statusAwal].filter(Boolean).map(esc).join(" · ");
    return `<div class="kk-item" style="--c:${st.color}">
      <input type="checkbox" data-sel="${q.id}" ${ui.selected.has(q.id) ? "checked" : ""}>
      <div style="min-width:0">
        <div class="nm">${names}<span class="kk-pill">${st.label}</span></div>
        <div class="meta">${meta}</div>
        <div class="kk-diff">${diff}</div>
        ${q.reason ? `<div class="why">${esc(q.reason)}</div>` : ""}
      </div>
      <div class="acts">
        <a class="kk-btn sm ghost" href="${esc(docUrl(q))}" target="_blank" title="Buka dokumen di tab baru">↗</a>
        <a class="kk-btn sm ghost" href="${esc(docUrl(q))}" data-manual="${q.id}" title="Kerjakan manual: buka dokumen di tab ini, panel bantu muncul di kanan bawah">✍</a>
        <button class="kk-btn sm soft" data-one="${q.id}" title="Jalankan dokumen ini saja">▶</button>
      </div>
    </div>`;
  }

  function filteredItems() {
    const s = normalize(ui.search);
    return loadQueue().filter(
      (q) =>
        (ui.filter === "all" || q.status === ui.filter) &&
        (!s || normalize([q.kec, q.desa, q.sls, ...q.targets.map((t) => `${t.nama} ${t.codeIdentity}`)].join(" ")).includes(s)),
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
          `<button class="kk-stat ${ui.filter === k ? "on" : ""}" style="--c:${col}" data-filter="${k}"><div class="n">${c[k] || 0}</div><div class="l">${l}</div></button>`,
      )
      .join("");
    const items = filteredItems();
    root.querySelector("[data-list]").innerHTML = items.length
      ? items.slice(0, ui.limit).map(itemHtml).join("") +
        (items.length > ui.limit ? `<div class="kk-more"><button class="kk-btn sm" data-more>Tampilkan ${Math.min(60, items.length - ui.limit)} lagi (sisa ${items.length - ui.limit})</button></div>` : "")
      : `<div class="kk-empty">${c.all ? "Tidak ada dokumen di filter ini." : "📄 Muat file Excel Pengecekan KBLI dulu."}</div>`;
    root.querySelector("[data-selinfo]").textContent = ui.selected.size ? `${ui.selected.size} dicentang` : "";
    const pend = c.pending;
    root.querySelectorAll("[data-needpend]").forEach((b) => (b.disabled = !pend));
    root.querySelectorAll("[data-runsel]").forEach((b) => (b.disabled = !ui.selected.size));
  }

  function refreshPanel() {
    const root = document.getElementById("kk-panel");
    if (!root) return;
    const a = document.activeElement;
    if (a && root.contains(a) && a.matches("input.kk-search")) {
      renderDynamic(root);
      return;
    }
    const body = root.querySelector(".kk-body");
    const top = body ? body.scrollTop : 0;
    renderDynamic(root);
    if (body) body.scrollTop = top;
  }

  function openPanel() {
    ensureStyles();
    closePanel();
    const conf = loadConf();
    const overlay = document.createElement("div");
    overlay.id = "kk-panel";
    overlay.className = "kk kk-overlay";
    overlay.innerHTML = `
      <div class="kk-sheet">
        <div class="kk-head">
          <div class="row1">
            <div class="kk-logo">${esc(APP.badge)}</div>
            <div>
              <div class="kk-title">${esc(APP.title)}</div>
              <div class="kk-sub"><code>kbli_akhir → KBLI Baru</code> &nbsp;· buka → ganti KBLI/produk → cek anomali KBLI → kirim → approve</div>
            </div>
            <button class="kk-x" data-act="close" title="Tutup (Esc)">×</button>
          </div>
          <div class="kk-prog" data-prog></div>
        </div>
        <div class="kk-body">
          <div class="kk-grid2">
            <div class="kk-card">
              <div class="kk-sec">① Data Excel</div>
              <label class="kk-drop" data-drop>
                <div class="ic">📊</div>
                <div style="min-width:0">
                  <b>${esc(ui.file || (loadQueue().length ? "Antrean tersimpan di browser" : "Pilih / seret file .xlsx"))}</b>
                  <div class="kk-hint">Kolom: <i>link, nama_usaha, kbli_akhir, Edit KBLI (1=Ya), KBLI Baru, Produk, Produk Baru, keg_utama</i>. Hanya baris Edit KBLI = 1 yang dikerjakan. Muat ulang file yang sama tidak menghapus progres.</div>
                </div>
                <input type="file" accept=".xlsx" data-file hidden>
              </label>
              <div class="kk-row" style="margin-top:12px">
                <button class="kk-btn sm" data-act="csv">⬇ Laporan CSV</button>
                <button class="kk-btn sm" data-act="export">💾 Ekspor</button>
                <button class="kk-btn sm" data-act="import">📂 Impor</button>
                <button class="kk-btn sm ghost danger" data-act="clear">Hapus antrean</button>
                <input type="file" accept=".json" data-importfile hidden>
              </div>
            </div>
            <div class="kk-card">
              <div class="kk-sec">② Pengaturan</div>
              <div class="kk-seg" data-speed>${SPEEDS.map((s, i) => `<button data-speed="${i}" class="${Number(conf.speed) === i ? "on" : ""}">${s.name}</button>`).join("")}</div>
              <div style="margin-top:8px">
                <label class="kk-tog"><input type="checkbox" data-conf="checkFirst" ${conf.checkFirst ? "checked" : ""}><span class="sw"></span><span>Cek dulu di Review<small>Kalau KBLI/produk sudah benar, dokumen tidak di-revoke</small></span></label>
                <label class="kk-tog"><input type="checkbox" data-conf="approve" ${conf.approve ? "checked" : ""}><span class="sw"></span><span>Approve setelah kirim</span></label>
                <label class="kk-tog"><input type="checkbox" data-conf="forceOnGalat" ${conf.forceOnGalat ? "checked" : ""}><span class="sw"></span><span>Submit Paksa kalau ada galat<small>Mati: dokumen bergalat ditandai "Perlu cek"</small></span></label>
              </div>
            </div>
          </div>

          <div class="kk-card">
            <div class="kk-sec">③ Jalankan</div>
            <div class="kk-row">
              <button class="kk-btn soft" data-act="test" data-needpend>🧪 Uji 1 dokumen</button>
              <button class="kk-btn" data-act="n5" data-needpend>▶ 5</button>
              <button class="kk-btn" data-act="n20" data-needpend>▶ 20</button>
              <button class="kk-btn" data-act="runsel" data-runsel>▶ Yang dicentang</button>
              <button class="kk-btn primary" data-act="all" data-needpend>⚡ Jalankan semua</button>
              <span style="flex:1"></span>
              <button class="kk-btn sm ghost" data-act="retry" title="Perlu cek, Gagal & Terisi (uji) dikembalikan ke Belum">↻ Ulangi yang bermasalah</button>
            </div>
            <div class="kk-hint" style="margin-top:10px">Bisa dimulai dari halaman FASIH mana saja — tiap dokumen dibuka lewat link di Excel. Kalau link-nya tidak membuka dokumen yang benar, dokumen dicari lewat Filter desa/SLS di halaman daftar assignment (buka halaman daftar itu sekali dulu). Mode uji berhenti tepat sebelum Kirim. Gagal terus? Kerjakan manual lewat tombol ✍ di tiap baris. Pintasan panel: <b>Alt+${APP.hotkey}</b>.</div>
          </div>

          <div class="kk-stats" data-stats></div>

          <div class="kk-row">
            <input class="kk-search" placeholder="Cari nama usaha, desa, kecamatan…" value="${esc(ui.search)}">
            <button class="kk-btn sm" data-act="selall">☑ Centang yang tampil</button>
            <button class="kk-btn sm ghost" data-act="selnone">Kosongkan</button>
            <button class="kk-btn sm" data-act="setstatus" data-runsel title="Hasil cek manual: tentukan status dokumen yang dicentang (ikut ke Laporan CSV)">🏷 Atur status</button>
            <span class="kk-hint" data-selinfo></span>
          </div>
          <div class="kk-list" data-list></div>
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
    overlay.querySelector(".kk-search").addEventListener("input", (e) => {
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
    document.getElementById("kk-status")?.remove();
    ensureStyles();
    const modal = document.createElement("div");
    modal.id = "kk-status";
    modal.className = "kk kk-overlay";
    modal.style.cssText = "align-items:center;justify-content:center;z-index:1000003;";
    const options = Object.entries(STATUS)
      .map(
        ([k, v]) =>
          `<button class="kk-btn" data-status="${k}" style="justify-content:flex-start;text-align:left;border-left:4px solid ${v.color}"><span><b>${v.label}</b><br><span class="kk-hint">${STATUS_HINT[k] || ""}</span></span></button>`,
      )
      .join("");
    modal.innerHTML = `<div class="kk-card" style="width:min(440px,92vw);max-height:90vh;overflow:auto">
      <div class="kk-sec">🏷 Atur status · ${ids.length} dokumen</div>
      <textarea class="kk-search" data-note rows="2" placeholder="Catatan (opsional), mis. sudah dikoreksi manual di FASIH" style="width:100%;resize:vertical"></textarea>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">${options}<button class="kk-btn ghost" data-status="">Batal</button></div>
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
      const { items, sheet, rows, skipped, notFlagged } = await parseWorkbook(await file.arrayBuffer());
      const old = new Map(loadQueue().map((q) => [q.id, q]));
      let kept = 0;
      const merged = items.map((it) => {
        const o = old.get(it.id);
        if (o && o.status !== "pending") {
          kept++;
          return { ...it, status: o.status, reason: o.reason, result: o.result, doneAt: o.doneAt, cardHints: o.cardHints, kbliNotes: o.kbliNotes };
        }
        return it;
      });
      saveQueue(merged);
      ui.file = file.name;
      ui.selected.clear();
      openPanel();
      toast(
        `${rows} baris → ${merged.length} dokumen dari sheet "${sheet}"${kept ? ` · ${kept} progres lama dipertahankan` : ""}${notFlagged ? ` · ${notFlagged} baris Edit KBLI ≠ 1 dilewati` : ""}${skipped ? ` · ${skipped} baris tanpa link / KBLI Baru tidak valid dilewati` : ""}`,
      );
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
      ["no", "baris_excel", "nama_usaha", "kec", "desa", "sls", "kbli_lama", "kbli_baru", "produk_lama", "produk_baru", "kegiatan_utama_lama", "kegiatan_utama_baru", "status", "keterangan", "hasil", "waktu", "link"].join(","),
    ];
    loadQueue().forEach((q) =>
      q.targets.forEach((t) =>
        lines.push(
          [t.no, t.row, t.nama, q.kec, q.desa, q.sls, t.kbliLama, t.kbliBaru, t.produkLama, t.produkBaru, t.kegUtamaLama, t.kegUtamaBaru, (STATUS[q.status] || {}).label, q.reason, q.result, q.doneAt, docUrl(q)]
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
      if (!Array.isArray(data.queue) || data.queue.some((q) => !q.targets || q.targets.some((t) => !("kbliBaru" in t))))
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
  function openCardNow() {
    const kb = visibleKbli();
    if (!kb) return null;
    const inst = instOf(kb);
    const name = ["nama_komersial", "nama_usaha_edit", "nama_usaha"]
      .map((id) => {
        const b = box(id, inst);
        const i = b && b.querySelector("input, textarea");
        return i ? i.value.trim() : "";
      })
      .find(Boolean);
    // kb sudah dipastikan kelihatan (visibleKbli() di atas), jadi baca langsung tanpa menunggu
    const code = effectiveKbliCode(inst);
    return { inst, code, name: name || "" };
  }
  function targetFor(q, card) {
    const t = q.targets;
    const byName = card.name ? t.filter((x) => nameMatch(card.name, x.nama) >= NAME_OK) : [];
    if (byName.length === 1) return byName[0];
    const pool = byName.length ? byName : t;
    return pool.find((x) => card.code === x.kbliBaru) || pool.find((x) => card.code === x.kbliLama) || (t.length === 1 ? t[0] : null);
  }

  // Panel bantu & bar progres bisa digeser (tarik bagian judul) & posisinya diingat;
  // klik dua kali judul = kembali ke tempat semula
  function placeEl(el, key) {
    if (!el) return;
    const pos = loadJson(key, null);
    if (!pos) return Object.assign(el.style, { left: "", top: "", right: "", bottom: "", transform: "" });
    const w = Math.min(el.offsetWidth || 400, window.innerWidth);
    const x = Math.min(Math.max(0, pos.x), window.innerWidth - w);
    const y = Math.min(Math.max(0, pos.y), window.innerHeight - 48);
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto", transform: "none" });
  }
  function makeDraggable(el, key) {
    el.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".top") || e.target.closest("button") || e.button !== 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      el.classList.add("drag");
      const move = (ev) => {
        const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - r.width);
        const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 48);
        Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto", transform: "none" });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        el.classList.remove("drag");
        const b = el.getBoundingClientRect();
        saveJson(key, { x: Math.round(b.left), y: Math.round(b.top) });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".top") || e.target.closest("button")) return;
      saveJson(key, null);
      placeEl(el, key);
    });
  }
  window.addEventListener("resize", () => {
    placeEl(document.getElementById("kk-help"), HELPER_POS_KEY);
    placeEl(document.getElementById("kk-hud"), HUD_POS_KEY);
  });

  let helpSig = "";
  let helpBusy = false;
  function updateHelper() {
    let el = document.getElementById("kk-help");
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
      el.id = "kk-help";
      el.className = "kk kk-hud kk-help";
      el.addEventListener("click", onHelperClick);
      makeDraggable(el, HELPER_POS_KEY);
      document.body.appendChild(el);
      requestAnimationFrame(() => placeEl(el, HELPER_POS_KEY));
    }
    const mini = !!loadJson(HELPER_MIN_KEY, false);
    el.classList.toggle("min", mini);
    const card = openCardNow();
    const editing = onEditOf(id);
    const sig = JSON.stringify([q.status, q.reason, card && card.code, card && card.name, editing, helpBusy, mini]);
    if (sig === helpSig) return;
    helpSig = sig;
    const st = STATUS[q.status] || STATUS.pending;
    const t = card ? targetFor(q, card) : null;
    const rows = q.targets
      .map((x) => {
        const now = card && t === x ? card.code : null;
        const ok = now !== null && (!x.kbliBaru || now === x.kbliBaru);
        const kbliLine = x.kbliBaru
          ? `<div class="line">KBLI: <span class="o">${esc(x.kbliLama || "-")}</span> → <span class="n">${esc(x.kbliBaru)}</span>${now === null ? "" : ok ? " ✓" : ` (sekarang ${esc(now || "-")})`}</div>`
          : `<div class="line">KBLI: <span class="n">tetap</span> (tidak diubah)${now ? ` · sekarang ${esc(now)}` : ""}</div>`;
        const produkLine = x.produkBaru ? `<div class="line">Produk: <span class="o">${esc(x.produkLama)}</span> → <span class="n">${esc(x.produkBaru)}</span></div>` : "";
        const kegLine = x.kegUtamaBaru ? `<div class="line">Keg. utama: <span class="o">${esc(x.kegUtamaLama)}</span> → <span class="n">${esc(x.kegUtamaBaru)}</span></div>` : "";
        return `<div class="doc" style="margin-top:8px">${esc(x.nama)}</div>${kbliLine}${produkLine}${kegLine}`;
      })
      .join("");
    const nameWarn = card && t && card.name && nameMatch(card.name, t.nama) < NAME_OK ? ` ⚠ nama di kartu "${esc(card.name)}" beda dengan Excel` : "";
    const hint = !editing
      ? "Klik Edit (revoke kalau perlu), lalu buka kartu usahanya."
      : card
        ? `Kartu terbuka${t ? ` → ${esc(t.nama)}` : " (tidak cocok dengan Excel)"}${nameWarn}.`
        : "Buka kartu usaha yang mau dikoreksi.";
    el.innerHTML = `
      <div class="top" title="Tarik untuk memindah · klik dua kali untuk kembali ke pojok">
        <span class="grip">⠿</span>
        <div class="ttl">✍ ${esc(APP.name)} — manual</div>
        <span class="kk-pill" style="--c:${st.color}">${st.label}</span>
        <span style="flex:1"></span>
        <button class="kk-btn" data-help="min" title="${mini ? "Perbesar" : "Perkecil"}">${mini ? "▢" : "–"}</button>
        <button class="kk-btn" data-help="hide" title="Sembunyikan untuk dokumen ini">×</button>
      </div>
      ${q.reason ? `<div class="dim" style="margin-top:6px">${esc(q.reason)}</div>` : ""}
      ${rows}
      <div class="dim" style="margin-top:8px">${hint}</div>
      <div class="kk-row" style="margin-top:10px">
        <button class="kk-btn go" data-help="fill" ${editing && card && !helpBusy ? "" : "disabled"}>✏ Isi ke kartu ini</button>
        <button class="kk-btn" data-help="done">✓ Tandai selesai manual</button>
        <button class="kk-btn" data-help="status" title="Pilih status lain (Perlu cek, Gagal, Sudah sesuai, …)">🏷 Status…</button>
        <button class="kk-btn" data-help="auto" title="Kembalikan ke Belum & jalankan otomatis dokumen ini">↻ Otomatis</button>
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
    if (act === "min") {
      saveJson(HELPER_MIN_KEY, !loadJson(HELPER_MIN_KEY, false));
      updateHelper();
      return placeEl(document.getElementById("kk-help"), HELPER_POS_KEY);
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
      if (t.kbliBaru && card.code && card.code !== t.kbliLama && card.code !== t.kbliBaru) warn.push(`KBLI di kartu (${card.code}) beda dari KBLI lama/baru di Excel`);
      if (warn.length && !confirm(`Perhatian: ${warn.join("; ")}.\n\nTetap ganti ke KBLI baru?`)) return;
      helpBusy = true;
      updateHelper();
      try {
        const r = await ensureKbliCard(card.inst, t);
        updateItem(q.id, { result: `${t.nama.split("(")[0].trim()}: ${r.summary} (manual)` });
        toast("KBLI/produk sudah diganti. Cek Anomali KBLI & isian “Pilih UMKM dalam satu SLS” di kartu lain, Kirim & Approve di FASIH, lalu klik “Tandai selesai manual”.");
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
    let hud = document.getElementById("kk-hud");
    if (!run.running) {
      if (hud) hud.remove();
      hudSig = "";
      return;
    }
    if (!document.body) return;
    ensureStyles();
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "kk-hud";
      hud.className = "kk kk-hud";
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
          if (r.cur) finishItem(r.cur.id, "tested", "MODE UJI: KBLI diganti tapi TIDAK dikirim (dokumen masih terbuka edit)");
        }
        if (act === "min") {
          saveJson(HUD_MIN_KEY, !loadJson(HUD_MIN_KEY, false));
          hudSig = "";
          updateHud();
          placeEl(hud, HUD_POS_KEY);
        }
      });
      makeDraggable(hud, HUD_POS_KEY);
      document.body.appendChild(hud);
      requestAnimationFrame(() => placeEl(hud, HUD_POS_KEY));
    }
    const hudMini = !!loadJson(HUD_MIN_KEY, false);
    hud.classList.toggle("min", hudMini);
    const it = run.cur ? loadQueue().find((q) => q.id === run.cur.id) : null;
    const iNow = run.cur ? STEPS.findIndex(([k]) => k === run.cur.stage) : -1;
    const limited = rateLimited();
    const total = run.total || 0;
    const done = run.processed || 0;
    const sig = JSON.stringify([run.cur, run.paused, run.logs, limited, done, run.testMode, run.hold, hudMini]);
    if (sig === hudSig) return;
    hudSig = sig;
    hud.innerHTML = `
      <div class="top" title="Tarik untuk memindah · klik dua kali untuk kembali ke tengah bawah">
        <span class="grip">⠿</span>
        <div class="spin ${run.paused || run.hold || limited ? "wait" : ""}"></div>
        <div class="ttl">${esc(APP.name)}</div>
        <div class="dim">${run.hold ? "⏸ DIJEDA · " : ""}${T().name}${run.testMode ? " · Mode uji" : ""} · ${done}/${total} dokumen</div>
        <span style="flex:1"></span>
        ${run.paused ? `<button class="kk-btn go" data-hud="go">✓ Kirim sekarang</button><button class="kk-btn" data-hud="pass">Lewati</button>` : ""}
        ${run.hold ? `<button class="kk-btn go" data-hud="resume">▶ Lanjut</button>` : `<button class="kk-btn" data-hud="hold" title="Tahan sementara; langkah yang sedang jalan dilanjutkan dari titik yang sama">⏸ Jeda</button>`}
        <button class="kk-btn" data-hud="panel" title="Buka panel">☰</button>
        <button class="kk-btn" data-hud="min" title="${hudMini ? "Perbesar" : "Perkecil"}">${hudMini ? "▢" : "–"}</button>
        <button class="kk-btn stop" data-hud="stop">■ Stop</button>
      </div>
      ${
        run.hold && run.hold.reason === "logout"
          ? `<div class="doc wait">🔒 Sesi FASIH berakhir sejak ${new Date(run.hold.at).toLocaleTimeString("id-ID")} — login ulang dulu, lalu klik ▶ Lanjut. Dokumen yang belum diproses masih aman.</div>`
          : run.hold
            ? `<div class="doc wait">⏸ Dijeda sejak ${new Date(run.hold.at).toLocaleTimeString("id-ID")} — jangan pindah halaman / klik isian supaya bisa dilanjutkan dengan aman</div>`
            : ""
      }
      ${limited ? `<div class="doc wait">⛔ Server membatasi (429) — lanjut otomatis ${new Date(rateInfo().until).toLocaleTimeString("id-ID")}</div>` : ""}
      ${it ? `<div class="doc">▶ ${esc(it.targets.map((t) => t.nama).join(" + "))} <span class="dim">· ${esc([it.desa, it.sls].filter(Boolean).join(" · "))}</span></div>` : ""}
      ${it ? `<div class="steps">${STEPS.map(([k, l], i) => `<div class="st ${i < iNow ? "done" : i === iNow ? "now" : ""}">${i < iNow ? "✓ " : ""}${l}</div>`).join("")}</div>` : ""}
      <div class="log">${(run.logs || []).map((l) => `<div>${esc(l)}</div>`).join("") || "<div>…</div>"}</div>
      <div class="bar"><i style="width:${total ? Math.min(100, (100 * done) / total) : 0}%"></i></div>`;
  }

  function ensureLauncher() {
    if (!document.body || document.getElementById("kk-launch")) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "kk-launch";
    btn.className = "kk-launch";
    btn.innerHTML = `<span class="b">${esc(APP.badge)}</span> ${esc(APP.launch)}`;
    btn.title = `Buka panel (Alt+${APP.hotkey})`;
    btn.style.bottom = `${APP.launchBottom}px`;
    btn.onclick = openPanel;
    document.body.appendChild(btn);
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === APP.hotkey) {
      e.preventDefault();
      document.getElementById("kk-panel") ? closePanel() : openPanel();
    }
  });

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
