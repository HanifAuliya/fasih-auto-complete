// ==UserScript==
// @name         FASIH Submit & Approve (status EDITED BY Admin Kabupaten, dari belakang)
// @namespace    hanif-bps-hst
// @version      1.0
// @description  Tanpa Excel/link: buka halaman data survei dengan filter status "EDITED BY Admin Kabupaten" (100 baris per halaman), ambil dokumen dari halaman & baris PALING BELAKANG (yang depan mungkin masih dikerjakan manual), buka Review -> Edit -> Kirim -> Approve, lalu kembali ke daftar. Dokumen bergalat dilewati & dicatat. Mode uji berhenti sebelum Kirim.
// @match        https://fasih-sm.bps.go.id/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Halaman daftar data survei + filter status (dari alamat yang dipakai di FASIH)
  const LIST_PATH =
    "/app/surveys/a0429e96-51a5-477b-a415-485f9c153004/fd68e454-ba45-4b85-8205-f3bf777ded24/data";
  const STATUS_FILTER = "EDITED BY Admin Kabupaten";
  const PER_PAGE = 100;

  const APP = { name: "Submit & Approve", version: "1.0", hotkey: "0", launchBottom: 400 };
  const RUN_KEY = "fsa_run";
  const CONF_KEY = "fsa_conf";
  const POS_KEY = "fsa_pos";
  const PHASE_TIMEOUT_MS = 4 * 60 * 1000;

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
  const loadConf = () => ({ approve: true, testMode: false, limit: 0, ...loadJson(CONF_KEY, {}) });
  const saveConf = (c) => saveJson(CONF_KEY, c);

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
    !!el && (el.offsetParent !== null || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  function triggerClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    });
  }
  function pressKey(key) {
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, keyCode: key === "Enter" ? 13 : 27, bubbles: true }),
    );
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

  function log(msg) {
    console.log(`[${APP.name}] ${msg}`);
    const r = loadRun();
    r.logs = [...(r.logs || []), `${new Date().toLocaleTimeString("id-ID")} ${msg}`].slice(-8);
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
  const onReview = () => /\/app\/assignment\/[^/]+\/[^/]+\/?$/.test(location.pathname);
  const onEdit = () => /\/app\/assignment\/[^/]+\/[^/]+\/edit/.test(location.pathname);
  function listUrl(page) {
    const u = new URL(location.origin + LIST_PATH);
    u.searchParams.set("page", String(page || 1));
    u.searchParams.set("perPage", String(PER_PAGE));
    u.searchParams.set("status", STATUS_FILTER);
    return u.toString();
  }
  // Halaman daftar yang terbuka sudah memakai filter status, 100 baris, dan halaman yang diminta?
  function listUrlOk(page) {
    if (!onList()) return false;
    const p = new URLSearchParams(location.search);
    return (
      p.get("status") === STATUS_FILTER && Number(p.get("perPage")) === PER_PAGE && Number(p.get("page") || 1) === page
    );
  }
  function goto(url) {
    const r = loadRun();
    r.navAt = Date.now();
    saveRun(r);
    location.href = url;
  }

  const tableText = () => (document.querySelector("table tbody") || {}).innerText || "";
  const isLoading = () =>
    Array.from(document.querySelectorAll('[class*="animate-spin"], [class*="skeleton"], [aria-busy="true"]')).some(
      (el) => visible(el) && !el.closest(OWN),
    ) || /loading|memuat/i.test(tableText());
  // Tunggu tabel termuat & diam sebentar (tanpa indikator loading)
  async function waitTable() {
    if (!(await waitFor(() => document.querySelector("table thead"), 30000))) throw new Error("tabel data tidak muncul");
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
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.innerText.trim().toUpperCase());
    const idx = (part) => heads.findIndex((h) => h.includes(part));
    const iKode = idx("KODE");
    const iNama = idx("NAMA");
    const iStatus = idx("STATUS");
    return Array.from(table.querySelectorAll("tbody tr"))
      .filter((tr) => tr.querySelectorAll("td").length > 2)
      .map((tr) => {
        const cells = tr.querySelectorAll("td");
        const text = (i) => (i >= 0 && cells[i] ? cells[i].innerText.trim() : "");
        const kodeBtn = (iKode >= 0 && cells[iKode] && cells[iKode].querySelector("button:not([title])")) || null;
        return {
          tr,
          kode: kodeBtn ? kodeBtn.innerText.trim() : text(iKode),
          nama: text(iNama),
          status: text(iStatus),
          kodeBtn,
        };
      });
  }
  // Link Review dokumen pada satu baris (langsung di baris, atau muncul setelah kodenya diklik)
  async function rowLink(row) {
    const direct = Array.from(row.tr.querySelectorAll("a[href]")).find((a) => REVIEW_HREF.test(a.href));
    if (direct) return direct.href;
    const links = () =>
      Array.from(document.querySelectorAll("a[href]")).filter((a) => REVIEW_HREF.test(a.href) && !a.closest(OWN));
    const before = new Set(links().map((a) => a.href));
    for (const target of [row.kodeBtn, row.tr.querySelector('[role="checkbox"]'), row.tr]) {
      if (!target) continue;
      triggerClick(target);
      const a = await waitFor(() => links().find((x) => visible(x) && !before.has(x.href)), 4000);
      if (a) return a.href;
    }
    return null;
  }

  // =========================================================================
  // REVIEW -> EDIT -> KIRIM -> APPROVE (sama dengan skrip koreksi lain)
  // =========================================================================
  async function reviewToEdit() {
    await waitFor(() => buttonByIcon("edit") || buttonByIcon("rotate-clockwise"), 20000);
    await sleep(600);
    let edit = buttonByIcon("edit");
    if (!edit || edit.disabled) {
      const revoke = buttonByIcon("rotate-clockwise");
      if (!revoke || revoke.disabled) throw new Error("tombol Edit & Revoke tidak aktif");
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
    if (!(await waitFor(() => onEdit() && document.querySelector(".fasih-form-sidebar"), 30000)))
      throw new Error("halaman edit tidak terbuka");
    await sleep(1500);
  }

  const sidebarItem = (title) => {
    const sq = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const items = Array.from(document.querySelectorAll(".fasih-form-sidebar [title]"));
    return items.find((el) => sq(el.getAttribute("title")) === sq(title)) || null;
  };
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
      return !!s && (s.checked || s.getAttribute("aria-checked") === "true" || (c && c.hasAttribute("data-checked")));
    };
    for (const attempt of [() => triggerClick(control() || findAnomaliSwitch()), () => findAnomaliSwitch().click()]) {
      if (isOn()) break;
      attempt();
      await waitFor(isOn, 2500);
    }
    if (isOn()) await sleep(1200);
  }

  const isKirimText = (b) => b.innerText.trim().toUpperCase() === "KIRIM";
  const inDialog = (b) => !!b.closest('[role="dialog"], [role="alertdialog"]');
  const hasSendIcon = (b) => !!b.querySelector('svg path[d^="M10 14l11 -11"], svg.tabler-icon-send');
  function findNavKirim() {
    const bs = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !inDialog(b) && !b.closest(OWN),
    );
    return bs.find(hasSendIcon) || bs.find((b) => b.id === "fasih-form-nav-submit-button") || bs[0] || null;
  }
  function findDialogKirim() {
    const bs = Array.from(document.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && isKirimText(b) && !b.closest(OWN),
    );
    return bs.find(inDialog) || bs.find((b) => !hasSendIcon(b) && b.id !== "fasih-form-nav-submit-button") || null;
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
        const t = card.querySelector("div[title]");
        return `${t ? t.getAttribute("title").trim() : "?"} (${Array.from(card.querySelectorAll("li"))
          .map((li) => li.innerText.trim())
          .join(", ")})`;
      });
  }
  function closeDialogs() {
    Array.from(document.querySelectorAll('button[aria-label="Dismiss"]'))
      .filter(visible)
      .forEach((b) => triggerClick(b));
    if (Array.from(document.querySelectorAll('[role="dialog"]')).some(visible)) pressKey("Escape");
  }
  const dialogText = () => {
    const d = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible).pop();
    return d ? d.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  };
  const backButton = () =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => /KEMBALI KE REVIEW/i.test(b.innerText) && b.getClientRects().length > 0,
    );
  async function backToReview(timeoutMs) {
    const sign = await waitFor(() => backButton() || (!onEdit() ? "left" : null), timeoutMs);
    if (!sign) throw new Error(`tidak ada tanda terkirim setelah Konfirmasi: ${dialogText() || "cek manual"}`);
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
    await waitFor(() => summaryCount("GALAT") || findDialogKirim() || readGalatList().length, 15000);
    await sleep(1200);
    const galat = summaryCount("GALAT");
    if ((galat && galat.n > 0) || (readGalatList().length && !galat)) {
      if (galat && galat.btn && !readGalatList().length) {
        triggerClick(galat.btn);
        await waitFor(() => readGalatList().length, 6000);
      }
      const detail = readGalatList().join("; ");
      closeDialogs();
      throw new Error(`galat ${galat ? galat.n : readGalatList().length}: ${detail || "lihat di FASIH"}`);
    }
    const dk = findDialogKirim();
    if (!dk) throw new Error(`tombol Kirim di dialog tidak muncul: ${dialogText()}`);
    const r = loadRun();
    r.submitClicked = true;
    saveRun(r);
    triggerClick(dk);
    const konf = await waitFor(() => buttonByText("Konfirmasi"), 15000);
    if (!konf) throw new Error(`tombol Konfirmasi tidak muncul: ${dialogText()}`);
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
    const check = await waitFor(findCheck, 25000);
    if (!check) throw new Error("tombol Approve (✔) tidak aktif");
    await sleep(600);
    triggerClick(check);
    const ok = await waitFor(() => {
      const bs = Array.from(document.querySelectorAll("button")).filter(
        (b) => visible(b) && !b.disabled && b.innerText.trim().toUpperCase() === "KONFIRMASI" && !b.closest(OWN),
      );
      return bs.find((b) => /bg-success/.test(b.className)) || bs[0] || null;
    }, 10000);
    if (!ok) throw new Error("konfirmasi approve tidak muncul");
    await sleep(400);
    triggerClick(ok);
    await sleep(2500);
  }

  // =========================================================================
  // MESIN
  // =========================================================================
  // Dokumen selesai / gagal -> catat, lalu kembali ke halaman daftar yang sama
  function finishDoc(ok, reason) {
    const r = loadRun();
    const cur = r.cur || {};
    if (ok) r.done = (r.done || 0) + 1;
    else {
      r.failed = [...(r.failed || []), { kode: cur.kode, nama: cur.nama, reason }];
      r.skip = [...new Set([...(r.skip || []), cur.kode])];
    }
    r.cur = null;
    r.submitClicked = false;
    r.confirmed = false;
    r.paused = false;
    saveRun(r);
    log(`${ok ? "✅" : "⚠️"} ${cur.kode || ""} ${cur.nama || ""}: ${reason}`);
    if (r.limit && (r.done || 0) + (r.failed || []).length >= r.limit) return stopRun("Selesai (batas jumlah tercapai)");
    setPhase("list");
    goto(listUrl(r.page || 1));
  }

  let busy = false;
  async function tick() {
    const run = loadRun();
    if (!run.running || busy || run.hold || run.paused) return;
    if (Date.now() - (run.navAt || 0) < 2500) return; // halaman baru saja dipindah
    busy = true;
    stopRequested = false;
    try {
      if (run.phase !== "list" && run.phase !== "probe" && Date.now() - (run.phaseAt || 0) > PHASE_TIMEOUT_MS) {
        if (run.cur) return finishDoc(false, `macet di tahap "${run.phase}" lebih dari 4 menit`);
      }
      // 1) Cari halaman terakhir: buka page=N; penuh 100 baris -> N+1; kosong -> N-1
      if (run.phase === "probe") {
        const page = run.page || 1;
        if (!listUrlOk(page)) return goto(listUrl(page));
        await waitTable();
        const n = readRows().length;
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
        const skip = new Set(run.skip || []);
        const rows = readRows().filter((r) => /EDITED/i.test(r.status || "EDITED") && !skip.has(r.kode));
        if (!rows.length) {
          if (page > 1) {
            log(`Halaman ${page} sudah habis → halaman ${page - 1}`);
            setPhase("list", { page: page - 1 });
            return goto(listUrl(page - 1));
          }
          return stopRun("Selesai ✓ tidak ada dokumen EDITED tersisa");
        }
        const row = rows[rows.length - 1];
        log(`▶ ${row.kode} ${row.nama} (hal. ${page}, baris terakhir)`);
        const href = await rowLink(row);
        if (!href) {
          setPhase("list", { cur: { kode: row.kode, nama: row.nama } });
          return finishDoc(false, "tombol Review tidak muncul di daftar");
        }
        setPhase("review", { cur: { kode: row.kode, nama: row.nama, href }, submitClicked: false, confirmed: false });
        return goto(href);
      }
      const cur = run.cur || {};
      if (run.phase === "review") {
        if (onEdit()) return setPhase("submit");
        if (!onReview()) return goto(cur.href);
        log("Buka Edit");
        await reviewToEdit();
        return setPhase("submit");
      }
      if (run.phase === "submit") {
        if (!onEdit()) {
          if (run.submitClicked && onReview()) return setPhase("approve");
          return setPhase("review");
        }
        if (run.submitClicked) {
          await backToReview(20000); // halaman dimuat ulang setelah Kirim: jangan kirim dua kali
          return setPhase("approve");
        }
        if (loadConf().testMode && !run.confirmed) {
          const r = loadRun();
          r.paused = true;
          saveRun(r);
          return log('MODE UJI: siap Kirim. Periksa, lalu klik "Kirim sekarang" atau "Lewati"');
        }
        await submitCurrent();
        if (!loadConf().approve) return finishDoc(true, "terkirim");
        return setPhase("approve");
      }
      if (run.phase === "approve") {
        if (!onReview()) return goto(cur.href);
        log("Approve");
        await approveDocument();
        return finishDoc(true, "terkirim & approve");
      }
    } catch (e) {
      console.error(`[${APP.name}]`, e);
      pressKey("Escape");
      if (["list", "probe"].includes(loadRun().phase)) log(`⚠ ${e.message}`);
      else finishDoc(false, e.message);
    } finally {
      busy = false;
    }
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
      done: 0,
      failed: [],
      skip: loadRun().skip || [], // dokumen bergalat sebelumnya tetap dilewati (hapus lewat tombol Reset)
      logs: [],
    });
    log(`Mulai${testMode ? " · MODE UJI" : ""}: cari halaman terakhir (${STATUS_FILTER}, ${PER_PAGE}/halaman)`);
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
      #fsa-launch { position:fixed; left:16px; z-index:999999; border:none; border-radius:999px; padding:10px 16px 10px 12px; background:linear-gradient(120deg,#0f766e,#0891b2); color:#fff; font:650 13px "Inter",ui-sans-serif,system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 28px rgba(8,145,178,.4); }
      #fsa-launch b { background:rgba(255,255,255,.22); border-radius:7px; padding:2px 6px; font-size:11.5px; margin-right:6px; }
      #fsa-box { position:fixed; right:16px; bottom:16px; z-index:1000002; width:min(460px,94vw); background:rgba(17,19,36,.94); color:#eef0ff; border-radius:16px; padding:14px 16px; box-shadow:0 20px 50px rgba(10,10,30,.45); font-size:13px; }
      #fsa-box .top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; cursor:move; user-select:none; }
      #fsa-box .t { font-weight:700; }
      #fsa-box .m { color:#9aa0c3; font-size:12px; }
      #fsa-box button { border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.08); color:#eef0ff; border-radius:9px; padding:6px 10px; font-size:12.5px; font-weight:600; cursor:pointer; }
      #fsa-box button:hover { background:rgba(255,255,255,.16); }
      #fsa-box button.go { background:#16a34a; border-color:#16a34a; }
      #fsa-box button.stop { background:transparent; border-color:rgba(248,113,113,.45); color:#fca5a5; }
      #fsa-box .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:10px; }
      #fsa-box label { display:inline-flex; gap:6px; align-items:center; font-size:12.5px; cursor:pointer; }
      #fsa-box input[type=number] { width:60px; background:rgba(0,0,0,.3); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:7px; padding:3px 6px; }
      #fsa-box .log { margin-top:10px; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; background:rgba(0,0,0,.28); border-radius:9px; padding:7px 10px; line-height:1.5; max-height:130px; overflow:auto; }
      #fsa-box .log div:last-child { color:#fde68a; }
      #fsa-box .fail { margin-top:8px; max-height:120px; overflow:auto; font-size:12px; color:#fcd34d; }
      #fsa-box .hint { color:#9aa0c3; font-size:11.5px; margin-top:8px; line-height:1.45; }
    `;
    document.head.appendChild(st);
  }

  let sig = "";
  function render() {
    if (!document.body) return;
    ensureStyles();
    let launch = document.getElementById("fsa-launch");
    if (!launch) {
      launch = document.createElement("button");
      launch.id = "fsa-launch";
      launch.style.bottom = `${APP.launchBottom}px`;
      launch.innerHTML = `<b>✔</b>Submit & Approve`;
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
    const s = JSON.stringify([run, conf]);
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
      if (pos) Object.assign(box.style, { left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto" });
    }
    const failed = run.failed || [];
    const PH = { probe: "Cari halaman terakhir", list: "Pilih dokumen", review: "Buka / Edit", submit: "Kirim", approve: "Approve" };
    box.innerHTML = `
      <div class="top">
        <div class="t">✔ ${esc(APP.name)}</div>
        <div class="m">${run.running ? `${run.hold ? "⏸ dijeda · " : ""}${esc(PH[run.phase] || run.phase || "")}${conf.testMode ? " · Mode uji" : ""} · hal. ${run.page || "-"}` : "berhenti"}</div>
        <span style="flex:1"></span>
        ${
          run.running
            ? `${run.paused ? `<button class="go" data-a="send">✓ Kirim sekarang</button><button data-a="pass">Lewati</button>` : ""}
               ${run.hold ? `<button class="go" data-a="resume">▶ Lanjut</button>` : `<button data-a="hold">⏸ Jeda</button>`}
               <button class="stop" data-a="stop">■ Stop</button>`
            : `<button data-a="close" title="Tutup">✕</button>`
        }
      </div>
      <div class="m" style="margin-top:6px">✅ ${run.done || 0} terkirim${conf.approve ? " & approve" : ""} · ⚠ ${failed.length} dilewati${(run.skip || []).length > failed.length ? ` (+${(run.skip || []).length - failed.length} dari sesi sebelumnya)` : ""}</div>
      ${run.cur ? `<div style="margin-top:6px;font-weight:650">▶ ${esc(run.cur.kode)} ${esc(run.cur.nama || "")}</div>` : ""}
      ${
        run.running
          ? ""
          : `<div class="row">
              <button class="go" data-a="start">▶ Mulai</button>
              <button data-a="test">🧪 Uji 1 dokumen</button>
              <label>Batas <input type="number" min="0" data-c="limit" value="${conf.limit || 0}"> dok (0 = semua)</label>
            </div>
            <div class="row">
              <label><input type="checkbox" data-c="approve" ${conf.approve ? "checked" : ""}> Approve setelah kirim</label>
              <button data-a="reset" title="Dokumen yang tadinya bergalat dicoba lagi">↻ Reset daftar dilewati</button>
            </div>
            <div class="hint">Membuka daftar data dengan filter <b>${esc(STATUS_FILTER)}</b>, ${PER_PAGE} baris/halaman, lalu mengerjakan dari <b>halaman & baris paling belakang</b>: Review → Edit → Kirim → Approve. Dokumen bergalat tidak diperbaiki, cukup dilewati & dicatat di bawah. Pintasan: Alt+${APP.hotkey}.</div>`
      }
      <div class="log">${(run.logs || []).map((l) => `<div>${esc(l)}</div>`).join("") || "<div>…</div>"}</div>
      ${failed.length ? `<div class="fail">${failed.map((f) => `⚠ ${esc(f.kode)} ${esc(f.nama || "")}: ${esc(f.reason)}`).join("<br>")}</div>` : ""}`;
  }
  function onClick(e) {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
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
      log("Kirim sekarang");
    }
    if (a === "pass") {
      const r = loadRun();
      r.paused = false;
      saveRun(r);
      finishDoc(false, "MODE UJI: tidak dikirim (dokumen masih terbuka edit)");
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
    c[k] = e.target.type === "checkbox" ? e.target.checked : Math.max(0, Number(e.target.value) || 0);
    saveConf(c);
  }
  function makeDraggable(el) {
    el.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".top") || e.target.closest("button") || e.button !== 0) return;
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
  console.log(`[${APP.name} v${APP.version}] Aktif. Tombol di kiri bawah (Alt+${APP.hotkey}).`);
})();
