/*
 * Rostering System — shared mockup behaviors.
 * Demonstrates, with real working code, the interaction patterns the frontend
 * implementer must reproduce in packages/ui: modal focus-trap/Escape/return-
 * focus, calendar roving-tabindex + arrow-key navigation, and toast/live-region
 * announcements. This is illustrative vanilla JS for static mockups, not the
 * production implementation (that will be React), but the *behavior* is meant
 * to be copied 1:1.
 */
(function () {
  "use strict";

  const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

  /* ---------------- Modal: focus trap + Escape + return focus ---------------- */

  function openModal(modal, triggerEl) {
    if (!modal) return;
    modal._returnFocus = triggerEl || document.activeElement;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    const dialog = modal.querySelector('[role="dialog"]');
    const focusables = dialog ? dialog.querySelectorAll(FOCUSABLE) : [];
    (focusables[0] || dialog).focus();

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal(modal);
        return;
      }
      if (e.key === "Tab" && dialog) {
        const items = Array.prototype.filter.call(
          dialog.querySelectorAll(FOCUSABLE),
          (el) => el.offsetParent !== null
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    modal._onKeydown = onKeydown;
    modal.addEventListener("keydown", onKeydown);
  }

  function closeModal(modal) {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    if (modal._onKeydown) modal.removeEventListener("keydown", modal._onKeydown);
    if (modal._returnFocus && typeof modal._returnFocus.focus === "function") {
      modal._returnFocus.focus();
    }
  }

  document.addEventListener("click", (e) => {
    const openTrigger = e.target.closest("[data-open-modal]");
    if (openTrigger) {
      const modal = document.getElementById(openTrigger.getAttribute("data-open-modal"));
      openModal(modal, openTrigger);
      return;
    }
    const closeTrigger = e.target.closest("[data-close-modal]");
    if (closeTrigger) {
      closeModal(closeTrigger.closest(".modal-overlay"));
      return;
    }
    // Click on overlay background (not the modal card itself) closes too.
    if (e.target.classList && e.target.classList.contains("modal-overlay")) {
      closeModal(e.target);
    }
  });

  window.RosterKit = window.RosterKit || {};
  window.RosterKit.openModal = openModal;
  window.RosterKit.closeModal = closeModal;

  /* ---------------- Toast: aria-live region ---------------- */

  function toast(regionId, message, variant) {
    const region = document.getElementById(regionId);
    if (!region) return;
    const el = document.createElement("div");
    el.className = "toast toast--" + (variant || "success");
    el.innerHTML =
      '<span class="toast__icon" aria-hidden="true">' +
      (variant === "error" ? "✕" : variant === "warning" ? "⚠" : "✓") +
      "</span><span>" + message + "</span>";
    region.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  window.RosterKit.toast = toast;

  /* ---------------- CalendarGrid: roving tabindex + arrow keys ---------------- */
  /* Container must be a <table> (or any element) whose focusable slot cells
     carry [data-cal-cell] and are laid out with one row per shift (A/B/C) and
     one column per day, matching the DOM row/column order. */

  function initRovingGrid(container) {
    if (!container) return;
    const cells = Array.prototype.slice.call(container.querySelectorAll("[data-cal-cell]"));
    if (!cells.length) return;

    // Build a row/col index from actual table rows so Up/Down/Left/Right map
    // to visual position rather than DOM order alone.
    const rows = Array.prototype.slice.call(container.querySelectorAll("tbody tr"));
    const grid = rows.map((tr) => Array.prototype.slice.call(tr.querySelectorAll("[data-cal-cell]")));

    let current = cells[0];
    cells.forEach((c) => (c.tabIndex = c === current ? 0 : -1));

    function coordsOf(cell) {
      for (let r = 0; r < grid.length; r++) {
        const c = grid[r].indexOf(cell);
        if (c !== -1) return [r, c];
      }
      return [0, 0];
    }

    function focusCell(cell) {
      if (!cell) return;
      current.tabIndex = -1;
      cell.tabIndex = 0;
      cell.focus();
      current = cell;
    }

    container.addEventListener("keydown", (e) => {
      const target = e.target.closest("[data-cal-cell]");
      if (!target) return;
      const [r, c] = coordsOf(target);
      let next = null;
      switch (e.key) {
        case "ArrowRight":
          next = (grid[r] || [])[c + 1] || (grid[r + 1] || [])[0];
          break;
        case "ArrowLeft":
          next = (grid[r] || [])[c - 1] || (grid[r - 1] || [])[(grid[r - 1] || []).length - 1];
          break;
        case "ArrowDown":
          next = (grid[r + 1] || [])[c];
          break;
        case "ArrowUp":
          next = (grid[r - 1] || [])[c];
          break;
        case "Home":
          next = grid[r][0];
          break;
        case "End":
          next = grid[r][grid[r].length - 1];
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          target.click();
          return;
        default:
          return;
      }
      if (next) {
        e.preventDefault();
        focusCell(next);
      }
    });

    container.addEventListener("focusin", (e) => {
      const target = e.target.closest("[data-cal-cell]");
      if (target && target !== current) {
        current.tabIndex = -1;
        target.tabIndex = 0;
        current = target;
      }
    });
  }
  window.RosterKit.initRovingGrid = initRovingGrid;

  /* ---------------- JobProgress: simulated polling demo ---------------- */

  function simulateJobProgress(el, onDone) {
    if (!el) return;
    const bar = el.querySelector(".job-progress__bar > span");
    const text = el.querySelector("[data-job-text]");
    let pct = 0;
    const timer = setInterval(() => {
      pct = Math.min(100, pct + Math.random() * 22);
      if (bar) bar.style.width = pct + "%";
      if (text) text.textContent = "Generating roster… " + Math.round(pct) + "%";
      if (pct >= 100) {
        clearInterval(timer);
        el.classList.remove("job-progress--active");
        el.classList.add("job-progress--completed");
        if (text) text.textContent = "Roster generated — 3 alerts to review.";
        if (onDone) onDone();
      }
    }, 450);
  }
  window.RosterKit.simulateJobProgress = simulateJobProgress;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-cal-grid]").forEach(initRovingGrid);
  });
})();
