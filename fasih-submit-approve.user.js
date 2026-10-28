// ==UserScript==
// @name         FASIH Approve (status EDITED / REVOKED BY Admin Kabupaten, dari belakang)
// @namespace    hanif-bps-hst
// @version      1.16
// @description  Tanpa Excel/link: buka halaman data survei dengan filter status "EDITED BY Admin Kabupaten" dan/atau "REVOKED BY Admin Kabupaten" (pilih di panel; 100 baris per halaman), ambil dokumen dari halaman & baris PALING BELAKANG (yang depan mungkin masih dikerjakan manual), buka Review lalu langsung Approve (tanpa Edit / Kirim), lalu kembali ke daftar. Dokumen yang gagal di-approve dilewati & dicatat. Mode uji berhenti sebelum Approve.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Halaman daftar data survei + filter status (dari alamat yang dipakai di FASIH)
  const LIST_PATH =
    "/app/surveys/a0429e96-51a5-477b-a415-485f9c153004/fd68e454-ba45-4b85-8205-f3bf777ded24/data";
  // Status yang dikerjakan (dipilih di panel): satu status, atau keduanya bergantian
  const STATUSES = {
    edited: "EDITED BY Admin Kabupaten",
    revoked: "REVOKED BY Admin Kabupaten",
  };
  const STATUS_MODES = {
    edited: { label: "EDITED BY Admin Kabupaten", list: ["edited"] },
    revoked: { label: "REVOKED BY Admin Kabupaten", list: ["revoked"] },
    both: { label: "EDITED + REVOKED (bergantian)", list: ["edited", "revoked"] },
  };
  const PER_PAGE = 100;

  const APP = {
    name: "Submit & Approve",
    version: "1.16",
    hotkey: "0",
    launchBottom: 400,
  };
  const RUN_KEY = "fsa_run";
  const CONF_KEY = "fsa_conf";
  const POS_KEY = "fsa_pos";
  // Dokumen yang sudah di-approve skrip ini: server FASIH lambat memperbarui daftar, jadi dokumen itu
  // masih tampil berstatus EDITED beberapa saat. Diingat DONE_KEEP_MS supaya tidak dibuka ulang.
  const DONE_KEY = "fsa_done";
  const DONE_KEEP_MS = 6 * 60 * 60 * 1000;
  const PHASE_TIMEOUT_MS = 4 * 60 * 1000;
  // Sekali buka daftar, ambil link Review sekian dokumen dari baris paling bawah, lalu approve
  // satu per satu langsung dari link itu (tidak bolak-balik ke daftar tiap dokumen)
  const BATCH = 20;
  // Setelah daftar habis: cek ulang dari halaman 1 sebanyak ini (jeda RECHECK_MS) sebelum berhenti
  const RECHECKS = 2;
  const RECHECK_MS = 30000;
  // Jaringan lambat: tunggu tombol ✔ / Revoke selama ini, lalu muat ulang halaman Review
  // sampai RETRIES kali sebelum dokumen dianggap gagal
  const APPROVE_WAIT_MS = 60000;
  const RETRIES = 3;

  // =========================================================================
  // UTILITAS
  // =========================================================================
  const loadJson = (k, f) => {
    try {
      return JSON.parse(localStorage.getItem(k)) || f;
    } catch (e) {
      return f;
    }
  };
  const saveJson = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.error(`[${APP.name}] gagal menyimpan`, e);
    }
  };
  const loadRun = () => loadJson(RUN_KEY, { running: false });
  const saveRun = (r) => saveJson(RUN_KEY, r);
  const loadConf = () => ({
    approve: true,
    testMode: false,
    limit: 0,
    devices: 1, // jumlah device yang menjalankan skrip ini bersamaan
    slot: 1, // device ini bagian ke berapa (1..devices)
    statusMode: "edited", // edited | revoked | both
    ...loadJson(CONF_KEY, {}),
  });
  const saveConf = (c) => saveJson(CONF_KEY, c);
  // Bagi dokumen antar device lewat kode dokumen (bukan halaman/urutan, karena urutan daftar berubah
  // terus setelah approve): tiap kode selalu jatuh ke bagian yang sama -> dua device tidak pernah
  // membuka dokumen yang sama.
  const devCount = (c) => Math.min(9, Math.max(1, Number(c.devices) || 1));
  const devSlot = (c) => Math.min(devCount(c), Math.max(1, Number(c.slot) || 1));
  function partOf(kode, n) {
    let h = 5381;
    for (const ch of String(kode || "")) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return (h % n) + 1;
  }
  const mine = (kode) => {
    const c = loadConf();
    return devCount(c) === 1 || partOf(kode, devCount(c)) === devSlot(c);
  };
  const modeOf = (c) => STATUS_MODES[c.statusMode] || STATUS_MODES.edited;
  const statusList = () => modeOf(loadConf()).list.map((k) => STATUSES[k]);
  const curStatus = () => {
    const list = statusList();
    return list[Math.min(list.length - 1, loadRun().statusIdx || 0)];
  };
  function loadDone() {
    const d = loadJson(DONE_KEY, {});
    const now = Date.now();
    for (const k of Object.keys(d)) if (now - d[k] > DONE_KEEP_MS) delete d[k];
    return d;
  }
  // Daftar dokumen yang ditarik dari tabel (tampil di kotak kendali; yang gagal bisa diulang)
  const ITEMS_KEY = "fsa_items";
  const ITEM_STATUS = {
    antre: { label: "Antre", color: "#818cf8" },
    done: { label: "Approve", color: "#4ade80" },
    already: { label: "Sudah approve", color: "#2dd4bf" },
    failed: { label: "Gagal", color: "#f87171" },
  };
  const loadItems = () => loadJson(ITEMS_KEY, {});
  function setItem(kode, patch) {
    if (!kode) return;
    const all = loadItems();
    all[kode] = { ...(all[kode] || { kode }), ...patch, at: Date.now() };
    saveJson(ITEMS_KEY, all);
  }
  function markDone(kode) {
    if (!kode) return;
    const d = loadDone();
    d[kode] = Date.now();
    saveJson(DONE_KEY, d);
  }

  let stopRequested = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(check, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return null;
      const res = check();
      if (res) return res;
      await sleep(200);
      while (loadRun().hold && !stopRequested) await sleep(1000); // tombol Jeda
    }
    return null;
  }

  const OWN = "#fsa-box, #fsa-launch";
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
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: key,
        keyCode: key === "Enter" ? 13 : 27,
        bubbles: true,
      }),
    );
  }
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

  function log(msg) {
    console.log(`[${APP.name}] ${msg}`);
    const r = loadRun();
    r.logs = [
      ...(r.logs || []),
      `${new Date().toLocaleTimeString("id-ID")} ${msg}`,
    ].slice(-8);
    saveRun(r);
    render();
  }
  function setPhase(phase, extra) {
    const r = loadRun();
    Object.assign(r, extra || {}, { phase, phaseAt: Date.now() });
    saveRun(r);
    render();
  }

  // =========================================================================
  // HALAMAN DAFTAR DATA (tabel)
  // =========================================================================
  const REVIEW_HREF = /\/app\/assignment\/[0-9a-f-]{36}\/[0-9a-f-]{36}/i;
  const onList = () => location.pathname.replace(/\/$/, "") === LIST_PATH;
  const onReview = () =>
    /\/app\/assignment\/[^/]+\/[^/]+\/?$/.test(location.pathname);
  const onEdit = () =>
    /\/app\/assignment\/[^/]+\/[^/]+\/edit/.test(location.pathname);
  function listUrl(page) {
    const u = new URL(location.origin + LIST_PATH);
    u.searchParams.set("page", String(page || 1));
    u.searchParams.set("perPage", String(PER_PAGE));
    u.searchParams.set("status", curStatus());
    return u.toString();
  }
  // Halaman daftar yang terbuka sudah memakai filter status, 100 baris, dan halaman yang diminta?
  function listUrlOk(page) {
    if (!onList()) return false;
    const p = new URLSearchParams(location.search);
    return (
      p.get("status") === curStatus() &&
      Number(p.get("perPage")) === PER_PAGE &&
      Number(p.get("page") || 1) === page
    );
  }
  function goto(url) {
    const r = loadRun();
    r.navAt = Date.now();
    saveRun(r);
    location.href = url;
  }

  const tableText = () =>
    (document.querySelector("table tbody") || {}).innerText || "";
  const isLoading = () =>
    Array.from(
      document.querySelectorAll(
        '[class*="animate-spin"], [class*="skeleton"], [aria-busy="true"]',
      ),
    ).some((el) => visible(el) && !el.closest(OWN)) ||
    /loading|memuat/i.test(tableText());
  // Tunggu tabel termuat & diam sebentar (tanpa indikator loading)
  async function waitTable() {
    if (!(await waitFor(() => document.querySelector("table thead"), 30000)))
      throw new Error("tabel data tidak muncul");
    let last = null;
    let since = Date.now();
    const start = Date.now();
    while (Date.now() - start < 30000 && !stopRequested) {
      await sleep(250);
      const now = tableText();
      if (now !== last || isLoading()) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= 1500) break;
    }
  }
  function readRows() {
    const table = document.querySelector("table");
    if (!table) return [];
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) =>
      th.innerText.trim().toUpperCase(),
    );
    const idx = (part) => heads.findIndex((h) => h.includes(part));
    const iKode = idx("KODE");
    const iNama = idx("NAMA");
    const iStatus = idx("STATUS");
    return Array.from(table.querySelectorAll("tbody tr"))
      .filter((tr) => tr.querySelectorAll("td").length > 2)
      .map((tr) => {
        const cells = tr.querySelectorAll("td");
        const text = (i) =>
          i >= 0 && cells[i] ? cells[i].innerText.trim() : "";
        const kodeBtn =
          (iKode >= 0 &&
            cells[iKode] &&
            cells[iKode].querySelector("button:not([title])")) ||
          null;
        return {
          tr,
          kode: kodeBtn ? kodeBtn.innerText.trim() : text(iKode),
          nama: text(iNama),
          status: text(iStatus),
          kodeBtn,
        };
      });
  }
  // Filter status lewat URL kadang tidak terpasang: kalau tabel masih memuat status lain, pilih
  // status yang sedang dikerjakan sendiri dari dropdown status (tombol ˅ di atas tabel), sekali per halaman.
  const sq = (t) => String(t || "").toUpperCase().replace(/[^A-Z]/g, "");
  const isEdited = (st) => !!st && sq(st).includes(sq(curStatus()));
  let filterTriedAt = "";
  async function ensureStatusFilter() {
    const rows = readRows();
    if (!rows.length || rows.every((r) => !r.status || isEdited(r.status)))
      return true;
    if (filterTriedAt === location.href) return false;
    filterTriedAt = location.href;
    log(
      `Filter status belum terpasang → pilih ${curStatus()} dari dropdown`,
    );
    const optionEls = () =>
      Array.from(
        document.querySelectorAll(
          '[role="option"], [cmdk-item], [role="menuitem"], [role="menuitemcheckbox"], [role="listbox"] li, [data-radix-popper-content-wrapper] label, [role="dialog"] label',
        ),
      ).filter(
        (el) => visible(el) && !el.closest(OWN) && isEdited(el.innerText),
      );
    const toggles = Array.from(document.querySelectorAll("button")).filter(
      (b) =>
        visible(b) &&
        !b.closest("table") &&
        !b.closest(OWN) &&
        (b.querySelector(
          "svg.tabler-icon-chevron-down, svg.tabler-icon-selector",
        ) ||
          b.getAttribute("role") === "combobox"),
    );
    for (const t of toggles) {
      const before = tableText();
      triggerClick(t);
      const opt = await waitFor(() => optionEls()[0], 2500);
      if (!opt) {
        pressKey("Escape");
        await sleep(300);
        continue;
      }
      const cb = opt.querySelector('input[type="checkbox"], [role="checkbox"]');
      triggerClick(cb || opt);
      await sleep(500);
      pressKey("Escape");
      await waitFor(() => tableText() !== before, 6000);
      await waitTable();
      if (readRows().every((r) => !r.status || isEdited(r.status))) {
        log(`Filter status ${curStatus()} terpasang`);
        return true;
      }
    }
    log(
      `⚠ dropdown status ${curStatus()} tidak ketemu — baris status lain dilewati`,
    );
    return false;
  }

  // Klik kode dokumen di tabel -> muncul kartu kecil berisi tombol "Review" (tombol itu dibungkus link
  // /app/assignment/...). Hasil: alamat Review (string), { button } kalau tombolnya tanpa link, atau null.
  const reviewBtn = () =>
    Array.from(document.querySelectorAll("button, a")).find(
      (b) =>
        visible(b) &&
        !b.closest(OWN) &&
        /^\s*Review\s*$/i.test(b.innerText || ""),
    ) || null;
  async function closeReviewCard() {
    if (!reviewBtn()) return;
    pressKey("Escape");
    if (await waitFor(() => !reviewBtn(), 1500)) return;
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    ); // klik di luar kartu
    await waitFor(() => !reviewBtn(), 1500);
  }
  async function rowLink(row) {
    const direct = Array.from(row.tr.querySelectorAll("a[href]")).find((a) =>
      REVIEW_HREF.test(a.href),
    );
    if (direct) return direct.href;
    await closeReviewCard(); // kartu dari baris sebelumnya ditutup dulu supaya tidak tertukar
    // Kartu Review bisa muncul di dalam baris tabel itu sendiri, atau melayang di halaman
    const inRow = () =>
      Array.from(row.tr.querySelectorAll("a[href]")).find((a) =>
        REVIEW_HREF.test(a.href),
      );
    for (const target of [row.kodeBtn, row.tr]) {
      if (!target) continue;
      for (const click of [() => triggerClick(target), () => target.click()]) {
        click();
        const mine = () => {
          const b = reviewBtn();
          const tr = b && b.closest("tr");
          return b && (!tr || tr === row.tr) ? b : null;
        };
        const got = await waitFor(() => inRow() || mine(), 4000);
        if (!got) continue;
        if (got.tagName === "A" && REVIEW_HREF.test(got.href)) return got.href;
        const a = got.closest("a[href]") || got.querySelector("a[href]");
        if (a && REVIEW_HREF.test(a.href)) return a.href;
        return { button: got };
      }
    }
    return null;
  }

  // =========================================================================
  // REVIEW -> EDIT -> KIRIM -> APPROVE (sama dengan skrip koreksi lain)
  // =========================================================================
  async function reviewToEdit() {
    await waitFor(
      () => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"),
      20000,
    );
    await sleep(600);
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      const revoke = buttonByIcon("rotate-clockwise");
      if (!revoke || revoke.disabled)
        throw new Error("tombol Edit & Revoke tidak aktif");
      log("Revoke dokumen");
      triggerClick(revoke);
      const ok = await waitFor(() => buttonByText("Konfirmasi"), 8000);
      if (!ok) throw new Error("konfirmasi revoke tidak muncul");
      triggerClick(ok);
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
        () => onEdit() && document.querySelector(".fasih-form-sidebar"),
        30000,
      ))
    )
      throw new Error("halaman edit tidak terbuka");
    await sleep(1500);
  }

  const sidebarItem = (title) => {
    const sq = (s) =>
      String(s || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    const items = Array.from(
      document.querySelectorAll(".fasih-form-sidebar [title]"),
    );
    return (
      items.find((el) => sq(el.getAttribute("title")) === sq(title)) || null
    );
  };
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
  // Halaman CATATAN + nyalakan "Tampilkan Anomali" (FASIH memintanya sebelum Kirim)
  async function openCatatan() {
    closeDialogs();
    const item = await waitFor(() => sidebarItem("CATATAN"), 10000);
    if (!item) return log("⚠ menu CATATAN tidak ada, langsung Kirim");
    triggerClick(item);
    if (!(await waitFor(findAnomaliSwitch, 10000))) return;
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
  }

  const isKirimText = (b) => b.innerText.trim().toUpperCase() === "KIRIM";
  const inDialog = (b) => !!b.closest('[role="dialog"], [role="alertdialog"]');
  const hasSendIcon = (b) =>
    !!b.querySelector('svg path[d^="M10 14l11 -11"], svg.tabler-icon-send');
  function findNavKirim() {
    const bs = Array.from(document.querySelectorAll("button")).filter(
      (b) =>
        visible(b) &&
        !b.disabled &&
        isKirimText(b) &&
        !inDialog(b) &&
        !b.closest(OWN),
    );
    return (
      bs.find(hasSendIcon) ||
      bs.find((b) => b.id === "fasih-form-nav-submit-button") ||
      bs[0] ||
      null
    );
  }
  function findDialogKirim() {
    const bs = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !b.closest(OWN),
    );
    return (
      bs.find(inDialog) ||
      bs.find(
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
        const t = card.querySelector("div[title]");
        return `${t ? t.getAttribute("title").trim() : "?"} (${Array.from(
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
  const dialogText = () => {
    const d = Array.from(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    )
      .filter(visible)
      .pop();
    return d ? d.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  };
  const backButton = () =>
    Array.from(document.querySelectorAll("button")).find(
      (b) =>
        /KEMBALI KE REVIEW/i.test(b.innerText) && b.getClientRects().length > 0,
    );
  async function backToReview(timeoutMs) {
    const sign = await waitFor(
      () => backButton() || (!onEdit() ? "left" : null),
      timeoutMs,
    );
    if (!sign)
      throw new Error(
        `tidak ada tanda terkirim setelah Konfirmasi: ${dialogText() || "cek manual"}`,
      );
    if (sign !== "left") {
      await sleep(400);
      triggerClick(sign);
      if (!(await waitFor(() => !onEdit(), 15000))) {
        sign.click();
        await waitFor(() => !onEdit(), 15000);
      }
    }
    await sleep(1200);
  }
  // Kirim. Ada galat -> error (dokumen dilewati, tidak diperbaiki otomatis)
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
    await sleep(1200);
    const galat = summaryCount("GALAT");
    if ((galat && galat.n > 0) || (readGalatList().length && !galat)) {
      if (galat && galat.btn && !readGalatList().length) {
        triggerClick(galat.btn);
        await waitFor(() => readGalatList().length, 6000);
      }
      const detail = readGalatList().join("; ");
      closeDialogs();
      throw new Error(
        `galat ${galat ? galat.n : readGalatList().length}: ${detail || "lihat di FASIH"}`,
      );
    }
    const dk = findDialogKirim();
    if (!dk)
      throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    const r = loadRun();
    r.submitClicked = true;
    saveRun(r);
    triggerClick(dk);
    const konf = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konf)
      throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
    await sleep(400);
    triggerClick(konf);
    await backToReview(60000);
  }
  async function approveDocument() {
    const findCheck = () => {
      const bs = Array.from(document.querySelectorAll("svg.tabler-icon-check"))
        .map((s) => s.closest("button"))
        .filter((b) => b && visible(b) && !b.disabled && !b.closest(OWN));
      return bs.find((b) => /bg-success/.test(b.className)) || bs[0] || null;
    };
    const revokeBtn = () => buttonByIcon("rotate-clockwise");
    // Jaringan lambat: tunggu sampai halaman Review benar-benar termuat (tombol ✔ atau Revoke tampil)
    const check = await waitFor(
      () => findCheck() || (revokeBtn() ? "already" : null),
      APPROVE_WAIT_MS,
    );
    if (check === "already") {
      await sleep(800); // beri waktu tombol ✔ muncul kalau halamannya masih memuat
      if (!findCheck()) return "already";
    }
    if (!check)
      throw Object.assign(new Error("tombol Approve (✔) tidak aktif"), {
        retry: true,
      });
    // Tombol Konfirmasi di dialog approve (utamakan yang di dalam dialog & berwarna hijau)
    const findKonf = () => {
      const bs = Array.from(document.querySelectorAll("button")).filter(
        (b) =>
          visible(b) &&
          !b.closest(OWN) &&
          /^(KONFIRMASI|YA|APPROVE|SETUJU)\b/i.test(b.innerText.trim()),
      );
      const pick = (list) =>
        list.find((b) => /bg-success/.test(b.className)) || list[0] || null;
      return (
        pick(bs.filter(inDialog)) ||
        pick(bs.filter((b) => !findCheck() || b !== findCheck()))
      );
    };
    // Berhasil = tombol Revoke tampil, atau dialog sudah tertutup & tombol ✔ hilang
    const approved = () => !!revokeBtn() || (!findKonf() && !findCheck());
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (stopRequested) return;
      await sleep(600);
      // Dialog konfirmasi belum ada -> klik ✔ (lagi)
      if (!findKonf()) {
        const chk = findCheck();
        if (!chk) {
          if (revokeBtn()) return; // sudah ter-approve
          throw Object.assign(new Error("tombol Approve (✔) tidak aktif"), {
            retry: true,
          });
        }
        if (attempt > 1) log(`Klik ✔ lagi (percobaan ${attempt})`);
        triggerClick(chk);
      }
      const ok = await waitFor(() => {
        const b = findKonf();
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!ok) continue;
      await sleep(500); // tunggu animasi dialog selesai supaya klik tidak hilang
      triggerClick(ok);
      // Klik dengan event belum tentu diterima -> cadangan klik bawaan kalau dialog masih terbuka
      if (!(await waitFor(() => !findKonf() || approved(), 3000))) {
        const again = findKonf();
        if (again && !again.disabled) again.click();
      }
      // Tunggu server (jaringan lambat): dialog tertutup & tombol ✔ hilang / Revoke tampil
      if (await waitFor(approved, 30000)) {
        await sleep(500);
        if (approved()) return;
      }
      if (findKonf())
        log(`⚠ Konfirmasi belum terkirim, coba lagi (${attempt}/3)`);
    }
    throw Object.assign(
      new Error("konfirmasi approve tidak terpencet / belum tersimpan"),
      { retry: true },
    );
  }

  // =========================================================================
  // MESIN
  // =========================================================================
  // Dokumen selesai / gagal -> catat, lalu kembali ke halaman daftar yang sama
  function finishDoc(ok, reason) {
    const r = loadRun();
    const cur = r.cur || {};
    r.idleChecks = 0; // ada dokumen yang diproses -> hitungan "sudah habis" diulang
    setItem(cur.kode, {
      nama: cur.nama,
      href: cur.href,
      status: ok ? (/^sudah/.test(reason) ? "already" : "done") : "failed",
      reason,
    });
    if (ok) {
      r.done = (r.done || 0) + 1;
      markDone(cur.kode);
    } else {
      r.failed = [
        ...(r.failed || []),
        { kode: cur.kode, nama: cur.nama, reason },
      ];
      r.skip = [...new Set([...(r.skip || []), cur.kode])];
    }
    r.cur = null;
    r.submitClicked = false;
    r.confirmed = false;
    r.paused = false;
    saveRun(r);
    log(`${ok ? "✅" : "⚠️"} ${cur.kode || ""} ${cur.nama || ""}: ${reason}`);
    if (r.limit && (r.done || 0) + (r.failed || []).length >= r.limit) {
      stopRun("Selesai (batas jumlah tercapai)");
      return goto(listUrl(r.page || 1)); // tetap kembali ke daftar (halaman terakhir)
    }
    // Masih ada dokumen di batch -> langsung buka link Review berikutnya
    const next = (r.batch || []).shift();
    if (next) {
      setPhase("review", { cur: next, batch: r.batch, confirmed: false });
      return goto(next.href);
    }
    // Kembali ke daftar di halaman terakhir. Jumlah halaman bisa berubah setelah approve
    // (dokumen keluar dari filter EDITED) -> dicek lagi: penuh -> maju, kosong -> mundur.
    setPhase("probe", { page: r.page || 1 });
    goto(listUrl(r.page || 1));
  }

  let busy = false;
  async function tick() {
    const run = loadRun();
    if (!run.running || busy || run.hold || run.paused) return;
    if (Date.now() - (run.navAt || 0) < 1200) return; // halaman baru saja dipindah
    if (Date.now() < (run.nextAt || 0)) return; // menunggu sebelum cek ulang daftar
    busy = true;
    stopRequested = false;
    try {
      if (
        run.phase !== "list" &&
        run.phase !== "probe" &&
        Date.now() - (run.phaseAt || 0) > PHASE_TIMEOUT_MS
      ) {
        if (run.cur)
          return finishDoc(
            false,
            `macet di tahap "${run.phase}" lebih dari 4 menit`,
          );
      }
      // 1) Cari halaman terakhir: buka page=N; penuh 100 baris -> N+1; kosong -> N-1
      if (run.phase === "probe") {
        const page = run.page || 1;
        if (!listUrlOk(page)) return goto(listUrl(page));
        await waitTable();
        await ensureStatusFilter();
        const all = readRows();
        const n = all.length;
        if (n >= PER_PAGE) {
          log(`Halaman ${page} penuh, cek halaman ${page + 1}`);
          setPhase("probe", { page: page + 1 });
          return goto(listUrl(page + 1));
        }
        if (n === 0 && page > 1) {
          log(`Halaman ${page} kosong → halaman terakhir ${page - 1}`);
          setPhase("list", { page: page - 1 });
          return goto(listUrl(page - 1));
        }
        log(`Halaman terakhir: ${page} (${n} dokumen)`);
        return setPhase("list", { page });
      }
      // 2) Halaman daftar: ambil baris paling bawah yang belum dilewati
      if (run.phase === "list") {
        const page = run.page || 1;
        if (!listUrlOk(page)) return goto(listUrl(page));
        await waitTable();
        await ensureStatusFilter();
        const skip = new Set(run.skip || []);
        const done = loadDone();
        const edited = readRows().filter(
          (r) => !r.status || isEdited(r.status),
        );
        // Sudah di-approve tapi masih tampil EDITED (server belum memperbarui daftar) -> tidak dibuka lagi
        const stale = edited.filter((r) => done[r.kode]).length;
        if (stale)
          log(
            `${stale} dokumen sudah di-approve tapi masih tampil di daftar (server belum update), dilewati`,
          );
        // Beberapa device: dokumen bagian device lain tidak disentuh
        const rows = edited.filter(
          (r) => !skip.has(r.kode) && !done[r.kode] && mine(r.kode),
        );
        if (!rows.length) {
          if (page > 1) {
            log(`Halaman ${page} sudah habis → halaman ${page - 1}`);
            setPhase("list", { page: page - 1 });
            return goto(listUrl(page - 1));
          }
          // Halaman 1 juga sudah habis. Mode keduanya: lanjut ke status berikutnya dulu.
          const list = statusList();
          const si = Math.min(list.length - 1, run.statusIdx || 0);
          if (si + 1 < list.length) {
            log(`${list[si]} habis → lanjut ${list[si + 1]}`);
            setPhase("probe", { page: 1, statusIdx: si + 1 });
            return goto(listUrl(1));
          }
          // Semua status habis. Bisa jadi ada dokumen yang baru masuk (dari yang dikerjakan manual)
          // -> cek ulang dari awal beberapa kali dulu, baru berhenti kalau memang sudah habis.
          const idle = (run.idleChecks || 0) + 1;
          if (idle <= RECHECKS) {
            log(
              `Tidak ada dokumen ${list.length > 1 ? "EDITED / REVOKED" : list[0]} tersisa — cek ulang ${RECHECK_MS / 1000} detik lagi (${idle}/${RECHECKS})`,
            );
            return setPhase("probe", {
              page: 1,
              statusIdx: 0,
              idleChecks: idle,
              nextAt: Date.now() + RECHECK_MS,
            });
          }
          return stopRun(
            `Selesai ✓ semua dokumen ${list.join(" & ")} sudah habis`,
          );
        }
        // Ambil link Review sampai BATCH dokumen dari baris paling bawah ke atas
        const picks = rows.slice(-BATCH).reverse();
        const cf = loadConf();
        log(
          `Ambil ${picks.length} dokumen terbawah di hal. ${page}${devCount(cf) > 1 ? ` (bagian device ${devSlot(cf)}/${devCount(cf)})` : ""}`,
        );
        const batch = [];
        for (const row of picks) {
          if (stopRequested || !loadRun().running) break;
          const href = await rowLink(row);
          if (href && href.button) {
            // Tombol Review tanpa link: tidak bisa dikumpulkan, klik langsung (kalau antrean masih kosong)
            if (batch.length) break;
            triggerClick(href.button);
            if (!(await waitFor(onReview, 20000))) {
              const r = loadRun();
              r.failed = [
                ...(r.failed || []),
                {
                  kode: row.kode,
                  nama: row.nama,
                  reason: "klik Review tidak membuka dokumen",
                },
              ];
              setItem(row.kode, {
                nama: row.nama,
                status: "failed",
                reason: "klik Review tidak membuka dokumen",
              });
              r.skip = [...new Set([...(r.skip || []), row.kode])];
              saveRun(r);
              return;
            }
            log(`▶ ${row.kode} ${row.nama}`);
            return setPhase("review", {
              cur: { kode: row.kode, nama: row.nama, href: location.href },
              batch: [],
              confirmed: false,
            });
          }
          await closeReviewCard();
          if (href && batch.some((x) => x.href === href)) {
            log(
              `⚠ ${row.kode}: link Review sama dengan dokumen lain di antrean, dilewati dulu`,
            );
            continue;
          }
          if (href) {
            batch.push({ kode: row.kode, nama: row.nama, href });
            setItem(row.kode, {
              nama: row.nama,
              href,
              status: "antre",
              reason: "",
              page,
            });
          } else {
            const r = loadRun();
            r.failed = [
              ...(r.failed || []),
              {
                kode: row.kode,
                nama: row.nama,
                reason: "tombol Review tidak muncul di daftar",
              },
            ];
            setItem(row.kode, {
              nama: row.nama,
              status: "failed",
              reason: "tombol Review tidak muncul di daftar",
            });
            r.skip = [...new Set([...(r.skip || []), row.kode])];
            saveRun(r);
          }
          await sleep(150);
        }
        if (!batch.length)
          return log(
            "⚠ tidak ada link Review yang bisa diambil di halaman ini",
          );
        const first = batch.shift();
        log(`▶ ${first.kode} ${first.nama} (+${batch.length} lagi di antrean)`);
        setPhase("review", { cur: first, batch, confirmed: false });
        return goto(first.href);
      }
      const cur = run.cur || {};
      // Langsung Approve di halaman Review (tanpa Edit, tanpa Kirim, tanpa toggle anomali)
      if (run.phase === "review" || run.phase === "approve") {
        if (!onReview()) return goto(cur.href);
        if (loadConf().testMode && !run.confirmed) {
          const r = loadRun();
          r.paused = true;
          saveRun(r);
          return log(
            'MODE UJI: siap Approve. Periksa, lalu klik "Approve sekarang" atau "Lewati"',
          );
        }
        log("Approve");
        const res = await approveDocument();
        return finishDoc(
          true,
          res === "already"
            ? "sudah di-approve (tombol Revoke tampil), dilewati"
            : "approve",
        );
      }
    } catch (e) {
      console.error(`[${APP.name}]`, e);
      pressKey("Escape");
      const now = loadRun();
      // Halaman Review belum termuat sempurna (jaringan lambat) -> muat ulang & coba lagi, bukan langsung gagal
      if (e.retry && now.cur && (now.cur.tries || 0) + 1 < RETRIES) {
        now.cur.tries = (now.cur.tries || 0) + 1;
        now.phaseAt = Date.now();
        now.navAt = Date.now();
        saveRun(now);
        log(
          `⏳ ${e.message} — jaringan lambat? muat ulang halaman (percobaan ${now.cur.tries + 1}/${RETRIES})`,
        );
        location.reload();
        return;
      }
      if (["list", "probe"].includes(loadRun().phase)) log(`⚠ ${e.message}`);
      else finishDoc(false, e.message);
    } finally {
      busy = false;
    }
  }

  // Ulangi dokumen yang gagal: yang punya link langsung dibuka & di-approve; yang belum punya link
  // (tombol Review tidak muncul) cukup dikeluarkan dari daftar dilewati supaya ikut terambil lagi dari tabel.
  function retryItems(kodes) {
    const all = loadItems();
    const list = kodes.map((k) => all[k]).filter(Boolean);
    if (!list.length) return;
    const r0 = loadRun();
    const set = new Set(kodes);
    const skip = (r0.skip || []).filter((k) => !set.has(k));
    const failed = (r0.failed || []).filter((f) => !set.has(f.kode));
    list.forEach((it) =>
      setItem(it.kode, { status: "antre", reason: "diulang" }),
    );
    const withLink = list
      .filter((it) => it.href)
      .map((it) => ({ kode: it.kode, nama: it.nama, href: it.href }));
    if (r0.running) {
      // Sedang berjalan: masukkan ke depan antrean
      r0.batch = [...withLink, ...(r0.batch || [])];
      r0.skip = skip;
      r0.failed = failed;
      saveRun(r0);
      return log(`↻ ${list.length} dokumen dimasukkan lagi ke antrean`);
    }
    const conf = loadConf();
    conf.testMode = false;
    saveConf(conf);
    const first = withLink.shift();
    saveRun({
      running: true,
      limit: 0,
      phase: first ? "review" : "probe",
      phaseAt: Date.now(),
      page: r0.page || 1,
      cur: first || null,
      batch: withLink,
      idleChecks: 0,
      nextAt: 0,
      done: 0,
      failed,
      skip,
      logs: [],
      boxOpen: true,
    });
    log(`↻ Ulangi ${list.length} dokumen`);
    if (first) goto(first.href);
  }

  function startRun(testMode) {
    const conf = loadConf();
    conf.testMode = !!testMode;
    saveConf(conf);
    saveRun({
      running: true,
      limit: testMode ? 1 : conf.limit || 0, // uji = 1 dokumen saja
      phase: "probe",
      phaseAt: Date.now(),
      page: 1,
      statusIdx: 0,
      batch: [],
      idleChecks: 0,
      nextAt: 0,
      done: 0,
      failed: [],
      skip: loadRun().skip || [], // dokumen bergalat sebelumnya tetap dilewati (hapus lewat tombol Reset)
      logs: [],
    });
    log(
      `Mulai${testMode ? " · MODE UJI" : ""}: cari halaman terakhir (${modeOf(conf).label}, ${PER_PAGE}/halaman)`,
    );
  }
  function stopRun(msg) {
    const r = loadRun();
    r.running = false;
    r.paused = false;
    r.hold = false;
    saveRun(r);
    stopRequested = true;
    log(msg || "Dihentikan.");
  }

  // =========================================================================
  // TAMPILAN (kotak kendali + bar status)
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById("fsa-style")) return;
    const st = document.createElement("style");
    st.id = "fsa-style";
    st.textContent = `
      #fsa-box, #fsa-box *, #fsa-launch { box-sizing:border-box; font-family:"Inter",ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif; }
      #fsa-launch { position:fixed; left:16px; z-index:999999; border:none; border-radius:999px; padding:10px 16px 10px 12px; background:linear-gradient(120deg,#0f766e,#0891b2); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 28px rgba(8,145,178,.4); transition:transform .15s; }
      #fsa-launch:hover { transform:translateY(-2px); }
      #fsa-launch b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 6px; font-size:11.5px; margin-right:6px; }
      #fsa-box { --ok:#22c55e; --bad:#f87171; --acc:#818cf8; --warn:#fbbf24; --mut:#9aa0c3; --line:rgba(255,255,255,.08); --card:rgba(255,255,255,.04);
        position:fixed; right:16px; bottom:16px; z-index:1000002; width:min(940px,96vw); max-height:92vh; display:flex; flex-direction:column;
        background:linear-gradient(160deg,rgba(23,26,48,.97),rgba(13,15,30,.97)); color:#eef0ff; border:1px solid var(--line); border-radius:18px;
        box-shadow:0 24px 60px rgba(5,6,20,.55); font-size:13px; overflow:hidden; backdrop-filter:blur(8px); }
      #fsa-box .top { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line); cursor:move; user-select:none; background:rgba(255,255,255,.02); }
      #fsa-box .logo { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; font-weight:800; background:linear-gradient(135deg,#0f766e,#0891b2); box-shadow:0 6px 16px rgba(8,145,178,.35); flex:none; }
      #fsa-box .ttl { display:flex; flex-direction:column; line-height:1.2; min-width:0; }
      #fsa-box .ttl b { font-size:14px; }
      #fsa-box .ttl span { color:var(--mut); font-size:11.5px; }
      #fsa-box .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:11.5px; font-weight:650; background:rgba(255,255,255,.06); border:1px solid var(--line); white-space:nowrap; }
      #fsa-box .pill i { width:8px; height:8px; border-radius:50%; background:var(--c,#64748b); box-shadow:0 0 0 3px color-mix(in srgb,var(--c,#64748b) 25%,transparent); }
      #fsa-box .pill.live i { animation:fsapulse 1.4s ease-in-out infinite; }
      @keyframes fsapulse { 50% { opacity:.35; } }
      #fsa-box .sp { flex:1; }
      #fsa-box button { border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#eef0ff; border-radius:10px; padding:7px 12px; font-size:12.5px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s,transform .1s; }
      #fsa-box button:hover { background:rgba(255,255,255,.13); }
      #fsa-box button:active { transform:scale(.97); }
      #fsa-box button.go { background:linear-gradient(135deg,#16a34a,#15803d); border-color:transparent; box-shadow:0 6px 16px rgba(22,163,74,.3); }
      #fsa-box button.go:hover { filter:brightness(1.1); }
      #fsa-box button.big { padding:10px 18px; font-size:13.5px; }
      #fsa-box button.stop { background:rgba(248,113,113,.1); border-color:rgba(248,113,113,.4); color:#fca5a5; }
      #fsa-box button.ghost { background:transparent; }
      #fsa-box .cols { display:flex; gap:0; min-height:0; flex:1; }
      #fsa-box .col-l { flex:1.05 1 0; min-width:0; padding:14px 16px; overflow:auto; }
      #fsa-box .col-r { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border-left:1px solid var(--line); padding:14px 16px; min-height:0; }
      @media (max-width:760px) { #fsa-box .cols { flex-direction:column; overflow:auto; } #fsa-box .col-r { border-left:none; border-top:1px solid var(--line); } }
      #fsa-box .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
      #fsa-box .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:9px 10px; }
      #fsa-box .stat b { display:block; font-size:20px; font-weight:750; color:var(--c,#eef0ff); line-height:1.1; font-variant-numeric:tabular-nums; }
      #fsa-box .stat span { color:var(--mut); font-size:11px; }
      #fsa-box .cur { margin-top:10px; display:flex; gap:10px; align-items:center; background:rgba(129,140,248,.1); border:1px solid rgba(129,140,248,.3); border-radius:12px; padding:9px 12px; }
      #fsa-box .cur .k { font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#c7d2fe; }
      #fsa-box .cur .n { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #fsa-box .sec { margin-top:12px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
      #fsa-box .sec h4 { margin:0 0 8px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); font-weight:700; }
      #fsa-box .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      #fsa-box .row + .row { margin-top:10px; }
      #fsa-box label { display:inline-flex; gap:6px; align-items:center; font-size:12.5px; cursor:pointer; color:#d6d9f0; }
      #fsa-box select, #fsa-box input[type=number] { background:rgba(0,0,0,.35); color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:8px; padding:5px 8px; font-size:12.5px; outline:none; }
      #fsa-box select:focus, #fsa-box input[type=number]:focus { border-color:var(--acc); }
      #fsa-box input[type=number] { width:70px; }
      #fsa-box select option { color:#000; }
      #fsa-box .hint { color:var(--mut); font-size:11.5px; margin-top:10px; line-height:1.5; }
      #fsa-box .lbl { display:flex; align-items:center; gap:8px; margin-top:12px; margin-bottom:6px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); font-weight:700; }
      #fsa-box .log { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; background:rgba(0,0,0,.35); border:1px solid var(--line); border-radius:10px; padding:8px 10px; line-height:1.6; max-height:150px; overflow:auto; }
      #fsa-box .log div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#b8bdd9; }
      #fsa-box .log div:last-child { color:#fde68a; }
      #fsa-box .rh { display:flex; align-items:center; gap:8px; }
      #fsa-box .rh b { font-size:13.5px; }
      #fsa-box .count { background:rgba(255,255,255,.08); border-radius:999px; padding:1px 8px; font-size:11.5px; color:var(--mut); }
      #fsa-box .tabs { display:flex; gap:2px; flex-wrap:wrap; margin-top:10px; background:rgba(0,0,0,.25); border:1px solid var(--line); border-radius:10px; padding:3px; }
      #fsa-box .tabs button { border:none; background:transparent; padding:5px 9px; font-size:11.5px; color:var(--mut); border-radius:7px; }
      #fsa-box .tabs button.on { background:rgba(129,140,248,.22); color:#fff; }
      #fsa-box .tabs button em { font-style:normal; opacity:.7; margin-left:3px; }
      #fsa-box .acts { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
      #fsa-box .acts button { padding:5px 10px; font-size:11.5px; }
      #fsa-box .acts .retry { background:rgba(248,113,113,.12); border-color:rgba(248,113,113,.4); color:#fecaca; }
      #fsa-box .items { margin-top:8px; flex:1; min-height:120px; max-height:min(420px,52vh); overflow:auto; display:flex; flex-direction:column; gap:5px; padding-right:2px; }
      #fsa-box .it { display:flex; gap:8px; align-items:center; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--c); border-radius:10px; padding:6px 8px 6px 10px; font-size:12px; transition:background .15s; }
      #fsa-box .it:hover { background:rgba(255,255,255,.07); }
      #fsa-box .it .nm { flex:1; min-width:0; }
      #fsa-box .it .nm div { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
      #fsa-box .it .nm code { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--mut); }
      #fsa-box .it .nm small { display:block; color:#fca5a5; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #fsa-box .chip { color:var(--c); background:color-mix(in srgb,var(--c) 16%,transparent); border-radius:999px; padding:2px 8px; font-weight:700; font-size:10.5px; white-space:nowrap; }
      #fsa-box .it a, #fsa-box .it button { padding:3px 8px; font-size:12px; color:#eef0ff; text-decoration:none; border:1px solid rgba(255,255,255,.12); border-radius:8px; background:rgba(255,255,255,.05); }
      #fsa-box .empty { margin-top:16px; color:var(--mut); font-size:12px; text-align:center; padding:24px 10px; border:1px dashed var(--line); border-radius:12px; }
      #fsa-box ::-webkit-scrollbar { width:8px; height:8px; }
      #fsa-box ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12); border-radius:8px; }
    `;
    document.head.appendChild(st);
  }

  let sig = "";
  let viewFilter = "all";
  function render() {
    if (!document.body) return;
    ensureStyles();
    let launch = document.getElementById("fsa-launch");
    if (!launch) {
      launch = document.createElement("button");
      launch.id = "fsa-launch";
      launch.style.bottom = `${APP.launchBottom}px`;
      launch.innerHTML = `<b>✔</b>Auto Approve`;
      launch.title = `Buka kotak kendali (Alt+${APP.hotkey})`;
      launch.onclick = () => {
        const r = loadRun();
        r.boxOpen = !r.boxOpen;
        saveRun(r);
        sig = "";
        render();
      };
      document.body.appendChild(launch);
    }
    const run = loadRun();
    const conf = loadConf();
    let box = document.getElementById("fsa-box");
    if (!run.running && !run.boxOpen) {
      if (box) box.remove();
      sig = "";
      return;
    }
    const items = Object.values(loadItems()).sort(
      (a, b) => (b.at || 0) - (a.at || 0),
    );
    const s = JSON.stringify([
      run,
      conf,
      items.length,
      items[0] && items[0].at,
      viewFilter,
    ]);
    if (s === sig && box) return;
    sig = s;
    if (!box) {
      box = document.createElement("div");
      box.id = "fsa-box";
      box.addEventListener("click", onClick);
      box.addEventListener("change", onChange);
      box.addEventListener("keydown", (e) => e.stopPropagation());
      makeDraggable(box);
      document.body.appendChild(box);
      const pos = loadJson(POS_KEY, null);
      if (pos)
        Object.assign(box.style, {
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          right: "auto",
          bottom: "auto",
        });
    }
    const failed = run.failed || [];
    const PH = {
      probe: "Cari halaman terakhir",
      list: "Pilih dokumen",
      review: "Approve",
      approve: "Approve",
    };
    const st = !run.running
      ? { t: "Berhenti", c: "#64748b" }
      : run.hold
        ? { t: "Dijeda", c: "#fbbf24" }
        : run.paused
          ? { t: "Menunggu konfirmasi", c: "#fbbf24" }
          : { t: PH[run.phase] || run.phase || "Berjalan", c: "#22c55e", live: true };
    const skipOld = (run.skip || []).length - failed.length;
    const statTile = (n, label, c) =>
      `<div class="stat" style="--c:${c}"><b>${n}</b><span>${label}</span></div>`;
    box.innerHTML = `
      <div class="top">
        <div class="logo">✔</div>
        <div class="ttl"><b>${esc(APP.name)}</b><span>v${esc(APP.version)} · ${esc(run.running ? curStatus() : modeOf(conf).label)}</span></div>
        <span class="pill${st.live ? " live" : ""}" style="--c:${st.c}"><i></i>${esc(st.t)}${conf.testMode && run.running ? " · uji" : ""}</span>
        ${devCount(conf) > 1 ? `<span class="pill" style="--c:#818cf8"><i></i>Device ${devSlot(conf)}/${devCount(conf)}</span>` : ""}
        <span class="sp"></span>
        ${
          run.running
            ? `${run.paused ? `<button class="go" data-a="send">✓ Approve sekarang</button><button data-a="pass">Lewati</button>` : ""}
               ${run.hold ? `<button class="go" data-a="resume">▶ Lanjut</button>` : `<button data-a="hold">⏸ Jeda</button>`}
               <button class="stop" data-a="stop">■ Stop</button>`
            : `<button class="ghost" data-a="close" title="Tutup (Alt+${APP.hotkey})">✕</button>`
        }
      </div>
      <div class="cols"><div class="col-l">
        <div class="stats">
          ${statTile(run.done || 0, "Di-approve", "#4ade80")}
          ${statTile(failed.length, `Dilewati${skipOld > 0 ? ` (+${skipOld} lama)` : ""}`, failed.length ? "#f87171" : "#eef0ff")}
          ${statTile((run.batch || []).length + (run.cur ? 1 : 0), "Antrean", "#a5b4fc")}
          ${statTile(run.page || "–", "Halaman", "#eef0ff")}
        </div>
        ${run.cur ? `<div class="cur"><span class="pill live" style="--c:#818cf8"><i></i>Proses</span><div style="min-width:0"><div class="n">${esc(run.cur.nama || "")}</div><div class="k">${esc(run.cur.kode)}</div></div></div>` : ""}
        ${
          run.running
            ? ""
            : `<div class="sec">
                <h4>Jalankan</h4>
                <div class="row">
                  <button class="go big" data-a="start">▶ Mulai approve</button>
                  <button data-a="test">🧪 Uji 1 dokumen</button>
                </div>
                <div class="row">
                  <label>Status <select data-c="statusMode">${Object.entries(STATUS_MODES).map(([k, v]) => `<option value="${k}"${modeOf(conf) === v ? " selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
                </div>
                <div class="row">
                  <label>Batas <input type="number" min="0" data-c="limit" value="${conf.limit || 0}"> dokumen <span class="m" style="color:var(--mut)">(0 = semua)</span></label>
                </div>
              </div>
              <div class="sec" title="Jalankan di beberapa device sekaligus tanpa bentrok: isi jumlah device yang sama di semua device, lalu tiap device pilih nomor bagian yang berbeda">
                <h4>Beberapa device</h4>
                <div class="row">
                  <label>Jumlah device <select data-c="devices">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option value="${n}"${devCount(conf) === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
                  ${devCount(conf) > 1 ? `<label>Device ini bagian <select data-c="slot">${Array.from({ length: devCount(conf) }, (_, i) => i + 1).map((n) => `<option value="${n}"${devSlot(conf) === n ? " selected" : ""}>${n}</option>`).join("")}</select> dari ${devCount(conf)}</label>` : ""}
                </div>
                <div class="hint" style="margin-top:8px">${devCount(conf) > 1 ? "Tiap device hanya mengerjakan bagiannya sendiri (dibagi dari kode dokumen) — tidak akan bentrok." : "Pakai lebih dari 1 device? Isi jumlah device yang sama di semua device, lalu pilih bagian yang berbeda."}</div>
              </div>
              <div class="hint">Buka daftar <b>${esc(modeOf(conf).label)}</b> (${PER_PAGE} baris/halaman), kerjakan dari <b>halaman & baris paling belakang</b>: Review → langsung <b>Approve</b>. Yang gagal dicatat di kanan & bisa diulang. <button class="ghost" data-a="reset" style="padding:3px 8px;font-size:11.5px;margin-left:4px" title="Dokumen yang tadinya gagal dicoba lagi saat Mulai">↻ Reset daftar dilewati</button></div>`
        }
        <div class="lbl">Log</div>
        <div class="log">${(run.logs || []).map((l) => `<div title="${esc(l)}">${esc(l)}</div>`).join("") || "<div>…</div>"}</div>
      </div>
      <div class="col-r">
        <div class="rh"><b>📋 Dokumen ditarik</b><span class="count">${items.length}</span></div>
        ${itemsHtml(items) || '<div class="empty">Belum ada dokumen.<br>Daftar terisi saat skrip mengambil link Review dari tabel.</div>'}
      </div></div>`;
  }
  function itemsHtml(items) {
    if (!items.length) return "";
    const n = (k) => items.filter((x) => x.status === k).length;
    const shown = items
      .filter((x) => viewFilter === "all" || x.status === viewFilter)
      .slice(0, 200);
    const tab = (k, l) =>
      `<button data-f="${k}" class="${viewFilter === k ? "on" : ""}">${l}<em>${k === "all" ? items.length : n(k)}</em></button>`;
    return `<div class="tabs">${tab("all", "Semua")}${Object.entries(ITEM_STATUS)
      .map(([k, v]) => tab(k, v.label))
      .join("")}</div>
      <div class="acts">
        ${n("failed") ? `<button class="retry" data-a="retryall" title="Approve ulang semua dokumen yang gagal">↻ Ulangi semua gagal (${n("failed")})</button>` : ""}
        <span class="sp"></span>
        <button data-a="csv" title="Unduh daftar sebagai CSV">⬇ CSV</button>
        <button class="ghost" data-a="clearitems" title="Kosongkan daftar ini (tidak mengubah FASIH)">🗑 Kosongkan</button>
      </div>
      <div class="items">${
        shown
          .map((x) => {
            const st = ITEM_STATUS[x.status] || ITEM_STATUS.antre;
            return `<div class="it" style="--c:${st.color}">
              <div class="nm"><div title="${esc(x.nama || "")}">${esc(x.nama || "(tanpa nama)")}</div><code>${esc(x.kode)}</code>${x.reason && x.status === "failed" ? `<small title="${esc(x.reason)}">${esc(x.reason)}</small>` : ""}</div>
              <span class="chip">${st.label}</span>
              ${x.href ? `<a href="${esc(x.href)}" target="_blank" title="Buka di tab baru">↗</a>` : ""}
              ${x.status === "failed" ? `<button data-retry="${esc(x.kode)}" title="Approve ulang dokumen ini">↻</button>` : ""}</div>`;
          })
          .join("") || '<div class="empty">Tidak ada dokumen di kategori ini.</div>'
      }</div>`;
  }
  function exportCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = Object.values(loadItems()).map((x) =>
      [
        x.kode,
        x.nama,
        (ITEM_STATUS[x.status] || {}).label || x.status,
        x.reason,
        x.href,
        x.at ? new Date(x.at).toLocaleString("id-ID") : "",
      ]
        .map(cell)
        .join(","),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob(
        [
          String.fromCharCode(0xfeff) +
            ["kode,nama,status,keterangan,link,waktu", ...rows].join(
              String.fromCharCode(10),
            ),
        ],
        {
          type: "text/csv",
        },
      ),
    );
    a.download = `approve-edited-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.csv`;
    a.click();
  }
  function onClick(e) {
    const f = e.target.closest("[data-f]");
    if (f) {
      viewFilter = f.dataset.f;
      sig = "";
      return render();
    }
    const rt = e.target.closest("[data-retry]");
    if (rt) {
      retryItems([rt.dataset.retry]);
      sig = "";
      return render();
    }
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "retryall")
      retryItems(
        Object.values(loadItems())
          .filter((x) => x.status === "failed")
          .map((x) => x.kode),
      );
    if (a === "csv") exportCsv();
    if (
      a === "clearitems" &&
      confirm(
        "Kosongkan daftar dokumen di kotak ini? (status di FASIH tidak berubah)",
      )
    )
      saveJson(ITEMS_KEY, {});
    if (a === "start") startRun(false);
    if (a === "test") startRun(true);
    if (a === "stop") stopRun("Dihentikan.");
    if (a === "hold" || a === "resume") {
      const r = loadRun();
      r.hold = a === "hold";
      if (a === "resume") r.phaseAt = Date.now();
      saveRun(r);
      log(a === "hold" ? "⏸ Dijeda" : "▶ Dilanjutkan");
    }
    if (a === "send") {
      const r = loadRun();
      r.paused = false;
      r.confirmed = true;
      r.phaseAt = Date.now();
      saveRun(r);
      log("Approve sekarang");
    }
    if (a === "pass") {
      const r = loadRun();
      r.paused = false;
      saveRun(r);
      finishDoc(false, "MODE UJI: tidak di-approve");
    }
    if (a === "reset") {
      const r = loadRun();
      r.skip = [];
      r.failed = [];
      saveRun(r);
      log("Daftar dokumen yang dilewati dikosongkan");
    }
    if (a === "close") {
      const r = loadRun();
      r.boxOpen = false;
      saveRun(r);
    }
    sig = "";
    render();
  }
  function onChange(e) {
    const k = e.target.dataset.c;
    if (!k) return;
    const c = loadConf();
    c[k] =
      e.target.type === "checkbox"
        ? e.target.checked
        : k === "statusMode"
          ? e.target.value
          : Math.max(0, Number(e.target.value) || 0);
    saveConf(c);
    sig = "";
    render();
  }
  function makeDraggable(el) {
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
      const move = (ev) =>
        Object.assign(el.style, {
          left: `${Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 160)}px`,
          top: `${Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40)}px`,
          right: "auto",
          bottom: "auto",
        });
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const b = el.getBoundingClientRect();
        saveJson(POS_KEY, { x: Math.round(b.left), y: Math.round(b.top) });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".top") || e.target.closest("button")) return;
      saveJson(POS_KEY, null);
      Object.assign(el.style, { left: "", top: "", right: "", bottom: "" });
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === APP.hotkey) {
      e.preventDefault();
      const r = loadRun();
      r.boxOpen = !r.boxOpen;
      saveRun(r);
      sig = "";
      render();
    }
  });

  setInterval(() => {
    render();
    if (loadRun().running) tick();
  }, 1000);
  console.log(
    `[${APP.name} v${APP.version}] Aktif. Tombol di kiri bawah (Alt+${APP.hotkey}).`,
  );
})();
