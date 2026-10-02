// ==UserScript==
// @name         FASIH OSS -> Keluarga: Pindah + Tautkan
// @namespace    hanif-bps-hst
// @version      2.21
// @description  OSS dipindah ke SLS keluarga (⋮ > Ganti Wilayah), lalu dokumen keluarga dibuka: salin Blok P (alamat, no bangunan, geotag) dan pilih OSS di "Pilih UMKM dalam satu SLS". Ada -> OSS Ditemukan + alamat & geotag keluarga; tidak ada / keluarga tanpa usaha -> OSS Tutup. Keduanya dikirim & di-approve.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Excel dibaca di browser ini saja; datanya tidak dikirim ke mana pun.
  const QUEUE_KEY = "fgw2_queue";
  const CONF_KEY = "fgw_conf";
  const RUN_KEY = "fgw2_run";
  const RATE_KEY = "fasih_rate_limit"; // sama dengan skrip FASIH Otomatis: jeda 429 berlaku untuk keduanya

  const DEFAULT_CONF = {
    pengawas: "fakhriansyah@bps.go.id",
    pencacah: "raudatul.jannah@bps.go.id",
    speed: 0, // indeks SPEEDS (0 = Turbo)
    strictId: false, // true: wajib cocok assignment_id; false: boleh 1 nama persis di SLS asal
    doLink: true, // setelah dipindah: tautkan ke keluarga + kirim
    approve: true, // approve setelah kirim
    surveyPrefix: "fd68e454-ba45-4b85-8205-f3bf777ded24", // /app/assignment/<ini>/<assignment_id>
  };

  // Tingkat kecepatan: jeda antar-assignment, lama tunggu tabel/dropdown/dialog (ms)
  const SPEEDS = [
    { name: "Turbo", scale: 0.35, gap: [0, 150], settle: 300, after: 100, optStep: 80, afterPick: 150, dlg: 300, submit: 250, poll: 60 },
    { name: "Kilat", scale: 0.5, gap: [300, 800], settle: 500, after: 200, optStep: 120, afterPick: 250, dlg: 500, submit: 500, poll: 100 },
    { name: "Cepat", scale: 0.75, gap: [1000, 2500], settle: 800, after: 400, optStep: 200, afterPick: 400, dlg: 800, submit: 800, poll: 150 },
    { name: "Normal", scale: 1, gap: [4000, 9000], settle: 1500, after: 1500, optStep: 300, afterPick: 700, dlg: 1200, submit: 1500, poll: 250 },
  ];
  // Jeda tetap di form dikali skala kecepatan (Turbo 35%)
  const W = (ms) => Math.max(100, Math.round(ms * (T().scale || 1)));
  const T = () => SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, Number(loadConf().speed) || 0))];

  const STATUS_LABEL = {
    pending: "belum dipindah",
    moved: "dipindah, belum ditautkan",
    linked: "selesai: ditautkan",
    closed: "selesai: OSS tutup",
    tested: "terisi (uji)",
    red: "gagal",
    yellow: "perlu cek",
    manual: "selesai (dicek manual)",
  };
  const STATUS_COLOR = {
    pending: "#2563eb",
    moved: "#7c3aed",
    linked: "#15803d",
    closed: "#0f766e",
    tested: "#0891b2",
    red: "#dc2626",
    yellow: "#b45309",
    manual: "#4d7c0f",
    ganda: "#c2410c", // sub-kategori closed: OSS Ganda
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
      console.error("[Ganti Wilayah] Gagal menyimpan.", e);
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
    const count =
      Date.now() - (prev.at || 0) < 2 * 3600000 ? (prev.count || 0) + 1 : 1;
    const minutes = Math.min(60, 15 * Math.pow(2, count - 1));
    saveJson(RATE_KEY, {
      at: Date.now(),
      until: Date.now() + minutes * 60000,
      count,
      url: String(url || "").slice(0, 200),
    });
    // Diturunkan satu tingkat supaya tidak kena 429 lagi
    const cf = loadConf();
    cf.speed = Math.min(SPEEDS.length - 1, (Number(cf.speed) || 0) + 1);
    saveConf(cf);
    console.warn(`[Ganti Wilayah] 429 dari server. Berhenti ${minutes} menit, kecepatan turun ke ${SPEEDS[cf.speed].name}.`);
  }
  (function watch429() {
    const origFetch = window.fetch;
    if (origFetch && !origFetch.__fgw429) {
      const wrapped = function (input) {
        return origFetch.apply(this, arguments).then((res) => {
          if (res && res.status === 429)
            noteRateLimit(typeof input === "string" ? input : input && input.url);
          return res;
        });
      };
      wrapped.__fgw429 = true;
      window.fetch = wrapped;
    }
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && !XHR.__fgw429) {
      const origOpen = XHR.open;
      const origSend = XHR.send;
      XHR.open = function (method, url) {
        this.__fgwUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.send = function () {
        this.addEventListener("loadend", () => {
          if (this.status === 429) noteRateLimit(this.__fgwUrl);
        });
        return origSend.apply(this, arguments);
      };
      XHR.__fgw429 = true;
    }
  })();

  let stopRequested = false;
  async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
    while (rateLimited() && !stopRequested) {
      updateBar();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function waitFor(check, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return null;
      const result = check();
      if (result) return result;
      await sleep(T().poll);
    }
    return null;
  }

  const normalize = (text) =>
    String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

  const visible = (el) =>
    !!el &&
    (el.offsetParent !== null ||
      (el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden"));

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

  function setInputValue(input, value) {
    input.focus();
    const proto =
      input.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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

  // "[0005] RT 005" -> { code: "0005", name: "RT 005" }
  function parseOption(text) {
    const m = String(text || "")
      .trim()
      .match(/^\[?(\d+)\]?\s*(.*)$/);
    return m
      ? { code: m[1], name: m[2].trim() }
      : { code: "", name: String(text || "").trim() };
  }

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

  // Hasil: [{ name, rows: [[teks sel, ...], ...] }] ; semua nilai sebagai teks (kode "0005" tetap utuh)
  async function readXlsx(arrayBuffer) {
    const read = await openZip(arrayBuffer);
    const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
    const tags = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
    const sharedXml = await read("xl/sharedStrings.xml");
    const shared = sharedXml
      ? tags(xml(sharedXml), "si").map((si) =>
          tags(si, "t").map((t) => t.textContent).join(""),
        )
      : [];
    const rels = {};
    tags(xml(await read("xl/_rels/workbook.xml.rels")), "Relationship").forEach(
      (r) => {
        rels[r.getAttribute("Id")] = r.getAttribute("Target");
      },
    );
    const colIndex = (ref) =>
      ref
        .replace(/\d+/g, "")
        .split("")
        .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const sheets = [];
    for (const s of tags(xml(await read("xl/workbook.xml")), "sheet")) {
      const relId =
        s.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "id",
        ) || s.getAttribute("r:id");
      let target = rels[relId].replace(/^\//, "");
      if (!target.startsWith("xl/")) target = "xl/" + target;
      const rows = tags(xml(await read(target)), "row").map((row) => {
        const out = [];
        tags(row, "c").forEach((c) => {
          const type = c.getAttribute("t");
          const v = tags(c, "v")[0];
          let value = "";
          if (type === "inlineStr")
            value = tags(c, "t").map((t) => t.textContent).join("");
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

  const REQUIRED_COLS = [
    "assignment_id",
    "kec_kode",
    "desa_kode",
    "sls_asal",
    "nama_usaha",
    "sls_tujuan",
    "subsls_tujuan",
  ];
  const pad = (v, n) => (String(v || "").trim() ? String(v).trim().padStart(n, "0") : "");

  async function parseWorkbook(arrayBuffer) {
    const sheets = await readXlsx(arrayBuffer);
    const sheet = sheets.find((s) => /^pindah$/i.test(s.name)) || sheets[0];
    const headers = sheet.rows[0].map((h) => String(h).trim().toLowerCase());
    const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
    if (missing.length)
      throw new Error(`kolom tidak ada di sheet "${sheet.name}": ${missing.join(", ")}`);
    const col = (name) => headers.indexOf(name);
    const items = [];
    let skipped = 0;
    sheet.rows.slice(1).forEach((r, i) => {
      const get = (name) => (col(name) >= 0 ? String(r[col(name)] || "").trim() : "");
      if (!get("assignment_id")) return;
      const proses = get("proses").toUpperCase();
      if (proses && !/^(1|YA|Y|TRUE)$/.test(proses)) {
        skipped++;
        return;
      }
      items.push({
        id: get("assignment_id").toLowerCase(),
        row: i + 2,
        yakin: get("yakin"),
        kec: { code: pad(get("kec_kode"), 3), name: get("kec_nama") },
        desa: { code: pad(get("desa_kode"), 3), name: get("desa_nama") },
        slsAsal: pad(get("sls_asal"), 4),
        subslsAsal: pad(get("subsls_asal"), 2),
        slsAsalNama: get("sls_asal_nama"),
        namaUsaha: get("nama_usaha").toUpperCase(),
        slsTujuan: pad(get("sls_tujuan"), 4),
        subslsTujuan: pad(get("subsls_tujuan"), 2),
        slsTujuanNama: get("sls_tujuan_nama"),
        kelAnggota: get("kel_anggota"),
        linkOss: get("link_oss"),
        linkKel: get("link_keluarga"),
        kelId: (get("kel_assignment_id") || (get("link_keluarga").match(/([0-9a-f-]{36})/i) || [])[1] || "").toLowerCase(),
        // status_awal "dipindah" (dari laporan sebelumnya) -> langsung ke tahap tautkan
        status: /^dipindah$/i.test(get("status_awal")) ? "moved" : "pending",
        reason: /^dipindah$/i.test(get("status_awal")) ? `dipindah (laporan sebelumnya)` : "",
      });
    });
    return { items, sheet: sheet.name, skipped };
  }

  // =========================================================================
  // HALAMAN DAFTAR ASSIGNMENT: FILTER + CARI
  // =========================================================================
  const searchInput = () =>
    document.querySelector('input[placeholder^="Cari"]:not([cmdk-input])');
  const tableText = () =>
    (document.querySelector("table tbody") || {}).innerText || "";
  const isListPage = () =>
    !!searchInput() && !!document.querySelector("table thead");

  function isLoading() {
    const busy = Array.from(
      document.querySelectorAll('[class*="animate-spin"], [class*="skeleton"], [aria-busy="true"]'),
    ).some((el) => visible(el) && !el.closest("#fgw-panel, #fgw-bar"));
    return busy || /loading|memuat/i.test(tableText());
  }

  async function waitTableSettled(before) {
    if (before !== undefined)
      await waitFor(() => tableText() !== before || isLoading(), 6000);
    const start = Date.now();
    let last = tableText();
    let stableSince = Date.now();
    while (Date.now() - start < 30000 && !stopRequested) {
      await sleep(250);
      const now = tableText();
      if (now !== last || isLoading()) {
        last = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= T().settle) break;
    }
    await sleep(T().after);
  }

  function filterButton() {
    return Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]')).find(
      (b) => b.querySelector(".tabler-icon-filter") && !b.closest("th"),
    );
  }

  const gantiDialog = () =>
    Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (d) => visible(d) && /ganti wilayah/i.test((d.querySelector("h2") || {}).innerText || ""),
    ) || null;

  // Combobox berlabel (scope: dialog Ganti Wilayah, atau halaman kecuali dialog itu)
  // Label dicocokkan tanpa spasi/tanda baca ("SUBSLS" = "SUB SLS" = "Sub-SLS")
  const squash = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function fieldButton(label, scope) {
    const dlg = gantiDialog();
    const lab = Array.from((scope || document).querySelectorAll("label")).find(
      (l) =>
        squash(l.innerText) === squash(label) &&
        (scope || !dlg || !dlg.contains(l)),
    );
    return lab ? lab.parentElement.querySelector('button[role="combobox"]') : null;
  }

  const OPTION_SELECTOR = '[cmdk-item], [role="option"]';
  const visibleOptions = () =>
    Array.from(document.querySelectorAll(OPTION_SELECTOR)).filter(
      (el) => visible(el) && !el.closest("#fgw-panel, #fgw-bar") && el.innerText.trim(),
    );
  const optionText = (el) => el.getAttribute("data-value") || el.innerText;
  const shownText = (btn) =>
    ((btn && (btn.querySelector("span") || btn).innerText) || "").trim();
  const shownCode = (btn) => parseOption(shownText(btn)).code;

  // Pilih opsi berkode [code] pada combobox. Hasil: true jika sudah bernilai code.
  async function pickByCode(getBtn, code, label) {
    // Isian di bawahnya (DESA/SLS/SUBSLS) baru muncul setelah isian di atasnya selesai dimuat
    let btn = getBtn() || (await waitFor(getBtn, 8000));
    if (!btn) throw new Error(`isian ${label} tidak ada`);
    if (shownCode(btn) === code) return true;
    triggerClick(btn);
    await waitFor(() => visibleOptions().length, 6000);
    let count = -1;
    for (let i = 0; i < 8 && visibleOptions().length !== count; i++) {
      count = visibleOptions().length; // tunggu daftar selesai dimuat
      await sleep(T().optStep);
    }
    const find = () => visibleOptions().find((el) => parseOption(optionText(el)).code === code);
    let target = find();
    const input = document.querySelector("input[cmdk-input]");
    if (!target && input) {
      setInputValue(input, code);
      target = await waitFor(find, 4000);
    }
    if (!target) {
      pressKey("Escape");
      await sleep(300);
      throw new Error(`pilihan ${label} [${code}] tidak ada`);
    }
    triggerClick(target);
    const ok = await waitFor(() => shownCode(getBtn()) === code, 5000);
    await sleep(T().afterPick); // isian di bawahnya dimuat ulang
    return !!ok;
  }

  async function openFilterPanel() {
    if (fieldButton("KECAMATAN")) return;
    const btn = filterButton();
    if (!btn) throw new Error("tombol Filter tidak ditemukan");
    triggerClick(btn);
    if (!(await waitFor(() => fieldButton("KECAMATAN"), 6000)))
      throw new Error("isian KECAMATAN tidak muncul di Filter");
  }

  async function closeFilterPanel() {
    const field = fieldButton("KECAMATAN");
    if (!field) return;
    const scope = field.closest('[role="dialog"]') || document;
    const apply = Array.from(scope.querySelectorAll("button")).find((b) =>
      /^(TERAPKAN|APPLY|SIMPAN|TAMPILKAN|OK)$/i.test(b.innerText.trim()),
    );
    if (apply) triggerClick(apply);
    else pressKey("Escape");
    await sleep(400);
    if (fieldButton("KECAMATAN") && filterButton()) triggerClick(filterButton());
    await sleep(300);
  }

  let appliedFilterKey = null;
  async function applyFilter(item, sls = item.slsAsal) {
    const key = `${item.kec.code}|${item.desa.code}|${sls}`;
    if (appliedFilterKey === key) return;
    const before = tableText();
    await openFilterPanel();
    await pickByCode(() => fieldButton("KECAMATAN"), item.kec.code, "Filter KECAMATAN");
    await pickByCode(() => fieldButton("DESA"), item.desa.code, "Filter DESA");
    if (fieldButton("SLS"))
      await pickByCode(() => fieldButton("SLS"), sls, "Filter SLS");
    await closeFilterPanel();
    await waitTableSettled(before);
    appliedFilterKey = key;
  }

  async function searchList(query) {
    const input = searchInput();
    if (!input) throw new Error('kotak "Cari..." tidak ditemukan');
    if (input.value.trim().toUpperCase() !== query.toUpperCase()) {
      const before = tableText();
      setInputValue(input, query);
      await sleep(T().after);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
      await waitTableSettled(before);
    }
    return Array.from(document.querySelectorAll("table tbody tr")).filter(
      (tr) => tr.querySelectorAll("td").length > 2,
    );
  }

  // Baris yang pasti assignment ini: id ada di HTML baris, atau muncul di link Review setelah kode diklik
  async function rowHasId(tr, id) {
    if (tr.innerHTML.toLowerCase().includes(id)) return true;
    const kodeBtn = tr.querySelector("td button:not([title]):not([aria-haspopup])");
    if (!kodeBtn) return false;
    triggerClick(kodeBtn);
    const link = await waitFor(
      () => document.querySelector(`a[href*="${id}"]`),
      1500,
    );
    return !!link;
  }

  // Hasil: { tr, note } atau error
  async function findRow(item) {
    await applyFilter(item);
    const want = normalize(item.namaUsaha);
    const rows = await searchList(item.namaUsaha);
    const exact = rows.filter((tr) =>
      Array.from(tr.querySelectorAll("td")).some((td) => normalize(td.innerText) === want),
    );
    const loose = rows.filter((tr) => normalize(tr.innerText).includes(want));
    const candidates = exact.length ? exact : loose;
    // Jalur cepat: id langsung terbaca di HTML baris, atau (tidak wajib id) cuma 1 nama persis -> tanpa klik kode
    const direct = candidates.find((tr) => tr.innerHTML.toLowerCase().includes(item.id));
    if (direct) return { tr: direct, note: "cocok assignment_id" };
    if (!loadConf().strictId && exact.length === 1)
      return { tr: exact[0], note: "1 nama persis di SLS asal" };
    for (const tr of candidates.slice(0, 6)) {
      if (await rowHasId(tr, item.id)) return { tr, note: "cocok assignment_id" };
    }
    if (!loadConf().strictId && exact.length === 1)
      return { tr: exact[0], note: "1 nama persis di SLS asal (id tidak terbaca di tabel)" };
    if (!candidates.length)
      throw Object.assign(new Error(`"${item.namaUsaha}" tidak ada di SLS ${item.slsAsal} (mungkin sudah dipindah)`), { soft: true });
    throw Object.assign(new Error(`${candidates.length} baris bernama "${item.namaUsaha}", assignment_id tidak bisa dipastikan`), { soft: true });
  }

  // =========================================================================
  // ⋮ > GANTI WILAYAH
  // =========================================================================
  async function openGantiWilayah(tr) {
    const menuBtn =
      tr.querySelector("td:last-child button[aria-haspopup='menu']") ||
      tr.querySelector("button[aria-haspopup='menu']");
    if (!menuBtn) throw new Error("tombol ⋮ tidak ada di baris");
    triggerClick(menuBtn);
    const item = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find(
          (el) => visible(el) && /ganti\s+wilayah/i.test(el.innerText),
        ),
      5000,
    );
    if (!item) {
      pressKey("Escape");
      throw new Error('menu "Ganti Wilayah" tidak muncul');
    }
    triggerClick(item);
    const dlg = await waitFor(gantiDialog, 8000);
    if (!dlg) throw new Error("dialog Ganti Wilayah tidak terbuka");
    await sleep(T().dlg); // isian wilayah terisi
    return dlg;
  }

  // Pilih petugas (Pengawas/Pencacah) berdasarkan email
  async function pickUser(btnId, email, label) {
    const getBtn = () => document.getElementById(btnId);
    const btn = getBtn();
    if (!btn) throw new Error(`isian ${label} tidak ada`);
    if (shownText(btn).toLowerCase() === email.toLowerCase()) return true;
    triggerClick(btn);
    await waitFor(() => visibleOptions().length, 6000);
    const find = () =>
      visibleOptions().find((el) => optionText(el).toLowerCase().includes(email.toLowerCase()));
    let target = find();
    const input = document.querySelector("input[cmdk-input]");
    for (const q of [email, email.split("@")[0]]) {
      if (target || !input) break;
      setInputValue(input, q);
      target = await waitFor(find, 4000);
    }
    if (!target) {
      pressKey("Escape");
      await sleep(300);
      throw new Error(`${label} ${email} tidak ada di pilihan (belum punya akses ke SLS tujuan?)`);
    }
    triggerClick(target);
    return !!(await waitFor(
      () => shownText(getBtn()).toLowerCase().includes(email.toLowerCase()),
      5000,
    ));
  }

  async function fillGantiWilayah(item) {
    const conf = loadConf();
    const dlg = () => gantiDialog();
    const f = (label) => () => fieldButton(label, dlg());
    // Provinsi & kabupaten sudah terisi wilayah asal; kec/desa sama dengan asal -> dicek saja
    for (const [label, code] of [
      ["PROVINSI", "63"],
      ["KABUPATEN/KOTA", "07"],
      ["KECAMATAN", item.kec.code],
      ["DESA", item.desa.code],
      ["SLS", item.slsTujuan],
      ["SUBSLS", item.subslsTujuan],
    ]) {
      // SLS tanpa pecahan: FASIH tidak menampilkan isian SUBSLS -> cukup untuk SubSLS 00
      if (label === "SUBSLS" && !(await waitFor(f(label), 8000))) {
        if (code === "00") continue;
        throw new Error(`isian SUBSLS tidak muncul, padahal tujuan SubSLS ${code}`);
      }
      if (!(await pickByCode(f(label), code, label)))
        throw new Error(`${label} tidak bisa diisi [${code}]`);
    }
    await pickUser("userIds[0]", conf.pengawas, "Pengawas");
    await pickUser("userIds[1]", conf.pencacah, "Pencacah");
    await sleep(500);
    // Cek ulang semuanya sebelum kirim
    const got = ["KECAMATAN", "DESA", "SLS", "SUBSLS"].map((l) =>
      l === "SUBSLS" && !f(l)() ? "00" : shownCode(f(l)()),
    );
    const want = [item.kec.code, item.desa.code, item.slsTujuan, item.subslsTujuan];
    if (got.join("|") !== want.join("|"))
      throw new Error(`isian wilayah tidak sesuai: ${got.join("/")} ≠ ${want.join("/")}`);
  }

  async function submitGantiWilayah() {
    const d = gantiDialog();
    const btn = d && Array.from(d.querySelectorAll('button[type="submit"]')).find(
      (b) => /ubah wilayah/i.test(b.innerText),
    );
    if (!btn || btn.disabled) throw new Error('tombol "Ubah Wilayah Assignment" tidak aktif');
    triggerClick(btn);
    const closed = await waitFor(() => !gantiDialog(), 20000);
    if (!closed) {
      const dlgNow = gantiDialog();
      const msg = ((dlgNow ? dlgNow.innerText : "").match(/.*(gagal|error|tidak|wajib).*/i) || [""])[0];
      throw new Error(`dialog tidak tertutup setelah kirim${msg ? `: ${msg.slice(0, 120)}` : ""}`);
    }
    await sleep(T().submit);
  }

  function closeGantiDialog() {
    const d = gantiDialog();
    if (!d) return;
    const x = Array.from(d.querySelectorAll("button")).find((b) => /close/i.test(b.innerText));
    if (x) triggerClick(x);
    else pressKey("Escape");
  }


  // =========================================================================
  // FORM ASSIGNMENT (review / edit)
  // =========================================================================
  const FIELD_WAIT_MS = 2500;
  const FORM_OPTION_SELECTOR =
    '[role="option"], [cmdk-item], [data-reka-collection-item], [role="listbox"] li, [role="dialog"] li';

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
  const normName = (t) =>
    normalize(t)
      .replace(/\b(MUHAMMAD|MUHAMAD|MOHAMMAD|MOHAMAD|MOCH|MOH|MHD|MUH)\b/g, "M")
      .replace(/\b(HAJI|HAJJAH|HJ|H)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const nameSimilarity = (a, b) => {
    const na = normName(a);
    const nb = normName(b);
    return na && nb ? levenshteinRatio(na, nb) : 0;
  };

  // Opsi "Pilih UMKM dalam satu SLS": "NAMA - ALAMAT" -> cocok jika NAMA = nama usaha OSS
  function umkmMatches(text, namaUsaha) {
    const name = String(text || "").split(/\s+-\s+/)[0];
    return normName(name) === normName(namaUsaha) || nameSimilarity(name, namaUsaha) >= 0.9;
  }

  function box(id, inst) {
    return document.getElementById(inst === undefined ? id : `${id}#${inst}`);
  }
  async function waitBox(id, inst, ms) {
    return waitFor(() => {
      const b = box(id, inst);
      return visible(b) ? b : null;
    }, ms === undefined ? FIELD_WAIT_MS : ms);
  }
  const fresh = (el) => (el.id && document.getElementById(el.id)) || el;

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

  // Isi satu rincian (radio / teks). Hasil: 'ok' | 'skip' (tidak muncul) | 'fail'
  async function fillField(id, inst, value, opts = {}) {
    const container = opts.container || (await waitBox(id, inst, opts.wait));
    if (!container) return "skip";
    if (container.querySelector('input[type="radio"]'))
      return (await setRadio(container, String(value))) ? "ok" : "fail";
    const input = container.querySelector('input[type="text"]:not([disabled]), input:not([type]):not([disabled]), textarea:not([disabled])');
    if (!input) return "skip";
    if (input.value.trim() !== String(value)) {
      setFieldValue(input, String(value));
      commitField(input);
      await sleep(250);
    }
    return "ok";
  }

  function buttonByText(text, scope) {
    return Array.from((scope || document).querySelectorAll("button")).find(
      (b) =>
        visible(b) &&
        !b.disabled &&
        b.innerText.trim().toUpperCase() === text.toUpperCase() &&
        !b.closest("#fgw-panel, #fgw-bar"),
    );
  }
  function buttonMatching(re) {
    return Array.from(document.querySelectorAll("button")).find(
      (b) => visible(b) && !b.disabled && re.test(b.innerText) && !b.closest("#fgw-panel, #fgw-bar"),
    );
  }
  function buttonByIcon(icon) {
    const svg = Array.from(document.querySelectorAll(`svg.tabler-icon-${icon}`)).find(
      (s) => s.closest("button") && visible(s.closest("button")),
    );
    return svg ? svg.closest("button") : null;
  }

  const formOptions = () =>
    Array.from(document.querySelectorAll(FORM_OPTION_SELECTOR)).filter(
      (el) => visible(el) && !el.closest("#fgw-panel, #fgw-bar") && el.innerText.trim(),
    );
  function dropdownValue(container) {
    const el = container.querySelector('textarea, input[type="text"]');
    return el ? el.value.trim() : "";
  }
  // Kotak terkunci ke identitas lain (textarea/tombolnya disabled, isinya cuma placeholder abu-abu
  // seperti "NAMA - DESA ..."), bukan slot kosong yang bisa dipilih
  function dropdownDisabled(container) {
    const el = container.querySelector('textarea, input[type="text"]');
    return !!(el && (el.disabled || el.hasAttribute("data-disabled") || el.getAttribute("aria-disabled") === "true"));
  }
  // Dropdown pencarian di form. pick(options) -> elemen opsi yang dipilih
  async function chooseFromDropdown(container, searchText, pick) {
    const textarea = container.querySelector('textarea, input[type="text"]');
    const toggle = container.querySelector('button[aria-haspopup="dialog"]');
    triggerClick(toggle || textarea);
    await sleep(400);
    if (searchText) {
      const search =
        document.querySelector('[role="dialog"] input:not([type="radio"]):not([type="checkbox"])') || textarea;
      if (search) setFieldValue(search, searchText);
    }
    const target = await waitFor(() => pick(formOptions()), 6000);
    if (!target) {
      pressKey("Escape");
      await sleep(W(300));
      return false;
    }
    triggerClick(target);
    await sleep(W(600));
    return true;
  }

  // ---------- Navigasi form ----------
  const squashT = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sidebarItems = () =>
    Array.from(document.querySelectorAll(".fasih-form-sidebar > div[title], .fasih-form-sidebar [title]"));
  function sidebarItem(title) {
    const want = squashT(title);
    const items = sidebarItems();
    return (
      items.find((el) => squashT(el.getAttribute("title")) === want) ||
      items.find((el) => squashT(el.getAttribute("title")).startsWith(want)) ||
      null
    );
  }
  async function goSection(title, readyCheck, force) {
    if (!force && readyCheck()) return true;
    const item = await waitFor(() => sidebarItem(title), 30000);
    if (!item) throw new Error(`menu "${title}" tidak ada di sidebar`);
    triggerClick(item);
    if (!(await waitFor(readyCheck, 20000))) throw new Error(`halaman "${title}" tidak terbuka`);
    await sleep(W(800));
    return true;
  }

  // Buka halaman sidebar yang memuat isian tertentu (dicoba satu per satu; hasilnya diingat)
  const SECTION_CACHE_KEY = "fgw_section_cache";
  async function goToField(key, check) {
    if (check()) return true;
    const cache = loadJson(SECTION_CACHE_KEY, {});
    await waitFor(() => sidebarItems().length, 30000);
    const titles = Array.from(new Set(sidebarItems().map((el) => el.getAttribute("title")).filter(Boolean)));
    // Halaman P dicoba duluan (isian Blok P paling sering dicari)
    const guess = titles.filter((t) => /(^|[\s-])P$|BLOK P\b/i.test(t.trim()));
    const base = guess.concat(titles.filter((t) => !guess.includes(t)));
    const order = cache[key] ? [cache[key], ...base.filter((t) => t !== cache[key])] : base;
    for (const title of order) {
      const el = sidebarItem(title);
      if (!el) continue;
      triggerClick(el);
      if (await waitFor(check, 1500)) {
        cache[key] = title;
        saveJson(SECTION_CACHE_KEY, cache);
        await sleep(W(600));
        return true;
      }
    }
    throw new Error(`isian ${key} tidak ditemukan di halaman mana pun`);
  }

  const onBlokII = () => visible(box("se2026_nested")) && !document.querySelector('[id^="keberadaan_usaha#"]');
  function usahaCards() {
    const list = box("se2026_nested");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-nested-view]")).map((card) => {
      const span = card.querySelector("span");
      return { card, name: (span ? span.innerText : card.innerText).trim().toUpperCase() };
    });
  }
  async function openUsahaPage(card) {
    triggerClick(card.card);
    const kb = await waitFor(() => {
      const el = document.querySelector('[id^="keberadaan_usaha#"]');
      return visible(el) ? el : null;
    }, 20000);
    if (!kb) throw new Error(`rincian usaha "${card.name}" tidak terbuka`);
    await sleep(W(800));
    return kb.id.split("#")[1];
  }

  // ---------- Review -> Edit (revoke bila perlu) ----------
  async function reviewToEdit() {
    await waitFor(() => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"), 20000);
    await sleep(W(600));
    let revoked = false;
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      const revoke = buttonByIcon("rotate-clockwise");
      if (!revoke || revoke.disabled) throw new Error("tombol Edit & Revoke tidak aktif");
      runLog("Revoke dokumen");
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
        for (let i = 0; i < 7 && el; i++, el = el.parentElement)
          if (/anomali/i.test(el.innerText || "")) return true;
        return false;
      }) || null
    );
  }
  async function openCatatan() {
    closeDialogs();
    await goSection("CATATAN", () => !!findAnomaliSwitch());
    const control = () => {
      const s = findAnomaliSwitch();
      return s && s.parentElement.querySelector('[id$="-control"]');
    };
    const isOn = () => {
      const s = findAnomaliSwitch();
      const c = control();
      return !!s && (s.checked || s.getAttribute("aria-checked") === "true" || (c && c.hasAttribute("data-checked")));
    };
    for (const attempt of [
      () => triggerClick(control() || findAnomaliSwitch()),
      () => findAnomaliSwitch().click(),
    ]) {
      if (isOn()) break;
      attempt();
      await waitFor(isOn, 2500);
    }
    if (isOn()) await sleep(W(1200));
    runLog(`CATATAN: anomali ${isOn() ? "aktif" : "GAGAL diaktifkan"}`);
  }

  const isKirimText = (b) => b.innerText.trim().toUpperCase() === "KIRIM";
  const inDialog = (b) => !!b.closest('[role="dialog"], [role="alertdialog"]');
  const hasSendIcon = (b) => !!b.querySelector('svg path[d^="M10 14l11 -11"], svg.tabler-icon-send');
  function findNavKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !inDialog(b) && !b.closest("#fgw-panel, #fgw-bar"),
    );
    return buttons.find(hasSendIcon) || buttons.find((b) => b.id === "fasih-form-nav-submit-button") || buttons[0] || null;
  }
  function findDialogKirim() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !b.closest("#fgw-panel, #fgw-bar"),
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
        return `${titleEl ? titleEl.getAttribute("title").trim() : "?"} (${Array.from(card.querySelectorAll("li")).map((li) => li.innerText.trim()).join(", ")})`;
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
    Array.from(document.querySelectorAll("button")).find(
      (b) => /KEMBALI KE REVIEW/i.test(b.innerText) && b.getClientRects().length > 0,
    );
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

  // Kirim dokumen yang sedang diedit. Galat -> gagal (tidak dikirim)
  async function submitCurrent() {
    const run = loadRun();
    if (run.cur && run.cur.submitClicked) {
      await backToReview(20000); // halaman dimuat ulang setelah Kirim: jangan kirim dua kali
      return;
    }
    await openCatatan();
    const nav = await waitFor(findNavKirim, 10000);
    if (!nav) throw new Error("tombol Kirim tidak ditemukan / tidak aktif");
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
      closeDialogs();
      throw new Error(`galat ${galat ? galat.n : list.length}: ${detail || "lihat di FASIH"}`);
    }
    const dialogKirim = findDialogKirim();
    if (!dialogKirim) throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    const r = loadRun();
    r.cur.submitClicked = true;
    saveRun(r);
    triggerClick(dialogKirim);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi) throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }

  // OSS: Kirim -> tombol ⋮ di samping Kirim -> "Submit Paksa" -> Konfirmasi (galat tidak menghalangi)
  const isDotsButton = (b) => !!b.querySelector('svg path[d^="M12 12m-1 0"]');
  function findForceTrigger() {
    const cands = Array.from(
      document.querySelectorAll('button[id^="dropdownmenu-"][id$="-trigger"], button[aria-haspopup="true"], button[aria-haspopup="menu"]'),
    ).filter((b) => visible(b) && isDotsButton(b) && !b.closest("#fgw-panel, #fgw-bar"));
    return cands.find(inDialog) || cands[0] || null;
  }
  async function forceSubmitCurrent() {
    const run = loadRun();
    if (run.cur && run.cur.submitClicked) {
      await backToReview(20000); // halaman dimuat ulang setelah kirim: jangan kirim dua kali
      return;
    }
    await openCatatan();
    const nav = await waitFor(findNavKirim, 10000);
    if (!nav) throw new Error("tombol Kirim tidak ditemukan / tidak aktif");
    runLog("OSS: klik Kirim");
    triggerClick(nav);
    await waitFor(() => summaryCount("GALAT") || findDialogKirim() || findForceTrigger(), 15000);
    await sleep(W(1000));
    const galat = summaryCount("GALAT");
    const trigger = await waitFor(findForceTrigger, 8000);
    if (!trigger) throw new Error(`tombol ⋮ (Submit Paksa) tidak muncul: ${dialogText()}`);
    triggerClick(trigger);
    const menu = await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => visible(el) && /SUBMIT\s+PAKSA/i.test(el.innerText)),
      6000,
    );
    if (!menu) {
      pressKey("Escape");
      throw new Error('menu "Submit Paksa" tidak muncul');
    }
    runLog(`OSS: Submit Paksa${galat && galat.n ? ` (galat ${galat.n} diabaikan)` : ""}`);
    triggerClick(menu);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi) throw new Error(`tombol Konfirmasi Submit Paksa tidak muncul: ${dialogText()}`);
    const r = loadRun();
    r.cur.submitClicked = true;
    saveRun(r);
    await sleep(W(400));
    triggerClick(konfirmasi);
    await backToReview(60000);
  }

  async function approveDocument() {
    const findCheck = () => {
      const buttons = Array.from(document.querySelectorAll("svg.tabler-icon-check"))
        .map((s) => s.closest("button"))
        .filter((b) => b && visible(b) && !b.disabled);
      return buttons.find((b) => /bg-success/.test(b.className)) || buttons[0] || null;
    };
    const check = await waitFor(findCheck, 25000);
    if (!check) throw new Error("terkirim, tapi tombol Approve (✔) tidak aktif");
    await sleep(W(600));
    triggerClick(check);
    const ok = await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter(
        (b) => visible(b) && !b.disabled && b.innerText.trim().toUpperCase() === "KONFIRMASI",
      );
      return buttons.find((b) => /bg-success/.test(b.className)) || buttons[0] || null;
    }, 10000);
    if (!ok) throw new Error("terkirim, tapi konfirmasi approve tidak muncul");
    await sleep(W(400));
    triggerClick(ok);
    await sleep(W(2500));
  }

  // =========================================================================
  // KELUARGA: salin Blok P + tautkan UMKM
  // =========================================================================
  const textOf = (id) => {
    const b = box(id);
    const i = b && b.querySelector("textarea, input");
    return i ? i.value.trim() : "";
  };
  function readGeotag(g) {
    const out = {};
    if (!g) return out;
    Array.from(g.querySelectorAll("span")).forEach((s) => {
      const label = s.innerText.trim().toUpperCase();
      const val = s.nextElementSibling ? s.nextElementSibling.innerText.trim() : "";
      if (label === "LATITUDE") out.lat = val;
      if (label === "LONGITUDE") out.lng = val;
    });
    return out;
  }

  async function readFamilyP() {
    await goToField("jalan_domisili", () => visible(box("jalan_domisili")));
    await sleep(W(500));
    const geo = readGeotag(box("geotag"));
    return {
      jalan: textOf("jalan_domisili"),
      nomor: textOf("nomor_domisili"),
      noBang: textOf("no_bang"),
      lat: geo.lat || "",
      lng: geo.lng || "",
    };
  }

  // Hasil: { result: 'found' | 'nousaha' | 'nomatch', changed, card }
  // Opsi di popover dropdown UMKM (id popover diambil dari aria-controls tombol panah)
  function umkmOptions(container) {
    const toggle = container.querySelector('button[aria-haspopup="dialog"]');
    const pop = toggle && toggle.getAttribute("aria-controls") && document.getElementById(toggle.getAttribute("aria-controls"));
    const scoped = pop
      ? Array.from(pop.querySelectorAll('[role="option"], [cmdk-item], li, button, [data-value]')).filter(
          (el) => visible(el) && el.innerText.trim() && !el.querySelector('[role="option"], li, button'),
        )
      : [];
    return scoped.length ? scoped : formOptions();
  }

  // Ketik nama OSS di kotak "Pilih UMKM dalam satu SLS", lalu pilih opsi yang namanya sama
  async function searchAndPickUmkm(umkm, query, namaUsaha) {
    const ta = () => fresh(umkm).querySelector("textarea, input[type='text']");
    if (!ta()) return false;
    triggerClick(ta());
    setFieldValue(ta(), query);
    let target = await waitFor(() => umkmOptions(fresh(umkm)).find((o) => umkmMatches(o.innerText, namaUsaha)), 5000);
    if (!target) {
      // Daftar belum terbuka: buka lewat tombol panah (teks pencarian tetap)
      const toggle = fresh(umkm).querySelector('button[aria-haspopup="dialog"]');
      if (toggle && toggle.getAttribute("aria-expanded") !== "true") triggerClick(toggle);
      target = await waitFor(() => umkmOptions(fresh(umkm)).find((o) => umkmMatches(o.innerText, namaUsaha)), 4000);
    }
    if (!target) {
      pressKey("Escape");
      if (ta() && ta().value.trim() === query) setFieldValue(ta(), ""); // hapus sisa teks pencarian
      await sleep(W(300));
      return false;
    }
    triggerClick(target);
    return !!(await waitFor(() => umkmMatches(dropdownValue(fresh(umkm)), namaUsaha), 4000));
  }

  // Tautkan OSS ke SATU usaha keluarga yang punya isian "Pilih UMKM dalam satu SLS".
  // Baca kartu usaha keluarga & kondisi isian "Pilih UMKM dalam satu SLS" tiap kartu. MURNI BACA --
  // tidak klik apa pun yang mengubah isian, jadi aman dipanggil di halaman Review (belum Edit) maupun Edit.
  // Hasil: { result: 'nousaha'|'found'|'ganda'|'nomatch'|'pick', card?, slots }
  //   - 'found' : OSS ini sudah tertaut di salah satu kartu
  //   - 'ganda' : semua kartu usaha tidak punya isian Pilih UMKM yang bisa dipakai (kosong+tidak ada kolom,
  //               atau kolom ada tapi terkunci & kosong) -> usaha dicatat langsung, OSS ini data Ganda
  //   - 'nomatch': ada kolom Pilih UMKM yang sudah dipakai (terisi usaha lain, kolom terkunci) tapi tidak
  //               satu pun cocok nama OSS kita, dan tidak ada slot kosong yang bisa dicoba
  //   - 'pick'  : ada slot (kosong atau bukan) yang masih bisa diklik -> perlu dicoba cari & pilih
  async function scanUsahaCards(item) {
    await goSection("SE2026 - L BLOK II", onBlokII, true);
    const total = usahaCards().length;
    if (!total) return { result: "nousaha", slots: [] };

    const slots = [];
    let noField = 0;
    for (let idx = 0; idx < total; idx++) {
      if (idx > 0) await goSection("SE2026 - L BLOK II", onBlokII, true);
      const card = usahaCards()[idx];
      if (!card) continue;
      const inst = await openUsahaPage(card);
      const umkm = await waitBox("pilih_umkm_sls", inst, 3000);
      if (!umkm) {
        noField++; // kartu usaha ini tidak punya isian "Pilih UMKM dalam satu SLS" sama sekali
        continue;
      }
      const now = dropdownValue(umkm);
      if (now && umkmMatches(now, item.namaUsaha)) return { result: "found", card: card.name, slots: [] };
      if (dropdownDisabled(umkm)) {
        if (!now) noField++; // kosong & terkunci -> kartu ini memang tidak pakai Pilih UMKM
        // terkunci tapi SUDAH terisi usaha lain -> mekanismenya dipakai, cuma bukan OSS kita; bukan bukti Ganda
        continue;
      }
      slots.push({ idx, name: card.name, empty: !now || /TIDAK ADA/i.test(now) });
    }
    if (!slots.length && noField === total) return { result: "ganda", slots: [] };
    if (!slots.length) return { result: "nomatch", slots: [] };
    return { result: "pick", slots };
  }

  // Hasil: { result: 'found' | 'nousaha' | 'ganda' | 'nomatch', changed, card }
  async function linkUmkm(item) {
    const scan = await scanUsahaCards(item);
    if (scan.result === "nousaha") return { result: "nousaha", changed: false };
    if (scan.result === "found") return { result: "found", changed: false, card: scan.card };
    if (scan.result === "ganda")
      return { result: "ganda", changed: false, note: "usaha keluarga tidak punya isian Pilih UMKM dalam satu SLS" };
    if (scan.result === "nomatch") return { result: "nomatch", changed: false, note: "tidak ada usaha dengan isian Pilih UMKM" };
    const { slots } = scan;

    // 2) Pilih satu kartu (yang masih kosong didahulukan), cari nama OSS, pilih
    const words = normalize(item.namaUsaha).split(" ");
    const queries = Array.from(new Set([item.namaUsaha.trim(), words.slice(0, 2).join(" "), words.sort((a, b) => b.length - a.length)[0]]));
    const order = slots.filter((s) => s.empty).concat(slots.filter((s) => !s.empty));
    for (const slot of order) {
      await goSection("SE2026 - L BLOK II", onBlokII, true);
      const card = usahaCards()[slot.idx];
      if (!card) continue;
      const inst = await openUsahaPage(card);
      const umkm = await waitBox("pilih_umkm_sls", inst, 3000);
      if (!umkm) continue;
      for (const q of queries) {
        if (await searchAndPickUmkm(umkm, q, item.namaUsaha))
          return { result: "found", changed: true, card: card.name };
      }
      // Nama OSS tidak ada di daftar kartu ini -> daftar UMKM sama untuk satu SLS, tidak perlu coba kartu lain
      return { result: "nomatch", changed: false };
    }
    return { result: "nomatch", changed: false };
  }

  // =========================================================================
  // OSS: Blok P (keberadaan, bangunan, alamat, geotag) + Blok II + kirim
  // =========================================================================
  async function setGeotag(lat, lng) {
    const g = await waitBox("geotag", undefined, 3000);
    if (!g) throw new Error("isian Geotagging tidak ada di OSS");
    const cur = readGeotag(g);
    if (cur.lat === lat && cur.lng === lng) return;
    const btn = Array.from(g.querySelectorAll("button")).find((b) => /AMBIL LOKASI|PERBARUI LOKASI/i.test(b.innerText));
    if (!btn) throw new Error('tombol "Ambil Lokasi" tidak ada');
    triggerClick(btn);
    const peta = await waitFor(() => buttonMatching(/PILIH DI PETA/i), 8000);
    if (!peta) throw new Error('pilihan "Pilih di peta" tidak muncul');
    triggerClick(peta);
    const latIn = await waitFor(() => document.getElementById("map-latitude"), 8000);
    const lngIn = document.getElementById("map-longitude");
    if (!latIn || !lngIn) throw new Error("kotak latitude/longitude tidak muncul");
    const accIn = document.getElementById("map-accuracy"); // akurasi (meter) diisi 5
    const fields = [[latIn, lat], [lngIn, lng]];
    if (accIn) fields.push([accIn, "5"]);
    for (const [el, v] of fields) {
      setInputValue(el, v);
      el.focus();
      ["keydown", "keypress", "keyup"].forEach((type) =>
        el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })),
      );
      await sleep(W(400));
    }
    const use = await waitFor(() => buttonMatching(/GUNAKAN LOKASI/i), 8000);
    if (!use) throw new Error('tombol "Gunakan Lokasi" tidak aktif');
    triggerClick(use);
    const ya = await waitFor(() => buttonByText("Ya"), 6000);
    if (ya) triggerClick(ya);
    if (!(await waitFor(() => readGeotag(box("geotag")).lat, 8000)))
      throw new Error("koordinat tidak tersimpan di Geotagging");
    await sleep(W(500));
  }

  // Keberadaan Bangunan/Usaha (Blok P) -> Keberadaan Usaha (Blok II) harus sama statusnya
  const KEBERADAAN = {
    "0": { label: "Tidak Ditemukan", blok2: ["00", "0"] },
    "1": { label: "Ditemukan", blok2: ["1"] },
    "3": { label: "Tutup", blok2: ["3"] },
    "4": { label: "Ganda", blok2: ["4"] },
  };

  async function setBlok2Keberadaan(code) {
    const want = KEBERADAAN[code];
    const kbVisible = () => {
      const el = document.querySelector('[id^="keberadaan_usaha#"]');
      return visible(el) ? el : null;
    };
    try {
      await goToField("oss_keberadaan_usaha", kbVisible);
    } catch (e) {
      await goToField("oss_blok2_kartu", () => visible(box("se2026_nested")));
      const card = usahaCards()[0];
      if (!card) throw new Error("kartu usaha OSS tidak ada di Blok II");
      await openUsahaPage(card);
    }
    await sleep(W(500));
    const kb = kbVisible();
    // Pilihan di Blok II menyesuaikan Blok P (mis. hanya "3. Tutup"); pakai nilai yang tersedia
    const value = want.blok2.find((v) => kb && kb.querySelector(`input[type="radio"][value="${v}"]`));
    if (!value || (await fillField("", undefined, value, { container: kb })) !== "ok")
      throw new Error(`Keberadaan Usaha (Blok II) tidak bisa diisi ${want.label}`);
    if (radioValue(fresh(kb)) !== value)
      throw new Error(`Keberadaan Usaha (Blok II) = ${radioValue(fresh(kb)) || "kosong"}, seharusnya ${want.label}`);
    runLog(`Blok II: Keberadaan Usaha = ${want.label}`);
    await sleep(W(600));
  }

  // KETERANGAN PEMBERI JAWABAN: Nama Pemberi Informasi = Pemilik Usaha + centang persetujuan
  async function fillKeterangan() {
    const onKet = () => visible(box("nama_info_list"));
    try {
      await goSection("KETERANGAN PEMBERI JAWABAN", onKet);
    } catch (e) {
      await goToField("nama_info_list", onKet);
    }
    const info = box("nama_info_list");
    if (!/PEMILIK USAHA/i.test(dropdownValue(info))) {
      const pick = (opts) => opts.find((o) => /PEMILIK\s+USAHA/i.test(o.innerText));
      const ok =
        (await chooseFromDropdown(info, "", pick)) || (await chooseFromDropdown(fresh(info), "Pemilik", pick));
      if (!ok || !(await waitFor(() => /PEMILIK USAHA/i.test(dropdownValue(fresh(info))), 3000)))
        throw new Error('Nama Pemberi Informasi tidak bisa diisi "Pemilik Usaha"');
    }
    const setuju = await waitBox("persetujuan_responden", undefined, 3000);
    if (!setuju) throw new Error("centang persetujuan responden tidak ada");
    const checked = () => {
      const b = box("persetujuan_responden");
      const cb = b && b.querySelector('input[type="checkbox"]');
      const ctl = b && b.querySelector('[id$="-control"]');
      return !!(cb && (cb.checked || cb.hasAttribute("data-checked"))) || !!(ctl && ctl.hasAttribute("data-checked"));
    };
    if (!checked()) {
      triggerClick(setuju.querySelector('[id$="-control"]') || setuju.querySelector('input[type="checkbox"]'));
      if (!(await waitFor(checked, 3000))) {
        const cb = setuju.querySelector('input[type="checkbox"]');
        if (cb) cb.click();
        if (!(await waitFor(checked, 3000))) throw new Error("persetujuan responden tidak bisa dicentang");
      }
    }
    runLog("OSS Keterangan: Pemberi informasi = Pemilik Usaha, persetujuan dicentang");
    await sleep(W(500));
  }

  // Keberadaan Bangunan Lainnya/Usaha diisi DULUAN dan dipastikan benar-benar terpilih
  async function setAdaBangUsaha(code) {
    const label = KEBERADAAN[code].label;
    await goToField("ada_bang_usaha", () => visible(box("ada_bang_usaha")));
    for (let i = 0; i < 3 && radioValue(box("ada_bang_usaha")) !== code; i++) {
      await fillField("ada_bang_usaha", undefined, code);
      await waitFor(() => radioValue(box("ada_bang_usaha")) === code, 2000);
    }
    if (radioValue(box("ada_bang_usaha")) !== code)
      throw new Error(`Keberadaan Bangunan/Usaha tidak bisa diisi ${label} (sekarang: ${radioValue(box("ada_bang_usaha")) || "kosong"})`);
    runLog(`OSS Blok P: Keberadaan Bangunan/Usaha = ${code}. ${label} ✓`);
    await sleep(W(800)); // isian lanjutan muncul setelah dijawab
  }

  async function fillOss(item) {
    if (item.linkResult === "ganda") {
      await setAdaBangUsaha("4");
      try {
        await fillKeterangan();
      } catch (e) {
        runLog(`⚠ keterangan pemberi jawaban dilewati: ${e.message}`);
      }
      await setBlok2Keberadaan("4");
      return;
    }
    if (item.linkResult !== "found") {
      await setAdaBangUsaha("3");
      try {
        await fillKeterangan();
      } catch (e) {
        runLog(`⚠ keterangan pemberi jawaban dilewati: ${e.message}`);
      }
      await setBlok2Keberadaan("3");
      return;
    }
    await setAdaBangUsaha("1");
    await fillKeterangan();
    // Keterangan di halaman lain: pastikan Blok P tetap Ditemukan setelah kembali
    await setAdaBangUsaha("1");
    runLog("OSS Blok P: Kode Penggunaan Bangunan = 1");
    if ((await fillField("kode_bang", undefined, "1", { wait: 4000 })) === "fail") throw new Error("Kode Penggunaan Bangunan tidak bisa diisi 1");
    const p = item.pdata || {};
    runLog(`OSS Blok P: alamat "${p.jalan || "-"}", no ${p.nomor || "-"}, no bangunan ${p.noBang || "-"}`);
    if (p.jalan) await fillField("jalan_domisili", undefined, p.jalan, { wait: 1500 });
    await fillField("nomor_domisili", undefined, p.nomor || "-", { wait: 1500 });
    if (p.noBang) await fillField("no_bang", undefined, p.noBang, { wait: 1500 });
    if (p.lat && p.lng) {
      runLog(`OSS Blok P: geotag ${p.lat}, ${p.lng} (akurasi 5 m)`);
      await setGeotag(p.lat, p.lng);
    }
    else runLog("⚠ geotag keluarga kosong, OSS tidak diberi koordinat");

    await setBlok2Keberadaan("1");
  }

  // =========================================================================
  // MESIN: pindah (daftar) -> keluarga -> OSS, bertahap lintas halaman
  // =========================================================================
  let busy = false;
  let userDecision = null; // mode uji dialog Ganti Wilayah: "send" | "skip"
  const STAGE_TIMEOUT_MS = 4 * 60 * 1000;
  const STAGE_LABEL = {
    gcheck_scan: "Cek Review keluarga (tanpa edit)",
    kel_open: "Membuka keluarga",
    kel_fill: "Cek usaha keluarga",
    kel_submit: "Kirim keluarga",
    kel_approve: "Approve keluarga",
    oss_open: "Membuka OSS",
    oss_fill: "Mengisi OSS",
    oss_submit: "Kirim OSS",
    oss_approve: "Approve OSS",
  };
  // Urutan langkah per baris (untuk bar progres)
  const STEPS = [
    ["move", "Pindah wilayah"],
    ["kel_open", "Buka keluarga"],
    ["kel_fill", "Salin Blok P + pilih UMKM"],
    ["kel_submit", "Kirim keluarga"],
    ["kel_approve", "Approve keluarga"],
    ["oss_open", "Buka OSS"],
    ["oss_fill", "Isi OSS (keterangan, P, geotag, Blok II)"],
    ["oss_submit", "Kirim OSS"],
    ["oss_approve", "Approve OSS"],
  ];

  function runLog(msg) {
    console.log(`[OSS→Keluarga] ${msg}`);
    const r = loadRun();
    r.lastLog = msg;
    r.logs = [...(r.logs || []), `${new Date().toLocaleTimeString("id-ID")} ${msg}`].slice(-5);
    saveRun(r);
    updateBar();
  }
  function setStage(stage, extra) {
    const r = loadRun();
    if (r.cur && r.cur.stage && r.cur.stage !== stage && r.phaseAt)
      r.lastStep = `${STAGE_LABEL[r.cur.stage] || r.cur.stage}: ${Math.round((Date.now() - r.phaseAt) / 1000)} dtk`;
    r.cur = Object.assign(r.cur || {}, { navTries: 0 }, extra || {}, { stage });
    r.phaseAt = Date.now();
    saveRun(r);
    updateBar();
  }

  const prefix = () => loadConf().surveyPrefix;
  const reviewUrl = (id) => `${location.origin}/app/assignment/${prefix()}/${id}`;
  const onReviewOf = (id) => new RegExp(`/app/assignment/[^/]+/${id}/?$`, "i").test(location.pathname);
  const onEditOf = (id) => new RegExp(`/app/assignment/[^/]+/${id}/edit`, "i").test(location.pathname);
  const onDetailOf = (id) => new RegExp(`/app/assignment-detail/${id}`, "i").test(location.pathname);
  // ID survei bisa beda antara dokumen keluarga dan OSS -> diingat terpisah
  const prefixFor = (kind) => {
    const c = loadConf();
    return (kind === "oss" ? c.prefixOss : c.prefixKel) || c.surveyPrefix;
  };

  // Menuju halaman Review dokumen id. Hasil true jika sudah di halaman Review.
  // Coba URL /app/assignment/<ID survei>/<id>; kalau tidak terbuka, lewat /app/assignment-detail/<id> (link di Excel)
  async function ensureReview(id, kind) {
    if (onReviewOf(id)) return true;
    if (onDetailOf(id)) {
      const link = await waitFor(
        () =>
          Array.from(document.querySelectorAll('a[href*="/app/assignment/"]')).find((a) =>
            a.getAttribute("href").toLowerCase().includes(id),
          ),
        12000,
      );
      if (link) {
        const m = link.getAttribute("href").match(/\/app\/assignment\/([0-9a-f-]{36})\//i);
        if (m) {
          const c = loadConf();
          c[kind === "oss" ? "prefixOss" : "prefixKel"] = m[1];
          saveConf(c);
        }
        runLog(`Buka Review ${kind === "oss" ? "OSS" : "keluarga"} dari halaman detail`);
        const r = loadRun();
        r.navAt = Date.now();
        saveRun(r);
        location.href = link.href;
        return false;
      }
      throw new Error("halaman detail assignment tidak punya link Review");
    }
    const r = loadRun();
    if (Date.now() - (r.navAt || 0) < 3000) return false; // tunggu halaman sebelumnya selesai dimuat
    const tries = (r.cur && r.cur.navTries) || 0;
    if (tries >= 4) throw new Error(`dokumen ${kind === "oss" ? "OSS" : "keluarga"} tidak bisa dibuka (cek ID survei / akses akun)`);
    r.cur.navTries = tries + 1;
    r.navAt = Date.now();
    saveRun(r);
    const url =
      tries === 0
        ? `${location.origin}/app/assignment/${prefixFor(kind)}/${id}`
        : `${location.origin}/app/assignment-detail/${id}`;
    runLog(`Membuka ${kind === "oss" ? "OSS" : "keluarga"} (percobaan ${tries + 1})`);
    location.href = url;
    return false;
  }

  function goUrl(url) {
    const r = loadRun();
    if (Date.now() - (r.navAt || 0) < 8000) return;
    r.navAt = Date.now();
    saveRun(r);
    location.href = url;
  }
  function goList() {
    const r = loadRun();
    if (r.listUrl && !isListPage()) goUrl(r.listUrl);
  }

  // Ambil awalan survei dari link Review di halaman daftar (jika ada)
  function learnPrefix() {
    const a = document.querySelector('a[href*="/app/assignment/"]');
    const m = a && a.getAttribute("href").match(/\/app\/assignment\/([0-9a-f-]{36})\//i);
    if (m && m[1] !== prefix()) {
      const cf = loadConf();
      cf.surveyPrefix = m[1];
      saveConf(cf);
    }
  }

  function finishItem(id, status, reason) {
    updateItem(id, { status, reason, doneAt: new Date().toISOString() });
    const r = loadRun();
    r.cur = null;
    r.moving = null;
    r.paused = null;
    r.processed = (r.processed || 0) + 1;
    const gap = T().gap;
    r.nextAt = Date.now() + gap[0] + Math.random() * (gap[1] - gap[0]);
    saveRun(r);
    runLog(`${/linked|closed|moved/.test(status) ? "✅" : "⚠️"} ${reason}`);
  }

  // Pindah wilayah di halaman daftar. Hasil: { status, reason }
  async function moveItem(item, testMode) {
    runLog(`Mencari ${item.namaUsaha} (${item.desa.name} ${item.slsAsalNama || item.slsAsal})`);
    let found;
    try {
      found = await findRow(item);
    } catch (e) {
      // Tidak ada di SLS asal: mungkin sudah pindah -> cek di SLS tujuan
      if (!e.soft || !/tidak ada di SLS/.test(e.message)) throw e;
      await applyFilter(item, item.slsTujuan);
      const want = normalize(item.namaUsaha);
      const rows = await searchList(item.namaUsaha);
      if (rows.some((tr) => Array.from(tr.querySelectorAll("td")).some((td) => normalize(td.innerText) === want)))
        return { status: "moved", reason: `sudah ada di SLS tujuan ${item.slsTujuan}` };
      throw e;
    }
    await openGantiWilayah(found.tr);
    runLog(`Mengisi → SLS ${item.slsTujuan}/${item.subslsTujuan} ${item.slsTujuanNama}`);
    await fillGantiWilayah(item);
    if (testMode) {
      userDecision = null;
      const r = loadRun();
      r.waiting = true;
      saveRun(r);
      runLog(`MODE UJI: periksa dialog Ganti Wilayah, lalu "Kirim sekarang" / "Lewati"`);
      await waitFor(() => userDecision, 24 * 3600000);
      const r2 = loadRun();
      r2.waiting = false;
      saveRun(r2);
      if (userDecision !== "send") {
        closeGantiDialog();
        return { status: "tested", reason: `terisi, tidak dikirim (${found.note})` };
      }
    }
    await submitGantiWilayah();
    appliedFilterKey = null;
    return { status: "moved", reason: `dipindah ke SLS ${item.slsTujuan}/${item.subslsTujuan} (${found.note})` };
  }

  const needsForce = (q) => q.status === "linked" && !q.forced;
  // OSS Tutup lama (sebelum perbaikan Ganda): karena saat itu kartu usaha tanpa isian
  // "Pilih UMKM dalam satu SLS" selalu dibaca "nomatch" -> OSS Tutup, padahal seharusnya "Ganda".
  // gandaChecked: sudah pernah dicek ulang (dan dipastikan tetap Tutup) -> jangan diulang terus.
  const needsGandaCheck = (q) => q.status === "closed" && q.linkResult === "nomatch" && !q.gandaChecked;
  function nextItem(run) {
    const only = run.onlyIds ? new Set(run.onlyIds) : null;
    if (run.forceRedo) return loadQueue().find((q) => needsForce(q) && (!only || only.has(q.id)));
    if (run.recheckGanda) return loadQueue().find((q) => needsGandaCheck(q) && (!only || only.has(q.id)));
    const want = run.onlyLink ? ["moved"] : run.doLink ? ["moved", "pending"] : ["pending"];
    const ready = loadQueue().filter((q) => want.includes(q.status) && (!only || only.has(q.id)));
    // Pindah wilayah SEMUA dulu (tetap di halaman daftar), baru tautkan yang sudah dipindah
    const pending = ready.filter((q) => q.status === "pending");
    if (pending.length)
      return pending.find((q) => `${q.kec.code}|${q.desa.code}|${q.slsAsal}` === appliedFilterKey) || pending[0];
    return ready.find((q) => q.status === "moved");
  }

  // Mode uji: berhenti sebelum Kirim. Hasil true = boleh lanjut
  function testGate(run, what) {
    if (!run.testMode || (run.cur && run.cur.confirmed === run.cur.stage)) return true;
    if (!run.paused) {
      run.paused = { stage: run.cur.stage };
      saveRun(run);
      runLog(`MODE UJI: ${what} siap dikirim. Periksa, lalu "Kirim sekarang" / "Lewati"`);
    }
    return false;
  }

  async function tick() {
    const run = loadRun();
    if (!run.running || busy || rateLimited() || run.paused) return;
    busy = true;
    stopRequested = false;
    try {
      if (isListPage()) {
        run.listUrl = location.href;
        saveRun(run);
        learnPrefix();
      }
      // ---- belum ada item aktif: ambil berikutnya ----
      if (!run.cur) {
        if (Date.now() < (run.nextAt || 0)) return;
        const item = nextItem(run);
        if (!item || (run.limit && run.processed >= run.limit)) return stopRun("Selesai.");
        if (run.forceRedo) {
          setStage("oss_open", { id: item.id, force: true });
          runLog(`Force submit ulang OSS ${item.namaUsaha}`);
          return;
        }
        if (run.recheckGanda) {
          setStage("gcheck_scan", { id: item.id });
          runLog(`Cek ulang Ganda (baca halaman Review dulu, tanpa edit): ${item.namaUsaha}`);
          return;
        }
        if (item.status === "moved") {
          setStage("kel_open", { id: item.id });
          runLog(`Tautkan ${item.namaUsaha}`);
          return;
        }
        if (!isListPage()) return goList();
        const rm = loadRun();
        rm.moving = { id: item.id };
        saveRun(rm);
        let res;
        try {
          res = await moveItem(item, run.testMode);
        } catch (e) {
          appliedFilterKey = null;
          closeGantiDialog();
          pressKey("Escape");
          res = { status: e.soft ? "yellow" : "red", reason: e.message };
        }
        // Sesudah dipindah: status "dipindah"; ditautkan nanti setelah semua selesai dipindah
        finishItem(item.id, res.status, `${item.namaUsaha}: ${res.reason}`);
        return;
      }

      // ---- item aktif: lanjutkan tahapnya ----
      const cur = run.cur;
      const item = loadQueue().find((q) => q.id === cur.id);
      if (!item) return finishItem(cur.id, "red", "item hilang dari antrean");
      if (Date.now() - (run.phaseAt || 0) > STAGE_TIMEOUT_MS)
        return finishItem(item.id, "red", `${item.namaUsaha}: macet di tahap "${STAGE_LABEL[cur.stage] || cur.stage}"`);
      try {
        await runStage(run, cur, item);
      } catch (e) {
        console.error("[OSS→Keluarga]", e);
        pressKey("Escape");
        const where = STAGE_LABEL[cur.stage] || cur.stage;
        finishItem(item.id, /galat/.test(e.message) ? "yellow" : "red", `${item.namaUsaha}: [${where}] ${e.message}`);
      }
    } finally {
      busy = false;
    }
  }

  async function runStage(run, cur, item) {
    const kelId = item.kelId;
    switch (cur.stage) {
      case "gcheck_scan": {
        // Baca dulu di halaman Review keluarga (TANPA klik Edit / revoke) -- cuma lanjut ke cara lama
        // (revoke) kalau ternyata ada yang perlu ditulis (OSS baru ketemu cocok).
        if (!(await ensureReview(kelId, "kel"))) return;
        runLog(`Cek kartu usaha keluarga (halaman Review, belum edit): ${item.namaUsaha}`);
        let scan;
        try {
          scan = await scanUsahaCards(item);
        } catch (e) {
          runLog(`⚠ cek tanpa-edit gagal (${e.message}), pakai cara lama (revoke keluarga)`);
          return setStage("kel_open");
        }
        if (scan.result === "nousaha" || scan.result === "nomatch") {
          updateItem(item.id, { gandaChecked: true });
          finishItem(item.id, item.status, `${item.namaUsaha}: dicek ulang tanpa revoke, tidak ada perubahan (tetap OSS Tutup)`);
          return goList();
        }
        if (scan.result === "ganda") {
          // Keluarga tidak perlu diubah sama sekali -> langsung revoke & perbaiki OSS-nya saja
          updateItem(item.id, { linkResult: "ganda", gandaChecked: true });
          setStage("oss_open", { submitClicked: false });
          runLog(`Ganda terkonfirmasi tanpa revoke keluarga, membuka OSS ${item.namaUsaha}`);
          const r = loadRun();
          r.navAt = 0;
          saveRun(r);
          await ensureReview(item.id, "oss");
          return;
        }
        // scan.result === "found" / "pick": ada kemungkinan baru bisa ditautkan -> perlu tulis ke keluarga,
        // tidak bisa dilakukan dari halaman Review -> lanjut cara lama (revoke keluarga). Ditandai sudah
        // dicek supaya baris ini tidak diulang-ulang lagi oleh tombol Cek Ganda meskipun hasil akhirnya
        // ternyata tetap Tutup.
        updateItem(item.id, { gandaChecked: true });
        runLog(`Berpotensi ada yang bisa ditautkan, lanjut cara biasa (revoke keluarga)`);
        return setStage("kel_open");
      }
      case "kel_open":
      case "oss_open": {
        const id = cur.stage === "kel_open" ? kelId : item.id;
        if (!id) throw new Error("assignment_id keluarga kosong di Excel");
        const next = cur.stage === "kel_open" ? "kel_fill" : cur.force ? "oss_submit" : "oss_fill";
        if (onEditOf(id)) return setStage(next);
        if (!(await ensureReview(id, cur.stage === "kel_open" ? "kel" : "oss"))) return;
        runLog(`${STAGE_LABEL[cur.stage]}: ${item.namaUsaha}`);
        const revoked = await reviewToEdit();
        return setStage(next, { revoked, submitClicked: false });
      }
      case "kel_fill": {
        if (!onEditOf(kelId)) return setStage("kel_open");
        runLog("Salin Blok P keluarga");
        const pdata = await readFamilyP();
        runLog("Cek usaha keluarga & Pilih UMKM SLS");
        const link = await linkUmkm(item);
        updateItem(item.id, { pdata, linkResult: link.result, linkCard: link.card || "" });
        runLog(
          link.result === "found"
            ? `UMKM ${item.namaUsaha} ${link.changed ? "dipilih" : "sudah terpilih"} di usaha "${link.card}"`
            : link.result === "nousaha"
              ? "Keluarga tidak punya usaha → OSS akan ditutup"
              : link.result === "ganda"
                ? "Usaha keluarga tidak punya isian Pilih UMKM → OSS akan Ganda"
                : "OSS tidak ada di pilihan UMKM keluarga → OSS akan ditutup",
        );
        return setStage(cur.revoked || link.changed ? "kel_submit" : "oss_open", { submitClicked: false });
      }
      case "oss_fill": {
        if (!onEditOf(item.id)) return setStage("oss_open");
        runLog(item.linkResult === "found" ? "OSS: Ditemukan + salin alamat & geotag" : "OSS: Tutup");
        await fillOss(item);
        return setStage("oss_submit", { submitClicked: false });
      }
      case "kel_submit":
      case "oss_submit": {
        const id = cur.stage === "kel_submit" ? kelId : item.id;
        const next = cur.stage === "kel_submit" ? "kel_approve" : "oss_approve";
        if (!onEditOf(id)) {
          if (cur.submitClicked && onReviewOf(id)) return setStage(next);
          throw new Error("halaman edit tertutup sebelum dikirim");
        }
        const paksa = cur.stage === "oss_submit" && (cur.force || item.linkResult === "found");
        if (!testGate(run, cur.stage === "kel_submit" ? "Dokumen keluarga" : paksa ? "Dokumen OSS (Submit Paksa)" : "Dokumen OSS (Tutup, Kirim biasa)")) return;
        runLog(STAGE_LABEL[cur.stage]);
        if (paksa) await forceSubmitCurrent();
        else await submitCurrent();
        return setStage(next);
      }
      case "kel_approve":
      case "oss_approve": {
        const id = cur.stage === "kel_approve" ? kelId : item.id;
        if (!(await ensureReview(id, cur.stage === "kel_approve" ? "kel" : "oss"))) return;
        runLog(STAGE_LABEL[cur.stage]);
        // Pada titik ini dokumen SUDAH terkirim (kel_submit/oss_submit lolos sebelum sampai di sini),
        // dan untuk OSS, sudah tertaut (linkUmkm di kel_fill). Approve cuma langkah terakhir
        // (sering tanpa tombol ✔ aktif kalau sudah pernah di-approve, mis. lewat Force Submit Ulang)
        // -> kalau gagal, JANGAN menghapus status terkirim/tertaut yang sudah benar dengan menandai gagal.
        let approveNote = "";
        if (loadConf().approve) {
          try {
            await approveDocument();
          } catch (e) {
            approveNote = ` (approve ${cur.stage === "kel_approve" ? "keluarga" : "OSS"} gagal, cek manual: ${e.message})`;
            updateItem(item.id, cur.stage === "kel_approve" ? { kelNote: `approve keluarga gagal: ${e.message}` } : { ossNote: `approve OSS gagal: ${e.message}` });
            runLog(`⚠ approve ${cur.stage === "kel_approve" ? "keluarga" : "OSS"} gagal (${e.message}), status tetap dicatat terkirim`);
          }
          closeDialogs();
        }
        if (cur.stage === "kel_approve") {
          // Keluarga selesai -> langsung buka dokumen OSS
          setStage("oss_open", { submitClicked: false });
          runLog(`Keluarga selesai, membuka OSS ${item.namaUsaha}`);
          const r = loadRun();
          r.navAt = 0; // boleh pindah halaman sekarang
          saveRun(r);
          await ensureReview(item.id, "oss");
          return;
        }
        if (cur.force) {
          finishItem(item.id, item.status, `${item.namaUsaha}: force submit ulang ✓${loadConf().approve && !approveNote ? " & approve" : ""}${approveNote}`);
          updateItem(item.id, { forced: true });
          return goList();
        }
        const found = item.linkResult === "found";
        if (found) updateItem(item.id, { forced: true });
        finishItem(
          item.id,
          found ? "linked" : "closed",
          (found
            ? `${item.namaUsaha}: dipindah, ditautkan ke usaha "${item.linkCard}", OSS Ditemukan`
            : item.linkResult === "nousaha"
              ? `${item.namaUsaha}: dipindah, keluarga tanpa usaha → OSS Tutup`
              : item.linkResult === "ganda"
                ? `${item.namaUsaha}: dipindah, usaha keluarga tidak punya isian Pilih UMKM → OSS Ganda`
                : `${item.namaUsaha}: dipindah, tidak ada di pilihan UMKM → OSS Tutup`) + approveNote,
        );
        return goList();
      }
      default:
        throw new Error(`tahap tidak dikenal: ${cur.stage}`);
    }
  }

  function startRun(opts) {
    if (!isListPage()) {
      alert('Mulai dari halaman daftar assignment (tabel dengan kotak "Cari...").');
      return;
    }
    const conf = loadConf();
    // ▶ N / Uji 1: ambil N baris dari antrean -> N baris itu dipindah dulu, lalu ditautkan
    let onlyIds = opts.onlyIds || null;
    if (!onlyIds && opts.limit && opts.forceRedo)
      onlyIds = loadQueue().filter(needsForce).slice(0, opts.limit).map((q) => q.id);
    if (!onlyIds && opts.limit && !opts.forceRedo) {
      const want = opts.onlyLink ? ["moved"] : ["pending"];
      onlyIds = loadQueue()
        .filter((q) => want.includes(q.status))
        .slice(0, opts.limit)
        .map((q) => q.id);
      if (!onlyIds.length && !opts.onlyLink && conf.doLink)
        onlyIds = loadQueue().filter((q) => q.status === "moved").slice(0, opts.limit).map((q) => q.id);
    }
    saveRun({
      running: true,
      limit: 0,
      testMode: !!opts.testMode,
      doLink: conf.doLink,
      onlyLink: !!opts.onlyLink,
      forceRedo: !!opts.forceRedo,
      recheckGanda: !!opts.recheckGanda,
      onlyIds,
      processed: 0,
      listUrl: location.href,
      cur: null,
    });
    document.getElementById("fgw-panel")?.remove();
    runLog(`Mulai${opts.forceRedo ? " (force submit ulang OSS)" : ""}${opts.recheckGanda ? " (cek ulang Ganda dari OSS Tutup)" : ""}${opts.onlyLink ? " (tautkan saja)" : ""}${opts.testMode ? " · MODE UJI" : ""}`);
  }

  function stopRun(msg) {
    const r = loadRun();
    r.running = false;
    r.waiting = false;
    r.paused = null;
    saveRun(r);
    stopRequested = true;
    userDecision = userDecision || "skip";
    runLog(msg || "Dihentikan.");
    updateBar();
  }

  // =========================================================================
  // TAMPILAN
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById("fgw-style")) return;
    const style = document.createElement("style");
    style.id = "fgw-style";
    style.textContent = `
      .fgw, .fgw * { box-sizing:border-box; font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .fgw { --ink:#0f1222; --muted:#6b7186; --line:#e7e8ef; --soft:#f6f7fb; --accent:#0d9488; --accent2:#0891b2; --accent-soft:#e6f7f5; color:var(--ink); }
      .fgw button { font:inherit; }
      .fgw-overlay { position:fixed; inset:0; z-index:1000001; background:rgba(15,18,34,.38); backdrop-filter:blur(3px); display:flex; justify-content:flex-end; }
      .fgw-overlay.anim { animation:fgw-fade .18s ease; }
      .fgw-overlay.anim .fgw-sheet { animation:fgw-in .22s ease; }
      @keyframes fgw-fade { from { opacity:0; } to { opacity:1; } }
      @keyframes fgw-in { from { transform:translateX(24px); opacity:.4; } to { transform:none; opacity:1; } }
      @keyframes fgw-spin { to { transform:rotate(360deg); } }
      @keyframes fgw-pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
      @keyframes fgw-up { from { transform:translate(-50%,12px); opacity:0; } to { transform:translate(-50%,0); opacity:1; } }
      .fgw-sheet { background:var(--soft); width:min(860px,100vw); height:100vh; display:flex; flex-direction:column; box-shadow:-20px 0 60px rgba(15,18,34,.25); }
      .fgw-head { position:relative; padding:20px 24px 18px; color:#fff; background:linear-gradient(120deg,#0f766e,#0891b2 55%,#4f46e5); overflow:hidden; }
      .fgw-head:after { content:""; position:absolute; right:-60px; top:-80px; width:240px; height:240px; border-radius:50%; background:rgba(255,255,255,.09); pointer-events:none; }
      .fgw-head > * { position:relative; z-index:1; }
      .fgw-head-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .fgw-logo { width:44px; height:44px; border-radius:12px; background:rgba(255,255,255,.18); display:grid; place-items:center; font-size:20px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.25); flex:none; }
      .fgw-title { font-size:17px; font-weight:750; letter-spacing:-.2px; }
      .fgw-subtitle { font-size:12.5px; opacity:.85; margin-top:2px; }
      .fgw-head .fgw-btn { background:rgba(255,255,255,.14); border-color:rgba(255,255,255,.22); color:#fff; }
      .fgw-head .fgw-btn:hover { background:rgba(255,255,255,.26); }
      .fgw-prog { margin-top:16px; }
      .fgw-prog .track { height:8px; border-radius:99px; background:rgba(255,255,255,.2); overflow:hidden; display:flex; }
      .fgw-prog .seg { height:100%; transition:width .4s ease; }
      .fgw-prog .lbl { display:flex; justify-content:space-between; gap:10px; font-size:12px; margin-top:7px; opacity:.92; flex-wrap:wrap; }
      .fgw-prog .lbl i { font-style:normal; display:inline-flex; align-items:center; gap:5px; margin-right:10px; }
      .fgw-prog .lbl i::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--c); }
      .fgw-body { flex:1; overflow:auto; padding:18px 22px 26px; display:flex; flex-direction:column; gap:16px; }
      .fgw-card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow:0 1px 2px rgba(15,18,34,.04); }
      .fgw-card.run { background:linear-gradient(180deg,#f3fbfa,#fff); border-color:#99e3da; }
      .fgw-sec { font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:12px; }
      .fgw-sub { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:14px 0 8px; }
      .fgw-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
      .fgw-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .fgw-field { display:flex; flex-direction:column; gap:4px; font-size:11.5px; font-weight:600; color:var(--muted); }
      .fgw-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:10px; padding:8px 13px;
        font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; line-height:1.2; }
      .fgw-btn:hover { background:#fafcfc; border-color:#c7cfd2; transform:translateY(-1px); }
      .fgw-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }
      .fgw-btn.primary { background:linear-gradient(120deg,var(--accent),var(--accent2)); border-color:transparent; color:#fff; box-shadow:0 6px 16px rgba(13,148,136,.3); }
      .fgw-btn.primary:hover { box-shadow:0 8px 22px rgba(13,148,136,.4); }
      .fgw-btn.soft { background:var(--accent-soft); border-color:#c6ece7; color:#0f766e; }
      .fgw-btn.warn { color:#b45309; border-color:#fcd9a5; background:#fffbf3; }
      .fgw-btn.ok { color:#4d7c0f; border-color:#cfe5a9; }
      .fgw-btn.danger { color:#dc2626; }
      .fgw-btn.ghost { border-color:transparent; background:transparent; color:var(--muted); }
      .fgw-btn.sm { padding:5px 10px; font-size:12px; border-radius:8px; }
      .fgw-btn.icon { width:34px; height:34px; justify-content:center; padding:0; font-size:16px; }
      .fgw-btn .n { background:rgba(15,18,34,.08); border-radius:6px; padding:0 6px; font-size:11.5px; }
      .fgw-btn.primary .n { background:rgba(255,255,255,.25); }
      .fgw-input { border:1px solid var(--line); border-radius:9px; padding:8px 10px; font-size:13px; outline:none; background:#fff; color:var(--ink); min-width:0; width:100%; }
      .fgw-input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
      .fgw-hint { font-size:12px; color:var(--muted); line-height:1.5; }
      .fgw-seg { display:inline-flex; background:#eef1f3; border-radius:10px; padding:3px; gap:2px; }
      .fgw-seg label { position:relative; cursor:pointer; }
      .fgw-seg input { position:absolute; opacity:0; pointer-events:none; }
      .fgw-seg span { display:block; padding:6px 12px; border-radius:8px; font-size:12.5px; font-weight:600; color:var(--muted); }
      .fgw-seg input:checked + span { background:#fff; color:var(--accent); box-shadow:0 1px 3px rgba(15,18,34,.12); }
      .fgw-switch { display:flex; align-items:flex-start; gap:10px; padding:6px 0; font-size:13px; cursor:pointer; }
      .fgw-switch input { display:none; }
      .fgw-switch i { flex:none; width:36px; height:21px; border-radius:99px; background:#d5d7e3; position:relative; transition:background .15s; margin-top:1px; }
      .fgw-switch i::after { content:""; position:absolute; top:2.5px; left:2.5px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.2); transition:transform .15s; }
      .fgw-switch input:checked + i { background:var(--accent); }
      .fgw-switch input:checked + i::after { transform:translateX(15px); }
      .fgw-switch small { display:block; color:var(--muted); font-size:11.5px; margin-top:1px; }
      .fgw-details summary { cursor:pointer; font-size:12.5px; font-weight:600; color:var(--muted); list-style:none; margin-top:12px; }
      .fgw-details summary::-webkit-details-marker { display:none; }
      .fgw-details[open] summary { margin-bottom:6px; }
      .fgw-stats { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
      .fgw-stat { border:1px solid var(--line); border-radius:12px; padding:10px 12px; cursor:pointer; background:#fff; text-align:left; transition:all .15s; }
      .fgw-stat:hover { border-color:#c7cfd2; transform:translateY(-1px); }
      .fgw-stat.active { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 16%,transparent); }
      .fgw-stat .n { font-size:21px; font-weight:780; color:var(--c); line-height:1.1; letter-spacing:-.5px; }
      .fgw-stat .l { font-size:11.5px; color:var(--muted); margin-top:2px; display:flex; align-items:center; gap:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .fgw-stat .l::before { content:""; flex:none; width:7px; height:7px; border-radius:50%; background:var(--c); }
      .fgw-list { display:flex; flex-direction:column; gap:8px; }
      .fgw-item { display:grid; grid-template-columns:22px 1fr; gap:12px; align-items:start; background:#fff; border:1px solid var(--line); border-left:3px solid var(--c,var(--line));
        border-radius:12px; padding:12px 14px; font-size:12.5px; transition:all .15s; }
      .fgw-item:hover { border-color:#c7cfd2; border-left-color:var(--c); box-shadow:0 2px 8px rgba(15,18,34,.06); }
      .fgw-item input[type=checkbox] { width:17px; height:17px; margin-top:2px; accent-color:var(--accent); cursor:pointer; }
      .fgw-name { font-weight:650; font-size:13.5px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .fgw-badge { font-size:11px; font-weight:650; padding:2px 8px; border-radius:999px; color:var(--c); background:color-mix(in srgb,var(--c) 11%,#fff); }
      .fgw-yakin { font-size:11px; color:var(--muted); background:var(--soft); border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-weight:500; }
      .fgw-meta { color:var(--muted); margin-top:4px; line-height:1.5; }
      .fgw-route { display:inline-flex; align-items:center; gap:6px; margin-top:7px; background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:3px 8px; font-variant-numeric:tabular-nums; }
      .fgw-route .from { color:var(--muted); }
      .fgw-route .to { font-weight:700; color:var(--accent); }
      .fgw-reason { margin-top:7px; padding:6px 9px; border-radius:8px; color:var(--c); background:color-mix(in srgb,var(--c) 8%,#fff); line-height:1.45; }
      .fgw-links { margin-top:7px; display:flex; gap:6px; }
      .fgw-links a { font-size:11.5px; font-weight:600; color:var(--accent); text-decoration:none; border:1px solid var(--line); border-radius:7px; padding:2px 8px; background:#fff; }
      .fgw-links a:hover { border-color:var(--accent); }
      .fgw-empty { text-align:center; color:var(--muted); font-size:13px; padding:30px 0; }
      .fgw-launch { position:fixed; left:16px; bottom:64px; z-index:999999; display:flex; align-items:center; gap:8px; border:none; border-radius:999px; padding:10px 16px 10px 12px;
        background:linear-gradient(120deg,#0d9488,#0891b2); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer;
        box-shadow:0 10px 28px rgba(13,148,136,.4); transition:transform .15s; }
      .fgw-launch:hover { transform:translateY(-2px); }
      .fgw-launch b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 7px; font-size:11.5px; font-weight:800; }
      .fgw-bar { position:fixed; left:50%; bottom:16px; transform:translateX(-50%); z-index:1000002; width:min(720px,94vw); background:rgba(17,19,36,.93); backdrop-filter:blur(12px);
        color:#eef0ff; border-radius:18px; padding:14px 16px; box-shadow:0 20px 50px rgba(10,10,30,.45), inset 0 0 0 1px rgba(255,255,255,.07); font-size:13px; animation:fgw-up .25s ease; }
      .fgw-bar .top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .fgw-bar .dot { width:16px; height:16px; border-radius:50%; border:2.5px solid rgba(255,255,255,.2); border-top-color:#5eead4; flex:none; animation:fgw-spin .8s linear infinite; }
      .fgw-bar .dot.paused { animation:none; border-color:rgba(251,191,36,.3); border-top-color:#fbbf24; }
      .fgw-bar .t { font-weight:700; color:#fff; }
      .fgw-bar .m { color:#9aa0c3; font-size:12px; }
      .fgw-bar .notice { margin-top:10px; padding:8px 11px; border-radius:10px; background:rgba(251,191,36,.12); color:#fcd34d; font-size:12.5px; line-height:1.45; box-shadow:inset 0 0 0 1px rgba(251,191,36,.25); }
      .fgw-bar .doc { margin-top:10px; font-weight:650; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .fgw-bar .steps { display:flex; gap:4px; margin-top:10px; }
      .fgw-bar .st { flex:1; min-width:0; text-align:center; font-size:10.5px; padding:5px 2px; border-radius:8px; background:rgba(255,255,255,.06); color:#7d83a8;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transition:all .2s; }
      .fgw-bar .st.done { color:#86efac; background:rgba(34,197,94,.1); }
      .fgw-bar .st.now { color:#fff; background:linear-gradient(120deg,#0d9488,#0891b2); font-weight:650; box-shadow:0 4px 14px rgba(8,145,178,.35); }
      .fgw-bar .st.wait { color:#1f1300; background:#fbbf24; font-weight:650; animation:fgw-pulse 1.6s infinite; }
      .fgw-bar .log { margin-top:10px; color:#c7cbf0; font-size:11.5px; font-family:ui-monospace,Consolas,monospace; background:rgba(0,0,0,.28); border-radius:9px; padding:7px 10px; line-height:1.55; }
      .fgw-bar .log div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.65; }
      .fgw-bar .log div.last { opacity:1; color:#fde68a; }
      .fgw-bar .log .tm { color:#9aa0c3; }
      .fgw-bar .foot { display:flex; align-items:center; gap:6px; margin-top:11px; flex-wrap:wrap; }
      .fgw-bar .prog { flex:1; min-width:120px; height:5px; border-radius:99px; background:rgba(255,255,255,.1); overflow:hidden; display:flex; }
      .fgw-bar .prog i { display:block; height:100%; transition:width .4s; }
      .fgw-bar .chip { font-size:11px; font-weight:650; padding:2px 7px; border-radius:99px; background:rgba(255,255,255,.07); color:var(--c); }
      .fgw-bar .pct { font-size:12px; font-weight:700; color:#fff; min-width:34px; text-align:right; }
      .fgw-bar .fgw-btn { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.12); color:#eef0ff; padding:6px 11px; font-size:12.5px; }
      .fgw-bar .fgw-btn:hover { background:rgba(255,255,255,.16); }
      .fgw-bar .fgw-btn.go { background:#16a34a; border-color:#16a34a; }
      .fgw-bar .fgw-btn.stop { background:transparent; border-color:rgba(248,113,113,.45); color:#fca5a5; }
      @media (max-width:720px) { .fgw-grid2 { grid-template-columns:1fr; } .fgw-stats { grid-template-columns:repeat(3,1fr); } }
    `;
    document.head.appendChild(style);
  }

  const esc = (s) =>
    String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  // Label pendek untuk langkah di bar status
  const STEP_SHORT = {
    move: "Pindah wilayah",
    kel_open: "Buka keluarga",
    kel_fill: "Blok P + UMKM",
    kel_submit: "Kirim keluarga",
    kel_approve: "Approve kel.",
    oss_open: "Buka OSS",
    oss_fill: "Isi OSS",
    oss_submit: "Kirim OSS",
    oss_approve: "Approve OSS",
  };
  const DONE_STATUSES = ["linked", "closed", "manual"];

  let barSig = "";
  function updateBar() {
    const run = loadRun();
    let bar = document.getElementById("fgw-bar");
    if (!run.running) {
      if (bar) bar.remove();
      barSig = "";
      return;
    }
    if (!document.body) return;
    if (!bar) {
      ensureStyles();
      bar = document.createElement("div");
      bar.id = "fgw-bar";
      bar.className = "fgw fgw-bar";
      bar.addEventListener("click", (e) => {
        const act = e.target.closest("[data-bar]")?.dataset.bar;
        if (act === "stop") stopRun();
        if (act === "panel") openPanel();
        if (act === "send") userDecision = "send";
        if (act === "skip") userDecision = "skip";
        if (act === "go") {
          const r = loadRun();
          if (r.cur) r.cur.confirmed = r.cur.stage;
          r.paused = null;
          r.phaseAt = Date.now(); // waktu menunggu Anda tidak dihitung macet
          saveRun(r);
          updateBar();
        }
        if (act === "pass") {
          const r = loadRun();
          if (r.cur) finishItem(r.cur.id, "tested", "MODE UJI: tidak dikirim (dokumen masih terbuka/revoke, cek manual)");
          goList();
        }
      });
      document.body.appendChild(bar);
      barSig = "";
    }
    const c = counts();
    const rate = rateLimited()
      ? `⛔ Server membatasi (429) — lanjut sendiri ${new Date(rateInfo().until).toLocaleTimeString()}. Jangan refresh berulang-ulang.`
      : "";
    // Baris yang sedang dikerjakan & langkahnya
    const curId = (run.cur && run.cur.id) || (run.moving && run.moving.id);
    const it = curId ? loadQueue().find((q) => q.id === curId) : null;
    const stepNow = run.cur ? run.cur.stage : run.moving ? "move" : "";
    const iNow = STEPS.findIndex(([k]) => k === stepNow);
    const only = run.onlyIds ? new Set(run.onlyIds) : null;
    const scope = loadQueue().filter((q) => !only || only.has(q.id));
    const sisaPindah = scope.filter((q) => q.status === "pending").length;
    const sisaTaut = scope.filter((q) => q.status === "moved").length;
    const fase = run.recheckGanda
      ? `Cek ulang Ganda · sisa ${scope.filter(needsGandaCheck).length}`
      : run.forceRedo
        ? `Force submit ulang OSS · sisa ${scope.filter(needsForce).length}`
        : run.onlyLink || (!sisaPindah && run.doLink)
          ? `Fase 2/2 · Tautkan · sisa ${sisaTaut}`
          : `Fase 1/2 · Pindah wilayah · sisa ${sisaPindah}${run.doLink ? ` (lalu tautkan ${sisaTaut + sisaPindah})` : ""}`;
    const waiting = !!(run.paused || run.waiting);
    const steps = it
      ? `<div class="steps">${STEPS.filter(([k]) => (stepNow === "move" ? k === "move" : k !== "move"))
          .map(([k, label]) => {
            const i = STEPS.findIndex(([x]) => x === k);
            const cls = i < iNow ? "done" : i === iNow ? (waiting ? "wait" : "now") : "";
            return `<div class="st ${cls}" title="${esc(label)}">${i < iNow ? "✓ " : ""}${STEP_SHORT[k] || label}</div>`;
          })
          .join("")}</div>`
      : "";
    // Progres: selesai (tertaut/tutup/manual) + sudah dipindah (setengah jalan)
    const total = scope.length;
    const nDone = scope.filter((q) => DONE_STATUSES.includes(q.status)).length;
    const nMoved = scope.filter((q) => q.status === "moved").length;
    const pct = (n) => (total ? (100 * n) / total : 0);
    const logs = (run.logs || []).length ? run.logs : run.lastLog ? [run.lastLog] : [];
    const timer = run.cur && run.phaseAt ? `${Math.round((Date.now() - run.phaseAt) / 1000)} dtk` : "";
    // Digambar ulang hanya kalau isinya berubah (penghitung detik diperbarui di tempat) supaya tombol tidak berkedip
    const sig = JSON.stringify([run.cur && run.cur.stage, curId, run.paused, run.waiting, logs, rate, run.lastStep, fase, c, nDone, nMoved, T().name, run.testMode]);
    if (sig === barSig) {
      const tm = bar.querySelector("[data-timer]");
      if (tm) tm.textContent = timer;
      return;
    }
    barSig = sig;
    bar.innerHTML = `
      <div class="top">
        <span class="dot${waiting || rate ? " paused" : ""}"></span>
        <div class="t">OSS → Keluarga</div>
        <div class="m">${esc(fase)} · ${T().name}${run.testMode ? " · Mode uji" : ""}</div>
        <span style="flex:1"></span>
        ${run.paused ? `<button class="fgw-btn go" data-bar="go">✓ Kirim sekarang</button><button class="fgw-btn" data-bar="pass">Lewati</button>` : ""}
        ${run.waiting ? `<button class="fgw-btn go" data-bar="send">✓ Kirim sekarang</button><button class="fgw-btn" data-bar="skip">Lewati</button>` : ""}
        <button class="fgw-btn" data-bar="panel" title="Buka panel (Alt+8)">☰</button>
        <button class="fgw-btn stop" data-bar="stop">■ Stop</button>
      </div>
      ${rate ? `<div class="notice">${esc(rate)}</div>` : ""}
      ${it ? `<div class="doc">▶ ${esc(it.namaUsaha)} <span class="m">· ${esc(it.desa.name)} · SLS ${it.slsAsal} → ${it.slsTujuan}/${it.subslsTujuan}</span></div>` : ""}
      ${steps}
      <div class="log">
        ${logs.map((l, i) => `<div class="${i === logs.length - 1 ? "last" : ""}">${esc(l)}${i === logs.length - 1 && timer ? ` <span class="tm">(<span data-timer>${timer}</span>)</span>` : ""}</div>`).join("") || "<div>…</div>"}
        ${run.lastStep ? `<div class="tm">⏱ langkah sebelumnya — ${esc(run.lastStep)}</div>` : ""}
      </div>
      <div class="foot">
        <div class="prog"><i style="width:${pct(nDone)}%;background:linear-gradient(90deg,#34d399,#5eead4)"></i><i style="width:${pct(nMoved)}%;background:#a78bfa"></i></div>
        <span class="chip" style="--c:#86efac">✓ ${c.linked} tertaut</span>
        <span class="chip" style="--c:#5eead4">${c.closed} tutup${c.ganda ? ` (${c.ganda} ganda)` : ""}</span>
        <span class="chip" style="--c:#c4b5fd">${c.moved} dipindah</span>
        ${c.yellow ? `<span class="chip" style="--c:#fcd34d">${c.yellow} cek</span>` : ""}
        ${c.red ? `<span class="chip" style="--c:#fca5a5">${c.red} gagal</span>` : ""}
        <span class="pct">${Math.round(pct(nDone))}%</span>
      </div>`;
  }

  function counts() {
    const c = { pending: 0, moved: 0, linked: 0, closed: 0, tested: 0, red: 0, yellow: 0, manual: 0, ganda: 0 };
    loadQueue().forEach((q) => {
      c[q.status] = (c[q.status] || 0) + 1;
      if (q.linkResult === "ganda") c.ganda++; // sub-kategori closed: OSS Ganda (bukan status tersendiri)
    });
    return c;
  }

  function downloadReport() {
    const q = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
    const header = ["baris_excel", "assignment_id", "kel_assignment_id", "status", "alasan", "hasil_tautan", "usaha_keluarga", "force_submit", "jalan", "nomor", "no_bang", "latitude", "longitude", "waktu", "kecamatan", "desa", "sls_asal", "nama_usaha", "sls_tujuan", "subsls_tujuan", "sls_tujuan_nama", "kel_anggota", "yakin", "link_oss", "link_keluarga"];
    const lines = loadQueue().map((i) =>
      [i.row, i.id, i.kelId, STATUS_LABEL[i.status], i.reason, i.linkResult || "", i.linkCard || "", i.forced ? "ya" : "", (i.pdata || {}).jalan, (i.pdata || {}).nomor, (i.pdata || {}).noBang, (i.pdata || {}).lat, (i.pdata || {}).lng, i.doneAt || "", i.kec.name, i.desa.name, i.slsAsal, i.namaUsaha, i.slsTujuan, i.subslsTujuan, i.slsTujuanNama, i.kelAnggota, i.yakin, i.linkOss, i.linkKel]
        .map(q)
        .join(","),
    );
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `laporan-oss-keluarga-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`;
    a.click();
  }

  // Ekspor/impor ANTREAN APA ADANYA (semua field mentah, bukan laporan untuk dibaca orang) supaya
  // bisa lanjut kerja persis dari titik yang sama di laptop lain -- status, alasan, hasil tautan,
  // Blok P yang sudah disalin, dll ikut semua. Laporan CSV di atas cuma buat dibaca, bukan buat dimuat balik.
  function downloadQueueJson() {
    const blob = new Blob([JSON.stringify({ queue: loadQueue(), conf: loadConf(), exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `antrean-oss-keluarga-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`;
    a.click();
  }

  let panelFilter = "pending";
  let panelSearch = "";
  let lastPanelRefresh = 0;
  const selected = new Set();

  function openPanel() {
    const wasOpen = !!document.getElementById("fgw-panel"); // disegarkan ulang: tanpa animasi masuk
    document.getElementById("fgw-panel")?.remove();
    ensureStyles();
    const queue = loadQueue();
    const conf = loadConf();
    const c = counts();
    // "ganda" bukan status tersendiri (statusnya tetap "closed"), jadi filternya khusus baca linkResult
    const shown = queue
      .filter((q) => panelFilter === "all" || (panelFilter === "ganda" ? q.linkResult === "ganda" : q.status === panelFilter))
      .slice(0, 150);
    const stat = (key, label, color) =>
      `<button class="fgw-stat${panelFilter === key ? " active" : ""}" style="--c:${color}" data-act="filter" data-f="${key}"><div class="n">${key === "all" ? queue.length : c[key] || 0}</div><div class="l">${label}</div></button>`;
    const rows = shown
      .map((q) => {
        const isGanda = q.linkResult === "ganda";
        const color = isGanda ? STATUS_COLOR.ganda : STATUS_COLOR[q.status] || "#64748b";
        const label = isGanda ? "OSS Ganda" : STATUS_LABEL[q.status];
        return `<div class="fgw-item" style="--c:${color}" data-text="${esc(normalize(`${q.namaUsaha} ${q.desa.name} ${q.kec.name} ${q.id}`))}">
          <input type="checkbox" data-sel="${q.id}" ${selected.has(q.id) ? "checked" : ""}>
          <div style="min-width:0;">
            <div class="fgw-name">${esc(q.namaUsaha)} <span class="fgw-badge">${label}</span>${q.yakin ? `<span class="fgw-yakin">${esc(q.yakin)}</span>` : ""}</div>
            <div class="fgw-meta">📍 ${esc(q.kec.name)} › ${esc(q.desa.name)} · keluarga: ${esc(q.kelAnggota || "-")} · baris ${q.row}</div>
            <div class="fgw-route"><span class="from">SLS ${q.slsAsal}/${q.subslsAsal}</span>→<span class="to">${q.slsTujuan}/${q.subslsTujuan}</span>${q.slsTujuanNama ? `<span class="from">${esc(q.slsTujuanNama)}</span>` : ""}</div>
            ${q.reason ? `<div class="fgw-reason">${esc(q.reason)}</div>` : ""}
            <div class="fgw-links">${q.linkOss ? `<a href="${esc(q.linkOss)}" target="_blank">OSS ↗</a>` : ""}${q.linkKel ? `<a href="${esc(q.linkKel)}" target="_blank">Keluarga ↗</a>` : ""}</div>
          </div></div>`;
      })
      .join("");

    const total = queue.length;
    const pct = (n) => (total ? (100 * (n || 0)) / total : 0);
    const nDone = (c.linked || 0) + (c.closed || 0) + (c.manual || 0);
    const nIssue = (c.yellow || 0) + (c.red || 0);
    const progHtml = total
      ? `<div class="fgw-prog">
          <div class="track">
            <div class="seg" style="width:${pct(c.linked)}%;background:#86efac"></div>
            <div class="seg" style="width:${pct((c.closed || 0) + (c.manual || 0))}%;background:#5eead4"></div>
            <div class="seg" style="width:${pct(c.moved)}%;background:#c4b5fd"></div>
            <div class="seg" style="width:${pct(nIssue)}%;background:#fcd34d"></div>
          </div>
          <div class="lbl">
            <span><i style="--c:#86efac">${c.linked} tertaut</i><i style="--c:#5eead4">${(c.closed || 0) + (c.manual || 0)} tutup/manual</i><i style="--c:#c4b5fd">${c.moved} dipindah</i><i style="--c:#fcd34d">${nIssue} perlu cek</i></span>
            <b>${nDone} / ${total} selesai · ${Math.round(pct(nDone))}%</b>
          </div>
        </div>`
      : "";

    const overlay = document.createElement("div");
    overlay.id = "fgw-panel";
    overlay.className = `fgw fgw-overlay${wasOpen ? "" : " anim"}`;
    overlay.innerHTML = `<div class="fgw-sheet">
      <div class="fgw-head">
        <div class="fgw-head-row">
          <div class="fgw-logo">🔀</div>
          <div style="flex:1;min-width:180px;">
            <div class="fgw-title">OSS → Keluarga</div>
            <div class="fgw-subtitle">Pindah wilayah → tautkan UMKM → kirim & approve · ${total} baris antrean</div>
          </div>
          ${total ? `<button class="fgw-btn sm" data-act="report">⬇ Laporan CSV</button><button class="fgw-btn sm" data-act="export" title="Ekspor antrean apa adanya (semua status/progres) buat dilanjutkan di laptop lain">💾 Ekspor</button>` : ""}
          <button class="fgw-btn sm" data-act="import" title="Muat file Ekspor Antrean dari laptop lain, lanjutkan persis dari situ">📂 Impor</button>
          <button class="fgw-btn icon" data-act="close" title="Tutup">✕</button>
        </div>
        ${progHtml}
      </div>
      <div class="fgw-body">
        ${total ? `<div class="fgw-stats">${stat("pending", "Belum dipindah", STATUS_COLOR.pending)}${stat("moved", "Dipindah", STATUS_COLOR.moved)}${stat("linked", "Ditautkan", STATUS_COLOR.linked)}${stat("closed", "OSS tutup", STATUS_COLOR.closed)}${stat("ganda", "OSS Ganda", STATUS_COLOR.ganda)}${stat("yellow", "Perlu cek", STATUS_COLOR.yellow)}${stat("red", "Gagal", STATUS_COLOR.red)}${stat("manual", "Selesai manual", STATUS_COLOR.manual)}${stat("tested", "Uji", STATUS_COLOR.tested)}${stat("all", "Semua", "#0f172a")}</div>` : ""}

        <div class="fgw-card">
          <div class="fgw-sec">Persiapan</div>
          <div class="fgw-row">
            <button class="fgw-btn ${total ? "" : "primary"}" data-act="load">📥 Muat Excel target</button>
            <span class="fgw-hint">sheet "Pindah" · kolom proses = 1</span>
          </div>
          <div class="fgw-grid2" style="margin-top:14px;">
            <label class="fgw-field">Pengawas<input class="fgw-input" data-conf="pengawas" value="${esc(conf.pengawas)}"></label>
            <label class="fgw-field">Pencacah<input class="fgw-input" data-conf="pencacah" value="${esc(conf.pencacah)}"></label>
          </div>
          <div class="fgw-sub">Kecepatan</div>
          <div class="fgw-row">
            <div class="fgw-seg">${SPEEDS.map((sp, i) => `<label><input type="radio" name="fgw-speed" value="${i}" ${Number(conf.speed) === i ? "checked" : ""}><span>${sp.name}</span></label>`).join("")}</div>
            <span class="fgw-hint">turun sendiri kalau server membalas 429</span>
          </div>
          <div class="fgw-sub">Opsi</div>
          <label class="fgw-switch"><input type="checkbox" data-flag="doLink" ${conf.doLink ? "checked" : ""}><i></i><span>Setelah dipindah: tautkan & kirim<small>Buka keluarga, pilih UMKM, isi OSS (Ditemukan/Tutup/Ganda), kirim</small></span></label>
          <label class="fgw-switch"><input type="checkbox" data-flag="approve" ${conf.approve ? "checked" : ""}><i></i><span>Approve keluarga & OSS setelah kirim</span></label>
          <label class="fgw-switch"><input type="checkbox" data-strict ${conf.strictId ? "checked" : ""}><i></i><span>Wajib cocok assignment_id<small>Lebih aman, tapi bisa lebih banyak "perlu cek"</small></span></label>
          <details class="fgw-details">
            <summary>⚙ Lanjutan</summary>
            <label class="fgw-field">ID survei (awalan URL /app/assignment/…)<input class="fgw-input" data-conf="surveyPrefix" value="${esc(conf.surveyPrefix)}"></label>
          </details>
        </div>

        ${total ? `
        <div class="fgw-card run">
          <div class="fgw-sec">Jalankan</div>
          <div class="fgw-row">
            <button class="fgw-btn soft" data-act="test">🧪 Uji 1</button>
            <button class="fgw-btn" data-act="sel">▶ Yang dicentang <span class="n" data-selcount>${selected.size}</span></button>
            ${[5, 20].map((n) => `<button class="fgw-btn" data-act="run" data-n="${n}">▶ ${n}</button>`).join("")}
            <button class="fgw-btn primary" data-act="run" data-n="0">⚡ Semua <span class="n">${c.pending + (conf.doLink ? c.moved : 0)}</span></button>
          </div>
          <div class="fgw-hint" style="margin-top:8px;">Mulai dari halaman daftar assignment. Semua pindah wilayah dulu, baru ditautkan satu per satu: keluarga (revoke, pilih UMKM, kirim, approve) → OSS (isi, kirim, approve). Uji 1 berhenti sebelum tiap Kirim.</div>
          <div class="fgw-sub">Lanjutan & perbaikan</div>
          <div class="fgw-row">
            <button class="fgw-btn" data-act="link">🔗 Tautkan yang sudah dipindah <span class="n">${c.moved}</span></button>
            <button class="fgw-btn warn" data-act="force">⚡ Force submit ulang OSS ditemukan <span class="n">${queue.filter(needsForce).length}</span></button>
            <button class="fgw-btn warn" data-act="gandaCheck">🔎 Cek ulang Ganda dari OSS Tutup <span class="n">${queue.filter(needsGandaCheck).length}</span></button>
          </div>
          <details class="fgw-details">
            <summary>ⓘ Cara kerja "Cek ulang Ganda"</summary>
            <div class="fgw-hint">Mengecek ulang baris "OSS tutup" yang alasannya "tidak ada di pilihan UMKM" (kartu usaha tanpa isian Pilih UMKM, atau isiannya terkunci — dulu salah dibaca Tutup, seharusnya Ganda). Dibaca dulu dari halaman <b>Review keluarga tanpa revoke</b>: kalau tetap Tutup, baris tidak disentuh; kalau Ganda, cuma OSS-nya yang direvoke & diperbaiki; keluarga baru direvoke kalau ternyata ada kecocokan UMKM baru.</div>
          </details>
        </div>

        <div>
          <div class="fgw-row" style="margin-bottom:8px;">
            <input class="fgw-input" data-search placeholder="Cari nama / desa / id…" style="flex:1;min-width:200px;width:auto;" value="${esc(panelSearch)}">
            <button class="fgw-btn sm" data-act="selall">☑ Centang yang tampil (${shown.length})</button>
            <button class="fgw-btn sm ghost" data-act="selnone">Kosongkan</button>
          </div>
          <div class="fgw-row" style="margin-bottom:10px;">
            <button class="fgw-btn sm ok" data-act="markdone" title="Baris Gagal/Perlu cek yang sudah kamu perbaiki sendiri di FASIH">✓ Tandai selesai manual <span class="n" data-selcount2>${selected.size}</span></button>
            <button class="fgw-btn sm" data-act="reset">↻ Gagal/perlu cek → belum</button>
            <span style="flex:1"></span>
            <button class="fgw-btn sm ghost danger" data-act="clear">🗑 Hapus antrean</button>
          </div>
          <div class="fgw-list">${rows || '<div class="fgw-empty">Tidak ada baris di kategori ini.</div>'}</div>
          ${shown.length >= 150 ? '<div class="fgw-hint" style="text-align:center;margin-top:8px;">Menampilkan 150 baris pertama · lengkapnya di Laporan CSV</div>' : ""}
        </div>` : '<div class="fgw-empty">Belum ada antrean.<br>Mulai dengan <b>📥 Muat Excel target</b>.</div>'}
      </div>
      <input data-file type="file" accept=".xlsx" style="display:none">
      <input data-file-json type="file" accept=".json" style="display:none"></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("keydown", (e) => e.stopPropagation());
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelectorAll("[data-conf]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const cf = loadConf();
        cf[inp.dataset.conf] = inp.value.trim();
        saveConf(cf);
      }),
    );
    overlay.querySelectorAll('[name="fgw-speed"]').forEach(
      (r) =>
        (r.onchange = () => {
          const cf = loadConf();
          cf.speed = Number(r.value);
          saveConf(cf);
        }),
    );
    overlay.querySelectorAll("[data-flag]").forEach(
      (cb) =>
        (cb.onchange = () => {
          const cf = loadConf();
          cf[cb.dataset.flag] = cb.checked;
          saveConf(cf);
        }),
    );
    overlay.querySelector("[data-strict]").onchange = (e) => {
      const cf = loadConf();
      cf.strictId = e.target.checked;
      saveConf(cf);
    };
    const search = overlay.querySelector("[data-search]");
    const applySearch = () => {
      const t = normalize(search.value);
      overlay.querySelectorAll(".fgw-item").forEach((r) => (r.style.display = !t || r.dataset.text.includes(t) ? "" : "none"));
    };
    if (search) {
      search.oninput = () => {
        panelSearch = search.value;
        applySearch();
      };
      if (panelSearch) applySearch();
    }
    const updateSelCount = () => {
      overlay.querySelectorAll("[data-selcount], [data-selcount2]").forEach((l) => (l.textContent = selected.size));
    };
    overlay.addEventListener("change", (e) => {
      const box = e.target.closest("[data-sel]");
      if (!box) return;
      if (box.checked) selected.add(box.dataset.sel);
      else selected.delete(box.dataset.sel);
      updateSelCount();
    });

    const fileInput = overlay.querySelector("[data-file]");
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const old = new Map(loadQueue().map((q) => [q.id, q]));
        const { items, sheet, skipped } = await parseWorkbook(await file.arrayBuffer());
        let kept = 0;
        items.forEach((i) => {
          const o = old.get(i.id);
          if (o && o.status !== "pending") {
            Object.assign(i, { status: o.status, reason: o.reason, doneAt: o.doneAt, pdata: o.pdata, linkResult: o.linkResult, linkCard: o.linkCard });
            kept++;
          }
        });
        saveQueue(items);
        alert(`Sheet "${sheet}": ${items.length} baris dimuat, ${skipped} dilewati (proses ≠ 1).${kept ? `\nStatus lama dipertahankan untuk ${kept} baris.` : ""}`);
      } catch (err) {
        alert(`Gagal membaca Excel: ${err.message}`);
      }
      openPanel();
    };

    const fileInputJson = overlay.querySelector("[data-file-json]");
    fileInputJson.onchange = async () => {
      const file = fileInputJson.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const items = Array.isArray(data) ? data : data.queue; // dukung file lama yang cuma array
        if (!Array.isArray(items)) throw new Error("file bukan hasil Ekspor Antrean yang valid");
        const n = loadQueue().length;
        if (n && !confirm(`Antrean saat ini (${n} baris) akan diganti dengan isi file ini (${items.length} baris, diekspor ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "?"}). Lanjutkan?`))
          return;
        saveQueue(items);
        if (data.conf && confirm("File ini juga menyimpan pengaturan (Pengawas/Pencacah/dll). Pakai pengaturan itu juga?"))
          saveConf({ ...loadConf(), ...data.conf });
        alert(`Antrean dimuat: ${items.length} baris.`);
      } catch (err) {
        alert(`Gagal memuat file: ${err.message}`);
      }
      openPanel();
    };

    overlay.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "close") overlay.remove();
      if (act === "load") fileInput.click();
      if (act === "report") downloadReport();
      if (act === "export") downloadQueueJson();
      if (act === "import") fileInputJson.click();
      if (act === "filter") {
        panelFilter = el.dataset.f;
        openPanel();
      }
      if (act === "test") startRun({ limit: 1, testMode: true });
      if (act === "force") {
        const n = loadQueue().filter(needsForce).length;
        if (!n) return alert("Tidak ada OSS tertaut (Ditemukan) yang perlu di-force submit ulang.");
        if (confirm(`Force submit ulang ${n} OSS Ditemukan (tertaut) (revoke → Submit Paksa${loadConf().approve ? " → approve" : ""}) TANPA berhenti?`))
          startRun({ forceRedo: true });
      }
      if (act === "gandaCheck") {
        const n = loadQueue().filter(needsGandaCheck).length;
        if (!n) return alert('Tidak ada OSS Tutup berstatus "tidak ada di pilihan UMKM" yang perlu dicek ulang.');
        if (confirm(`Cek ulang ${n} OSS Tutup lewat halaman Review keluarga dulu (TANPA revoke). Keluarga/OSS cuma direvoke & dikirim ulang${loadConf().approve ? " (+ approve)" : ""} kalau memang ada yang perlu diperbaiki (jadi Ganda atau ternyata Ditemukan). TANPA berhenti, lanjutkan?`))
          startRun({ recheckGanda: true });
      }
      if (act === "link") {
        if (!counts().moved) return alert("Tidak ada baris berstatus dipindah.");
        if (confirm(`Tautkan ${counts().moved} OSS yang sudah dipindah (revoke keluarga & OSS, kirim${loadConf().approve ? ", approve" : ""}) TANPA berhenti?`))
          startRun({ onlyLink: true });
      }
      if (act === "run") {
        const n = Number(el.dataset.n);
        if (confirm(`Pindahkan ${n || "SEMUA (" + counts().pending + ")"} assignment OSS ke SLS keluarga TANPA berhenti?\nPengawas: ${loadConf().pengawas}\nPencacah: ${loadConf().pencacah}`))
          startRun({ limit: n });
      }
      if (act === "selall") {
        overlay.querySelectorAll(".fgw-item").forEach((row) => {
          if (row.style.display === "none") return; // hormati pencarian yang sedang aktif juga
          const cb = row.querySelector("[data-sel]");
          if (!cb) return;
          selected.add(cb.dataset.sel);
          cb.checked = true;
        });
        updateSelCount();
      }
      if (act === "selnone") {
        selected.clear();
        overlay.querySelectorAll("[data-sel]").forEach((cb) => (cb.checked = false));
        updateSelCount();
      }
      if (act === "markdone") {
        const ids = loadQueue().filter((q) => selected.has(q.id)).map((q) => q.id);
        if (!ids.length) return alert("Belum ada baris yang dicentang.");
        if (confirm(`Tandai ${ids.length} baris yang dicentang sebagai "selesai (dicek manual)"? Baris ini tidak akan diproses otomatis lagi.`)) {
          const q = loadQueue();
          q.filter((i) => ids.includes(i.id)).forEach((i) => {
            const prevLabel = STATUS_LABEL[i.status] || i.status;
            i.status = "manual";
            i.reason = `ditandai selesai manual oleh pengguna (sebelumnya: ${prevLabel})`;
            i.doneAt = new Date().toISOString();
          });
          saveQueue(q);
          selected.clear();
          openPanel();
        }
      }
      if (act === "sel") {
        const ids = loadQueue().filter((q) => selected.has(q.id) && !["linked", "closed"].includes(q.status)).map((q) => q.id);
        if (!ids.length) return alert("Belum ada baris (belum dipindah) yang dicentang.");
        const q = loadQueue();
        q.filter((i) => ids.includes(i.id) && i.status !== "moved").forEach((i) => (i.status = "pending"));
        saveQueue(q);
        if (confirm(`Kerjakan ${ids.length} baris yang dicentang tanpa berhenti?`)) startRun({ onlyIds: ids });
      }
      if (act === "reset") {
        const q = loadQueue();
        q.filter((i) => ["red", "yellow", "tested"].includes(i.status)).forEach((i) => {
          i.status = "pending";
          i.reason = "";
        });
        saveQueue(q);
        openPanel();
      }
      if (act === "clear" && confirm("Hapus seluruh antrean Ganti Wilayah?")) {
        saveQueue([]);
        openPanel();
      }
    });
  }

  function ensureLauncher() {
    if (!document.body || document.getElementById("fgw-launch") || /\/app\/assignment\//.test(location.pathname)) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "fgw-launch";
    btn.className = "fgw-launch";
    const left = loadQueue().filter((q) => q.status === "pending" || q.status === "moved").length;
    btn.innerHTML = `🔀 OSS → Keluarga${left ? ` <b>${left}</b>` : ""}`;
    btn.title = "Buka panel (Alt+8)";
    btn.onclick = openPanel;
    document.body.appendChild(btn);
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "8") {
      e.preventDefault();
      openPanel();
    }
  });

  // Panel detail (Alt+8) dulu cuma gambar sekali saat dibuka: status/jumlah di dalamnya
  // tidak ikut berubah walau antrean di localStorage terus diperbarui oleh tick(). Disegarkan
  // berkala di sini supaya tetap hidup selama dibiarkan terbuka saat proses berjalan.
  function refreshPanelLive() {
    const overlay = document.getElementById("fgw-panel");
    if (!overlay) return;
    const now = Date.now();
    if (now - lastPanelRefresh < 1500) return;
    const active = document.activeElement;
    if (active && overlay.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;
    lastPanelRefresh = now;
    const body = overlay.querySelector(".fgw-body");
    const scrollTop = body ? body.scrollTop : 0;
    openPanel();
    const newBody = document.querySelector("#fgw-panel .fgw-body");
    if (newBody) newBody.scrollTop = scrollTop;
  }

  // Halaman dimuat ulang saat berjalan -> lanjutkan (tanpa mode tunggu uji)
  setInterval(() => {
    ensureLauncher();
    const run = loadRun();
    if (run.running && !busy) {
      if (run.waiting) {
        run.waiting = false;
        saveRun(run);
      }
      tick();
    }
    if (run.running) updateBar();
    refreshPanelLive();
  }, 700);

  console.log("[OSS → Keluarga v2.21] Aktif. Tombol di kiri bawah (Alt+8).");
})();
