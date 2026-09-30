// ==UserScript==
// @name         FASIH OSS -> Keluarga: Pindah + Tautkan
// @namespace    hanif-bps-hst
// @version      2.3
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
    {
      name: "Turbo",
      gap: [0, 150],
      settle: 300,
      after: 100,
      optStep: 80,
      afterPick: 150,
      dlg: 300,
      submit: 250,
      poll: 60,
    },
    {
      name: "Kilat",
      gap: [300, 800],
      settle: 500,
      after: 200,
      optStep: 120,
      afterPick: 250,
      dlg: 500,
      submit: 500,
      poll: 100,
    },
    {
      name: "Cepat",
      gap: [1000, 2500],
      settle: 800,
      after: 400,
      optStep: 200,
      afterPick: 400,
      dlg: 800,
      submit: 800,
      poll: 150,
    },
    {
      name: "Normal",
      gap: [4000, 9000],
      settle: 1500,
      after: 1500,
      optStep: 300,
      afterPick: 700,
      dlg: 1200,
      submit: 1500,
      poll: 250,
    },
  ];
  const T = () =>
    SPEEDS[
      Math.min(SPEEDS.length - 1, Math.max(0, Number(loadConf().speed) || 0))
    ];

  const STATUS_LABEL = {
    pending: "belum dipindah",
    moved: "dipindah, belum ditautkan",
    linked: "selesai: ditautkan",
    closed: "selesai: OSS tutup",
    tested: "terisi (uji)",
    red: "gagal",
    yellow: "perlu cek",
  };
  const STATUS_COLOR = {
    pending: "#2563eb",
    moved: "#7c3aed",
    linked: "#15803d",
    closed: "#0f766e",
    tested: "#0891b2",
    red: "#dc2626",
    yellow: "#b45309",
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
    console.warn(
      `[Ganti Wilayah] 429 dari server. Berhenti ${minutes} menit, kecepatan turun ke ${SPEEDS[cf.speed].name}.`,
    );
  }
  (function watch429() {
    const origFetch = window.fetch;
    if (origFetch && !origFetch.__fgw429) {
      const wrapped = function (input) {
        return origFetch.apply(this, arguments).then((res) => {
          if (res && res.status === 429)
            noteRateLimit(
              typeof input === "string" ? input : input && input.url,
            );
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

  // Hasil: [{ name, rows: [[teks sel, ...], ...] }] ; semua nilai sebagai teks (kode "0005" tetap utuh)
  async function readXlsx(arrayBuffer) {
    const read = await openZip(arrayBuffer);
    const xml = (text) =>
      new DOMParser().parseFromString(text, "application/xml");
    const tags = (node, tag) =>
      Array.from(node.getElementsByTagNameNS("*", tag));
    const sharedXml = await read("xl/sharedStrings.xml");
    const shared = sharedXml
      ? tags(xml(sharedXml), "si").map((si) =>
          tags(si, "t")
            .map((t) => t.textContent)
            .join(""),
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
            value = tags(c, "t")
              .map((t) => t.textContent)
              .join("");
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
  const pad = (v, n) =>
    String(v || "").trim() ? String(v).trim().padStart(n, "0") : "";

  async function parseWorkbook(arrayBuffer) {
    const sheets = await readXlsx(arrayBuffer);
    const sheet = sheets.find((s) => /^pindah$/i.test(s.name)) || sheets[0];
    const headers = sheet.rows[0].map((h) => String(h).trim().toLowerCase());
    const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
    if (missing.length)
      throw new Error(
        `kolom tidak ada di sheet "${sheet.name}": ${missing.join(", ")}`,
      );
    const col = (name) => headers.indexOf(name);
    const items = [];
    let skipped = 0;
    sheet.rows.slice(1).forEach((r, i) => {
      const get = (name) =>
        col(name) >= 0 ? String(r[col(name)] || "").trim() : "";
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
        kelId: (
          get("kel_assignment_id") ||
          (get("link_keluarga").match(/([0-9a-f-]{36})/i) || [])[1] ||
          ""
        ).toLowerCase(),
        // status_awal "dipindah" (dari laporan sebelumnya) -> langsung ke tahap tautkan
        status: /^dipindah$/i.test(get("status_awal")) ? "moved" : "pending",
        reason: /^dipindah$/i.test(get("status_awal"))
          ? `dipindah (laporan sebelumnya)`
          : "",
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
      document.querySelectorAll(
        '[class*="animate-spin"], [class*="skeleton"], [aria-busy="true"]',
      ),
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
    return Array.from(
      document.querySelectorAll('button[aria-haspopup="dialog"]'),
    ).find((b) => b.querySelector(".tabler-icon-filter") && !b.closest("th"));
  }

  const gantiDialog = () =>
    Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (d) =>
        visible(d) &&
        /ganti wilayah/i.test((d.querySelector("h2") || {}).innerText || ""),
    ) || null;

  // Combobox berlabel (scope: dialog Ganti Wilayah, atau halaman kecuali dialog itu)
  // Label dicocokkan tanpa spasi/tanda baca ("SUBSLS" = "SUB SLS" = "Sub-SLS")
  const squash = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  function fieldButton(label, scope) {
    const dlg = gantiDialog();
    const lab = Array.from((scope || document).querySelectorAll("label")).find(
      (l) =>
        squash(l.innerText) === squash(label) &&
        (scope || !dlg || !dlg.contains(l)),
    );
    return lab
      ? lab.parentElement.querySelector('button[role="combobox"]')
      : null;
  }

  const OPTION_SELECTOR = '[cmdk-item], [role="option"]';
  const visibleOptions = () =>
    Array.from(document.querySelectorAll(OPTION_SELECTOR)).filter(
      (el) =>
        visible(el) &&
        !el.closest("#fgw-panel, #fgw-bar") &&
        el.innerText.trim(),
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
    const find = () =>
      visibleOptions().find((el) => parseOption(optionText(el)).code === code);
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
    if (fieldButton("KECAMATAN") && filterButton())
      triggerClick(filterButton());
    await sleep(300);
  }

  let appliedFilterKey = null;
  async function applyFilter(item, sls = item.slsAsal) {
    const key = `${item.kec.code}|${item.desa.code}|${sls}`;
    if (appliedFilterKey === key) return;
    const before = tableText();
    await openFilterPanel();
    await pickByCode(
      () => fieldButton("KECAMATAN"),
      item.kec.code,
      "Filter KECAMATAN",
    );
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
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
        }),
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
    const kodeBtn = tr.querySelector(
      "td button:not([title]):not([aria-haspopup])",
    );
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
      Array.from(tr.querySelectorAll("td")).some(
        (td) => normalize(td.innerText) === want,
      ),
    );
    const loose = rows.filter((tr) => normalize(tr.innerText).includes(want));
    const candidates = exact.length ? exact : loose;
    // Jalur cepat: id langsung terbaca di HTML baris, atau (tidak wajib id) cuma 1 nama persis -> tanpa klik kode
    const direct = candidates.find((tr) =>
      tr.innerHTML.toLowerCase().includes(item.id),
    );
    if (direct) return { tr: direct, note: "cocok assignment_id" };
    if (!loadConf().strictId && exact.length === 1)
      return { tr: exact[0], note: "1 nama persis di SLS asal" };
    for (const tr of candidates.slice(0, 6)) {
      if (await rowHasId(tr, item.id))
        return { tr, note: "cocok assignment_id" };
    }
    if (!loadConf().strictId && exact.length === 1)
      return {
        tr: exact[0],
        note: "1 nama persis di SLS asal (id tidak terbaca di tabel)",
      };
    if (!candidates.length)
      throw Object.assign(
        new Error(
          `"${item.namaUsaha}" tidak ada di SLS ${item.slsAsal} (mungkin sudah dipindah)`,
        ),
        { soft: true },
      );
    throw Object.assign(
      new Error(
        `${candidates.length} baris bernama "${item.namaUsaha}", assignment_id tidak bisa dipastikan`,
      ),
      { soft: true },
    );
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
      visibleOptions().find((el) =>
        optionText(el).toLowerCase().includes(email.toLowerCase()),
      );
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
      throw new Error(
        `${label} ${email} tidak ada di pilihan (belum punya akses ke SLS tujuan?)`,
      );
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
        throw new Error(
          `isian SUBSLS tidak muncul, padahal tujuan SubSLS ${code}`,
        );
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
    const want = [
      item.kec.code,
      item.desa.code,
      item.slsTujuan,
      item.subslsTujuan,
    ];
    if (got.join("|") !== want.join("|"))
      throw new Error(
        `isian wilayah tidak sesuai: ${got.join("/")} ≠ ${want.join("/")}`,
      );
  }

  async function submitGantiWilayah() {
    const d = gantiDialog();
    const btn =
      d &&
      Array.from(d.querySelectorAll('button[type="submit"]')).find((b) =>
        /ubah wilayah/i.test(b.innerText),
      );
    if (!btn || btn.disabled)
      throw new Error('tombol "Ubah Wilayah Assignment" tidak aktif');
    triggerClick(btn);
    const closed = await waitFor(() => !gantiDialog(), 20000);
    if (!closed) {
      const dlgNow = gantiDialog();
      const msg = ((dlgNow ? dlgNow.innerText : "").match(
        /.*(gagal|error|tidak|wajib).*/i,
      ) || [""])[0];
      throw new Error(
        `dialog tidak tertutup setelah kirim${msg ? `: ${msg.slice(0, 120)}` : ""}`,
      );
    }
    await sleep(T().submit);
  }

  function closeGantiDialog() {
    const d = gantiDialog();
    if (!d) return;
    const x = Array.from(d.querySelectorAll("button")).find((b) =>
      /close/i.test(b.innerText),
    );
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
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
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
    return (
      normName(name) === normName(namaUsaha) ||
      nameSimilarity(name, namaUsaha) >= 0.9
    );
  }

  function box(id, inst) {
    return document.getElementById(inst === undefined ? id : `${id}#${inst}`);
  }
  async function waitBox(id, inst, ms) {
    return waitFor(
      () => {
        const b = box(id, inst);
        return visible(b) ? b : null;
      },
      ms === undefined ? FIELD_WAIT_MS : ms,
    );
  }
  const fresh = (el) => (el.id && document.getElementById(el.id)) || el;

  function radioValue(container) {
    const checked = container.querySelector(
      'input[type="radio"]:checked, input[type="radio"][data-checked]',
    );
    return checked ? checked.value : "";
  }

  async function setRadio(container, value) {
    const input = container.querySelector(
      `input[type="radio"][value="${value}"]`,
    );
    if (!input) return false;
    if (radioValue(container) === value) return true;
    if (input.disabled) return false;
    const group = input.closest('[role="group"]') || input.parentElement;
    triggerClick((group && group.querySelector('[role="radio"]')) || input);
    return !!(await waitFor(
      () => radioValue(fresh(container)) === value,
      3000,
    ));
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
    const input = container.querySelector(
      'input[type="text"]:not([disabled]), input:not([type]):not([disabled]), textarea:not([disabled])',
    );
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
      (b) =>
        visible(b) &&
        !b.disabled &&
        re.test(b.innerText) &&
        !b.closest("#fgw-panel, #fgw-bar"),
    );
  }
  function buttonByIcon(icon) {
    const svg = Array.from(
      document.querySelectorAll(`svg.tabler-icon-${icon}`),
    ).find((s) => s.closest("button") && visible(s.closest("button")));
    return svg ? svg.closest("button") : null;
  }

  const formOptions = () =>
    Array.from(document.querySelectorAll(FORM_OPTION_SELECTOR)).filter(
      (el) =>
        visible(el) &&
        !el.closest("#fgw-panel, #fgw-bar") &&
        el.innerText.trim(),
    );
  function dropdownValue(container) {
    const el = container.querySelector('textarea, input[type="text"]');
    return el ? el.value.trim() : "";
  }
  // Dropdown pencarian di form. pick(options) -> elemen opsi yang dipilih
  async function chooseFromDropdown(container, searchText, pick) {
    const textarea = container.querySelector('textarea, input[type="text"]');
    const toggle = container.querySelector('button[aria-haspopup="dialog"]');
    triggerClick(toggle || textarea);
    await sleep(400);
    if (searchText) {
      const search =
        document.querySelector(
          '[role="dialog"] input:not([type="radio"]):not([type="checkbox"])',
        ) || textarea;
      if (search) setFieldValue(search, searchText);
    }
    const target = await waitFor(() => pick(formOptions()), 6000);
    if (!target) {
      pressKey("Escape");
      await sleep(300);
      return false;
    }
    triggerClick(target);
    await sleep(600);
    return true;
  }

  // ---------- Navigasi form ----------
  const squashT = (s) =>
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
    if (!(await waitFor(readyCheck, 20000)))
      throw new Error(`halaman "${title}" tidak terbuka`);
    await sleep(800);
    return true;
  }

  // Buka halaman sidebar yang memuat isian tertentu (dicoba satu per satu; hasilnya diingat)
  const SECTION_CACHE_KEY = "fgw_section_cache";
  async function goToField(key, check) {
    if (check()) return true;
    const cache = loadJson(SECTION_CACHE_KEY, {});
    await waitFor(() => sidebarItems().length, 30000);
    const titles = Array.from(
      new Set(
        sidebarItems()
          .map((el) => el.getAttribute("title"))
          .filter(Boolean),
      ),
    );
    const order = cache[key]
      ? [cache[key], ...titles.filter((t) => t !== cache[key])]
      : titles;
    for (const title of order) {
      const el = sidebarItem(title);
      if (!el) continue;
      triggerClick(el);
      if (await waitFor(check, 2500)) {
        cache[key] = title;
        saveJson(SECTION_CACHE_KEY, cache);
        await sleep(600);
        return true;
      }
    }
    throw new Error(`isian ${key} tidak ditemukan di halaman mana pun`);
  }

  const onBlokII = () =>
    visible(box("se2026_nested")) &&
    !document.querySelector('[id^="keberadaan_usaha#"]');
  function usahaCards() {
    const list = box("se2026_nested");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-nested-view]")).map(
      (card) => {
        const span = card.querySelector("span");
        return {
          card,
          name: (span ? span.innerText : card.innerText).trim().toUpperCase(),
        };
      },
    );
  }
  async function openUsahaPage(card) {
    triggerClick(card.card);
    const kb = await waitFor(() => {
      const el = document.querySelector('[id^="keberadaan_usaha#"]');
      return visible(el) ? el : null;
    }, 20000);
    if (!kb) throw new Error(`rincian usaha "${card.name}" tidak terbuka`);
    await sleep(800);
    return kb.id.split("#")[1];
  }

  // ---------- Review -> Edit (revoke bila perlu) ----------
  async function reviewToEdit() {
    await waitFor(
      () => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"),
      20000,
    );
    await sleep(600);
    let revoked = false;
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      const revoke = buttonByIcon("rotate-clockwise");
      if (!revoke || revoke.disabled)
        throw new Error("tombol Edit & Revoke tidak aktif");
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
      await sleep(600);
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
    await sleep(1500);
    return revoked;
  }

  // ---------- Kirim + Approve ----------
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
      return (
        !!s &&
        (s.checked ||
          s.getAttribute("aria-checked") === "true" ||
          (c && c.hasAttribute("data-checked")))
      );
    };
    for (const attempt of [
      () => triggerClick(control() || findAnomaliSwitch()),
      () => findAnomaliSwitch().click(),
    ]) {
      if (isOn()) break;
      attempt();
      await waitFor(isOn, 2500);
    }
    if (isOn()) await sleep(1200);
    runLog(`CATATAN: anomali ${isOn() ? "aktif" : "GAGAL diaktifkan"}`);
  }

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
        !b.closest("#fgw-panel, #fgw-bar"),
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
      (b) =>
        visible(b) &&
        !b.disabled &&
        isKirimText(b) &&
        !b.closest("#fgw-panel, #fgw-bar"),
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
    if (Array.from(document.querySelectorAll('[role="dialog"]')).some(visible))
      pressKey("Escape");
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
      await sleep(400);
      triggerClick(sign);
      if (!(await waitFor(leftEdit, 15000))) {
        sign.click();
        await waitFor(leftEdit, 15000);
      }
    }
    await sleep(1200);
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
    await waitFor(
      () =>
        summaryCount("GALAT") || findDialogKirim() || readGalatList().length,
      15000,
    );
    await sleep(1200);
    const galat = summaryCount("GALAT");
    const list = readGalatList();
    if ((galat && galat.n > 0) || (list.length && !galat)) {
      if (galat && galat.btn && !list.length) {
        triggerClick(galat.btn);
        await waitFor(() => readGalatList().length, 6000);
      }
      const detail = readGalatList().join("; ");
      closeDialogs();
      throw new Error(
        `galat ${galat ? galat.n : list.length}: ${detail || "lihat di FASIH"}`,
      );
    }
    const dialogKirim = findDialogKirim();
    if (!dialogKirim)
      throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    const r = loadRun();
    r.cur.submitClicked = true;
    saveRun(r);
    triggerClick(dialogKirim);
    const konfirmasi = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konfirmasi)
      throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
    await sleep(400);
    triggerClick(konfirmasi);
    await backToReview(60000);
  }

  async function approveDocument() {
    const findCheck = () => {
      const buttons = Array.from(
        document.querySelectorAll("svg.tabler-icon-check"),
      )
        .map((s) => s.closest("button"))
        .filter((b) => b && visible(b) && !b.disabled);
      return (
        buttons.find((b) => /bg-success/.test(b.className)) ||
        buttons[0] ||
        null
      );
    };
    const check = await waitFor(findCheck, 25000);
    if (!check)
      throw new Error("terkirim, tapi tombol Approve (✔) tidak aktif");
    await sleep(600);
    triggerClick(check);
    const ok = await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter(
        (b) =>
          visible(b) &&
          !b.disabled &&
          b.innerText.trim().toUpperCase() === "KONFIRMASI",
      );
      return (
        buttons.find((b) => /bg-success/.test(b.className)) ||
        buttons[0] ||
        null
      );
    }, 10000);
    if (!ok) throw new Error("terkirim, tapi konfirmasi approve tidak muncul");
    await sleep(400);
    triggerClick(ok);
    await sleep(2500);
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
      const val = s.nextElementSibling
        ? s.nextElementSibling.innerText.trim()
        : "";
      if (label === "LATITUDE") out.lat = val;
      if (label === "LONGITUDE") out.lng = val;
    });
    return out;
  }

  async function readFamilyP() {
    await goToField("jalan_domisili", () => visible(box("jalan_domisili")));
    await sleep(500);
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
    const pop =
      toggle &&
      toggle.getAttribute("aria-controls") &&
      document.getElementById(toggle.getAttribute("aria-controls"));
    const scoped = pop
      ? Array.from(
          pop.querySelectorAll(
            '[role="option"], [cmdk-item], li, button, [data-value]',
          ),
        ).filter(
          (el) =>
            visible(el) &&
            el.innerText.trim() &&
            !el.querySelector('[role="option"], li, button'),
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
    let target = await waitFor(
      () =>
        umkmOptions(fresh(umkm)).find((o) =>
          umkmMatches(o.innerText, namaUsaha),
        ),
      5000,
    );
    if (!target) {
      // Daftar belum terbuka: buka lewat tombol panah (teks pencarian tetap)
      const toggle = fresh(umkm).querySelector(
        'button[aria-haspopup="dialog"]',
      );
      if (toggle && toggle.getAttribute("aria-expanded") !== "true")
        triggerClick(toggle);
      target = await waitFor(
        () =>
          umkmOptions(fresh(umkm)).find((o) =>
            umkmMatches(o.innerText, namaUsaha),
          ),
        4000,
      );
    }
    if (!target) {
      pressKey("Escape");
      if (ta() && ta().value.trim() === query) setFieldValue(ta(), ""); // hapus sisa teks pencarian
      await sleep(300);
      return false;
    }
    triggerClick(target);
    return !!(await waitFor(
      () => umkmMatches(dropdownValue(fresh(umkm)), namaUsaha),
      4000,
    ));
  }

  // Tautkan OSS ke SATU usaha keluarga yang punya isian "Pilih UMKM dalam satu SLS".
  // Hasil: { result: 'found' | 'nousaha' | 'nomatch', changed, card }
  async function linkUmkm(item) {
    await goSection("SE2026 - L BLOK II", onBlokII, true);
    const total = usahaCards().length;
    if (!total) return { result: "nousaha", changed: false };

    // 1) Baca isian UMKM tiap kartu; kalau OSS ini sudah tertaut di salah satunya, selesai
    const slots = [];
    for (let idx = 0; idx < total; idx++) {
      if (idx > 0) await goSection("SE2026 - L BLOK II", onBlokII, true);
      const card = usahaCards()[idx];
      if (!card) continue;
      const inst = await openUsahaPage(card);
      const umkm = await waitBox("pilih_umkm_sls", inst, 3000);
      if (!umkm) continue;
      const now = dropdownValue(umkm);
      if (now && umkmMatches(now, item.namaUsaha))
        return { result: "found", changed: false, card: card.name };
      slots.push({
        idx,
        name: card.name,
        empty: !now || /TIDAK ADA/i.test(now),
      });
    }
    if (!slots.length)
      return {
        result: "nomatch",
        changed: false,
        note: "tidak ada usaha dengan isian Pilih UMKM",
      };

    // 2) Pilih satu kartu (yang masih kosong didahulukan), cari nama OSS, pilih
    const words = normalize(item.namaUsaha).split(" ");
    const queries = Array.from(
      new Set([
        item.namaUsaha.trim(),
        words.slice(0, 2).join(" "),
        words.sort((a, b) => b.length - a.length)[0],
      ]),
    );
    const order = slots
      .filter((s) => s.empty)
      .concat(slots.filter((s) => !s.empty));
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
    const btn = Array.from(g.querySelectorAll("button")).find((b) =>
      /AMBIL LOKASI|PERBARUI LOKASI/i.test(b.innerText),
    );
    if (!btn) throw new Error('tombol "Ambil Lokasi" tidak ada');
    triggerClick(btn);
    const peta = await waitFor(() => buttonMatching(/PILIH DI PETA/i), 8000);
    if (!peta) throw new Error('pilihan "Pilih di peta" tidak muncul');
    triggerClick(peta);
    const latIn = await waitFor(
      () => document.getElementById("map-latitude"),
      8000,
    );
    const lngIn = document.getElementById("map-longitude");
    if (!latIn || !lngIn)
      throw new Error("kotak latitude/longitude tidak muncul");
    for (const [el, v] of [
      [latIn, lat],
      [lngIn, lng],
    ]) {
      setInputValue(el, v);
      el.focus();
      ["keydown", "keypress", "keyup"].forEach((type) =>
        el.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          }),
        ),
      );
      await sleep(400);
    }
    const use = await waitFor(() => buttonMatching(/GUNAKAN LOKASI/i), 8000);
    if (!use) throw new Error('tombol "Gunakan Lokasi" tidak aktif');
    triggerClick(use);
    const ya = await waitFor(() => buttonByText("Ya"), 6000);
    if (ya) triggerClick(ya);
    if (!(await waitFor(() => readGeotag(box("geotag")).lat, 8000)))
      throw new Error("koordinat tidak tersimpan di Geotagging");
    await sleep(500);
  }

  // Keberadaan Bangunan/Usaha (Blok P) -> Keberadaan Usaha (Blok II) harus sama statusnya
  const KEBERADAAN = {
    0: { label: "Tidak Ditemukan", blok2: ["00", "0"] },
    1: { label: "Ditemukan", blok2: ["1"] },
    3: { label: "Tutup", blok2: ["3"] },
    4: { label: "Ganda", blok2: ["4"] },
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
    await sleep(500);
    const kb = kbVisible();
    // Pilihan di Blok II menyesuaikan Blok P (mis. hanya "3. Tutup"); pakai nilai yang tersedia
    const value = want.blok2.find(
      (v) => kb && kb.querySelector(`input[type="radio"][value="${v}"]`),
    );
    if (
      !value ||
      (await fillField("", undefined, value, { container: kb })) !== "ok"
    )
      throw new Error(
        `Keberadaan Usaha (Blok II) tidak bisa diisi ${want.label}`,
      );
    if (radioValue(fresh(kb)) !== value)
      throw new Error(
        `Keberadaan Usaha (Blok II) = ${radioValue(fresh(kb)) || "kosong"}, seharusnya ${want.label}`,
      );
    runLog(`Blok II: Keberadaan Usaha = ${want.label}`);
    await sleep(600);
  }

  async function fillOss(item) {
    await goToField("ada_bang_usaha", () => visible(box("ada_bang_usaha")));
    if (item.linkResult !== "found") {
      if ((await fillField("ada_bang_usaha", undefined, "3")) !== "ok")
        throw new Error("Keberadaan Bangunan/Usaha tidak bisa diisi Tutup");
      await sleep(800);
      await setBlok2Keberadaan("3");
      return;
    }
    if ((await fillField("ada_bang_usaha", undefined, "1")) !== "ok")
      throw new Error("Keberadaan Bangunan/Usaha tidak bisa diisi Ditemukan");
    await sleep(800);
    if (
      (await fillField("kode_bang", undefined, "1", { wait: 4000 })) === "fail"
    )
      throw new Error("Kode Penggunaan Bangunan tidak bisa diisi 1");
    const p = item.pdata || {};
    if (p.jalan)
      await fillField("jalan_domisili", undefined, p.jalan, { wait: 1500 });
    await fillField("nomor_domisili", undefined, p.nomor || "-", {
      wait: 1500,
    });
    if (p.noBang)
      await fillField("no_bang", undefined, p.noBang, { wait: 1500 });
    if (p.lat && p.lng) await setGeotag(p.lat, p.lng);
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
    kel_open: "Membuka keluarga",
    kel_fill: "Cek usaha keluarga",
    kel_submit: "Kirim keluarga",
    kel_approve: "Approve keluarga",
    oss_open: "Membuka OSS",
    oss_fill: "Mengisi OSS",
    oss_submit: "Kirim OSS",
    oss_approve: "Approve OSS",
  };

  function runLog(msg) {
    console.log(`[OSS→Keluarga] ${msg}`);
    const r = loadRun();
    r.lastLog = msg;
    saveRun(r);
    updateBar();
  }
  function setStage(stage, extra) {
    const r = loadRun();
    r.cur = Object.assign(r.cur || {}, extra || {}, { stage });
    r.phaseAt = Date.now();
    saveRun(r);
    updateBar();
  }

  const prefix = () => loadConf().surveyPrefix;
  const reviewUrl = (id) =>
    `${location.origin}/app/assignment/${prefix()}/${id}`;
  const onReviewOf = (id) =>
    new RegExp(`/app/assignment/[^/]+/${id}/?$`, "i").test(location.pathname);
  const onEditOf = (id) =>
    new RegExp(`/app/assignment/[^/]+/${id}/edit`, "i").test(location.pathname);

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
    const m =
      a &&
      a.getAttribute("href").match(/\/app\/assignment\/([0-9a-f-]{36})\//i);
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
    r.paused = null;
    r.processed = (r.processed || 0) + 1;
    const gap = T().gap;
    r.nextAt = Date.now() + gap[0] + Math.random() * (gap[1] - gap[0]);
    saveRun(r);
    runLog(`${/linked|closed|moved/.test(status) ? "✅" : "⚠️"} ${reason}`);
  }

  // Pindah wilayah di halaman daftar. Hasil: { status, reason }
  async function moveItem(item, testMode) {
    runLog(
      `Mencari ${item.namaUsaha} (${item.desa.name} ${item.slsAsalNama || item.slsAsal})`,
    );
    let found;
    try {
      found = await findRow(item);
    } catch (e) {
      // Tidak ada di SLS asal: mungkin sudah pindah -> cek di SLS tujuan
      if (!e.soft || !/tidak ada di SLS/.test(e.message)) throw e;
      await applyFilter(item, item.slsTujuan);
      const want = normalize(item.namaUsaha);
      const rows = await searchList(item.namaUsaha);
      if (
        rows.some((tr) =>
          Array.from(tr.querySelectorAll("td")).some(
            (td) => normalize(td.innerText) === want,
          ),
        )
      )
        return {
          status: "moved",
          reason: `sudah ada di SLS tujuan ${item.slsTujuan}`,
        };
      throw e;
    }
    await openGantiWilayah(found.tr);
    runLog(
      `Mengisi → SLS ${item.slsTujuan}/${item.subslsTujuan} ${item.slsTujuanNama}`,
    );
    await fillGantiWilayah(item);
    if (testMode) {
      userDecision = null;
      const r = loadRun();
      r.waiting = true;
      saveRun(r);
      runLog(
        `MODE UJI: periksa dialog Ganti Wilayah, lalu "Kirim sekarang" / "Lewati"`,
      );
      await waitFor(() => userDecision, 24 * 3600000);
      const r2 = loadRun();
      r2.waiting = false;
      saveRun(r2);
      if (userDecision !== "send") {
        closeGantiDialog();
        return {
          status: "tested",
          reason: `terisi, tidak dikirim (${found.note})`,
        };
      }
    }
    await submitGantiWilayah();
    appliedFilterKey = null;
    return {
      status: "moved",
      reason: `dipindah ke SLS ${item.slsTujuan}/${item.subslsTujuan} (${found.note})`,
    };
  }

  function nextItem(run) {
    const only = run.onlyIds ? new Set(run.onlyIds) : null;
    const want = run.onlyLink
      ? ["moved"]
      : run.doLink
        ? ["moved", "pending"]
        : ["pending"];
    const ready = loadQueue().filter(
      (q) => want.includes(q.status) && (!only || only.has(q.id)),
    );
    // Pindah wilayah SEMUA dulu (tetap di halaman daftar), baru tautkan yang sudah dipindah
    const pending = ready.filter((q) => q.status === "pending");
    if (pending.length)
      return (
        pending.find(
          (q) =>
            `${q.kec.code}|${q.desa.code}|${q.slsAsal}` === appliedFilterKey,
        ) || pending[0]
      );
    return ready.find((q) => q.status === "moved");
  }

  // Mode uji: berhenti sebelum Kirim. Hasil true = boleh lanjut
  function testGate(run, what) {
    if (!run.testMode || (run.cur && run.cur.confirmed === run.cur.stage))
      return true;
    if (!run.paused) {
      run.paused = { stage: run.cur.stage };
      saveRun(run);
      runLog(
        `MODE UJI: ${what} siap dikirim. Periksa, lalu "Kirim sekarang" / "Lewati"`,
      );
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
        if (!item || (run.limit && run.processed >= run.limit))
          return stopRun("Selesai.");
        if (item.status === "moved") {
          setStage("kel_open", { id: item.id });
          runLog(`Tautkan ${item.namaUsaha}`);
          return;
        }
        if (!isListPage()) return goList();
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
        return finishItem(
          item.id,
          "red",
          `${item.namaUsaha}: macet di tahap "${STAGE_LABEL[cur.stage] || cur.stage}"`,
        );
      try {
        await runStage(run, cur, item);
      } catch (e) {
        console.error("[OSS→Keluarga]", e);
        pressKey("Escape");
        const where = STAGE_LABEL[cur.stage] || cur.stage;
        finishItem(
          item.id,
          /galat/.test(e.message) ? "yellow" : "red",
          `${item.namaUsaha}: [${where}] ${e.message}`,
        );
      }
    } finally {
      busy = false;
    }
  }

  async function runStage(run, cur, item) {
    const kelId = item.kelId;
    switch (cur.stage) {
      case "kel_open":
      case "oss_open": {
        const id = cur.stage === "kel_open" ? kelId : item.id;
        if (!id) throw new Error("assignment_id keluarga kosong di Excel");
        const next = cur.stage === "kel_open" ? "kel_fill" : "oss_fill";
        if (onEditOf(id)) return setStage(next);
        if (!onReviewOf(id)) return goUrl(reviewUrl(id));
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
        updateItem(item.id, {
          pdata,
          linkResult: link.result,
          linkCard: link.card || "",
        });
        runLog(
          link.result === "found"
            ? `UMKM ${item.namaUsaha} ${link.changed ? "dipilih" : "sudah terpilih"} di usaha "${link.card}"`
            : link.result === "nousaha"
              ? "Keluarga tidak punya usaha → OSS akan ditutup"
              : "OSS tidak ada di pilihan UMKM keluarga → OSS akan ditutup",
        );
        return setStage(
          cur.revoked || link.changed ? "kel_submit" : "oss_open",
          { submitClicked: false },
        );
      }
      case "oss_fill": {
        if (!onEditOf(item.id)) return setStage("oss_open");
        runLog(
          item.linkResult === "found"
            ? "OSS: Ditemukan + salin alamat & geotag"
            : "OSS: Tutup",
        );
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
        if (
          !testGate(
            run,
            cur.stage === "kel_submit" ? "Dokumen keluarga" : "Dokumen OSS",
          )
        )
          return;
        runLog(STAGE_LABEL[cur.stage]);
        await submitCurrent();
        return setStage(next);
      }
      case "kel_approve":
      case "oss_approve": {
        const id = cur.stage === "kel_approve" ? kelId : item.id;
        if (!onReviewOf(id)) return goUrl(reviewUrl(id));
        runLog(STAGE_LABEL[cur.stage]);
        if (loadConf().approve) await approveDocument();
        if (cur.stage === "kel_approve")
          return setStage("oss_open", { submitClicked: false });
        const found = item.linkResult === "found";
        finishItem(
          item.id,
          found ? "linked" : "closed",
          found
            ? `${item.namaUsaha}: dipindah, ditautkan ke usaha "${item.linkCard}", OSS Ditemukan`
            : `${item.namaUsaha}: dipindah, ${item.linkResult === "nousaha" ? "keluarga tanpa usaha" : "tidak ada di pilihan UMKM"} → OSS Tutup`,
        );
        return goList();
      }
      default:
        throw new Error(`tahap tidak dikenal: ${cur.stage}`);
    }
  }

  function startRun(opts) {
    if (!isListPage()) {
      alert(
        'Mulai dari halaman daftar assignment (tabel dengan kotak "Cari...").',
      );
      return;
    }
    const conf = loadConf();
    // ▶ N / Uji 1: ambil N baris dari antrean -> N baris itu dipindah dulu, lalu ditautkan
    let onlyIds = opts.onlyIds || null;
    if (!onlyIds && opts.limit) {
      const want = opts.onlyLink ? ["moved"] : ["pending"];
      onlyIds = loadQueue()
        .filter((q) => want.includes(q.status))
        .slice(0, opts.limit)
        .map((q) => q.id);
      if (!onlyIds.length && !opts.onlyLink && conf.doLink)
        onlyIds = loadQueue()
          .filter((q) => q.status === "moved")
          .slice(0, opts.limit)
          .map((q) => q.id);
    }
    saveRun({
      running: true,
      limit: 0,
      testMode: !!opts.testMode,
      doLink: conf.doLink,
      onlyLink: !!opts.onlyLink,
      onlyIds,
      processed: 0,
      listUrl: location.href,
      cur: null,
    });
    document.getElementById("fgw-panel")?.remove();
    runLog(
      `Mulai${opts.onlyLink ? " (tautkan saja)" : ""}${opts.testMode ? " · MODE UJI" : ""}`,
    );
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
      .fgw, .fgw * { box-sizing:border-box; font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
      .fgw-overlay { position:fixed; inset:0; z-index:1000001; background:rgba(15,23,42,.35); display:flex; justify-content:flex-end; }
      .fgw-sheet { background:#fff; color:#0f172a; width:min(760px,100vw); height:100vh; display:flex; flex-direction:column; box-shadow:-12px 0 40px rgba(15,23,42,.18); }
      .fgw-head { padding:16px 20px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:10px; }
      .fgw-title { font-size:16px; font-weight:700; flex:1; }
      .fgw-body { flex:1; overflow:auto; padding:16px 20px; display:flex; flex-direction:column; gap:14px; }
      .fgw-card { border:1px solid #e5e7eb; border-radius:12px; padding:12px; }
      .fgw-sec { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:#64748b; margin-bottom:8px; }
      .fgw-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .fgw-btn { border:1px solid #e5e7eb; background:#fff; color:#0f172a; border-radius:8px; padding:7px 11px; font-size:12.5px; font-weight:600; cursor:pointer; }
      .fgw-btn:hover { background:#f8fafc; }
      .fgw-btn.primary { background:#0d9488; border-color:#0d9488; color:#fff; }
      .fgw-btn.danger { color:#dc2626; }
      .fgw-btn.sm { padding:4px 8px; font-size:12px; }
      .fgw-input { border:1px solid #e5e7eb; border-radius:8px; padding:6px 9px; font-size:12.5px; min-width:220px; }
      .fgw-hint { font-size:12px; color:#64748b; }
      .fgw-stats { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
      .fgw-stat { border:1px solid #e5e7eb; border-radius:10px; padding:8px 10px; cursor:pointer; background:#fff; text-align:left; }
      .fgw-stat.active { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent); }
      .fgw-stat .n { font-size:18px; font-weight:700; color:var(--c); }
      .fgw-stat .l { font-size:11px; color:#64748b; }
      .fgw-item { display:grid; grid-template-columns:20px 1fr; gap:10px; border:1px solid #e5e7eb; border-radius:10px; padding:10px; font-size:12.5px; }
      .fgw-item b { font-size:13px; }
      .fgw-badge { font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; color:var(--c); background:color-mix(in srgb,var(--c) 12%,#fff); }
      .fgw-meta { color:#64748b; margin-top:2px; }
      .fgw-reason { margin-top:4px; color:var(--c); }
      .fgw-launch { position:fixed; left:16px; bottom:64px; z-index:999999; border:none; border-radius:999px; padding:9px 14px; background:#0d9488; color:#fff; font:600 13px ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 8px 24px rgba(13,148,136,.35); }
      .fgw-bar { position:fixed; top:12px; right:12px; z-index:1000002; width:min(460px,94vw); background:#0f172a; color:#f8fafc; border-radius:14px; padding:12px 14px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; box-shadow:0 16px 40px rgba(15,23,42,.35); font:13px ui-sans-serif,system-ui,sans-serif; }
      .fgw-bar .s { color:#cbd5e1; font-size:12px; }
      .fgw-bar .fgw-btn { background:#1e293b; border-color:#334155; color:#f8fafc; }
      .fgw-bar .fgw-btn.go { background:#16a34a; border-color:#16a34a; }
      .fgw-bar .fgw-btn.stop { background:transparent; border-color:#7f1d1d; color:#fca5a5; }
    `;
    document.head.appendChild(style);
  }

  const esc = (s) =>
    String(s || "").replace(
      /[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
    );

  function updateBar() {
    const run = loadRun();
    let bar = document.getElementById("fgw-bar");
    if (!run.running) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      ensureStyles();
      bar = document.createElement("div");
      bar.id = "fgw-bar";
      bar.className = "fgw fgw-bar";
      bar.addEventListener("click", (e) => {
        const act = e.target.closest("[data-bar]")?.dataset.bar;
        if (act === "stop") stopRun();
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
          if (r.cur)
            finishItem(
              r.cur.id,
              "tested",
              "MODE UJI: tidak dikirim (dokumen masih terbuka/revoke, cek manual)",
            );
          goList();
        }
      });
      document.body.appendChild(bar);
    }
    const c = counts();
    const rate = rateLimited()
      ? `⛔ Server membatasi (429), lanjut sendiri ${new Date(rateInfo().until).toLocaleTimeString()}`
      : "";
    bar.innerHTML = `<div style="flex:1;min-width:0;">
        <div><b>OSS → Keluarga</b>${run.cur ? ` · ${STAGE_LABEL[run.cur.stage] || run.cur.stage}` : ""} · ${T().name}${run.testMode ? " · Mode uji" : ""} · ${run.processed || 0}${run.limit ? " / " + run.limit : run.onlyIds ? " / " + run.onlyIds.length : ""}</div>
        <div class="s">${esc(rate || run.lastLog || "")}</div>
        <div class="s">✓ ${c.linked} ditautkan · ${c.closed} OSS tutup · ${c.moved} dipindah (belum ditautkan) · ${c.yellow} perlu cek · ${c.red} gagal · ${c.pending} belum dipindah</div>
      </div>
      ${run.paused ? `<button class="fgw-btn go" data-bar="go">✓ Kirim sekarang</button><button class="fgw-btn" data-bar="pass">Lewati</button>` : ""}
      ${run.waiting ? `<button class="fgw-btn go" data-bar="send">✓ Kirim sekarang</button><button class="fgw-btn" data-bar="skip">Lewati</button>` : ""}
      <button class="fgw-btn stop" data-bar="stop">Stop</button>`;
  }

  function counts() {
    const c = {
      pending: 0,
      moved: 0,
      linked: 0,
      closed: 0,
      tested: 0,
      red: 0,
      yellow: 0,
    };
    loadQueue().forEach((q) => (c[q.status] = (c[q.status] || 0) + 1));
    return c;
  }

  function downloadReport() {
    const q = (v) =>
      `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
    const header = [
      "baris_excel",
      "assignment_id",
      "kel_assignment_id",
      "status",
      "alasan",
      "hasil_tautan",
      "usaha_keluarga",
      "jalan",
      "nomor",
      "no_bang",
      "latitude",
      "longitude",
      "waktu",
      "kecamatan",
      "desa",
      "sls_asal",
      "nama_usaha",
      "sls_tujuan",
      "subsls_tujuan",
      "sls_tujuan_nama",
      "kel_anggota",
      "yakin",
      "link_oss",
      "link_keluarga",
    ];
    const lines = loadQueue().map((i) =>
      [
        i.row,
        i.id,
        i.kelId,
        STATUS_LABEL[i.status],
        i.reason,
        i.linkResult || "",
        i.linkCard || "",
        (i.pdata || {}).jalan,
        (i.pdata || {}).nomor,
        (i.pdata || {}).noBang,
        (i.pdata || {}).lat,
        (i.pdata || {}).lng,
        i.doneAt || "",
        i.kec.name,
        i.desa.name,
        i.slsAsal,
        i.namaUsaha,
        i.slsTujuan,
        i.subslsTujuan,
        i.slsTujuanNama,
        i.kelAnggota,
        i.yakin,
        i.linkOss,
        i.linkKel,
      ]
        .map(q)
        .join(","),
    );
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `laporan-oss-keluarga-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`;
    a.click();
  }

  let panelFilter = "pending";
  const selected = new Set();

  function openPanel() {
    document.getElementById("fgw-panel")?.remove();
    ensureStyles();
    const queue = loadQueue();
    const conf = loadConf();
    const c = counts();
    const shown = queue
      .filter((q) => panelFilter === "all" || q.status === panelFilter)
      .slice(0, 150);
    const stat = (key, label, color) =>
      `<button class="fgw-stat${panelFilter === key ? " active" : ""}" style="--c:${color}" data-act="filter" data-f="${key}"><div class="n">${key === "all" ? queue.length : c[key] || 0}</div><div class="l">${label}</div></button>`;
    const rows = shown
      .map((q) => {
        const color = STATUS_COLOR[q.status] || "#64748b";
        return `<div class="fgw-item" data-text="${esc(normalize(`${q.namaUsaha} ${q.desa.name} ${q.kec.name} ${q.id}`))}">
          <input type="checkbox" data-sel="${q.id}" ${selected.has(q.id) ? "checked" : ""}>
          <div><b>${esc(q.namaUsaha)}</b> <span class="fgw-badge" style="--c:${color}">${STATUS_LABEL[q.status]}</span> <span class="fgw-hint">${esc(q.yakin)}</span>
            <div class="fgw-meta">${esc(q.kec.name)} › ${esc(q.desa.name)} · SLS ${q.slsAsal}/${q.subslsAsal} → <b>${q.slsTujuan}/${q.subslsTujuan}</b> ${esc(q.slsTujuanNama)} · keluarga: ${esc(q.kelAnggota)} · baris ${q.row}</div>
            ${q.reason ? `<div class="fgw-reason" style="--c:${color}">${esc(q.reason)}</div>` : ""}
            <div class="fgw-meta"><a href="${esc(q.linkOss)}" target="_blank">OSS ↗</a> · <a href="${esc(q.linkKel)}" target="_blank">Keluarga ↗</a></div>
          </div></div>`;
      })
      .join("");

    const overlay = document.createElement("div");
    overlay.id = "fgw-panel";
    overlay.className = "fgw fgw-overlay";
    overlay.innerHTML = `<div class="fgw-sheet">
      <div class="fgw-head"><div class="fgw-title">🔀 OSS → Keluarga: Pindah + Tautkan</div>
        ${queue.length ? `<button class="fgw-btn sm" data-act="report">⬇ Laporan CSV</button>` : ""}
        <button class="fgw-btn sm" data-act="close">✕</button></div>
      <div class="fgw-body">
        <div class="fgw-card"><div class="fgw-sec">Persiapan</div>
          <div class="fgw-row"><button class="fgw-btn ${queue.length ? "" : "primary"}" data-act="load">📥 Muat Excel target</button>
            <span class="fgw-hint">sheet "Pindah" · kolom proses = 1</span></div>
          <div class="fgw-row" style="margin-top:8px;"><span class="fgw-hint" style="width:70px;">Pengawas</span><input class="fgw-input" data-conf="pengawas" value="${esc(conf.pengawas)}"></div>
          <div class="fgw-row" style="margin-top:6px;"><span class="fgw-hint" style="width:70px;">Pencacah</span><input class="fgw-input" data-conf="pencacah" value="${esc(conf.pencacah)}"></div>
          <div class="fgw-row" style="margin-top:8px;"><span class="fgw-hint" style="width:70px;">Kecepatan</span>
            ${SPEEDS.map((sp, i) => `<label class="fgw-hint"><input type="radio" name="fgw-speed" value="${i}" ${Number(conf.speed) === i ? "checked" : ""}> ${sp.name}</label>`).join(" ")}
            <span class="fgw-hint">(turun sendiri kalau server membalas 429)</span></div>
          <label class="fgw-hint" style="display:block;margin-top:8px;"><input type="checkbox" data-flag="doLink" ${conf.doLink ? "checked" : ""}> Setelah dipindah: buka keluarga, pilih UMKM, isi OSS (Ditemukan/Tutup), kirim</label>
          <label class="fgw-hint" style="display:block;margin-top:4px;"><input type="checkbox" data-flag="approve" ${conf.approve ? "checked" : ""}> Approve keluarga & OSS setelah kirim</label>
          <div class="fgw-row" style="margin-top:6px;"><span class="fgw-hint" style="width:70px;">ID survei</span><input class="fgw-input" data-conf="surveyPrefix" value="${esc(conf.surveyPrefix)}" style="min-width:300px;"></div>
          <label class="fgw-hint" style="display:block;margin-top:8px;"><input type="checkbox" data-strict ${conf.strictId ? "checked" : ""}> Wajib cocok assignment_id (lebih aman, bisa lebih banyak "perlu cek")</label>
        </div>
        ${
          queue.length
            ? `
        <div class="fgw-stats" style="grid-template-columns:repeat(4,1fr);">${stat("pending", "Belum dipindah", STATUS_COLOR.pending)}${stat("moved", "Dipindah, belum ditautkan", STATUS_COLOR.moved)}${stat("linked", "Ditautkan", STATUS_COLOR.linked)}${stat("closed", "OSS tutup", STATUS_COLOR.closed)}${stat("yellow", "Perlu cek", STATUS_COLOR.yellow)}${stat("red", "Gagal", STATUS_COLOR.red)}${stat("tested", "Uji", STATUS_COLOR.tested)}${stat("all", "Semua", "#0f172a")}</div>
        <div class="fgw-card"><div class="fgw-sec">Jalankan</div>
          <div class="fgw-row">
            <button class="fgw-btn primary" data-act="test">🧪 Uji 1 (berhenti sebelum tiap kirim)</button>
            <button class="fgw-btn" data-act="link">🔗 Tautkan yang sudah dipindah (${c.moved})</button>
            <button class="fgw-btn" data-act="sel">▶ Yang dicentang (<span data-selcount>${selected.size}</span>)</button>
            ${[5, 20].map((n) => `<button class="fgw-btn" data-act="run" data-n="${n}">▶ ${n}</button>`).join("")}
            <button class="fgw-btn" data-act="run" data-n="0">▶ Semua (${c.pending + (conf.doLink ? c.moved : 0)})</button>
          </div>
          <div class="fgw-hint" style="margin-top:6px;">Mulai dari halaman daftar assignment. Tombol ▶ dan 🔗 berjalan tanpa berhenti: pindah → keluarga (revoke, pilih UMKM, kirim, approve) → OSS (isi, kirim, approve). Urutan: SEMUA pindah wilayah dulu, baru ditautkan satu per satu.</div>
        </div>
        <div class="fgw-row"><input class="fgw-input" data-search placeholder="Cari nama / desa / id…" style="flex:1;">
          <button class="fgw-btn sm" data-act="reset">↻ Gagal/perlu cek → belum</button>
          <button class="fgw-btn sm danger" data-act="clear">🗑 Hapus antrean</button></div>
        <div style="display:flex;flex-direction:column;gap:6px;">${rows || '<div class="fgw-hint">Tidak ada baris.</div>'}</div>
        ${shown.length >= 150 ? '<div class="fgw-hint">Menampilkan 150 baris pertama · lengkapnya di Laporan CSV</div>' : ""}`
            : '<div class="fgw-hint">Belum ada antrean. Klik <b>Muat Excel target</b>.</div>'
        }
      </div>
      <input data-file type="file" accept=".xlsx" style="display:none"></div>`;
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
    if (search)
      search.oninput = () => {
        const t = normalize(search.value);
        overlay
          .querySelectorAll(".fgw-item")
          .forEach(
            (r) =>
              (r.style.display =
                !t || r.dataset.text.includes(t) ? "" : "none"),
          );
      };
    overlay.addEventListener("change", (e) => {
      const box = e.target.closest("[data-sel]");
      if (!box) return;
      if (box.checked) selected.add(box.dataset.sel);
      else selected.delete(box.dataset.sel);
      const l = overlay.querySelector("[data-selcount]");
      if (l) l.textContent = selected.size;
    });

    const fileInput = overlay.querySelector("[data-file]");
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const old = new Map(loadQueue().map((q) => [q.id, q]));
        const { items, sheet, skipped } = await parseWorkbook(
          await file.arrayBuffer(),
        );
        let kept = 0;
        items.forEach((i) => {
          const o = old.get(i.id);
          if (o && o.status !== "pending") {
            Object.assign(i, {
              status: o.status,
              reason: o.reason,
              doneAt: o.doneAt,
              pdata: o.pdata,
              linkResult: o.linkResult,
              linkCard: o.linkCard,
            });
            kept++;
          }
        });
        saveQueue(items);
        alert(
          `Sheet "${sheet}": ${items.length} baris dimuat, ${skipped} dilewati (proses ≠ 1).${kept ? `\nStatus lama dipertahankan untuk ${kept} baris.` : ""}`,
        );
      } catch (err) {
        alert(`Gagal membaca Excel: ${err.message}`);
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
      if (act === "filter") {
        panelFilter = el.dataset.f;
        openPanel();
      }
      if (act === "test") startRun({ limit: 1, testMode: true });
      if (act === "link") {
        if (!counts().moved)
          return alert("Tidak ada baris berstatus dipindah.");
        if (
          confirm(
            `Tautkan ${counts().moved} OSS yang sudah dipindah (revoke keluarga & OSS, kirim${loadConf().approve ? ", approve" : ""}) TANPA berhenti?`,
          )
        )
          startRun({ onlyLink: true });
      }
      if (act === "run") {
        const n = Number(el.dataset.n);
        if (
          confirm(
            `Pindahkan ${n || "SEMUA (" + counts().pending + ")"} assignment OSS ke SLS keluarga TANPA berhenti?\nPengawas: ${loadConf().pengawas}\nPencacah: ${loadConf().pencacah}`,
          )
        )
          startRun({ limit: n });
      }
      if (act === "sel") {
        const ids = loadQueue()
          .filter(
            (q) =>
              selected.has(q.id) && !["linked", "closed"].includes(q.status),
          )
          .map((q) => q.id);
        if (!ids.length)
          return alert("Belum ada baris (belum dipindah) yang dicentang.");
        const q = loadQueue();
        q.filter((i) => ids.includes(i.id) && i.status !== "moved").forEach(
          (i) => (i.status = "pending"),
        );
        saveQueue(q);
        if (
          confirm(`Kerjakan ${ids.length} baris yang dicentang tanpa berhenti?`)
        )
          startRun({ onlyIds: ids });
      }
      if (act === "reset") {
        const q = loadQueue();
        q.filter((i) => ["red", "yellow", "tested"].includes(i.status)).forEach(
          (i) => {
            i.status = "pending";
            i.reason = "";
          },
        );
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
    if (
      !document.body ||
      document.getElementById("fgw-launch") ||
      /\/app\/assignment\//.test(location.pathname)
    )
      return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "fgw-launch";
    btn.className = "fgw-launch";
    btn.textContent = "🔀 OSS → Keluarga";
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
  }, 1500);

  console.log("[OSS → Keluarga v2.3] Aktif. Tombol di kiri bawah (Alt+8).");
})();
