// ==UserScript==
// @name         FASIH Remark Anomali Sosek
// @namespace    hanif-bps-hst
// @version      1.7
// @description  Baca Excel "anomali_sosek" (sheet sosek = daftar kategori & remark; R149/R143/R154/R161 = Blok IV keluarga; R63/R31-R34 = Blok I per anggota), buka tiap dokumen, pasang remark (#0) di catatan rincian yang tepat — Blok I di kartu anggota yang NIK-nya cocok — lalu Kirim & Approve.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  // Excel dibaca di browser ini saja; datanya tidak dikirim ke mana pun selain catatan di FASIH.
  // Antrean bisa belasan ribu dokumen (data se-kabupaten) -> disimpan di penyimpanan Tampermonkey
  // (GM_setValue), bukan localStorage yang batasnya ±5 MB dan dipakai bareng skrip FASIH lain.
  const QUEUE_KEY = "rs_queue";
  const QREV_KEY = "rs_queue_rev"; // penanda versi antrean (localStorage) supaya cache di memori tahu kapan harus baca ulang
  const CONF_KEY = "rs_conf";
  const RUN_KEY = "rs_run";
  const LIST_KEY = "rs_list_url";
  const HOME_URL =
    "https://fasih-sm.bps.go.id/app/surveys/a0429e96-51a5-477b-a415-485f9c153004/fd68e454-ba45-4b85-8205-f3bf777ded24/data?page=1&perPage=10";
  const SURVEY_PREFIX = "fd68e454-ba45-4b85-8205-f3bf777ded24"; // bagian pertama link dokumen (sama untuk semua baris Excel)
  const HELPER_KEY = "rs_helper_hidden";
  const HELPER_POS_KEY = "rs_helper_pos";
  const HELPER_MIN_KEY = "rs_helper_min";
  const HUD_POS_KEY = "rs_hud_pos";
  const HUD_MIN_KEY = "rs_hud_min";
  const RATE_KEY = "fasih_rate_limit"; // sama dengan skrip FASIH lain: jeda 429 berlaku bersama

  const APP = {
    name: "Remark Sosek",
    version: "1.7",
    title: "Remark Anomali Sosek",
    badge: "SOS",
    launch: "Remark Sosek",
    hotkey: "8",
    launchBottom: 496,
    file: "remark-sosek",
  };

  const SEC_I = "SE2026 - L BLOK I";
  const SEC_IV = "SE2026 - L BLOK IV";

  // Kategori = nama sheet. fields = id rincian di form FASIH yang diberi remark.
  // Blok I ada di kartu anggota keluarga (id-nya berakhiran #nomor kartu), Blok IV langsung di halaman.
  const CATS = {
    R149: {
      blok: 4,
      fields: ["jumlah_laptop_new"],
      label: "Prelist punya komputer/laptop/tablet, hasil pendataan 0",
      rincian: "Blok IV, R17f",
    },
    R143: {
      blok: 4,
      fields: ["jumlah_ac_new"],
      label: "Prelist punya AC, hasil pendataan 0",
      rincian: "Blok IV, R17d",
    },
    R154: {
      blok: 4,
      fields: ["jumlah_motor_new"],
      label: "Prelist punya sepeda motor, hasil pendataan 0",
      rincian: "Blok IV, R17g.i",
    },
    R161: {
      blok: 4,
      fields: ["jumlah_mobil_new"],
      label: "Prelist punya mobil, hasil pendataan 0",
      rincian: "Blok IV, R17h.i",
    },
    R63: {
      blok: 1,
      fields: ["umur_ak"],
      label: "Umur individu > 90 tahun",
      rincian: "Blok I, R13.b",
    },
    R31: {
      blok: 1,
      fields: ["nik_dtsen", "tgl_lahir"],
      label: "Laki-laki: tanggal lahir ≠ digit 7-8 NIK",
      rincian: "Blok I, R7 dan R13.a (tanggal lahir)",
    },
    R32: {
      blok: 1,
      fields: ["nik_dtsen", "tgl_lahir"],
      label: "Perempuan: tanggal lahir ≠ digit 7-8 NIK",
      rincian: "Blok I, R7 dan R13.a (tanggal lahir)",
    },
    R33: {
      blok: 1,
      fields: ["nik_dtsen", "bln_lahir"],
      label: "Bulan lahir ≠ digit 9-10 NIK",
      rincian: "Blok I, R7 dan R13.a (bulan lahir)",
    },
    R34: {
      blok: 1,
      fields: ["nik_dtsen", "thn_lahir"],
      label: "Tahun lahir ≠ digit 11-12 NIK",
      rincian: "Blok I, R7 dan R13.a (tahun lahir)",
    },
  };
  const FIELD_LABEL = {
    jumlah_laptop_new: "R17f",
    jumlah_ac_new: "R17d",
    jumlah_motor_new: "R17g.i",
    jumlah_mobil_new: "R17h.i",
    umur_ak: "R13.b",
    nik_dtsen: "R7",
    tgl_lahir: "R13.a tgl",
    bln_lahir: "R13.a bln",
    thn_lahir: "R13.a thn",
  };
  const DEFAULT_REMARK = "#0";

  const DEFAULT_CONF = {
    speed: 1,
    patience: 1, // indeks PATIENCE: batas tunggu dikali (FASIH lelet)
    checkFirst: true, // cek dulu di Review: kalau semua remark sudah ada, tidak perlu revoke
    reviewZero: true, // remark cuma #0 (data benar, tidak diubah) -> tulis catatan di Review lalu Approve, tanpa revoke/kirim
    approve: true,
    forceOnGalat: false,
    kab: "HULU SUNGAI TENGAH", // baris Excel kabupaten lain dilewati (kosong = semua)
    catOn: {}, // kategori yang dibaca saat muat Excel (default semua)
    remarks: {}, // teks remark per kategori (default dari kolom Remark sheet sosek)
    catMeta: {}, // label & rincian dari sheet sosek
  };

  const SPEEDS = [
    { name: "Turbo", scale: 0.35, gap: [0, 200], poll: 60 },
    { name: "Kilat", scale: 0.5, gap: [300, 900], poll: 100 },
    { name: "Cepat", scale: 0.75, gap: [1000, 2500], poll: 150 },
    { name: "Normal", scale: 1, gap: [3000, 7000], poll: 250 },
  ];
  const T = () =>
    SPEEDS[
      Math.min(SPEEDS.length - 1, Math.max(0, Number(loadConf().speed) || 0))
    ];
  const W = (ms) => Math.max(100, Math.round(ms * (T().scale || 1)));
  // FASIH kadang lelet: semua batas tunggu (waitFor & batas macet per tahap) dikali faktor ini.
  // Kalau FASIH cepat tidak ada ruginya (waitFor berhenti begitu elemennya muncul).
  const PATIENCE = [
    { name: "Biasa", x: 1 },
    { name: "Sabar ×2", x: 2 },
    { name: "Sabar ×3", x: 3 },
  ];
  const P = () =>
    PATIENCE[
      Math.min(
        PATIENCE.length - 1,
        Math.max(0, Number(loadConf().patience) || 0),
      )
    ];

  const STATUS = {
    pending: { label: "Belum", color: "#6366f1" },
    done: { label: "Selesai", color: "#16a34a" },
    already: { label: "Sudah ada remark", color: "#0d9488" },
    tested: { label: "Terisi (uji)", color: "#0891b2" },
    yellow: { label: "Perlu cek", color: "#d97706" },
    red: { label: "Gagal", color: "#dc2626" },
    manual: { label: "Selesai manual", color: "#7c3aed" },
    forbidden: { label: "Forbidden", color: "#64748b" },
  };
  const FINISHED = ["done", "already", "manual"];
  const STATUS_HINT = {
    pending: "kembali ke antrean, dikerjakan otomatis lagi",
    done: "remark dipasang, dikirim & approve",
    already: "semua remark memang sudah ada di FASIH",
    tested: "remark terpasang tapi belum dikirim",
    yellow: "perlu dicek lagi",
    red: "tidak bisa dikerjakan",
    manual: "dikerjakan sendiri di FASIH",
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
  const HAS_GM =
    typeof GM_getValue === "function" && typeof GM_setValue === "function";
  let qCache = null;
  let qRev = -1;
  function loadQueue() {
    const rev = Number(localStorage.getItem(QREV_KEY)) || 0;
    if (qCache && rev === qRev) return qCache;
    try {
      const raw = HAS_GM
        ? GM_getValue(QUEUE_KEY, "[]")
        : localStorage.getItem(QUEUE_KEY);
      qCache = JSON.parse(raw || "[]") || [];
    } catch (e) {
      qCache = [];
    }
    qRev = rev;
    return qCache;
  }
  let saveWarned = false;
  function saveQueue(q) {
    const raw = JSON.stringify(q);
    try {
      if (HAS_GM) GM_setValue(QUEUE_KEY, raw);
      else localStorage.setItem(QUEUE_KEY, raw);
    } catch (e) {
      console.error(`[${APP.name}] Gagal menyimpan antrean.`, e);
      if (!saveWarned)
        alert(
          `Antrean terlalu besar untuk disimpan (${Math.round(raw.length / 1e6)} MB). Saring per kabupaten / kurangi kategori.`,
        );
      saveWarned = true;
    }
    qCache = q;
    qRev = (Number(localStorage.getItem(QREV_KEY)) || 0) + 1;
    try {
      localStorage.setItem(QREV_KEY, String(qRev));
    } catch (e) {}
  }
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
    const count =
      Date.now() - (prev.at || 0) < 2 * 3600000 ? (prev.count || 0) + 1 : 1;
    const minutes = Math.min(60, 15 * Math.pow(2, count - 1));
    saveJson(RATE_KEY, {
      at: Date.now(),
      until: Date.now() + minutes * 60000,
      count,
      url: String(url || "").slice(0, 200),
    });
    const cf = loadConf();
    cf.speed = Math.min(SPEEDS.length - 1, (Number(cf.speed) || 0) + 1);
    saveConf(cf);
    console.warn(
      `[${APP.name}] 429 dari server. Berhenti ${minutes} menit, kecepatan turun ke ${SPEEDS[cf.speed].name}.`,
    );
  }
  (function watch429() {
    // Skrip ini jalan di sandbox Tampermonkey; fetch halaman dibungkus lewat unsafeWindow kalau bisa.
    // Kalau tidak bisa pun tidak apa: skrip FASIH lain (grant none) menulis jeda 429 ke RATE_KEY yang sama.
    try {
      const PAGE = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const origFetch = PAGE.fetch;
      if (origFetch && !origFetch.__rs) {
        const wrapped = function (input) {
          return origFetch.apply(this, arguments).then((res) => {
            if (res && res.status === 429)
              noteRateLimit(
                typeof input === "string" ? input : input && input.url,
              );
            return res;
          });
        };
        wrapped.__rs = true;
        PAGE.fetch = wrapped;
      }
      const XHR = PAGE.XMLHttpRequest && PAGE.XMLHttpRequest.prototype;
      if (XHR && !XHR.__rs) {
        const origOpen = XHR.open;
        const origSend = XHR.send;
        XHR.open = function (method, url) {
          this.__rsUrl = url;
          return origOpen.apply(this, arguments);
        };
        XHR.send = function () {
          this.addEventListener("loadend", () => {
            if (this.status === 429) noteRateLimit(this.__rsUrl);
          });
          return origSend.apply(this, arguments);
        };
        XHR.__rs = true;
      }
    } catch (e) {
      console.warn(`[${APP.name}] Tidak bisa memantau 429 langsung.`, e);
    }
  })();

  let stopRequested = false;
  const onHold = () => !!loadRun().hold;
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
    if (!document.body || document.querySelector(".fasih-form-sidebar"))
      return (forbiddenLast = false);
    const text = Array.from(document.body.children)
      .filter(
        (el) =>
          !/^(rs|kk)-/.test(el.id || "") &&
          !/^(SCRIPT|STYLE)$/.test(el.tagName),
      )
      .map((el) => el.innerText || "")
      .join(" ");
    return (forbiddenLast =
      /\b403\b.{0,20}(forbidden|akses)|forbidden|akses ditolak|access denied|tidak (memiliki|punya) (hak )?akses/i.test(
        text,
      ));
  }
  const forbiddenError = () =>
    Object.assign(new Error("halaman Forbidden (tidak ada akses)"), {
      forbidden: true,
    });

  async function waitFor(check, timeoutMs) {
    timeoutMs *= P().x;
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

  const OWN =
    "#rs-panel, #rs-hud, #rs-launch, #rs-help, #rs-status, #kk-panel, #kk-hud, #kk-launch, #kk-help, #kk-status";
  const normalize = (text) =>
    String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  const digits = (s) => String(s ?? "").replace(/\D/g, "");
  const visible = (el) =>
    !!el &&
    (el.offsetParent !== null ||
      (el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden"));
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
    );

  function triggerClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
      (type) => {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        el.dispatchEvent(
          new Ctor(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            button: 0,
          }),
        );
      },
    );
  }
  function pressKey(key) {
    const code = key === "Enter" ? 13 : 27;
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: key,
        keyCode: code,
        bubbles: true,
      }),
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
      typed =
        value === ""
          ? document.execCommand("delete", false)
          : document.execCommand("insertText", false, value);
    } catch (e) {
      typed = false;
    }
    if (!typed || el.value !== value) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value,
        }),
      );
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // =========================================================================
  // KECOCOKAN NAMA ANGGOTA (cadangan kalau NIK di form sudah diperbaiki & beda dari Excel)
  // =========================================================================
  function levenshteinRatio(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++)
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }
  const nameScore = (a, b) => {
    const x = normalize(a);
    const y = normalize(b);
    return x && y ? levenshteinRatio(x, y) : 0;
  };
  const NAME_OK = 0.8;

  // =========================================================================
  // MEMBACA EXCEL (.xlsx = zip berisi XML). File anomali_sosek ±50 MB dengan >100 ribu baris per sheet,
  // jadi XML-nya dibaca pakai regex (bukan DOMParser yang bisa bikin tab kehabisan memori) dan baris
  // kabupaten lain langsung dibuang saat dibaca.
  // =========================================================================
  async function openZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    let eocd = -1;
    for (
      let i = bytes.length - 22;
      i >= Math.max(0, bytes.length - 65557);
      i--
    ) {
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
      const name = new TextDecoder().decode(
        bytes.subarray(ptr + 46, ptr + 46 + nameLen),
      );
      files[name] = {
        method: view.getUint16(ptr + 10, true),
        size: view.getUint32(ptr + 20, true),
        offset: view.getUint32(ptr + 42, true),
      };
      ptr +=
        46 +
        nameLen +
        view.getUint16(ptr + 30, true) +
        view.getUint16(ptr + 32, true);
    }
    return async (name) => {
      const f = files[name];
      if (!f) return null;
      const start =
        f.offset +
        30 +
        view.getUint16(f.offset + 26, true) +
        view.getUint16(f.offset + 28, true);
      const data = bytes.subarray(start, start + f.size);
      if (f.method === 0) return new TextDecoder().decode(data);
      const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    };
  }

  const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const unxml = (s) =>
    String(s).replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, e) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1].toLowerCase() === "x"
              ? parseInt(e.slice(2), 16)
              : parseInt(e.slice(1), 10),
          )
        : XML_ENT[e.toLowerCase()],
    );
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? unxml(m[1]) : "";
  };
  const colIndex = (ref) =>
    ref
      .replace(/\d+/g, "")
      .split("")
      .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const joinT = (xml) => {
    let s = "";
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(xml))) s += m[1];
    return unxml(s);
  };

  async function openWorkbook(arrayBuffer) {
    const read = await openZip(arrayBuffer);
    const sharedXml = (await read("xl/sharedStrings.xml")) || "";
    const shared = [];
    const reSi = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m;
    while ((m = reSi.exec(sharedXml)))
      shared.push(
        m[1] ? joinT(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")) : "",
      );
    const rels = {};
    ((await read("xl/_rels/workbook.xml.rels")) || "").replace(
      /<Relationship\b[^>]*>/g,
      (tag) => {
        rels[attr(tag, "Id")] = attr(tag, "Target");
        return tag;
      },
    );
    const sheets = [];
    ((await read("xl/workbook.xml")) || "").replace(
      /<sheet\b[^>]*>/g,
      (tag) => {
        let target = (rels[attr(tag, "r:id")] || "").replace(/^\//, "");
        if (target && !target.startsWith("xl/")) target = "xl/" + target;
        sheets.push({ name: attr(tag, "name"), target });
        return tag;
      },
    );
    // Panggil onRow(cells) untuk tiap baris sheet; onRow mengembalikan false = berhenti
    async function eachRow(sheetName, onRow) {
      const s = sheets.find((x) => x.name === sheetName);
      if (!s) return false;
      const xml = await read(s.target);
      if (!xml) return false;
      const reRow = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
      const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let row;
      while ((row = reRow.exec(xml))) {
        const cells = [];
        const inner = row[1] || "";
        reC.lastIndex = 0;
        let c;
        while ((c = reC.exec(inner))) {
          const a = c[1];
          const body = c[2] || "";
          const ref = (a.match(/\br="([A-Z]+)\d*"/) || [])[1];
          if (!ref) continue;
          const t = (a.match(/\bt="(\w+)"/) || [])[1];
          let value = "";
          if (t === "inlineStr") value = joinT(body);
          else {
            const v = body.match(/<v>([\s\S]*?)<\/v>/);
            if (v)
              value = t === "s" ? (shared[Number(v[1])] ?? "") : unxml(v[1]);
          }
          cells[colIndex(ref)] = String(value);
        }
        if (
          onRow(Array.from(cells, (x) => (x === undefined ? "" : x))) === false
        )
          break;
      }
      return true;
    }
    return { sheets: sheets.map((s) => s.name), eachRow };
  }

  const UUID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const hdrKey = (h) =>
    String(h || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

  // Status yang sudah tertulis di Excel (kolom status_web dari alat rekap, atau status_remark dari skrip
  // ini) -> status antrean, supaya Excel yang di-upload ulang tidak mengerjakan lagi yang sudah beres.
  function excelStatus(label, reason) {
    const t = normalize(label);
    if (!t || /^(BELUM|PENDING)/.test(t)) return null;
    if (/SUDAH ADA REMARK|ALREADY/.test(t)) return "already";
    if (/MANUAL/.test(t)) return "manual";
    if (/^(SELESAI|SUKSES|HIJAU|DONE)/.test(t))
      return /remark sudah ada|tidak diubah/i.test(reason) ? "already" : "done";
    if (/PERLU CEK|KUNING|YELLOW/.test(t)) return "yellow";
    if (/FORBIDDEN/.test(t)) return "forbidden";
    if (/GAGAL|MERAH|RED/.test(t)) return "red";
    return null;
  }
  const excelTime = (t) => {
    const m = String(t || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    return m
      ? new Date(`${m[1]}T${m[2]}:00+08:00`).toISOString()
      : new Date().toISOString();
  };
  async function parseWorkbook(arrayBuffer, onProgress) {
    const conf = loadConf();
    const wb = await openWorkbook(arrayBuffer);
    const meta = {};
    // Sheet "sosek": Kategori Sosek | Jumlah | Rincian | Remark
    if (wb.sheets.includes("sosek")) {
      let first = true;
      await wb.eachRow("sosek", (r) => {
        if (first) return ((first = false), true);
        const code = (String(r[0] || "").match(/^\s*(R\d+)\b/i) || [])[1];
        if (code)
          meta[code.toUpperCase()] = {
            label: String(r[0])
              .replace(/^\s*R\d+\.\s*/i, "")
              .trim(),
            jumlah: r[1],
            rincian: r[2],
            remark: String(r[3] ?? "").trim(),
          };
      });
    }
    const kabWant = normalize(conf.kab);
    const byDoc = new Map();
    const stats = {};
    const unknown = wb.sheets.filter(
      (s) => s !== "sosek" && !CATS[s.toUpperCase()],
    );
    for (const sheet of wb.sheets) {
      const cat = sheet.toUpperCase();
      const def = CATS[cat];
      if (!def) continue;
      if (conf.catOn[cat] === false) {
        stats[cat] = { off: true };
        continue;
      }
      onProgress && onProgress(`Membaca sheet ${sheet}…`);
      await new Promise((r) => setTimeout(r, 30));
      let col = null;
      const st = (stats[cat] = {
        rows: 0,
        kept: 0,
        noLink: 0,
        docs: new Set(),
      });
      await wb.eachRow(sheet, (r) => {
        if (!col) {
          const h = r.map(hdrKey);
          const at = (...names) => h.findIndex((x) => names.includes(x));
          col = {
            link: at("link_fasih_sm", "link"),
            kab: at("nama_kab"),
            kec: at("nama_kec"),
            desa: at("nama_desa"),
            sls: at("nama_sls"),
            kk: at("nama_kk"),
            no: at("no_urut_kk"),
            nik: at("nik_dtsen", "nik"),
            nama: at("nama_dtsen"),
            stWeb: at("status_web"),
            ketWeb: at("keterangan_web"),
            wWeb: at("waktu_status_web"),
            stRem: at("status_remark"),
            ketRem: at("keterangan_remark"),
            wRem: at("waktu_remark"),
          };
          if (col.link < 0)
            throw new Error(
              `kolom link_fasih_sm tidak ada di sheet "${sheet}"`,
            );
          return true;
        }
        const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
        if (!r.some((x) => String(x).trim())) return true;
        st.rows++;
        if (kabWant && col.kab >= 0 && normalize(get("kab")) !== kabWant)
          return true;
        const ids = get("link").match(UUID_RE) || [];
        if (!ids.length) {
          st.noLink++;
          return true;
        }
        const id = ids[ids.length - 1].toLowerCase();
        const pre =
          ids.length > 1 ? ids[ids.length - 2].toLowerCase() : SURVEY_PREFIX;
        if (!byDoc.has(id))
          byDoc.set(id, {
            id,
            pre: pre === SURVEY_PREFIX ? undefined : pre,
            kec: get("kec"),
            desa: get("desa"),
            sls: get("sls"),
            kk: get("kk"),
            iv: {},
            m: {},
            cats: new Set(),
          });
        const doc = byDoc.get(id);
        doc.cats.add(cat);
        // status_web (lebih baru, dari alat rekap) didahulukan; kosong / "Belum" -> pakai status_remark
        for (const [s, k, w] of [
          ["stWeb", "ketWeb", "wWeb"],
          ["stRem", "ketRem", "wRem"],
        ]) {
          const code = excelStatus(get(s), get(k));
          if (!code) continue;
          if (!doc.xs || get(w) > doc.xs.at)
            doc.xs = {
              status: code,
              reason: get(k) || get("ketRem"),
              at: get(w) || get("wRem"),
            };
          break;
        }
        if (def.blok === 4) {
          def.fields.forEach(
            (f) => (doc.iv[f] = [...new Set([...(doc.iv[f] || []), cat])]),
          );
        } else {
          const nik = digits(get("nik"));
          const no = digits(get("no"));
          const nama = get("nama");
          const key = nik || `${no}|${normalize(nama)}`;
          const mem = (doc.m[key] = doc.m[key] || { nik, no, nama, f: {} });
          if (!mem.nama && nama) mem.nama = nama;
          def.fields.forEach(
            (f) => (mem.f[f] = [...new Set([...(mem.f[f] || []), cat])]),
          );
        }
        st.kept++;
        st.docs.add(id);
        return true;
      });
    }
    const items = Array.from(byDoc.values()).map((d) => ({
      id: d.id,
      ...(d.pre ? { pre: d.pre } : {}),
      kec: d.kec,
      desa: d.desa,
      sls: d.sls,
      kk: d.kk,
      cats: Array.from(d.cats),
      iv: Object.entries(d.iv),
      m: Object.values(d.m).map((x) => ({
        nik: x.nik,
        no: x.no,
        nama: x.nama,
        f: Object.entries(x.f),
      })),
      // Semua status di Excel (Selesai, Gagal, Perlu cek, dll.) ikut masuk antrean beserta alasannya.
      // Yang Gagal / Perlu cek tidak dijalankan ulang otomatis; pakai tombol "Ulangi yang bermasalah".
      ...(d.xs
        ? {
            status: d.xs.status,
            reason: d.xs.reason || "status dari Excel",
            fromExcel: true,
            doneAt: excelTime(d.xs.at),
          }
        : { status: "pending", reason: "" }),
    }));
    Object.values(stats).forEach((s) => s.docs && (s.docs = s.docs.size));
    return { items, meta, stats, unknown };
  }

  // =========================================================================
  // REMARK
  // =========================================================================
  const catMeta = (cat) => ({
    ...CATS[cat],
    ...((loadConf().catMeta || {})[cat] || {}),
  });
  const remarkOf = (cat) => {
    const r = (loadConf().remarks || {})[cat];
    return String(r === undefined ? DEFAULT_REMARK : r).trim();
  };
  // Teks remark unik untuk satu rincian (rincian R7 bisa diminta beberapa kategori sekaligus: R31 & R33)
  const tagsFor = (cats) => [...new Set(cats.map(remarkOf).filter(Boolean))];
  // Semua teks remark yang diminta satu dokumen (Blok IV + semua anggota)
  const itemTags = (q) => [
    ...new Set([
      ...q.iv.flatMap(([, c]) => tagsFor(c)),
      ...q.m.flatMap((m) => m.f.flatMap(([, c]) => tagsFor(c))),
    ]),
  ];
  // #0 = data sudah benar, tidak ada yang diubah -> tidak perlu revoke; selain #0 (mis. #1 = ada perubahan) lewat Edit
  const reviewOnly = (q) =>
    !!loadConf().reviewZero && itemTags(q).every((t) => t === "#0");
  const itemHasWork = (q) =>
    q.iv.some(([, cats]) => tagsFor(cats).length) ||
    q.m.some((m) => m.f.some(([, cats]) => tagsFor(cats).length));
  // Tag utuh (bukan potongan): "#0" tidak cocok dengan "#01"
  const hasTag = (msg, tag) =>
    !!tag &&
    new RegExp(tag.replace(/[^\w#]/g, (ch) => "\\" + ch) + "(?!\\w)", "i").test(
      msg,
    );
  const noteMessages = () =>
    Array.from(document.querySelectorAll('[class*="wrap-break-word"]'))
      .filter(visible)
      .map((el) => el.textContent.trim());
  const noteBox = () =>
    Array.from(document.querySelectorAll("textarea")).find(
      (t) =>
        visible(t) &&
        /tambah catatan/i.test(t.placeholder || "") &&
        !t.closest(OWN),
    );
  const anyDialog = () =>
    Array.from(document.querySelectorAll('[role="dialog"]')).some(
      (d) => visible(d) && !d.closest(OWN),
    );

  // Catatan di FASIH itu thread chat: kotak "Tambah catatan di sini..." selalu kosong (kotak ketik pesan
  // baru), catatan yang sudah ada muncul sebagai pesan di atasnya, dan begitu terkirim tidak bisa dihapus.
  // Jadi tag yang sudah ada di thread TIDAK dikirim lagi. write=false: cuma baca (dipakai di Review).
  // Hasil: { missing } = isian tidak ada; { noBtn } = tombol Catatan tidak ada; atau { present, added, need }.
  async function remarkField(id, inst, tags, write) {
    const c = await waitBox(id, inst, 3000);
    if (!c) return { missing: true };
    const btn = Array.from(c.querySelectorAll('button[title="Catatan"]')).find(
      visible,
    );
    if (!btn) return { noBtn: true };
    triggerClick(btn);
    let ta = await waitFor(noteBox, 4000);
    if (!ta) {
      closeDialogs();
      return { noBtn: true };
    }
    await sleep(W(300));
    await waitFor(() => noteMessages().length, W(1200)); // thread pesan lama dimuat sesaat setelah popup terbuka
    const present = tags.filter((t) =>
      noteMessages().some((msg) => hasTag(msg, t)),
    );
    const need = tags.filter((t) => !present.includes(t));
    const added = [];
    if (write) {
      for (const tag of need) {
        ta = noteBox() || ta;
        if (!ta || ta.disabled || ta.readOnly) break;
        setFieldValue(ta, tag);
        const simpan = await waitFor(
          () =>
            Array.from(
              document.querySelectorAll('button[title="Simpan"]'),
            ).find((b) => visible(b) && !b.disabled && !b.closest(OWN)),
          2500,
        );
        if (!simpan) break;
        triggerClick(simpan);
        if (
          await waitFor(
            () => noteMessages().some((msg) => hasTag(msg, tag)),
            8000,
          )
        )
          added.push(tag);
        else break;
        await sleep(W(300));
      }
    }
    closeDialogs();
    await waitFor(() => !anyDialog(), 3000);
    await sleep(W(200));
    return { present, added, need: need.filter((t) => !added.includes(t)) };
  }

  // =========================================================================
  // FORM ASSIGNMENT
  // =========================================================================
  const box = (id, inst) =>
    document.getElementById(inst === undefined ? id : `${id}#${inst}`);
  async function waitBox(id, inst, ms) {
    return waitFor(() => {
      const b = box(id, inst);
      return visible(b) ? b : null;
    }, ms);
  }
  const fieldValue = (id, inst) => {
    const b = box(id, inst);
    const el =
      b &&
      b.querySelector(
        'input[type="text"], textarea, input:not([type="radio"]):not([type="checkbox"])',
      );
    return el ? el.value.trim() : "";
  };

  function buttonByText(text) {
    return Array.from(document.querySelectorAll("button")).find(
      (b) =>
        visible(b) &&
        !b.disabled &&
        b.innerText.trim().toUpperCase() === text.toUpperCase() &&
        !b.closest(OWN),
    );
  }
  function buttonByIcon(icon) {
    const svg = Array.from(
      document.querySelectorAll(`svg.tabler-icon-${icon}`),
    ).find(
      (s) =>
        s.closest("button") && visible(s.closest("button")) && !s.closest(OWN),
    );
    return svg ? svg.closest("button") : null;
  }

  const squash = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const sidebarItems = () =>
    Array.from(
      document.querySelectorAll(
        ".fasih-form-sidebar > div[title], .fasih-form-sidebar [title]",
      ),
    );
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
    if (!(await waitFor(readyCheck, 20000)))
      throw new Error(`halaman "${title}" tidak terbuka`);
    await sleep(W(700));
    return true;
  }

  // ---------- Blok I: kartu anggota keluarga ----------
  const openNik = () =>
    Array.from(document.querySelectorAll('[id^="nik_dtsen#"]')).find(visible) ||
    null;
  const onMemberList = () => visible(box("nested_dtsen")) && !openNik();
  function memberCards() {
    const list = box("nested_dtsen");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-nested-view]")).map(
      (card) => {
        const span = card.querySelector("span");
        const num = Array.from(card.querySelectorAll("div")).find((d) =>
          /^\d+$/.test(d.innerText.trim()),
        );
        return {
          card,
          no: num ? num.innerText.trim() : "",
          name: (span ? span.innerText : card.innerText).trim().toUpperCase(),
        };
      },
    );
  }
  async function openMember(card) {
    triggerClick(card.card);
    const el = await waitFor(openNik, 20000);
    if (!el) throw new Error(`kartu anggota "${card.name}" tidak terbuka`);
    await sleep(W(700));
    return el.id.split("#")[1];
  }

  // Pasang (write=true) / cek (write=false) semua remark satu kelompok rincian. Hasil dikumpulkan ke acc.
  async function doFields(fields, inst, write, who, acc) {
    for (const [field, cats] of fields) {
      const tags = tagsFor(cats);
      if (!tags.length) continue;
      const label = `${who}${FIELD_LABEL[field] || field}`;
      const r = await remarkField(field, inst, tags, write);
      if (r.missing) acc.problems.push(`${label}: isian tidak muncul`);
      else if (r.noBtn) acc.problems.push(`${label}: tombol Catatan tidak ada`);
      else {
        if (r.added.length) acc.notes.push(`${label} +${r.added.join(" ")}`);
        if (r.present.length)
          acc.notes.push(`${label} sudah ${r.present.join(" ")}`);
        if (r.need.length)
          (write ? acc.problems : acc.todo).push(
            `${label} ${write ? "gagal simpan" : "belum"} ${r.need.join(" ")}`,
          );
        if (r.added.length) acc.added++;
      }
    }
  }

  // Telusuri dokumen ini: Blok IV langsung, Blok I lewat kartu anggota yang NIK-nya sama dengan Excel.
  // write=false: cuma baca (aman di halaman Review). write=true: pasang remark yang belum ada.
  async function scanDoc(item, write) {
    const acc = { notes: [], problems: [], todo: [], added: 0 };
    if (!(await waitFor(() => sidebarItems().length, 30000)))
      throw new Error("sidebar form belum termuat");
    const iv = item.iv.filter(([, cats]) => tagsFor(cats).length);
    if (iv.length) {
      await goSection(
        SEC_IV,
        () => visible(box(iv[0][0])) || visible(box("aset_bergerak")),
      );
      await doFields(iv, undefined, write, "", acc);
    }
    const members = item.m.filter((m) =>
      m.f.some(([, cats]) => tagsFor(cats).length),
    );
    if (members.length) {
      await goSection(SEC_I, onMemberList, true);
      const cards = memberCards();
      if (!cards.length)
        throw new Error("tidak ada kartu anggota keluarga di Blok I");
      const left = new Set(members.map((_, i) => i));
      // Urutkan kartu: yang nomor urut / namanya cocok dengan Excel dibuka lebih dulu
      const order = cards
        .map((c, idx) => ({
          idx,
          score: Math.max(
            ...members.map(
              (m) =>
                (m.no && m.no === c.no ? 1 : 0) + nameScore(c.name, m.nama),
            ),
          ),
        }))
        .sort((a, b) => b.score - a.score);
      let first = true;
      for (const o of order) {
        if (!left.size) break;
        if (!first) await goSection(SEC_I, onMemberList, true);
        first = false;
        const card = memberCards()[o.idx];
        if (!card) continue;
        const inst = await openMember(card);
        const nik = digits(fieldValue("nik_dtsen", inst));
        const nama = fieldValue("nama_dtsen_edit", inst) || card.name;
        let mi = [...left].find(
          (i) => members[i].nik && members[i].nik === nik,
        );
        let viaName = false;
        // NIK beda (mis. sudah diperbaiki petugas): cocokkan nomor urut + nama, harus dua-duanya cocok
        if (mi === undefined) {
          mi = [...left].find(
            (i) =>
              members[i].no &&
              members[i].no === card.no &&
              members[i].nama &&
              nameScore(nama, members[i].nama) >= NAME_OK,
          );
          viaName = mi !== undefined;
        }
        if (mi === undefined) continue;
        left.delete(mi);
        const m = members[mi];
        if (viaName)
          acc.notes.push(
            `"${nama}": NIK di form ${nik || "-"} ≠ Excel ${m.nik || "-"}, dicocokkan lewat no urut + nama`,
          );
        await doFields(m.f, inst, write, `${card.no}. ${nama} · `, acc);
      }
      if (left.size)
        acc.problems.push(
          `anggota tidak ketemu di Blok I: ${[...left].map((i) => `${members[i].nama || "?"} (NIK ${members[i].nik || "-"}, no ${members[i].no || "-"})`).join(", ")}`,
        );
    }
    return acc;
  }

  // =========================================================================
  // HALAMAN DAFTAR ASSIGNMENT
  // =========================================================================
  const REVIEW_HREF = /\/app\/assignment\/[0-9a-f-]{36}\/[0-9a-f-]{36}/i;
  const searchInput = () =>
    document.querySelector('input[placeholder^="Cari"]:not([cmdk-input])');
  const isListPage = () =>
    !REVIEW_HREF.test(location.pathname) &&
    !/\/app\/assignment-detail\//i.test(location.pathname) &&
    !!searchInput() &&
    !!document.querySelector("table thead");

  // ---------- Review -> Edit (revoke bila perlu) ----------
  // Revoke saja (tetap di halaman Review): klik Revoke, Konfirmasi, tunggu Edit/Approve aktif lagi
  async function revokeDoc() {
    const revoke = buttonByIcon("rotate-clockwise");
    if (!revoke || revoke.disabled)
      throw new Error("tombol Edit & Revoke tidak aktif");
    log("Revoke dokumen");
    triggerClick(revoke);
    const ok = await waitFor(() => buttonByText("Konfirmasi"), 8000);
    if (!ok) throw new Error("konfirmasi revoke tidak muncul");
    triggerClick(ok);
    const edit = await waitFor(() => {
      const b = buttonByIcon("edit");
      return b && !b.disabled ? b : null;
    }, 20000);
    if (!edit) throw new Error("tombol Edit belum aktif setelah revoke");
    await sleep(W(600));
    return edit;
  }
  async function reviewToEdit() {
    await waitFor(
      () => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"),
      20000,
    );
    await sleep(W(600));
    let revoked = false;
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      edit = await revokeDoc();
      revoked = true;
    }
    triggerClick(edit);
    if (
      !(await waitFor(
        () =>
          /\/edit/.test(location.pathname) &&
          document.querySelector(".fasih-form-sidebar"),
        30000,
      ))
    )
      throw new Error("halaman edit tidak terbuka");
    await sleep(W(1500));
    return revoked;
  }

  // ---------- CATATAN: toggle Anomali (sama seperti skrip KBLI, dinyalakan sebelum Kirim) ----------
  function findAnomaliSwitch() {
    const direct = document.querySelector(
      '#cek_anomali_button input[role="switch"]',
    );
    if (direct) return direct;
    return (
      Array.from(document.querySelectorAll('input[role="switch"]')).find(
        (sw) => {
          let el = sw;
          for (let i = 0; i < 7 && el; i++, el = el.parentElement)
            if (/anomali/i.test(el.innerText || "")) return true;
          return false;
        },
      ) || null
    );
  }
  function findAnomaliControl() {
    const direct = findAnomaliSwitch();
    const near =
      direct && direct.parentElement.querySelector('[id$="-control"]');
    if (near) return near;
    return (
      Array.from(document.querySelectorAll('[id$="-control"]')).find((el) => {
        if (!visible(el)) return false;
        let p = el;
        for (let i = 0; i < 7 && p; i++, p = p.parentElement)
          if (/anomali/i.test(p.innerText || "")) return true;
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
        (!!c &&
          (c.hasAttribute("data-checked") ||
            c.getAttribute("aria-checked") === "true"))
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

  // ---------- Kirim + Approve ----------
  const isKirimText = (b) => b.innerText.trim().toUpperCase() === "KIRIM";
  const inDialog = (b) => !!b.closest('[role="dialog"], [role="alertdialog"]');
  const hasSendIcon = (b) =>
    !!b.querySelector('svg path[d^="M10 14l11 -11"], svg.tabler-icon-send');
  function findNavKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) =>
        visible(b) &&
        !b.disabled &&
        isKirimText(b) &&
        !inDialog(b) &&
        !b.closest(OWN),
    );
    return (
      buttons.find(hasSendIcon) ||
      buttons.find((b) => b.id === "fasih-form-nav-submit-button") ||
      buttons[0] ||
      null
    );
  }
  function findDialogKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !b.closest(OWN),
    );
    return (
      buttons.find(inDialog) ||
      buttons.find(
        (b) => !hasSendIcon(b) && b.id !== "fasih-form-nav-submit-button",
      ) ||
      null
    );
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
        const card =
          lihat.closest('div[class*="rounded-lg"]') ||
          lihat.parentElement.parentElement;
        const titleEl = card.querySelector("div[title]");
        return `${titleEl ? titleEl.getAttribute("title").trim() : "?"} (${Array.from(
          card.querySelectorAll("li"),
        )
          .map((li) => li.innerText.trim())
          .join(", ")})`;
      });
  }
  function closeDialogs() {
    Array.from(document.querySelectorAll('button[aria-label="Dismiss"]'))
      .filter(visible)
      .forEach((b) => triggerClick(b));
    if (anyDialog()) pressKey("Escape");
  }
  function dialogText() {
    const d = Array.from(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    )
      .filter(visible)
      .pop();
    return d ? d.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  }
  const backButton = () =>
    Array.from(document.querySelectorAll("button")).find(
      (b) =>
        /KEMBALI KE REVIEW/i.test(b.innerText) && b.getClientRects().length > 0,
    );
  const leftEdit = () => !/\/edit/.test(location.pathname);
  async function backToReview(timeoutMs) {
    const sign = await waitFor(
      () => backButton() || (leftEdit() ? "left" : null),
      timeoutMs,
    );
    if (!sign)
      throw new Error(
        `tidak ada tanda terkirim setelah Konfirmasi: ${dialogText() || "cek manual"}`,
      );
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
    await waitFor(
      () =>
        summaryCount("GALAT") || findDialogKirim() || readGalatList().length,
      15000,
    );
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
      throw Object.assign(
        new Error(`galat ${n}: ${detail || "lihat di FASIH"}`),
        { soft: true, noRetry: true },
      );
    }
    const dialogKirim = findDialogKirim();
    if (!dialogKirim)
      throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    markSubmitClicked();
    triggerClick(dialogKirim);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi)
      throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }
  const isDotsButton = (b) => !!b.querySelector('svg path[d^="M12 12m-1 0"]');
  function findForceTrigger() {
    const cands = Array.from(
      document.querySelectorAll(
        'button[id^="dropdownmenu-"][id$="-trigger"], button[aria-haspopup="true"], button[aria-haspopup="menu"]',
      ),
    ).filter((b) => visible(b) && isDotsButton(b) && !b.closest(OWN));
    return cands.find(inDialog) || cands[0] || null;
  }
  async function forceSubmit(galatN) {
    const trigger = await waitFor(findForceTrigger, 8000);
    if (!trigger)
      throw new Error(`galat ${galatN}, tombol ⋮ (Submit Paksa) tidak muncul`);
    triggerClick(trigger);
    const menu = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find(
          (el) => visible(el) && /SUBMIT\s+PAKSA/i.test(el.innerText),
        ),
      6000,
    );
    if (!menu) {
      pressKey("Escape");
      throw new Error(`galat ${galatN}, menu "Submit Paksa" tidak ada`);
    }
    triggerClick(menu);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi)
      throw new Error(
        `tombol Konfirmasi Submit Paksa tidak muncul: ${dialogText()}`,
      );
    markSubmitClicked();
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }
  async function approveDocument() {
    const findCheck = () => {
      const buttons = Array.from(
        document.querySelectorAll("svg.tabler-icon-check"),
      )
        .map((s) => s.closest("button"))
        .filter((b) => b && visible(b) && !b.disabled && !b.closest(OWN));
      return (
        buttons.find((b) => /bg-success/.test(b.className)) ||
        buttons[0] ||
        null
      );
    };
    const check = await waitFor(findCheck, 25000);
    if (!check) throw new Error("tombol Approve (✔) tidak aktif");
    await sleep(W(600));
    triggerClick(check);
    const ok = await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter(
        (b) =>
          visible(b) &&
          !b.disabled &&
          b.innerText.trim().toUpperCase() === "KONFIRMASI" &&
          !b.closest(OWN),
      );
      return (
        buttons.find((b) => /bg-success/.test(b.className)) ||
        buttons[0] ||
        null
      );
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
    ["fill", "Pasang remark"],
    ["submit", "Kirim"],
    ["approve", "Approve"],
  ];
  const STEP_LABEL = Object.fromEntries(STEPS);
  const STAGE_TIMEOUT_MS = 6 * 60 * 1000; // dokumen dengan banyak anggota bisa butuh puluhan popup catatan
  const HEARTBEAT_MS = 5 * 60 * 1000;
  let busy = false;

  // FASIH lelet / halaman setengah termuat -> dokumen tidak langsung Gagal: halaman dimuat ulang lalu
  // tahap yang sama diulang (paling banyak MAX_RETRY kali per dokumen, jeda makin lama) dan kesabaran
  // naik satu tingkat. Tidak diulang: galat isian, link salah, Forbidden, dan tahap Kirim yang tombol
  // Kirim-nya sudah sempat diklik (bisa terkirim dobel -> tetap cek manual).
  const MAX_RETRY = 3;
  async function retryStage(cur, why) {
    if (cur.stage === "submit" && cur.submitClicked) return false;
    const n = (cur.retries || 0) + 1;
    if (n > MAX_RETRY) return false;
    const wait = 5000 * n;
    const r = loadRun();
    r.cur = Object.assign(r.cur || {}, { retries: n });
    r.phaseAt = r.navAt = Date.now() + wait;
    saveRun(r);
    const c = loadConf();
    const up = (Number(c.patience) || 0) < PATIENCE.length - 1;
    if (up) {
      c.patience = (Number(c.patience) || 0) + 1;
      saveConf(c);
    }
    log(
      `⟳ ${why} — FASIH lelet? muat ulang & ulangi "${STEP_LABEL[cur.stage] || cur.stage}" (${n}/${MAX_RETRY})${up ? `, kesabaran → ${PATIENCE[c.patience].name}` : ""}`,
    );
    await sleep(wait);
    if (loadRun().running) location.reload();
    return true;
  }

  let loginAt = 0;
  let loginLast = false;
  function loginPage() {
    if (Date.now() - loginAt < 1000) return loginLast;
    loginAt = Date.now();
    // Semua halaman aplikasi (sudah login) ada di bawah /app/... -> di situ jangan pernah dianggap login
    if (
      !document.body ||
      /^\/app\//.test(location.pathname) ||
      document.querySelector(".fasih-form-sidebar") ||
      isListPage()
    )
      return (loginLast = false);
    const pwVisible = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ).some(visible);
    const text = Array.from(document.body.children)
      .filter(
        (el) =>
          !/^(rs|kk)-/.test(el.id || "") &&
          !/^(SCRIPT|STYLE)$/.test(el.tagName),
      )
      .map((el) => el.innerText || "")
      .join(" ");
    const textHints =
      /\b(masuk|login|sign in)\b/i.test(text) &&
      /\b(sso|nip|kata sandi|password|single sign)\b/i.test(text);
    return (loginLast = pwVisible || textHints);
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
  const LOGIN_CONFIRM_MS = 10000;
  let loginSince = 0;
  const appAlive = () =>
    !!document.body &&
    /^\/app\//.test(location.pathname) &&
    (!!document.querySelector(".fasih-form-sidebar") ||
      isListPage() ||
      document.body.innerText.trim().length > 200);
  function haltForLogout() {
    const r = loadRun();
    if (!r.running || r.hold) return;
    if (!loginSince) loginSince = Date.now();
    if (Date.now() - loginSince < LOGIN_CONFIRM_MS) return;
    r.hold = { at: Date.now(), reason: "logout" };
    saveRun(r);
    log(
      "⏸ Dijeda otomatis — sesi FASIH berakhir (logout). Login ulang, lalu klik ▶ Lanjut. Progres tidak hilang.",
    );
    beepAlert();
  }

  function log(msg) {
    console.log(`[${APP.name}] ${msg}`);
    const r = loadRun();
    r.lastLog = msg;
    r.logs = [
      ...(r.logs || []),
      `${new Date().toLocaleTimeString("id-ID")} ${msg}`,
    ].slice(-6);
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

  const docUrl = (item) =>
    `${location.origin}/app/assignment/${item.pre || SURVEY_PREFIX}/${item.id}`;
  const onReviewOf = (id) =>
    new RegExp(`/app/assignment/[^/]+/${id}/?$`, "i").test(location.pathname);
  const onEditOf = (id) =>
    new RegExp(`/app/assignment/[^/]+/${id}/edit`, "i").test(location.pathname);

  function ensureReview(item) {
    if (onReviewOf(item.id)) return true;
    const r = loadRun();
    if (Date.now() - (r.navAt || 0) < 4000) return false;
    const tries = (r.cur && r.cur.navTries) || 0;
    if (tries >= 4)
      throw Object.assign(
        new Error(
          "link tidak benar / dokumen tidak bisa dibuka (cek link di Excel / akses akun)",
        ),
        { soft: true, noRetry: true },
      );
    r.cur.navTries = tries + 1;
    r.navAt = Date.now();
    saveRun(r);
    log(`Membuka dokumen${tries ? ` (percobaan ${tries + 1})` : ""}`);
    location.href =
      tries % 2 === 0
        ? docUrl(item)
        : `${location.origin}/app/assignment-detail/${item.id}`;
    return false;
  }
  function followDetailLink(item) {
    if (
      !new RegExp(`/app/assignment-detail/${item.id}`, "i").test(
        location.pathname,
      )
    )
      return false;
    const a = Array.from(
      document.querySelectorAll('a[href*="/app/assignment/"]'),
    ).find((x) => x.getAttribute("href").toLowerCase().includes(item.id));
    if (!a) return false;
    const r = loadRun();
    r.navAt = Date.now();
    saveRun(r);
    location.href = a.href;
    return true;
  }

  const accSummary = (acc) =>
    [...acc.notes, ...acc.todo, ...acc.problems].join("; ") || "-";

  function finishItem(id, status, reason) {
    updateItem(id, {
      status,
      reason: String(reason || "").slice(0, 600),
      doneAt: new Date().toISOString(),
    });
    const r = loadRun();
    r.cur = null;
    r.paused = null;
    r.processed = (r.processed || 0) + 1;
    const gap = T().gap;
    r.nextAt = Date.now() + gap[0] + Math.random() * (gap[1] - gap[0]);
    saveRun(r);
    log(
      `${FINISHED.includes(status) ? "✅" : status === "tested" ? "🧪" : "⚠️"} ${reason}`,
    );
    refreshPanel();
  }
  function nextItem(run) {
    const only = run.onlyIds ? new Set(run.onlyIds) : null;
    return loadQueue().find(
      (q) => q.status === "pending" && (!only || only.has(q.id)),
    );
  }
  const itemTitle = (q) => {
    const names = q.m.map((m) => m.nama).filter(Boolean);
    return names.length
      ? `${q.kk || "?"} · ${names.join(", ")}`
      : q.kk || q.id.slice(0, 8);
  };

  async function tick() {
    const run = loadRun();
    if (run.running && run.hold && run.hold.reason === "logout" && appAlive()) {
      loginSince = 0;
      log("🔓 Sesi FASIH aktif lagi — lanjut otomatis");
      return setHold(false);
    }
    if (!run.running || busy || rateLimited() || run.paused || run.hold) return;
    if (loginPage()) return haltForLogout();
    loginSince = 0;
    busy = true;
    stopRequested = false;
    try {
      if (!run.cur) {
        if (Date.now() < (run.nextAt || 0)) return;
        const listUrl = loadJson(LIST_KEY, "") || HOME_URL;
        if (Date.now() - (run.hbAt || 0) > HEARTBEAT_MS && !isListPage()) {
          run.hbAt = Date.now();
          saveRun(run);
          log("↻ Singgah ke halaman daftar assignment (jaga sesi tetap aktif)");
          location.href = listUrl;
          return;
        }
        const item = nextItem(run);
        if (!item || (run.limit && run.processed >= run.limit))
          return stopRun("Selesai ✓");
        if (!itemHasWork(item))
          return finishItem(
            item.id,
            "already",
            "semua kategori dokumen ini remark-nya dikosongkan di pengaturan, dilewati",
          );
        setStage("open", { id: item.id, submitClicked: false });
        log(`▶ ${itemTitle(item)} [${item.cats.join(", ")}]`);
        return;
      }
      const cur = run.cur;
      const item = loadQueue().find((q) => q.id === cur.id);
      if (!item)
        return finishItem(cur.id, "red", "dokumen hilang dari antrean");
      if (Date.now() - (run.phaseAt || 0) > STAGE_TIMEOUT_MS * P().x) {
        if (await retryStage(cur, "tahap terlalu lama")) return;
        return finishItem(
          item.id,
          "red",
          `macet di tahap "${STEP_LABEL[cur.stage] || cur.stage}"`,
        );
      }
      try {
        if (forbiddenPage()) throw forbiddenError();
        await runStage(run, cur, item);
      } catch (e) {
        console.error(`[${APP.name}]`, e);
        if (e.forbidden) {
          const edited =
            cur.revoked || ["fill", "submit"].includes(cur.stage)
              ? " (dokumen sempat dibuka edit, cek manual)"
              : "";
          return finishItem(
            item.id,
            "forbidden",
            `halaman Forbidden (tidak ada akses), dilewati${edited}`,
          );
        }
        pressKey("Escape");
        if (!e.noRetry && (await retryStage(cur, e.message))) return;
        const where = STEP_LABEL[cur.stage] || cur.stage;
        const after =
          cur.revoked || ["fill", "submit"].includes(cur.stage)
            ? " — dokumen sudah di-revoke / dibuka edit, cek manual"
            : "";
        finishItem(
          item.id,
          e.soft ? "yellow" : "red",
          `[${where}] ${e.message}${after}`,
        );
      }
    } finally {
      busy = false;
    }
  }

  async function runStage(run, cur, item) {
    const conf = loadConf();
    switch (cur.stage) {
      case "open": {
        if (onEditOf(item.id)) return setStage("fill", { revoked: true });
        if (followDetailLink(item)) return;
        if (!ensureReview(item)) return;
        return setStage(conf.checkFirst || reviewOnly(item) ? "check" : "edit");
      }
      case "check": {
        if (!ensureReview(item)) return;
        const direct = reviewOnly(item);
        // Dokumen sudah di-approve: di Review cuma ada Revoke & Info (tanpa Edit/Approve/Catatan).
        await waitFor(
          () => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"),
          20000,
        );
        await sleep(W(600));
        const editBtn = buttonByIcon("edit");
        if (!editBtn || editBtn.disabled) {
          if (!direct) {
            log(
              "Dokumen sudah di-approve (tombol Edit tidak aktif) → revoke lewat Edit",
            );
            return setStage("edit");
          }
          // Remark #0: revoke saja, tetap di halaman Review (tanpa masuk Edit), lalu tulis catatan & Approve
          await revokeDoc();
          log("Revoke selesai → tulis remark #0 di Review (tanpa Edit)");
          return setStage("check", { revoked: true });
        }
        try {
          // Remark cuma #0: catatan langsung ditulis di Review (tanpa masuk Edit), lalu Approve
          const acc = await scanDoc(item, direct);
          if (direct) {
            updateItem(item.id, { result: accSummary(acc) });
            const notFound = acc.problems.some((p) => /tidak ketemu/.test(p)); // anggota tidak ada di form = cek manual; isian/tombol Catatan tidak ada di Review = lewat Edit
            // Kalau dokumen tadi di-revoke, harus tetap di-approve walau semua remark ternyata sudah ada
            if (!acc.problems.length && (acc.added || cur.revoked))
              return setStage("approve", { viaReview: true });
            if (!acc.problems.length)
              return finishItem(
                item.id,
                "already",
                `tidak diubah, remark sudah ada · ${accSummary(acc)}`,
              );
            if (notFound)
              throw Object.assign(
                new Error(
                  `${accSummary(acc)}${cur.revoked ? " — dokumen sudah di-revoke," : " — tidak di-revoke,"} cek manual`,
                ),
                { soft: true },
              );
            // Catatan tidak bisa disimpan di Review (mis. terkunci) -> jalur biasa: Edit, Kirim, Approve
            log(
              `⚠ remark #0 tidak bisa ditulis di Review (${accSummary(acc)}) → lewat Edit`,
            );
            closeDialogs();
            return setStage("edit");
          }
          if (!acc.todo.length && !acc.problems.length)
            return finishItem(
              item.id,
              "already",
              `tidak diubah, remark sudah ada · ${accSummary(acc)}`,
            );
          if (
            acc.problems.some((p) => /tidak ketemu/.test(p)) &&
            !acc.todo.length
          )
            throw Object.assign(
              new Error(`${accSummary(acc)} — tidak di-revoke, cek manual`),
              { soft: true },
            );
          log(`Cek Review: ${acc.todo.length} rincian belum ada remark → Edit`);
        } catch (e) {
          if (e.forbidden || e.soft || !cur.retries) throw e;
          log(`⚠ cek Review gagal (${e.message}), lanjut ke Edit`);
        }
        closeDialogs();
        return setStage("edit");
      }
      case "edit": {
        if (onEditOf(item.id)) return setStage("fill");
        if (!ensureReview(item)) return;
        const revoked = await reviewToEdit();
        return setStage("fill", { revoked });
      }
      case "fill": {
        if (!onEditOf(item.id)) return setStage("edit");
        const acc = await scanDoc(item, true);
        updateItem(item.id, { result: accSummary(acc) });
        if (acc.problems.length)
          throw Object.assign(new Error(accSummary(acc)), { soft: true });
        return setStage("submit", { submitClicked: false, added: acc.added });
      }
      case "submit": {
        if (!onEditOf(item.id)) {
          if (cur.submitClicked && onReviewOf(item.id))
            return setStage("approve");
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
            log(
              'MODE UJI: remark sudah dipasang. Periksa, lalu "Kirim sekarang" atau "Lewati"',
            );
          }
          return;
        }
        await submitCurrent();
        return setStage("approve");
      }
      case "approve": {
        if (!ensureReview(item)) return;
        if (cur.viaReview && run.testMode && cur.confirmed !== "approve") {
          if (!run.paused) {
            run.paused = { stage: "approve" };
            saveRun(run);
            log(
              'MODE UJI: remark #0 sudah dipasang di Review. Periksa, lalu "Approve sekarang" atau "Lewati"',
            );
          }
          return;
        }
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
        if (cur.viaReview) {
          const how = cur.revoked
            ? "revoke, remark di Review tanpa Edit"
            : "di Review tanpa revoke";
          return note
            ? finishItem(
                item.id,
                "yellow",
                `${q.result || "remark dipasang"} · ${how}${note}`,
              )
            : finishItem(
                item.id,
                "done",
                `${q.result || "remark dipasang"} · ${how}${conf.approve ? " & approve" : ""}`,
              );
        }
        return finishItem(
          item.id,
          "done",
          `${q.result || "remark dipasang"} · terkirim${conf.approve && !note ? " & approve" : ""}${note}`,
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
    if (onlyIds && !onlyIds.length)
      return toast("Tidak ada dokumen berstatus Belum untuk dijalankan.");
    if (!onlyIds && !loadQueue().some((q) => q.status === "pending"))
      return toast("Semua dokumen sudah diproses.");
    saveRun({
      running: true,
      testMode: !!opts.testMode,
      onlyIds,
      total: onlyIds
        ? onlyIds.length
        : loadQueue().filter((q) => q.status === "pending").length,
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
  function stopRun(msg, goHome = true) {
    const r = loadRun();
    r.running = false;
    r.paused = null;
    r.hold = null;
    saveRun(r);
    stopRequested = true;
    log(msg || "Dihentikan.");
    updateHud();
    if (/Selesai/.test(msg || ""))
      toast(`Selesai — ${r.processed || 0} dokumen diproses.`);
    // Jangan dibiarkan lama di halaman dokumen setelah berhenti (FASIH bisa menganggap sesi "tidak login")
    if (goHome && !isListPage()) location.href = HOME_URL;
  }

  // =========================================================================
  // TAMPILAN (gaya sama dengan skrip Koreksi KBLI)
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById("rs-style")) return;
    const style = document.createElement("style");
    style.id = "rs-style";
    style.textContent = `
      .kk, .kk * { box-sizing:border-box; font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .kk { --bg:#ffffff; --bg2:#f6f7fb; --line:#e7e8ef; --tx:#0f1222; --mut:#6b7186; --acc:#0f766e; --acc2:#0369a1; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; color:var(--tx); }
      .kk button { font:inherit; }
      .kk-overlay { position:fixed; inset:0; z-index:1000001; background:rgba(15,18,34,.38); backdrop-filter:blur(3px); display:flex; justify-content:flex-end; animation:kkfade .18s ease; }
      @keyframes kkfade { from{opacity:0} to{opacity:1} }
      @keyframes kkslide { from{transform:translateX(24px);opacity:.4} to{transform:none;opacity:1} }
      @keyframes kkspin { to{transform:rotate(360deg)} }
      @keyframes kkpulse { 0%,100%{opacity:1} 50%{opacity:.45} }
      .kk-sheet { background:var(--bg2); width:min(820px,100vw); height:100vh; display:flex; flex-direction:column; box-shadow:-20px 0 60px rgba(15,18,34,.25); animation:kkslide .22s ease; }
      .kk-head.rs { position:relative; padding:20px 24px 18px; color:#fff; background:linear-gradient(120deg,#0f766e,#0369a1 55%,#4f46e5); overflow:hidden; }
      .kk-head.rs:after { content:""; position:absolute; right:-60px; top:-80px; width:240px; height:240px; border-radius:50%; background:rgba(255,255,255,.09); }
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
      .kk-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--bg); color:var(--tx); border-radius:10px; padding:8px 13px; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; text-decoration:none; }
      .kk-btn:hover { border-color:#c7c9d9; background:#fafaff; transform:translateY(-1px); }
      .kk-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }
      .kk-btn.primary { background:linear-gradient(120deg,var(--acc),var(--acc2)); border-color:transparent; color:#fff; box-shadow:0 6px 16px rgba(3,105,161,.3); }
      .kk-btn.soft { background:#e6f6f4; border-color:#cdeee9; color:var(--acc); }
      .kk-btn.ghost { border-color:transparent; background:transparent; color:var(--mut); }
      .kk-btn.ghost:hover { background:#f0f1f6; color:var(--tx); }
      .kk-btn.danger { color:var(--bad); }
      .kk-btn.sm { padding:5px 9px; font-size:12px; border-radius:8px; }
      .kk-drop { border:1.5px dashed #c9cbe0; border-radius:14px; padding:16px; display:flex; align-items:center; gap:14px; cursor:pointer; transition:all .15s; background:#fbfbfe; }
      .kk-drop:hover, .kk-drop.over { border-color:var(--acc); background:#f2fbfa; }
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
      .kk-input { display:block; width:100%; margin-top:5px; border:1px solid var(--line); border-radius:10px; padding:7px 11px; font-size:13px; outline:none; background:var(--bg); color:var(--tx); }
      .kk-input:focus { border-color:var(--acc); }
      .rs-cats { display:grid; grid-template-columns:auto 1fr 90px; gap:6px 10px; align-items:center; font-size:12.5px; }
      .rs-cats .code { font-weight:750; color:var(--acc); }
      .rs-cats .k4 { font-size:10.5px; font-weight:700; padding:1px 6px; border-radius:6px; background:#eef2ff; color:#4338ca; margin-left:4px; }
      .rs-cats .k1 { font-size:10.5px; font-weight:700; padding:1px 6px; border-radius:6px; background:#fef3c7; color:#92400e; margin-left:4px; }
      .rs-cats input[type=text] { margin:0; padding:5px 8px; }
      .rs-cats input[type=checkbox] { width:16px; height:16px; accent-color:var(--acc); }
      .kk-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(82px,1fr)); gap:8px; }
      .kk-stat { border:1px solid var(--line); border-radius:12px; padding:10px 11px; cursor:pointer; background:var(--bg); text-align:left; transition:all .15s; }
      .kk-stat:hover { transform:translateY(-1px); }
      .kk-stat.on { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 16%,transparent); }
      .kk-stat .n { font-size:21px; font-weight:780; color:var(--c); letter-spacing:-.5px; }
      .kk-stat .l { font-size:11.5px; color:var(--mut); margin-top:1px; white-space:nowrap; }
      .kk-search { flex:1; min-width:200px; border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:13px; background:var(--bg); outline:none; }
      .kk-search:focus { border-color:var(--acc); }
      .kk-list { display:flex; flex-direction:column; gap:8px; }
      .kk-item { display:grid; grid-template-columns:22px 1fr auto; gap:12px; align-items:start; background:var(--bg); border:1px solid var(--line); border-left:3px solid var(--c); border-radius:12px; padding:12px 14px; font-size:12.5px; }
      .kk-item input[type=checkbox] { width:16px; height:16px; margin-top:2px; accent-color:var(--acc); }
      .kk-item .nm { font-size:13.5px; font-weight:650; }
      .kk-item .meta { color:var(--mut); margin-top:3px; }
      .kk-pill { display:inline-block; font-size:11px; font-weight:650; padding:2px 8px; border-radius:99px; color:var(--c); background:color-mix(in srgb,var(--c) 11%,#fff); margin-left:6px; vertical-align:1px; }
      .kk-diff { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .kk-chg { display:inline-flex; align-items:center; gap:6px; background:var(--bg2); border:1px solid var(--line); border-radius:8px; padding:3px 8px; }
      .kk-chg .k { font-weight:700; color:var(--acc); font-size:11px; }
      .kk-chg .a { color:var(--tx); font-weight:650; }
      .kk-chg .u { color:var(--mut); font-size:11px; }
      .kk-item .why { margin-top:7px; color:var(--c); line-height:1.45; }
      .kk-item .acts { display:flex; gap:4px; }
      .kk-empty { text-align:center; padding:36px 10px; color:var(--mut); font-size:13px; }
      .kk-more { text-align:center; font-size:12px; color:var(--mut); padding:6px; }
      .rs-launch { position:fixed; left:16px; bottom:112px; z-index:999999; display:flex; align-items:center; gap:8px; border:none; border-radius:999px; padding:10px 16px 10px 12px; background:linear-gradient(120deg,#0f766e,#0369a1); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 28px rgba(3,105,161,.4); transition:transform .15s; }
      .rs-launch:hover { transform:translateY(-2px); }
      .rs-launch .b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 6px; font-size:11.5px; font-weight:800; }
      .kk-hud { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:1000002; width:min(640px,94vw); background:rgba(17,19,36,.92); backdrop-filter:blur(12px); color:#eef0ff; border-radius:18px; padding:14px 16px; box-shadow:0 20px 50px rgba(10,10,30,.45), inset 0 0 0 1px rgba(255,255,255,.07); font-size:13px; }
      .kk-hud .top { display:flex; align-items:center; gap:10px; cursor:move; user-select:none; touch-action:none; }
      .kk-hud .top .grip { color:#7d83a8; font-size:14px; line-height:1; }
      .kk-hud .spin { width:16px; height:16px; border-radius:50%; border:2.5px solid rgba(255,255,255,.2); border-top-color:#5eead4; animation:kkspin .8s linear infinite; flex:none; }
      .kk-hud .spin.wait { animation:none; border-color:#fbbf24; }
      .kk-hud .ttl { font-weight:700; }
      .kk-hud .dim { color:#9aa0c3; font-size:12px; }
      .kk-hud .doc { margin-top:9px; font-weight:650; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .kk-hud .steps { display:flex; gap:4px; margin-top:9px; }
      .kk-hud .st { flex:1; text-align:center; font-size:10.5px; padding:4px 2px; border-radius:7px; background:rgba(255,255,255,.06); color:#7d83a8; white-space:nowrap; }
      .kk-hud .st.done { color:#86efac; background:rgba(34,197,94,.1); }
      .kk-hud .st.now { color:#fff; background:linear-gradient(120deg,#0f766e,#0369a1); font-weight:650; }
      .kk-hud .log { margin-top:9px; color:#c7cbf0; font-size:12px; font-family:ui-monospace,Consolas,monospace; background:rgba(0,0,0,.25); border-radius:8px; padding:6px 9px; max-height:74px; overflow:hidden; line-height:1.5; }
      .kk-hud .log div:last-child { color:#fde68a; }
      .kk-hud .bar { height:4px; border-radius:99px; background:rgba(255,255,255,.1); margin-top:10px; overflow:hidden; }
      .kk-hud .bar i { display:block; height:100%; background:linear-gradient(90deg,#5eead4,#38bdf8); transition:width .4s; }
      .kk-hud .kk-btn { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.12); color:#eef0ff; padding:6px 11px; font-size:12.5px; }
      .kk-hud .kk-btn:hover { background:rgba(255,255,255,.16); }
      .kk-hud .kk-btn.go { background:#16a34a; border-color:#16a34a; }
      .kk-hud .kk-btn.stop { background:transparent; border-color:rgba(248,113,113,.45); color:#fca5a5; }
      .kk-hud .wait { color:#fbbf24; animation:kkpulse 1.6s infinite; }
      .kk-hud .line { font-size:12px; margin-top:4px; }
      .kk-hud .line .n { color:#fff; font-weight:650; }
      .kk-hud.drag { opacity:.85; box-shadow:0 24px 60px rgba(10,10,30,.6); }
      .kk-hud.min { width:auto; max-width:94vw; padding:9px 12px; }
      .kk-hud.min > :not(.top) { display:none; }
      .rs-help { left:auto; right:16px; transform:none; width:min(400px,94vw); z-index:1000001; }
      .rs-help .kk-pill { background:color-mix(in srgb,var(--c) 30%,transparent); color:#fff; }
      .rs-help .kk-row { margin-top:6px; }
      .rs-help .kk-btn:disabled { opacity:.4; }
      .kk-toast { position:fixed; left:50%; top:20px; transform:translateX(-50%); z-index:1000003; background:#111324; color:#fff; padding:10px 16px; border-radius:12px; font:600 13px "Inter",ui-sans-serif,system-ui,sans-serif; box-shadow:0 12px 30px rgba(0,0,0,.3); animation:kkfade .2s; }
    `;
    document.head.appendChild(style);
  }

  function toast(msg, ms) {
    ensureStyles();
    const t = document.createElement("div");
    t.className = "kk kk-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 3200);
    return t;
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
  const ui = {
    filter: "all",
    search: "",
    selected: new Set(),
    limit: 60,
    file: "",
    loading: "",
  };

  function closePanel() {
    document.getElementById("rs-panel")?.remove();
  }

  // Chip per rincian yang akan diberi remark
  function remarkChips(q, cls) {
    const chip = (who, field, cats) => {
      const tags = tagsFor(cats);
      return `<span class="${cls}"><span class="k">${esc(cats.join("/"))}</span>${who ? `<span class="u">${esc(who)}</span>` : ""}<span class="a">${esc(FIELD_LABEL[field] || field)}</span><span class="u">${tags.length ? esc(tags.join(" ")) : "mati"}</span></span>`;
    };
    return [
      ...q.iv.map(([f, cats]) => chip("", f, cats)),
      ...q.m.flatMap((m) =>
        m.f.map(([f, cats]) =>
          chip(
            `${m.no ? m.no + ". " : ""}${m.nama || "NIK " + (m.nik || "-")}`,
            f,
            cats,
          ),
        ),
      ),
    ].join("");
  }

  function itemHtml(q) {
    const st = STATUS[q.status] || STATUS.pending;
    const meta = [
      q.kec,
      q.desa,
      q.sls,
      q.m.length ? `${q.m.length} anggota` : "",
      q.cats.join(", "),
    ]
      .filter(Boolean)
      .map(esc)
      .join(" · ");
    return `<div class="kk-item" style="--c:${st.color}">
      <input type="checkbox" data-sel="${q.id}" ${ui.selected.has(q.id) ? "checked" : ""}>
      <div style="min-width:0">
        <div class="nm">${esc(q.kk || "(tanpa nama KK)")}<span class="kk-pill">${st.label}</span></div>
        <div class="meta">${meta}</div>
        <div class="kk-diff">${remarkChips(q, "kk-chg")}</div>
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
        (!s ||
          normalize(
            [
              q.kec,
              q.desa,
              q.sls,
              q.kk,
              q.cats.join(" "),
              ...q.m.map((m) => `${m.nama} ${m.nik}`),
            ].join(" "),
          ).includes(s)),
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
    root.querySelector("[data-stats]").innerHTML = [
      ["all", "Semua", "#0f766e"],
      ...Object.entries(STATUS).map(([k, v]) => [k, v.label, v.color]),
    ]
      .map(
        ([k, l, col]) =>
          `<button class="kk-stat ${ui.filter === k ? "on" : ""}" style="--c:${col}" data-filter="${k}"><div class="n">${c[k] || 0}</div><div class="l">${l}</div></button>`,
      )
      .join("");
    const items = filteredItems();
    root.querySelector("[data-list]").innerHTML = items.length
      ? items.slice(0, ui.limit).map(itemHtml).join("") +
        (items.length > ui.limit
          ? `<div class="kk-more"><button class="kk-btn sm" data-more>Tampilkan ${Math.min(60, items.length - ui.limit)} lagi (sisa ${items.length - ui.limit})</button></div>`
          : "")
      : `<div class="kk-empty">${c.all ? "Tidak ada dokumen di filter ini." : "📄 Muat file Excel anomali_sosek dulu."}</div>`;
    root.querySelector("[data-selinfo]").textContent = ui.selected.size
      ? `${ui.selected.size} dicentang`
      : "";
    root
      .querySelectorAll("[data-needpend]")
      .forEach((b) => (b.disabled = !c.pending));
    root
      .querySelectorAll("[data-runsel]")
      .forEach((b) => (b.disabled = !ui.selected.size));
    const ld = root.querySelector("[data-loading]");
    if (ld) ld.textContent = ui.loading;
  }

  function refreshPanel() {
    const root = document.getElementById("rs-panel");
    if (!root) return;
    const a = document.activeElement;
    if (a && root.contains(a) && a.matches("input")) return; // jangan ganggu yang sedang mengetik
    const body = root.querySelector(".kk-body");
    const top = body ? body.scrollTop : 0;
    renderDynamic(root);
    if (body) body.scrollTop = top;
  }

  function catRows(conf) {
    const queue = loadQueue();
    const perCat = {};
    queue.forEach((q) =>
      q.cats.forEach((c) => (perCat[c] = (perCat[c] || 0) + 1)),
    );
    return Object.keys(CATS)
      .map((code) => {
        const m = catMeta(code);
        const rm = (conf.remarks || {})[code];
        return `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-cat-on="${code}" ${conf.catOn[code] === false ? "" : "checked"} title="Ikut dibaca saat muat Excel"><span class="code">${code}</span><span class="${m.blok === 1 ? "k1" : "k4"}">Blok ${m.blok === 1 ? "I" : "IV"}</span></label>
          <div><div>${esc(m.label)}</div><div class="kk-hint">${esc(m.rincian || "")} → ${m.fields.map((f) => FIELD_LABEL[f] || f).join(" + ")}${perCat[code] ? ` · ${perCat[code]} dokumen di antrean` : ""}</div></div>
          <input type="text" class="kk-input" data-remark="${code}" value="${esc(rm === undefined ? DEFAULT_REMARK : rm)}" placeholder="kosong = mati">`;
      })
      .join("");
  }

  function openPanel() {
    ensureStyles();
    closePanel();
    const conf = loadConf();
    const overlay = document.createElement("div");
    overlay.id = "rs-panel";
    overlay.className = "kk kk-overlay";
    overlay.innerHTML = `
      <div class="kk-sheet">
        <div class="kk-head rs">
          <div class="row1">
            <div class="kk-logo">${esc(APP.badge)}</div>
            <div>
              <div class="kk-title">${esc(APP.title)}</div>
              <div class="kk-sub"><code>Blok IV R17 · Blok I R7/R13</code> &nbsp;· buka → pasang remark di catatan rincian → kirim → approve</div>
            </div>
            <button class="kk-x" data-act="close" title="Tutup (Esc)">×</button>
          </div>
          <div class="kk-prog" data-prog></div>
        </div>
        <div class="kk-body">
          <div class="kk-grid2">
            <div class="kk-card">
              <div class="kk-sec">① Data Excel</div>
              <div style="font-size:13px;margin-bottom:10px">Kabupaten
                <input class="kk-input" data-text-conf="kab" value="${esc(conf.kab)}" placeholder="kosong = semua kabupaten">
                <small class="kk-hint">Baris kabupaten lain dilewati saat muat. File se-provinsi ±50 MB, muatnya bisa ±1 menit.</small>
              </div>
              <label class="kk-drop" data-drop>
                <div class="ic">📊</div>
                <div style="min-width:0">
                  <b>${esc(ui.file || (loadQueue().length ? `Antrean tersimpan (${loadQueue().length} dokumen)` : "Pilih / seret anomali_sosek.xlsx"))}</b>
                  <div class="kk-hint">Sheet <i>sosek</i> = kategori & remark; sheet R149/R143/R154/R161/R63/R31–R34 = data (kolom <i>link_fasih_sm</i>, Blok I juga <i>nik_dtsen, no_urut_kk, nama_dtsen</i>). Muat ulang file yang sama tidak menghapus progres, kecuali status di Excel (status_web / status_remark) lebih baru.</div>
                  <div class="kk-hint" data-loading style="color:var(--acc);font-weight:650"></div>
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
              <div style="font-size:11.5px;color:var(--mut);margin:8px 0 4px">Kesabaran menunggu FASIH <small>(lelet → pilih lebih besar; naik sendiri kalau ada yang diulang)</small></div>
              <div class="kk-seg" data-patience>${PATIENCE.map((p, i) => `<button data-patience="${i}" class="${(Number(conf.patience) || 0) === i ? "on" : ""}">${p.name}</button>`).join("")}</div>
              <div style="margin-top:8px">
                <label class="kk-tog"><input type="checkbox" data-conf="checkFirst" ${conf.checkFirst ? "checked" : ""}><span class="sw"></span><span>Cek dulu di Review<small>Kalau semua remark sudah ada di catatan, dokumen tidak di-revoke</small></span></label>
                <label class="kk-tog"><input type="checkbox" data-conf="reviewZero" ${conf.reviewZero ? "checked" : ""}><span class="sw"></span><span>Remark #0 langsung di Review<small>#0 = data benar, tidak diubah: catatan ditulis di Review lalu Approve, tanpa revoke & kirim. Remark lain (mis. #1) tetap lewat Edit</small></span></label>
                <label class="kk-tog"><input type="checkbox" data-conf="approve" ${conf.approve ? "checked" : ""}><span class="sw"></span><span>Approve setelah kirim</span></label>
                <label class="kk-tog"><input type="checkbox" data-conf="forceOnGalat" ${conf.forceOnGalat ? "checked" : ""}><span class="sw"></span><span>Submit Paksa kalau ada galat<small>Mati: dokumen bergalat ditandai "Perlu cek"</small></span></label>
              </div>
            </div>
          </div>

          <div class="kk-card">
            <div class="kk-sec">Kategori & teks remark</div>
            <div class="rs-cats">${catRows(conf)}</div>
            <div class="kk-hint" style="margin-top:8px">Centang = sheet ikut dibaca saat muat Excel. Teks remark bisa diubah kapan saja (berlaku untuk dokumen yang belum diproses); kosong = rincian itu tidak diberi remark. Remark yang sudah ada di thread catatan tidak dikirim lagi.</div>
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
            <div class="kk-hint" style="margin-top:10px">Bisa dimulai dari halaman FASIH mana saja — tiap dokumen dibuka lewat link di Excel. Blok I: kartu anggota dicari lewat NIK (cadangan: no urut + nama). Mode uji berhenti tepat sebelum Kirim. Pintasan panel: <b>Alt+${APP.hotkey}</b>.</div>
          </div>

          <div class="kk-stats" data-stats></div>

          <div class="kk-row">
            <input class="kk-search" placeholder="Cari nama KK/anggota, NIK, desa, kecamatan, kategori…" value="${esc(ui.search)}">
            <button class="kk-btn sm" data-act="selall">☑ Centang yang tampil</button>
            <button class="kk-btn sm ghost" data-act="selnone">Kosongkan</button>
            <button class="kk-btn sm" data-act="setstatus" data-runsel title="Tentukan status dokumen yang dicentang (ikut ke Laporan CSV)">🏷 Atur status</button>
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
    fileInput.addEventListener(
      "change",
      () => fileInput.files[0] && loadExcel(fileInput.files[0]),
    );
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
    imp.addEventListener(
      "change",
      () => imp.files[0] && importJson(imp.files[0]),
    );
    overlay.querySelector(".kk-search").addEventListener("input", (e) => {
      ui.search = e.target.value;
      ui.limit = 60;
      renderDynamic(overlay);
    });
    overlay.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-sel]");
      if (sel) {
        sel.checked
          ? ui.selected.add(sel.dataset.sel)
          : ui.selected.delete(sel.dataset.sel);
        renderDynamic(overlay);
      }
      const cf = e.target.closest("[data-conf]");
      if (cf) {
        const c = loadConf();
        c[cf.dataset.conf] = cf.checked;
        saveConf(c);
      }
      const co = e.target.closest("[data-cat-on]");
      if (co) {
        const c = loadConf();
        c.catOn = { ...c.catOn, [co.dataset.catOn]: co.checked };
        saveConf(c);
      }
      const rm = e.target.closest("[data-remark]");
      if (rm) {
        const c = loadConf();
        c.remarks = { ...c.remarks, [rm.dataset.remark]: rm.value.trim() };
        saveConf(c);
        renderDynamic(overlay);
      }
      const tc = e.target.closest("[data-text-conf]");
      if (tc) {
        const c = loadConf();
        c[tc.dataset.textConf] = tc.value.trim();
        saveConf(c);
      }
    });
    overlay.addEventListener("click", (e) => {
      const pt = e.target.closest("button[data-patience]");
      if (pt) {
        const c = loadConf();
        c.patience = Number(pt.dataset.patience);
        saveConf(c);
        overlay
          .querySelectorAll("button[data-patience]")
          .forEach((b) => b.classList.toggle("on", b === pt));
        return;
      }
      const sp = e.target.closest("button[data-speed]");
      if (sp) {
        const c = loadConf();
        c.speed = Number(sp.dataset.speed);
        saveConf(c);
        overlay
          .querySelectorAll("button[data-speed]")
          .forEach((b) => b.classList.toggle("on", b === sp));
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
        if (loadRun().running)
          stopRun("Dihentikan untuk dikerjakan manual.", false);
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
        if (
          confirm(
            `Jalankan ${counts().pending} dokumen sekarang (Kirim${loadConf().approve ? " + Approve" : ""} otomatis)?`,
          )
        )
          startRun({});
      }
      if (act === "runsel") {
        const ids = Array.from(ui.selected);
        const q = loadQueue();
        q.forEach(
          (x) =>
            ids.includes(x.id) &&
            !FINISHED.includes(x.status) &&
            Object.assign(x, { status: "pending", reason: "" }),
        );
        saveQueue(q);
        startRun({
          onlyIds: ids.filter((id) =>
            q.find((x) => x.id === id && x.status === "pending"),
          ),
        });
      }
      if (act === "retry") {
        const q = loadQueue();
        let n = 0;
        q.forEach((x) => {
          if (/yellow|red|tested/.test(x.status)) {
            x.status = "pending";
            x.reason = "";
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
      if (
        act === "clear" &&
        confirm("Hapus seluruh antrean & progres di browser ini?")
      ) {
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
    document.getElementById("rs-status")?.remove();
    ensureStyles();
    const modal = document.createElement("div");
    modal.id = "rs-status";
    modal.className = "kk kk-overlay";
    modal.style.cssText =
      "align-items:center;justify-content:center;z-index:1000003;";
    const options = Object.entries(STATUS)
      .map(
        ([k, v]) =>
          `<button class="kk-btn" data-status="${k}" style="justify-content:flex-start;text-align:left;border-left:4px solid ${v.color}"><span><b>${v.label}</b><br><span class="kk-hint">${STATUS_HINT[k] || ""}</span></span></button>`,
      )
      .join("");
    modal.innerHTML = `<div class="kk-card" style="width:min(440px,92vw);max-height:90vh;overflow:auto">
      <div class="kk-sec">🏷 Atur status · ${ids.length} dokumen</div>
      <textarea class="kk-search" data-note rows="2" placeholder="Catatan (opsional), mis. remark sudah dipasang manual di FASIH" style="width:100%;resize:vertical"></textarea>
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
    const setLoading = (msg) => {
      ui.loading = msg;
      const el = document.querySelector("#rs-panel [data-loading]");
      if (el) el.textContent = msg;
    };
    try {
      setLoading("Membuka file…");
      const { items, meta, stats, unknown } = await parseWorkbook(
        await file.arrayBuffer(),
        setLoading,
      );
      // Remark & label dari sheet sosek jadi bawaan (teks remark yang sudah diubah di panel tetap dipakai)
      const c = loadConf();
      c.catMeta = {};
      Object.entries(meta).forEach(([code, m]) => {
        if (!CATS[code]) return;
        c.catMeta[code] = { label: m.label, rincian: m.rincian };
        if ((c.remarks || {})[code] === undefined && m.remark)
          c.remarks = { ...c.remarks, [code]: m.remark };
      });
      saveConf(c);
      const old = new Map(loadQueue().map((q) => [q.id, q]));
      let kept = 0;
      let fromXlsNewer = 0;
      const merged = items.map((it) => {
        const o = old.get(it.id);
        if (o && o.status !== "pending") {
          // Status beres di Excel (status_web / status_remark, termasuk Gagal & Perlu cek) yang lebih baru dari progres lokal -> pakai Excel
          if (
            it.fromExcel &&
            it.doneAt &&
            (!o.doneAt || new Date(it.doneAt) > new Date(o.doneAt))
          ) {
            fromXlsNewer++;
            return { ...it, result: o.result };
          }
          kept++;
          return {
            ...it,
            status: o.status,
            reason: o.reason,
            result: o.result,
            doneAt: o.doneAt,
          };
        }
        return it;
      });
      saveQueue(merged);
      const fromXls = merged.filter(
        (x) => x.fromExcel && x.status !== "pending",
      ).length;
      ui.file = file.name;
      ui.selected.clear();
      setLoading("");
      openPanel();
      const per = Object.entries(stats)
        .filter(([, s]) => !s.off)
        .map(([k, s]) => `${k} ${s.kept}`)
        .join(", ");
      toast(
        `${merged.length} dokumen${c.kab ? ` (${c.kab})` : ""} · baris: ${per}${kept ? ` · ${kept} progres lama dipertahankan` : ""}${fromXls ? ` · ${fromXls} status dibaca dari kolom status Excel${fromXlsNewer ? ` (${fromXlsNewer} menimpa progres lama)` : ""}` : ""}${unknown.length ? ` · sheet tak dikenal dilewati: ${unknown.join(", ")}` : ""}`,
        7000,
      );
    } catch (e) {
      setLoading("");
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
  const stamp = () =>
    new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  function wilayahTag() {
    const queue = loadQueue();
    const kecs = [...new Set(queue.map((q) => q.kec).filter(Boolean))];
    let tag = loadConf().kab || "semua-wilayah";
    if (kecs.length === 1) tag = kecs[0];
    return tag
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80);
  }

  function exportCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      [
        "kec",
        "desa",
        "sls",
        "nama_kk",
        "kategori",
        "no_urut",
        "nama_anggota",
        "nik",
        "rincian",
        "remark",
        "status",
        "keterangan",
        "waktu",
        "link",
      ].join(","),
    ];
    loadQueue().forEach((q) => {
      const row = (cats, m, field) =>
        lines.push(
          [
            q.kec,
            q.desa,
            q.sls,
            q.kk,
            cats.join("/"),
            m && m.no,
            m && m.nama,
            m && m.nik,
            FIELD_LABEL[field] || field,
            tagsFor(cats).join(" "),
            (STATUS[q.status] || {}).label,
            q.reason,
            q.doneAt,
            docUrl(q),
          ]
            .map(cell)
            .join(","),
        );
      q.iv.forEach(([f, cats]) => row(cats, null, f));
      q.m.forEach((m) => m.f.forEach(([f, cats]) => row(cats, m, f)));
    });
    download(
      `laporan-${APP.file}-${wilayahTag()}-${stamp()}.csv`,
      "\uFEFF" + lines.join("\n"),
      "text/csv",
    );
  }
  function exportJson() {
    download(
      `antrean-${APP.file}-${wilayahTag()}-${stamp()}.json`,
      JSON.stringify({
        v: 1,
        app: APP.file,
        queue: loadQueue(),
        conf: loadConf(),
      }),
      "application/json",
    );
  }
  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      if (
        !Array.isArray(data.queue) ||
        data.queue.some((q) => !Array.isArray(q.iv) || !Array.isArray(q.m))
      )
        throw new Error(`bukan file ekspor skrip ${APP.name}`);
      if (
        loadQueue().length &&
        !confirm(
          `Timpa antrean sekarang (${loadQueue().length} dokumen) dengan isi file (${data.queue.length} dokumen)?`,
        )
      )
        return;
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
  const docIdHere = () => {
    const m = location.pathname.match(
      /\/app\/assignment\/[^/]+\/([0-9a-f-]{36})/i,
    );
    return m ? m[1].toLowerCase() : null;
  };
  // Baris "rincian apa diberi remark apa" — dipakai di panel bantu manual & bar progres
  function remarkLines(q) {
    const line = (who, f, cats) =>
      `<div class="line">${esc(who)}<span class="n">${esc(FIELD_LABEL[f] || f)}</span> ← ${esc(tagsFor(cats).join(" ") || "mati")} <span class="dim">(${esc(cats.join("/"))})</span></div>`;
    return [
      ...q.iv.map(([f, cats]) => line("Blok IV · ", f, cats)),
      ...q.m.flatMap((m) =>
        m.f.map(([f, cats]) =>
          line(
            `Blok I · ${m.no ? m.no + ". " : ""}${m.nama || "?"} (NIK ${m.nik || "-"}) · `,
            f,
            cats,
          ),
        ),
      ),
    ].join("");
  }

  function placeEl(el, key) {
    if (!el) return;
    const pos = loadJson(key, null);
    if (!pos)
      return Object.assign(el.style, {
        left: "",
        top: "",
        right: "",
        bottom: "",
        transform: "",
      });
    const w = Math.min(el.offsetWidth || 400, window.innerWidth);
    const x = Math.min(Math.max(0, pos.x), window.innerWidth - w);
    const y = Math.min(Math.max(0, pos.y), window.innerHeight - 48);
    Object.assign(el.style, {
      left: `${x}px`,
      top: `${y}px`,
      right: "auto",
      bottom: "auto",
      transform: "none",
    });
  }
  function makeDraggable(el, key) {
    el.addEventListener("pointerdown", (e) => {
      if (
        !e.target.closest(".top") ||
        e.target.closest("button") ||
        e.button !== 0
      )
        return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      el.classList.add("drag");
      const move = (ev) => {
        const x = Math.min(
          Math.max(0, ev.clientX - dx),
          window.innerWidth - r.width,
        );
        const y = Math.min(
          Math.max(0, ev.clientY - dy),
          window.innerHeight - 48,
        );
        Object.assign(el.style, {
          left: `${x}px`,
          top: `${y}px`,
          right: "auto",
          bottom: "auto",
          transform: "none",
        });
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
    placeEl(document.getElementById("rs-help"), HELPER_POS_KEY);
    placeEl(document.getElementById("rs-hud"), HUD_POS_KEY);
  });

  let helpSig = "";
  let helpBusy = false;
  function updateHelper() {
    let el = document.getElementById("rs-help");
    const id = docIdHere();
    const q =
      id && !loadRun().running ? loadQueue().find((x) => x.id === id) : null;
    if (!q || loadJson(HELPER_KEY, null) === id) {
      if (el) el.remove();
      helpSig = "";
      return;
    }
    if (!document.body) return;
    ensureStyles();
    if (!el) {
      el = document.createElement("div");
      el.id = "rs-help";
      el.className = "kk kk-hud rs-help";
      el.addEventListener("click", onHelperClick);
      makeDraggable(el, HELPER_POS_KEY);
      document.body.appendChild(el);
      requestAnimationFrame(() => placeEl(el, HELPER_POS_KEY));
    }
    const mini = !!loadJson(HELPER_MIN_KEY, false);
    el.classList.toggle("min", mini);
    const editing = onEditOf(id);
    const sig = JSON.stringify([
      q.status,
      q.reason,
      editing,
      helpBusy,
      mini,
      loadConf().remarks,
    ]);
    if (sig === helpSig) return;
    helpSig = sig;
    const st = STATUS[q.status] || STATUS.pending;
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
      <div class="doc">${esc(q.kk || "")} <span class="dim">· ${esc([q.desa, q.sls].filter(Boolean).join(" · "))}</span></div>
      ${remarkLines(q)}
      <div class="dim" style="margin-top:8px">${editing ? "Mode edit: klik “Pasang remark” untuk memasang semua remark di dokumen ini." : "Klik Edit (revoke kalau perlu) dulu supaya bisa Kirim setelah remark dipasang."}</div>
      <div class="kk-row" style="margin-top:10px">
        <button class="kk-btn go" data-help="fill" ${!helpBusy ? "" : "disabled"}>✏ Pasang remark</button>
        <button class="kk-btn" data-help="done">✓ Tandai selesai manual</button>
        <button class="kk-btn" data-help="status">🏷 Status…</button>
        <button class="kk-btn" data-help="auto" title="Kembalikan ke Belum & jalankan otomatis dokumen ini">↻ Otomatis</button>
      </div>`;
  }
  async function onHelperClick(e) {
    const act = e.target.closest("[data-help]")?.dataset.help;
    const here = docIdHere();
    const q = here && loadQueue().find((x) => x.id === here);
    if (!act || !q) return;
    if (act === "hide") {
      saveJson(HELPER_KEY, here);
      return updateHelper();
    }
    if (act === "min") {
      saveJson(HELPER_MIN_KEY, !loadJson(HELPER_MIN_KEY, false));
      updateHelper();
      return placeEl(document.getElementById("rs-help"), HELPER_POS_KEY);
    }
    if (act === "done") {
      const before = (STATUS[q.status] || {}).label || q.status;
      updateItem(q.id, {
        status: "manual",
        reason:
          `dikerjakan manual (sebelumnya: ${before}${q.reason ? ` — ${q.reason}` : ""})`.slice(
            0,
            600,
          ),
        doneAt: new Date().toISOString(),
      });
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
      helpBusy = true;
      stopRequested = false;
      updateHelper();
      try {
        const acc = await scanDoc(q, true);
        updateItem(q.id, { result: `${accSummary(acc)} (manual)` });
        alert(
          acc.problems.length
            ? `Sebagian belum terpasang:\n${acc.problems.join("\n")}\n\nTerpasang/sudah ada:\n${acc.notes.join("\n") || "-"}`
            : `Remark terpasang:\n${acc.notes.join("\n") || "-"}\n\nSekarang Kirim & Approve di FASIH, lalu klik “Tandai selesai manual”.`,
        );
      } catch (err) {
        alert(`Gagal memasang remark: ${err.message}`);
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
    let hud = document.getElementById("rs-hud");
    if (!run.running) {
      if (hud) hud.remove();
      hudSig = "";
      return;
    }
    if (!document.body) return;
    ensureStyles();
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "rs-hud";
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
          if (r.cur)
            finishItem(
              r.cur.id,
              "tested",
              "MODE UJI: remark dipasang tapi TIDAK dikirim (dokumen masih terbuka edit)",
            );
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
    const sig = JSON.stringify([
      run.cur,
      run.paused,
      run.logs,
      limited,
      done,
      run.testMode,
      run.hold,
      hudMini,
    ]);
    if (sig === hudSig) return;
    hudSig = sig;
    hud.innerHTML = `
      <div class="top" title="Tarik untuk memindah · klik dua kali untuk kembali ke tengah bawah">
        <span class="grip">⠿</span>
        <div class="spin ${run.paused || run.hold || limited ? "wait" : ""}"></div>
        <div class="ttl">${esc(APP.name)}</div>
        <div class="dim">${run.hold ? "⏸ DIJEDA · " : ""}${T().name}${run.testMode ? " · Mode uji" : ""} · ${done}/${total} dokumen</div>
        <span style="flex:1"></span>
        ${run.paused ? `<button class="kk-btn go" data-hud="go">✓ ${run.paused.stage === "approve" ? "Approve" : "Kirim"} sekarang</button><button class="kk-btn" data-hud="pass">Lewati</button>` : ""}
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
      ${it ? `<div class="doc">▶ ${esc(it.kk || "")} <span class="dim">· ${esc([it.desa, it.sls].filter(Boolean).join(" · "))}</span></div>` : ""}
      ${it ? remarkLines(it) : ""}
      ${it ? `<div class="steps">${STEPS.map(([k, l], i) => `<div class="st ${i < iNow ? "done" : i === iNow ? "now" : ""}">${i < iNow ? "✓ " : ""}${l}</div>`).join("")}</div>` : ""}
      <div class="log">${(run.logs || []).map((l) => `<div>${esc(l)}</div>`).join("") || "<div>…</div>"}</div>
      <div class="bar"><i style="width:${total ? Math.min(100, (100 * done) / total) : 0}%"></i></div>`;
  }

  function ensureLauncher() {
    if (!document.body || document.getElementById("rs-launch")) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "rs-launch";
    btn.className = "rs-launch";
    btn.innerHTML = `<span class="b">${esc(APP.badge)}</span> ${esc(APP.launch)}`;
    btn.title = `Buka panel (Alt+${APP.hotkey})`;
    btn.style.bottom = `${APP.launchBottom}px`;
    btn.onclick = openPanel;
    document.body.appendChild(btn);
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === APP.hotkey) {
      e.preventDefault();
      document.getElementById("rs-panel") ? closePanel() : openPanel();
    }
  });

  let lastPanelRefresh = 0;
  setInterval(() => {
    ensureLauncher();
    if (isListPage() && loadJson(LIST_KEY, "") !== location.href)
      saveJson(LIST_KEY, location.href);
    const run = loadRun();
    if (run.running && !busy) tick();
    if (run.running) updateHud();
    updateHelper();
    if (Date.now() - lastPanelRefresh > 1500) {
      lastPanelRefresh = Date.now();
      refreshPanel();
    }
  }, 700);

  console.log(
    `[${APP.name} v${APP.version}] Aktif. Tombol di kiri bawah (Alt+${APP.hotkey}).`,
  );
})();
