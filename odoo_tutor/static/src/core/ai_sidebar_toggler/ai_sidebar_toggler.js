/* eslint-disable */
/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";
import { normalizeDomEvent } from "../normalize_ui_event";
// ---------------------
// Helpers
// ---------------------

const AI_DOC = window.top?.document || document;
async function getUserLogin() {
    const info = await rpc("/web/session/get_session_info", {});
    return {
        uid: info.uid,
        user_login: info.username,
        name: info.name,
        db: info.db,
    };
}

function parseHashParams(hash) {
    const h = (hash || window.location.hash || "").replace(/^#/, "");
    const out = {};
    h.split("&").forEach((kv) => {
        const [k, v] = kv.split("=");
        if (!k) return;
        out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
    return out;
}

function parseQueryParams(url) {
    try {
        const u = url ? new URL(url, window.location.href) : new URL(window.location.href);
        const out = {};
        for (const [k, v] of u.searchParams.entries()) out[k] = v;
        return out;
    } catch {
        return {};
    }
}

function guessViewType() {
    if (document.querySelector(".o_form_view")) return "form";
    if (document.querySelector(".o_list_view, .o_list_renderer")) return "list";
    if (document.querySelector(".o_kanban_view")) return "kanban";
    if (document.querySelector(".o_graph_view")) return "graph";
    if (document.querySelector(".o_pivot_view")) return "pivot";
    return null;
}

function slugify(s) {
    return (s || "")
        .toString()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 60);
}

function cleanText(x) {
    return (x || "").toString().trim().replace(/\s+/g, " ");
}

function safeId(val) {
    if (val == null || val === "") return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : String(val);
}

function classifyElement(el) {
    const tag = (el.tagName || "").toUpperCase();
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    const role = (el.getAttribute?.("role") || "").toLowerCase();

    if (role === "checkbox") return "Checkbox";
    if (role === "button" || role === "menuitem" || role === "tab") return "Button";

    const buttonish = el.closest?.("button,[role='button'],.o-kanban-button,.o_statusbar_button");
    if (buttonish) return "Button";

    if (tag === "INPUT") {
        if (type === "checkbox") return "Checkbox";
        if (["button", "submit", "reset"].includes(type)) return "Button";
        return "Input";
    }
    if (tag === "BUTTON") return "Button";
    if (tag === "SELECT") return "List";
    if (tag === "A") return "Link";

    if (tag === "I" || tag === "SPAN") {
        const cls = (el.className || "").toString();
        if (/\bfa-cloud-upload\b/.test(cls)) return "Button";
    }

    if (el.closest?.(".o_list_renderer")) return "List";
    if (el.closest?.(".o_kanban_view")) return "List";
    return "Other";
}

let __AI_UID_SEQ = 0;
function ensureElementUid(el) {
    if (!el || !el.dataset) return null;
    if (!el.dataset.aiUid) {
        __AI_UID_SEQ += 1;
        el.dataset.aiUid = String(__AI_UID_SEQ);
    }
    return el.dataset.aiUid;
}

function pickHeaderCellFor(table, cell) {
    if (!table) return null;

    const aria = Number(
        cell?.getAttribute?.("aria-colindex") ||
            cell?.closest?.("[aria-colindex]")?.getAttribute?.("aria-colindex")
    );
    if (Number.isFinite(aria)) {
        const th = table.querySelector('thead th[aria-colindex="' + aria + '"]');
        if (th) return th;
    }

    let idx = null;
    if (cell && typeof cell.cellIndex === "number") idx = cell.cellIndex;

    const thead = table.tHead || table.querySelector("thead");
    let headerCells = [];
    if (thead) {
        const rows = Array.from(thead.rows || []);
        const headerRow = rows.length ? rows[rows.length - 1] : null;
        headerCells = headerRow ? Array.from(headerRow.cells || []) : Array.from(thead.querySelectorAll("th"));
    } else {
        headerCells = Array.from(table.querySelectorAll("thead th"));
    }
    if (!headerCells.length) return null;

    if (idx == null && cell?.parentElement) {
        const siblings = Array.from(cell.parentElement.children || []);
        idx = siblings.indexOf(cell);
    }
    if (idx != null && headerCells[idx]) return headerCells[idx];

    const txt = cleanText(cell?.textContent || "").toLowerCase();
    let best = null, bestScore = -1;
    for (const th of headerCells) {
        const name = (th.getAttribute?.("data-name") || "").toLowerCase();
        const label = cleanText(th.textContent).toLowerCase();
        let s = 0;
        if (name && txt && label.includes(txt)) s += 2;
        if (txt && label && (txt === label || label.includes(txt))) s += 1;
        if (s > bestScore) {
            bestScore = s;
            best = th;
        }
    }
    return best;
}

function findGridContext(el) {
    const out = {};
    const cell = el.closest?.("td, th") || null;
    const table =
        cell?.closest?.("table") ||
        el.closest?.("table") ||
        document.querySelector(".o_list_renderer table");
    const th = table ? pickHeaderCellFor(table, cell) : null;

    if (th?.getAttribute?.("data-name")) out.columnField = th.getAttribute("data-name");
    if (th) out.columnLabel = cleanText(th.textContent);

    const row = el.closest?.("tr") || null;
    if (row) {
        const rid = row.getAttribute?.("data-res-id") || row.getAttribute?.("data-id") || row.dataset?.id;
        out.rowId = safeId(rid);

        const prodCell =
            row.querySelector?.('td[data-name="product_id"]') ||
            row.querySelector?.("td.o_data_cell a") ||
            row.querySelector?.("td.o_data_cell");
        if (prodCell) out.rowLabel = cleanText(prodCell.textContent);
    }

    const any = el.closest?.("[data-model], [data-name]");
    if (any?.getAttribute?.("data-name") && !out.columnField) {
        out.columnField = any.getAttribute("data-name");
    }

    return out;
}

function getControlLabel(el) {
    if (!el) return null;
    const id = el.id || el.getAttribute?.("id");
    let labelEl = null;

    if (id) {
        try {
            const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
            labelEl = document.querySelector('label[for="' + sel + '"]');
        } catch {
            labelEl = document.querySelector('label[for="' + id + '"]');
        }
    }

    if (!labelEl) labelEl = el.closest?.("label") || null;
    if (!labelEl && el.parentElement) labelEl = el.parentElement.querySelector?.("label") || null;

    if (!labelEl) {
        const wrap = el.closest?.(".form-check, .custom-control, .o_boolean_toggle, .o_setting_box, .o_form_label");
        if (wrap) {
            labelEl =
                wrap.querySelector?.(".form-check-label, .custom-control-label, label, .o_form_label, .o_setting_label") ||
                null;
        }
    }

    if (!labelEl && el.nextElementSibling?.tagName === "LABEL") labelEl = el.nextElementSibling;
    if (!labelEl && el.previousElementSibling?.tagName === "LABEL") labelEl = el.previousElementSibling;

    const txt = cleanText(labelEl?.textContent || el.getAttribute?.("title") || "") || "";
    return txt || null;
}

function buildUniqueKey(el, uiType, gctx) {
    if (uiType === "List" && gctx?.rowId != null) return `List-${gctx.rowId}`;

    if (uiType === "Checkbox") {
        const name = el?.getAttribute?.("name");
        if (name) return `Checkbox-${name}`;
        const rid = gctx?.rowId != null ? String(gctx.rowId) : null;
        if (rid) return `Checkbox-${rid}`;
    }

    if (uiType === "Input") {
        const name = el?.getAttribute?.("name");
        if (name) return `Input-${name}`;
        const idAttr = el?.id;
        if (idAttr) return `Input-${idAttr}`;
        if (gctx?.columnField) return `Input-${gctx.columnField}`;
        if (gctx?.columnLabel) return `Input-${slugify(gctx.columnLabel)}`;
    }

    if (uiType === "Button") {
        const title = el?.getAttribute?.("title");
        if (title) return `Button-${title}`;
    }

    if (uiType === "Link") {
        const href = el?.getAttribute?.("href");
        if (href) {
            const tail = href.split(/[\/#?]/).filter(Boolean).slice(-1)[0] || href;
            return `Link-${tail}`;
        }
    }

    const uid = ensureElementUid(el) || Math.floor(Math.random() * 1e9);
    return `${uiType}-${uid}`;
}

/**
 * "Target element" (MVP) para tu backend:
 * - Ideal: button.new_lead (si existe name/id/data-name)
 * - Fallback: uniqueKey
 */
function buildTargetElement(el, uiType, uniqueKey, labelKey) {
    const tag = (el?.tagName || "").toLowerCase() || "el";

    const dataName = el?.getAttribute?.("data-name");
    if (dataName) return `${tag}.${dataName}`;

    const name = el?.getAttribute?.("name");
    if (name) return `${tag}.${name}`;

    const id = el?.id;
    if (id) return `${tag}#${id}`;

    const title = el?.getAttribute?.("title");
    if (uiType === "Button" && title) return `button.${slugify(title)}`;

    if (labelKey) return `${tag}.${labelKey}`;

    return uniqueKey || `${tag}.unknown`;
}

// ---------------------
// Component
// ---------------------
class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");
        this._lastActiveListField = null;
        // ✅ WebSocket service (single source of truth)
        this.aiWs = useService("ai_ws");

        // ✅ Recorder service (tu nuevo servicio)
        this.aiRecorder = useService("ai_recorder"); // si no existe aún, Odoo lanzará error -> asegúrate de registrarlo

        this.state = useState({
            showButton: false,
            logs: [],
            ctx: { viewType: null, resId: null },
        });
        // dedupe cache: key -> lastTsMs
        this._dedup = new Map();
        this.DEDUP_MS = 650;

        this.modules = [
            "sale.order",
            "sale,report",
            "res.partner",
            "stock.picking",
            "stock.picking.type",
            "stock.location",
            "stock.quant",
            "stock.move",
            "stock.lot",
            "stock.warehouse",
            "stock.rule",
            "stock.scrap",
            "stock.warehouse.orderpoint",
            "product.template",
            "product.product",
            "product.category",
            "product.supplierinfo",
            "product.pricelist",
            "product.pricelist.item",
            "product.attribute",
            "product.attribute.value",
            "product.template.attribute.value",
            "product.supplierinfo",
            "product.supplierinfo.product",
            "product.supplierinfo.product.category",
            "product.supplierinfo.product.product",
            "purchase.order",
            "project.project",
            "project.task",
            "project.task.type",
            "report.project.task.user",
            "project.tags",
            "mail.activity.type",
            "account.journal",
            "account.account",
            "account.payment",
            "account.move",
            "account.invoice",
            "purchase.order",
            "res.config.settings",
            "crm.lead",
            "crm.team",
            "crm.activity.report",
            "crm.stage",
            "crm.tag",
            "crm.lost.reason",
            "crm.iap.lead.mining.request",
            "mail.activity.plan",
            "mail.activity.type",
            "crm.team.member",

        ];

        onMounted(() => {
            // abre conexión WS (si ya está abierta, no hace nada)
            this.aiWs?.ensureConnected?.().catch(() => {});
        });

        // interval de contexto / visibilidad
        this._interval = setInterval(() => {
            let currentModel = null, showButton = false;
            const currentAction = this.actionService.currentController?.props;
            if (currentAction) {
                currentModel = currentAction.resModel;
                if (this.modules.includes(currentModel)) showButton = true;
            }
            this.state.showButton = showButton;

            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";
            if (isCreatingSaleOrder) this.contextService.setContext(currentModel, "form", "create");
            else if (currentModel) this.contextService.setContext(currentModel, "form", "list");

            this.state.ctx = this._getContextSnapshot();
        }, 500);

        // ---------------------
        // Document listeners (guardamos refs para cleanup)
        // ---------------------
        this._onDocClick = (ev) => {
            if (!ev.target || !ev.target.tagName) return;

            const t = ev.target;
            const td = t?.closest?.("td");
            if (td) {
                const inferred =
                  td.getAttribute("data-name") ||
                  td.getAttribute("data-field") ||
                  td.dataset?.name ||
                  td.dataset?.field ||
                  null;

                if (inferred) {
                  this._lastActiveListField = inferred;
                  console.log("[AI_UI] inferred list column:", inferred);
                }
            }
            const base = this._getContextSnapshot();

            const link = ev.target.closest?.("a, [role='menuitem'], .o_app, .o_menuitem, .dropdown-item");
            let href = null, menuXmlid = null;
            if (link) {
                href = link.getAttribute?.("href") || null;
                const ds = link.dataset || {};
                menuXmlid = ds.menuXmlid || ds.menuXmlId || ds.xmlid || null;
            }
            const uiType = classifyElement(ev.target);
            const gctx = findGridContext(ev.target);
            const label = getControlLabel(ev.target);
            const labelKey = label ? `${uiType}-${slugify(label)}` : null;
            const uniqueKey = buildUniqueKey(ev.target, uiType, gctx);
            const targetElement = buildTargetElement(ev.target, uiType, uniqueKey, labelKey);

            const logEv = this.addLog("click", {
                tag: ev.target.tagName,
                text: cleanText(ev.target.innerText).slice(0, 80),
                className: ev.target.className,
                idAttr: ev.target.id || null,
                nameAttr: ev.target.name || null,
                role: ev.target.getAttribute?.("role") || null,
                title: ev.target.getAttribute?.("title") || null,
                href,
                menuXmlid,
                uiType,
                uniqueKey,
                targetElement,
                label,
                labelKey,
                ...gctx,
                ...base,
            });

            // ✅ Normalización (console + opcional WS)
            try {
              const normalized = normalizeDomEvent({
                domEventType: "click",
                originalEvent: ev,
                context: this._getContextSnapshot(),
                hints: { lastActiveField: this._lastActiveListField },
              });

              if (normalized) {
                // si quieres mandarlo por WS ya:
                this.aiWs?.sendEvent?.({
                  type: "ui_event",
                  event_name: normalized.type,
                  event_data: normalized,
                }).catch(() => {});
              }
            } catch (e) {
              console.warn("[AI_UI] normalize failed", e);
            }

            /*this._maybeRecordUiEvent({
              type: "click",
              timestamp: Date.now(),
              targetElement: ev.target,
              uiType: ev.uiType || "Unknown",
              label: ev.label || null,
              labelKey: ev.labelKey || null,
              name: ev.name || null,
              viewType: ev.viewType || null,
              resId: ev.resId || null,
            });*/

            // route_after
            setTimeout(() => {
                this.addLog("route_after", this._getContextSnapshot());
            }, 0);

        };

        this._onDocInput = (ev) => {
            if (!ev.target || !["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;

            const base = this._getContextSnapshot();
            const uiType = classifyElement(ev.target);
            const gctx = findGridContext(ev.target);
            const label = getControlLabel(ev.target);
            const labelKey = label ? `${uiType}-${slugify(label)}` : null;
            const uniqueKey = buildUniqueKey(ev.target, uiType, gctx);
            const targetElement = buildTargetElement(ev.target, uiType, uniqueKey, labelKey);

            const logEv = this.addLog("input", {
                name: ev.target.name,
                value: (ev.target.value ?? "").toString().slice(0, 80),
                tag: ev.target.tagName,
                className: ev.target.className,
                idAttr: ev.target.id || null,
                role: ev.target.getAttribute?.("role") || null,
                title: ev.target.getAttribute?.("title") || null,
                uiType,
                uniqueKey,
                targetElement,
                label,
                labelKey,
                ...gctx,
                ...base,
            });

        };

        this._onDocChange = (ev) => {
            if (!ev.target || !["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName)) return;
            const base = this._getContextSnapshot();
            const uiType = classifyElement(ev.target);
            const gctx = findGridContext(ev.target);
            const label = getControlLabel(ev.target);
            const labelKey = label ? `${uiType}-${slugify(label)}` : null;
            const uniqueKey = buildUniqueKey(ev.target, uiType, gctx);
            const targetElement = buildTargetElement(ev.target, uiType, uniqueKey, labelKey);

            const logEv = this.addLog("input_final", {
                name: ev.target.name,
                value: (ev.target.value ?? "").toString().slice(0, 80),
                tag: ev.target.tagName,
                className: ev.target.className,
                idAttr: ev.target.id || null,
                role: ev.target.getAttribute?.("role") || null,
                title: ev.target.getAttribute?.("title") || null,
                uiType,
                uniqueKey,
                targetElement,
                label,
                labelKey,
                ...gctx,
                ...base,
            });

            const checked =
              ev.target?.type === "checkbox"
                ? !!ev.target.checked
                : null;

            try {
              const normalized = normalizeDomEvent({
                domEventType: "change",
                originalEvent: ev,
                context: this._getContextSnapshot(),
                hints: { lastActiveField: this._lastActiveListField },
              });

              if (normalized) {
                this.aiWs?.sendEvent?.({
                  type: "ui_event",
                  event_name: normalized.type,
                  event_data: normalized,
                }).catch(() => {});
              }
            } catch (e) {
              console.warn("[AI_UI] normalize failed", e);
            }

            /*this._maybeRecordUiEvent({
              type: "input_final",
              timestamp: Date.now(),
              targetElement: ev.target,
              uiType: ev.target?.type === "checkbox" ? "Checkbox" : "Input",
              name: ev.target?.name || null,
              value: ev.target?.value || null,
              checked,
            });*/

        };

        AI_DOC.addEventListener("click", this._onDocClick, true);
        AI_DOC.addEventListener("input", this._onDocInput, true);
        AI_DOC.addEventListener("change", this._onDocChange, true);

        // ---------------------
        // Debug helpers (como antes)
        // ---------------------
        window.filterUIEvents = (opts = {}) => {
            const {
                uiType,
                uniqueKey,
                labelKey,
                columnField,
                columnLabel,
                rowLabelContains,
                valueEquals,
                containsText,
                type,
                sinceMs,
                limit = 2000,
            } = opts;

            const now = Date.now();
            const out = [];
            const src = this.state.logs.slice(-limit);
            for (const e of src) {
                if (type && e.type !== type) continue;
                if (uiType && e.uiType !== uiType) continue;
                if (uniqueKey && e.uniqueKey !== uniqueKey) continue;
                if (labelKey && e.labelKey !== labelKey) continue;
                if (columnField && e.columnField !== columnField) continue;
                if (columnLabel && e.columnLabel !== columnLabel) continue;

                if (rowLabelContains) {
                    const r = (e.rowLabel || "").toLowerCase();
                    if (!r.includes(String(rowLabelContains).toLowerCase())) continue;
                }
                if (valueEquals !== undefined) {
                    if ((e.value ?? "") !== String(valueEquals)) continue;
                }
                if (sinceMs) {
                    const t = Date.parse(e.timestamp || "") || 0;
                    if (!t || now - t > sinceMs) continue;
                }
                if (containsText) {
                    const q = String(containsText).toLowerCase();
                    const hay = (e.text || e.value || "").toLowerCase();
                    if (!hay.includes(q)) continue;
                }
                out.push(e);
            }
            return out;
        };

        window.pickMostRelevant = (events = [], opts = {}) => {
            const { targetText, preferTag, preferUiType, recencyBias = 0.2 } = opts;
            const norm = (s) => (s || "").toString().toLowerCase();
            const tgt = norm(targetText);
            const scored = events.map((e, idx) => {
                let score = 0;
                const t = norm(e.text || e.value || "");
                if (t && tgt) {
                    if (t === tgt) score += 5;
                    if (t.includes(tgt)) score += 3;
                    if (t.startsWith(tgt)) score += 1;
                }
                if (preferTag && (e.tag || "").toUpperCase() === String(preferTag).toUpperCase()) score += 2;
                if (preferUiType && e.uiType === preferUiType) score += 1.5;

                const ts = Date.parse(e.timestamp || "") || 0;
                if (ts) {
                    const ageMs = Date.now() - ts;
                    const rec = Math.max(0, 1 - Math.min(ageMs / (5 * 60 * 1000), 1));
                    score += rec * (recencyBias * 5);
                }
                if (e.uniqueKey) score += 0.5;
                return { e, score, idx };
            });

            scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
            return scored.length ? { best: scored[0].e, scored } : { best: null, scored: [] };
        };
    }

    _getContextSnapshot() {
      try {
        // 1) usa TU context_service primero (es lo más estable)
        const ctx = this.contextService?.getContext?.() || {};
        const props = this.actionService.currentController?.props || {};

        const model = props.resModel || ctx.model || null;

        const viewType =
          props.viewType ||
          ctx.view ||
          (document.querySelector(".o_form_view, .o_form_renderer") ? "form" : null) ||
          (document.querySelector(".o_list_view, .o_list_renderer") ? "list" : null) ||
          (document.querySelector(".o_kanban_view, .o_kanban_renderer") ? "kanban" : null) ||
          null;

        const resId = props.resId || null;

        return { model, viewType, resId };
      } catch {
        return { model: null, viewType: null, resId: null };
      }
    }

    addLog(type, data) {
        const ev = { type, ...data, timestamp: new Date().toISOString() };

        if (this.state.logs.length > 1000) {
            this.state.logs.splice(0, this.state.logs.length - 1000);
        }
        this.state.logs.push(ev);
        return ev;
    }

    /**
     * Envia evento al backend SOLO si recorder está activo.
     * - Dedup por (type + targetElement + value?) en ventana corta.
     * - Además lo pasa al ai_recorder (si tiene método).
     */

    _maybeRecordUiEvent(ev) {
      try {
        // Siempre imprime para debug (aunque no esté grabando)
        console.log("[AI_UI] candidate", ev);

        const isActive =
          window.getRecorderStatus?.() === "recording" ||
          window.__AI_TUTOR_RECORDER_ACTIVE;

        // 🔥 Construimos JSON normalizado tipo ticket
        const normalized = {
          type:
            ev.type === "input_final"
              ? "field_changed"
              : ev.type === "click" && ev.uiType === "Button"
              ? "button_click"
              : ev.type,
          label: ev.labelKey || ev.label || null,
          field: ev.name || ev.columnField || null,
          value:
            ev.uiType === "Checkbox"
              ? !!ev.checked
              : ev.value ?? null,
          meta: {
            viewType: ev.viewType || null,
            resId: ev.resId || null,
            rowId: ev.rowId || null,
          },
          ts: new Date().toISOString(),
          v: 1,
        };

        if (!isActive) return;

        // Envío por websocket si está grabando
        if (window.aiWs?.sendEvent) {
          window.aiWs.sendEvent(normalized);
        }
      } catch (err) {
        console.warn("[AI_UI] normalize error", err);
      }
    }

    willUnmount() {
        clearInterval(this._interval);

        try {
            AI_DOC.removeEventListener("click", this._onDocClick, true);
            AI_DOC.removeEventListener("input", this._onDocInput, true);
            AI_DOC.removeEventListener("change", this._onDocChange, true);
        } catch {}

        this._onDocClick = null;
        this._onDocInput = null;
        this._onDocChange = null;
    }
}

registry.category("main_components").add(
    "AiFloatingButton",
    { Component: AiFloatingButton },
    { sequence: 100 }
);
